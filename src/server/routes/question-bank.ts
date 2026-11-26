import { Hono } from 'hono';
import { z } from 'zod';
import type { AttemptAnswer } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import { notFound, readBody, readQuery } from '../lib/http.js';
import { pageSchema } from '../lib/schemas.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import {
  createCategory,
  createQuestion,
  deleteCategory,
  deleteQuestion,
  duplicateQuestion,
  findQuestion,
  listCategories,
  listQuestions,
  moveQuestions,
  toBankQuestion,
  updateCategory,
  updateQuestion,
} from '../services/question-bank.js';
import {
  effectiveAnswer,
  gradeQuestion,
  QUESTION_TYPES,
  questionInputSchema,
  reviewQuestion,
  snapshotFromRow,
  studentQuestion,
} from '../services/question-types.js';
import { canManageBank, canReadCategory, manageableCourseIds, sharedCategoryRows, sharedFromMap } from '../services/question-sharing.js';

const id = z.string().max(40);
const categoryFields = {
  name: z.string().trim().min(1, 'Enter a name').max(100),
  description: z.string().trim().max(1000),
  parentId: id.nullable(),
};
const withCategory = z.object({ categoryId: id.nullable().optional() });

const answerSchema = z.object({
  optionIds: z.array(id).max(20).optional(),
  text: z.string().max(50_000).optional(),
  order: z.array(id).max(20).optional(),
  matches: z
    .record(id, id)
    .refine((m) => Object.keys(m).length <= 20, 'Too many matches')
    .optional(),
});

