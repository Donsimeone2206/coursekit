/**
 * Sharing question categories between courses, and copying questions and categories to other courses.
 *
 * A share makes a category and everything below it usable (read-only) in another course's bank, quiz editor
 * and random quiz questions; only the owning course edits it. Copies are independent of their source.
 * Quiz slots that already use shared questions keep working when a share ends (see endShare and quiz-slots.ts).
 */
import type { CourseRef, CourseRole, QuestionCategory } from '../../shared/types.js';
import { getCourseCapabilities, ROLE_CAPABILITIES } from '../../shared/permissions.js';
import {
  MAX_TRANSFER_CATEGORIES,
  MAX_TRANSFER_QUESTIONS,
  type QuestionShare,
  type SharedFrom,
  type SharedQuestionCategory,
} from '../../shared/question-sharing.js';
import type { DB } from '../db/types.js';
import type { QuestionCategoryRow, QuestionRow, UserRow } from '../db/schema.js';
import type { QuestionCategoryShareRow } from '../db/schema-question-sharing.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { newId, now, num } from '../lib/util.js';
import { ancestorIds, ensureCategories, loadCategories, sortCategories, subtreeIds, transact } from './question-bank.js';

/** Course roles whose members manage the course's question bank. */
const MANAGER_ROLES = (Object.keys(ROLE_CAPABILITIES) as CourseRole[]).filter((r) => ROLE_CAPABILITIES[r].includes('questionbank:manage'));

/** Courses whose question bank the user manages: every course for administrators. */
export async function manageableCourseIds(db: DB, user: UserRow): Promise<'all' | Set<string>> {
  if (getCourseCapabilities(user.role, null).includes('questionbank:manage')) return 'all';
  if (MANAGER_ROLES.length === 0) return new Set();
  const rows = await db
    .selectFrom('enrolments')
    .select('courseId')
    .where('userId', '=', user.id)
    .where('status', '=', 'active')
    .where('role', 'in', MANAGER_ROLES)
    .execute();
  return new Set(rows.map((r) => r.courseId));
}

export async function manageableCourses(db: DB, user: UserRow): Promise<CourseRef[]> {
  const ids = await manageableCourseIds(db, user);
  if (ids !== 'all' && ids.size === 0) return [];
  let query = db.selectFrom('courses').select(['id', 'slug', 'title', 'coverColor']).orderBy('title').orderBy('id').limit(1000);
  if (ids !== 'all') query = query.where('id', 'in', [...ids]);
  return query.execute();
}

export async function canManageBank(db: DB, user: UserRow, courseId: string): Promise<boolean> {
  const ids = await manageableCourseIds(db, user);
  return ids === 'all' || ids.has(courseId);
}

interface SharedRows {
  /** Category ids of other courses' banks that the course can use. */
  ids: Set<string>;
  rows: QuestionCategoryRow[];
}

/** The categories other courses share with `courseId`: each shared category and everything below it. */
export async function sharedCategoryRows(db: DB, courseId: string): Promise<SharedRows> {
  const shares = await db
    .selectFrom('questionCategoryShares as s')
    .innerJoin('questionCategories as c', 'c.id', 's.categoryId')
    .select(['s.categoryId', 'c.courseId'])
    .where((eb) => eb.or([eb('s.courseId', '=', courseId), eb('s.courseId', 'is', null)]))
    .where('c.courseId', '!=', courseId)
    .execute();
  if (shares.length === 0) return { ids: new Set(), rows: [] };
  const sources = [...new Set(shares.map((s) => s.courseId))];
  const all = await db.selectFrom('questionCategories').selectAll().where('courseId', 'in', sources).execute();
  const ids = new Set<string>();
  for (const s of shares) for (const id of subtreeIds(all, s.categoryId)) ids.add(id);
  return { ids, rows: all.filter((r) => ids.has(r.id)) };
}

