/**
 * Group modes and group restrictions (0.3.0). Every list and endpoint goes through these helpers, keyed on the
 * activity rather than its type, so new activity types get the same rules without code of their own.
 *
 * Group mode (a course default that each activity can override):
 * - none: groups only organise and filter.
 * - separate: students only see their own groups' discussions. Staff without `course:accessAllGroups` (teaching
 *   assistants) only see the students of the groups they belong to: submissions, grading, quiz attempts and reports,
 *   and the activity's column in the gradebook. Staff with it pick a group or "All participants".
 * - visible: everyone can see every group's discussions and work lists, but students only take part in their own
 *   groups' discussions.
 *
 * Group restriction: an activity limited to the members of chosen groups. It only applies to people who can't see
 * hidden activities (students, and visitors looking at a course outline); staff see it with a "Groups: ..." badge.
 * For a student outside the groups the activity doesn't exist: it isn't listed anywhere, can't be opened or
 * submitted, and doesn't count towards their grades, progress or completion. A restriction to a group that was
 * deleted stays in place (open to nobody) until a teacher changes it, as in Moodle.
 */
import { sql, type SelectQueryBuilder } from 'kysely';
import { DELETED_GROUP_NAME } from '../../shared/group-modes.js';
import { getCourseCapabilities } from '../../shared/permissions.js';
import type { ActivityGroupInfo, CourseRole, GroupChoice, GroupMode, GroupRef, SiteRole } from '../../shared/types.js';
import type { ActivityRow, CourseRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { badRequest, notFound } from '../lib/http.js';
import { now } from '../lib/util.js';
import type { ActivityAccess, CourseAccess } from './access.js';
import { byName, canSeeAllGroups } from './groups.js';

/** Long id lists would hit bound-parameter limits; above this, filter in memory instead. */
const MAX_IN = 500;

export function toGroupMode(value: unknown): GroupMode {
  return value === 'separate' || value === 'visible' ? value : 'none';
}

/** The group mode in effect for an activity: its own, or the course's default. Without an activity, the course's. */
export function effectiveGroupMode(course: Pick<CourseRow, 'groupMode'>, activity?: Pick<ActivityRow, 'groupMode'> | null): GroupMode {
  return toGroupMode(activity?.groupMode ?? course.groupMode);
}

/** Whether the viewer sees every group's work and discussions, whatever the group mode. */
export function accessesAllGroups(access: CourseAccess): boolean {
  return access.can('course:accessAllGroups');
}

/** Group restrictions apply to everyone who can't see hidden activities. Staff see restricted activities with a badge. */
export function restrictionsApplyTo(access: CourseAccess): boolean {
  return !access.can('course:viewHidden');
}

/** The course's groups, in name order. */
export async function courseGroupRefs(db: DB, courseId: string): Promise<GroupRef[]> {
  const rows = await db.selectFrom('courseGroups').select(['id', 'name']).where('courseId', '=', courseId).execute();
  return rows.sort(byName);
}

/** Ids of the groups a user belongs to in a course. */
export async function userGroupIds(db: DB, courseId: string, userId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom('courseGroupMembers')
    .select('groupId')
    .where('courseId', '=', courseId)
    .where('userId', '=', userId)
    .execute();
  return new Set(rows.map((r) => r.groupId));
}

/** Group ids by user, in the given courses (optionally only some users). */
async function membershipsIn(db: DB, courseIds: string[], userIds?: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (courseIds.length === 0 || userIds?.length === 0) return result;
  const wanted = userIds ? new Set(userIds) : null;
  const rows = await db
    .selectFrom('courseGroupMembers')
    .select(['userId', 'groupId'])
    .where('courseId', 'in', courseIds)
    .$if(!!wanted && wanted.size <= MAX_IN, (q) => q.where('userId', 'in', [...wanted!]))
    .execute();
  for (const row of rows) {
    if (wanted && !wanted.has(row.userId)) continue;
    let set = result.get(row.userId);
    if (!set) result.set(row.userId, (set = new Set()));
    set.add(row.groupId);
  }
  return result;
}

/** The groups each restricted activity in these courses is limited to. Unrestricted activities are not in the map. */
export async function restrictionsIn(db: DB, courseIds: string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (courseIds.length === 0) return result;
  const rows = await db.selectFrom('activityGroups').select(['activityId', 'groupId']).where('courseId', 'in', courseIds).execute();
  for (const row of rows) {
    let set = result.get(row.activityId);
    if (!set) result.set(row.activityId, (set = new Set()));
    set.add(row.groupId);
  }
  return result;
}

/** The groups one activity is limited to (empty: everyone). */
export async function restrictionOf(db: DB, activityId: string): Promise<string[]> {
  const rows = await db.selectFrom('activityGroups').select('groupId').where('activityId', '=', activityId).execute();
  return rows.map((r) => r.groupId);
}

const overlaps = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string>) => !!a && [...b].some((id) => a.has(id));

