/**
 * The live class worker: a small timer that starts and stops with the server (unref'd, like the email outbox).
 * Each run sends due reminders, keeps provider meetings in step with sessions (Zoom meetings are created for the next
 * two weeks, and every meeting that exists follows its session; rooms of cancelled or deleted sessions and classes, and
 * meetings replaced for another host, are removed at the provider), watches running BigBlueButton
 * rooms for attendance, and fetches recordings and reports after sessions. Several server processes can run it at
 * once: every piece of work is claimed with a conditional update first.
 */
import type { ActivityRow, CourseRow } from '../../db/schema.js';
import type { LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { EventBus } from '../../lib/events.js';
import { now, num } from '../../lib/util.js';
import { parseSettings } from '../activity-types.js';
import { effectiveGroupMode } from '../group-modes.js';
import { courseMembers, evaluateLiveCompletion, matchMember, recordPresence } from './attendance.js';
import { loadLiveConfig, providerStatus, publicBase, type LiveConfig } from './config.js';
import { LiveProviderError, logProviderProblem } from './http.js';
import { claimRoom, liveProvider, releaseRoom, type LiveDeps, type RoomContext } from './providers.js';
import { saveProviderRecordings } from './recordings.js';
import { ensureRoom, roomGroups } from './rooms.js';
import { sendDueReminders } from './sessions.js';

const TICK_MS = 60_000;
/** Provider calls one run may make, so a run stays short even with many classes. */
const CALL_BUDGET = 40;
/** Zoom meetings are created this far ahead (Zoom limits how many meetings a user can create per day). */
export const ZOOM_AHEAD_DAYS = 14;
/** How long after a session to keep looking for recordings and reports. */
const FOLLOW_UPS_MS = [10 * 60_000, 60 * 60_000, 4 * 3600_000, 12 * 3600_000, 24 * 3600_000];
const POLL_EVERY_MS = 55_000;
const MAX_REMOVE_ATTEMPTS = 10;

export interface LiveRunResult {
  reminders: number;
  synced: number;
  removed: number;
  polled: number;
  followedUp: number;
}

interface Budget {
  left: number;
}

const take = (budget: Budget) => {
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
};

const backoff = (attempts: number) => new Date(Date.now() + Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8))).toISOString();

async function loadRefs(deps: LiveDeps, activityId: string | null, courseId: string | null) {
  const activity = activityId
    ? await deps.db.selectFrom('activities').selectAll().where('id', '=', activityId).executeTakeFirst()
    : undefined;
  const course = courseId ? await deps.db.selectFrom('courses').selectAll().where('id', '=', courseId).executeTakeFirst() : undefined;
  return { activity, course };
}

function roomContext(
  deps: LiveDeps,
  config: LiveConfig,
  refs: { activity: ActivityRow; course: CourseRow; session: LiveSessionRow; room: LiveRoomRow },
  groupName: string | null,
): RoomContext {
  return {
    deps,
    config,
    activity: refs.activity,
    course: refs.course,
    session: refs.session,
    settings: parseSettings('live', refs.activity.settings),
    room: refs.room,
    groupName,
    origin: publicBase(deps.config.publicUrl),
  };
}

