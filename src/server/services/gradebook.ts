/**
 * Builds the gradebook (staff) and "my grades" (student) payloads from the course-total maths.
 */
import type { GradeCategoryResult, Gradebook, GradebookItem, GradebookRow, MyGrades } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import { round } from '../lib/util.js';
import { computeCourseGrade, loadGradeSetup, type CategoryTotal, type GradeItemInfo, type GradeSetup } from './course-total.js';
import { loadAvailability, unavailableActivityIds, type CellState } from './group-modes.js';

export interface GradebookStudent {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

/** Items grouped by category (in category order), course order within each category. */
export function itemsInCategoryOrder(setup: GradeSetup): GradeItemInfo[] {
  const rank = new Map(setup.categories.map((c, i) => [c.id, i]));
  return setup.items
    .map((item, index) => ({ item, index, rank: rank.get(item.categoryId) ?? setup.categories.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

function toItem(item: GradeItemInfo): GradebookItem {
  return {
    activityId: item.activityId,
    title: item.title,
    type: item.type,
    maxGrade: item.maxGrade,
    dueAt: item.dueAt,
    categoryId: item.categoryId,
    weight: item.weight,
  };
}

const pct = (value: number | null) => (value == null ? null : round(value, 2));

function toCategoryResult(t: CategoryTotal | undefined): GradeCategoryResult {
  return {
    percentage: pct(t?.percentage ?? null),
    earned: round(t?.earned ?? 0),
    possible: round(t?.possible ?? 0),
    share: pct(t?.share ?? null),
  };
}

const average = (values: number[]) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * The staff gradebook: every item (hidden ones too) for the given students. A cell is "not applicable" when the
 * activity is limited to groups the student isn't in: it shows no grade and doesn't count towards their totals or
 * the averages. `cell` can also hide cells from the viewer (separate groups); the row's totals are hidden with them.
 */
export async function buildCourseGradebook(
  db: DB,
  courseId: string,
  students: GradebookStudent[],
  options: { cell?: (activityId: string, userId: string) => CellState } = {},
): Promise<Gradebook> {
  const setup = await loadGradeSetup(db, courseId, { includeHidden: true });
  const items = itemsInCategoryOrder(setup);
  const grades = await db.selectFrom('grades').selectAll().where('courseId', '=', courseId).execute();
  const byKey = new Map(grades.map((g) => [`${g.activityId}:${g.userId}`, g]));
  const availability = options.cell ? null : await loadAvailability(db, courseId);
  const stateOf =
    options.cell ??
    ((activityId: string, userId: string): CellState => (availability!.isAvailable(activityId, userId) ? 'ok' : 'notApplicable'));

  const rows: GradebookRow[] = students.map((s) => {
    const states = new Map(setup.items.map((item) => [item.activityId, stateOf(item.activityId, s.id)]));
    // Activities that don't apply to the student count as if they weren't there.
    const scores = new Map(
      setup.items.map((item) => [
        item.activityId,
        states.get(item.activityId) === 'notApplicable' ? null : (byKey.get(`${item.activityId}:${s.id}`)?.score ?? null),
      ]),
    );
    const grade = computeCourseGrade(setup, scores);
    const totalsHidden = [...states.values()].includes('hidden');
    const cells: GradebookRow['cells'] = {};
    for (const item of items) {
      const state = states.get(item.activityId) ?? 'ok';
      const g = byKey.get(`${item.activityId}:${s.id}`);
      cells[item.activityId] =
        state === 'ok'
          ? { score: g?.score ?? null, feedback: g?.feedback ?? null, dropped: grade.dropped.has(item.activityId) }
          : { score: null, feedback: null, dropped: false, ...(state === 'notApplicable' ? { notApplicable: true } : { hidden: true }) };
    }
    const categories: GradebookRow['categories'] = {};
    for (const c of setup.categories) categories[c.id] = toCategoryResult(totalsHidden ? undefined : grade.categories.get(c.id));
    return {
      user: { id: s.id, name: s.name, email: s.email, avatarUrl: s.avatarUrl },
      cells,
      total: totalsHidden ? 0 : round(grade.earned),
      max: totalsHidden ? 0 : round(grade.possible),
      percentage: totalsHidden ? null : pct(grade.percentage),
      categories,
      ...(totalsHidden ? { totalsHidden: true } : {}),
    };
  });

  const averages: Gradebook['averages'] = {};
  for (const item of items) {
    averages[item.activityId] = average(rows.map((r) => r.cells[item.activityId]?.score).filter((s): s is number => s != null));
  }
  const categoryAverages: Gradebook['categoryAverages'] = {};
  for (const c of setup.categories) {
    categoryAverages[c.id] = average(rows.map((r) => r.categories[c.id]?.percentage).filter((p): p is number => p != null));
  }
  return {
    items: items.map(toItem),
    rows,
    averages,
    courseAverage: average(rows.map((r) => r.percentage).filter((p): p is number => p != null)),
    aggregation: setup.aggregation,
    categories: setup.categories,
    categoryAverages,
  };
}

/**
 * A student's own grades. Hidden activities, and activities limited to groups the student isn't in, are left out,
 * so they don't count towards the total either.
 */
export async function buildStudentGrades(db: DB, courseId: string, userId: string): Promise<MyGrades> {
  const loaded = await loadGradeSetup(db, courseId, { includeHidden: false });
  const unavailable = await unavailableActivityIds(db, userId, [courseId]);
  const setup = { ...loaded, items: loaded.items.filter((item) => !unavailable.has(item.activityId)) };
  const grades = await db.selectFrom('grades').selectAll().where('courseId', '=', courseId).where('userId', '=', userId).execute();
  const byActivity = new Map(grades.map((g) => [g.activityId, g]));
  const grade = computeCourseGrade(
    setup,
    new Map(setup.items.map((item) => [item.activityId, byActivity.get(item.activityId)?.score ?? null])),
  );
  return {
    items: itemsInCategoryOrder(setup).map((item) => {
      const g = byActivity.get(item.activityId);
      return {
        ...toItem(item),
        score: g?.score ?? null,
        feedback: g?.feedback ?? null,
        gradedAt: g?.gradedAt ?? null,
        dropped: grade.dropped.has(item.activityId),
      };
    }),
    total: round(grade.earned),
    max: round(grade.possible),
    percentage: pct(grade.percentage),
    aggregation: setup.aggregation,
    categories: setup.categories.map((c) => ({ ...c, ...toCategoryResult(grade.categories.get(c.id)) })),
  };
}
