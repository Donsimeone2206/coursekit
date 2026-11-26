/**
 * Live classes. Mounted at the root:
 *
 * Inside /api (session, CSRF and no-store come from the /api middleware):
 * - /api/admin/live: provider settings (administrators; secrets are never sent back)
 * - /api/live/providers: the providers teachers can pick
 * - /api/live/activities/:activityId: the class for the viewer, scheduling sessions, its calendar file
 * - /api/live/sessions/:sessionId: edit, cancel, delete, calendar file, attendance, recordings, refresh, end, embed
 * - /api/live/recordings/:recordingId: hide or remove a recording
 *
 * Outside /api:
 * - GET /live/join/:sessionId: signed-in browsers; checks access and the join window, logs the join and redirects to
 *   the provider (a confirmation page first when the link came from another site)
 * - /live/bbb/:token/ended|recording|analytics: BigBlueButton callbacks, signed per room (and by BigBlueButton)
 * - POST /live/zoom/webhook: Zoom webhooks, verified with x-zm-signature
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  LIVE_PROVIDER_DESCRIPTIONS,
  LIVE_PROVIDER_IDS,
  LIVE_PROVIDER_LABELS,
  type LiveProviderOption,
  type LiveProviderId,
} from '../../shared/live.js';
import { sessionMiddleware } from '../auth/session.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { LiveRecordingRow, LiveRoomRow } from '../db/schema-live.js';
import { ApiError, badRequest, notFound, readBody, readQuery } from '../lib/http.js';
import { newId, now } from '../lib/util.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import { effectiveGroupMode, inScope, userGroupIds } from '../services/group-modes.js';
import { escapeHtml, sendError, sendPage } from '../services/lti/html.js';
import { evaluateLiveCompletion } from '../services/live/attendance.js';
import { verifyAnalyticsAuth, verifyRecordingReady, parseAnalytics } from '../services/live/bbb.js';
import {
  handleBbbAnalytics,
  handleBbbEnded,
  handleBbbRecordingReady,
  handleZoomEvent,
  loadRoomContext,
} from '../services/live/callbacks.js';
import {
  httpsUrlSchema,
  liveAdminInputSchema,
  loadLiveConfig,
  providerStatus,
  publicBase,
  saveLiveConfig,
  toLiveAdminSettings,
  verifyRoomToken,
} from '../services/live/config.js';
import { enterLiveSession } from '../services/live/enter.js';
import { LiveProviderError } from '../services/live/http.js';
import { buildIcs, icsFileName, type IcsEvent } from '../services/live/ics.js';
import { LIVE_PROVIDERS, liveProvider } from '../services/live/providers.js';
import { roomTargets } from '../services/live/rooms.js';
import {
  cancelSession,
  deleteSession,
  scheduleSchema,
  scheduleSessions,
  sessionLabel,
  sessionUpdateSchema,
  updateSession,
} from '../services/live/sessions.js';
import { liveClassInfo, loadLiveContext, loadSession, scopedStudents, sessionAttendance, type LiveContext } from '../services/live/view.js';
import { fetchAfterSession, liveWorkerFor, pollRoom } from '../services/live/worker.js';
import { clearZoomTokens, verifyZoomWebhook, zoomUrlValidation } from '../services/live/zoom.js';

const SMALL_BODY = 64 * 1024;
const WEBHOOK_BODY = 1024 * 1024;
const ANALYTICS_BODY = 4 * 1024 * 1024;

function errorJson(message: string, code: string) {
  return { error: { message, code } };
}

/** "attachment" with an ASCII name and the UTF-8 one (RFC 6266). */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function liveRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, config } = deps;
  const kick = () => liveWorkerFor(deps.events)?.kick();
  /** For what this response gives the requester (.ics files). */
  const origin = (c: Context) => publicBase(config.publicUrl) ?? new URL(c.req.url).origin;
  /**
   * For addresses a provider keeps and shows everyone (BigBlueButton's logout URL): only the public URL. The request's
   * origin comes from its Host header, which the client chooses, and the first person in creates the meeting.
   */
  const providerOrigin = publicBase(config.publicUrl);

  const context = (c: Context<AppEnv>, activityId: string) => loadLiveContext(db, requireUser(c), activityId, config.publicUrl);

  async function sessionContext(c: Context<AppEnv>) {
    const session = await loadSession(db, c.req.param('sessionId')!);
    const ctx = await context(c, session.activityId);
    return { session, ctx };
  }

  const assertManager = (ctx: LiveContext) => {
    assertCan(ctx.access, 'course:manageContent', 'Only teachers can schedule and change sessions.');
    assertWritable(ctx.access);
  };
  const assertModerator = (ctx: LiveContext) => {
    assertCan(ctx.access, 'live:moderate', 'Only teachers and teaching assistants can do that.');
    assertWritable(ctx.access);
  };

  // ---- administration -----------------------------------------------------------------------------

  async function usage(): Promise<Record<LiveProviderId, number>> {
    const counts = Object.fromEntries(LIVE_PROVIDER_IDS.map((id) => [id, 0])) as Record<LiveProviderId, number>;
    const rows = await db.selectFrom('activities').select('settings').where('type', '=', 'live').execute();
    for (const row of rows) {
      const provider = (() => {
        try {
          return (JSON.parse(row.settings) as { provider?: unknown }).provider;
        } catch {
          return null;
        }
      })();
      if (typeof provider === 'string' && provider in counts) counts[provider as LiveProviderId]++;
    }
    return counts;
  }

  r.get('/api/admin/live', async (c) => {
    requireAdmin(c);
    return c.json(toLiveAdminSettings(await loadLiveConfig(db), config.publicUrl, await usage()));
  });

  r.put('/api/admin/live', async (c) => {
    requireAdmin(c);
    const input = await readBody(c, liveAdminInputSchema);
    const saved = await saveLiveConfig(db, input);
    if (input.zoom) clearZoomTokens();
    kick();
    return c.json(toLiveAdminSettings(saved, config.publicUrl, await usage()));
  });

  r.post('/api/admin/live/:provider/test', async (c) => {
    requireAdmin(c);
    const id = c.req.param('provider') as LiveProviderId;
    const provider = LIVE_PROVIDER_IDS.includes(id) ? LIVE_PROVIDERS[id] : null;
    if (!provider) throw notFound('Provider');
    const cfg = await loadLiveConfig(db);
    const status = providerStatus(cfg, id, config.publicUrl);
    if (!status.ready) throw badRequest(status.problem ?? `Turn ${LIVE_PROVIDER_LABELS[id]} on first.`);
    if (!provider.test) return c.json({ ok: true, message: `${LIVE_PROVIDER_LABELS[id]} needs no connection test.` });
    try {
      return c.json({ ok: true, message: await provider.test(cfg) });
    } catch (err) {
      if (err instanceof LiveProviderError) throw badRequest(err.message);
      throw err;
    }
  });

  // ---- teachers and learners ----------------------------------------------------------------------

  r.get('/api/live/providers', async (c) => {
    const user = requireUser(c);
    const { courseId } = readQuery(c, z.object({ courseId: z.string().max(80) }));
    const access = await loadCourseAccess(db, user, courseId);
    assertCan(access, 'course:manageContent');
    const cfg = await loadLiveConfig(db);
    const options: LiveProviderOption[] = LIVE_PROVIDER_IDS.filter((id) => providerStatus(cfg, id, config.publicUrl).ready).map((id) => {
      const traits = LIVE_PROVIDERS[id].traits(cfg);
      return {
        id,
        label: LIVE_PROVIDER_LABELS[id],
        description: LIVE_PROVIDER_DESCRIPTIONS[id],
        recordings: traits.recordings,
        waitForModerator: traits.waitForModerator,
        embeddable: traits.embeddable,
        groupRooms: traits.groupRooms,
        ...(id === 'zoom'
          ? {
              defaultHost: cfg.zoom.defaultHost || null,
              hosts: [cfg.zoom.defaultHost, ...cfg.zoom.hosts].filter(
                (host, i, all) => !!host && all.findIndex((other) => other.toLowerCase() === host.toLowerCase()) === i,
              ),
              concurrentMeetings: cfg.zoom.concurrentMeetings,
            }
          : {}),
      };
    });
    return c.json(options);
  });

  r.get('/api/live/activities/:activityId', async (c) => {
    const ctx = await context(c, c.req.param('activityId'));
    return c.json(await liveClassInfo(db, ctx));
  });

  r.post('/api/live/activities/:activityId/sessions', async (c) => {
    const ctx = await context(c, c.req.param('activityId'));
    assertManager(ctx);
    const input = await readBody(c, scheduleSchema);
    const rows = await scheduleSessions(deps, ctx.access.activity, ctx.access.course, input, ctx.access.user.id);
    kick();
    return c.json({ ids: rows.map((s) => s.id) }, 201);
  });

  r.patch('/api/live/sessions/:sessionId', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertManager(ctx);
    const input = await readBody(c, sessionUpdateSchema);
    await updateSession(deps, ctx.access.activity, ctx.access.course, session, input);
    kick();
    return c.json({ ok: true });
  });

  r.post('/api/live/sessions/:sessionId/cancel', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertManager(ctx);
    await cancelSession(deps, ctx.access.activity, ctx.access.course, session);
    kick();
    return c.json({ ok: true });
  });

  r.delete('/api/live/sessions/:sessionId', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertManager(ctx);
    await deleteSession(deps, ctx.access.activity, ctx.access.course, session);
    kick();
    return c.json({ ok: true });
  });

  // ---- calendar files -----------------------------------------------------------------------------

  function icsEvent(c: Context, ctx: LiveContext, session: IcsEvent['session']): IcsEvent {
    const { activity, course } = ctx.access;
    const url = `${origin(c)}/courses/${course.slug}/activities/${activity.id}`;
    return {
      session,
      summary: sessionLabel(activity, session),
      description: [session.agenda.trim(), `Join from ${course.title} on Coursekit: ${url}`].filter(Boolean).join('\n\n'),
      url,
      location: ctx.provider ? `${LIVE_PROVIDER_LABELS[ctx.provider.id]} (online)` : 'Online',
      reminderMinutes: ctx.settings.reminderMinutes,
    };
  }

  const sendIcs = (c: Context, body: string, name: string) =>
    c.body(body, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': attachment(name) });

  r.get('/api/live/sessions/:sessionId/ics', async (c) => {
    const { session, ctx } = await sessionContext(c);
    const body = buildIcs([icsEvent(c, ctx, session)], { host: new URL(origin(c)).hostname, calendarName: ctx.access.course.title });
    return sendIcs(c, body, icsFileName(sessionLabel(ctx.access.activity, session), session.startsAt));
  });

  r.get('/api/live/activities/:activityId/ics', async (c) => {
    const ctx = await context(c, c.req.param('activityId'));
    const sessions = await db
      .selectFrom('liveSessions')
      .selectAll()
      .where('activityId', '=', ctx.access.activity.id)
      .orderBy('startsAt', 'asc')
      .execute();
    const body = buildIcs(
      sessions.map((s) => icsEvent(c, ctx, s)),
      { host: new URL(origin(c)).hostname, calendarName: ctx.access.activity.title },
    );
    return sendIcs(c, body, icsFileName(ctx.access.activity.title));
  });

  // ---- attendance ---------------------------------------------------------------------------------

  /** Rooms of a session the viewer moderates (their joinable rooms; every room for staff with access to all groups). */
  async function moderatedRooms(ctx: LiveContext, sessionId: string, groupId?: string | null): Promise<LiveRoomRow[]> {
    const targets = await roomTargets(db, ctx.access, ctx.provider, ctx.config);
    const keys = new Set(targets.targets.filter((t) => t.joinable).map((t) => t.groupId ?? ''));
    if (groupId !== undefined && groupId !== null && !keys.has(groupId)) throw notFound('Room');
    const rooms = await db.selectFrom('liveRooms').selectAll().where('sessionId', '=', sessionId).where('state', '=', 'active').execute();
    return rooms.filter((room) => keys.has(room.groupKey) && (groupId == null || room.groupKey === groupId));
  }

  r.get('/api/live/sessions/:sessionId/attendance', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertCan(ctx.access, 'live:moderate', 'Only teachers and teaching assistants can see attendance.');
    const { groupId } = readQuery(c, z.object({ groupId: z.string().max(40).optional() }));
    // A running BigBlueButton class: look at who is in the room now (at most every 20 seconds).
    if (ctx.ready && ctx.provider?.poll) {
      const fresh = Date.now() - 20_000;
      for (const room of await moderatedRooms(ctx, session.id)) {
        if (!room.startedAt || room.endedAt || (room.lastPolledAt && Date.parse(room.lastPolledAt) > fresh)) continue;
        await db.updateTable('liveRooms').set({ lastPolledAt: now() }).where('id', '=', room.id).execute();
        await pollRoom(deps, ctx.config, room).catch(() => {});
      }
    }
    return c.json(await sessionAttendance(db, ctx, session, groupId ?? null));
  });

  r.put('/api/live/sessions/:sessionId/attendance/:userId', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertModerator(ctx);
    if (session.status === 'cancelled') throw badRequest('This session was cancelled.');
    if (Date.parse(session.startsAt) > Date.now()) throw badRequest('Attendance can be marked once the session has started.');
    const { status } = await readBody(c, z.object({ status: z.enum(['present', 'absent']).nullable() }));
    const userId = c.req.param('userId');
    // Only students the viewer sees (separate groups) and the activity applies to (group restrictions).
    const { scope } = await scopedStudents(db, ctx.access);
    const student = await db
      .selectFrom('enrolments')
      .select('userId')
      .where('courseId', '=', ctx.access.course.id)
      .where('userId', '=', userId)
      .where('role', '=', 'student')
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!student || !(await inScope(db, scope, userId))) throw notFound('Student');
    if (status === null) {
      await db.deleteFrom('liveAttendance').where('sessionId', '=', session.id).where('userId', '=', userId).execute();
    } else {
      const row = { sessionId: session.id, userId, courseId: session.courseId, status, markedBy: ctx.access.user.id, markedAt: now() };
      await db
        .insertInto('liveAttendance')
        .values(row)
        .onConflict((oc) => oc.columns(['sessionId', 'userId']).doUpdateSet({ status, markedBy: row.markedBy, markedAt: row.markedAt }))
        .execute();
    }
    await evaluateLiveCompletion(deps, ctx.access.activity, [userId]);
    return c.json({ ok: true });
  });

  // ---- recordings ---------------------------------------------------------------------------------

  r.post('/api/live/sessions/:sessionId/recordings', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertModerator(ctx);
    const input = await readBody(
      c,
      z.object({
        title: z.string().trim().min(1, 'Add a title').max(200),
        url: httpsUrlSchema,
        groupId: z.string().max(40).nullable().default(null),
      }),
    );
    const targets = await roomTargets(db, ctx.access, ctx.provider, ctx.config);
    if (input.groupId && !targets.targets.some((t) => t.groupId === input.groupId && t.joinable)) throw notFound('Group');
    if (!input.groupId && targets.grouped && !ctx.access.can('course:accessAllGroups')) {
      throw badRequest('Pick the group this recording is for.');
    }
    const ts = now();
    const id = newId();
    await db
      .insertInto('liveRecordings')
      .values({
        id,
        sessionId: session.id,
        courseId: session.courseId,
        roomId: null,
        groupKey: targets.grouped ? (input.groupId ?? '') : '',
        source: 'manual',
        externalId: null,
        title: input.title,
        url: input.url,
        passcode: null,
        durationMinutes: null,
        recordedAt: null,
        hidden: 0,
        removedAt: null,
        addedBy: ctx.access.user.id,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    return c.json({ id }, 201);
  });

  async function recordingContext(c: Context<AppEnv>): Promise<{ recording: LiveRecordingRow; ctx: LiveContext }> {
    const recording = await db.selectFrom('liveRecordings').selectAll().where('id', '=', c.req.param('recordingId')!).executeTakeFirst();
    if (!recording || recording.removedAt) throw notFound('Recording');
    const session = await loadSession(db, recording.sessionId);
    const ctx = await context(c, session.activityId);
    assertModerator(ctx);
    // Another group's recording, for staff who only see their own groups: by the group mode, as the class page lists
    // them (not by whether the provider has group rooms now).
    if (recording.groupKey) {
      const mode = effectiveGroupMode(ctx.access.course, ctx.access.activity);
      if (mode !== 'none' && !ctx.access.can('course:accessAllGroups')) {
        const mine = await userGroupIds(db, ctx.access.course.id, ctx.access.user.id);
        if (!mine.has(recording.groupKey)) throw notFound('Recording');
      }
    }
    return { recording, ctx };
  }

  const providerCall = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof LiveProviderError) throw badRequest(err.message);
      throw err;
    }
  };

  r.patch('/api/live/recordings/:recordingId', async (c) => {
    const { recording, ctx } = await recordingContext(c);
    const { hidden } = await readBody(c, z.object({ hidden: z.boolean() }));
    const provider = recording.source === 'manual' ? null : liveProvider(recording.source);
    if (provider?.publishRecording && providerStatus(ctx.config, provider.id, config.publicUrl).ready) {
      await providerCall(() => provider.publishRecording!(ctx.config, recording, !hidden));
    }
    await db
      .updateTable('liveRecordings')
      .set({ hidden: hidden ? 1 : 0, updatedAt: now() })
      .where('id', '=', recording.id)
      .execute();
    return c.json({ ok: true });
  });

  r.delete('/api/live/recordings/:recordingId', async (c) => {
    const { recording, ctx } = await recordingContext(c);
    if (recording.source === 'manual') {
      await db.deleteFrom('liveRecordings').where('id', '=', recording.id).execute();
      return c.json({ ok: true });
    }
    const provider = liveProvider(recording.source);
    if (provider?.deleteRecording && providerStatus(ctx.config, provider.id, config.publicUrl).ready) {
      await providerCall(() => provider.deleteRecording!(ctx.config, recording));
    }
    // Kept as removed, so fetching recordings again doesn't bring it back.
    await db.updateTable('liveRecordings').set({ removedAt: now(), updatedAt: now() }).where('id', '=', recording.id).execute();
    return c.json({ ok: true });
  });

  // ---- moderation ---------------------------------------------------------------------------------

  r.post('/api/live/sessions/:sessionId/refresh', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertModerator(ctx);
    if (!ctx.ready || !ctx.provider) throw badRequest(ctx.problem ?? 'This live class can’t reach its provider right now.');
    for (const room of await moderatedRooms(ctx, session.id)) {
      if (!room.startedAt && !room.externalId) continue;
      await providerCall(async () => {
        if (ctx.provider!.poll && !room.endedAt && room.startedAt) await pollRoom(deps, ctx.config, room);
        await fetchAfterSession(deps, ctx.config, room);
      });
    }
    return c.json({ ok: true });
  });

  r.post('/api/live/sessions/:sessionId/end', async (c) => {
    const { session, ctx } = await sessionContext(c);
    assertModerator(ctx);
    const provider = ctx.provider;
    if (!ctx.ready || !provider?.endForEveryone) throw badRequest('This kind of live class can’t be ended for everyone from Coursekit.');
    const { groupId } = await readBody(c, z.object({ groupId: z.string().max(40).nullable().default(null) }));
    const rooms = (await moderatedRooms(ctx, session.id, groupId)).filter((room) => room.startedAt && !room.endedAt);
    for (const room of rooms) {
      await providerCall(() => provider.endForEveryone!(ctx.config, room));
      await db
        .updateTable('liveRooms')
        .set({ endedAt: now(), nextFollowUpAt: new Date(Date.now() + 10 * 60_000).toISOString(), updatedAt: now() })
        .where('id', '=', room.id)
        .execute();
    }
    return c.json({ ended: rooms.length });
  });

  r.post('/api/live/sessions/:sessionId/embed', async (c) => {
    const user = requireUser(c);
    const session = await loadSession(db, c.req.param('sessionId'));
    const ctx = await context(c, session.activityId);
    if (!ctx.provider?.traits(ctx.config).embeddable || !ctx.settings.embed) throw badRequest('This live class opens in a new tab.');
    const { groupId } = await readBody(c, z.object({ groupId: z.string().max(40).nullable().default(null) }));
    const outcome = await enterLiveSession(deps, user, session.id, { groupId, participant: false, origin: providerOrigin });
    if (outcome.choices) throw badRequest('Pick a group’s room first.');
    if (!('url' in outcome.result)) throw badRequest('The class hasn’t started yet.');
    return c.json({ url: outcome.result.url });
  });

  // ---- outside /api -------------------------------------------------------------------------------

  r.use('/live/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  const small = bodyLimit({ maxSize: SMALL_BODY, onError: (c) => c.json(errorJson('Request body is too large.', 'too_large'), 413) });
  const webhook = bodyLimit({ maxSize: WEBHOOK_BODY, onError: (c) => c.json(errorJson('Request body is too large.', 'too_large'), 413) });
  const analytics = bodyLimit({
    maxSize: ANALYTICS_BODY,
    onError: (c) => c.json(errorJson('Request body is too large.', 'too_large'), 413),
  });
  r.use('/live/*', (c, next) =>
    c.req.path === '/live/zoom/webhook' ? webhook(c, next) : c.req.path.endsWith('/analytics') ? analytics(c, next) : small(c, next),
  );
  r.use('/live/join/*', sessionMiddleware(deps));

  const errorPage = (c: Context, err: unknown) => {
    if (err instanceof ApiError) {
      const status = ([400, 401, 403, 404] as const).find((s) => s === err.status) ?? 400;
      return sendError(c, err.message, status, 'We couldn’t open this class');
    }
    throw err;
  };

  r.get('/live/join/:sessionId', async (c) => {
    const user = c.get('user');
    if (!user) {
      return sendPage(c, {
        title: 'Please sign in',
        status: 401,
        body: '<h1>Please sign in</h1><p>Sign in to Coursekit, then open the class again.</p><a class="button" href="/login">Sign in</a>',
      });
    }
    const url = c.req.path + (c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : '');
    // A join link opened from another site needs one click on Coursekit's own page first.
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return sendPage(c, {
        title: 'Join the class',
        body: `<h1>Join the class?</h1><p>A link from another site wants to open a live class with your Coursekit account.</p><a class="button" href="${escapeHtml(url)}">Join</a>`,
      });
    }
    const groupId = c.req.query('group') || null;
    if (groupId && groupId.length > 40) return sendError(c, 'That room doesn’t exist.', 404, 'We couldn’t open this class');
    try {
      const outcome = await enterLiveSession(deps, user, c.req.param('sessionId'), {
        groupId,
        participant: c.req.query('as') === 'participant',
        origin: providerOrigin,
      });
      if (outcome.choices) {
        const links = outcome.choices
          .map(
            (t) =>
              `<li><a href="/live/join/${escapeHtml(outcome.session.id)}?group=${encodeURIComponent(t.groupId ?? '')}">${escapeHtml(t.groupName ?? 'Whole class')}</a></li>`,
          )
          .join('');
        return sendPage(c, { title: 'Pick a room', body: `<h1>Which group’s room?</h1><ul>${links}</ul>` });
      }
      if ('url' in outcome.result) return c.redirect(outcome.result.url, 302);
      return sendPage(c, {
        title: 'Waiting for the class to start',
        body: `<div class="spinner" role="status" aria-label="Waiting"></div><h1>Waiting for your teacher</h1><p>${escapeHtml(sessionLabel(outcome.ctx.access.activity, outcome.session))} hasn’t been started yet. This page tries again every 10 seconds, so you can leave it open.</p><a class="button" href="${escapeHtml(url)}">Try again now</a>`,
        script: 'setTimeout(function(){location.reload()},10000);',
      });
    } catch (err) {
      return errorPage(c, err);
    }
  });

  /** BigBlueButton callbacks: the signed address names the room; 410 tells BigBlueButton the room is gone. */
  async function bbbTarget(c: Context, purpose: 'bbb-ended' | 'bbb-recording' | 'bbb-analytics') {
    const roomId = await verifyRoomToken(db, c.req.param('token') ?? '', purpose);
    if (!roomId) return { error: c.json(errorJson('Not found.', 'not_found'), 404) };
    const target = await loadRoomContext(db, roomId);
    if (!target || target.room.provider !== 'bbb') return { error: c.json(errorJson('This class no longer exists.', 'gone'), 410) };
    const cfg = await loadLiveConfig(db);
    if (!cfg.bbb.secret || !cfg.bbb.url) return { error: c.json(errorJson('BigBlueButton isn’t set up.', 'unavailable'), 503) };
    return { target, cfg };
  }

  // The ended address is visible to people in the meeting: check with BigBlueButton at most every 10 seconds per room.
  const endedChecks = new Map<string, number>();
  const bbbEnded = async (c: Context) => {
    const t = await bbbTarget(c, 'bbb-ended');
    if (t.error) return t.error;
    const room = t.target!.room;
    // Already known to have ended: nothing to check.
    if (room.endedAt) return c.json({ ok: true, state: 'ended' });
    const last = endedChecks.get(room.id) ?? 0;
    if (Date.now() - last < 10_000) return c.json(errorJson('Checked a moment ago. Try again shortly.', 'too_many_requests'), 429);
    if (endedChecks.size > 5000) endedChecks.clear();
    endedChecks.set(room.id, Date.now());
    try {
      return c.json({ ok: true, state: await handleBbbEnded(deps, t.cfg!, t.target!) });
    } catch (err) {
      if (err instanceof LiveProviderError) return c.json(errorJson('BigBlueButton couldn’t be reached.', 'unavailable'), 503);
      throw err;
    }
  };
  r.get('/live/bbb/:token/ended', bbbEnded);
  r.post('/live/bbb/:token/ended', bbbEnded);

  r.post('/live/bbb/:token/recording', async (c) => {
    const t = await bbbTarget(c, 'bbb-recording');
    if (t.error) return t.error;
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const signed = typeof form.signed_parameters === 'string' ? form.signed_parameters : '';
    const verified = await verifyRecordingReady(t.cfg!.bbb.secret!, signed);
    if (!verified || verified.meetingId !== t.target!.room.roomKey)
      return c.json(errorJson('The signature doesn’t match.', 'unauthorized'), 401);
    try {
      await handleBbbRecordingReady(deps, t.cfg!, t.target!);
    } catch (err) {
      if (err instanceof LiveProviderError) return c.json(errorJson('BigBlueButton couldn’t be reached.', 'unavailable'), 503);
      throw err;
    }
    return c.json({ ok: true });
  });

  r.post('/live/bbb/:token/analytics', async (c) => {
    const t = await bbbTarget(c, 'bbb-analytics');
    if (t.error) return t.error;
    if (!(await verifyAnalyticsAuth(t.cfg!.bbb.secret!, c.req.header('authorization')))) {
      return c.json(errorJson('The signature doesn’t match.', 'unauthorized'), 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json(errorJson('The body must be JSON.', 'bad_request'), 400);
    }
    const data = parseAnalytics(body);
    if (!data) return c.json(errorJson('That isn’t analytics data.', 'bad_request'), 400);
    if (data.meetingId !== t.target!.room.roomKey) return c.json(errorJson('That data is for another meeting.', 'unauthorized'), 401);
    await handleBbbAnalytics(deps, t.target!, data);
    return c.json({ ok: true });
  });

  r.post('/live/zoom/webhook', async (c) => {
    const raw = await c.req.text();
    const cfg = await loadLiveConfig(db);
    const secret = cfg.zoom.webhookSecret;
    if (!cfg.zoom.enabled || !secret) return c.json(errorJson('Zoom webhooks aren’t set up on this site.', 'not_found'), 404);
    if (!verifyZoomWebhook(secret, c.req.header('x-zm-signature'), c.req.header('x-zm-request-timestamp'), raw)) {
      return c.json(errorJson('The signature doesn’t match.', 'unauthorized'), 401);
    }
    let body: { event?: unknown; payload?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json(errorJson('The body must be JSON.', 'bad_request'), 400);
    }
    const event = typeof body.event === 'string' ? body.event : '';
    const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {};
    if (event === 'endpoint.url_validation') {
      const plainToken = typeof payload.plainToken === 'string' ? payload.plainToken : '';
      if (!plainToken || plainToken.length > 256) return c.json(errorJson('plainToken is missing.', 'bad_request'), 400);
      return c.json(zoomUrlValidation(secret, plainToken));
    }
    await handleZoomEvent(deps, event, payload);
    return c.json({ ok: true });
  });

  return r;
}
