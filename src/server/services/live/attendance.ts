/**
 * Attendance of live class sessions. Evidence comes from Coursekit's join log (everyone who joins through Coursekit)
 * and from the provider where it reports it (BigBlueButton while a class runs and its analytics afterwards, Zoom's
 * webhooks or participants report). A teacher's mark wins over both. Someone is present when a teacher marked them
 * present, or (without a mark) when the provider saw them or they joined through Coursekit.
 */
import type { ActivityRow } from '../../db/schema.js';
import type { LivePresenceSource, LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { newId, now } from '../../lib/util.js';
import { parseSettings } from '../activity-types.js';
import { markCompleted, unmarkCompleted } from '../progress.js';
import type { LiveDeps } from './providers.js';

const CHUNK = 400;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface PresenceInput {
  /** Unique for this source in this session: the same event delivered twice changes nothing. */
  key: string;
  userId: string | null;
  name: string | null;
  role: 'moderator' | 'viewer' | null;
  joinedAt: string;
  leftAt: string | null;
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : b > a ? b : a);

/**
 * One entry per key. A provider can list one person twice (BigBlueButton lists every connection, so a second device
 * or a second tab repeats the user id), and PostgreSQL refuses an INSERT ... ON CONFLICT DO UPDATE that would change
 * one row twice. Repeats are merged: the earliest join, the latest leave.
 */
export function uniquePresence(entries: PresenceInput[]): PresenceInput[] {
  const byKey = new Map<string, PresenceInput>();
  for (const e of entries) {
    const key = e.key.slice(0, 400);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...e, key });
      continue;
    }
    byKey.set(key, {
      key,
      userId: seen.userId ?? e.userId,
      name: seen.name ?? e.name,
      role: seen.role === 'moderator' || e.role === 'moderator' ? 'moderator' : (seen.role ?? e.role),
      joinedAt: e.joinedAt < seen.joinedAt ? e.joinedAt : seen.joinedAt,
      leftAt: later(seen.leftAt, e.leftAt),
    });
  }
  return [...byKey.values()];
}

/**
 * Stores presence. New keys are added; for a key seen before, `extend` moves its end later (polling) and otherwise
 * the row stays as it was (a repeated webhook or callback).
 */
export async function recordPresence(
  db: DB,
  session: Pick<LiveSessionRow, 'id'>,
  room: Pick<LiveRoomRow, 'id' | 'groupKey'> | null,
  source: LivePresenceSource,
  entries: PresenceInput[],
  options: { extend?: boolean } = {},
): Promise<void> {
  const ts = now();
  for (const part of chunks(uniquePresence(entries), 100)) {
    const rows = part.map((e) => ({
      id: newId(),
      sessionId: session.id,
      roomId: room?.id ?? null,
      groupKey: room?.groupKey ?? '',
      userId: e.userId,
      source,
      sourceKey: e.key,
      name: e.name ? e.name.slice(0, 200) : null,
      role: e.role,
      joinedAt: e.joinedAt,
      leftAt: e.leftAt,
      createdAt: ts,
      updatedAt: ts,
    }));
    if (rows.length === 0) continue;
    await db
      .insertInto('livePresence')
      .values(rows)
      .onConflict((oc) =>
        options.extend
          ? oc.columns(['sessionId', 'source', 'sourceKey']).doUpdateSet((eb) => ({ leftAt: eb.ref('excluded.leftAt'), updatedAt: ts }))
          : oc.columns(['sessionId', 'source', 'sourceKey']).doNothing(),
      )
      .execute();
  }
}

/** Coursekit's join log: someone opened a room through Coursekit. */
export async function logJoin(
  db: DB,
  session: Pick<LiveSessionRow, 'id'>,
  room: Pick<LiveRoomRow, 'id' | 'groupKey'> | null,
  user: { id: string; name: string },
  role: 'moderator' | 'viewer',
): Promise<void> {
  const t = now();
  await recordPresence(db, session, room, 'join', [{ key: newId(), userId: user.id, name: user.name, role, joinedAt: t, leftAt: null }]);
}

