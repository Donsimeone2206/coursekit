import type { AppDeps } from '../context.js';
import type { DB } from '../db/index.js';
import type { ActivityRow } from '../db/schema.js';
import { now, num } from '../lib/util.js';

/** Activities that count towards progress: visible, in a visible section, with completion tracking on. */
function trackedActivities(db: DB) {
  return db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .where('activities.visible', '=', 1)
    .where('sections.visible', '=', 1)
    .where('activities.completion', '!=', 'none');
}

/** Progress (0-100) of one user in several courses. */
export async function progressByCourse(db: DB, userId: string, courseIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (courseIds.length === 0) return result;

  const totals = await trackedActivities(db)
    .where('activities.courseId', 'in', courseIds)
    .select(['activities.courseId', (eb) => eb.fn.countAll().as('total')])
    .groupBy('activities.courseId')
    .execute();

  const done = await trackedActivities(db)
    .innerJoin('completions', 'completions.activityId', 'activities.id')
    .where('completions.userId', '=', userId)
    .where('activities.courseId', 'in', courseIds)
    .select(['activities.courseId', (eb) => eb.fn.countAll().as('done')])
    .groupBy('activities.courseId')
    .execute();

  const doneMap = new Map(done.map((r) => [r.courseId, num(r.done)]));
  for (const id of courseIds) result.set(id, 0);
  for (const row of totals) {
    const total = num(row.total);
    result.set(row.courseId, total ? Math.round(((doneMap.get(row.courseId) ?? 0) / total) * 100) : 0);
  }
  return result;
}

/** Progress (0-100) of several users in one course. */
export async function progressByUser(db: DB, courseId: string, userIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;

  const totalRow = await trackedActivities(db)
    .where('activities.courseId', '=', courseId)
    .select((eb) => eb.fn.countAll().as('total'))
    .executeTakeFirst();
  const total = num(totalRow?.total);

  const done = await trackedActivities(db)
    .innerJoin('completions', 'completions.activityId', 'activities.id')
    .where('activities.courseId', '=', courseId)
    .where('completions.userId', 'in', userIds)
    .select(['completions.userId', (eb) => eb.fn.countAll().as('done')])
    .groupBy('completions.userId')
    .execute();
  const doneMap = new Map(done.map((r) => [r.userId, num(r.done)]));

  for (const id of userIds) result.set(id, total ? Math.round(((doneMap.get(id) ?? 0) / total) * 100) : 0);
  return result;
}

export async function markCompleted(deps: Pick<AppDeps, 'db' | 'events'>, activity: ActivityRow, userId: string) {
  if (activity.completion === 'none') return;
  const result = await deps.db
    .insertInto('completions')
    .values({ activityId: activity.id, userId, courseId: activity.courseId, completedAt: now() })
    .onConflict((oc) => oc.columns(['activityId', 'userId']).doNothing())
    .executeTakeFirst();
  if (num(result.numInsertedOrUpdatedRows) > 0) {
    deps.events.emit('activity.completed', { activityId: activity.id, courseId: activity.courseId, userId });
  }
}

export async function unmarkCompleted(db: DB, activityId: string, userId: string) {
  await db.deleteFrom('completions').where('activityId', '=', activityId).where('userId', '=', userId).execute();
}
