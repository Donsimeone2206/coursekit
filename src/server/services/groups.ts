import { randomInt } from 'node:crypto';
import { groupCount, groupNames, MAX_AUTO_GROUPS, type GroupSplit } from '../../shared/groups.js';
import type { CourseGroups, GroupMember, GroupMembersAdded, GroupRef } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { CourseGroupRow, CourseRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/http.js';
import { newId, now, num } from '../lib/util.js';
import type { CourseAccess } from './access.js';

type Deps = Pick<AppDeps, 'db' | 'events'>;

const ROLE_ORDER = { teacher: 0, assistant: 1, student: 2 } as const;

/** Natural, case-insensitive order: "Group 2" comes before "Group 10". */
export function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** Staff see every group and who is in it. Students only see the groups they belong to. */
export function canSeeAllGroups(access: CourseAccess): boolean {
  return access.can('course:manageGroups') || access.can('course:manageParticipants') || access.can('grades:viewAll');
}

/** Subquery with the members of a group, for `where('enrolments.userId', 'in', groupMemberIds(db, id))`. */
export function groupMemberIds(db: DB, groupId: string) {
  return db.selectFrom('courseGroupMembers as gm').select('gm.userId').where('gm.groupId', '=', groupId);
}

/** Subquery with the ids of the groups a user belongs to in a course. */
function groupIdsOf(db: DB, courseId: string, userId: string) {
  return db
    .selectFrom('courseGroupMembers as mine')
    .select('mine.groupId')
    .where('mine.courseId', '=', courseId)
    .where('mine.userId', '=', userId);
}

/**
 * Resolves a `groupId` filter. The group must belong to the course and be one the viewer may see
 * (any group for staff, their own for students); otherwise it is "not found".
 */
export async function findVisibleGroup(db: DB, access: CourseAccess, groupId: string): Promise<GroupRef> {
  const group = await db
    .selectFrom('courseGroups')
    .select(['id', 'name'])
    .where('id', '=', groupId)
    .where('courseId', '=', access.course.id)
    .$if(!canSeeAllGroups(access), (q) => q.where('id', 'in', groupIdsOf(db, access.course.id, access.user.id)))
    .executeTakeFirst();
  if (!group) throw notFound('Group');
  return group;
}

/** The groups a user belongs to in a course. */
export async function groupsOfUser(db: DB, courseId: string, userId: string): Promise<GroupRef[]> {
  const rows = await db
    .selectFrom('courseGroupMembers')
    .innerJoin('courseGroups', 'courseGroups.id', 'courseGroupMembers.groupId')
    .select(['courseGroups.id', 'courseGroups.name'])
    .where('courseGroupMembers.courseId', '=', courseId)
    .where('courseGroupMembers.userId', '=', userId)
    .execute();
  return rows.sort(byName);
}

/** Each person's groups in the course, limited to the groups the viewer may see. One query for the whole course. */
export async function groupsByUser(db: DB, access: CourseAccess): Promise<Map<string, GroupRef[]>> {
  const rows = await db
    .selectFrom('courseGroupMembers')
    .innerJoin('courseGroups', 'courseGroups.id', 'courseGroupMembers.groupId')
    .select(['courseGroupMembers.userId', 'courseGroups.id', 'courseGroups.name'])
    .where('courseGroupMembers.courseId', '=', access.course.id)
    .$if(!canSeeAllGroups(access), (q) => q.where('courseGroupMembers.groupId', 'in', groupIdsOf(db, access.course.id, access.user.id)))
    .execute();
  const map = new Map<string, GroupRef[]>();
  for (const row of rows.sort(byName)) {
    const list = map.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.userId, list);
  }
  return map;
}

/**
 * The groups the viewer may see, each with its enrolled members. People who left the course keep their
 * membership rows, but they are hidden here and come back if they are enrolled again.
 */
