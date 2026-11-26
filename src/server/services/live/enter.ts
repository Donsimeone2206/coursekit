/**
 * Joining (or, for staff, starting) a session: access through loadActivityAccess, the join window, the right room for
 * the person's group, the provider's address, and Coursekit's join log. Students never get moderator rights or a
 * Zoom start link, and only ever enter their own groups' rooms.
 */
import { liveSessionState } from '../../../shared/live.js';
import type { UserRow } from '../../db/schema.js';
import type { LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import { badRequest, forbidden, notFound } from '../../lib/http.js';
import { now } from '../../lib/util.js';
import { assertWritable } from '../access.js';
import { evaluateLiveCompletion, logJoin } from './attendance.js';
import { LiveProviderError } from './http.js';
import type { EnterResult, LiveDeps } from './providers.js';
import { ensureRoom, roomTargets, type RoomTarget } from './rooms.js';
import { loadLiveContext, loadSession, type LiveContext } from './view.js';

export interface EnterOptions {
  groupId: string | null;
  /** Staff: join as a participant instead of starting as the host. */
  participant: boolean;
  /** The site's public URL, for links back that the provider keeps (logout URL); null without one. Never the request's Host. */
  origin: string | null;
}

export interface EnterOutcome {
  result: EnterResult;
  ctx: LiveContext;
  session: LiveSessionRow;
  room: LiveRoomRow | null;
  /** Several rooms could be meant: the viewer has to pick one. */
  choices: RoomTarget[] | null;
}

export async function enterLiveSession(deps: LiveDeps, user: UserRow, sessionId: string, options: EnterOptions): Promise<EnterOutcome> {
  const { db } = deps;
  const session = await loadSession(db, sessionId);
  const ctx = await loadLiveContext(db, user, session.activityId, deps.config.publicUrl);
  const { access, settings, provider } = ctx;
  // Archived courses are read-only: nothing to join (and no attendance to record) except for course managers.
  assertWritable(access);
  if (!provider || !ctx.ready) throw badRequest(ctx.problem ?? 'This live class can’t be joined right now.');
  if (session.status === 'cancelled') throw badRequest('This session was cancelled.');
  const state = liveSessionState(session, settings.joinMinutesBefore, Date.now());
  if (!ctx.moderator) {
    if (state === 'ended') throw badRequest('This session has ended.');
    if (state === 'upcoming') {
      throw badRequest(
        settings.joinMinutesBefore > 0
          ? `This session opens ${settings.joinMinutesBefore} minutes before it starts.`
          : 'This session opens when it starts.',
      );
    }
  }

  const targets = await roomTargets(db, access, provider, ctx.config);
  const joinable = targets.targets.filter((t) => t.joinable);
  let target: RoomTarget | undefined;
  if (options.groupId) {
    target = targets.targets.find((t) => t.groupId === options.groupId);
    // Someone else's group (or one the viewer can't even see) is refused the same way: no room here.
    if (!target) throw notFound('Room');
    if (!target.joinable) throw forbidden('You can only join your own group’s room.');
  } else if (!targets.grouped) {
    target = targets.targets[0];
  } else if (joinable.length === 1) {
    target = joinable[0];
  } else if (joinable.length === 0) {
    throw forbidden(targets.note ?? 'There is no room for you to join in this session.');
  } else {
    return { result: { waiting: true }, ctx, session, room: null, choices: joinable };
  }
  if (!target) throw notFound('Room');

  const room = await ensureRoom(db, session, provider.id, target.groupId);
  const moderator = ctx.moderator;
  let result: EnterResult;
  try {
    result = await provider.enter({
      deps,
      config: ctx.config,
      activity: access.activity,
      course: access.course,
      session,
      settings,
      room,
      groupName: target.groupName,
      origin: options.origin,
      user,
      moderator,
      start: moderator && !options.participant,
    });
  } catch (err) {
    if (err instanceof LiveProviderError) {
      // Staff get the provider's reason; learners a plain message (the reason is for whoever can fix it).
      throw badRequest(
        moderator ? err.message : 'The live class couldn’t be opened right now. Please try again in a moment, or let your teacher know.',
      );
    }
    throw err;
  }
  if ('url' in result) {
    await logJoin(db, session, room, user, moderator ? 'moderator' : 'viewer');
    if (!room.startedAt)
      await db
        .updateTable('liveRooms')
        .set({ startedAt: now(), updatedAt: now() })
        .where('id', '=', room.id)
        .where('startedAt', 'is', null)
        .execute();
    if (access.role === 'student') await evaluateLiveCompletion(deps, access.activity, [user.id]);
  }
  return { result, ctx, session, room, choices: null };
}
