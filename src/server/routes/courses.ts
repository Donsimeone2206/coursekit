import { Hono } from 'hono';
import { z } from 'zod';
import { COVER_COLORS } from '../../shared/constants.js';
import { canCreateCourses } from '../../shared/permissions.js';
import type { ActivitySummary, Announcement, CourseDetail, Paginated, Participant, Section } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { ActivityRow, CourseRow } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound, readBody, readQuery } from '../lib/http.js';
import { courseRoleSchema, emailSchema, imageUrlSchema, isoDateSchema, markdownSchema, pageSchema } from '../lib/schemas.js';
import { likePattern, newId, now, num } from '../lib/util.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import { parseSettings } from '../services/activity-types.js';
import { summarizeCourses, uniqueCourseSlug } from '../services/courses.js';
import { courseMemberIds, notify } from '../services/notify.js';
import { progressByUser } from '../services/progress.js';
import { toCourseRef, toPublicUser } from '../services/serialize.js';
import { normalizeEmail } from '../services/users.js';

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes');

const courseFields = {
  title: z.string().trim().min(3, 'Use at least 3 characters').max(150),
  slug: slugSchema,
  summary: z.string().trim().max(500),
  description: markdownSchema(100_000),
  categoryId: z.string().max(40).nullable(),
  coverColor: z.enum(COVER_COLORS),
  coverImageUrl: imageUrlSchema.nullable(),
  visibility: z.enum(['draft', 'published', 'archived']),
  enrolment: z.enum(['open', 'key', 'invite']),
  enrolmentKey: z.string().trim().max(100).nullable(),
  startDate: isoDateSchema.nullable(),
  endDate: isoDateSchema.nullable(),
};

const createSchema = z.object({
  title: courseFields.title,
  slug: courseFields.slug.optional(),
  summary: courseFields.summary.default(''),
  description: courseFields.description.default(''),
  categoryId: courseFields.categoryId.default(null),
  coverColor: courseFields.coverColor.default('indigo'),
  visibility: courseFields.visibility.default('draft'),
  enrolment: courseFields.enrolment.default('open'),
  enrolmentKey: courseFields.enrolmentKey.default(null),
  startDate: courseFields.startDate.default(null),
  endDate: courseFields.endDate.default(null),
});

const updateSchema = z.object(courseFields).partial();

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function activityMeta(a: ActivityRow, counts: Map<string, number>): string | null {
  switch (a.type) {
    case 'lesson': {
      const s = parseSettings('lesson', a.settings);
      if (s.estimatedMinutes) return `${s.estimatedMinutes} min ${s.videoUrl ? 'video' : 'read'}`;
      return s.videoUrl ? 'Video' : null;
    }
    case 'resource':
      return parseSettings('resource', a.settings).kind === 'file' ? 'File' : 'Link';
    case 'assignment':
      return a.maxGrade != null ? `${a.maxGrade} points` : null;
    case 'quiz':
      return plural(counts.get(a.id) ?? 0, 'question');
    case 'forum':
      return plural(counts.get(a.id) ?? 0, 'discussion');
    default:
      return null;
  }
}

async function assertCategory(deps: AppDeps, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const exists = await deps.db.selectFrom('categories').select('id').where('id', '=', categoryId).executeTakeFirst();
  if (!exists) throw badRequest('That category does not exist.');
}