/** The course question bank: categories and questions. Everything needs `questionbank:manage`. */
export function questionBankRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function bankAccess(c: Parameters<typeof requireUser>[0], courseId: string) {
    const access = await loadCourseAccess(db, requireUser(c), courseId);
    assertCan(access, 'questionbank:manage');
    return access;
  }

  /** Loads a question and checks the viewer manages its bank (anyone else gets a 404). */
  async function questionAccess(c: Parameters<typeof requireUser>[0]) {
    const question = await findQuestion(db, c.req.param('questionId')!);
    const access = await loadCourseAccess(db, requireUser(c), question.courseId);
    if (!access.can('questionbank:manage')) throw notFound('Question');
    return { question, access };
  }

  /**
   * Read-only access: the viewer manages the question's bank, or a bank its category is shared with, or a
   * course whose quiz already uses it (a share that ended leaves those quizzes working).
   */
  async function questionReadAccess(c: Parameters<typeof requireUser>[0]) {
    const user = requireUser(c);
    const question = await findQuestion(db, c.req.param('questionId')!);
    const category = await db.selectFrom('questionCategories').selectAll().where('id', '=', question.categoryId).executeTakeFirst();
    if (!category) throw notFound('Question');
    if (!(await canReadCategory(db, user, category))) {
      const managed = await manageableCourseIds(db, user);
      const used =
        managed !== 'all' && managed.size > 0
          ? await db
              .selectFrom('quizSlots')
              .innerJoin('activities', 'activities.id', 'quizSlots.activityId')
              .select('quizSlots.id')
              .where('quizSlots.questionId', '=', question.id)
              .where('activities.courseId', 'in', [...managed])
              .executeTakeFirst()
          : undefined;
      if (!used) throw notFound('Question');
    }
    return { question, owner: await canManageBank(db, user, question.courseId) };
  }

  async function categoryAccess(c: Parameters<typeof requireUser>[0]) {
    const category = await db.selectFrom('questionCategories').selectAll().where('id', '=', c.req.param('categoryId')!).executeTakeFirst();
    if (!category) throw notFound('Category');
    const access = await loadCourseAccess(db, requireUser(c), category.courseId);
    if (!access.can('questionbank:manage')) throw notFound('Category');
    return { category, access };
  }

  r.get('/courses/:courseId/question-categories', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    return c.json(await listCategories(db, access.course.id));
  });

  r.post('/courses/:courseId/question-categories', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    assertWritable(access);
    const input = await readBody(
      c,
      z.object({ ...categoryFields, description: categoryFields.description.default(''), parentId: id.nullable().default(null) }),
    );
    const row = await createCategory(db, access.course.id, input);
    return c.json({ ...row, questionCount: 0 }, 201);
  });

  r.patch('/question-categories/:categoryId', async (c) => {
    const { category, access } = await categoryAccess(c);
    assertWritable(access);
    const input = await readBody(
      c,
      z.object({
        name: categoryFields.name.optional(),
        description: categoryFields.description.optional(),
        parentId: categoryFields.parentId.optional(),
      }),
    );
    await updateCategory(db, category, input);
    return c.json({ ok: true });
  });

  /** `?moveTo=<categoryId>` takes the category's questions, subcategories and random quiz slots. */
  r.delete('/question-categories/:categoryId', async (c) => {
    const { category, access } = await categoryAccess(c);
    assertWritable(access);
    const { moveTo } = readQuery(c, z.object({ moveTo: id.optional() }));
    await deleteCategory(db, category, moveTo || null);
    return c.json({ ok: true });
  });

  r.get('/courses/:courseId/questions', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    const q = readQuery(
      c,
      z.object({
        categoryId: id.optional(),
        subcategories: z.enum(['0', '1']).optional(),
        q: z.string().max(100).optional(),
        type: z.enum(QUESTION_TYPES).optional(),
        ...pageSchema,
      }),
    );
    const filter = {
      categoryId: q.categoryId,
      includeSubcategories: q.subcategories === '1',
      q: q.q,
      type: q.type,
      page: q.page,
      pageSize: q.pageSize,
    };
    // A category shared with this course lists its own course's questions (read-only here).
    const category = q.categoryId
      ? await db.selectFrom('questionCategories').select(['id', 'courseId']).where('id', '=', q.categoryId).executeTakeFirst()
      : undefined;
    if (category && category.courseId !== access.course.id && (await sharedCategoryRows(db, access.course.id)).ids.has(category.id)) {
      const sharedFrom = await sharedFromMap(db, [category.courseId]);
      return c.json(await listQuestions(db, category.courseId, filter, { courseId: access.course.id, sharedFrom }));
    }
    return c.json(await listQuestions(db, access.course.id, filter));
  });

  r.post('/courses/:courseId/questions', async (c) => {
    const user = requireUser(c);
    const access = await bankAccess(c, c.req.param('courseId'));
    assertWritable(access);
    const input = await readBody(c, z.intersection(questionInputSchema, withCategory));
    const row = await createQuestion(db, access.course.id, input.categoryId, input, user.id);
    return c.json(await toBankQuestion(db, row), 201);
  });

  r.post('/courses/:courseId/questions/move', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    assertWritable(access);
    const { ids, categoryId } = await readBody(c, z.object({ ids: z.array(id).min(1).max(500), categoryId: id }));
    return c.json({ moved: await moveQuestions(db, access.course.id, [...new Set(ids)], categoryId) });
  });

  r.get('/questions/:questionId', async (c) => {
    const { question, owner } = await questionReadAccess(c);
    const bank = await toBankQuestion(db, question);
    return c.json(owner ? bank : { ...bank, usage: [] });
  });

  /** Edits a question everywhere it's used. Attempts already started keep the version they began with. */
  r.put('/questions/:questionId', async (c) => {
    const { question, access } = await questionAccess(c);
    assertWritable(access);
    const input = await readBody(c, z.intersection(questionInputSchema, withCategory));
    const row = await updateQuestion(db, question, input, input.categoryId);
    return c.json(await toBankQuestion(db, row));
  });

  r.post('/questions/:questionId/duplicate', async (c) => {
    const user = requireUser(c);
    const { question, access } = await questionAccess(c);
    assertWritable(access);
    return c.json(await toBankQuestion(db, await duplicateQuestion(db, question, user.id)), 201);
  });

  r.delete('/questions/:questionId', async (c) => {
    const { question, access } = await questionAccess(c);
    assertWritable(access);
    await deleteQuestion(db, question);
    return c.json({ ok: true });
  });

  /** The question as a student would see it, freshly shuffled. */
  r.get('/questions/:questionId/preview', async (c) => {
    const { question } = await questionReadAccess(c);
    const snapshot = snapshotFromRow(question);
    return c.json({ question: studentQuestion(snapshot), answer: effectiveAnswer(snapshot, undefined) ?? null });
  });

  /** Grades a preview answer: `{ answer }`. Returns the result and the question with its answers. */
  r.post('/questions/:questionId/check', async (c) => {
    const { question } = await questionReadAccess(c);
    const { answer } = await readBody(c, z.object({ answer: answerSchema.default({}) }));
    const snapshot = snapshotFromRow(question);
    return c.json({ result: gradeQuestion(snapshot, answer as AttemptAnswer), question: reviewQuestion(snapshot, true) });
  });

  return r;
}
