/**
 * What a live class looks like to one viewer: its sessions with the rooms they can see and join, recordings, their
 * own attendance (learners) or attendance counts (staff), and the staff attendance list of a session.
 */
import {
  LIVE_PROVIDER_LABELS,
  liveSessionState,
  type LiveAttendanceRow,
  type LiveClassInfo,
  type LiveGuestRow,
  type LiveSession,
  type LiveSessionAttendance,
  type LiveSettings,
} from '../../../shared/live.js';
import type { UserRow } from '../../db/schema.js';
import type { LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { notFound } from '../../lib/http.js';
import type { ActivityAccess } from '../access.js';
import { loadActivityAccess } from '../access.js';
import { parseSettings } from '../activity-types.js';
import { courseGroupRefs, effectiveGroupMode, studentScope, userGroupIds, whereInScope } from '../group-modes.js';
import { groupsByUser, groupsOfUser } from '../groups.js';
import { attendanceFor, attendedCounts, coveredMinutes } from './attendance.js';
import { loadLiveConfig, providerStatus, zoomCanStart, zoomHostFor, type LiveConfig } from './config.js';
import { liveProvider, type LiveProvider } from './providers.js';
import { visibleRecordings } from './recordings.js';
import { roomGroups, roomTargets } from './rooms.js';

export interface LiveContext {
  access: ActivityAccess;
  settings: LiveSettings;
  config: LiveConfig;
  provider: LiveProvider | null;
  /** The provider is set up on the site. */
  ready: boolean;
  /** Why the class can't be joined, worded for the viewer. */
  problem: string | null;
  /** Starts sessions, takes attendance, manages recordings (live:moderate). */
  moderator: boolean;
  /** Schedules and edits sessions (course:manageContent). */
  manager: boolean;
}

/** Loads a live class for a viewer, through loadActivityAccess (visibility and group restrictions apply). */
export async function loadLiveContext(db: DB, user: UserRow, activityId: string, publicUrl: string | null): Promise<LiveContext> {
  const access = await loadActivityAccess(db, user, activityId);
  if (access.activity.type !== 'live') throw notFound('Live class');
  const settings = parseSettings('live', access.activity.settings);
  const config = await loadLiveConfig(db);
  const provider = liveProvider(settings.provider);
  const manager = access.can('course:manageContent');
  const moderator = access.can('live:moderate');
  let problem: string | null = null;
  let ready = false;
  if (!provider) {
    problem = manager ? 'Choose how this class meets: select Edit and pick a way to meet.' : 'This live class isn’t ready yet.';
  } else {
    const status = providerStatus(config, provider.id, publicUrl);
    ready = status.ready;
    if (!ready) {
      problem = moderator
        ? `${LIVE_PROVIDER_LABELS[provider.id]} isn’t set up on this site right now. An administrator can set it up under Administration → Live classes${manager ? ', or select Edit to pick another way to meet' : ''}.`
        : 'This live class can’t be joined right now. Please let your teacher know.';
    }
  }
  return { access, settings, config, provider, ready, problem, moderator, manager };
}

export async function loadSession(db: DB, sessionId: string): Promise<LiveSessionRow> {
  const session = await db.selectFrom('liveSessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  if (!session) throw notFound('Session');
  return session;
}

/** The students whose attendance the viewer sees (separate groups, group restrictions), optionally one group. */
export async function scopedStudents(db: DB, access: ActivityAccess, groupId?: string | null) {
  const scope = await studentScope(db, access, groupId);
  const rows = await whereInScope(
    db,
    db
      .selectFrom('enrolments')
      .innerJoin('users', 'users.id', 'enrolments.userId')
      .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
      .where('enrolments.courseId', '=', access.course.id)
      .where('enrolments.role', '=', 'student')
      .where('enrolments.status', '=', 'active'),
    'enrolments.userId',
    scope,
  )
    .orderBy('users.name', 'asc')
    .execute();
  return { scope, students: rows };
}

/**
 * The groups whose rooms' recordings the viewer may see: in separate groups mode, their own groups (unless they access
 * every group); otherwise every group (null). Decided by the group mode, not by whether the provider has group rooms
 * now: recordings keep the group of the room they came from after a class changes how it meets.
 */
async function recordingGroupKeys(db: DB, access: ActivityAccess): Promise<Set<string> | null> {
  if (effectiveGroupMode(access.course, access.activity) !== 'separate' || access.can('course:accessAllGroups')) return null;
  return userGroupIds(db, access.course.id, access.user.id);
}

/** Staff of a Zoom class with a room per group: more rooms on one host than it can run at once. */
async function zoomHostWarning(db: DB, ctx: LiveContext): Promise<string | null> {
  const { access, settings, config } = ctx;
  const limit = config.zoom.concurrentMeetings;
  const counts = new Map<string, { host: string; rooms: number }>();
  for (const group of await roomGroups(db, access.activity.id, access.course.id)) {
    const host = zoomHostFor(config.zoom, settings, group.id);
    if (!host) continue;
    const entry = counts.get(host.toLowerCase()) ?? { host, rooms: 0 };
    entry.rooms++;
    counts.set(host.toLowerCase(), entry);
  }
  const crowded = [...counts.values()].filter((c) => c.rooms > limit).sort((a, b) => b.rooms - a.rooms)[0];
  if (!crowded) return null;
  return `Zoom lets one user host ${limit === 1 ? 'only one meeting' : 'at most two meetings'} at a time, but the rooms of ${crowded.rooms} groups are hosted by ${crowded.host}, so some groups won’t get in. ${ctx.manager ? 'Give each group its own Zoom host: select Edit.' : 'Ask a teacher to give each group its own Zoom host.'}`;
}

export async function liveClassInfo(db: DB, ctx: LiveContext, nowMs = Date.now()): Promise<LiveClassInfo> {
  const { access, settings, provider, config } = ctx;
  const { activity } = access;
  const traits = provider?.traits(config) ?? null;
  const targets = await roomTargets(db, access, provider, config);
  const sessions = await db
    .selectFrom('liveSessions')
    .selectAll()
    .where('activityId', '=', activity.id)
    .orderBy('startsAt', 'asc')
    .execute();
  const ids = sessions.map((s) => s.id);
  const groupNames = new Map((await courseGroupRefs(db, access.course.id)).map((g) => [g.id, g.name]));
  const recordings = await visibleRecordings(
    db,
    ids,
    { staff: ctx.moderator, groupKeys: await recordingGroupKeys(db, access) },
    groupNames,
  );
  const isLearner = access.role === 'student';
  const started = sessions.filter((s) => s.status === 'scheduled' && Date.parse(s.startsAt) - settings.joinMinutesBefore * 60_000 <= nowMs);
  const mine = isLearner
    ? await attendanceFor(
        db,
        started.map((s) => s.id),
        [access.user.id],
      )
    : new Map();

  let summary: Map<string, { present: number; total: number }> | null = null;
  if (ctx.moderator && started.length) {
    const { students } = await scopedStudents(db, access);
    const all = await attendanceFor(
      db,
      started.map((s) => s.id),
      students.length <= 400 ? students.map((s) => s.id) : null,
    );
    const inScope = new Set(students.map((s) => s.id));
    summary = new Map(
      started.map((s) => {
        const users = all.get(s.id) ?? new Map();
        let present = 0;
        for (const [userId, entry] of users) if (inScope.has(userId) && entry.status === 'present') present++;
        return [s.id, { present, total: students.length }];
      }),
    );
  }

  let syncErrors = new Map<string, string>();
  if (ctx.moderator && ids.length) {
    const rows = await db
      .selectFrom('liveRooms')
      .select(['sessionId', 'syncError'])
      .where('activityId', '=', activity.id)
      .where('state', '=', 'active')
      .where('syncError', 'is not', null)
      .execute();
    syncErrors = new Map(rows.filter((r) => r.sessionId && r.syncError).map((r) => [r.sessionId!, r.syncError!]));
  }

  const list: LiveSession[] = sessions.map((s) => {
    const state = liveSessionState(s, settings.joinMinutesBefore, nowMs);
    const windowOpen = state === 'open' || state === 'live';
    const timeOk = ctx.moderator ? s.status === 'scheduled' : windowOpen;
    const rooms = targets.targets.map((t) => {
      // Archived courses are read-only for everyone but course managers.
      const canJoin = ctx.ready && t.joinable && timeOk && !access.readOnly;
      const joinUrl = canJoin ? `/live/join/${s.id}${t.groupId ? `?group=${encodeURIComponent(t.groupId)}` : ''}` : null;
      // Zoom: staff start the meeting as its host only when that host is shared or is them (enter checks it again).
      const canStart =
        ctx.moderator && provider?.id === 'zoom'
          ? zoomCanStart(config.zoom, zoomHostFor(config.zoom, settings, t.groupId ?? ''), access.user.email)
          : undefined;
      return {
        groupId: t.groupId,
        groupName: t.groupName,
        mine: t.mine,
        joinable: t.joinable,
        canJoin,
        joinUrl,
        ...(canStart !== undefined
          ? { canStart, participantUrl: joinUrl && canStart ? `${joinUrl}${joinUrl.includes('?') ? '&' : '?'}as=participant` : null }
          : {}),
      };
    });
    let joinNote: string | null = null;
    if (s.status === 'scheduled' && state !== 'ended') {
      if (!ctx.ready) joinNote = ctx.problem;
      else if (targets.note) joinNote = targets.note;
      else if (!ctx.moderator && state === 'upcoming') {
        joinNote =
          settings.joinMinutesBefore > 0
            ? `You can join ${settings.joinMinutesBefore} minutes before it starts.`
            : 'You can join when it starts.';
      }
    }
    const session: LiveSession = {
      id: s.id,
      seriesId: s.seriesId,
      title: s.title,
      agenda: s.agenda,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      durationMinutes: s.durationMinutes,
      timeZone: s.timeZone,
      status: s.status,
      state,
      joinOpensAt: new Date(Date.parse(s.startsAt) - settings.joinMinutesBefore * 60_000).toISOString(),
      rooms,
      canJoin: rooms.some((r) => r.canJoin),
      joinNote,
      recordings: recordings.get(s.id) ?? [],
      icsUrl: `/api/live/sessions/${s.id}/ics`,
    };
    if (isLearner && (state === 'live' || state === 'ended' || state === 'open')) {
      const entry = mine.get(s.id)?.get(access.user.id);
      session.attendance = entry
        ? { status: entry.status, joinedAt: entry.joinedAt, minutes: entry.minutes, marked: !!entry.marked }
        : { status: state === 'ended' ? 'absent' : null, joinedAt: null, minutes: null, marked: false };
    }
    if (summary?.has(s.id) && state !== 'upcoming' && state !== 'open') session.attendanceSummary = summary.get(s.id)!;
    if (ctx.manager) session.meetingUrl = s.meetingUrl;
    if (ctx.moderator) session.syncError = syncErrors.get(s.id) ?? null;
    return session;
  });

  let completion: LiveClassInfo['completion'] = null;
  if (isLearner && activity.completion === 'auto') {
    // Counted exactly as completion counts it (evaluateLiveCompletion), so the two always agree.
    const attended = (await attendedCounts(db, activity.id, [access.user.id])).get(access.user.id) ?? 0;
    completion = { required: Math.max(1, settings.attendanceRequired), attended };
  }

  return {
    activityId: activity.id,
    provider: provider?.id ?? null,
    providerLabel: provider ? LIVE_PROVIDER_LABELS[provider.id] : null,
    ready: ctx.ready,
    problem: ctx.problem,
    warning: ctx.moderator && ctx.ready && provider?.id === 'zoom' && targets.grouped ? await zoomHostWarning(db, ctx) : null,
    canManage: ctx.manager,
    canModerate: ctx.moderator,
    groupMode: targets.mode,
    myGroups: await groupsOfUser(db, access.course.id, access.user.id),
    embed: !!traits?.embeddable && settings.embed,
    canEndForEveryone: ctx.moderator && !!traits?.endForEveryone,
    joinMinutesBefore: settings.joinMinutesBefore,
    sessions: list,
    completion,
    icsUrl: `/api/live/activities/${activity.id}/ics`,
    serverTime: new Date(nowMs).toISOString(),
  };
}

const SOURCE_NOTES: Record<string, string> = {
  bbb: 'Times come from BigBlueButton: who is in the room while the class runs, and its full report when the class ends (needs the site’s public URL). People who joined through Coursekit count as present.',
  zoom: 'Times come from Zoom: its webhooks while the meeting runs, or its participants report after it ends. People are matched by their Zoom email or name; anyone who joined through Coursekit counts as present.',
  jitsi: 'Coursekit records when people join through it. Jitsi Meet doesn’t report when people leave, so there are no durations.',
  link: 'Coursekit records when people open the meeting link through it. It can’t see who is in the meeting or for how long.',
};

/** The attendance list of a session for staff, limited to the students they see. */
export async function sessionAttendance(
  db: DB,
  ctx: LiveContext,
  session: LiveSessionRow,
  groupId: string | null,
  nowMs = Date.now(),
): Promise<LiveSessionAttendance> {
  const { access } = ctx;
  const { scope, students } = await scopedStudents(db, access, groupId);
  const att =
    (await attendanceFor(db, [session.id], students.length <= 400 ? students.map((s) => s.id) : null)).get(session.id) ?? new Map();
  const groups = await groupsByUser(db, access);
  const started = Date.parse(session.startsAt) <= nowMs;
  const rows: LiveAttendanceRow[] = students.map((s) => {
    const entry = att.get(s.id);
    return {
      user: { id: s.id, name: s.name, avatarUrl: s.avatarUrl, email: s.email },
      groups: groups.get(s.id) ?? [],
      status: entry?.status ?? 'absent',
      source: entry?.source ?? null,
      marked: entry?.marked ?? null,
      joinedAt: entry?.joinedAt ?? null,
      leftAt: entry?.leftAt ?? null,
      minutes: entry?.minutes ?? null,
    };
  });
  // People the provider saw who aren't participants, in the rooms the viewer sees.
  const allowed = scope.groupIds ? new Set(['', ...scope.groupIds]) : null;
  const unmatched = await db
    .selectFrom('livePresence')
    .select(['name', 'joinedAt', 'leftAt', 'groupKey'])
    .where('sessionId', '=', session.id)
    .where('userId', 'is', null)
    .execute();
  const byName = new Map<string, { joinedAt: string; intervals: Array<{ start: number; end: number }> }>();
  for (const p of unmatched) {
    if (allowed && !allowed.has(p.groupKey)) continue;
    if (groupId && p.groupKey !== groupId) continue;
    const name = p.name?.trim() || 'Guest';
    const g = byName.get(name) ?? { joinedAt: p.joinedAt, intervals: [] };
    if (p.joinedAt < g.joinedAt) g.joinedAt = p.joinedAt;
    g.intervals.push({ start: Date.parse(p.joinedAt), end: Date.parse(p.leftAt ?? p.joinedAt) });
    byName.set(name, g);
  }
  const guests: LiveGuestRow[] = [...byName.entries()]
    .map(([name, g]) => ({ name, joinedAt: g.joinedAt, minutes: coveredMinutes(g.intervals) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    sessionId: session.id,
    rows,
    guests,
    groupChoice: scope.choice,
    sourceNote: SOURCE_NOTES[ctx.provider?.id ?? 'link']!,
    canMark: ctx.moderator && started && session.status === 'scheduled',
  };
}