export function courseRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, events } = deps;

  /** Course catalog: published courses, searchable and filterable by category. */
  r.get('/', async (c) => {
    const user = requireUser(c);
    const q = readQuery(c, z.object({ q: z.string().max(100).optional(), category: z.string().max(40).optional(), ...pageSchema }));
    let query = db.selectFrom('courses').where('visibility', '=', 'published');
    if (q.q?.trim()) {
      const pattern = likePattern(q.q);
      query = query.where((eb) =>
        eb.or([eb(eb.fn('lower', ['title']), 'like', pattern), eb(eb.fn('lower', ['summary']), 'like', pattern)]),
      );
    }
    if (q.category) query = query.where('categoryId', '=', q.category);
    const totalRow = await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
    const rows = await query
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute();
    const result: Paginated<Awaited<ReturnType<typeof summarizeCourses>>[number]> = {
      items: await summarizeCourses(db, user, rows),
      total: num(totalRow?.n),
      page: q.page,
      pageSize: q.pageSize,
    };
    return c.json(result);
  });

  /** Courses the current user is enrolled in (any role). */
  r.get('/mine', async (c) => {
    const user = requireUser(c);
    const rows = await db
      .selectFrom('courses')
      .innerJoin('enrolments', 'enrolments.courseId', 'courses.id')
      .selectAll('courses')
      .where('enrolments.userId', '=', user.id)
      .where('enrolments.status', '=', 'active')
      .where((eb) => eb.or([eb('courses.visibility', '!=', 'draft'), eb('enrolments.role', 'in', ['teacher', 'assistant'])]))
      .orderBy('courses.title', 'asc')
      .execute();
    const summaries = await summarizeCourses(db, user, rows);
    summaries.sort((a, b) => (b.lastAccessAt ?? '').localeCompare(a.lastAccessAt ?? ''));
    return c.json(summaries);
  });

  r.post('/', async (c) => {
    const user = requireUser(c);
    if (!canCreateCourses(user.role)) throw forbidden('Only instructors and administrators can create courses.');
    const input = await readBody(c, createSchema);
    await assertCategory(deps, input.categoryId);
    const slug = await uniqueCourseSlug(db, input.slug ?? input.title);
    const ts = now();
    const course: CourseRow = {
      id: newId(),
      slug,
      title: input.title,
      summary: input.summary,
      description: input.description,
      categoryId: input.categoryId,
      coverColor: input.coverColor,
      coverImageUrl: null,
      visibility: input.visibility,
      enrolment: input.enrolment,
      enrolmentKey: input.enrolmentKey,
      startDate: input.startDate,
      endDate: input.endDate,
      createdBy: user.id,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('courses').values(course).execute();
      await trx
        .insertInto('enrolments')
        .values({ id: newId(), courseId: course.id, userId: user.id, role: 'teacher', status: 'active', lastAccessAt: ts, createdAt: ts })
        .execute();
      await trx
        .insertInto('sections')
        .values({ id: newId(), courseId: course.id, title: 'Getting started', summary: '', position: 0, visible: 1, createdAt: ts })
        .execute();
    });
    events.emit('course.created', { courseId: course.id, userId: user.id });
    events.emit('enrolment.created', { courseId: course.id, userId: user.id, role: 'teacher' });
    return c.json({ id: course.id, slug: course.slug }, 201);
  });

  r.get('/:courseId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    const { course } = access;
    const canView = access.can('course:view');
    if (!canView && course.visibility !== 'published') throw notFound('Course');
    const showHidden = access.can('course:viewHidden');

    const [sections, activities] = await Promise.all([
      db.selectFrom('sections').selectAll().where('courseId', '=', course.id).orderBy('position', 'asc').execute(),
      db.selectFrom('activities').selectAll().where('courseId', '=', course.id).orderBy('position', 'asc').execute(),
    ]);

    const quizIds = activities.filter((a) => a.type === 'quiz').map((a) => a.id);
    const forumIds = activities.filter((a) => a.type === 'forum').map((a) => a.id);
    const [questionCounts, discussionCounts, completions] = await Promise.all([
      quizIds.length
        ? db
            .selectFrom('questions')
            .select(['activityId', (eb) => eb.fn.countAll().as('n')])
            .where('activityId', 'in', quizIds)
            .groupBy('activityId')
            .execute()
        : [],
      forumIds.length
        ? db
            .selectFrom('discussions')
            .select(['activityId', (eb) => eb.fn.countAll().as('n')])
            .where('activityId', 'in', forumIds)
            .groupBy('activityId')
            .execute()
        : [],
      canView
        ? db.selectFrom('completions').select('activityId').where('courseId', '=', course.id).where('userId', '=', user.id).execute()
        : [],
    ]);
    const counts = new Map<string, number>();
    for (const row of [...questionCounts, ...discussionCounts]) counts.set(row.activityId, num(row.n));
    const completed = new Set(completions.map((r) => r.activityId));

    const sectionDtos: Section[] = sections
      .filter((s) => showHidden || s.visible)
      .map((s) => ({
        id: s.id,
        title: s.title,
        summary: s.summary,
        position: s.position,
        visible: !!s.visible,
        activities: activities
          .filter((a) => a.sectionId === s.id && (showHidden || a.visible))
          .map((a): ActivitySummary => ({
            id: a.id,
            courseId: a.courseId,
            sectionId: a.sectionId,
            type: a.type,
            title: a.title,
            visible: !!a.visible,
            position: a.position,
            dueAt: a.dueAt,
            maxGrade: a.maxGrade,
            completion: a.completion,
            completed: completed.has(a.id),
            meta: activityMeta(a, counts),
          })),
      }));

    if (access.enrolment) {
      const last = access.enrolment.lastAccessAt ? Date.parse(access.enrolment.lastAccessAt) : 0;
      if (Date.now() - last > 5 * 60_000) {
        await db.updateTable('enrolments').set({ lastAccessAt: now() }).where('id', '=', access.enrolment.id).execute();
      }
    }

    const [summary] = await summarizeCourses(db, user, [course]);
    const detail: CourseDetail = {
      ...summary!,
      description: course.description,
      capabilities: access.capabilities,
      sections: sectionDtos,
      hasEnrolmentKey: course.enrolment === 'key' && !!course.enrolmentKey,
      enrolmentKey: access.can('course:update') ? course.enrolmentKey : null,
      canEnrol: !access.enrolment && course.visibility === 'published' && course.enrolment !== 'invite',
      outlineOnly: !canView,
    };
    return c.json(detail);
  });

  r.patch('/:courseId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:update');
    const input = await readBody(c, updateSchema);
    await assertCategory(deps, input.categoryId);
    if (input.slug && input.slug !== access.course.slug) {
      const taken = await db.selectFrom('courses').select('id').where('slug', '=', input.slug).executeTakeFirst();
      if (taken) throw conflict('Another course already uses this URL.');
    }
    await db
      .updateTable('courses')
      .set({ ...input, updatedAt: now() })
      .where('id', '=', access.course.id)
      .execute();
    events.emit('course.updated', { courseId: access.course.id });
    const updated = await db.selectFrom('courses').select(['id', 'slug']).where('id', '=', access.course.id).executeTakeFirstOrThrow();
    return c.json(updated);
  });

  r.delete('/:courseId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:delete');
    const files = await db.selectFrom('files').select('storageKey').where('courseId', '=', access.course.id).execute();
    await db.deleteFrom('courses').where('id', '=', access.course.id).execute();
    await Promise.allSettled(files.map((f) => deps.storage.delete(f.storageKey)));
    events.emit('course.deleted', { courseId: access.course.id });
    return c.json({ ok: true });
  });

  /** Self-enrolment as a student. */
  r.post('/:courseId/enrol', async (c) => {
    const user = requireUser(c);
    const input = await readBody(c, z.object({ key: z.string().max(100).optional() }));
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    const { course } = access;
    if (access.enrolment) return c.json({ ok: true });
    const existing = await db
      .selectFrom('enrolments')
      .select(['id', 'status'])
      .where('courseId', '=', course.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (existing?.status === 'suspended') throw forbidden('Your enrolment in this course is suspended.');
    if (course.visibility !== 'published') throw forbidden('This course is not open for enrolment.');
    if (course.enrolment === 'invite') throw forbidden('This course is invite-only. Ask the teacher to enrol you.');
    if (course.enrolment === 'key' && course.enrolmentKey && input.key?.trim() !== course.enrolmentKey) {
      throw badRequest('That enrolment key is not correct.');
    }
    const ts = now();
    await db
      .insertInto('enrolments')
      .values({ id: newId(), courseId: course.id, userId: user.id, role: 'student', status: 'active', lastAccessAt: ts, createdAt: ts })
      .execute();
    events.emit('enrolment.created', { courseId: course.id, userId: user.id, role: 'student' });
    return c.json({ ok: true }, 201);
  });

  r.post('/:courseId/leave', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    if (!access.enrolment) throw badRequest('You are not enrolled in this course.');
    if (access.enrolment.role !== 'student') throw badRequest('Teachers leave a course by removing themselves from Participants.');
    await db.deleteFrom('enrolments').where('id', '=', access.enrolment.id).execute();
    events.emit('enrolment.deleted', { courseId: access.course.id, userId: user.id });
    return c.json({ ok: true });
  });

  r.get('/:courseId/participants', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:viewParticipants');
    const manage = access.can('course:manageParticipants') || access.can('grades:viewAll');
    const rows = await db
      .selectFrom('enrolments')
      .innerJoin('users', 'users.id', 'enrolments.userId')
      .select([
        'enrolments.id as enrolmentId',
        'enrolments.role',
        'enrolments.status',
        'enrolments.createdAt',
        'enrolments.lastAccessAt',
        'users.id',
        'users.name',
        'users.email',
        'users.avatarUrl',
      ])
      .where('enrolments.courseId', '=', access.course.id)
      .$if(!manage, (q) => q.where('enrolments.status', '=', 'active'))
      .orderBy('users.name', 'asc')
      .execute();
    const progress = manage
      ? await progressByUser(
          db,
          access.course.id,
          rows.filter((r) => r.role === 'student').map((r) => r.id),
        )
      : new Map<string, number>();
    const rolesOrder = { teacher: 0, assistant: 1, student: 2 } as const;
    const participants: Participant[] = rows
      .map((row) => ({
        enrolmentId: row.enrolmentId,
        user: { id: row.id, name: row.name, avatarUrl: row.avatarUrl, email: manage ? row.email : null },
        role: row.role,
        status: row.status,
        enrolledAt: row.createdAt,
        lastAccessAt: manage ? row.lastAccessAt : null,
        progress: row.role === 'student' && manage ? (progress.get(row.id) ?? 0) : null,
      }))
      .sort((a, b) => rolesOrder[a.role] - rolesOrder[b.role]);
    return c.json(participants);
  });

  /** Enrol existing users by email. */
  r.post('/:courseId/participants', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:manageParticipants');
    const input = await readBody(
      c,
      z.object({ emails: z.array(emailSchema).min(1, 'Add at least one email').max(500), role: courseRoleSchema.default('student') }),
    );
    const emails = [...new Set(input.emails.map(normalizeEmail))];
    const users = await db.selectFrom('users').select(['id', 'email']).where('email', 'in', emails).execute();
    const found = new Map(users.map((u) => [u.email, u.id]));
    const existing = await db
      .selectFrom('enrolments')
      .select('userId')
      .where('courseId', '=', access.course.id)
      .where('userId', 'in', users.length ? users.map((u) => u.id) : ['-'])
      .execute();
    const enrolled = new Set(existing.map((e) => e.userId));

    const ts = now();
    const toAdd = users.filter((u) => !enrolled.has(u.id));
    if (toAdd.length) {
      await db
        .insertInto('enrolments')
        .values(
          toAdd.map((u) => ({
            id: newId(),
            courseId: access.course.id,
            userId: u.id,
            role: input.role,
            status: 'active' as const,
            lastAccessAt: null,
            createdAt: ts,
          })),
        )
        .execute();
      await notify(
        db,
        toAdd.map((u) => u.id),
        {
          type: 'enrolment',
          title: `You were added to ${access.course.title}`,
          body: `${user.name} enrolled you as a ${input.role === 'assistant' ? 'teaching assistant' : input.role}.`,
          link: `/courses/${access.course.slug}`,
        },
      );
      for (const u of toAdd) events.emit('enrolment.created', { courseId: access.course.id, userId: u.id, role: input.role });
    }
    return c.json({
      added: toAdd.length,
      alreadyEnrolled: users.filter((u) => enrolled.has(u.id)).map((u) => u.email),
      notFound: emails.filter((e) => !found.has(e)),
    });
  });

  r.patch('/:courseId/participants/:enrolmentId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:manageParticipants');
    const input = await readBody(c, z.object({ role: courseRoleSchema.optional(), status: z.enum(['active', 'suspended']).optional() }));
    const enrolment = await db
      .selectFrom('enrolments')
      .selectAll()
      .where('id', '=', c.req.param('enrolmentId'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!enrolment) throw notFound('Participant');
    if (enrolment.userId === user.id && user.role !== 'admin') throw badRequest("You can't change your own enrolment.");
    await db.updateTable('enrolments').set(input).where('id', '=', enrolment.id).execute();
    return c.json({ ok: true });
  });

  r.delete('/:courseId/participants/:enrolmentId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:manageParticipants');
    const enrolment = await db
      .selectFrom('enrolments')
      .selectAll()
      .where('id', '=', c.req.param('enrolmentId'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!enrolment) throw notFound('Participant');
    if (enrolment.userId === user.id && user.role !== 'admin') throw badRequest("You can't remove yourself from the course.");
    await db.deleteFrom('enrolments').where('id', '=', enrolment.id).execute();
    events.emit('enrolment.deleted', { courseId: access.course.id, userId: enrolment.userId });
    return c.json({ ok: true });
  });

  r.get('/:courseId/announcements', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:view');
    const rows = await db
      .selectFrom('announcements')
      .innerJoin('users', 'users.id', 'announcements.userId')
      .select([
        'announcements.id',
        'announcements.title',
        'announcements.body',
        'announcements.createdAt',
        'users.id as userId',
        'users.name as userName',
        'users.avatarUrl as userAvatarUrl',
      ])
      .where('announcements.courseId', '=', access.course.id)
      .orderBy('announcements.createdAt', 'desc')
      .limit(50)
      .execute();
    const items: Announcement[] = rows.map((row) => ({
      id: row.id,
      course: toCourseRef(access.course),
      title: row.title,
      body: row.body,
      author: { id: row.userId, name: row.userName, avatarUrl: row.userAvatarUrl },
      createdAt: row.createdAt,
    }));
    return c.json(items);
  });

  r.post('/:courseId/announcements', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'announcement:post');
    assertWritable(access);
    const input = await readBody(
      c,
      z.object({ title: z.string().trim().min(1, 'Add a title').max(200), body: markdownSchema(50_000).min(1, 'Write a message') }),
    );
    const row = { id: newId(), courseId: access.course.id, userId: user.id, title: input.title, body: input.body, createdAt: now() };
    await db.insertInto('announcements').values(row).execute();
    const recipients = (await courseMemberIds(db, access.course.id, ['student', 'assistant', 'teacher'])).filter((id) => id !== user.id);
    await notify(db, recipients, {
      type: 'announcement',
      title: `${access.course.title}: ${input.title}`,
      body: input.body.slice(0, 200),
      link: `/courses/${access.course.slug}/announcements`,
    });
    events.emit('announcement.created', { announcementId: row.id, courseId: access.course.id, userId: user.id });
    const announcement: Announcement = {
      id: row.id,
      course: toCourseRef(access.course),
      title: row.title,
      body: row.body,
      author: toPublicUser(user),
      createdAt: row.createdAt,
    };
    return c.json(announcement, 201);
  });

  r.delete('/:courseId/announcements/:id', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'announcement:post');
    await db.deleteFrom('announcements').where('id', '=', c.req.param('id')).where('courseId', '=', access.course.id).execute();
    return c.json({ ok: true });
  });

  return r;
}