export interface CourseMember {
  id: string;
  name: string;
  email: string;
}

/** Active participants of a course (any role), for matching provider participants to people. */
export async function courseMembers(db: DB, courseId: string): Promise<CourseMember[]> {
  return db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email'])
    .where('enrolments.courseId', '=', courseId)
    .where('enrolments.status', '=', 'active')
    .execute();
}

/**
 * Which participant a provider's attendee is: the user id Coursekit gave it (BigBlueButton), else the email
 * (Zoom, signed-in participants), else a name that only one participant has.
 */
export function matchMember(
  members: CourseMember[],
  who: { userId?: string | null; email?: string | null; name?: string | null },
): string | null {
  if (who.userId) {
    const byId = members.find((m) => m.id === who.userId);
    if (byId) return byId.id;
  }
  if (who.email) {
    const email = who.email.trim().toLowerCase();
    const byEmail = members.find((m) => m.email.toLowerCase() === email);
    if (byEmail) return byEmail.id;
  }
  if (who.name) {
    const name = who.name.trim().toLowerCase();
    const byName = members.filter((m) => m.name.trim().toLowerCase() === name);
    if (byName.length === 1) return byName[0]!.id;
  }
  return null;
}

/** Total minutes covered by some intervals, overlaps counted once. */
export function coveredMinutes(intervals: Array<{ start: number; end: number }>): number {
  const sorted = intervals.filter((i) => i.end >= i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const { start, end } of sorted) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return Math.round(total / 60_000);
}

export interface AttendanceEntry {
  status: 'present' | 'absent';
  source: 'manual' | 'provider' | 'join' | null;
  marked: 'present' | 'absent' | null;
  joinedAt: string | null;
  leftAt: string | null;
  minutes: number | null;
}

/**
 * Attendance per session and user, for the users with any evidence or mark (others are absent once a session has
 * started). `userIds` limits it to some people.
 */
export async function attendanceFor(
  db: DB,
  sessionIds: string[],
  userIds?: string[] | null,
): Promise<Map<string, Map<string, AttendanceEntry>>> {
  const result = new Map<string, Map<string, AttendanceEntry>>();
  if (sessionIds.length === 0 || userIds?.length === 0) return result;
  const wanted = userIds ? new Set(userIds) : null;
  const presence: Array<{ sessionId: string; userId: string | null; source: string; joinedAt: string; leftAt: string | null }> = [];
  const marks: Array<{ sessionId: string; userId: string; status: 'present' | 'absent' }> = [];
  for (const ids of chunks(sessionIds)) {
    presence.push(
      ...(await db
        .selectFrom('livePresence')
        .select(['sessionId', 'userId', 'source', 'joinedAt', 'leftAt'])
        .where('sessionId', 'in', ids)
        .where('userId', 'is not', null)
        .$if(!!wanted && wanted.size <= CHUNK, (q) => q.where('userId', 'in', [...wanted!]))
        .execute()),
    );
    marks.push(
      ...(await db
        .selectFrom('liveAttendance')
        .select(['sessionId', 'userId', 'status'])
        .where('sessionId', 'in', ids)
        .$if(!!wanted && wanted.size <= CHUNK, (q) => q.where('userId', 'in', [...wanted!]))
        .execute()),
    );
  }
  type Acc = {
    joins: number;
    provider: Array<{ start: number; end: number }>;
    providerSeen: boolean;
    first: string | null;
    last: string | null;
  };
  const acc = new Map<string, Map<string, Acc>>();
  const slot = (sessionId: string, userId: string): Acc => {
    let bySession = acc.get(sessionId);
    if (!bySession) acc.set(sessionId, (bySession = new Map()));
    let a = bySession.get(userId);
    if (!a) bySession.set(userId, (a = { joins: 0, provider: [], providerSeen: false, first: null, last: null }));
    return a;
  };
  for (const p of presence) {
    if (!p.userId || (wanted && !wanted.has(p.userId))) continue;
    const a = slot(p.sessionId, p.userId);
    if (!a.first || p.joinedAt < a.first) a.first = p.joinedAt;
    if (p.source === 'join') {
      a.joins++;
      continue;
    }
    a.providerSeen = true;
    if (p.leftAt && (!a.last || p.leftAt > a.last)) a.last = p.leftAt;
    a.provider.push({ start: Date.parse(p.joinedAt), end: Date.parse(p.leftAt ?? p.joinedAt) });
  }
  const markOf = new Map(marks.filter((m) => !wanted || wanted.has(m.userId)).map((m) => [`${m.sessionId} ${m.userId}`, m.status]));
  const keys = new Set<string>([...markOf.keys()]);
  for (const [sessionId, users] of acc) for (const userId of users.keys()) keys.add(`${sessionId} ${userId}`);
  for (const key of keys) {
    const [sessionId, userId] = key.split(' ') as [string, string];
    const a = acc.get(sessionId)?.get(userId) ?? null;
    const marked = markOf.get(key) ?? null;
    const evidence: AttendanceEntry['source'] = a?.providerSeen ? 'provider' : a && a.joins > 0 ? 'join' : null;
    const entry: AttendanceEntry = {
      status: marked ?? (evidence ? 'present' : 'absent'),
      source: marked ? 'manual' : evidence,
      marked,
      joinedAt: a?.first ?? null,
      leftAt: a?.last ?? null,
      minutes: a?.providerSeen ? coveredMinutes(a.provider) : null,
    };
    let bySession = result.get(sessionId);
    if (!bySession) result.set(sessionId, (bySession = new Map()));
    bySession.set(userId, entry);
  }
  return result;
}