export async function listGroups(db: DB, access: CourseAccess): Promise<CourseGroups> {
  const all = canSeeAllGroups(access);
  const mine = groupIdsOf(db, access.course.id, access.user.id);
  const [groups, members] = await Promise.all([
    db
      .selectFrom('courseGroups')
      .selectAll()
      .where('courseId', '=', access.course.id)
      .$if(!all, (q) => q.where('id', 'in', mine))
      .execute(),
    db
      .selectFrom('courseGroupMembers')
      .innerJoin('enrolments', (join) =>
        join.onRef('enrolments.courseId', '=', 'courseGroupMembers.courseId').onRef('enrolments.userId', '=', 'courseGroupMembers.userId'),
      )
      .innerJoin('users', 'users.id', 'courseGroupMembers.userId')
      .select(['courseGroupMembers.groupId', 'users.id', 'users.name', 'users.avatarUrl', 'enrolments.role', 'enrolments.status'])
      .where('courseGroupMembers.courseId', '=', access.course.id)
      .$if(!all, (q) => q.where('courseGroupMembers.groupId', 'in', mine).where('enrolments.status', '=', 'active'))
      .execute(),
  ]);
  const byGroup = new Map<string, GroupMember[]>();
  for (const m of members) {
    const list = byGroup.get(m.groupId) ?? [];
    list.push({ id: m.id, name: m.name, avatarUrl: m.avatarUrl, role: m.role, status: m.status });
    byGroup.set(m.groupId, list);
  }
  return {
    groups: groups.sort(byName).map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      createdAt: g.createdAt,
      members: (byGroup.get(g.id) ?? []).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || byName(a, b)),
    })),
    canManage: access.can('course:manageGroups') && !access.readOnly,
    allGroups: all,
  };
}

export async function loadGroup(db: DB, courseId: string, groupId: string): Promise<CourseGroupRow> {
  const group = await db
    .selectFrom('courseGroups')
    .selectAll()
    .where('id', '=', groupId)
    .where('courseId', '=', courseId)
    .executeTakeFirst();
  if (!group) throw notFound('Group');
  return group;
}

/** Unique index violations on SQLite and PostgreSQL. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === '23505' || /UNIQUE constraint failed/i.test(String(e?.message ?? ''));
}

const nameTaken = () => conflict('Another group in this course already has that name.');

async function assertNameFree(db: DB, courseId: string, name: string, exceptId?: string) {
  const taken = await db
    .selectFrom('courseGroups')
    .select('id')
    .where('courseId', '=', courseId)
    .where((eb) => eb(eb.fn('lower', ['name']), '=', eb.fn('lower', [eb.cast(eb.val(name), 'text')])))
    .$if(!!exceptId, (q) => q.where('id', '!=', exceptId!))
    .executeTakeFirst();
  if (taken) throw nameTaken();
}

export async function createGroup(deps: Deps, course: Pick<CourseRow, 'id'>, input: { name: string; description: string }) {
  await assertNameFree(deps.db, course.id, input.name);
  const ts = now();
  const group: CourseGroupRow = {
    id: newId(),
    courseId: course.id,
    name: input.name,
    description: input.description,
    createdAt: ts,
    updatedAt: ts,
  };
  try {
    await deps.db.insertInto('courseGroups').values(group).execute();
  } catch (err) {
    throw isUniqueViolation(err) ? nameTaken() : err;
  }
  deps.events.emit('group.created', { groupId: group.id, courseId: course.id });
  return group;
}

export async function updateGroup(
  deps: Deps,
  group: CourseGroupRow,
  input: { name?: string | undefined; description?: string | undefined },
) {
  if (input.name !== undefined && input.name !== group.name) await assertNameFree(deps.db, group.courseId, input.name, group.id);
  const update = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    updatedAt: now(),
  };
  try {
    await deps.db.updateTable('courseGroups').set(update).where('id', '=', group.id).execute();
  } catch (err) {
    throw isUniqueViolation(err) ? nameTaken() : err;
  }
  deps.events.emit('group.updated', { groupId: group.id, courseId: group.courseId });
  return { ...group, ...update };
}

export async function deleteGroup(deps: Deps, group: CourseGroupRow) {
  await deps.db.deleteFrom('courseGroups').where('id', '=', group.id).execute();
  deps.events.emit('group.deleted', { groupId: group.id, courseId: group.courseId });
}

/** Adds enrolled people to a group. People already in it, and anyone not enrolled in the course, are reported back. */
export async function addGroupMembers(deps: Deps, group: CourseGroupRow, userIds: string[]): Promise<GroupMembersAdded> {
  const { db } = deps;
  const ids = [...new Set(userIds)];
  const enrolledRows = ids.length
    ? await db.selectFrom('enrolments').select('userId').where('courseId', '=', group.courseId).where('userId', 'in', ids).execute()
    : [];
  const enrolled = new Set(enrolledRows.map((r) => r.userId));
  const eligible = ids.filter((id) => enrolled.has(id));
  const ts = now();
  const inserted = eligible.length
    ? await db
        .insertInto('courseGroupMembers')
        .values(eligible.map((userId) => ({ groupId: group.id, userId, courseId: group.courseId, createdAt: ts })))
        .onConflict((oc) => oc.columns(['groupId', 'userId']).doNothing())
        .returning('userId')
        .execute()
    : [];
  const added = inserted.map((r) => r.userId);
  const addedSet = new Set(added);
  for (const userId of added) deps.events.emit('group.member.added', { groupId: group.id, courseId: group.courseId, userId });
  return {
    added,
    alreadyMembers: eligible.filter((id) => !addedSet.has(id)),
    notEnrolled: ids.filter((id) => !enrolled.has(id)),
  };
}

