/**
 * Scheduling live class sessions: one at a time or as a daily or weekly repeat that keeps the same local time in the
 * teacher's time zone, editing, cancelling and deleting them, and telling the learners who can see the class.
 */
import { z } from 'zod';
import { LIVE_LIMITS } from '../../../shared/live.js';
import type { ActivityRow, CourseRow } from '../../db/schema.js';
import type { LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';
import { isoDateSchema } from '../../lib/schemas.js';
import { newId, now, num } from '../../lib/util.js';
import { parseSettings } from '../activity-types.js';
import { audienceOf } from '../group-modes.js';
import { courseMemberIds, notify } from '../notify.js';
import { evaluateLiveCompletion } from './attendance.js';
import { httpsUrlSchema } from './config.js';
import type { LiveDeps } from './providers.js';
import { retireRooms } from './rooms.js';
import { formatInZone, isValidTimeZone, repeatStarts } from './time.js';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const timeZoneSchema = z.string().trim().max(64).refine(isValidTimeZone, 'Unknown time zone');
const durationSchema = z
  .number()
  .int()
  .min(LIVE_LIMITS.minDuration, 'Sessions last at least 5 minutes')
  .max(LIVE_LIMITS.maxDuration, 'Sessions last at most 12 hours');
/** Sessions can be scheduled from a year ago (to record a class that already happened) to five years ahead. */
const sessionStart = isoDateSchema.refine((v) => {
  const t = Date.parse(v);
  return t > Date.now() - 366 * 86_400_000 && t < Date.now() + 5 * 366 * 86_400_000;
}, 'Pick a date within the next few years');

export const scheduleSchema = z.object({
  startsAt: sessionStart,
  durationMinutes: durationSchema,
  title: z.string().trim().max(200).default(''),
  agenda: z.string().max(5000).default(''),
  meetingUrl: z.preprocess(emptyToNull, httpsUrlSchema.nullable()).default(null),
  timeZone: timeZoneSchema,
  repeat: z
    .object({
      frequency: z.enum(['daily', 'weekly']),
      count: z.number().int().min(1).max(LIVE_LIMITS.maxRepeat, `Repeat at most ${LIVE_LIMITS.maxRepeat} times`),
    })
    .nullable()
    .default(null),
});

export const sessionUpdateSchema = z.object({
  startsAt: sessionStart.optional(),
  durationMinutes: durationSchema.optional(),
  title: z.string().trim().max(200).optional(),
  agenda: z.string().max(5000).optional(),
  meetingUrl: z.preprocess(emptyToNull, httpsUrlSchema.nullable()).optional(),
  timeZone: timeZoneSchema.optional(),
});

const addMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/**
 * The learners to tell about a live class: enrolled students who can see it (visibility, group restrictions). None
 * while the course is archived: it is read-only for them, so there is nothing they could join.
 */
async function learnerAudience(db: DB, activity: ActivityRow): Promise<string[]> {
  const course = await db.selectFrom('courses').select('visibility').where('id', '=', activity.courseId).executeTakeFirst();
  if (!course || course.visibility === 'archived') return [];
  return audienceOf(db, activity, await courseMemberIds(db, activity.courseId, ['student']));
}

export function sessionLabel(activity: Pick<ActivityRow, 'title'>, session: Pick<LiveSessionRow, 'title'>): string {
  return session.title ? `${activity.title}: ${session.title}` : activity.title;
}

const activityLink = (course: Pick<CourseRow, 'slug'>, activity: Pick<ActivityRow, 'id'>) =>
  `/courses/${course.slug}/activities/${activity.id}`;

/** A reminder whose time has already come when the session is scheduled (or moved) would arrive with the news itself. */
function remindedAtFor(activity: ActivityRow, startsAt: string): string | null {
  const minutes = parseSettings('live', activity.settings).reminderMinutes;
  if (minutes == null) return null;
  return Date.parse(startsAt) - minutes * 60_000 <= Date.now() ? now() : null;
}

export async function scheduleSessions(
  deps: LiveDeps,
  activity: ActivityRow,
  course: CourseRow,
  input: z.output<typeof scheduleSchema>,
  userId: string,
): Promise<LiveSessionRow[]> {
  const { db } = deps;
  const count = input.repeat?.count ?? 1;
  const existing = await db
    .selectFrom('liveSessions')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('activityId', '=', activity.id)
    .executeTakeFirst();
  if (num(existing?.n) + count > LIVE_LIMITS.maxSessions) {
    throw badRequest(`A live class can have up to ${LIVE_LIMITS.maxSessions} sessions. Delete some old ones first.`);
  }
  const starts = input.repeat
    ? repeatStarts(Date.parse(input.startsAt), input.repeat.frequency, count, input.timeZone)
    : [Date.parse(input.startsAt)];
  const ts = now();
  const seriesId = starts.length > 1 ? newId() : null;
  const rows: LiveSessionRow[] = starts.map((start) => {
    const startsAt = new Date(start).toISOString();
    return {
      id: newId(),
      activityId: activity.id,
      courseId: activity.courseId,
      seriesId,
      title: input.title,
      agenda: input.agenda,
      startsAt,
      endsAt: addMinutes(startsAt, input.durationMinutes),
      durationMinutes: input.durationMinutes,
      timeZone: input.timeZone,
      status: 'scheduled',
      meetingUrl: input.meetingUrl,
      sequence: 0,
      remindedAt: remindedAtFor(activity, startsAt),
      createdBy: userId,
      createdAt: ts,
      updatedAt: ts,
    };
  });
  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insertInto('liveSessions')
      .values(rows.slice(i, i + 100))
      .execute();
  }
  const upcoming = rows.filter((r) => Date.parse(r.endsAt) > Date.now());
  if (upcoming.length) {
    const first = upcoming[0]!;
    const when = formatInZone(first.startsAt, first.timeZone);
    await notify(db, await learnerAudience(db, activity), {
      type: 'live.scheduled',
      title: upcoming.length === 1 ? `New live session: ${sessionLabel(activity, first)}` : `New live sessions: ${activity.title}`,
      body:
        upcoming.length === 1
          ? `${when}, for ${first.durationMinutes} minutes.`
          : `${upcoming.length} ${input.repeat?.frequency === 'daily' ? 'daily' : 'weekly'} sessions, starting ${when}.`,
      link: activityLink(course, activity),
    });
  }
  return rows;
}

