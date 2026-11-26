import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CourseGroups, Participant } from '../src/shared/types.js';
import type { Coursekit } from '../src/server/index.js';
import { planGroups } from '../src/server/services/groups.js';
import { groupNames, letters } from '../src/shared/groups.js';
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
  await school.sam.post(`${base}/enrol`);
  await school.kim.post(`${base}/enrol`);
  ids = { sam: await idOf(school.sam), kim: await idOf(school.kim), teacher: await idOf(school.teacher) };
});
afterEach(async () => {
  await lms.close();
});

/** Creates students and enrols them in the test course. */
async function enrolStudents(count: number): Promise<string[]> {
  const emails: string[] = [];
  for (let i = 0; i < count; i++) {
    const email = `student${i}@test.dev`;
    await lms.createUser({ name: `Student ${String(i).padStart(2, '0')}`, email, password: PASSWORD });
    emails.push(email);
  }
  const res = await school.teacher.post(`${base}/participants`, { emails, role: 'student' });
  expect(res.body.added).toBe(count);
  const participants = await school.teacher.get<Participant[]>(`${base}/participants`);
  return participants.body.filter((p) => p.role === 'student').map((p) => p.user.id);
}

async function createGroup(name: string, client = school.teacher): Promise<string> {
  const res = await client.post(`${base}/groups`, { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function groups(client = school.teacher) {
  return (await client.get<CourseGroups>(`${base}/groups`)).body;
}

describe('managing groups', () => {
  it('lets teachers create, rename and delete groups', async () => {
    const created = await school.teacher.post(`${base}/groups`, { name: '  Team Aurora ', description: 'Project team' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Team Aurora', description: 'Project team', members: [] });

    const renamed = await school.teacher.patch(`${base}/groups/${created.body.id}`, { name: 'Team Borealis' });
    expect(renamed.body.name).toBe('Team Borealis');
    const list = await groups();
    expect(list).toMatchObject({ canManage: true, allGroups: true });
    expect(list.groups.map((g) => g.name)).toEqual(['Team Borealis']);

    expect((await del(school.teacher, `${base}/groups/${created.body.id}`)).status).toBe(200);
    expect((await groups()).groups).toEqual([]);
    expect((await del(school.teacher, `${base}/groups/${created.body.id}`)).status).toBe(404);
  });

  it('validates names and keeps them unique in the course, ignoring case', async () => {
    expect((await school.teacher.post(`${base}/groups`, { name: '   ' })).status).toBe(400);
    const a = await createGroup('Team A');
    const b = await createGroup('Team B');
    const dupe = await school.teacher.post(`${base}/groups`, { name: 'team a' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('conflict');
    expect((await school.teacher.patch(`${base}/groups/${b}`, { name: 'TEAM A' })).status).toBe(409);
    expect((await school.teacher.patch(`${base}/groups/${a}`, { name: 'Team A', description: 'Same name is fine' })).status).toBe(200);

    // Another course may reuse the name.
    const other = await school.teacher.post('/api/courses', { title: 'Other course' });
    expect((await school.teacher.post(`/api/courses/${other.body.id}/groups`, { name: 'Team A' })).status).toBe(201);
  });

  it('adds enrolled people only, reports duplicates and lets a person be in several groups', async () => {
    await lms.createUser({ name: 'Out Sider', email: 'outsider@test.dev', password: PASSWORD });
    const outsider = await idOf(await login(lms, 'outsider@test.dev'));
    const a = await createGroup('Team A');
    const b = await createGroup('Team B');

    const first = await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam, ids.kim, outsider, ids.sam] });
    expect(first.status).toBe(200);
    expect(first.body.added.sort()).toEqual([ids.sam, ids.kim].sort());
    expect(first.body.notEnrolled).toEqual([outsider]);
    expect(first.body.alreadyMembers).toEqual([]);

    const again = await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam] });
    expect(again.body).toMatchObject({ added: [], alreadyMembers: [ids.sam], notEnrolled: [] });
    expect((await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [] })).status).toBe(400);

    await school.teacher.post(`${base}/groups/${b}/members`, { userIds: [ids.sam] });
    const participants = await school.teacher.get<Participant[]>(`${base}/participants`);
    const sam = participants.body.find((p) => p.user.id === ids.sam)!;
    expect(sam.groups!.map((g) => g.name)).toEqual(['Team A', 'Team B']);

    expect((await del(school.teacher, `${base}/groups/${a}/members/${ids.kim}`)).status).toBe(200);
    expect((await del(school.teacher, `${base}/groups/${a}/members/${ids.kim}`)).status).toBe(404);
    const list = await groups();
    expect(list.groups.find((g) => g.id === a)!.members.map((m) => m.id)).toEqual([ids.sam]);
  });

  it('emits events for group changes', async () => {
    const seen: string[] = [];
    lms.events.onAny((event) => {
      if (event.startsWith('group.')) seen.push(event);
    });
    const a = await createGroup('Team A');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam] });
    await del(school.teacher, `${base}/groups/${a}/members/${ids.sam}`);
    await school.teacher.patch(`${base}/groups/${a}`, { description: 'New' });
    await del(school.teacher, `${base}/groups/${a}`);
    await tick();
    expect(seen).toEqual(['group.created', 'group.member.added', 'group.member.removed', 'group.updated', 'group.deleted']);
  });

  it('keeps groups inside their own course', async () => {
    const other = await school.teacher.post('/api/courses', { title: 'Other course' });
    const foreign = await school.teacher.post(`/api/courses/${other.body.id}/groups`, { name: 'Elsewhere' });
    expect((await school.teacher.patch(`${base}/groups/${foreign.body.id}`, { name: 'Moved' })).status).toBe(404);
    expect((await school.teacher.post(`${base}/groups/${foreign.body.id}/members`, { userIds: [ids.sam] })).status).toBe(404);
    expect((await del(school.teacher, `${base}/groups/${foreign.body.id}`)).status).toBe(404);
    expect((await school.teacher.get(`${base}/participants?groupId=${foreign.body.id}`)).status).toBe(404);
  });

  it('lets teaching assistants see every group, but only teachers change them', async () => {
    const id = await createGroup('Teacher group');
    const participants = await school.teacher.get<Participant[]>(`${base}/participants`);
    const kim = participants.body.find((p) => p.user.id === ids.kim)!;
    await school.teacher.patch(`${base}/participants/${kim.enrolmentId}`, { role: 'assistant' });
    const course = await school.kim.get(base);
    expect(course.body.capabilities).not.toContain('course:manageGroups');
    const list = await school.kim.get(`${base}/groups`);
    expect(list.body.canManage).toBe(false);
    expect(list.body.groups.map((g: { id: string }) => g.id)).toContain(id);
    const refused = await school.kim.post(`${base}/groups`, { name: 'Assistant group' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('Only teachers can change groups.');
    expect((await school.kim.post(`${base}/groups/${id}/members`, { userIds: [ids.sam] })).status).toBe(403);
  });

  it('lets administrators manage groups in any course', async () => {
    const id = await createGroup('Admin group', school.admin);
    expect((await school.admin.post(`${base}/groups/${id}/members`, { userIds: [ids.kim] })).body.added).toEqual([ids.kim]);
  });
});

