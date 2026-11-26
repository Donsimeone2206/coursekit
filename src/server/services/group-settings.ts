/** Saving an activity's group mode and group restriction (0.3.0). */
import { z } from 'zod';
import type { GroupMode } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { ActivityRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { restrictionOf, saveRestriction } from './group-modes.js';

/** Optional fields for the create and update activity bodies. Leaving one out keeps the activity's setting. */
export const activityGroupsSchema = {
  /** The activity's own group mode; null follows the course. */
  groupMode: z.enum(['none', 'separate', 'visible']).nullable().optional(),
  /** Limit the activity to the members of these groups; an empty list opens it to everyone. */
  groupIds: z.array(z.string().max(40)).max(200).optional(),
};

export interface ActivityGroupsInput {
  groupMode?: GroupMode | null | undefined;
  groupIds?: string[] | undefined;
}

/**
 * Saves the group mode and restriction that are given, and says whether something changed. Outside a transaction it
 * emits `activity.groups.updated` when something did (course completion is checked again, since a restriction changes
 * what students must do); in one, the caller emits it after the commit.
 */
export async function saveActivityGroups(
  deps: Pick<AppDeps, 'events'>,
  db: DB,
  activity: Pick<ActivityRow, 'id' | 'courseId' | 'groupMode'>,
  input: ActivityGroupsInput,
  userId: string,
): Promise<boolean> {
  let changed = false;
  if (input.groupMode !== undefined && input.groupMode !== activity.groupMode) {
    await db.updateTable('activities').set({ groupMode: input.groupMode }).where('id', '=', activity.id).execute();
    changed = true;
  }
  if (input.groupIds !== undefined) {
    const before = new Set(await restrictionOf(db, activity.id));
    await saveRestriction(db, activity, input.groupIds);
    const after = new Set(input.groupIds);
    if (before.size !== after.size || [...after].some((id) => !before.has(id))) changed = true;
  }
  if (changed && !db.isTransaction) {
    deps.events.emit('activity.groups.updated', { activityId: activity.id, courseId: activity.courseId, userId });
  }
  return changed;
}