/** Rooms of sessions that haven't started, left over from another provider or from groups the class no longer has. */
async function retireStaleRooms(deps: LiveDeps, config: LiveConfig, nowMs: number): Promise<void> {
  const { db } = deps;
  const rows = await db
    .selectFrom('liveRooms')
    .innerJoin('liveSessions', 'liveSessions.id', 'liveRooms.sessionId')
    .innerJoin('activities', 'activities.id', 'liveSessions.activityId')
    .innerJoin('courses', 'courses.id', 'liveSessions.courseId')
    .select([
      'liveRooms.id',
      'liveRooms.provider',
      'liveRooms.groupKey',
      'activities.id as activityId',
      'activities.settings',
      'activities.groupMode',
      'courses.groupMode as courseGroupMode',
      'courses.id as courseId',
    ])
    .where('liveRooms.state', '=', 'active')
    .where('liveRooms.startedAt', 'is', null)
    .where('liveSessions.startsAt', '>', new Date(nowMs).toISOString())
    .limit(1000)
    .execute();
  const groups = new Map<string, Set<string>>();
  const stale: string[] = [];
  for (const r of rows) {
    const settings = parseSettings('live', r.settings);
    if (settings.provider !== r.provider) {
      stale.push(r.id);
      continue;
    }
    const provider = liveProvider(r.provider);
    const grouped =
      !!provider?.traits(config).groupRooms && effectiveGroupMode({ groupMode: r.courseGroupMode }, { groupMode: r.groupMode }) !== 'none';
    if (!grouped && r.groupKey !== '') stale.push(r.id);
    else if (grouped) {
      if (r.groupKey === '') {
        stale.push(r.id);
        continue;
      }
      // Groups that were deleted, or that the class is no longer limited to.
      let ids = groups.get(r.activityId);
      if (!ids) groups.set(r.activityId, (ids = new Set((await roomGroups(db, r.activityId, r.courseId)).map((g) => g.id))));
      if (!ids.has(r.groupKey)) stale.push(r.id);
    }
  }
  for (let i = 0; i < stale.length; i += 400) {
    await db
      .updateTable('liveRooms')
      .set({ sessionId: null, state: 'delete', updatedAt: now() })
      .where('id', 'in', stale.slice(i, i + 400))
      .where('startedAt', 'is', null)
      .execute();
  }
}

/**
 * Zoom meetings for the sessions of the next two weeks, created and updated as sessions change. Meetings that already
 * exist further ahead (a session moved later, or started early by staff) keep following their session too.
 */
async function syncAhead(deps: LiveDeps, config: LiveConfig, budget: Budget, nowMs: number): Promise<number> {
  const { db } = deps;
  if (!providerStatus(config, 'zoom', deps.config.publicUrl).ready) return 0;
  const ahead = new Date(nowMs + ZOOM_AHEAD_DAYS * 86_400_000).toISOString();
  const sessions = await db
    .selectFrom('liveSessions')
    .innerJoin('activities', 'activities.id', 'liveSessions.activityId')
    .selectAll('liveSessions')
    .where('liveSessions.status', '=', 'scheduled')
    .where('liveSessions.endsAt', '>', new Date(nowMs).toISOString())
    .where((eb) =>
      eb.or([
        eb('liveSessions.startsAt', '<=', ahead),
        eb.exists(
          eb
            .selectFrom('liveRooms')
            .select('liveRooms.id')
            .whereRef('liveRooms.sessionId', '=', 'liveSessions.id')
            .where('liveRooms.provider', '=', 'zoom')
            .where('liveRooms.state', '=', 'active')
            .where('liveRooms.externalId', 'is not', null),
        ),
      ]),
    )
    .where('activities.type', '=', 'live')
    .where('activities.settings', 'like', '%"provider":"zoom"%')
    .orderBy('liveSessions.startsAt', 'asc')
    .limit(500)
    .execute();
  let synced = 0;
  const refsCache = new Map<string, { activity?: ActivityRow; course?: CourseRow }>();
  for (const session of sessions) {
    if (budget.left <= 0) break;
    let refs = refsCache.get(session.activityId);
    if (!refs) refsCache.set(session.activityId, (refs = await loadRefs(deps, session.activityId, session.courseId)));
    const { activity, course } = refs;
    if (!activity || !course) continue;
    const settings = parseSettings('live', activity.settings);
    if (settings.provider !== 'zoom') continue;
    const provider = liveProvider('zoom')!;
    const grouped = provider.traits(config).groupRooms && effectiveGroupMode(course, activity) !== 'none';
    const wanted = grouped ? await roomGroups(db, activity.id, course.id) : [{ id: null as string | null, name: null as string | null }];
    // Beyond the two weeks, only meetings that exist are kept in step; the others are created once the session is near.
    const existing =
      session.startsAt > ahead
        ? new Map(
            (
              await db
                .selectFrom('liveRooms')
                .selectAll()
                .where('sessionId', '=', session.id)
                .where('provider', '=', 'zoom')
                .where('state', '=', 'active')
                .where('externalId', 'is not', null)
                .execute()
            ).map((r) => [r.groupKey, r]),
          )
        : null;
    for (const group of wanted) {
      if (existing && !existing.has(group.id ?? '')) continue;
      const room = existing?.get(group.id ?? '') ?? (await ensureRoom(db, session, 'zoom', group.id));
      // After a failure, wait for the backoff. sync() itself returns without calling Zoom when nothing changed.
      if (room.syncError && room.nextSyncAt && Date.parse(room.nextSyncAt) > nowMs) continue;
      if (budget.left <= 0) break;
      try {
        if (await provider.sync!(roomContext(deps, config, { activity, course, session, room }, group.name))) {
          budget.left--;
          synced++;
        }
      } catch (err) {
        budget.left--;
        logProviderProblem('setting up a Zoom meeting', err);
      }
    }
  }
  return synced;
}

