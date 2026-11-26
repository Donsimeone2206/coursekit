import type { SharedFrom } from '../../shared/question-sharing.js';
import type { BankQuestion, BankQuestionSummary, Paginated, QuestionCategory, QuestionType, QuestionUsage } from '../../shared/types.js';
import type { Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import type { Database, QuestionCategoryRow, QuestionRow } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { likePattern, newId, now, num } from '../lib/util.js';
import { editorQuestion, questionLabel, storedQuestion, type QuestionInput } from './question-types.js';

export const DEFAULT_CATEGORY_NAME = 'Default';

/** Runs `fn` in a transaction, or in the caller's one if `db` already is a transaction. */
export async function transact<T>(db: DB, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.isTransaction ? fn(db as Transaction<Database>) : db.transaction().execute(fn);
}

/** Categories in tree order (each parent followed by its subcategories), siblings by position then name. */
export function sortCategories<T extends Pick<QuestionCategoryRow, 'id' | 'parentId' | 'position' | 'name'>>(rows: T[]): T[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const parent = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const out: T[] = [];
  const visit = (parent: string | null) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const r of list) {
      out.push(r);
      visit(r.id);
    }
  };
  visit(null);
  return out;
}

/** The category and everything below it. */
export function subtreeIds(rows: Pick<QuestionCategoryRow, 'id' | 'parentId'>[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of rows) if (r.parentId === out[i] && !out.includes(r.id)) out.push(r.id);
  return out;
}

/** The categories a question in `id` is found under: itself and its parents. */
export function ancestorIds(rows: Pick<QuestionCategoryRow, 'id' | 'parentId'>[], id: string): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  for (let cur = byId.get(id); cur && !out.includes(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur.id);
  return out;
}

export async function loadCategories(db: DB, courseId: string): Promise<QuestionCategoryRow[]> {
  return sortCategories(await db.selectFrom('questionCategories').selectAll().where('courseId', '=', courseId).execute());
}

/** Every course's bank has at least one category; the first is created on demand. */
export async function ensureCategories(db: DB, courseId: string): Promise<QuestionCategoryRow[]> {
  const rows = await loadCategories(db, courseId);
  if (rows.length) return rows;
  const row: QuestionCategoryRow = {
    id: newId(),
    courseId,
    parentId: null,
    name: DEFAULT_CATEGORY_NAME,
    description: '',
    position: 0,
    createdAt: now(),
  };
  await db.insertInto('questionCategories').values(row).execute();
  return [row];
}

export async function listCategories(db: DB, courseId: string): Promise<QuestionCategory[]> {
  const rows = await ensureCategories(db, courseId);
  const counts = await db
    .selectFrom('questions')
    .select(['categoryId', (eb) => eb.fn.countAll().as('n')])
    .where('courseId', '=', courseId)
    .groupBy('categoryId')
    .execute();
  const byCategory = new Map(counts.map((c) => [c.categoryId, num(c.n)]));
  return rows.map((r) => ({ ...r, questionCount: byCategory.get(r.id) ?? 0 }));
}

async function categoryInCourse(db: DB, courseId: string, id: string, what = 'category'): Promise<QuestionCategoryRow> {
  const row = await db
    .selectFrom('questionCategories')
    .selectAll()
    .where('id', '=', id)
    .where('courseId', '=', courseId)
    .executeTakeFirst();
  if (!row) throw badRequest(`That ${what} is not in this course's question bank.`);
  return row;
}

export async function createCategory(
  db: DB,
  courseId: string,
  input: { name: string; description: string; parentId: string | null },
): Promise<QuestionCategoryRow> {
  if (input.parentId) await categoryInCourse(db, courseId, input.parentId, 'parent category');
  const siblings = await db
    .selectFrom('questionCategories')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('courseId', '=', courseId)
    .where((eb) => (input.parentId ? eb('parentId', '=', input.parentId) : eb('parentId', 'is', null)))
    .executeTakeFirst();
  const row: QuestionCategoryRow = {
    id: newId(),
    courseId,
    parentId: input.parentId,
    name: input.name,
    description: input.description,
    position: siblings?.max == null ? 0 : num(siblings.max) + 1,
    createdAt: now(),
  };
  await db.insertInto('questionCategories').values(row).execute();
  return row;
}