describe('what students see', () => {
  let lee: Client;
  let leeId: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    await lms.createUser({ name: 'Lee Student', email: 'lee@test.dev', password: PASSWORD });
    lee = await login(lms, 'lee@test.dev');
    await lee.post(`${base}/enrol`);
    leeId = await idOf(lee);
    a = await createGroup('Team A');
    b = await createGroup('Team B');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam, leeId] });
    await school.teacher.post(`${base}/groups/${b}/members`, { userIds: [ids.kim] });
  });

  it('does not let students manage groups', async () => {
    expect((await school.sam.post(`${base}/groups`, { name: 'Mine' })).status).toBe(403);
    expect((await school.sam.patch(`${base}/groups/${a}`, { name: 'Renamed' })).status).toBe(403);
    expect((await del(school.sam, `${base}/groups/${a}`)).status).toBe(403);
    expect((await school.sam.post(`${base}/groups/${b}/members`, { userIds: [ids.sam] })).status).toBe(403);
    expect((await del(school.sam, `${base}/groups/${a}/members/${leeId}`)).status).toBe(403);
    expect((await school.sam.post(`${base}/groups/auto`, { split: 'groups', size: 2 })).status).toBe(403);
    expect((await groups()).groups.find((g) => g.id === a)!.members).toHaveLength(2);
  });

  it('shows students only their own groups and who is in them', async () => {
    const mine = await groups(school.sam);
    expect(mine).toMatchObject({ canManage: false, allGroups: false });
    expect(mine.groups.map((g) => g.name)).toEqual(['Team A']);
    expect(mine.groups[0]!.members.map((m) => m.id).sort()).toEqual([ids.sam, leeId].sort());
    expect(JSON.stringify(mine)).not.toContain(ids.kim);

    const course = await school.sam.get(base);
    expect(course.body.myGroups).toEqual([{ id: a, name: 'Team A' }]);
    expect((await school.kim.get(base)).body.myGroups).toEqual([{ id: b, name: 'Team B' }]);
  });

  it("doesn't reveal other groups' memberships on the participants page", async () => {
    const list = await school.sam.get<Participant[]>(`${base}/participants`);
    const byId = new Map(list.body.map((p) => [p.user.id, p]));
    expect(byId.get(leeId)!.groups).toEqual([{ id: a, name: 'Team A' }]);
    expect(byId.get(ids.kim)!.groups).toEqual([]);

    expect((await school.sam.get(`${base}/participants?groupId=${b}`)).status).toBe(404);
    const filtered = await school.sam.get<Participant[]>(`${base}/participants?groupId=${a}`);
    expect(filtered.body.map((p) => p.user.id).sort()).toEqual([ids.sam, leeId].sort());
  });

  it('keeps people who are not enrolled out of the groups page', async () => {
    await lms.createUser({ name: 'Visitor', email: 'visitor@test.dev', password: PASSWORD });
    const visitor = await login(lms, 'visitor@test.dev');
    expect((await visitor.get(`${base}/groups`)).status).toBe(403);
  });

  it('hides people who leave the course and brings them back when they re-enrol', async () => {
    await lee.post(`${base}/leave`);
    expect((await groups()).groups.find((g) => g.id === a)!.members.map((m) => m.id)).toEqual([ids.sam]);
    expect((await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [leeId] })).body.notEnrolled).toEqual([leeId]);
    await lee.post(`${base}/enrol`);
    expect((await groups()).groups.find((g) => g.id === a)!.members).toHaveLength(2);
  });
});