/** Rooms of cancelled or deleted sessions and classes: removed at the provider, then forgotten. */
async function removeRetired(deps: LiveDeps, config: LiveConfig, budget: Budget, nowMs: number): Promise<number> {
  const { db } = deps;
  const rows = await db
    .selectFrom('liveRooms')
    .selectAll()
    .where((eb) => eb.or([eb('state', '=', 'delete'), eb('sessionId', 'is', null)]))
    .where((eb) => eb.or([eb('nextSyncAt', 'is', null), eb('nextSyncAt', '<=', new Date(nowMs).toISOString())]))
    .limit(100)
    .execute();
  let removed = 0;
  for (const room of rows) {
    const provider = liveProvider(room.provider);
    const needsCall =
      !!provider?.remove &&
      (room.provider === 'zoom' ? !!room.externalId : room.provider === 'bbb' ? !!room.startedAt && !room.endedAt : false);
    if (needsCall && !take(budget)) break;
    const claim = await claimRoom(db, room.id);
    if (!claim) continue;
    try {
      if (needsCall) await provider!.remove!(config, room);
      await db.deleteFrom('liveRooms').where('id', '=', room.id).where('claimId', '=', claim).execute();
      removed++;
    } catch (err) {
      const attempts = room.syncAttempts + 1;
      if (attempts >= MAX_REMOVE_ATTEMPTS) {
        logProviderProblem(`giving up removing a ${room.provider} meeting`, err);
        await db.deleteFrom('liveRooms').where('id', '=', room.id).where('claimId', '=', claim).execute();
      } else {
        logProviderProblem(`removing a ${room.provider} meeting`, err);
        await releaseRoom(db, room.id, claim, { syncAttempts: attempts, nextSyncAt: backoff(attempts) });
      }
    }
  }
  return removed;
}

/** Who is in running BigBlueButton rooms (the presence each poll sees, extended while they stay). */
async function pollRunning(deps: LiveDeps, config: LiveConfig, budget: Budget, nowMs: number): Promise<number> {
  const { db } = deps;
  if (!providerStatus(config, 'bbb', deps.config.publicUrl).ready) return 0;
  const nowIso = new Date(nowMs).toISOString();
  const rooms = await db
    .selectFrom('liveRooms')
    .innerJoin('liveSessions', 'liveSessions.id', 'liveRooms.sessionId')
    .selectAll('liveRooms')
    .where('liveRooms.provider', '=', 'bbb')
    .where('liveRooms.state', '=', 'active')
    .where('liveRooms.startedAt', 'is not', null)
    .where('liveRooms.endedAt', 'is', null)
    .where('liveSessions.endsAt', '>', new Date(nowMs - 3 * 3600_000).toISOString())
    .where((eb) =>
      eb.or([eb('liveRooms.lastPolledAt', 'is', null), eb('liveRooms.lastPolledAt', '<=', new Date(nowMs - POLL_EVERY_MS).toISOString())]),
    )
    .limit(25)
    .execute();
  let polled = 0;
  for (const room of rooms) {
    if (!take(budget)) break;
    const claimed = await db
      .updateTable('liveRooms')
      .set({ lastPolledAt: nowIso })
      .where('id', '=', room.id)
      .where((eb) => (room.lastPolledAt ? eb('lastPolledAt', '=', room.lastPolledAt) : eb('lastPolledAt', 'is', null)))
      .executeTakeFirst();
    if (num(claimed.numUpdatedRows) !== 1) continue;
    try {
      await pollRoom(deps, config, room, nowIso);
      polled++;
    } catch (err) {
      logProviderProblem('checking a BigBlueButton meeting', err);
    }
  }
  return polled;
}