export async function updateCategory(
  db: DB,
  category: QuestionCategoryRow,
  input: { name?: string | undefined; description?: string | undefined; parentId?: string | null | undefined },
): Promise<void> {
  const update: Partial<QuestionCategoryRow> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.parentId !== undefined && input.parentId !== category.parentId) {
    if (input.parentId) {
      const all = await loadCategories(db, category.courseId);
      await categoryInCourse(db, category.courseId, input.parentId, 'parent category');
      if (subtreeIds(all, category.id).includes(input.parentId)) throw badRequest("A category can't be moved inside itself.");
    }
    update.parentId = input.parentId;
  }
  if (Object.keys(update).length) await db.updateTable('questionCategories').set(update).where('id', '=', category.id).execute();
}

/** Deletes a category. Its questions, subcategories and random quiz slots move to `moveTo` first. */
export async function deleteCategory(db: DB, category: QuestionCategoryRow, moveTo: string | null): Promise<void> {
  const all = await loadCategories(db, category.courseId);
  if (all.length <= 1) throw badRequest("This is the bank's only category. Create another one before deleting it.");
  const [questions, slots] = await Promise.all([
    db
      .selectFrom('questions')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('categoryId', '=', category.id)
      .executeTakeFirst(),
    db
      .selectFrom('quizSlots')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('categoryId', '=', category.id)
      .executeTakeFirst(),
  ]);
  const hasContent = num(questions?.n) > 0 || num(slots?.n) > 0 || all.some((c) => c.parentId === category.id);
  if (hasContent && !moveTo) {
    throw badRequest('This category has questions, subcategories or random quiz questions. Choose a category to move them to.');
  }
  if (moveTo) {
    await categoryInCourse(db, category.courseId, moveTo);
    if (subtreeIds(all, category.id).includes(moveTo)) throw badRequest('Move the contents to a category outside the one being deleted.');
  }
  // Random slots of other courses' quizzes (the category was shared with them) must not start drawing from `moveTo`.
  const elsewhere = await db
    .selectFrom('quizSlots')
    .innerJoin('activities', 'activities.id', 'quizSlots.activityId')
    .select('quizSlots.id')
    .where('quizSlots.categoryId', '=', category.id)
    .where('activities.courseId', '!=', category.courseId)
    .executeTakeFirst();
  if (elsewhere) throw conflict('Quizzes in other courses pick random questions from this category, so it can’t be deleted.');
  await transact(db, async (trx) => {
    if (moveTo) {
      await trx.updateTable('questions').set({ categoryId: moveTo, updatedAt: now() }).where('categoryId', '=', category.id).execute();
      await trx.updateTable('questionCategories').set({ parentId: moveTo }).where('parentId', '=', category.id).execute();
      await trx.updateTable('quizSlots').set({ categoryId: moveTo }).where('categoryId', '=', category.id).execute();
    }
    await trx.deleteFrom('questionCategories').where('id', '=', category.id).execute();
  });
}

export interface QuestionFilter {
  categoryId?: string | undefined;
  includeSubcategories?: boolean | undefined;
  q?: string | undefined;
  type?: QuestionType | undefined;
  page: number;
  pageSize: number;
}

