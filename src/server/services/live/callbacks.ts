/**
 * What providers tell Coursekit after the fact: BigBlueButton's meeting-ended, recording-ready and analytics
 * callbacks, and Zoom's webhooks. Nothing unauthenticated is trusted: callback addresses are signed per room, the
 * recording and analytics callbacks also carry a JWT signed with the BigBlueButton secret, "meeting ended" is checked
 * with BigBlueButton itself, and Zoom webhooks are signed. Handling is idempotent, so repeated deliveries change
 * nothing.
 */
import type { ActivityRow } from '../../db/schema.js';
import type { LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { now } from '../../lib/util.js';
import { courseMembers, evaluateLiveCompletion, matchMember, recordPresence, type PresenceInput } from './attendance.js';
import { bbbIsMeetingRunning, bbbServer, type BbbAnalytics } from './bbb.js';
import type { LiveConfig } from './config.js';
import { LIVE_PROVIDERS, type LiveDeps } from './providers.js';
import { saveProviderRecordings } from './recordings.js';
import { toZoomRecording } from './zoom.js';

export interface RoomWithSession {
  room: LiveRoomRow;
  session: LiveSessionRow;
  activity: ActivityRow;
}

export async function loadRoomContext(db: DB, roomId: string): Promise<RoomWithSession | null> {
  const room = await db.selectFrom('liveRooms').selectAll().where('id', '=', roomId).executeTakeFirst();
  if (!room?.sessionId) return null;
  const session = await db.selectFrom('liveSessions').selectAll().where('id', '=', room.sessionId).executeTakeFirst();
  if (!session) return null;
  const activity = await db.selectFrom('activities').selectAll().where('id', '=', session.activityId).executeTakeFirst();
  return activity ? { room, session, activity } : null;
}

/** After a meeting ends: follow up soon for recordings and reports. */
function followUpSoon(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

/** BigBlueButton says the meeting ended. The address is visible to people in the meeting, so ask BigBlueButton first. */
export async function handleBbbEnded(deps: LiveDeps, config: LiveConfig, target: RoomWithSession): Promise<'ended' | 'running'> {
  const { room } = target;
  if (await bbbIsMeetingRunning(bbbServer(config.bbb), room.roomKey)) return 'running';
  if (!room.endedAt) {
    await deps.db
      .updateTable('liveRooms')
      .set({ endedAt: now(), nextFollowUpAt: room.followUpCount === 0 ? followUpSoon() : room.nextFollowUpAt, updatedAt: now() })
      .where('id', '=', room.id)
      .execute();
  }
  return 'ended';
}

/** A recording is ready: read it from BigBlueButton (nothing in the callback is taken as fact beyond the ids). */
export async function handleBbbRecordingReady(deps: LiveDeps, config: LiveConfig, target: RoomWithSession): Promise<void> {
  const recordings = await LIVE_PROVIDERS.bbb.recordings!(config, target.room);
  await saveProviderRecordings(deps.db, target.session, target.room, 'bbb', recordings);
}

/** The analytics callback: exact join and leave times. They replace what polling the running meeting estimated. */
export async function handleBbbAnalytics(deps: LiveDeps, target: RoomWithSession, data: BbbAnalytics): Promise<void> {
  const { db } = deps;
  const { room, session } = target;
  const members = await courseMembers(db, session.courseId);
  const entries: PresenceInput[] = [];
  for (const a of data.attendees) {
    const userId = matchMember(members, { userId: a.extUserId, name: a.extUserId ? null : a.name });
    for (const i of a.intervals) {
      entries.push({
        key: `${data.internalMeetingId || room.roomKey}:${a.extUserId ?? a.name}:${i.joinedAt}`,
        userId,
        name: a.name,
        role: a.moderator ? 'moderator' : 'viewer',
        joinedAt: new Date(i.joinedAt).toISOString(),
        leftAt: new Date(i.leftAt).toISOString(),
      });
    }
  }
  let from = data.start ?? Date.now();
  if (data.start == null) for (const e of entries) from = Math.min(from, Date.parse(e.joinedAt));
  const to = data.finish ?? Date.now();
  await db
    .deleteFrom('livePresence')
    .where('sessionId', '=', session.id)
    .where('roomId', '=', room.id)
    .where('source', '=', 'bbb')
    .where('joinedAt', '>=', new Date(from - 15 * 60_000).toISOString())
    .where('joinedAt', '<=', new Date(to + 60_000).toISOString())
    .execute();
  await recordPresence(db, session, room, 'bbb-analytics', entries);
  if (!room.endedAt) {
    await db
      .updateTable('liveRooms')
      .set({
        endedAt: data.finish ? new Date(data.finish).toISOString() : now(),
        nextFollowUpAt: room.nextFollowUpAt ?? followUpSoon(),
        updatedAt: now(),
      })
      .where('id', '=', room.id)
      .execute();
  }
  const users = [...new Set(entries.map((e) => e.userId).filter((u): u is string => !!u))];
  await evaluateLiveCompletion(deps, target.activity, users);
}

const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Handles one verified Zoom webhook event. Events for meetings Coursekit didn't create are ignored. */
export async function handleZoomEvent(deps: LiveDeps, event: string, payload: Record<string, unknown>): Promise<void> {
  const { db } = deps;
  const object = (payload.object ?? {}) as Record<string, unknown>;
  const meetingId = typeof object.id === 'number' || typeof object.id === 'string' ? String(object.id) : null;
  if (!meetingId) return;
  const room = await db
    .selectFrom('liveRooms')
    .selectAll()
    .where('provider', '=', 'zoom')
    .where('externalId', '=', meetingId)
    .where('sessionId', 'is not', null)
    .executeTakeFirst();
  if (!room) return;
  const target = await loadRoomContext(db, room.id);
  if (!target) return;
  const { session, activity } = target;
  const instance = typeof object.uuid === 'string' ? object.uuid : meetingId;

  if (event === 'meeting.started') {
    if (!room.startedAt)
      await db
        .updateTable('liveRooms')
        .set({ startedAt: iso(object.start_time) ?? now(), updatedAt: now() })
        .where('id', '=', room.id)
        .execute();
    return;
  }

  if (event === 'meeting.participant_joined' || event === 'meeting.participant_left') {
    const p = (object.participant ?? {}) as Record<string, unknown>;
    const who = [p.participant_uuid, p.user_id, p.id, p.user_name].find((v) => (typeof v === 'string' && v) || typeof v === 'number');
    if (who === undefined) return;
    const prefix = `${instance}:${String(who)}:`;
    const name = typeof p.user_name === 'string' ? p.user_name : null;
    const email = typeof p.email === 'string' ? p.email : null;
    const members = await courseMembers(db, session.courseId);
    const userId = matchMember(members, { email, name });
    if (event === 'meeting.participant_joined') {
      const joinedAt = iso(p.join_time) ?? now();
      await recordPresence(db, session, room, 'zoom', [{ key: `${prefix}${joinedAt}`, userId, name, role: null, joinedAt, leftAt: null }]);
      if (!room.startedAt)
        await db.updateTable('liveRooms').set({ startedAt: joinedAt, updatedAt: now() }).where('id', '=', room.id).execute();
    } else {
      const leftAt = iso(p.leave_time) ?? now();
      const stays = (
        await db
          .selectFrom('livePresence')
          .select(['id', 'sourceKey', 'joinedAt', 'leftAt'])
          .where('sessionId', '=', session.id)
          .where('source', '=', 'zoom')
          .where('joinedAt', '<=', leftAt)
          .orderBy('joinedAt', 'desc')
          .execute()
      ).filter((row) => row.sourceKey.startsWith(prefix));
      // The same event delivered again: already recorded.
      if (stays.some((row) => row.leftAt === leftAt)) return;
      const open = stays.find((row) => !row.leftAt);
      if (open)
        await db
          .updateTable('livePresence')
          .set({ leftAt, updatedAt: now() })
          .where('id', '=', open.id)
          .where('leftAt', 'is', null)
          .execute();
      else {
        // The join wasn't delivered (or came before Coursekit knew the meeting): keep what is known.
        await recordPresence(db, session, room, 'zoom', [
          { key: `${prefix}left:${leftAt}`, userId, name, role: null, joinedAt: leftAt, leftAt },
        ]);
      }
    }
    if (userId) await evaluateLiveCompletion(deps, activity, [userId]);
    return;
  }

  if (event === 'meeting.ended') {
    const endedAt = iso(object.end_time) ?? now();
    await db
      .updateTable('livePresence')
      .set({ leftAt: endedAt, updatedAt: now() })
      .where('sessionId', '=', session.id)
      .where('roomId', '=', room.id)
      .where('source', '=', 'zoom')
      .where('leftAt', 'is', null)
      .execute();
    await db
      .updateTable('liveRooms')
      .set({ endedAt, nextFollowUpAt: room.followUpCount === 0 ? followUpSoon() : room.nextFollowUpAt, updatedAt: now() })
      .where('id', '=', room.id)
      .execute();
    return;
  }

  if (event === 'recording.completed') {
    const rec = toZoomRecording(object);
    if (rec) {
      await saveProviderRecordings(db, session, room, 'zoom', [
        {
          externalId: rec.uuid,
          title: rec.title,
          url: rec.url,
          passcode: rec.passcode,
          durationMinutes: rec.durationMinutes,
          recordedAt: rec.startTime,
          published: true,
        },
      ]);
    }
  }
}
