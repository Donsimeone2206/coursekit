/**
 * A quiz is an ordered list of slots. Each slot is a specific bank question, or "N random questions from
 * category X" (optionally including its subcategories), picked again for every attempt.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import type { QuizSlotInfo, QuizSlots } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import type { ActivityRow, QuestionCategoryRow, QuizSlotRow } from '../db/schema.js';
import { badRequest } from '../lib/http.js';
import { newId, num, parseJson, round } from '../lib/util.js';
import { loadCategories, sortCategories, subtreeIds, summarizeQuestions, transact } from './question-bank.js';
import { sharedCategoryRows, sharedFromMap } from './question-sharing.js';
import { shuffle, snapshotFromRow, type QuestionSnapshot } from './question-types.js';

/** Most questions one attempt can have. */
export const MAX_QUIZ_QUESTIONS = 200;

const markSchema = z.number().min(0, 'Marks can’t be negative').max(1000, 'Use a mark of 1000 or less').nullable().optional();

export const slotInputSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().max(40).optional(),
    kind: z.literal('question'),
    questionId: z.string().min(1).max(40),
    points: markSchema,
  }),
  z.object({
    id: z.string().max(40).optional(),
    kind: z.literal('random'),
    categoryId: z.string().min(1).max(40),
    questionCount: z.number().int('Use a whole number of questions').min(1, 'Pick at least one random question').max(MAX_QUIZ_QUESTIONS),
    includeSubcategories: z.boolean().default(false),
    points: markSchema,
  }),
]);

export type SlotInput = z.output<typeof slotInputSchema>;

export async function loadSlots(db: DB, activityId: string): Promise<QuizSlotRow[]> {
  return db.selectFrom('quizSlots').selectAll().where('activityId', '=', activityId).orderBy('position', 'asc').orderBy('id').execute();
}

/** Question count and total marks per quiz (quizzes without slots are left out). */
export async function quizTotals(db: DB, activityIds: string[]): Promise<Array<{ activityId: string; n: number; total: number }>> {
  if (activityIds.length === 0) return [];
  const rows = await db
    .selectFrom('quizSlots')
    .select([
      'activityId',
      (eb) => eb.fn.sum<number>('questionCount').as('n'),
      sql<number>`sum(${sql.ref('points')} * ${sql.ref('questionCount')})`.as('total'),
    ])
    .where('activityId', 'in', activityIds)
    .groupBy('activityId')
    .execute();
  return rows.map((r) => ({ activityId: r.activityId, n: num(r.n), total: round(num(r.total)) }));
}

/** The categories a random slot draws from. */
function slotCategories(slot: Pick<QuizSlotRow, 'categoryId' | 'includeSubcategories'>, categories: QuestionCategoryRow[]): string[] {
  if (!slot.categoryId) return [];
  return slot.includeSubcategories ? subtreeIds(categories, slot.categoryId) : [slot.categoryId];
}

interface Pools {
  categories: QuestionCategoryRow[];
  /** Question ids per random slot id, without the quiz's fixed questions. */
  pools: Map<string, string[]>;
}

/**
 * The quiz's course's categories, plus those of other courses whose categories the given ids belong to
 * (categories shared with this course, or that were shared when a slot started using them).
 */
async function categoriesFor(db: DB, activity: ActivityRow, categoryIds: Array<string | null>): Promise<QuestionCategoryRow[]> {
  const ids = [...new Set(categoryIds.filter((id): id is string => !!id))];
  const others = ids.length
    ? await db
        .selectFrom('questionCategories')
        .select('courseId')
        .distinct()
        .where('id', 'in', ids)
        .where('courseId', '!=', activity.courseId)
        .execute()
    : [];
  if (others.length === 0) return loadCategories(db, activity.courseId);
  const courses = [activity.courseId, ...others.map((o) => o.courseId)];
  return sortCategories(await db.selectFrom('questionCategories').selectAll().where('courseId', 'in', courses).execute());
}

/** Question ids of these that still exist. */
async function existingQuestionIds(db: DB, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .selectFrom('questions')
      .select('id')
      .where('id', 'in', ids.slice(i, i + 500))
      .execute();
    for (const r of rows) out.add(r.id);
  }
  return out;
}

