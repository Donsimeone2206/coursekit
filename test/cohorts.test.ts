import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CohortDetail, CohortLink, CohortMembersAdded, Participant } from '../src/shared/types.js';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import type { CoursekitEvents, Coursekit } from '../src/server/index.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let base: string;
let ids: { sam: string; kim: string; teacher: string };

const idOf = async (client: Client): Promise<string> => (await client.get('/api/auth/session')).body.user.id;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** DELETE the way a browser sends it: with an Origin header, which the CSRF check requires for body-less requests. */
async function del(client: Client, path: string): Promise<{ status: number; body: any }> {
  const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: client.cookie, origin: 'http://localhost' } });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  base = `/api/courses/${school.course.id}`;
  ids = { sam: await idOf(school.sam), kim: await idOf(school.kim), teacher: await idOf(school.teacher) };
});
afterEach(async () => {
  await lms.close();
});

async function createCohort(name: string, emails: string[] = []): Promise<string> {
  const res = await school.admin.post<CohortDetail>('/api/admin/cohorts', { name });
  expect(res.status).toBe(201);
  if (emails.length) await school.admin.post(`/api/admin/cohorts/${res.body.id}/members`, { emails });
  return res.body.id;
}

async function participants(client = school.teacher) {
  return (await client.get<Participant[]>(`${base}/participants`)).body;
}

function link(cohortId: string, role = 'student', client = school.teacher) {
  return client.post<{ link: CohortLink; enrolled: number }>(`${base}/cohorts`, { cohortId, role });
}

describe('managing cohorts', () => {
  it('is for administrators only', async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev']);
    for (const who of [school.teacher, school.sam]) {
      expect((await who.get('/api/admin/cohorts')).status).toBe(403);
      expect((await who.post('/api/admin/cohorts', { name: 'Mine' })).status).toBe(403);
      expect((await who.get(`/api/admin/cohorts/${id}/members`)).status).toBe(403);
      expect((await who.post(`/api/admin/cohorts/${id}/members`, { emails: ['kim@test.dev'] })).status).toBe(403);
      expect((await del(who, `/api/admin/cohorts/${id}`)).status).toBe(403);
    }
    expect((await school.admin.get('/api/admin/cohorts')).body.total).toBe(1);
  });

  it('creates, renames, searches and deletes cohorts with unique names', async () => {
    const id = await createCohort('Class of 2027');
    expect((await school.admin.post('/api/admin/cohorts', { name: 'CLASS OF 2027' })).status).toBe(409);
    expect((await school.admin.post('/api/admin/cohorts', { name: '' })).status).toBe(400);
    await createCohort('Staff');

    const renamed = await school.admin.patch<CohortDetail>(`/api/admin/cohorts/${id}`, {
      name: 'Class of 2028',
      description: 'Year group',
    });
    expect(renamed.body).toMatchObject({ name: 'Class of 2028', description: 'Year group', memberCount: 0, courseCount: 0 });
    expect((await school.admin.patch(`/api/admin/cohorts/${id}`, { name: 'staff' })).status).toBe(409);

    const search = await school.admin.get('/api/admin/cohorts?q=2028');
    expect(search.body.items.map((c: { name: string }) => c.name)).toEqual(['Class of 2028']);
    expect((await del(school.admin, `/api/admin/cohorts/${id}`)).status).toBe(200);
    expect((await school.admin.get(`/api/admin/cohorts/${id}`)).status).toBe(404);
  });

  it('adds people by email and by id, reporting duplicates, unknown and invalid entries', async () => {
    const id = await createCohort('Class of 2027');
    const first = await school.admin.post<CohortMembersAdded>(`/api/admin/cohorts/${id}/members`, {
      emails: ['sam@test.dev', ' KIM@test.dev ', 'kim@test.dev', 'nobody@test.dev', 'not-an-email', ''],
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ added: 2, alreadyMembers: [], notFound: ['nobody@test.dev'], invalid: ['not-an-email'], enrolled: 0 });

    const again = await school.admin.post<CohortMembersAdded>(`/api/admin/cohorts/${id}/members`, {
      emails: ['sam@test.dev'],
      userIds: [ids.teacher, 'missing-id'],
    });
    expect(again.body).toMatchObject({ added: 1, alreadyMembers: ['sam@test.dev'], notFound: ['missing-id'] });
    expect((await school.admin.post(`/api/admin/cohorts/${id}/members`, { emails: [' '] })).status).toBe(400);

    const members = await school.admin.get(`/api/admin/cohorts/${id}/members`);
    expect(members.body.total).toBe(3);
    expect(members.body.items.map((m: { email: string }) => m.email)).toEqual(['kim@test.dev', 'sam@test.dev', 'teacher@test.dev']);
    expect((await school.admin.get(`/api/admin/cohorts/${id}/members?q=SAM`)).body.items).toHaveLength(1);

    const candidates = await school.admin.get(`/api/admin/cohorts/${id}/candidates?q=student`);
    expect(candidates.body.map((c: { email: string; member: boolean }) => [c.email, c.member])).toEqual([
      ['kim@test.dev', true],
      ['sam@test.dev', true],
    ]);
    const admin = await school.admin.get(`/api/admin/cohorts/${id}/candidates?q=admin`);
    expect(admin.body).toMatchObject([{ email: 'admin@test.dev', member: false }]);

    expect((await del(school.admin, `/api/admin/cohorts/${id}/members/${ids.sam}`)).status).toBe(200);
    expect((await del(school.admin, `/api/admin/cohorts/${id}/members/${ids.sam}`)).status).toBe(404);
  });
});