/** Who can open which activity of a course. */
export interface Availability {
  /** Activity id → the groups it is limited to. Unrestricted activities are not in the map. */
  restricted: ReadonlyMap<string, ReadonlySet<string>>;
  /** The activity is not restricted, or the user is in one of its groups. */
  isAvailable(activityId: string, userId: string): boolean;
}

/** Loads a course's restrictions and the memberships needed to check them (for some users, or everyone). */
export async function loadAvailability(db: DB, courseId: string, userIds?: readonly string[]): Promise<Availability> {
  const restricted = await restrictionsIn(db, [courseId]);
  if (restricted.size === 0) return { restricted, isAvailable: () => true };
  const groups = await membershipsIn(db, [courseId], userIds);
  return {
    restricted,
    isAvailable: (activityId, userId) => {
      const allowed = restricted.get(activityId);
      return !allowed || overlaps(groups.get(userId), allowed);
    },
  };
}

/** Whether an activity is open to a user: it isn't restricted, or the user is in one of its groups. */
export async function isAvailableTo(db: DB, activityId: string, userId: string): Promise<boolean> {
  const groups = await restrictionOf(db, activityId);
  if (groups.length === 0) return true;
  const member = await db
    .selectFrom('courseGroupMembers')
    .select('userId')
    .where('groupId', 'in', groups)
    .where('userId', '=', userId)
    .executeTakeFirst();
  return !!member;
}

/** Activities in these courses that are limited to groups the user isn't in. For lists that span courses. */
export async function unavailableActivityIds(db: DB, userId: string, courseIds: string[]): Promise<Set<string>> {
  const hidden = new Set<string>();
  const restricted = await restrictionsIn(db, courseIds);
  if (restricted.size === 0) return hidden;
  const mine = (await membershipsIn(db, courseIds, [userId])).get(userId);
  for (const [activityId, groups] of restricted) if (!overlaps(mine, groups)) hidden.add(activityId);
  return hidden;
}

/** The course's activities that group restrictions hide from the viewer. Always empty for staff. */
export async function groupHiddenActivityIds(db: DB, access: CourseAccess): Promise<Set<string>> {
  if (!restrictionsApplyTo(access)) return new Set();
  return unavailableActivityIds(db, access.user.id, [access.course.id]);
}

/** Restrictions with group names, for staff badges. Groups that were deleted are named "Deleted group". */
export async function restrictionRefs(db: DB, courseId: string): Promise<Map<string, GroupRef[]>> {
  const restricted = await restrictionsIn(db, [courseId]);
  const result = new Map<string, GroupRef[]>();
  if (restricted.size === 0) return result;
  const names = new Map((await courseGroupRefs(db, courseId)).map((g) => [g.id, g.name]));
  for (const [activityId, ids] of restricted) {
    result.set(activityId, [...ids].map((id) => ({ id, name: names.get(id) ?? DELETED_GROUP_NAME })).sort(byName));
  }
  return result;
}

/**
 * Replaces the groups an activity is limited to (an empty list opens it to everyone). New groups must be in the
 * activity's course; groups it is already limited to may stay even if they were deleted since.
 */