export async function updateSession(
  deps: LiveDeps,
  activity: ActivityRow,
  course: CourseRow,
  session: LiveSessionRow,
  input: z.output<typeof sessionUpdateSchema>,
): Promise<LiveSessionRow> {
  const { db } = deps;
  if (session.status === 'cancelled') throw badRequest('This session was cancelled, so it can’t be changed.');
  const startsAt = input.startsAt ?? session.startsAt;
  const duration = input.durationMinutes ?? session.durationMinutes;
  const endsAt = addMinutes(startsAt, duration);
  const moved = startsAt !== session.startsAt || endsAt !== session.endsAt;
  const changed =
    moved ||
    (input.title !== undefined && input.title !== session.title) ||
    (input.agenda !== undefined && input.agenda !== session.agenda) ||
    (input.meetingUrl !== undefined && input.meetingUrl !== session.meetingUrl) ||
    (input.timeZone !== undefined && input.timeZone !== session.timeZone);
  if (!changed) return session;
  const update: Partial<LiveSessionRow> = {
    startsAt,
    endsAt,
    durationMinutes: duration,
    sequence: session.sequence + 1,
    updatedAt: now(),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.agenda !== undefined ? { agenda: input.agenda } : {}),
    ...(input.meetingUrl !== undefined ? { meetingUrl: input.meetingUrl } : {}),
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
    // A moved session gets a reminder for its new time.
    ...(moved ? { remindedAt: remindedAtFor(activity, startsAt) } : {}),
  };
  await db.updateTable('liveSessions').set(update).where('id', '=', session.id).execute();
  const next = { ...session, ...update } as LiveSessionRow;
  if (moved && (Date.parse(endsAt) > Date.now() || Date.parse(session.endsAt) > Date.now())) {
    await notify(db, await learnerAudience(db, activity), {
      type: 'live.moved',
      title: `Live session moved: ${sessionLabel(activity, next)}`,
      body: `Now ${formatInZone(startsAt, next.timeZone)}, for ${duration} minutes (it was ${formatInZone(session.startsAt, next.timeZone)}).`,
      link: activityLink(course, activity),
    });
  }
  return next;
}