async function randomPools(db: DB, activity: ActivityRow, slots: QuizSlotRow[]): Promise<Pools> {
  const random = slots.filter((s) => s.kind === 'random');
  if (random.length === 0) return { categories: [], pools: new Map() };
  const categories = await categoriesFor(
    db,
    activity,
    random.map((s) => s.categoryId),
  );
  const courseOf = new Map(categories.map((c) => [c.id, c.courseId]));
  const foreign = random.filter((s) => courseOf.get(s.categoryId!) !== activity.courseId);
  const shared = foreign.length ? (await sharedCategoryRows(db, activity.courseId)).ids : new Set<string>();
  // Another course's category draws live only while it's shared with this course; after the share ended, the
  // slot picks from the questions it had then (see endShare), or from nothing.
  const live = (slot: QuizSlotRow): string[] => {
    if (courseOf.get(slot.categoryId!) === activity.courseId) return slotCategories(slot, categories);
    return shared.has(slot.categoryId!) ? slotCategories(slot, categories).filter((id) => shared.has(id)) : [];
  };
  const ended = foreign.filter((s) => !shared.has(s.categoryId!));
  const frozen = new Map<string, string[]>();
  if (ended.length) {
    const rows = await db
      .selectFrom('quizSlotPools')
      .selectAll()
      .where(
        'slotId',
        'in',
        ended.map((s) => s.id),
      )
      .execute();
    for (const r of rows) frozen.set(r.slotId, parseJson<string[]>(r.questionIds, []));
  }
  const stillThere = await existingQuestionIds(db, [...new Set([...frozen.values()].flat())]);
  const wanted = [...new Set(random.flatMap(live))];
  const rows = wanted.length
    ? await db.selectFrom('questions').select(['id', 'categoryId']).where('categoryId', 'in', wanted).orderBy('id').execute()
    : [];
  const fixed = new Set(slots.filter((s) => s.kind === 'question').map((s) => s.questionId));
  const pools = new Map<string, string[]>();
  for (const slot of random) {
    const kept = frozen.get(slot.id);
    const cats = new Set(live(slot));
    const ids = kept ? kept.filter((id) => stillThere.has(id)) : rows.filter((r) => cats.has(r.categoryId)).map((r) => r.id);
    pools.set(
      slot.id,
      ids.filter((id) => !fixed.has(id)),
    );
  }
  return { categories, pools };
}

/**
 * Questions that random slots drawing from inside this slot's categories need in all. Category pools nest
 * (a subtree contains its subtrees), so filling the smallest pools first succeeds whenever, for every slot,
 * this need is at most the questions available.
 */
function neededFrom(slot: QuizSlotRow, random: QuizSlotRow[], categories: QuestionCategoryRow[]): number {
  const cats = new Set(slotCategories(slot, categories));
  return random
    .filter((other) => slotCategories(other, categories).every((c) => cats.has(c)))
    .reduce((sum, other) => sum + other.questionCount, 0);
}

export async function describeSlots(db: DB, activity: ActivityRow): Promise<QuizSlots> {
  const slots = await loadSlots(db, activity.id);
  const fixedIds = slots.filter((s) => s.kind === 'question').map((s) => s.questionId!);
  const { pools } = await randomPools(db, activity, slots);
  const rows = fixedIds.length
    ? await db
        .selectFrom('questions')
        .select(['id', 'type', 'name', 'prompt', 'points', 'categoryId', 'courseId', 'updatedAt'])
        .where('id', 'in', fixedIds)
        .execute()
    : [];
  const categories = await categoriesFor(db, activity, [...slots.map((s) => s.categoryId), ...rows.map((r) => r.categoryId)]);
  const sharedFrom = await sharedFromMap(
    db,
    categories.filter((c) => c.courseId !== activity.courseId).map((c) => c.courseId),
  );
  const summaries = new Map(
    (await summarizeQuestions(db, rows, categories, { courseId: activity.courseId, sharedFrom })).map((q) => [q.id, q]),
  );
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryInfo = (id: string) => {
    const c = categoryById.get(id);
    const from = c && c.courseId !== activity.courseId ? sharedFrom.get(c.courseId) : undefined;
    return { id, name: c?.name ?? '', ...(from ? { sharedFrom: from } : {}) };
  };
  const random = slots.filter((s) => s.kind === 'random');
  const problems: string[] = [];

  const items: QuizSlotInfo[] = slots.map((s) => {
    const info: QuizSlotInfo = {
      id: s.id,
      kind: s.kind,
      points: s.points,
      questionCount: s.questionCount,
      question: s.kind === 'question' ? (summaries.get(s.questionId!) ?? null) : null,
      category: s.categoryId ? categoryInfo(s.categoryId) : null,
      includeSubcategories: !!s.includeSubcategories,
      available: null,
      needed: null,
    };
    if (s.kind === 'random') {
      info.available = pools.get(s.id)?.length ?? 0;
      info.needed = neededFrom(s, random, categories);
      if (info.needed > info.available) {
        problems.push(
          `“${info.category?.name}” has ${info.available} question${info.available === 1 ? '' : 's'} to pick from, but ${info.needed} random question${info.needed === 1 ? ' is' : 's are'} drawn from it.`,
        );
      }
    }
    return info;
  });
  return {
    slots: items,
    questionCount: slots.reduce((n, s) => n + s.questionCount, 0),
    totalPoints: round(slots.reduce((sum, s) => sum + s.points * s.questionCount, 0)),
    problems: [...new Set(problems)],
  };
}