export async function saveRestriction(db: DB, activity: Pick<ActivityRow, 'id' | 'courseId'>, groupIds: string[]): Promise<void> {
  const ids = [...new Set(groupIds)];
  const current = new Set(await restrictionOf(db, activity.id));
  const added = ids.filter((id) => !current.has(id));
  if (added.length) {
    const found = await db
      .selectFrom('courseGroups')
      .select('id')
      .where('courseId', '=', activity.courseId)
      .where('id', 'in', added)
      .execute();
    if (found.length !== added.length) throw badRequest('Some of those groups are not in this course.');
  }
  if (ids.length === current.size && added.length === 0) return;
  const ts = now();
  const write = async (trx: DB) => {
    await trx.deleteFrom('activityGroups').where('activityId', '=', activity.id).execute();
    if (ids.length) {
      await trx
        .insertInto('activityGroups')
        .values(ids.map((groupId) => ({ activityId: activity.id, groupId, courseId: activity.courseId, createdAt: ts })))
        .execute();
    }
  };
  if (db.isTransaction) await write(db);
  else await db.transaction().execute(write);
}

/**
 * The groups the viewer can pick from for a group mode. Separate groups: people who can't access all groups only
 * get their own groups, and no "All participants". Otherwise staff (and everyone in visible groups) get every group;
 * students get their own groups.
 */
export async function groupChoice(db: DB, access: CourseAccess, mode: GroupMode): Promise<GroupChoice> {
  const all = await courseGroupRefs(db, access.course.id);
  const everyGroup = accessesAllGroups(access) || (mode !== 'separate' && (canSeeAllGroups(access) || mode === 'visible'));
  if (everyGroup) return { groups: all, allParticipants: true };
  const mine = await userGroupIds(db, access.course.id, access.user.id);
  return { groups: all.filter((g) => mine.has(g.id)), allParticipants: mode !== 'separate' };
}

/** How groups work in an activity for the viewer: the mode, the groups they can pick, and (forums) where they can post. */
export async function activityGroupInfo(db: DB, access: ActivityAccess): Promise<ActivityGroupInfo> {
  const mode = effectiveGroupMode(access.course, access.activity);
  const choice = await groupChoice(db, access, mode);
  if (mode === 'none') return { mode, ...choice, postGroups: [], postToAll: true };
  if (accessesAllGroups(access)) return { mode, ...choice, postGroups: choice.groups, postToAll: true };
  const mine = await userGroupIds(db, access.course.id, access.user.id);
  return { mode, ...choice, postGroups: choice.groups.filter((g) => mine.has(g.id)), postToAll: false };
}

/** Which students' work a staff member sees in an activity. */
export interface StudentScope {
  mode: GroupMode;
  choice: GroupChoice;
  /** The group picked with `?groupId=`. */
  group: GroupRef | null;
  /** Only members of these groups (the picked group, or the viewer's own groups in separate groups mode); null: everyone. */
  groupIds: string[] | null;
  /** The activity is limited to these groups, so it only applies to their members; null: everyone. */
  restrictedTo: string[] | null;
}

/**
 * The students whose work the viewer sees in an activity: in separate groups mode, staff without
 * `course:accessAllGroups` only see their own groups; a restricted activity only applies to its groups' members.
 * `groupId` narrows it to one group, which must be one the viewer can pick (otherwise "Group not found").
 */
export async function studentScope(db: DB, access: ActivityAccess, groupId?: string | null): Promise<StudentScope> {
  const mode = effectiveGroupMode(access.course, access.activity);
  const choice = await groupChoice(db, access, mode);
  let group: GroupRef | null = null;
  if (groupId) {
    group = choice.groups.find((g) => g.id === groupId) ?? null;
    if (!group) throw notFound('Group');
  }
  const restriction = await restrictionOf(db, access.activity.id);
  return {
    mode,
    choice,
    group,
    groupIds: group ? [group.id] : choice.allParticipants ? null : choice.groups.map((g) => g.id),
    restrictedTo: restriction.length ? restriction : null,
  };
}

/** Limits a query to the students in scope: `whereInScope(db, query, 'enrolments.userId', scope)`. */
export function whereInScope<QB extends SelectQueryBuilder<any, any, any>>(
  db: DB,
  qb: QB,
  column: string,
  scope: Pick<StudentScope, 'groupIds' | 'restrictedTo'>,
): QB {
  let query: SelectQueryBuilder<any, any, any> = qb;
  for (const ids of [scope.groupIds, scope.restrictedTo]) {
    if (!ids) continue;
    query = ids.length
      ? query.where(
          column,
          'in',
          db.selectFrom('courseGroupMembers').select('courseGroupMembers.userId').where('courseGroupMembers.groupId', 'in', ids),
        )
      : query.where(sql<boolean>`1 = 0`);
  }
  return query as QB;
}

