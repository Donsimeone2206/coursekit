/**
 * Live class providers behind one interface. Each provider says what it can do (traits) and implements the steps
 * it supports: entering a room (join or start), creating meetings ahead of time, removing and ending them, what
 * happens during a session (who is in the room) and after it (recordings, the participants report).
 * To add a provider: implement LiveProvider, add its id to LiveProviderId and its settings to services/live/config.ts.
 */
import { createHash } from 'node:crypto';
import type { LiveProviderId, LiveSettings } from '../../../shared/live.js';
import type { AppDeps } from '../../context.js';
import type { ActivityRow, CourseRow, UserRow } from '../../db/schema.js';
import type { LiveRecordingRow, LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';
import { newId, now, num } from '../../lib/util.js';
import {
  bbbCreate,
  bbbDeleteRecordings,
  bbbEnd,
  bbbJoinUrl,
  bbbMeetingInfo,
  bbbPublishRecordings,
  bbbRecordings,
  bbbServer,
  bbbIsMeetingRunning,
} from './bbb.js';
import { publicBase, sameZoomHost, signRoomToken, zoomCanStart, zoomHostFor, type LiveConfig } from './config.js';
import { LiveProviderError, logProviderProblem } from './http.js';
import { isPublicJitsi, jitsiRoomUrl, jitsiToken } from './jitsi.js';
import { retireMeeting } from './rooms.js';
import {
  createZoomMeeting,
  deleteZoomMeeting,
  endZoomMeeting,
  trashZoomRecording,
  updateZoomMeeting,
  zoomAccount,
  zoomCheck,
  zoomJoinUrl,
  zoomParticipants,
  zoomPastInstances,
  zoomRecordings,
  zoomStartUrl,
  type ZoomAccount,
  type ZoomMeetingPayload,
} from './zoom.js';

export type LiveDeps = Pick<AppDeps, 'db' | 'events' | 'config' | 'version'>;

export interface ProviderTraits {
  /** Recordings come from the provider. */
  recordings: boolean;
  waitForModerator: boolean;
  /** One room per group in a live class with groups. */
  groupRooms: boolean;
  endForEveryone: boolean;
  /** Can be shown inside the activity page. */
  embeddable: boolean;
  /** Meetings exist at the provider ahead of time and follow session changes (Zoom). */
  meetingsAhead: boolean;
  /** Reports who is in a running room (BigBlueButton). */
  liveAttendance: boolean;
  /** Supplies a participants report after a meeting (Zoom without webhooks). */
  report: boolean;
}

export interface RoomContext {
  deps: LiveDeps;
  config: LiveConfig;
  activity: ActivityRow;
  course: CourseRow;
  session: LiveSessionRow;
  settings: LiveSettings;
  room: LiveRoomRow;
  groupName: string | null;
  /**
   * The site's public URL, for links back to Coursekit that a provider keeps (BigBlueButton's logout URL). Never the
   * address of a request: its Host header is whatever the client sent. Null without a public URL.
   */
  origin: string | null;
}

export interface EnterContext extends RoomContext {
  user: UserRow;
  /** Enters with moderator rights (staff). */
  moderator: boolean;
  /** Staff asked to start the meeting as its host (Zoom's start link) rather than join as a participant. */
  start: boolean;
}

/** Where to send the person, or "wait": students wait until a moderator has started the class. */
export type EnterResult = { url: string } | { waiting: true };

export interface ProviderPresence {
  key: string;
  userId: string | null;
  email: string | null;
  name: string;
  role: 'moderator' | 'viewer' | null;
  joinedAt: string;
  leftAt: string | null;
}

export interface ProviderRecording {
  externalId: string;
  title: string;
  url: string;
  passcode: string | null;
  durationMinutes: number | null;
  recordedAt: string | null;
  /** BigBlueButton: unpublished recordings come back hidden. */
  published: boolean;
}

export interface PollResult {
  running: boolean;
  /** The meeting is over (or gone), as opposed to created and not started yet. */
  ended: boolean;
  runId: string | null;
  attendees: Array<{ userId: string | null; name: string; role: 'moderator' | 'viewer' }>;
}

export interface LiveProvider {
  id: LiveProviderId;
  traits(config: LiveConfig): ProviderTraits;
  enter(ctx: EnterContext): Promise<EnterResult>;
  /** Creates or updates the provider's meeting for a room (providers with meetingsAhead). True when it called the provider. */
  sync?(ctx: RoomContext): Promise<boolean>;
  /** Removes a room at the provider: deletes a meeting, or ends one that is running. */
  remove?(config: LiveConfig, room: LiveRoomRow): Promise<void>;
  endForEveryone?(config: LiveConfig, room: LiveRoomRow): Promise<void>;
  poll?(config: LiveConfig, room: LiveRoomRow): Promise<PollResult>;
  recordings?(config: LiveConfig, room: LiveRoomRow): Promise<ProviderRecording[]>;
  report?(config: LiveConfig, room: LiveRoomRow): Promise<ProviderPresence[]>;
  publishRecording?(config: LiveConfig, recording: LiveRecordingRow, published: boolean): Promise<void>;
  deleteRecording?(config: LiveConfig, recording: LiveRecordingRow): Promise<void>;
  /** Administration → Live classes → Test: checks the settings with a harmless call. */
  test?(config: LiveConfig): Promise<string>;
}

// ---- shared helpers -----------------------------------------------------------------------------------

export function activityLink(origin: string | null, course: Pick<CourseRow, 'slug'>, activityId: string): string | null {
  return origin ? `${origin}/courses/${course.slug}/activities/${activityId}` : null;
}

export function meetingName(
  activity: Pick<ActivityRow, 'title'>,
  session: Pick<LiveSessionRow, 'title'>,
  groupName: string | null,
): string {
  return `${activity.title}${session.title ? `: ${session.title}` : ''}${groupName ? ` (${groupName})` : ''}`.slice(0, 200);
}

/** Leases a room for one process: two servers never create two meetings for it. */
export async function claimRoom(db: DB, roomId: string, seconds = 120): Promise<string | null> {
  const claim = newId();
  const t = now();
  const result = await db
    .updateTable('liveRooms')
    .set({ claimId: claim, claimedUntil: new Date(Date.now() + seconds * 1000).toISOString() })
    .where('id', '=', roomId)
    .where((eb) => eb.or([eb('claimedUntil', 'is', null), eb('claimedUntil', '<', t)]))
    .executeTakeFirst();
  return num(result.numUpdatedRows) === 1 ? claim : null;
}

export async function releaseRoom(db: DB, roomId: string, claim: string, values: Partial<LiveRoomRow> = {}): Promise<void> {
  await db
    .updateTable('liveRooms')
    .set({ ...values, claimId: null, claimedUntil: null, updatedAt: now() })
    .where('id', '=', roomId)
    .where('claimId', '=', claim)
    .execute();
}

async function reload(db: DB, roomId: string): Promise<LiveRoomRow | undefined> {
  return db.selectFrom('liveRooms').selectAll().where('id', '=', roomId).executeTakeFirst();
}

// ---- BigBlueButton ------------------------------------------------------------------------------------

const bbb: LiveProvider = {
  id: 'bbb',
  traits: () => ({
    recordings: true,
    waitForModerator: true,
    groupRooms: true,
    endForEveryone: true,
    embeddable: false,
    meetingsAhead: false,
    liveAttendance: true,
    report: false,
  }),

  async enter(ctx) {
    const server = bbbServer(ctx.config.bbb);
    const { room, deps } = ctx;
    const join = (createTime: string | null) =>
      bbbJoinUrl(server, {
        meetingID: room.roomKey,
        fullName: ctx.user.name,
        userID: ctx.user.id,
        moderator: ctx.moderator,
        createTime,
      });

    if (!ctx.moderator && ctx.settings.waitForModerator) {
      // Only moderators create the meeting; viewers join once it is running.
      const info = await bbbMeetingInfo(server, room.roomKey);
      if (!info?.running) return { waiting: true };
      await deps.db.updateTable('liveRooms').set({ runId: info.createTime, updatedAt: now() }).where('id', '=', room.id).execute();
      return { url: join(info.createTime) };
    }

    const base = publicBase(deps.config.publicUrl);
    // Callbacks need an address BigBlueButton can reach: the public URL. Each is signed for this room and purpose.
    const callback = async (purpose: 'bbb-ended' | 'bbb-recording' | 'bbb-analytics', path: string) =>
      base ? `${base}/live/bbb/${await signRoomToken(deps.db, room.id, purpose)}/${path}` : null;
    const record = ctx.settings.recording !== 'off';
    const run = await bbbCreate(server, {
      meetingID: room.roomKey,
      name: meetingName(ctx.activity, ctx.session, ctx.groupName),
      welcome: (ctx.settings.welcomeMessage || `Welcome to ${ctx.activity.title}!`).slice(0, 2000),
      // Everyone leaving the meeting goes here, so only the public URL (left out without one).
      logoutURL: activityLink(ctx.origin, ctx.course, ctx.activity.id) ?? undefined,
      record,
      autoStartRecording: record && ctx.settings.recording === 'auto',
      allowStartStopRecording: record,
      endedUrl: await callback('bbb-ended', 'ended'),
      recordingReadyUrl: await callback('bbb-recording', 'recording'),
      // An administrator can turn it off: BigBlueButton keeps the meeting's events on its server for it.
      analyticsUrl: ctx.config.bbb.analytics ? await callback('bbb-analytics', 'analytics') : null,
      meta: { 'bbb-origin': 'Coursekit', 'bbb-origin-version': deps.version, 'bbb-context': ctx.course.title.slice(0, 200) },
    });
    await deps.db
      .updateTable('liveRooms')
      .set({ runId: run.createTime || null, endedAt: null, updatedAt: now() })
      .where('id', '=', room.id)
      .execute();
    return { url: join(run.createTime || null) };
  },

  async remove(config, room) {
    if (!room.startedAt || room.endedAt || !config.bbb.url || !config.bbb.secret) return;
    await bbbEnd(bbbServer(config.bbb), room.roomKey);
  },

  async endForEveryone(config, room) {
    await bbbEnd(bbbServer(config.bbb), room.roomKey);
  },

  async poll(config, room) {
    const info = await bbbMeetingInfo(bbbServer(config.bbb), room.roomKey);
    if (!info) return { running: false, ended: true, runId: null, attendees: [] };
    return {
      running: info.running,
      ended: !info.running && !!info.endTime,
      runId: info.createTime || null,
      attendees: info.attendees.map((a) => ({ userId: a.userId || null, name: a.fullName, role: a.role })),
    };
  },

  async recordings(config, room) {
    const list = await bbbRecordings(bbbServer(config.bbb), [room.roomKey]);
    return list
      .filter((r) => r.url && r.meetingId === room.roomKey)
      .map((r) => ({
        externalId: r.recordId,
        title: r.name || 'Recording',
        url: r.url!,
        passcode: null,
        durationMinutes: r.lengthMinutes,
        recordedAt: r.startTime ? new Date(r.startTime).toISOString() : null,
        published: r.published,
      }));
  },

  async publishRecording(config, recording, published) {
    if (recording.externalId) await bbbPublishRecordings(bbbServer(config.bbb), [recording.externalId], published);
  },

  async deleteRecording(config, recording) {
    if (recording.externalId) await bbbDeleteRecordings(bbbServer(config.bbb), [recording.externalId]);
  },

  async test(config) {
    // A random meeting id: the answer proves the address, the secret and the algorithm without touching a real class.
    await bbbIsMeetingRunning(bbbServer(config.bbb), `coursekit-test-${newId(12)}`);
    return 'Connected to BigBlueButton. The shared secret and checksum algorithm work.';
  },
};

// ---- Zoom ---------------------------------------------------------------------------------------------

/** The Zoom user who hosts the room's meeting: the group's own host, the class's, or the site's default host. */
function zoomHost(ctx: Pick<RoomContext, 'config' | 'settings' | 'room'>): string {
  const host = zoomHostFor(ctx.config.zoom, ctx.settings, ctx.room.groupKey);
  if (!host)
    throw new LiveProviderError(
      'zoom',
      'No Zoom host is set. An administrator can add a default host under Administration → Live classes.',
      'config',
    );
  return host;
}

export function zoomPayload(ctx: Pick<RoomContext, 'activity' | 'session' | 'settings' | 'groupName'>): ZoomMeetingPayload {
  const { session, settings } = ctx;
  return {
    topic: meetingName(ctx.activity, session, ctx.groupName),
    type: 2,
    start_time: new Date(session.startsAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: session.durationMinutes,
    timezone: session.timeZone || 'UTC',
    agenda: session.agenda.slice(0, 2000),
    settings: {
      join_before_host: !settings.waitForModerator,
      jbh_time: 0,
      waiting_room: false,
      auto_recording: settings.recording === 'auto' ? 'cloud' : 'none',
      mute_upon_entry: true,
      approval_type: 2,
    },
  };
}

const syncHash = (payload: ZoomMeetingPayload, host: string) =>
  createHash('sha256').update(JSON.stringify({ payload, host })).digest('hex');

const isGone = (err: unknown) => err instanceof LiveProviderError && err.kind === 'not_found';

/**
 * Creates the room's Zoom meeting if it has none, or updates it when the session changed. True when Zoom was called.
 * A meeting deleted in Zoom (a host tidying their meetings) is replaced by a new one.
 */
async function zoomSync(ctx: RoomContext): Promise<boolean> {
  const { db } = ctx.deps;
  const account = zoomAccount(ctx.config.zoom);
  const host = zoomHost(ctx);
  const payload = zoomPayload(ctx);
  const hash = syncHash(payload, host);
  const room = ctx.room;
  if (room.externalId && room.syncedHash === hash) return false;
  const claim = await claimRoom(db, room.id);
  if (!claim) return false;
  try {
    const fresh = (await reload(db, room.id)) ?? room;
    if (fresh.externalId && fresh.syncedHash === hash) {
      await releaseRoom(db, room.id, claim);
      return false;
    }
    const synced = { syncedHash: hash, syncError: null, syncAttempts: 0, nextSyncAt: null };
    let replaced: { externalId: string; host: string | null } | null = null;
    if (fresh.externalId && (!fresh.host || sameZoomHost(fresh.host, host))) {
      try {
        await updateZoomMeeting(account, fresh.externalId, payload);
        await releaseRoom(db, room.id, claim, synced);
        return true;
      } catch (err) {
        if (!isGone(err)) throw err;
        // Deleted in Zoom: forget it now (nobody is sent to it any more) and create a new one below.
        await forgetZoomMeeting(db, room.id, fresh.externalId);
      }
    } else if (fresh.externalId) {
      // The meeting already took place: keep it rather than replace it under people's feet.
      if (fresh.startedAt) {
        await releaseRoom(db, room.id, claim, { syncedHash: hash });
        return false;
      }
      // Another host: Zoom meetings can't move between users, so the meeting is replaced (the join link changes, which
      // is fine because people join through Coursekit). The new one first: if Zoom refuses it, the old one still works.
      replaced = { externalId: fresh.externalId, host: fresh.host };
    }
    const created = await createZoomMeeting(account, host, payload);
    await releaseRoom(db, room.id, claim, { externalId: created.id, joinUrl: created.joinUrl, host, ...synced });
    if (replaced) {
      try {
        await deleteZoomMeeting(account, replaced.externalId);
      } catch (err) {
        // Deleted later by the background worker, which retries.
        logProviderProblem('removing a replaced Zoom meeting', err);
        await retireMeeting(db, fresh, replaced.externalId, replaced.host);
      }
    }
    return true;
  } catch (err) {
    const message = err instanceof LiveProviderError ? err.message : 'Zoom couldn’t set up the meeting.';
    const attempts = room.syncAttempts + 1;
    await releaseRoom(db, room.id, claim, {
      syncError: message,
      syncAttempts: attempts,
      nextSyncAt: new Date(Date.now() + Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8))).toISOString(),
    });
    throw err;
  }
}