/** Replaces a quiz's slots. Returns the quiz's new total marks. */
export async function saveSlots(db: DB, activity: ActivityRow, inputs: SlotInput[]): Promise<number> {
  const fixedIds = inputs.flatMap((s) => (s.kind === 'question' ? [s.questionId] : []));
  if (new Set(fixedIds).size !== fixedIds.length) throw badRequest('A question can only be added to a quiz once.');
  const total = inputs.reduce((n, s) => n + (s.kind === 'random' ? s.questionCount : 1), 0);
  if (total > MAX_QUIZ_QUESTIONS) throw badRequest(`A quiz can have up to ${MAX_QUIZ_QUESTIONS} questions.`);

  // Allowed: this course's questions and categories, those shared with it, and (after a share ends) those the
  // quiz already uses, so the quiz keeps working; they can't be added again once removed.
  const current = await loadSlots(db, activity.id);
  const keptQuestions = new Set(current.flatMap((s) => (s.kind === 'question' && s.questionId ? [s.questionId] : [])));
  let shared: Set<string> | null = null;
  const isShared = async (categoryId: string) => (shared ??= (await sharedCategoryRows(db, activity.courseId)).ids).has(categoryId);

  const questions = fixedIds.length
    ? await db.selectFrom('questions').select(['id', 'points', 'courseId', 'categoryId']).where('id', 'in', fixedIds).execute()
    : [];
  let allowed = questions.length === fixedIds.length;
  for (const q of questions) {
    if (allowed && q.courseId !== activity.courseId && !keptQuestions.has(q.id)) allowed = await isShared(q.categoryId);
  }
  if (!allowed) throw badRequest("One of the questions is not in this course's question bank.");
  const categoryIds = [...new Set(inputs.flatMap((s) => (s.kind === 'random' ? [s.categoryId] : [])))];
  const categories = categoryIds.length
    ? await db.selectFrom('questionCategories').select(['id', 'courseId']).where('id', 'in', categoryIds).execute()
    : [];
  if (categories.length !== categoryIds.length) throw badRequest("One of the categories is not in this course's question bank.");
  // A random slot on another course's category that is no longer shared may stay as it was, or pick fewer
  // questions, but never draw from more: each existing slot covers one slot of the same category and scope.
  const courseOf = new Map(categories.map((c) => [c.id, c.courseId]));
  const unmatched = current.filter((s) => s.kind === 'random');
  const keptFrom = new Map<SlotInput, QuizSlotRow>();
  for (const s of inputs) {
    if (s.kind !== 'random' || courseOf.get(s.categoryId) === activity.courseId || (await isShared(s.categoryId))) continue;
    const fits = (p: QuizSlotRow) =>
      p.categoryId === s.categoryId && !!p.includeSubcategories === s.includeSubcategories && s.questionCount <= p.questionCount;
    let i = unmatched.findIndex((p) => p.id === s.id && fits(p));
    if (i < 0) i = unmatched.findIndex(fits);
    if (i < 0) throw badRequest("One of the categories is not in this course's question bank.");
    keptFrom.set(s, unmatched.splice(i, 1)[0]!);
  }
  const keptPools = keptFrom.size
    ? await db
        .selectFrom('quizSlotPools')
        .selectAll()
        .where(
          'slotId',
          'in',
          [...keptFrom.values()].map((p) => p.id),
        )
        .execute()
    : [];
  const poolOf = new Map(keptPools.map((p) => [p.slotId, p.questionIds]));

  const defaults = new Map(questions.map((q) => [q.id, q.points]));
  const existing = new Set(current.map((s) => s.id));
  const used = new Set<string>();
  const rows: QuizSlotRow[] = inputs.map((s, position) => {
    const id = s.id && existing.has(s.id) && !used.has(s.id) ? s.id : newId();
    used.add(id);
    return s.kind === 'question'
      ? {
          id,
          activityId: activity.id,
          position,
          kind: 'question',
          questionId: s.questionId,
          categoryId: null,
          questionCount: 1,
          includeSubcategories: 0,
          points: s.points ?? defaults.get(s.questionId) ?? 1,
        }
      : {
          id,
          activityId: activity.id,
          position,
          kind: 'random',
          questionId: null,
          categoryId: s.categoryId,
          questionCount: s.questionCount,
          includeSubcategories: s.includeSubcategories ? 1 : 0,
          points: s.points ?? 1,
        };
  });
  const marks = round(rows.reduce((sum, s) => sum + s.points * s.questionCount, 0));
  const pools = inputs.flatMap((s, i) => {
    const questionIds = poolOf.get(keptFrom.get(s)?.id ?? '');
    return questionIds ? [{ slotId: rows[i]!.id, questionIds }] : [];
  });

  await transact(db, async (trx) => {
    await trx.deleteFrom('quizSlots').where('activityId', '=', activity.id).execute();
    for (let i = 0; i < rows.length; i += 100) {
      await trx
        .insertInto('quizSlots')
        .values(rows.slice(i, i + 100))
        .execute();
    }
    // Deleting the slots removed their kept pools; put them back.
    for (const pool of pools) await trx.insertInto('quizSlotPools').values(pool).execute();
    await trx
      .updateTable('activities')
      .set({ maxGrade: marks > 0 ? marks : 10 })
      .where('id', '=', activity.id)
      .execute();
  });
  return marks;
}