async function courseTitles(db: DB, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('courses').select(['id', 'title']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Where questions of other courses come from, for labels. */
export async function sharedFromMap(db: DB, courseIds: string[]): Promise<Map<string, SharedFrom>> {
  const titles = await courseTitles(db, [...new Set(courseIds)]);
  return new Map([...titles].map(([courseId, courseTitle]) => [courseId, { courseId, courseTitle }]));
}

/** Shared categories for a course's bank, grouped by course, in tree order (shared tops have no parent). */
export async function listSharedCategories(db: DB, courseId: string): Promise<SharedQuestionCategory[]> {
  const { ids, rows } = await sharedCategoryRows(db, courseId);
  if (rows.length === 0) return [];
  const counts = await db
    .selectFrom('questions')
    .select(['categoryId', (eb) => eb.fn.countAll().as('n')])
    .where('categoryId', 'in', [...ids])
    .groupBy('categoryId')
    .execute();
  const byCategory = new Map(counts.map((c) => [c.categoryId, num(c.n)]));
  const from = await sharedFromMap(
    db,
    rows.map((r) => r.courseId),
  );
  const courses = [...from.values()].sort((a, b) => a.courseTitle.localeCompare(b.courseTitle) || a.courseId.localeCompare(b.courseId));
  return courses.flatMap((course) =>
    sortCategories(
      rows
        .filter((r) => r.courseId === course.courseId)
        .map((r) => ({ ...r, parentId: r.parentId && ids.has(r.parentId) ? r.parentId : null })),
    ).map((r): SharedQuestionCategory => ({ ...(r as QuestionCategory), questionCount: byCategory.get(r.id) ?? 0, sharedFrom: course })),
  );
}

/** Whether a course may use a category: its own, or shared with it. */
export async function canUseCategory(db: DB, courseId: string, category: Pick<QuestionCategoryRow, 'id' | 'courseId'>): Promise<boolean> {
  if (category.courseId === courseId) return true;
  return (await sharedCategoryRows(db, courseId)).ids.has(category.id);
}

/** Whether the user can read a category and its questions: they manage its bank, or one it's shared with. */
export async function canReadCategory(db: DB, user: UserRow, category: QuestionCategoryRow): Promise<boolean> {
  const managed = await manageableCourseIds(db, user);
  if (managed === 'all' || managed.has(category.courseId)) return true;
  if (managed.size === 0) return false;
  const ancestors = ancestorIds(await loadCategories(db, category.courseId), category.id);
  if (ancestors.length === 0) return false;
  const shares = await db.selectFrom('questionCategoryShares').select('courseId').where('categoryId', 'in', ancestors).execute();
  return shares.some((s) => s.courseId === null || managed.has(s.courseId));
}

export async function findCategory(db: DB, id: string): Promise<QuestionCategoryRow> {
  const row = await db.selectFrom('questionCategories').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Category');
  return row;
}

// ---------------------------------------------------------------------------------------------------- shares

export async function listShares(db: DB, categoryId: string): Promise<QuestionShare[]> {
  const rows = await db
    .selectFrom('questionCategoryShares as s')
    .leftJoin('courses as c', 'c.id', 's.courseId')
    .select(['s.id', 's.categoryId', 's.courseId', 's.createdAt', 'c.slug', 'c.title', 'c.coverColor'])
    .where('s.categoryId', '=', categoryId)
    .orderBy('s.createdAt')
    .orderBy('s.id')
    .execute();
  return rows
    .map((r) => ({
      id: r.id,
      categoryId: r.categoryId,
      course: r.courseId ? { id: r.courseId, slug: r.slug ?? '', title: r.title ?? '', coverColor: r.coverColor ?? '' } : null,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => (a.course ? 1 : 0) - (b.course ? 1 : 0) || (a.course?.title ?? '').localeCompare(b.course?.title ?? ''));
}

/** Shares a category with a course the user also manages, or (administrators) with every course on the site. */
export async function addShare(
  db: DB,
  user: UserRow,
  category: QuestionCategoryRow,
  input: { courseId?: string | null | undefined; site?: boolean | undefined },
): Promise<QuestionShare> {
  let courseId: string | null = null;
  if (input.site) {
    if (user.role !== 'admin') throw forbidden('Only administrators can share questions with every course on the site.');
  } else {
    if (!input.courseId) throw badRequest('Choose a course to share with.');
    const course = await db.selectFrom('courses').select('id').where('id', '=', input.courseId).executeTakeFirst();
    if (!course || !(await canManageBank(db, user, course.id)))
      throw badRequest('You can only share with courses whose question bank you manage.');
    if (course.id === category.courseId) throw badRequest('This category is already in that course’s bank.');
    courseId = course.id;
  }
  const existing = await db
    .selectFrom('questionCategoryShares')
    .select('id')
    .where('categoryId', '=', category.id)
    .where((eb) => (courseId ? eb('courseId', '=', courseId) : eb('courseId', 'is', null)))
    .executeTakeFirst();
  if (!existing) {
    await db
      .insertInto('questionCategoryShares')
      .values({ id: newId(), categoryId: category.id, courseId, createdBy: user.id, createdAt: now() })
      .execute();
  }
  const shares = await listShares(db, category.id);
  return shares.find((s) => (s.course?.id ?? null) === courseId)!;
}

/**
 * Ends a share. Random slots of other courses' quizzes that draw from the category (and aren't covered by
 * another share) keep picking from the questions they had at this moment: questions and subcategories
 * added later stay private. Fixed question slots keep their question (see saveSlots).
 */
export async function endShare(db: DB, share: QuestionCategoryShareRow, ownerCourseId: string): Promise<void> {
  await transact(db, async (trx) => {
    await trx.deleteFrom('questionCategoryShares').where('id', '=', share.id).execute();
    const all = await loadCategories(trx, ownerCourseId);
    let query = trx
      .selectFrom('quizSlots')
      .innerJoin('activities', 'activities.id', 'quizSlots.activityId')
      .select(['quizSlots.id', 'quizSlots.categoryId', 'quizSlots.includeSubcategories', 'activities.courseId'])
      .where('quizSlots.kind', '=', 'random')
      .where('quizSlots.categoryId', 'in', subtreeIds(all, share.categoryId))
      .where('activities.courseId', '!=', ownerCourseId);
    if (share.courseId) query = query.where('activities.courseId', '=', share.courseId);
    const stillShared = new Map<string, Set<string>>();
    for (const slot of await query.execute()) {
      if (!stillShared.has(slot.courseId)) stillShared.set(slot.courseId, (await sharedCategoryRows(trx, slot.courseId)).ids);
      if (stillShared.get(slot.courseId)!.has(slot.categoryId!)) continue;
      const categories = slot.includeSubcategories ? subtreeIds(all, slot.categoryId!) : [slot.categoryId!];
      const ids = await trx.selectFrom('questions').select('id').where('categoryId', 'in', categories).orderBy('id').execute();
      await trx.deleteFrom('quizSlotPools').where('slotId', '=', slot.id).execute();
      await trx
        .insertInto('quizSlotPools')
        .values({ slotId: slot.id, questionIds: JSON.stringify(ids.map((r) => r.id)) })
        .execute();
    }
  });
}

// ---------------------------------------------------------------------------------------------------- copies

async function targetCategory(db: DB, courseId: string, categoryId: string | null | undefined): Promise<QuestionCategoryRow> {
  if (!categoryId) return (await ensureCategories(db, courseId))[0]!;
  const row = await db
    .selectFrom('questionCategories')
    .selectAll()
    .where('id', '=', categoryId)
    .where('courseId', '=', courseId)
    .executeTakeFirst();
  if (!row) throw badRequest('That category is not in the target course’s question bank.');
  return row;
}

function copyRow(row: QuestionRow, courseId: string, categoryId: string, userId: string, ts: string): QuestionRow {
  return { ...row, id: newId(), courseId, categoryId, createdBy: userId, createdAt: ts, updatedAt: ts };
}

async function insertQuestions(db: DB, rows: QuestionRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 50) {
    await db
      .insertInto('questions')
      .values(rows.slice(i, i + 50))
      .execute();
  }
}

/** Copies questions into a category of the target course (by default its first category). */
export async function copyQuestions(
  db: DB,
  userId: string,
  rows: QuestionRow[],
  targetCourseId: string,
  targetCategoryId: string | null | undefined,
): Promise<number> {
  if (rows.length > MAX_TRANSFER_QUESTIONS) throw badRequest(`Copy up to ${MAX_TRANSFER_QUESTIONS} questions at a time.`);
  const category = await targetCategory(db, targetCourseId, targetCategoryId);
  const ts = now();
  await transact(db, (trx) =>
    insertQuestions(
      trx,
      rows.map((r) => copyRow(r, targetCourseId, category.id, userId, ts)),
    ),
  );
  return rows.length;
}

/** Copies a category (and, by default, its subcategories) with all its questions into the target course. */
export async function copyCategory(
  db: DB,
  userId: string,
  source: QuestionCategoryRow,
  includeSubcategories: boolean,
  targetCourseId: string,
  parentId: string | null | undefined,
): Promise<{ questions: number; categories: number; categoryId: string }> {
  const all = await loadCategories(db, source.courseId);
  const wanted = new Set(includeSubcategories ? subtreeIds(all, source.id) : [source.id]);
  const categories = all.filter((c) => wanted.has(c.id));
  if (categories.length > MAX_TRANSFER_CATEGORIES) throw badRequest(`Copy up to ${MAX_TRANSFER_CATEGORIES} categories at a time.`);
  const questions = await db
    .selectFrom('questions')
    .selectAll()
    .where('categoryId', 'in', [...wanted])
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  if (questions.length > MAX_TRANSFER_QUESTIONS) throw badRequest(`Copy up to ${MAX_TRANSFER_QUESTIONS} questions at a time.`);
  const parent = parentId ? await targetCategory(db, targetCourseId, parentId) : null;
  const siblings = await db
    .selectFrom('questionCategories')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('courseId', '=', targetCourseId)
    .where((eb) => (parent ? eb('parentId', '=', parent.id) : eb('parentId', 'is', null)))
    .executeTakeFirst();
  const ts = now();
  const ids = new Map(categories.map((c) => [c.id, newId()]));
  const rows: QuestionCategoryRow[] = categories.map((c) => ({
    id: ids.get(c.id)!,
    courseId: targetCourseId,
    parentId: c.id === source.id ? (parent?.id ?? null) : ids.get(c.parentId!)!,
    name: c.name,
    description: c.description,
    position: c.id === source.id ? (siblings?.max == null ? 0 : num(siblings.max) + 1) : c.position,
    createdAt: ts,
  }));
  await transact(db, async (trx) => {
    for (const row of rows) await trx.insertInto('questionCategories').values(row).execute();
    await insertQuestions(
      trx,
      questions.map((q) => copyRow(q, targetCourseId, ids.get(q.categoryId)!, userId, ts)),
    );
  });
  return { questions: questions.length, categories: rows.length, categoryId: ids.get(source.id)! };
}
