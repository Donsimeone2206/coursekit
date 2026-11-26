import type { AppDeps } from '../context.js';
import type { DB } from '../db/types.js';
import type { ActivityRow } from '../db/schema.js';
import { now, num } from '../lib/util.js';
import { loadAvailability, unavailableActivityIds } from './group-modes.js';

/**
 * Activities that count towards progress: visible, in a visible section, with completion tracking on. Activities
 * limited to groups a student isn't in don't count for them (see services/group-modes.ts).
 */
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
  const totalMap = new Map(totals.map((r) => [r.courseId, num(r.total)]));
  // Activities limited to groups the user isn't in don't count.
  const unavailable = await unavailableActivityIds(db, userId, courseIds);
  if (unavailable.size) {
    const rows = await trackedActivities(db)
      .leftJoin('completions', (join) => join.onRef('completions.activityId', '=', 'activities.id').on('completions.userId', '=', userId))
      .where('activities.id', 'in', [...unavailable])
      .select(['activities.courseId', 'completions.userId as doneBy'])
      .execute();
    for (const row of rows) {
      totalMap.set(row.courseId, (totalMap.get(row.courseId) ?? 0) - 1);
      if (row.doneBy) doneMap.set(row.courseId, (doneMap.get(row.courseId) ?? 0) - 1);
    }
  }
  for (const id of courseIds) {
    const total = totalMap.get(id) ?? 0;
    result.set(id, total > 0 ? Math.round(((doneMap.get(id) ?? 0) / total) * 100) : 0);
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

  // Activities limited to groups a user isn't in don't count for them.
  const availability = await loadAvailability(db, courseId, userIds);
  const restricted = availability.restricted.size
    ? (
        await trackedActivities(db)
          .where('activities.courseId', '=', courseId)
          .where('activities.id', 'in', [...availability.restricted.keys()])
          .select('activities.id')
          .execute()
      ).map((r) => r.id)
    : [];
  const restrictedDone = restricted.length
    ? await db
        .selectFrom('completions')
        .select(['userId', 'activityId'])
        .where('activityId', 'in', restricted)
        .$if(userIds.length <= 500, (q) => q.where('userId', 'in', userIds))
        .execute()
    : [];
  const completedRestricted = new Set(restrictedDone.map((r) => `${r.activityId}:${r.userId}`));

  for (const id of userIds) {
    let own = total;
    let ownDone = doneMap.get(id) ?? 0;
    for (const activityId of restricted) {
      if (availability.isAvailable(activityId, id)) continue;
      own--;
      if (completedRestricted.has(`${activityId}:${id}`)) ownDone--;
    }
    result.set(id, own > 0 ? Math.round((ownDone / own) * 100) : 0);
  }
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