/** One look at a running BigBlueButton room. Also used when staff open the attendance of a running session. */
export async function pollRoom(deps: LiveDeps, config: LiveConfig, room: LiveRoomRow, nowIso = now()): Promise<void> {
  const { db } = deps;
  const provider = liveProvider(room.provider);
  if (!provider?.poll || !room.sessionId) return;
  const session = await db.selectFrom('liveSessions').selectAll().where('id', '=', room.sessionId).executeTakeFirst();
  if (!session) return;
  const result = await provider.poll(config, room);
  if (result.running) {
    const members = await courseMembers(db, session.courseId);
    const run = result.runId ?? room.runId ?? 'run';
    const entries = result.attendees.map((a) => {
      const userId = matchMember(members, { userId: a.userId, name: a.userId ? null : a.name });
      return {
        key: `${room.id}:${run}:${userId ?? `guest:${a.name}`}`,
        userId,
        name: a.name,
        role: a.role,
        joinedAt: nowIso,
        leftAt: nowIso,
      };
    });
    await recordPresence(db, session, room, 'bbb', entries, { extend: true });
    if (result.runId && result.runId !== room.runId)
      await db.updateTable('liveRooms').set({ runId: result.runId }).where('id', '=', room.id).execute();
    const users = [...new Set(entries.map((e) => e.userId).filter((u): u is string => !!u))];
    if (users.length) {
      const activity = await db.selectFrom('activities').selectAll().where('id', '=', session.activityId).executeTakeFirst();
      if (activity) await evaluateLiveCompletion(deps, activity, users);
    }
  } else if (result.ended) {
    await db
      .updateTable('liveRooms')
      .set({
        endedAt: nowIso,
        nextFollowUpAt: room.nextFollowUpAt ?? new Date(Date.parse(nowIso) + FOLLOW_UPS_MS[0]!).toISOString(),
        updatedAt: nowIso,
      })
      .where('id', '=', room.id)
      .where('endedAt', 'is', null)
      .execute();
  }
}

/** After a session: recordings (BigBlueButton, Zoom) and Zoom's participants report when there are no webhooks. */
async function followUp(deps: LiveDeps, config: LiveConfig, budget: Budget, nowMs: number): Promise<number> {
  const { db } = deps;
  const nowIso = new Date(nowMs).toISOString();
  // Only providers set up now: rooms of one that was turned off stay due, and would otherwise fill every run's batch.
  const ready = (['bbb', 'zoom'] as const).filter((id) => providerStatus(config, id, deps.config.publicUrl).ready);
  if (!ready.length) return 0;
  const rooms = await db
    .selectFrom('liveRooms')
    .innerJoin('liveSessions', 'liveSessions.id', 'liveRooms.sessionId')
    .selectAll('liveRooms')
    .where('liveRooms.state', '=', 'active')
    .where('liveRooms.provider', 'in', ready)
    .where('liveRooms.startedAt', 'is not', null)
    .where('liveRooms.followUpCount', '<', FOLLOW_UPS_MS.length)
    .where((eb) =>
      eb.or([
        eb('liveRooms.nextFollowUpAt', '<=', nowIso),
        eb.and([
          eb('liveRooms.nextFollowUpAt', 'is', null),
          eb('liveSessions.endsAt', '<=', new Date(nowMs - FOLLOW_UPS_MS[0]!).toISOString()),
        ]),
      ]),
    )
    .limit(20)
    .execute();
  let done = 0;
  for (const room of rooms) {
    const provider = liveProvider(room.provider);
    if (!provider || !providerStatus(config, provider.id, deps.config.publicUrl).ready) continue;
    if (!take(budget)) break;
    const next = room.followUpCount + 1;
    const claimed = await db
      .updateTable('liveRooms')
      .set({
        followUpCount: next,
        nextFollowUpAt: next < FOLLOW_UPS_MS.length ? new Date(nowMs + FOLLOW_UPS_MS[next]!).toISOString() : null,
      })
      .where('id', '=', room.id)
      .where('followUpCount', '=', room.followUpCount)
      .executeTakeFirst();
    if (num(claimed.numUpdatedRows) !== 1) continue;
    try {
      await fetchAfterSession(deps, config, room);
      done++;
    } catch (err) {
      logProviderProblem(`fetching ${provider.id} recordings or attendance`, err);
    }
  }
  return done;
}