describe('cohort enrolment', () => {
  it('enrols every member through the normal enrolment path, with notifications and events', async () => {
    const created: Array<CoursekitEvents['enrolment.created']> = [];
    lms.events.on('enrolment.created', (e) => void created.push(e));
    const id = await createCohort('Class of 2027', ['sam@test.dev', 'kim@test.dev']);

    const res = await link(id);
    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(2);
    expect(res.body.link).toMatchObject({ cohort: { id, name: 'Class of 2027', memberCount: 2 }, role: 'student' });

    const people = await participants();
    expect(
      people
        .filter((p) => p.role === 'student')
        .map((p) => p.user.id)
        .sort(),
    ).toEqual([ids.sam, ids.kim].sort());
    const notes = await school.kim.get('/api/notifications');
    expect(notes.body.unreadCount).toBe(1);
    expect(notes.body.items[0]).toMatchObject({ type: 'enrolment', title: 'You were added to Testing 101' });
    expect(notes.body.items[0].body).toBe('Tina Teacher enrolled you as a student through the cohort Class of 2027.');
    await tick();
    expect(created.map((e) => [e.userId, e.role]).sort()).toEqual(
      [
        [ids.sam, 'student'],
        [ids.kim, 'student'],
      ].sort(),
    );

    const linked = await school.teacher.get<CohortLink[]>(`${base}/cohorts`);
    expect(linked.body.map((l) => [l.cohort.name, l.role, l.course.id])).toEqual([['Class of 2027', 'student', school.course.id]]);
  });

  it('enrols people who join the cohort later', async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev']);
    await link(id);
    const other = await school.teacher.post('/api/courses', { title: 'Second course', visibility: 'published' });
    await school.teacher.post(`/api/courses/${other.body.id}/cohorts`, { cohortId: id, role: 'assistant' });

    const later = await school.admin.post<CohortMembersAdded>(`/api/admin/cohorts/${id}/members`, { userIds: [ids.kim] });
    expect(later.body).toMatchObject({ added: 1, enrolled: 2 });
    expect((await participants()).find((p) => p.user.id === ids.kim)?.role).toBe('student');
    const second = await school.teacher.get<Participant[]>(`/api/courses/${other.body.id}/participants`);
    expect(second.body.find((p) => p.user.id === ids.kim)?.role).toBe('assistant');
    const notes = await school.kim.get('/api/notifications');
    expect(notes.body.items.map((n: { title: string }) => n.title).sort()).toEqual([
      'You were added to Second course',
      'You were added to Testing 101',
    ]);
  });

  it('leaves existing enrolments as they are, whatever their role or status', async () => {
    await school.sam.post(`${base}/enrol`);
    const sam = (await participants()).find((p) => p.user.id === ids.sam)!;
    await school.teacher.patch(`${base}/participants/${sam.enrolmentId}`, { status: 'suspended' });
    const id = await createCohort('Everyone', ['sam@test.dev', 'teacher@test.dev', 'kim@test.dev']);

    const res = await link(id, 'student');
    expect(res.body.enrolled).toBe(1);
    const people = await participants();
    expect(people.find((p) => p.user.id === ids.teacher)?.role).toBe('teacher');
    expect(people.find((p) => p.user.id === ids.sam)?.status).toBe('suspended');
    expect(people.find((p) => p.user.id === ids.kim)).toMatchObject({ role: 'student', status: 'active' });
  });

  it('rejects linking the same cohort twice and only offers unlinked cohorts', async () => {
    const id = await createCohort('Class of 2027');
    const other = await createCohort('Staff');
    expect((await link(id)).status).toBe(201);
    const dupe = await link(id, 'assistant');
    expect(dupe.status).toBe(409);
    const available = await school.teacher.get(`${base}/cohorts/available`);
    expect(available.body).toEqual([{ id: other, name: 'Staff', memberCount: 0 }]);
    expect((await link('no-such-cohort')).status).toBe(404);
    expect((await school.teacher.post(`${base}/cohorts`, { cohortId: id, role: 'owner' })).status).toBe(400);
  });

  it('keeps enrolments when a cohort is unlinked, and stops enrolling new members', async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev']);
    const linked = await link(id);
    expect((await del(school.teacher, `${base}/cohorts/${linked.body.link.id}`)).status).toBe(200);
    expect((await school.teacher.get(`${base}/cohorts`)).body).toEqual([]);
    expect((await participants()).some((p) => p.user.id === ids.sam)).toBe(true);

    const later = await school.admin.post(`/api/admin/cohorts/${id}/members`, { emails: ['kim@test.dev'] });
    expect(later.body.enrolled).toBe(0);
    expect((await participants()).some((p) => p.user.id === ids.kim)).toBe(false);
    expect((await del(school.teacher, `${base}/cohorts/${linked.body.link.id}`)).status).toBe(404);
  });

  it('keeps enrolments when someone leaves the cohort or the cohort is deleted', async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev', 'kim@test.dev']);
    await link(id);
    await del(school.admin, `/api/admin/cohorts/${id}/members/${ids.sam}`);
    await del(school.admin, `/api/admin/cohorts/${id}`);
    expect((await school.teacher.get(`${base}/cohorts`)).body).toEqual([]);
    const people = await participants();
    expect(people.filter((p) => p.role === 'student')).toHaveLength(2);
  });

  it('re-enrols members a teacher removed when the link is synced', async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev']);
    const linked = await link(id);
    const sam = (await participants()).find((p) => p.user.id === ids.sam)!;
    await del(school.teacher, `${base}/participants/${sam.enrolmentId}`);
    const synced = await school.teacher.post(`${base}/cohorts/${linked.body.link.id}/sync`);
    expect(synced.body).toEqual({ enrolled: 1 });
    expect((await school.teacher.post(`${base}/cohorts/${linked.body.link.id}/sync`)).body).toEqual({ enrolled: 0 });
  });

  it('only lets people who manage participants link cohorts', async () => {
    const id = await createCohort('Class of 2027', ['kim@test.dev']);
    await school.sam.post(`${base}/enrol`);
    expect((await school.sam.get(`${base}/cohorts`)).status).toBe(403);
    expect((await school.sam.get(`${base}/cohorts/available`)).status).toBe(403);
    expect((await link(id, 'student', school.sam)).status).toBe(403);

    // Teaching assistants can manage groups but not participants.
    await lms.createUser({ name: 'Ann Assistant', email: 'ann@test.dev', password: PASSWORD });
    await school.teacher.post(`${base}/participants`, { emails: ['ann@test.dev'], role: 'assistant' });
    const ann = await login(lms, 'ann@test.dev');
    expect((await link(id, 'student', ann)).status).toBe(403);

    // Administrators can, in any course, without being enrolled.
    const res = await link(id, 'student', school.admin);
    expect(res.status).toBe(201);
    const linkId = res.body.link.id;
    expect((await del(school.sam, `${base}/cohorts/${linkId}`)).status).toBe(403);
    expect((await school.sam.post(`${base}/cohorts/${linkId}/sync`)).status).toBe(403);
  });

  it("shows a cohort's linked courses to administrators", async () => {
    const id = await createCohort('Class of 2027', ['sam@test.dev']);
    await link(id, 'assistant');
    const detail = await school.admin.get<CohortDetail>(`/api/admin/cohorts/${id}`);
    expect(detail.body).toMatchObject({ name: 'Class of 2027', memberCount: 1, courseCount: 1 });
    expect(detail.body.links.map((l) => [l.course.slug, l.role])).toEqual([[school.course.slug, 'assistant']]);
  });

  it('enrols a large cohort in one go', async () => {
    const id = await createCohort('Big cohort');
    const emails = Array.from({ length: 450 }, (_, i) => `bulk${i}@test.dev`);
    for (const [i, email] of emails.entries()) await lms.createUser({ name: `Bulk ${i}`, email });
    const added = await school.admin.post<CohortMembersAdded>(`/api/admin/cohorts/${id}/members`, { emails });
    expect(added.body.added).toBe(450);
    const linked = await link(id);
    expect(linked.body.enrolled).toBe(450);
    expect((await participants()).filter((p) => p.role === 'student')).toHaveLength(450);
  });
});