/** Number of quizzes (of one course, if given) that use each question directly. */
async function quizCounts(db: DB, ids: string[], courseId?: string): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  let query = db
    .selectFrom('quizSlots')
    .select(['quizSlots.questionId', (eb) => eb.fn.count('quizSlots.activityId').distinct().as('n')])
    .where('quizSlots.questionId', 'in', ids);
  if (courseId) query = query.innerJoin('activities', 'activities.id', 'quizSlots.activityId').where('activities.courseId', '=', courseId);
  const rows = await query.groupBy('quizSlots.questionId').execute();
  return new Map(rows.map((r) => [r.questionId!, num(r.n)]));
}

type SummaryRow = Pick<QuestionRow, 'id' | 'type' | 'name' | 'prompt' | 'points' | 'categoryId' | 'updatedAt'> & { courseId?: string };

/** How a course sees bank questions: quiz counts of its own quizzes, and where other courses' questions come from. */
export interface SummaryView {
  courseId: string;
  sharedFrom?: Map<string, SharedFrom>;
}

export async function summarizeQuestions(
  db: DB,
  rows: SummaryRow[],
  categories: QuestionCategoryRow[],
  view?: SummaryView,
): Promise<BankQuestionSummary[]> {
  const counts = await quizCounts(
    db,
    rows.map((r) => r.id),
    view?.courseId,
  );
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const sharedFrom = view && r.courseId && r.courseId !== view.courseId ? view.sharedFrom?.get(r.courseId) : undefined;
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      excerpt: questionLabel({ prompt: r.prompt }, 160),
      points: r.points,
      categoryId: r.categoryId,
      categoryName: names.get(r.categoryId) ?? '',
      quizCount: counts.get(r.id) ?? 0,
      updatedAt: r.updatedAt,
      ...(sharedFrom ? { sharedFrom } : {}),
    };
  });
}