/** Forgets a meeting Zoom no longer has, unless another process already replaced it. */
async function forgetZoomMeeting(db: DB, roomId: string, externalId: string): Promise<void> {
  await db
    .updateTable('liveRooms')
    .set({ externalId: null, joinUrl: null, host: null, syncedHash: null, updatedAt: now() })
    .where('id', '=', roomId)
    .where('externalId', '=', externalId)
    .execute();
}

/**
 * The room's meeting, created now if the worker hasn't yet, or replaced first when the room's host changed (so nobody
 * is sent to a meeting that is about to be deleted). Waits briefly when another process is working on it.
 */
async function zoomMeetingFor(ctx: RoomContext): Promise<LiveRoomRow> {
  const host = zoomHost(ctx);
  const roomId = ctx.room.id;
  // A meeting for another host stays only once it took place (zoomSync keeps those).
  const current = (r: LiveRoomRow) => !!r.externalId && !!r.joinUrl && (!r.host || sameZoomHost(r.host, host) || !!r.startedAt);
  if (current(ctx.room)) return ctx.room;
  // Zoom refused the new host's meeting a moment ago: the old one is used until the background retry, rather than
  // asking Zoom again for everyone who joins.
  const { room } = ctx;
  if (room.externalId && room.joinUrl && room.syncError && room.nextSyncAt && Date.parse(room.nextSyncAt) > Date.now()) return room;
  try {
    await zoomSync(ctx);
  } catch (err) {
    // Zoom refused the new host's meeting: the old meeting still works until someone fixes the host.
    const fresh = await reload(ctx.deps.db, roomId);
    if (fresh?.externalId && fresh.joinUrl) return fresh;
    throw err;
  }
  for (let i = 0; i < 10; i++) {
    const fresh = await reload(ctx.deps.db, roomId);
    if (fresh && current(fresh)) return fresh;
    if (!fresh?.claimId) {
      if (fresh?.externalId && fresh.joinUrl) return fresh;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new LiveProviderError('zoom', 'The Zoom meeting for this session isn’t ready yet. Try again in a moment.', 'unreachable');
}

/** A meeting Zoom says it doesn't have any more: forgotten, and a new one created in its place. */
async function replaceGoneZoomMeeting(ctx: RoomContext, room: LiveRoomRow): Promise<LiveRoomRow> {
  await forgetZoomMeeting(ctx.deps.db, room.id, room.externalId!);
  const fresh = (await reload(ctx.deps.db, room.id)) ?? room;
  return zoomMeetingFor({ ...ctx, room: fresh });
}

/**
 * Meetings Coursekit checked Zoom still has in the last minute (per process), before sending people to their link: the
 * join link Zoom has now. People joining at the same moment share one check.
 */
const checkedMeetings = new Map<string, { at: number; joinUrl: Promise<string> }>();
const CHECK_MEETING_MS = 60_000;

function checkZoomMeeting(account: ZoomAccount, room: LiveRoomRow): Promise<string> {
  const key = `${room.id}:${room.externalId}`;
  let entry = checkedMeetings.get(key);
  if (!entry || Date.now() - entry.at > CHECK_MEETING_MS) {
    if (checkedMeetings.size > 5000) checkedMeetings.clear();
    entry = { at: Date.now(), joinUrl: zoomJoinUrl(account, room.externalId!) };
    checkedMeetings.set(key, entry);
    // A failed check isn't kept: the next person to join checks again.
    entry.joinUrl.catch(() => checkedMeetings.delete(key));
  }
  return entry.joinUrl;
}

const zoom: LiveProvider = {
  id: 'zoom',
  traits: (config) => ({
    recordings: true,
    waitForModerator: true,
    groupRooms: true,
    endForEveryone: true,
    embeddable: false,
    meetingsAhead: true,
    liveAttendance: false,
    report: !config.zoom.webhookSecret,
  }),

  async enter(ctx) {
    const account = zoomAccount(ctx.config.zoom);
    let room = await zoomMeetingFor(ctx);
    for (let attempt = 0; ; attempt++) {
      // A start link starts the meeting as its host, with that Zoom user's access key: only for a host an
      // administrator shared, or for the host themselves. Other staff join as participants.
      const asHost = ctx.moderator && ctx.start && zoomCanStart(ctx.config.zoom, room.host || zoomHost(ctx), ctx.user.email);
      try {
        if (asHost) return { url: await zoomStartUrl(account, room.externalId!) };
        const joinUrl = await checkZoomMeeting(account, room);
        if (joinUrl !== room.joinUrl) {
          // Changed in Zoom (a new passcode, say). Only for this meeting, in case another process just replaced it.
          await ctx.deps.db
            .updateTable('liveRooms')
            .set({ joinUrl, updatedAt: now() })
            .where('id', '=', room.id)
            .where('externalId', '=', room.externalId!)
            .execute();
          room = { ...room, joinUrl };
        }
        break;
      } catch (err) {
        if (isGone(err) && attempt === 0) {
          room = await replaceGoneZoomMeeting(ctx, room);
          continue;
        }
        // Zoom is slow or limiting requests: the link Coursekit has still lets people in.
        if (!asHost && !isGone(err)) {
          logProviderProblem('checking a Zoom meeting', err);
          break;
        }
        throw err;
      }
    }
    // The web client fills in the name from `uname`, which also helps match the participants report.
    const url = new URL(room.joinUrl!);
    url.searchParams.set('uname', ctx.user.name.slice(0, 100));
    return { url: url.toString() };
  },

  sync: zoomSync,

  async remove(config, room) {
    if (room.externalId) await deleteZoomMeeting(zoomAccount(config.zoom), room.externalId);
  },

  async endForEveryone(config, room) {
    if (room.externalId) await endZoomMeeting(zoomAccount(config.zoom), room.externalId);
  },

  async recordings(config, room) {
    if (!room.externalId) return [];
    const account = zoomAccount(config.zoom);
    const instances = await zoomPastInstances(account, room.externalId).catch(() => [] as string[]);
    const seen = new Map<string, ProviderRecording>();
    for (const id of instances.length ? instances : [room.externalId]) {
      for (const r of await zoomRecordings(account, id)) {
        seen.set(r.uuid, {
          externalId: r.uuid,
          title: r.title,
          url: r.url,
          passcode: r.passcode,
          durationMinutes: r.durationMinutes,
          recordedAt: r.startTime,
          published: true,
        });
      }
    }
    return [...seen.values()];
  },

  async report(config, room) {
    if (!room.externalId) return [];
    const account = zoomAccount(config.zoom);
    const instances = await zoomPastInstances(account, room.externalId);
    const out: ProviderPresence[] = [];
    for (const uuid of instances) {
      for (const p of await zoomParticipants(account, uuid)) {
        out.push({ key: p.key, userId: null, email: p.email, name: p.name, role: null, joinedAt: p.joinedAt, leftAt: p.leftAt });
      }
    }
    return out;
  },

  async deleteRecording(config, recording) {
    if (recording.externalId) await trashZoomRecording(zoomAccount(config.zoom), recording.externalId);
  },

  async test(config) {
    return zoomCheck(zoomAccount(config.zoom), config.zoom.defaultHost);
  },
};

// ---- Jitsi Meet ---------------------------------------------------------------------------------------

const jitsi: LiveProvider = {
  id: 'jitsi',
  traits: (config) => ({
    recordings: false,
    waitForModerator: false,
    groupRooms: true,
    endForEveryone: false,
    embeddable: !isPublicJitsi(config.jitsi),
    meetingsAhead: false,
    liveAttendance: false,
    report: false,
  }),

  async enter(ctx) {
    const { jitsi: c } = ctx.config;
    let jwt: string | null = null;
    if (c.appId && c.appSecret) {
      // Valid for the session (plus an hour for reconnecting), at most a day.
      const until = Math.min(Date.parse(ctx.session.endsAt) + 3600_000, Date.now() + 86_400_000);
      jwt = await jitsiToken({
        appId: c.appId,
        appSecret: c.appSecret,
        serverUrl: c.url,
        room: ctx.room.roomKey,
        user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, avatar: ctx.user.avatarUrl },
        moderator: ctx.moderator,
        expiresAt: Math.floor(Math.max(until, Date.now() + 600_000) / 1000),
      });
    }
    return {
      url: jitsiRoomUrl(c.url, ctx.room.roomKey, {
        jwt,
        displayName: ctx.user.name,
        subject: meetingName(ctx.activity, ctx.session, ctx.groupName),
      }),
    };
  },
};

// ---- Meeting link -------------------------------------------------------------------------------------

const link: LiveProvider = {
  id: 'link',
  traits: () => ({
    recordings: false,
    waitForModerator: false,
    groupRooms: false,
    endForEveryone: false,
    embeddable: false,
    meetingsAhead: false,
    liveAttendance: false,
    report: false,
  }),

  async enter(ctx) {
    const url = ctx.session.meetingUrl || ctx.settings.meetingUrl;
    if (!url) {
      throw ctx.moderator
        ? badRequest('Add the meeting link for this session first: choose Edit on the session, or set a link for the whole class.')
        : badRequest('This session has no meeting link yet. Please let your teacher know.');
    }
    return { url };
  },
};

export const LIVE_PROVIDERS: Record<LiveProviderId, LiveProvider> = { bbb, zoom, jitsi, link };

export function liveProvider(id: LiveProviderId | null | undefined): LiveProvider | null {
  return id ? (LIVE_PROVIDERS[id] ?? null) : null;
}