/** Whether one student is in scope (for grading one student, or opening their attempt). */
export async function inScope(db: DB, scope: Pick<StudentScope, 'groupIds' | 'restrictedTo'>, userId: string): Promise<boolean> {
  for (const ids of [scope.groupIds, scope.restrictedTo]) {
    if (!ids) continue;
    if (ids.length === 0) return false;
    const row = await db
      .selectFrom('courseGroupMembers')
      .select('userId')
      .where('groupId', 'in', ids)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!row) return false;
  }
  return true;
}

export type CellState = 'ok' | 'notApplicable' | 'hidden';

/** The gradebook as one viewer sees it: which groups they can pick, which rows they get, and the state of each cell. */
export interface GradebookScope {
  choice: GroupChoice;
  group: GroupRef | null;
  /** Rows: only members of these groups; null: every student. */
  groupIds: string[] | null;
  cell(activityId: string, userId: string): CellState;
}

/**
 * The gradebook follows the course's group mode for its rows (separate groups: staff without
 * `course:accessAllGroups` only get their own groups' students), and each activity's mode for its column: in an
 * activity with separate groups those staff don't see other groups' grades. Cells of students a restricted activity
 * doesn't apply to are "not applicable".
 */
export async function gradebookScope(db: DB, access: CourseAccess, groupId?: string | null): Promise<GradebookScope> {
  const { course } = access;
  const choice = await groupChoice(db, access, effectiveGroupMode(course));
  let group: GroupRef | null = null;
  if (groupId) {
    group = choice.groups.find((g) => g.id === groupId) ?? null;
    if (!group) throw notFound('Group');
  }
  const availability = await loadAvailability(db, course.id);
  let separate = new Set<string>();
  let mine = new Set<string>();
  let members = new Map<string, Set<string>>();
  if (!accessesAllGroups(access)) {
    const activities = await db
      .selectFrom('activities')
      .select(['id', 'groupMode'])
      .where('courseId', '=', course.id)
      .where('maxGrade', 'is not', null)
      .execute();
    separate = new Set(activities.filter((a) => effectiveGroupMode(course, a) === 'separate').map((a) => a.id));
    if (separate.size) {
      mine = await userGroupIds(db, course.id, access.user.id);
      members = await membershipsIn(db, [course.id]);
    }
  }
  return {
    choice,
    group,
    groupIds: group ? [group.id] : choice.allParticipants ? null : choice.groups.map((g) => g.id),
    cell(activityId, userId) {
      if (!availability.isAvailable(activityId, userId)) return 'notApplicable';
      if (separate.has(activityId) && !overlaps(members.get(userId), mine)) return 'hidden';
      return 'ok';
    },
  };
}

/**
 * Group rules for lists of students' work across the courses a staff member teaches (the dashboard's "To grade"),
 * in a fixed number of queries. `ruled` are the courses where a rule may hide work from the viewer (they can't
 * access all groups, or an activity is restricted); work elsewhere can be counted in SQL. `filter` keeps the work
 * the viewer sees, as gradebookScope's cell() being 'ok'.
 */