/** Chooses the questions for a new attempt, in slot order, with no question twice. */
export async function pickQuestions(db: DB, activity: ActivityRow, random: () => number = Math.random): Promise<QuestionSnapshot[]> {
  const slots = await loadSlots(db, activity.id);
  if (slots.length === 0) throw badRequest('This quiz has no questions yet.');
  const { pools, categories } = await randomPools(db, activity, slots);
  const picked = new Map<string, string[]>();
  const used = new Set(slots.filter((s) => s.kind === 'question').map((s) => s.questionId!));
  // Smallest pools first: they are the most constrained (see neededFrom).
  const random_ = slots.filter((s) => s.kind === 'random').sort((a, b) => (pools.get(a.id)?.length ?? 0) - (pools.get(b.id)?.length ?? 0));
  for (const slot of random_) {
    const pool = (pools.get(slot.id) ?? []).filter((id) => !used.has(id));
    if (pool.length < slot.questionCount) {
      const name = categories.find((c) => c.id === slot.categoryId)?.name ?? 'a category';
      throw badRequest(
        `This quiz can't start: it needs ${slot.questionCount} random question${slot.questionCount === 1 ? '' : 's'} from “${name}”, and only ${pool.length} ${pool.length === 1 ? 'is' : 'are'} left to pick from.`,
      );
    }
    const chosen = shuffle(pool, random).slice(0, slot.questionCount);
    for (const id of chosen) used.add(id);
    picked.set(slot.id, chosen);
  }

  const order = slots.flatMap((s) =>
    s.kind === 'question' ? [{ id: s.questionId!, points: s.points }] : (picked.get(s.id) ?? []).map((id) => ({ id, points: s.points })),
  );
  const rows = await db
    .selectFrom('questions')
    .selectAll()
    .where(
      'id',
      'in',
      order.map((o) => o.id),
    )
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return order.flatMap((o) => {
    const row = byId.get(o.id);
    return row ? [snapshotFromRow(row, { points: o.points, random })] : [];
  });
}
