import { Hono } from 'hono';
import { z } from 'zod';
import {
  MAX_IMPORT_BYTES,
  MAX_TRANSFER_QUESTIONS,
  type QuestionCopyResult,
  type QuestionShareSettings,
} from '../../shared/question-sharing.js';
import { requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import { notFound, readBody } from '../lib/http.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import { exportQuestions } from '../services/question-export.js';
import { previewImport, runImport } from '../services/question-import.js';
import {
  addShare,
  canManageBank,
  canReadCategory,
  copyCategory,
  copyQuestions,
  endShare,
  findCategory,
  listSharedCategories,
  listShares,
  manageableCourses,
} from '../services/question-sharing.js';

const id = z.string().min(1).max(40);
const format = z.enum(['gift', 'moodle']);

const importSchema = z.object({
  content: z.string().max(MAX_IMPORT_BYTES, `Import files of up to ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB.`),
  filename: z.string().max(255).optional(),
  format: format.optional(),
  categoryId: id.nullable().default(null),
  createCategories: z.boolean().default(true),
});

/**
 * Question import and export (Moodle XML, GIFT), copies to other courses and category shares. Everything
 * needs `questionbank:manage` in the course concerned; shares are managed by the category's own course.
 */
export function questionSharingRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function bankAccess(c: AppContext, courseId: string) {
    const access = await loadCourseAccess(db, requireUser(c), courseId);
    assertCan(access, 'questionbank:manage');
    return access;
  }

  /** A category, for its own course's bank managers (anyone else gets a 404). */
  async function ownCategoryAccess(c: AppContext) {
    const category = await findCategory(db, c.req.param('categoryId')!);
    const access = await loadCourseAccess(db, requireUser(c), category.courseId);
    if (!access.can('questionbank:manage')) throw notFound('Category');
    return { category, access };
  }

  /** Courses whose question bank the viewer manages: where questions can be copied or shared to. */
  r.get('/question-bank/courses', async (c) => c.json(await manageableCourses(db, requireUser(c))));

  /** Categories of other courses shared with this one (read-only here). */
  r.get('/courses/:courseId/shared-question-categories', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    return c.json(await listSharedCategories(db, access.course.id));
  });

  r.get('/question-categories/:categoryId/shares', async (c) => {
    const user = requireUser(c);
    const { category } = await ownCategoryAccess(c);
    const settings: QuestionShareSettings = {
      category: { id: category.id, name: category.name, courseId: category.courseId },
      shares: await listShares(db, category.id),
      courses: (await manageableCourses(db, user)).filter((course) => course.id !== category.courseId),
      canShareWithSite: user.role === 'admin',
    };
    return c.json(settings);
  });

  /** Shares the category (and its subcategories) with `{ courseId }`, or with every course: `{ site: true }` (administrators). */
  r.post('/question-categories/:categoryId/shares', async (c) => {
    const user = requireUser(c);
    const { category, access } = await ownCategoryAccess(c);
    assertWritable(access);
    const input = await readBody(c, z.object({ courseId: id.nullable().optional(), site: z.boolean().optional() }));
    return c.json(await addShare(db, user, category, input), 201);
  });

  /** Ends a share. Quizzes that already use the questions keep them (random slots: those there now); they can't be added again. */
  r.delete('/question-category-shares/:shareId', async (c) => {
    const user = requireUser(c);
    const share = await db.selectFrom('questionCategoryShares').selectAll().where('id', '=', c.req.param('shareId')).executeTakeFirst();
    if (!share) throw notFound('Share');
    const category = await findCategory(db, share.categoryId);
    if (!(await canManageBank(db, user, category.courseId))) throw notFound('Share');
    await endShare(db, share, category.courseId);
    return c.json({ ok: true });
  });

  /** Copies questions, or a category with its subcategories, into a course whose bank the viewer manages. */
  r.post('/question-copies', async (c) => {
    const user = requireUser(c);
    const input = await readBody(
      c,
      z
        .object({
          targetCourseId: id,
          targetCategoryId: id.nullable().optional(),
          questionIds: z.array(id).min(1).max(MAX_TRANSFER_QUESTIONS).optional(),
          categoryId: id.optional(),
          includeSubcategories: z.boolean().default(true),
        })
        .refine((v) => !!v.questionIds !== !!v.categoryId, 'Choose questions or a category to copy.'),
    );
    const target = await bankAccess(c, input.targetCourseId);
    assertWritable(target);
    if (input.categoryId) {
      const source = await findCategory(db, input.categoryId);
      if (!(await canReadCategory(db, user, source))) throw notFound('Category');
      const copied = await copyCategory(db, user.id, source, input.includeSubcategories, target.course.id, input.targetCategoryId ?? null);
      return c.json(copied satisfies QuestionCopyResult, 201);
    }
    const ids = [...new Set(input.questionIds!)];
    const rows = await db.selectFrom('questions').selectAll().where('id', 'in', ids).orderBy('createdAt').orderBy('id').execute();
    if (rows.length !== ids.length) throw notFound('Question');
    const categories = await db
      .selectFrom('questionCategories')
      .selectAll()
      .where('id', 'in', [...new Set(rows.map((q) => q.categoryId))])
      .execute();
    for (const category of categories) if (!(await canReadCategory(db, user, category))) throw notFound('Question');
    const questions = await copyQuestions(db, user.id, rows, target.course.id, input.targetCategoryId);
    return c.json({ questions, categories: 0, categoryId: null } satisfies QuestionCopyResult, 201);
  });

  /** A file of the course's questions (or of a category shared with it): `{ format, categoryId?, includeSubcategories?, questionIds? }`. */
  r.post('/courses/:courseId/question-export', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    const input = await readBody(
      c,
      z.object({
        format,
        categoryId: id.optional(),
        includeSubcategories: z.boolean().default(true),
        questionIds: z.array(id).max(MAX_TRANSFER_QUESTIONS).optional(),
      }),
    );
    return c.json(await exportQuestions(db, access.course.id, input));
  });

  /** What importing the file would do. Nothing is saved. */
  r.post('/courses/:courseId/question-import/preview', async (c) => {
    const access = await bankAccess(c, c.req.param('courseId'));
    assertWritable(access);
    return c.json(await previewImport(db, access.course.id, await readBody(c, importSchema)));
  });

  /** Imports the file's valid questions in one go (questions with errors are skipped). */
  r.post('/courses/:courseId/question-import', async (c) => {
    const user = requireUser(c);
    const access = await bankAccess(c, c.req.param('courseId'));
    assertWritable(access);
    return c.json(await runImport(db, access.course.id, user.id, await readBody(c, importSchema)), 201);
  });

  return r;
}