describe('filtering by group', () => {
  it('filters participants by group for staff', async () => {
    const a = await createGroup('Team A');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.kim] });
    const filtered = await school.teacher.get<Participant[]>(`${base}/participants?groupId=${a}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((p) => p.user.id)).toEqual([ids.kim]);
    expect((await school.teacher.get(`${base}/participants?groupId=nope`)).status).toBe(404);
  });

  it('filters assignment submissions by group', async () => {
    const assignment = await school.teacher.post(`${base}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'Essay',
      settings: { submissionTypes: ['text'] },
    });
    const a = await createGroup('Team A');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam] });
    const all = await school.teacher.get(`/api/activities/${assignment.body.id}/submissions`);
    expect(all.body).toHaveLength(2);
    const filtered = await school.teacher.get(`/api/activities/${assignment.body.id}/submissions?groupId=${a}`);
    expect(filtered.body.map((r: { user: { id: string } }) => r.user.id)).toEqual([ids.sam]);
    expect((await school.teacher.get(`/api/activities/${assignment.body.id}/submissions?groupId=nope`)).status).toBe(404);
    expect((await school.sam.get(`/api/activities/${assignment.body.id}/submissions?groupId=${a}`)).status).toBe(403);
  });

  it('filters the gradebook and its CSV export by group', async () => {
    await school.teacher.post(`${base}/activities`, { sectionId: school.sectionId, type: 'assignment', title: 'Essay', maxGrade: 10 });
    const a = await createGroup('Team A');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.kim] });
    const all = await school.teacher.get(`${base}/grades`);
    expect(all.body.gradebook.rows).toHaveLength(2);
    const filtered = await school.teacher.get(`${base}/grades?groupId=${a}`);
    expect(filtered.body.gradebook.rows.map((r: { user: { id: string } }) => r.user.id)).toEqual([ids.kim]);
    const csv = await lms.app.request(`${base}/grades/export.csv?groupId=${a}`, { headers: { cookie: school.teacher.cookie } });
    expect((await csv.text()).trim().split('\n')).toHaveLength(2); // header and Kim
    expect((await school.teacher.get(`${base}/grades?groupId=nope`)).status).toBe(404);
    // Students get their own grades whatever they pass.
    expect((await school.sam.get(`${base}/grades?groupId=${a}`)).body.kind).toBe('mine');
  });
});