/** Lists a bank's questions. `view` is the course looking at them, when the bank is shared with another course. */
export async function listQuestions(
  db: DB,
  courseId: string,
  filter: QuestionFilter,
  view: SummaryView = { courseId },
): Promise<Paginated<BankQuestionSummary>> {
  const categories = await loadCategories(db, courseId);
  let query = db.selectFrom('questions').where('courseId', '=', courseId);
  if (filter.categoryId) {
    const ids = filter.includeSubcategories ? subtreeIds(categories, filter.categoryId) : [filter.categoryId];
    query = query.where('categoryId', 'in', ids);
  }
  if (filter.type) query = query.where('type', '=', filter.type);
  if (filter.q?.trim()) {
    const pattern = likePattern(filter.q);
    query = query.where((eb) => eb.or([eb(eb.fn('lower', ['name']), 'like', pattern), eb(eb.fn('lower', ['prompt']), 'like', pattern)]));
  }
  const totalRow = await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
  const rows = await query
    .select(['id', 'type', 'name', 'prompt', 'points', 'categoryId', 'courseId', 'updatedAt'])
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize)
    .execute();
  return {
    items: await summarizeQuestions(db, rows, categories, view),
    total: num(totalRow?.n),
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

/** Quizzes that use a question, directly or through a random slot whose category includes it. */
export async function questionUsage(db: DB, question: Pick<QuestionRow, 'id' | 'courseId' | 'categoryId'>): Promise<QuestionUsage[]> {
  const categories = await loadCategories(db, question.courseId);
  const ancestors = ancestorIds(categories, question.categoryId);
  const rows = await db
    .selectFrom('quizSlots')
    .innerJoin('activities', 'activities.id', 'quizSlots.activityId')
    .select(['activities.id', 'activities.title', 'quizSlots.kind'])
    // Only this course's quizzes: courses the question is shared with keep their quiz titles to themselves.
    .where('activities.courseId', '=', question.courseId)
    .where((eb) =>
      eb.or([
        eb('quizSlots.questionId', '=', question.id),
        eb.and([eb('quizSlots.kind', '=', 'random'), eb('quizSlots.categoryId', '=', question.categoryId)]),
        ...(ancestors.length > 1
          ? [
              eb.and([
                eb('quizSlots.kind', '=', 'random'),
                eb('quizSlots.includeSubcategories', '=', 1),
                eb('quizSlots.categoryId', 'in', ancestors),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy('activities.title')
    .execute();
  const seen = new Set<string>();
  const out: QuestionUsage[] = [];
  // A direct use wins over a random pool in the same quiz.
  for (const kind of ['question', 'random'] as const) {
    for (const r of rows) {
      if (r.kind !== kind || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ activityId: r.id, title: r.title, kind });
    }
  }
  return out;
}

export async function toBankQuestion(db: DB, row: QuestionRow): Promise<BankQuestion> {
  return {
    ...editorQuestion(row),
    name: row.name,
    categoryId: row.categoryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    usage: await questionUsage(db, row),
  };
}

export async function findQuestion(db: DB, id: string): Promise<QuestionRow> {
  const row = await db.selectFrom('questions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Question');
  return row;
}

export async function createQuestion(
  db: DB,
  courseId: string,
  categoryId: string | null | undefined,
  input: QuestionInput,
  userId: string | null,
): Promise<QuestionRow> {
  const category = categoryId ? await categoryInCourse(db, courseId, categoryId) : (await ensureCategories(db, courseId))[0]!;
  const ts = now();
  const row: QuestionRow = {
    id: newId(),
    courseId,
    categoryId: category.id,
    ...storedQuestion(input),
    createdBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insertInto('questions').values(row).execute();
  return row;
}

/** Edits a bank question. Attempts already started keep their own copy. */
export async function updateQuestion(db: DB, row: QuestionRow, input: QuestionInput, categoryId?: string | null): Promise<QuestionRow> {
  const category = categoryId && categoryId !== row.categoryId ? (await categoryInCourse(db, row.courseId, categoryId)).id : row.categoryId;
  const next: QuestionRow = { ...row, ...storedQuestion(input), categoryId: category, updatedAt: now() };
  const { id, ...rest } = next;
  await db.updateTable('questions').set(rest).where('id', '=', id).execute();
  return next;
}

export async function duplicateQuestion(db: DB, row: QuestionRow, userId: string | null): Promise<QuestionRow> {
  const ts = now();
  const copy: QuestionRow = {
    ...row,
    id: newId(),
    name: `${questionLabel(row, 180)} (copy)`.slice(0, 200),
    createdBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insertInto('questions').values(copy).execute();
  return copy;
}

export async function moveQuestions(db: DB, courseId: string, ids: string[], categoryId: string): Promise<number> {
  const category = await categoryInCourse(db, courseId, categoryId);
  if (ids.length === 0) return 0;
  const result = await db
    .updateTable('questions')
    .set({ categoryId: category.id, updatedAt: now() })
    .where('courseId', '=', courseId)
    .where('id', 'in', ids)
    .executeTakeFirst();
  return num(result.numUpdatedRows);
}

/** Deletes a question that no quiz uses directly. Past attempts keep their snapshot of it. */
export async function deleteQuestion(db: DB, row: QuestionRow): Promise<void> {
  await transact(db, async (trx) => {
    const uses = await trx
      .selectFrom('quizSlots')
      .innerJoin('activities', 'activities.id', 'quizSlots.activityId')
      .select(['activities.title', 'activities.courseId'])
      .distinct()
      .where('quizSlots.questionId', '=', row.id)
      .orderBy('activities.title')
      .execute();
    const used = uses.filter((u) => u.courseId === row.courseId);
    if (uses.length > 0 && used.length === 0) {
      throw conflict('Quizzes in other courses that this question was shared with use it, so it can’t be deleted.');
    }
    if (used.length) {
      const titles = used.map((u) => `“${u.title}”`).join(', ');
      throw conflict(`This question is used in ${used.length === 1 ? 'the quiz' : 'these quizzes'} ${titles}. Remove it there first.`);
    }
    await trx.deleteFrom('questions').where('id', '=', row.id).execute();
  });
}