describe('upgrading from 0.1.x', () => {
  it('adds the group and cohort tables without touching existing data', async () => {
    const { db } = await createDatabase('sqlite::memory:');
    try {
      const old = new Migrator({
        db: db.withoutPlugins(),
        provider: { getMigrations: async () => ({ '001_initial': migrations['001_initial']! }) },
      });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      // A 0.1.x site's rows, written with the 0.1.x columns only.
      const v01 = db.withoutPlugins() as unknown as Kysely<any>;
      const ts = new Date().toISOString();
      await v01
        .insertInto('users')
        .values({ id: 'u1', email: 'old@test.dev', name: 'Old User', role: 'student', status: 'active', created_at: ts, updated_at: ts })
        .execute();
      await v01
        .insertInto('courses')
        .values({ id: 'c1', slug: 'old-course', title: 'Old course', created_by: 'u1', created_at: ts, updated_at: ts })
        .execute();
      await v01
        .insertInto('enrolments')
        .values({ id: 'e1', course_id: 'c1', user_id: 'u1', role: 'student', status: 'active', created_at: ts })
        .execute();

      const results = await migrateToLatest(db);
      expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['003_groups_cohorts', 'Success']);
      expect(await db.selectFrom('users').select(['id', 'email', 'name', 'role']).execute()).toEqual([
        { id: 'u1', email: 'old@test.dev', name: 'Old User', role: 'student' },
      ]);
      expect(await db.selectFrom('enrolments').select(['id', 'role']).execute()).toEqual([{ id: 'e1', role: 'student' }]);

      await db
        .insertInto('courseGroups')
        .values({ id: 'g1', courseId: 'c1', name: 'Team', description: '', createdAt: ts, updatedAt: ts })
        .execute();
      await db.insertInto('courseGroupMembers').values({ groupId: 'g1', userId: 'u1', courseId: 'c1', createdAt: ts }).execute();
      await expect(
        db
          .insertInto('courseGroups')
          .values({ id: 'g2', courseId: 'c1', name: 'TEAM', description: '', createdAt: ts, updatedAt: ts })
          .execute(),
      ).rejects.toThrow();
      await db.insertInto('cohorts').values({ id: 'h1', name: 'Cohort', description: '', createdAt: ts, updatedAt: ts }).execute();
      await db
        .insertInto('cohortCourses')
        .values({ id: 'l1', cohortId: 'h1', courseId: 'c1', role: 'student', createdBy: 'u1', createdAt: ts })
        .execute();

      // Deleting the course removes its groups and links (but not the cohort).
      await db.deleteFrom('courses').where('id', '=', 'c1').execute();
      expect(await db.selectFrom('courseGroupMembers').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('cohortCourses').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('cohorts').select('id').execute()).toEqual([{ id: 'h1' }]);

      // The migration can be rolled back and applied again.
      const full = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => migrations } });
      const down = await full.migrateDown();
      expect(down.error).toBeUndefined();
      expect((await full.migrateToLatest()).error).toBeUndefined();
      expect(await db.selectFrom('users').select('id').execute()).toEqual([{ id: 'u1' }]);
    } finally {
      await db.destroy();
    }
  });
});