export async function staffWorkRules(
  db: DB,
  user: { id: string; role: SiteRole },
  courses: Array<Pick<CourseRow, 'id' | 'groupMode'> & { myRole: CourseRole }>,
) {
  const limited = new Set(
    courses.filter((c) => !getCourseCapabilities(user.role, c.myRole).includes('course:accessAllGroups')).map((c) => c.id),
  );
  const rows = courses.length
    ? await db
        .selectFrom('activityGroups')
        .select(['activityId', 'groupId', 'courseId'])
        .where(
          'courseId',
          'in',
          courses.map((c) => c.id),
        )
        .execute()
    : [];
  const restricted = new Map<string, Set<string>>();
  const ruled = new Set(limited);
  for (const row of rows) {
    ruled.add(row.courseId);
    let set = restricted.get(row.activityId);
    if (!set) restricted.set(row.activityId, (set = new Set()));
    set.add(row.groupId);
  }
  const courseMode = new Map(courses.map((c) => [c.id, c.groupMode]));
  return {
    ruled: [...ruled],
    async filter<T extends { activityId: string; activityGroupMode: string | null; courseId: string; userId: string }>(
      work: T[],
    ): Promise<T[]> {
      if (work.length === 0) return work;
      // Group ids by course and user: the viewer's groups in one course say nothing about another.
      const userIds = new Set([user.id, ...work.map((w) => w.userId)]);
      const rows = await db
        .selectFrom('courseGroupMembers')
        .select(['courseId', 'userId', 'groupId'])
        .where('courseId', 'in', [...new Set(work.map((w) => w.courseId))])
        .$if(userIds.size <= MAX_IN, (q) => q.where('userId', 'in', [...userIds]))
        .execute();
      const groups = new Map<string, Set<string>>();
      for (const row of rows) {
        const key = `${row.courseId} ${row.userId}`;
        groups.set(key, (groups.get(key) ?? new Set<string>()).add(row.groupId));
      }
      const empty = new Set<string>();
      return work.filter((w) => {
        const theirs = groups.get(`${w.courseId} ${w.userId}`);
        const allowed = restricted.get(w.activityId);
        if (allowed && !overlaps(theirs, allowed)) return false;
        const separate = toGroupMode(w.activityGroupMode ?? courseMode.get(w.courseId)) === 'separate';
        return !(limited.has(w.courseId) && separate && !overlaps(theirs, groups.get(`${w.courseId} ${user.id}`) ?? empty));
      });
    },
  };
}

/**
 * Of `userIds`, the people who can open the activity (and, for a group discussion, see it): enrolled with access to
 * the course, the activity visible to them, in one of its groups if it is restricted, and in the discussion's group
 * in separate groups mode unless they can access all groups. Use it for notifications about the activity.
 */
export async function audienceOf(
  db: DB,
  activity: ActivityRow,
  userIds: Iterable<string>,
  options: { discussionGroupId?: string | null } = {},
): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const [course, section, users, enrolments, members, restriction] = await Promise.all([
    db.selectFrom('courses').select(['id', 'visibility', 'groupMode']).where('id', '=', activity.courseId).executeTakeFirst(),
    db.selectFrom('sections').select('visible').where('id', '=', activity.sectionId).executeTakeFirst(),
    db.selectFrom('users').select(['id', 'role']).where('id', 'in', ids).execute(),
    db
      .selectFrom('enrolments')
      .select(['userId', 'role'])
      .where('courseId', '=', activity.courseId)
      .where('userId', 'in', ids)
      .where('status', '=', 'active')
      .execute(),
    db
      .selectFrom('courseGroupMembers')
      .select(['userId', 'groupId'])
      .where('courseId', '=', activity.courseId)
      .where('userId', 'in', ids)
      .execute(),
    restrictionOf(db, activity.id),
  ]);
  if (!course) return [];
  const roleOf = new Map(enrolments.map((e) => [e.userId, e.role]));
  const groupsOf = new Map<string, Set<string>>();
  for (const m of members) groupsOf.set(m.userId, (groupsOf.get(m.userId) ?? new Set()).add(m.groupId));
  const hidden = !activity.visible || !section?.visible;
  const separate = effectiveGroupMode(course, activity) === 'separate';
  const groupId = options.discussionGroupId ?? null;
  return users
    .filter((u) => {
      const caps = getCourseCapabilities(u.role, roleOf.get(u.id) ?? null);
      if (!caps.includes('course:view')) return false;
      const staff = caps.includes('course:viewHidden');
      if (!staff && (hidden || course.visibility === 'draft')) return false;
      const mine = groupsOf.get(u.id) ?? new Set<string>();
      if (!staff && restriction.length && !restriction.some((g) => mine.has(g))) return false;
      if (separate && groupId && !caps.includes('course:accessAllGroups') && !mine.has(groupId)) return false;
      return true;
    })
    .map((u) => u.id);
}