export async function removeGroupMember(deps: Deps, group: CourseGroupRow, userId: string) {
  const result = await deps.db
    .deleteFrom('courseGroupMembers')
    .where('groupId', '=', group.id)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (num(result.numDeletedRows) === 0) throw notFound('Group member');
  deps.events.emit('group.member.removed', { groupId: group.id, courseId: group.courseId, userId });
}

/**
 * Shuffles people into balanced groups: `groups` makes `size` groups; `members` makes groups of at most
 * `size` people, using as few groups as that allows. Group sizes never differ by more than one.
 */
export function planGroups<T>(people: readonly T[], split: GroupSplit, size: number, random: (max: number) => number = randomInt): T[][] {
  const count = groupCount(split, size, people.length);
  const shuffled = [...people];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const groups: T[][] = Array.from({ length: count }, () => []);
  shuffled.forEach((person, i) => groups[i % count]!.push(person));
  return groups;
}

export interface AutoCreateInput {
  split: GroupSplit;
  size: number;
  /** Naming scheme, see `groupNames` in shared/groups.ts. */
  naming: string;
  /** Only place active students who aren't in any group yet. */
  onlyUngrouped: boolean;
}

/** Splits the course's active students into new groups at random, balancing their sizes. */
export async function autoCreateGroups(deps: Deps, course: Pick<CourseRow, 'id'>, input: AutoCreateInput) {
  const { db } = deps;
  const students = await db
    .selectFrom('enrolments')
    .select('enrolments.userId')
    .where('enrolments.courseId', '=', course.id)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .$if(input.onlyUngrouped, (q) =>
      q.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('courseGroupMembers')
              .select('courseGroupMembers.groupId')
              .whereRef('courseGroupMembers.userId', '=', 'enrolments.userId')
              .where('courseGroupMembers.courseId', '=', course.id),
          ),
        ),
      ),
    )
    .execute();
  const n = students.length;
  if (n === 0)
    throw badRequest(input.onlyUngrouped ? 'Every student is already in a group.' : 'There are no students to put into groups yet.');
  if (input.split === 'groups' && input.size > n) {
    throw badRequest(
      `There ${n === 1 ? 'is only 1 student' : `are only ${n} students`} to place, so make at most ${n} group${n === 1 ? '' : 's'}.`,
    );
  }
  const plan = planGroups(
    students.map((s) => s.userId),
    input.split,
    input.size,
  );
  if (plan.length > MAX_AUTO_GROUPS) throw badRequest(`That would make ${plan.length} groups. Make at most ${MAX_AUTO_GROUPS} at a time.`);

  const existing = await db.selectFrom('courseGroups').select('name').where('courseId', '=', course.id).execute();
  const names = groupNames(
    input.naming,
    plan.length,
    existing.map((g) => g.name),
  );
  if (names.some((name) => name.length > 100)) throw badRequest('That naming scheme makes names longer than 100 characters.');

  const ts = now();
  const created = plan.map((userIds, i) => ({
    group: { id: newId(), courseId: course.id, name: names[i]!, description: '', createdAt: ts, updatedAt: ts } satisfies CourseGroupRow,
    userIds,
  }));
  const memberships = created.flatMap(({ group, userIds }) =>
    userIds.map((userId) => ({ groupId: group.id, userId, courseId: course.id, createdAt: ts })),
  );
  try {
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < created.length; i += 100) {
        await trx
          .insertInto('courseGroups')
          .values(created.slice(i, i + 100).map((c) => c.group))
          .execute();
      }
      for (let i = 0; i < memberships.length; i += 400) {
        await trx
          .insertInto('courseGroupMembers')
          .values(memberships.slice(i, i + 400))
          .execute();
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'Groups changed while these were being made. Please try again.', 'conflict');
    throw err;
  }
  for (const { group, userIds } of created) {
    deps.events.emit('group.created', { groupId: group.id, courseId: course.id });
    for (const userId of userIds) deps.events.emit('group.member.added', { groupId: group.id, courseId: course.id, userId });
  }
  return created;
}
