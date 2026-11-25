import { Hono } from 'hono';
import { z } from 'zod';
import type { Announcement, AppNotification, CalendarEvent, DashboardData, SearchResults, TimelineItem } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { DB } from '../db/types.js';
import type { CourseRow, UserRow } from '../db/schema.js';
import { forbidden, notFound, readBody, readQuery } from '../lib/http.js';
import { isoDateSchema } from '../lib/schemas.js';
import { addDays, likePattern, newId, now, num, round } from '../lib/util.js';
import { assertCan, loadCourseAccess } from '../services/access.js';
import { summarizeCourses } from '../services/courses.js';
import { toCourseRef } from '../services/serialize.js';

type EnrolledCourse = CourseRow & { myRole: 'teacher' | 'assistant' | 'student' };

/** Courses the user is actively enrolled in. Students don't see drafts. */
async function enrolledCourses(db: DB, user: UserRow): Promise<EnrolledCourse[]> {
  return db
    .selectFrom('enrolments')
    .innerJoin('courses', 'courses.id', 'enrolments.courseId')
    .selectAll('courses')
    .select('enrolments.role as myRole')
    .where('enrolments.userId', '=', user.id)
    .where('enrolments.status', '=', 'active')
    .where((eb) => eb.or([eb('courses.visibility', '!=', 'draft'), eb('enrolments.role', 'in', ['teacher', 'assistant'])]))
    .execute();
}

