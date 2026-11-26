/**
 * Course totals: the one place that decides how grades add up. The gradebook, the CSV export,
 * the student's grades page and other features (such as course completion) all use it.
 *
 * Definitions, for one student:
 *
 * - An item is a graded activity (max grade m) in exactly one category. Unassigned items sit in the
 *   course's default category. Only graded items count: an item with no score is left out entirely,
 *   neither zero nor part of the points possible.
 * - Each counted item has a weight within its category, e: its points (e = m) unless the teacher set
 *   an item weight w (e = w). Item weights are only used by weighted aggregation; natural aggregation
 *   always counts points. So weights 1 and 3 make two items worth 25% and 75% of their category,
 *   whatever their points. An item with weight 0, or with a weight and a max grade of 0, doesn't count.
 * - Drop the lowest N (per category, in both aggregations): among the category's graded items with
 *   e > 0 and m > 0, the N with the lowest percentage (score / m) are left out. Ties drop the item
 *   with the larger e first (that helps the student most), then the one earlier in the course. At
 *   least one graded item always counts, so N is capped at (graded items - 1). Ungraded items are
 *   never dropped.
 * - Category subtotal = Σ (score / m × e) / Σ e × 100 over its counted items, which is
 *   Σ score / Σ m × 100 when the items count by points. Null when Σ e is 0 (nothing graded yet, or
 *   an empty category).
 *
 * Course total:
 *
 * - natural (default, 0.1.x behaviour): Σ score / Σ m × 100 over every counted item in the course,
 *   summed in course order. Without drop rules this is exactly what 0.1.x computed, to the last bit
 *   (an item with a max grade of 0 adds its score and no points possible, as before). Category and
 *   item weights are not used.
 * - weighted: Σ (weight_c × subtotal_c) / Σ weight_c over the categories that have a subtotal and a
 *   weight above 0. Categories without grades yet are skipped and the remaining weights are scaled up
 *   to 100% (normalised), which also covers weights that don't add up to 100: 20/20 behaves like
 *   50/50. A category with weight 0 never counts. When no category counts, the total is null.
 *
 * `earned` and `possible` are always plain points (Σ score, Σ m) of the counted items. They make up
 * the natural total; in weighted courses they are for information only. A category's `share` is the
 * part of the course total it carries right now: its normalised weight (weighted) or its share of
 * the points possible (natural).
 *
 * Totals are kept unrounded here; callers round for display (2 decimals). Scores above the max grade
 * (possible after lowering an assignment's max grade) are not capped, as in 0.1.x.
 */
import type { ActivityType, GradeAggregation, GradeCategory } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import { round, toBool } from '../lib/util.js';
import { loadAvailability } from './group-modes.js';

export const DEFAULT_CATEGORY_NAME = 'Uncategorised';

export interface GradeItemInfo {
  activityId: string;
  title: string;
  type: ActivityType;
  maxGrade: number;
  dueAt: string | null;
  /** The activity and its section are both visible to students. */
  visible: boolean;
  sectionTitle: string;
  /** Always one of the setup's categories (the default category's id is the course id). */
  categoryId: string;
  /** Weight within the category; null = by points (the max grade). */
  weight: number | null;
}

export interface GradeSetup {
  courseId: string;
  aggregation: GradeAggregation;
  /** In display order; always includes the default category. */
  categories: GradeCategory[];
  /** Graded activities in course order. */
  items: GradeItemInfo[];
}

export interface CategoryTotal {
  /** Unrounded subtotal (0-100), or null when nothing counts yet. */
  percentage: number | null;
  /** Points of the counted items (after drop-lowest). */
  earned: number;
  possible: number;
  share: number | null;
}

export interface CourseGrade {
  /** Unrounded course total (0-100), or null when nothing counts yet. */
  percentage: number | null;
  /** Points of the counted items (after drop-lowest); the natural total is earned / possible. */
  earned: number;
  possible: number;
  /** Subtotals keyed by category id (every category of the setup). */
  categories: Map<string, CategoryTotal>;
  /** Activity ids left out by drop-lowest. */
  dropped: Set<string>;
}

/** Scores by activity id. Missing and null both mean "not graded". */
export type Scores = ReadonlyMap<string, number | null | undefined>;

