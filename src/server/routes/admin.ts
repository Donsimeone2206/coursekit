import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminCourseRow, AdminOverview, AdminUserRow, Paginated, PublicUser } from '../../shared/types.js';
import { endSession, startSession } from '../auth/session.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import { badRequest, conflict, forbidden, notFound, readBody, readQuery } from '../lib/http.js';
import { hashPassword } from '../lib/password.js';
import { emailSchema, nameSchema, pageSchema, passwordSchema, siteRoleSchema } from '../lib/schemas.js';
import { addDays, likePattern, now, num, randomToken } from '../lib/util.js';
import { toCourseRef, toUser } from '../services/serialize.js';
import { getSiteSettings, updateSiteSettings } from '../services/settings.js';
import { createUser, normalizeEmail } from '../services/users.js';

export function adminRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.use('*', async (c, next) => {
    requireAdmin(c);
    await next();
  });

  r.get('/overview', async (c) => {
    const count = async (table: 'users' | 'courses' | 'enrolments' | 'activities' | 'submissions' | 'posts') => {
      const row = await db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
      return num(row?.n);
    };
    const [users, courses, enrolments, activities, submissions, posts] = await Promise.all([
      count('users'),
      count('courses'),
      count('enrolments'),
      count('activities'),
      count('submissions'),
      count('posts'),
    ]);

    const since = addDays(new Date(), -29);
    since.setUTCHours(0, 0, 0, 0);
    const recent = await db.selectFrom('users').select('createdAt').where('createdAt', '>=', since.toISOString()).execute();
    const buckets = new Map<string, number>();
    for (let i = 0; i < 30; i++) buckets.set(addDays(since, i).toISOString().slice(0, 10), 0);
    for (const u of recent) {
      const day = u.createdAt.slice(0, 10);
      if (buckets.has(day)) buckets.set(day, buckets.get(day)! + 1);
    }

    const top = await db
      .selectFrom('courses')
      .leftJoin('enrolments', (join) =>
        join.onRef('enrolments.courseId', '=', 'courses.id').on('enrolments.role', '=', 'student').on('enrolments.status', '=', 'active'),
      )
      .select(['courses.id', 'courses.slug', 'courses.title', 'courses.coverColor', (eb) => eb.fn.count('enrolments.id').as('students')])
      .groupBy(['courses.id', 'courses.slug', 'courses.title', 'courses.coverColor'])
      .orderBy('students', 'desc')
      .limit(5)
      .execute();

    const recentUsers = await db.selectFrom('users').selectAll().orderBy('createdAt', 'desc').limit(6).execute();

    const overview: AdminOverview = {
      counts: { users, courses, enrolments, activities, submissions, posts },
      signups: [...buckets].map(([date, n]) => ({ date, count: n })),
      topCourses: top.map((t) => ({ ...toCourseRef(t), students: num(t.students) })),
      recentUsers: recentUsers.map(toUser),
      database: deps.dbKind === 'postgres' ? 'PostgreSQL' : 'SQLite',
      version: deps.version,
    };
    return c.json(overview);
  });

  r.get('/users', async (c) => {
    const q = readQuery(
      c,
      z.object({
        q: z.string().max(100).optional(),
        role: siteRoleSchema.optional(),
        status: z.enum(['active', 'suspended']).optional(),
        ...pageSchema,
      }),
    );
    let query = db.selectFrom('users');
    if (q.q?.trim()) {
      const pattern = likePattern(q.q);
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['name']), 'like', pattern), eb('email', 'like', pattern)]));
    }
    if (q.role) query = query.where('role', '=', q.role);
    if (q.status) query = query.where('status', '=', q.status);

    const totalRow = await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
    const rows = await query
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute();

    const ids = rows.map((u) => u.id);
    const counts = ids.length
      ? await db
          .selectFrom('enrolments')
          .select(['userId', (eb) => eb.fn.countAll().as('n')])
          .where('userId', 'in', ids)
          .groupBy('userId')
          .execute()
      : [];
    const countMap = new Map(counts.map((r) => [r.userId, num(r.n)]));

    const result: Paginated<AdminUserRow> = {
      items: rows.map((u) => ({ ...toUser(u), courseCount: countMap.get(u.id) ?? 0 })),
      total: num(totalRow?.n),
      page: q.page,
      pageSize: q.pageSize,
    };
    return c.json(result);
  });

  r.post('/users', async (c) => {
    const input = await readBody(
      c,
      z.object({
        name: nameSchema,
        email: emailSchema,
        role: siteRoleSchema.default('student'),
        password: passwordSchema.optional(),
      }),
    );
    const temporaryPassword = input.password ? null : randomToken(9);
    const user = await createUser(deps, {
      name: input.name,
      email: input.email,
      role: input.role,
      password: input.password ?? temporaryPassword,
    });
    return c.json({ user: toUser(user), temporaryPassword }, 201);
  });

  r.patch('/users/:id', async (c) => {
    const me = requireUser(c);
    const id = c.req.param('id');
    const input = await readBody(
      c,
      z.object({
        name: nameSchema.optional(),
        email: emailSchema.optional(),
        role: siteRoleSchema.optional(),
        status: z.enum(['active', 'suspended']).optional(),
        password: passwordSchema.optional(),
      }),
    );
    const user = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!user) throw notFound('User');
    if (id === me.id && ((input.role && input.role !== 'admin') || input.status === 'suspended')) {
      throw badRequest("You can't remove your own administrator access.");
    }
    if (input.email) {
      const email = normalizeEmail(input.email);
      const taken = await db.selectFrom('users').select('id').where('email', '=', email).where('id', '!=', id).executeTakeFirst();
      if (taken) throw conflict('Another account already uses this email.');
      input.email = email;
    }
    const { password, ...rest } = input;
    await db
      .updateTable('users')
      .set({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}), updatedAt: now() })
      .where('id', '=', id)
      .execute();
    if (input.status === 'suspended' || password) await db.deleteFrom('sessions').where('userId', '=', id).execute();
    const updated = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return c.json(toUser(updated));
  });

  r.delete('/users/:id', async (c) => {
    const me = requireUser(c);
    const id = c.req.param('id');
    if (id === me.id) throw badRequest("You can't delete your own account.");
    const result = await db.deleteFrom('users').where('id', '=', id).executeTakeFirst();
    if (num(result.numDeletedRows) === 0) throw notFound('User');
    return c.json({ ok: true });
  });

  /** "Log in as": start a session as another user. The admin can return with /auth/stop-impersonating. */
  r.post('/users/:id/impersonate', async (c) => {
    const me = requireUser(c);
    const target = await db.selectFrom('users').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!target) throw notFound('User');
    if (target.id === me.id) throw badRequest('You are already signed in as this user.');
    if (target.role === 'admin') throw forbidden("You can't log in as another administrator.");
    if (target.status !== 'active') throw badRequest('This account is suspended.');
    await endSession(c, deps, { replacing: true });
    await startSession(c, deps, target, me.id);
    return c.json({ ok: true });
  });

  r.get('/settings', async (c) => c.json(await getSiteSettings(db)));

  r.put('/settings', async (c) => {
    const input = await readBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        tagline: z.string().trim().max(160).optional(),
        brandColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #4f46e5')
          .optional(),
        allowSignup: z.boolean().optional(),
        welcomeMessage: z.string().trim().max(300).optional(),
      }),
    );
    return c.json(await updateSiteSettings(db, input));
  });

  r.get('/courses', async (c) => {
    const q = readQuery(c, z.object({ q: z.string().max(100).optional(), ...pageSchema }));
    let query = db.selectFrom('courses').leftJoin('categories', 'categories.id', 'courses.categoryId');
    if (q.q?.trim()) query = query.where((eb) => eb(eb.fn('lower', ['courses.title']), 'like', likePattern(q.q!)));
    const totalRow = await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
    const rows = await query
      .select([
        'courses.id',
        'courses.slug',
        'courses.title',
        'courses.coverColor',
        'courses.visibility',
        'courses.createdAt',
        'categories.name as categoryName',
      ])
      .orderBy('courses.createdAt', 'desc')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute();

    const ids = rows.map((r) => r.id);
    const [teacherRows, studentRows] = ids.length
      ? await Promise.all([
          db
            .selectFrom('enrolments')
            .innerJoin('users', 'users.id', 'enrolments.userId')
            .select(['enrolments.courseId', 'users.id', 'users.name', 'users.avatarUrl'])
            .where('enrolments.courseId', 'in', ids)
            .where('enrolments.role', '=', 'teacher')
            .execute(),
          db
            .selectFrom('enrolments')
            .select(['courseId', (eb) => eb.fn.countAll().as('n')])
            .where('courseId', 'in', ids)
            .where('role', '=', 'student')
            .groupBy('courseId')
            .execute(),
        ])
      : [[], []];
    const teachers = new Map<string, PublicUser[]>();
    for (const t of teacherRows)
      teachers.set(t.courseId, [...(teachers.get(t.courseId) ?? []), { id: t.id, name: t.name, avatarUrl: t.avatarUrl }]);
    const students = new Map(studentRows.map((s) => [s.courseId, num(s.n)]));

    const result: Paginated<AdminCourseRow> = {
      items: rows.map((row) => ({
        ...toCourseRef(row),
        visibility: row.visibility,
        categoryName: row.categoryName ?? null,
        teachers: teachers.get(row.id) ?? [],
        studentCount: students.get(row.id) ?? 0,
        createdAt: row.createdAt,
      })),
      total: num(totalRow?.n),
      page: q.page,
      pageSize: q.pageSize,
    };
    return c.json(result);
  });

  return r;
}