export async function cancelSession(deps: LiveDeps, activity: ActivityRow, course: CourseRow, session: LiveSessionRow): Promise<void> {
  const { db } = deps;
  if (session.status === 'cancelled') return;
  const result = await db
    .updateTable('liveSessions')
    .set({ status: 'cancelled', sequence: session.sequence + 1, updatedAt: now() })
    .where('id', '=', session.id)
    .where('status', '=', 'scheduled')
    .executeTakeFirst();
  // Cancelled (or deleted) by another request at the same moment: that one tells students.
  if (num(result.numUpdatedRows) !== 1) return;
  await retireRooms(db, [session.id]);
  if (Date.parse(session.endsAt) > Date.now()) {
    await notify(db, await learnerAudience(db, activity), {
      type: 'live.cancelled',
      title: `Live session cancelled: ${sessionLabel(activity, session)}`,
      body: `The session on ${formatInZone(session.startsAt, session.timeZone)} won’t take place.`,
      link: activityLink(course, activity),
    });
  }
  await evaluateLiveCompletion(deps, activity);
}

/** Deletes a session with its attendance and recordings. Its provider rooms are cleaned up in the background. */
export async function deleteSession(deps: LiveDeps, activity: ActivityRow, course: CourseRow, session: LiveSessionRow): Promise<void> {
  const { db } = deps;
  // Students are told only by the request that deleted a session still scheduled at that moment: not twice when two
  // requests delete it at once, nor after a cancellation that already told them.
  const scheduled = await db.deleteFrom('liveSessions').where('id', '=', session.id).where('status', '=', 'scheduled').executeTakeFirst();
  const wasScheduled = num(scheduled.numDeletedRows) === 1;
  if (!wasScheduled) {
    const cancelled = await db.deleteFrom('liveSessions').where('id', '=', session.id).executeTakeFirst();
    if (num(cancelled.numDeletedRows) !== 1) return;
  }
  if (wasScheduled && Date.parse(session.endsAt) > Date.now()) {
    await notify(db, await learnerAudience(db, activity), {
      type: 'live.cancelled',
      title: `Live session cancelled: ${sessionLabel(activity, session)}`,
      body: `The session on ${formatInZone(session.startsAt, session.timeZone)} won’t take place.`,
      link: activityLink(course, activity),
    });
  }
  await evaluateLiveCompletion(deps, activity);
}

/** Sends the reminders that are due, each exactly once: the process whose conditional update claims it sends it. */
export async function sendDueReminders(deps: LiveDeps, nowMs = Date.now()): Promise<number> {
  const { db } = deps;
  const nowIso = new Date(nowMs).toISOString();
  const rows = await db
    .selectFrom('liveSessions')
    .innerJoin('activities', 'activities.id', 'liveSessions.activityId')
    .innerJoin('courses', 'courses.id', 'liveSessions.courseId')
    .selectAll('liveSessions')
    .select(['courses.slug as courseSlug'])
    .where('liveSessions.status', '=', 'scheduled')
    .where('liveSessions.remindedAt', 'is', null)
    .where('liveSessions.startsAt', '>', nowIso)
    .where('liveSessions.startsAt', '<=', new Date(nowMs + LIVE_LIMITS.maxReminderMinutes * 60_000).toISOString())
    .where('activities.type', '=', 'live')
    // None for archived courses. Their sessions stay unclaimed, so publishing the course again before one brings it back.
    .where('courses.visibility', '!=', 'archived')
    .orderBy('liveSessions.startsAt', 'asc')
    .limit(500)
    .execute();
  let sent = 0;
  const activities = new Map<string, ActivityRow | undefined>();
  for (const row of rows) {
    let activity = activities.get(row.activityId);
    if (!activities.has(row.activityId)) {
      activity = await db.selectFrom('activities').selectAll().where('id', '=', row.activityId).executeTakeFirst();
      activities.set(row.activityId, activity);
    }
    if (!activity) continue;
    const minutes = parseSettings('live', activity.settings).reminderMinutes;
    if (minutes == null || Date.parse(row.startsAt) - minutes * 60_000 > nowMs) continue;
    const claim = await db
      .updateTable('liveSessions')
      .set({ remindedAt: nowIso })
      .where('id', '=', row.id)
      .where('remindedAt', 'is', null)
      .where('status', '=', 'scheduled')
      .executeTakeFirst();
    if (num(claim.numUpdatedRows) !== 1) continue;
    await notify(db, await learnerAudience(db, activity), {
      type: 'live.reminder',
      title: `Starting soon: ${sessionLabel(activity, row)}`,
      body: `${formatInZone(row.startsAt, row.timeZone)}. Join from the class page when it opens.`,
      link: `/courses/${row.courseSlug}/activities/${activity.id}`,
    });
    sent++;
  }
  return sent;
}