/** Loads a course's categories, aggregation and graded activities. Hidden activities are only included on request (staff). */
export async function loadGradeSetup(db: DB, courseId: string, options: { includeHidden?: boolean } = {}): Promise<GradeSetup> {
  const settings = await db.selectFrom('gradeSettings').select('aggregation').where('courseId', '=', courseId).executeTakeFirst();
  const rows = await db
    .selectFrom('gradeCategories')
    .selectAll()
    .where('courseId', '=', courseId)
    .orderBy('position', 'asc')
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const categories: GradeCategory[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    weight: Number(r.weight),
    dropLowest: Number(r.dropLowest),
    position: Number(r.position),
    isDefault: r.id === courseId,
  }));
  if (!categories.some((c) => c.isDefault)) {
    const last = categories.reduce((max, c) => Math.max(max, c.position), -1);
    categories.push({ id: courseId, name: DEFAULT_CATEGORY_NAME, weight: 0, dropLowest: 0, position: last + 1, isDefault: true });
  }
  const known = new Set(categories.map((c) => c.id));

  const itemRows = await db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .leftJoin('gradeItems', 'gradeItems.activityId', 'activities.id')
    .select([
      'activities.id',
      'activities.title',
      'activities.type',
      'activities.maxGrade',
      'activities.dueAt',
      'activities.visible',
      'sections.visible as sectionVisible',
      'sections.title as sectionTitle',
      'gradeItems.categoryId',
      'gradeItems.weight',
    ])
    .where('activities.courseId', '=', courseId)
    .where('activities.maxGrade', 'is not', null)
    .orderBy('sections.position', 'asc')
    .orderBy('sections.id', 'asc')
    .orderBy('activities.position', 'asc')
    .orderBy('activities.id', 'asc')
    .execute();

  const items: GradeItemInfo[] = [];
  for (const r of itemRows) {
    const visible = toBool(r.visible) && toBool(r.sectionVisible);
    if (!visible && !options.includeHidden) continue;
    items.push({
      activityId: r.id,
      title: r.title,
      type: r.type,
      maxGrade: r.maxGrade ?? 0,
      dueAt: r.dueAt,
      visible,
      sectionTitle: r.sectionTitle,
      categoryId: r.categoryId && known.has(r.categoryId) ? r.categoryId : courseId,
      weight: r.weight == null ? null : Number(r.weight),
    });
  }
  return { courseId, aggregation: settings?.aggregation === 'weighted' ? 'weighted' : 'natural', categories, items };
}

/** An item's weight within its category: its points, or its item weight (weighted aggregation only). Null = doesn't count. */
function weightOf(item: GradeItemInfo, weighted: boolean): number | null {
  if (!weighted || item.weight == null) return item.maxGrade;
  return item.maxGrade > 0 && item.weight > 0 ? item.weight : null;
}

/** Computes one student's subtotals and course total. Pure: see the definitions at the top of this file. */
export function computeCourseGrade(setup: GradeSetup, scores: Scores): CourseGrade {
  const weighted = setup.aggregation === 'weighted';
  /** The score and category weight of an item that counts, or null (ungraded, or weighted out). */
  const counted = (item: GradeItemInfo) => {
    const score = scores.get(item.activityId);
    if (score == null) return null;
    const weight = weightOf(item, weighted);
    return weight == null ? null : { score, weight };
  };
  const order = new Map(setup.items.map((item, index) => [item.activityId, index]));
  const byCategory = new Map<string, GradeItemInfo[]>(setup.categories.map((c) => [c.id, []]));
  for (const item of setup.items) {
    const list = byCategory.get(item.categoryId);
    if (list) list.push(item);
    else byCategory.set(item.categoryId, [item]);
  }

  // Drop-lowest, per category.
  const dropped = new Set<string>();
  for (const category of setup.categories) {
    const rule = Math.floor(category.dropLowest);
    if (!(rule > 0)) continue;
    const candidates: Array<{ item: GradeItemInfo; percent: number; weight: number }> = [];
    for (const item of byCategory.get(category.id) ?? []) {
      const c = counted(item);
      if (!c || !(c.weight > 0) || !(item.maxGrade > 0)) continue;
      candidates.push({ item, percent: c.score / item.maxGrade, weight: c.weight });
    }
    const n = Math.min(rule, candidates.length - 1);
    if (n <= 0) continue;
    candidates.sort(
      (a, b) => a.percent - b.percent || b.weight - a.weight || order.get(a.item.activityId)! - order.get(b.item.activityId)!,
    );
    for (const c of candidates.slice(0, n)) dropped.add(c.item.activityId);
  }

  const categories = new Map<string, CategoryTotal>();
  for (const [id, items] of byCategory) {
    let earned = 0;
    let possible = 0;
    let part = 0;
    let weights = 0;
    for (const item of items) {
      const c = counted(item);
      if (!c || dropped.has(item.activityId)) continue;
      earned += c.score;
      possible += item.maxGrade;
      // Items that count by points add their score and max grade as they are, so points-based
      // subtotals are exactly Σ score / Σ max grade.
      part += !weighted || item.weight == null ? c.score : (c.score / item.maxGrade) * c.weight;
      weights += c.weight;
    }
    categories.set(id, { percentage: weights > 0 ? (part / weights) * 100 : null, earned, possible, share: null });
  }

  // Course points, summed in course order so natural totals match 0.1.x to the last bit.
  const course = { earned: 0, possible: 0 };
  for (const item of setup.items) {
    const c = counted(item);
    if (!c || dropped.has(item.activityId)) continue;
    course.earned += c.score;
    course.possible += item.maxGrade;
  }

  let percentage: number | null;
  if (weighted) {
    let sum = 0;
    let weights = 0;
    const counted: CategoryTotal[] = [];
    for (const category of setup.categories) {
      const t = categories.get(category.id);
      if (!t || t.percentage == null || !(category.weight > 0)) continue;
      sum += category.weight * t.percentage;
      weights += category.weight;
      counted.push(t);
    }
    percentage = weights > 0 ? sum / weights : null;
    for (const category of setup.categories) {
      const t = categories.get(category.id)!;
      if (counted.includes(t)) t.share = (category.weight / weights) * 100;
    }
  } else {
    percentage = course.possible > 0 ? (course.earned / course.possible) * 100 : null;
    if (course.possible > 0) for (const t of categories.values()) if (t.possible > 0) t.share = (t.possible / course.possible) * 100;
  }

  return { percentage, earned: course.earned, possible: course.possible, categories, dropped };
}