describe('auto-creating groups', () => {
  const sizes = (list: CourseGroups) => list.groups.map((g) => g.members.length);

  it('splits the students into a number of balanced groups, at random', async () => {
    const students = await enrolStudents(10); // 12 students with Sam and Kim
    expect(students).toHaveLength(12);
    const res = await school.teacher.post(`${base}/groups/auto`, { split: 'groups', size: 5 });
    expect(res.status).toBe(201);
    expect(res.body.groups.map((g: { name: string }) => g.name)).toEqual(['Group A', 'Group B', 'Group C', 'Group D', 'Group E']);
    const list = await groups();
    expect(sizes(list).sort()).toEqual([2, 2, 3, 3, 2].sort());
    const placed = list.groups.flatMap((g) => g.members.map((m) => m.id));
    expect(placed.sort()).toEqual([...students].sort());
    expect(placed).not.toContain(ids.teacher);
  });

  it('makes groups of at most N members, with sizes that differ by at most one', async () => {
    await enrolStudents(9); // 11 students
    const res = await school.teacher.post(`${base}/groups/auto`, { split: 'members', size: 4, naming: 'Team #' });
    expect(res.body.groups.map((g: { name: string }) => g.name)).toEqual(['Team 1', 'Team 2', 'Team 3']);
    expect(sizes(await groups()).sort()).toEqual([3, 4, 4]);
  });

  it('can place only students without a group, skipping names already in use', async () => {
    const students = await enrolStudents(8); // 10 students
    const existing = await createGroup('Group A');
    await school.teacher.post(`${base}/groups/${existing}/members`, { userIds: [ids.sam, ids.kim] });
    const res = await school.teacher.post(`${base}/groups/auto`, { split: 'members', size: 4, onlyUngrouped: true });
    expect(res.status).toBe(201);
    expect(res.body.groups.map((g: { name: string; memberCount: number }) => [g.name, g.memberCount])).toEqual([
      ['Group B', 4],
      ['Group C', 4],
    ]);
    const list = await groups();
    const created = list.groups.filter((g) => g.id !== existing).flatMap((g) => g.members.map((m) => m.id));
    expect(created.sort()).toEqual(students.filter((id) => id !== ids.sam && id !== ids.kim).sort());
  });

  it('rejects splits that are not possible', async () => {
    expect((await school.teacher.post(`${base}/groups/auto`, { split: 'groups', size: 3 })).status).toBe(400);
    expect((await school.teacher.post(`${base}/groups/auto`, { split: 'groups', size: 0 })).status).toBe(400);
    expect((await school.teacher.post(`${base}/groups/auto`, { split: 'sideways', size: 2 })).status).toBe(400);
    const a = await createGroup('Everyone');
    await school.teacher.post(`${base}/groups/${a}/members`, { userIds: [ids.sam, ids.kim] });
    const none = await school.teacher.post(`${base}/groups/auto`, { split: 'groups', size: 1, onlyUngrouped: true });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe('Every student is already in a group.');
  });

  it('balances every combination of class size and split', () => {
    for (let people = 1; people <= 40; people++) {
      const list = Array.from({ length: people }, (_, i) => i);
      for (let size = 1; size <= people; size++) {
        for (const split of ['groups', 'members'] as const) {
          const plan = planGroups(list, split, size);
          const counts = plan.map((g) => g.length);
          expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
          expect(plan.flat().sort((x, y) => x - y)).toEqual(list);
          if (split === 'groups') expect(plan).toHaveLength(size);
          else {
            expect(Math.max(...counts)).toBeLessThanOrEqual(size);
            expect(plan).toHaveLength(Math.ceil(people / size));
          }
        }
      }
    }
  });

  it('names groups from a scheme', () => {
    expect([1, 2, 26, 27, 52, 53, 702, 703].map(letters)).toEqual(['A', 'B', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(groupNames('Group @', 3, ['group b'])).toEqual(['Group A', 'Group C', 'Group D']);
    expect(groupNames('Lab #', 2, [])).toEqual(['Lab 1', 'Lab 2']);
    expect(groupNames('Team', 2, ['Team 1'])).toEqual(['Team 2', 'Team 3']);
    expect(groupNames('@-#', 2, [])).toEqual(['A-1', 'B-2']);
  });
});

describe('demo content', () => {
  it('seeds groups in Modern Web Development and a linked cohort', async () => {
    const demo = await createTestLms();
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
      const course = await alex.get('/api/courses/modern-web-development');
      expect(course.body.myGroups.map((g: { name: string }) => g.name)).toEqual(['Accessibility reviewers', 'Team Aurora']);

      const maya = await login(demo, 'maya.chen@coursekit.test', 'demo-password');
      const list = await maya.get<CourseGroups>('/api/courses/modern-web-development/groups');
      expect(list.body.groups.map((g) => [g.name, g.members.length])).toEqual([
        ['Accessibility reviewers', 4],
        ['Team Aurora', 7], // six students and Priya, the teaching assistant (demo-group-modes.ts)
        ['Team Borealis', 6],
      ]);

      const admin = await login(demo, 'admin@coursekit.test', 'demo-password');
      const cohorts = await admin.get('/api/admin/cohorts');
      expect(
        cohorts.body.items.map((c: { name: string; memberCount: number; courseCount: number }) => [c.name, c.memberCount, c.courseCount]),
      ).toEqual([
        ['Fall 2026 bootcamp', 6, 1],
        ['Teaching team', 3, 0],
      ]);
    } finally {
      await demo.close();
    }
  });
});
