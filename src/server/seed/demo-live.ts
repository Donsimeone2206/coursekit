/**
 * Demo data for live classes: a "Weekly live Q&A" in Modern Web Development using the Meeting link provider, so it
 * works without any account. A weekly series at 17:00 London time: two past sessions with attendance (joins through
 * Coursekit and a few teacher marks) and a recording link, and four upcoming ones. meet.example.com and
 * video.example.com are placeholders, so the links don't reach anything. Works offline.
 */
import { DEFAULT_LIVE_SETTINGS, type LiveSettings } from '../../shared/live.js';
import type { AppDeps } from '../context.js';
import type { LiveSessionRow } from '../db/schema-live.js';
import { newId, now } from '../lib/util.js';
import { localTimeAt, repeatStarts, zonedTimeToUtc } from '../services/live/time.js';

const ZONE = 'Europe/London';
const TOPICS: Array<[string, string]> = [
  ['Getting set up', 'Editors, browsers and the course project.\nBring any setup problems.'],
  ['Semantic HTML', 'Headings, landmarks and forms.\nWe’ll review two of your pages together.'],
  ['CSS layout', 'Flexbox and Grid questions, then a short layout challenge.'],
  ['JavaScript and the DOM', 'Events, selectors and debugging in the browser.'],
  ['React components', 'Props, state and when to split a component.'],
  ['Project check-in', 'Show what you have so far and get feedback.'],
];