/** Scores by user, then by activity, for some (or all) users of a course. */
export async function loadScores(db: DB, courseId: string, userIds?: readonly string[]): Promise<Map<string, Map<string, number>>> {
  const wanted = userIds ? new Set(userIds) : null;
  const result = new Map<string, Map<string, number>>();
  if (wanted?.size === 0) return result;
  let query = db
    .selectFrom('grades')
    .select(['activityId', 'userId', 'score'])
    .where('courseId', '=', courseId)
    .where('score', 'is not', null);
  // Long id lists would hit bound-parameter limits; filter those in memory instead.
  if (wanted && wanted.size <= 500) query = query.where('userId', 'in', [...wanted]);
  for (const g of await query.execute()) {
    if (g.score == null || (wanted && !wanted.has(g.userId))) continue;
    let scores = result.get(g.userId);
    if (!scores) result.set(g.userId, (scores = new Map()));
    scores.set(g.activityId, Number(g.score));
  }
  return result;
}

/**
 * Full breakdown (subtotals, dropped items) for each user, as staff see it: hidden activities count.
 * Pass `includeHidden: false` for the totals a student sees on their own grades page. Activities limited to
 * groups a user isn't in never count for them (as if ungraded).
 */
export async function courseGrades(
  db: DB,
  courseId: string,
  userIds: readonly string[],
  options: { includeHidden?: boolean } = {},
): Promise<Map<string, CourseGrade>> {
  const result = new Map<string, CourseGrade>();
  if (userIds.length === 0) return result;
  const setup = await loadGradeSetup(db, courseId, { includeHidden: options.includeHidden ?? true });
  const scores = await loadScores(db, courseId, userIds);
  const availability = await loadAvailability(db, courseId, userIds);
  const none = new Map<string, number>();
  for (const userId of userIds) {
    if (result.has(userId)) continue;
    let own: Scores = scores.get(userId) ?? none;
    if (availability.restricted.size) {
      own = new Map([...own].filter(([activityId]) => availability.isAvailable(activityId, userId)));
    }
    result.set(userId, computeCourseGrade(setup, own));
  }
  return result;
}

/**
 * Each user's course total as a percentage (0-100, rounded to 2 decimals), or null when nothing is
 * graded yet. This is the total in the gradebook and the CSV export (hidden activities included).
 */
export async function courseTotals(db: DB, courseId: string, userIds: string[]): Promise<Map<string, number | null>> {
  const totals = new Map<string, number | null>();
  for (const [userId, grade] of await courseGrades(db, courseId, userIds)) {
    totals.set(userId, grade.percentage == null ? null : round(grade.percentage, 2));
  }
  return totals;
}