/**
 * Sessions that count for attendance-based completion: every session that wasn't cancelled. Only evidence makes a
 * session count for someone (a join, the provider seeing them, a teacher's mark), and a session can't have any before
 * its join window opens. Not "sessions that started": a student who joins in the window before the start would then
 * not count, and nothing checks again when the session starts.
 */
async function countedSessions(db: DB, activityId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('liveSessions')
    .select('id')
    .where('activityId', '=', activityId)
    .where('status', '=', 'scheduled')
    .execute();
  return rows.map((r) => r.id);
}

/** How many sessions each user attended (sessions that weren't cancelled). */
export async function attendedCounts(db: DB, activityId: string, userIds?: string[]): Promise<Map<string, number>> {
  const sessions = await countedSessions(db, activityId);
  const counts = new Map<string, number>();
  const att = await attendanceFor(db, sessions, userIds);
  for (const users of att.values()) {
    for (const [userId, entry] of users) if (entry.status === 'present') counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Automatic completion of a live class: attending at least the required number of sessions. Checked again whenever
 * attendance or the settings change, so a teacher correcting attendance also corrects completion.
 */
export async function evaluateLiveCompletion(
  deps: Pick<LiveDeps, 'db' | 'events'>,
  activity: ActivityRow,
  userIds?: string[],
): Promise<void> {
  if (activity.type !== 'live' || activity.completion !== 'auto') return;
  const { db } = deps;
  const required = Math.max(1, parseSettings('live', activity.settings).attendanceRequired);
  const students = (
    await db
      .selectFrom('enrolments')
      .select('userId')
      .where('courseId', '=', activity.courseId)
      .where('role', '=', 'student')
      .where('status', '=', 'active')
      .$if(!!userIds, (q) => q.where('userId', 'in', userIds!.length ? userIds!.slice(0, 2000) : ['-']))
      .execute()
  ).map((r) => r.userId);
  if (students.length === 0) return;
  const counts = await attendedCounts(db, activity.id, students.length <= CHUNK ? students : undefined);
  const done = new Set<string>();
  for (const ids of chunks(students)) {
    const rows = await db
      .selectFrom('completions')
      .select('userId')
      .where('activityId', '=', activity.id)
      .where('userId', 'in', ids)
      .execute();
    for (const r of rows) done.add(r.userId);
  }
  for (const userId of students) {
    const attended = counts.get(userId) ?? 0;
    if (attended >= required && !done.has(userId)) await markCompleted(deps, activity, userId);
    else if (attended < required && done.has(userId)) await unmarkCompleted(db, activity.id, userId);
  }
}
