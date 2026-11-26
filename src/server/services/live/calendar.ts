/**
 * Live class sessions in the calendar (kind `live`) and in the dashboard's upcoming items, with the same rules as due
 * dates: staff of a course see every session, students only sessions of visible activities in visible sections that
 * aren't limited to groups they're outside.
 */
import type { CalendarEvent, CourseRole, TimelineItem } from '../../../shared/types.js';
import type { CourseRow } from '../../db/schema.js';
import type { DB } from '../../db/types.js';
import { toCourseRef } from '../serialize.js';

type EnrolledCourse = CourseRow & { myRole: CourseRole };

const CHUNK = 400;

async function sessionsIn(db: DB, courseIds: string[], from: string, to: string, options: { upcomingOnly?: boolean } = {}) {
  const rows = [];
  for (let i = 0; i < courseIds.length; i += CHUNK) {
    rows.push(
      ...(await db
        .selectFrom('liveSessions')
        .innerJoin('activities', 'activities.id', 'liveSessions.activityId')
        .innerJoin('sections', 'sections.id', 'activities.sectionId')
        .select([
          'liveSessions.id',
          'liveSessions.title',
          'liveSessions.agenda',
          'liveSessions.startsAt',
          'liveSessions.endsAt',
          'liveSessions.courseId',
          'activities.id as activityId',
          'activities.title as activityTitle',
          'activities.visible',
          'sections.visible as sectionVisible',
        ])
        .where('liveSessions.courseId', 'in', courseIds.slice(i, i + CHUNK))
        .where('liveSessions.status', '=', 'scheduled')
        .where('activities.type', '=', 'live')
        .$if(!options.upcomingOnly, (q) => q.where('liveSessions.startsAt', '>=', from).where('liveSessions.startsAt', '<=', to))
        .$if(!!options.upcomingOnly, (q) => q.where('liveSessions.endsAt', '>', from).where('liveSessions.startsAt', '<=', to))
        .orderBy('liveSessions.startsAt', 'asc')
        .execute()),
    );
  }
  return rows;
}

const sessionTitle = (activityTitle: string, title: string) => (title ? `${activityTitle}: ${title}` : activityTitle);

/** Sessions starting between `from` and `to` in the viewer's courses. */
export async function liveCalendarEvents(
  db: DB,
  courses: EnrolledCourse[],
  staffCourseIds: ReadonlySet<string>,
  unavailable: ReadonlySet<string>,
  from: string,
  to: string,
): Promise<CalendarEvent[]> {
  if (courses.length === 0) return [];
  const byId = new Map(courses.map((c) => [c.id, c]));
  const rows = await sessionsIn(
    db,
    courses.map((c) => c.id),
    from,
    to,
  );
  const events: CalendarEvent[] = [];
  for (const s of rows) {
    if (!staffCourseIds.has(s.courseId) && (!s.visible || !s.sectionVisible || unavailable.has(s.activityId))) continue;
    const course = byId.get(s.courseId);
    if (!course) continue;
    events.push({
      id: `live-${s.id}`,
      title: sessionTitle(s.activityTitle, s.title),
      kind: 'live',
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      description: s.agenda || null,
      course: toCourseRef(course),
      link: `/courses/${course.slug}/activities/${s.activityId}`,
      canDelete: false,
      icsUrl: `/api/live/sessions/${s.id}/ics`,
    });
  }
  return events;
}

/** The next (or running) session of each live class in the student's courses, for the dashboard's upcoming list. */
export async function liveTimelineItems(
  db: DB,
  courses: EnrolledCourse[],
  unavailable: ReadonlySet<string>,
  nowMs = Date.now(),
  daysAhead = 45,
): Promise<TimelineItem[]> {
  if (courses.length === 0) return [];
  const byId = new Map(courses.map((c) => [c.id, c]));
  const rows = await sessionsIn(
    db,
    courses.map((c) => c.id),
    new Date(nowMs).toISOString(),
    new Date(nowMs + daysAhead * 86_400_000).toISOString(),
    { upcomingOnly: true },
  );
  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  for (const s of rows) {
    if (seen.has(s.activityId) || !s.visible || !s.sectionVisible || unavailable.has(s.activityId)) continue;
    const course = byId.get(s.courseId);
    if (!course) continue;
    seen.add(s.activityId);
    items.push({
      activityId: s.activityId,
      title: sessionTitle(s.activityTitle, s.title),
      type: 'live',
      course: toCourseRef(course),
      dueAt: s.startsAt,
      status: 'todo',
      endsAt: s.endsAt,
    });
  }
  return items;
}
