/**
 * Rooms of a session. Without groups (or for a provider without group rooms) a session has one room for the whole
 * class. With groups each group gets its own room: in separate groups mode people see their own groups' rooms, in
 * visible groups mode everyone sees every group's room; either way students only join their own groups' rooms and
 * staff without access to all groups (teaching assistants) only start their own groups' rooms.
 */
import type { LiveProviderId } from '../../../shared/live.js';
import type { GroupMode } from '../../../shared/types.js';
import type { LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { newId, now } from '../../lib/util.js';
import type { ActivityAccess } from '../access.js';
import { activityGroupInfo, courseGroupRefs, effectiveGroupMode, restrictionOf, userGroupIds } from '../group-modes.js';
import type { LiveConfig } from './config.js';
import type { LiveProvider } from './providers.js';

export interface RoomTarget {
  groupId: string | null;
  groupName: string | null;
  /** The whole class, or one of the viewer's own groups. */
  mine: boolean;
  /** The viewer takes part in this room (their own group; any group with access to all groups). */
  joinable: boolean;
}

export interface RoomTargets {
  mode: GroupMode;
  /** Rooms per group. */
  grouped: boolean;
  targets: RoomTarget[];
  /** Why there is nothing to join, for the viewer. */
  note: string | null;
}

/** The rooms the viewer sees for every session of the live class, and which of them they may join. */
export async function roomTargets(db: DB, access: ActivityAccess, provider: LiveProvider | null, config: LiveConfig): Promise<RoomTargets> {
  const mode = effectiveGroupMode(access.course, access.activity);
  if (!provider || !provider.traits(config).groupRooms || mode === 'none') {
    return { mode, grouped: false, targets: [{ groupId: null, groupName: null, mine: true, joinable: true }], note: null };
  }
  const info = await activityGroupInfo(db, access);
  const joinable = new Set(info.postGroups.map((g) => g.id));
  const mine = await userGroupIds(db, access.course.id, access.user.id);
  // A class limited to some groups only has rooms for those groups.
  const restriction = new Set(await restrictionOf(db, access.activity.id));
  const targets = info.groups
    .filter((g) => restriction.size === 0 || restriction.has(g.id))
    .map((g) => ({ groupId: g.id, groupName: g.name, mine: mine.has(g.id), joinable: joinable.has(g.id) }));
  const anyJoinable = targets.some((t) => t.joinable);
  const staff = access.can('live:moderate');
  let note: string | null = null;
  if (targets.length === 0) {
    note = staff
      ? access.can('course:accessAllGroups')
        ? 'This class has a room for each group, but the course has no groups yet. Add groups on the Groups tab, or change the group mode.'
        : 'This class has a room for each group, and you’re not in any group, so there’s no room for you to start.'
      : 'This class has a room for each group, and you’re not in a group yet. Ask your teacher to add you to one.';
  } else if (!anyJoinable) {
    note = staff
      ? 'You can see every group’s room, but you’re not in any group, so you can’t start one.'
      : 'You can see every group’s room, but you’re not in a group yet, so you can’t join one. Ask your teacher to add you to a group.';
  }
  return { mode, grouped: true, targets, note };
}

/** The groups that get a room in a class with group rooms: the course's groups, or the ones the class is limited to. */
export async function roomGroups(db: DB, activityId: string, courseId: string): Promise<Array<{ id: string; name: string }>> {
  const [groups, restriction] = await Promise.all([courseGroupRefs(db, courseId), restrictionOf(db, activityId)]);
  if (restriction.length === 0) return groups;
  const allowed = new Set(restriction);
  return groups.filter((g) => allowed.has(g.id));
}

/** Random, unguessable room names (lowercase letters and digits, which every provider accepts). */
export function newRoomKey(): string {
  return `ck${newId(30)}`;
}

/**
 * The room of a session for a group (or the whole class), created on first use. A room left over from another
 * provider (the class changed how it meets) is detached so the background worker cleans it up at that provider.
 */
export async function ensureRoom(
  db: DB,
  session: Pick<LiveSessionRow, 'id' | 'activityId' | 'courseId'>,
  provider: LiveProviderId,
  groupId: string | null,
): Promise<LiveRoomRow> {
  const groupKey = groupId ?? '';
  const find = () =>
    db.selectFrom('liveRooms').selectAll().where('sessionId', '=', session.id).where('groupKey', '=', groupKey).executeTakeFirst();
  const existing = await find();
  if (existing && existing.provider === provider && existing.state === 'active') return existing;
  if (existing) {
    await db.updateTable('liveRooms').set({ sessionId: null, state: 'delete', updatedAt: now() }).where('id', '=', existing.id).execute();
  }
  const ts = now();
  await db
    .insertInto('liveRooms')
    .values({
      id: newId(),
      sessionId: session.id,
      activityId: session.activityId,
      courseId: session.courseId,
      groupKey,
      groupId,
      provider,
      roomKey: newRoomKey(),
      externalId: null,
      runId: null,
      joinUrl: null,
      host: null,
      syncedHash: null,
      state: 'active',
      syncError: null,
      syncAttempts: 0,
      nextSyncAt: null,
      claimId: null,
      claimedUntil: null,
      startedAt: null,
      endedAt: null,
      lastPolledAt: null,
      followUpCount: 0,
      nextFollowUpAt: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflict((oc) => oc.columns(['sessionId', 'groupKey']).doNothing())
    .execute();
  const row = await find();
  if (!row) throw new Error('Could not create the room.');
  return row;
}

/**
 * A provider meeting that was replaced (a Zoom meeting moved to another host): kept as a detached room in the
 * delete state, so the background worker deletes it at the provider, with retries.
 */
export async function retireMeeting(
  db: DB,
  room: Pick<LiveRoomRow, 'activityId' | 'courseId' | 'groupKey' | 'groupId' | 'provider'>,
  externalId: string,
  host: string | null,
): Promise<void> {
  const ts = now();
  await db
    .insertInto('liveRooms')
    .values({
      id: newId(),
      sessionId: null,
      activityId: room.activityId,
      courseId: room.courseId,
      groupKey: room.groupKey,
      groupId: room.groupId,
      provider: room.provider,
      roomKey: newRoomKey(),
      externalId,
      runId: null,
      joinUrl: null,
      host,
      syncedHash: null,
      state: 'delete',
      syncError: null,
      syncAttempts: 0,
      nextSyncAt: null,
      claimId: null,
      claimedUntil: null,
      startedAt: null,
      endedAt: null,
      lastPolledAt: null,
      followUpCount: 0,
      nextFollowUpAt: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .execute();
}

/** Marks a session's rooms for deletion at the provider (a cancelled session). */
export async function retireRooms(db: DB, sessionIds: string[]): Promise<void> {
  for (let i = 0; i < sessionIds.length; i += 400) {
    await db
      .updateTable('liveRooms')
      .set({ state: 'delete', updatedAt: now() })
      .where('sessionId', 'in', sessionIds.slice(i, i + 400))
      .execute();
  }
}