export function meRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.get('/dashboard', async (c) => {
    const user = requireUser(c);
    const enrolled = await enrolledCourses(db, user);
    const courses = (await summarizeCourses(db, user, enrolled)).sort((a, b) => (b.lastAccessAt ?? '').localeCompare(a.lastAccessAt ?? ''));
    const byId = new Map(enrolled.map((e) => [e.id, e]));
    const studentIds = enrolled.filter((e) => e.myRole === 'student').map((e) => e.id);
    const staffIds = enrolled.filter((e) => e.myRole !== 'student').map((e) => e.id);
    const allIds = enrolled.map((e) => e.id);
    const nowIso = now();

    // Timeline of due work in courses where the user is a student.
    const dueRows = studentIds.length
      ? await db
          .selectFrom('activities')
          .innerJoin('sections', 'sections.id', 'activities.sectionId')
          .select(['activities.id', 'activities.title', 'activities.type', 'activities.courseId', 'activities.dueAt'])
          .where('activities.courseId', 'in', studentIds)
          .where('activities.visible', '=', 1)
          .where('sections.visible', '=', 1)
          .where('activities.dueAt', 'is not', null)
          .where('activities.dueAt', '>=', addDays(new Date(), -21).toISOString())
          .where('activities.dueAt', '<=', addDays(new Date(), 45).toISOString())
          .orderBy('activities.dueAt', 'asc')
          .execute()
      : [];
    const dueIds = dueRows.map((a) => a.id);
    const [subs, attempts, dueGrades] = dueIds.length
      ? await Promise.all([
          db.selectFrom('submissions').select('activityId').where('userId', '=', user.id).where('activityId', 'in', dueIds).execute(),
          db
            .selectFrom('quizAttempts')
            .select('activityId')
            .where('userId', '=', user.id)
            .where('status', 'in', ['finished', 'needs_grading'])
            .where('activityId', 'in', dueIds)
            .execute(),
          db.selectFrom('grades').select(['activityId', 'score']).where('userId', '=', user.id).where('activityId', 'in', dueIds).execute(),
        ])
      : [[], [], []];
    const submitted = new Set(subs.map((s) => s.activityId));
    const attempted = new Set(attempts.map((a) => a.activityId));
    const graded = new Set(dueGrades.filter((g) => g.score != null).map((g) => g.activityId));

    const timeline: TimelineItem[] = [];
    for (const a of dueRows) {
      const course = byId.get(a.courseId)!;
      const dueAt = a.dueAt!;
      const status: TimelineItem['status'] = graded.has(a.id)
        ? 'graded'
        : a.type === 'assignment' && submitted.has(a.id)
          ? 'submitted'
          : a.type === 'quiz' && attempted.has(a.id)
            ? 'done'
            : dueAt < nowIso
              ? 'overdue'
              : 'todo';
      // Past items only matter while they are still outstanding.
      if (dueAt < nowIso && status !== 'overdue') continue;
      timeline.push({ activityId: a.id, title: a.title, type: a.type, course: toCourseRef(course), dueAt, status });
    }

    const announcementRows = allIds.length
      ? await db
          .selectFrom('announcements')
          .innerJoin('users', 'users.id', 'announcements.userId')
          .select([
            'announcements.id',
            'announcements.courseId',
            'announcements.title',
            'announcements.body',
            'announcements.createdAt',
            'users.id as userId',
            'users.name as userName',
            'users.avatarUrl as userAvatarUrl',
          ])
          .where('announcements.courseId', 'in', allIds)
          .orderBy('announcements.createdAt', 'desc')
          .limit(5)
          .execute()
      : [];
    const announcements: Announcement[] = announcementRows.map((a) => ({
      id: a.id,
      course: toCourseRef(byId.get(a.courseId)!),
      title: a.title,
      body: a.body,
      author: { id: a.userId, name: a.userName, avatarUrl: a.userAvatarUrl },
      createdAt: a.createdAt,
    }));

    const gradeRows = studentIds.length
      ? await db
          .selectFrom('grades')
          .innerJoin('activities', 'activities.id', 'grades.activityId')
          .select([
            'grades.activityId',
            'grades.score',
            'grades.gradedAt',
            'grades.courseId',
            'activities.title',
            'activities.type',
            'activities.maxGrade',
          ])
          .where('grades.userId', '=', user.id)
          .where('grades.courseId', 'in', studentIds)
          .where('grades.score', 'is not', null)
          .orderBy('grades.gradedAt', 'desc')
          .execute()
      : [];
    const recentGrades = gradeRows.slice(0, 5).map((g) => ({
      activityId: g.activityId,
      title: g.title,
      type: g.type,
      course: toCourseRef(byId.get(g.courseId)!),
      score: g.score ?? 0,
      maxGrade: g.maxGrade ?? 0,
      gradedAt: g.gradedAt ?? '',
    }));
    const fractions = gradeRows.filter((g) => (g.maxGrade ?? 0) > 0).map((g) => (g.score ?? 0) / g.maxGrade!);

    const pending = staffIds.length
      ? await db
          .selectFrom('submissions')
          .leftJoin('grades', (join) =>
            join.onRef('grades.activityId', '=', 'submissions.activityId').onRef('grades.userId', '=', 'submissions.userId'),
          )
          .innerJoin('activities', 'activities.id', 'submissions.activityId')
          .select(['submissions.activityId', 'submissions.courseId', 'activities.title', (eb) => eb.fn.countAll().as('n')])
          .where('submissions.courseId', 'in', staffIds)
          .where((eb) =>
            eb.or([
              eb('grades.score', 'is', null),
              eb('grades.gradedAt', 'is', null),
              eb('grades.gradedAt', '<', eb.ref('submissions.submittedAt')),
            ]),
          )
          .groupBy(['submissions.activityId', 'submissions.courseId', 'activities.title'])
          .execute()
      : [];

    const completedRow = studentIds.length
      ? await db
          .selectFrom('completions')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('userId', '=', user.id)
          .where('courseId', 'in', studentIds)
          .executeTakeFirst()
      : undefined;

    const weekAhead = addDays(new Date(), 7).toISOString();
    const data: DashboardData = {
      courses,
      timeline,
      announcements,
      recentGrades,
      toGrade: pending
        .map((p) => ({ activityId: p.activityId, title: p.title, course: toCourseRef(byId.get(p.courseId)!), count: num(p.n) }))
        .sort((a, b) => b.count - a.count),
      stats: {
        enrolled: studentIds.length,
        teaching: staffIds.length,
        completedActivities: num(completedRow?.n),
        averageGrade: fractions.length ? round((fractions.reduce((a, b) => a + b, 0) / fractions.length) * 100, 1) : null,
        dueThisWeek: timeline.filter((t) => (t.status === 'todo' || t.status === 'overdue') && t.dueAt <= weekAhead).length,
      },
    };
    return c.json(data);
  });

  r.get('/notifications', async (c) => {
    const user = requireUser(c);
    const rows = await db
      .selectFrom('notifications')
      .selectAll()
      .where('userId', '=', user.id)
      .orderBy('createdAt', 'desc')
      .limit(60)
      .execute();
    const unread = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('userId', '=', user.id)
      .where('readAt', 'is', null)
      .executeTakeFirst();
    const items: AppNotification[] = rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.readAt,
      createdAt: n.createdAt,
    }));
    return c.json({ items, unreadCount: num(unread?.n) });
  });

  r.post('/notifications/read', async (c) => {
    const user = requireUser(c);
    const { ids } = await readBody(c, z.object({ ids: z.array(z.string().max(40)).max(200).optional() }));
    await db
      .updateTable('notifications')
      .set({ readAt: now() })
      .where('userId', '=', user.id)
      .where('readAt', 'is', null)
      .$if(!!ids, (q) => q.where('id', 'in', ids!.length ? ids! : ['-']))
      .execute();
    return c.json({ ok: true });
  });

  r.get('/calendar', async (c) => {
    const user = requireUser(c);
    const q = readQuery(c, z.object({ from: isoDateSchema, to: isoDateSchema }));
    const enrolled = await enrolledCourses(db, user);
    const byId = new Map(enrolled.map((e) => [e.id, e]));
    const ids = enrolled.map((e) => e.id);
    const staffIds = new Set(enrolled.filter((e) => e.myRole !== 'student').map((e) => e.id));
    const events: CalendarEvent[] = [];

    if (ids.length) {
      const due = await db
        .selectFrom('activities')
        .innerJoin('sections', 'sections.id', 'activities.sectionId')
        .select([
          'activities.id',
          'activities.title',
          'activities.type',
          'activities.courseId',
          'activities.dueAt',
          'activities.visible',
          'sections.visible as sectionVisible',
        ])
        .where('activities.courseId', 'in', ids)
        .where('activities.dueAt', '>=', q.from)
        .where('activities.dueAt', '<=', q.to)
        .execute();
      for (const a of due) {
        if (!staffIds.has(a.courseId) && (!a.visible || !a.sectionVisible)) continue;
        const course = byId.get(a.courseId)!;
        events.push({
          id: `due-${a.id}`,
          title: `${a.title} due`,
          kind: 'due',
          startsAt: a.dueAt!,
          endsAt: null,
          description: null,
          course: toCourseRef(course),
          link: `/courses/${course.slug}/activities/${a.id}`,
          canDelete: false,
        });
      }
      for (const course of enrolled) {
        for (const [kind, date] of [
          ['course-start', course.startDate],
          ['course-end', course.endDate],
        ] as const) {
          if (date && date >= q.from && date <= q.to) {
            events.push({
              id: `${kind}-${course.id}`,
              title: `${course.title} ${kind === 'course-start' ? 'starts' : 'ends'}`,
              kind,
              startsAt: date,
              endsAt: null,
              description: null,
              course: toCourseRef(course),
              link: `/courses/${course.slug}`,
              canDelete: false,
            });
          }
        }
      }
    }

    const custom = await db
      .selectFrom('calendarEvents')
      .selectAll()
      .where('startsAt', '>=', q.from)
      .where('startsAt', '<=', q.to)
      .where((eb) =>
        eb.or([eb.and([eb('userId', '=', user.id), eb('courseId', 'is', null)]), ...(ids.length ? [eb('courseId', 'in', ids)] : [])]),
      )
      .execute();
    for (const e of custom) {
      const course = e.courseId ? byId.get(e.courseId) : undefined;
      events.push({
        id: e.id,
        title: e.title,
        kind: e.courseId ? 'course' : 'personal',
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        description: e.description,
        course: course ? toCourseRef(course) : null,
        link: course ? `/courses/${course.slug}` : null,
        canDelete: e.createdBy === user.id || (!!e.courseId && staffIds.has(e.courseId)) || user.role === 'admin',
      });
    }
    events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return c.json(events);
  });

  r.post('/calendar/events', async (c) => {
    const user = requireUser(c);
    const input = await readBody(
      c,
      z.object({
        title: z.string().trim().min(1, 'Add a title').max(200),
        description: z.string().max(5000).nullable().default(null),
        startsAt: isoDateSchema,
        endsAt: isoDateSchema.nullable().default(null),
        courseId: z.string().max(80).nullable().default(null),
      }),
    );
    let courseId: string | null = null;
    if (input.courseId) {
      const access = await loadCourseAccess(db, user, input.courseId);
      assertCan(access, 'course:manageContent', 'Only teachers can add course events.');
      courseId = access.course.id;
    }
    const row = {
      id: newId(),
      courseId,
      userId: courseId ? null : user.id,
      title: input.title,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: user.id,
      createdAt: now(),
    };
    await db.insertInto('calendarEvents').values(row).execute();
    return c.json({ id: row.id }, 201);
  });

  r.delete('/calendar/events/:id', async (c) => {
    const user = requireUser(c);
    const event = await db.selectFrom('calendarEvents').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!event) throw notFound('Event');
    let allowed = event.createdBy === user.id || user.role === 'admin';
    if (!allowed && event.courseId) {
      const access = await loadCourseAccess(db, user, event.courseId);
      allowed = access.can('course:manageContent');
    }
    if (!allowed) throw forbidden();
    await db.deleteFrom('calendarEvents').where('id', '=', event.id).execute();
    return c.json({ ok: true });
  });

  r.get('/search', async (c) => {
    const user = requireUser(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const empty: SearchResults = { courses: [], activities: [], users: [] };
    if (q.length < 2) return c.json(empty);
    const pattern = likePattern(q);
    const enrolled = await enrolledCourses(db, user);
    const ids = enrolled.map((e) => e.id);
    const staffIds = new Set(enrolled.filter((e) => e.myRole !== 'student').map((e) => e.id));

    const courses = await db
      .selectFrom('courses')
      .select(['id', 'slug', 'title', 'coverColor'])
      .where((eb) => eb(eb.fn('lower', ['title']), 'like', pattern))
      .$if(user.role !== 'admin', (qb) =>
        qb.where((eb) => eb.or([eb('visibility', '=', 'published'), ...(ids.length ? [eb('id', 'in', ids)] : [])])),
      )
      .orderBy('title', 'asc')
      .limit(6)
      .execute();

    const activityRows = ids.length
      ? await db
          .selectFrom('activities')
          .innerJoin('courses', 'courses.id', 'activities.courseId')
          .innerJoin('sections', 'sections.id', 'activities.sectionId')
          .select([
            'activities.id',
            'activities.title',
            'activities.type',
            'activities.visible',
            'sections.visible as sectionVisible',
            'courses.id as courseId',
            'courses.slug as courseSlug',
            'courses.title as courseTitle',
            'courses.coverColor as courseCoverColor',
          ])
          .where('activities.courseId', 'in', ids)
          .where((eb) => eb(eb.fn('lower', ['activities.title']), 'like', pattern))
          .limit(20)
          .execute()
      : [];

    const users =
      user.role === 'admin'
        ? await db
            .selectFrom('users')
            .select(['id', 'name', 'email', 'avatarUrl'])
            .where((eb) => eb.or([eb(eb.fn('lower', ['name']), 'like', pattern), eb('email', 'like', pattern)]))
            .limit(5)
            .execute()
        : [];

    const results: SearchResults = {
      courses: courses.map(toCourseRef),
      activities: activityRows
        .filter((a) => staffIds.has(a.courseId) || (a.visible && a.sectionVisible))
        .slice(0, 8)
        .map((a) => ({
          id: a.id,
          title: a.title,
          type: a.type,
          course: { id: a.courseId, slug: a.courseSlug, title: a.courseTitle, coverColor: a.courseCoverColor },
        })),
      users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl })),
    };
    return c.json(results);
  });

  return r;
}