export async function seedLiveClassesDemo(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const course = await db.selectFrom('courses').select(['id']).where('slug', '=', 'modern-web-development').executeTakeFirst();
  if (!course) return;
  const section = await db
    .selectFrom('sections')
    .select('id')
    .where('courseId', '=', course.id)
    .orderBy('position', 'asc')
    .executeTakeFirst();
  if (!section) return;
  const teacher = await db.selectFrom('users').select('id').where('email', '=', 'maya.chen@coursekit.test').executeTakeFirst();
  const students = (
    await db
      .selectFrom('enrolments')
      .innerJoin('users', 'users.id', 'enrolments.userId')
      .select(['users.id', 'users.name', 'users.email'])
      .where('enrolments.courseId', '=', course.id)
      .where('enrolments.role', '=', 'student')
      .where('enrolments.status', '=', 'active')
      .orderBy('users.email', 'asc')
      .execute()
  ).sort((a, b) => (a.email.startsWith('alex.') ? -1 : b.email.startsWith('alex.') ? 1 : 0));
  const ts = now();

  // The next 17:00 in London that is at least an hour away; the series starts two weeks before it.
  const today = localTimeAt(Date.now(), ZONE);
  let anchor = zonedTimeToUtc({ ...today, hour: 17, minute: 0 }, ZONE);
  if (anchor < Date.now() + 3600_000) {
    const tomorrow = localTimeAt(anchor + 86_400_000, ZONE);
    anchor = zonedTimeToUtc({ ...tomorrow, hour: 17, minute: 0 }, ZONE);
  }
  const startLocal = localTimeAt(anchor - 14 * 86_400_000, ZONE);
  const first = zonedTimeToUtc({ ...startLocal, hour: 17, minute: 0 }, ZONE);
  const starts = repeatStarts(first, 'weekly', TOPICS.length, ZONE);

  const max = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  const activityId = newId();
  const settings: LiveSettings = {
    ...DEFAULT_LIVE_SETTINGS,
    provider: 'link',
    meetingUrl: 'https://meet.example.com/coursekit-weekly-qa',
    joinMinutesBefore: 10,
    reminderMinutes: 30,
    attendanceRequired: 2,
  };
  await db
    .insertInto('activities')
    .values({
      id: activityId,
      courseId: course.id,
      sectionId: section.id,
      type: 'live',
      title: 'Weekly live Q&A',
      description:
        'Every week we meet online for an hour to go through your questions. Join from this page when a session opens, ten minutes before it starts. Recordings appear here afterwards.\n\n**This is a demo:** the meeting link points to meet.example.com, a placeholder. An administrator can set up BigBlueButton, Zoom or Jitsi Meet under Administration → Live classes.',
      position: max?.m == null ? 0 : Number(max.m) + 1,
      visible: 1,
      settings: JSON.stringify(settings),
      dueAt: null,
      maxGrade: null,
      completion: 'auto',
      createdBy: teacher?.id ?? null,
      createdAt: new Date(first - 7 * 86_400_000).toISOString(),
      updatedAt: ts,
    })
    .execute();

  const seriesId = newId();
  const sessions: LiveSessionRow[] = starts.map((start, i) => {
    const startsAt = new Date(start).toISOString();
    const past = start < Date.now();
    return {
      id: newId(),
      activityId,
      courseId: course.id,
      seriesId,
      title: `Week ${i + 1}: ${TOPICS[i]![0]}`,
      agenda: TOPICS[i]![1],
      startsAt,
      endsAt: new Date(start + 60 * 60_000).toISOString(),
      durationMinutes: 60,
      timeZone: ZONE,
      status: 'scheduled',
      meetingUrl: null,
      sequence: 0,
      remindedAt: past ? new Date(start - 30 * 60_000).toISOString() : null,
      createdBy: teacher?.id ?? null,
      createdAt: new Date(first - 7 * 86_400_000).toISOString(),
      updatedAt: new Date(first - 7 * 86_400_000).toISOString(),
    };
  });
  await db.insertInto('liveSessions').values(sessions).execute();

  // Attendance of the two past sessions: who joined through Coursekit, plus a couple of teacher marks.
  const past = sessions.filter((s) => Date.parse(s.startsAt) < Date.now()).slice(0, 2);
  const presence: Array<Record<string, unknown>> = [];
  const marks: Array<Record<string, unknown>> = [];
  const attended = new Map<string, number>();
  past.forEach((session, index) => {
    const start = Date.parse(session.startsAt);
    // Most students come; a different few miss each week.
    const present = students.filter((_, i) => (index === 0 ? i % 4 !== 3 : i % 3 !== 2));
    present.forEach((s, i) => {
      presence.push({
        id: newId(),
        sessionId: session.id,
        roomId: null,
        groupKey: '',
        userId: s.id,
        source: 'join',
        sourceKey: newId(),
        name: s.name,
        role: 'viewer',
        joinedAt: new Date(start - 5 * 60_000 + i * 45_000).toISOString(),
        leftAt: null,
        createdAt: session.startsAt,
        updatedAt: session.startsAt,
      });
      attended.set(s.id, (attended.get(s.id) ?? 0) + 1);
    });
    if (teacher) {
      presence.push({
        id: newId(),
        sessionId: session.id,
        roomId: null,
        groupKey: '',
        userId: teacher.id,
        source: 'join',
        sourceKey: newId(),
        name: 'Maya Chen',
        role: 'moderator',
        joinedAt: new Date(start - 8 * 60_000).toISOString(),
        leftAt: null,
        createdAt: session.startsAt,
        updatedAt: session.startsAt,
      });
    }
    // Someone who dialled in by phone, marked present by the teacher after the class.
    const absentee = students.find((s) => !present.includes(s));
    if (absentee && teacher && index === 1) {
      marks.push({
        sessionId: session.id,
        userId: absentee.id,
        courseId: course.id,
        status: 'present',
        markedBy: teacher.id,
        markedAt: session.endsAt,
      });
      attended.set(absentee.id, (attended.get(absentee.id) ?? 0) + 1);
    }
  });
  if (presence.length)
    await db
      .insertInto('livePresence')
      .values(presence as never)
      .execute();
  if (marks.length)
    await db
      .insertInto('liveAttendance')
      .values(marks as never)
      .execute();

  // A recording link the teacher added after the first session.
  if (past[0]) {
    await db
      .insertInto('liveRecordings')
      .values({
        id: newId(),
        sessionId: past[0].id,
        courseId: course.id,
        roomId: null,
        groupKey: '',
        source: 'manual',
        externalId: null,
        title: 'Recording: Getting set up',
        url: 'https://video.example.com/coursekit/weekly-qa-week-1',
        passcode: null,
        durationMinutes: 58,
        recordedAt: past[0].startsAt,
        hidden: 0,
        removedAt: null,
        addedBy: teacher?.id ?? null,
        createdAt: past[0].endsAt,
        updatedAt: past[0].endsAt,
      })
      .execute();
  }

  // Students who attended both sessions have completed the class (two sessions are required).
  const completed = students.filter((s) => (attended.get(s.id) ?? 0) >= settings.attendanceRequired);
  if (completed.length && past[1]) {
    await db
      .insertInto('completions')
      .values(completed.map((s) => ({ activityId, userId: s.id, courseId: course.id, completedAt: past[1]!.endsAt })))
      .execute();
  }
}