/** Recordings and (Zoom without webhooks) the participants report of one room. Also behind staff's Refresh. */
export async function fetchAfterSession(deps: LiveDeps, config: LiveConfig, room: LiveRoomRow): Promise<void> {
  const { db } = deps;
  const provider = liveProvider(room.provider);
  if (!provider || !room.sessionId) return;
  const session = await db.selectFrom('liveSessions').selectAll().where('id', '=', room.sessionId).executeTakeFirst();
  if (!session) return;
  if (provider.recordings) {
    await saveProviderRecordings(db, session, room, provider.id === 'bbb' ? 'bbb' : 'zoom', await provider.recordings(config, room));
  }
  if (provider.report && provider.traits(config).report) {
    try {
      const report = await provider.report(config, room);
      const members = await courseMembers(db, session.courseId);
      const entries = report.map((p) => ({ ...p, userId: matchMember(members, { email: p.email, name: p.name }) }));
      await recordPresence(db, session, room, 'zoom-report', entries, { extend: true });
      await db.updateTable('liveRooms').set({ syncError: null }).where('id', '=', room.id).execute();
      const users = [...new Set(entries.map((e) => e.userId).filter((u): u is string => !!u))];
      const activity = await db.selectFrom('activities').selectAll().where('id', '=', session.activityId).executeTakeFirst();
      if (activity && users.length) await evaluateLiveCompletion(deps, activity, users);
    } catch (err) {
      const message = err instanceof LiveProviderError ? err.message : 'Zoom’s participants report couldn’t be read.';
      await db
        .updateTable('liveRooms')
        .set({ syncError: `Attendance: ${message}` })
        .where('id', '=', room.id)
        .execute();
      throw err;
    }
  }
}

/** One run of everything above. Safe to call from several processes, or from tests with a fixed `now`. */
export async function runLiveMaintenance(deps: LiveDeps, nowMs = Date.now()): Promise<LiveRunResult> {
  const result: LiveRunResult = { reminders: 0, synced: 0, removed: 0, polled: 0, followedUp: 0 };
  const budget: Budget = { left: CALL_BUDGET };
  const step = async (name: string, fn: () => Promise<number | void>, key?: keyof LiveRunResult) => {
    try {
      const n = await fn();
      if (key && typeof n === 'number') result[key] = n;
    } catch (err) {
      logProviderProblem(name, err);
    }
  };
  await step('sending reminders', () => sendDueReminders(deps, nowMs), 'reminders');
  const config = await loadLiveConfig(deps.db);
  await step('tidying rooms', () => retireStaleRooms(deps, config, nowMs));
  await step('removing meetings', () => removeRetired(deps, config, budget, nowMs), 'removed');
  await step('setting up meetings', () => syncAhead(deps, config, budget, nowMs), 'synced');
  await step('checking running meetings', () => pollRunning(deps, config, budget, nowMs), 'polled');
  await step('fetching recordings and reports', () => followUp(deps, config, budget, nowMs), 'followedUp');
  return result;
}

export interface LiveWorker {
  /** Runs soon instead of at the next tick (after sessions change). */
  kick(): void;
  stop(): Promise<void>;
}

const workers = new WeakMap<EventBus, LiveWorker>();

/** The worker of a Coursekit instance, to kick it after changes. */
export function liveWorkerFor(events: EventBus): LiveWorker | undefined {
  return workers.get(events);
}

export function startLiveWorker(deps: LiveDeps): LiveWorker {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
    timer.unref();
  };
  const run = () => {
    timer = null;
    running = runLiveMaintenance(deps)
      .then(() => undefined)
      .catch((err) => logProviderProblem('the background run', err))
      .finally(() => {
        running = null;
        schedule(again ? 50 : TICK_MS);
        again = false;
      });
  };
  const offGroups = deps.events.on('activity.groups.updated', () => worker.kick());
  const worker: LiveWorker = {
    kick() {
      if (stopped) return;
      if (running) again = true;
      else schedule(200);
    },
    async stop() {
      stopped = true;
      offGroups();
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
      workers.delete(deps.events);
    },
  };
  workers.set(deps.events, worker);
  schedule(TICK_MS);
  return worker;
}
