import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityDetail, CourseDetail, Discussion, DiscussionDetail, Gradebook, MyGrades } from '../src/shared/types.js';
import type { Coursekit } from '../src/server/index.js';
import { completionEngineFor } from '../src/server/services/completion.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

/**
 * People: Sam (group A), Kim (group B), Lee (A and B), Nia (no group); teaching assistants Tara (in A) and
 * Omar (in no group); the teacher Tina; an administrator who isn't enrolled.
 */
let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let base: string;
let lee: Client;
let nia: Client;
let tara: Client;
let omar: Client;
let ids: Record<'sam' | 'kim' | 'lee' | 'nia' | 'tara' | 'omar', string>;
let groupA: string;
let groupB: string;

const idOf = async (client: Client): Promise<string> => (await client.get('/api/auth/session')).body.user.id;

async function del(client: Client, path: string): Promise<{ status: number; body: any }> {
  const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: client.cookie, origin: 'http://localhost' } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function activity(body: Record<string, unknown>): Promise<string> {
  const res = await school.teacher.post(`${base}/activities`, { sectionId: school.sectionId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

/** Uploads a small file. Multipart bodies need an Origin header (CSRF check), which the shared client doesn't send. */
async function upload(client: Client, context: 'activity' | 'submission' | 'post'): Promise<string> {
  const form = new FormData();
  form.set('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  form.set('context', context);
  form.set('courseId', school.course.id);
  const res = await lms.app.request('/api/files', {
    method: 'POST',
    body: form,
    headers: { cookie: client.cookie, origin: 'http://localhost' },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const download = async (client: Client, fileId: string): Promise<number> => (await client.get(`/api/files/${fileId}`)).status;

async function titles(client: Client): Promise<string[]> {
  const res = await client.get<CourseDetail>(base);
  expect(res.status).toBe(200);
  return res.body.sections.flatMap((s) => s.activities.map((a) => a.title));
}

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  base = `/api/courses/${school.course.id}`;
  for (const [name, email] of [
    ['Lee Student', 'lee@test.dev'],
    ['Nia Student', 'nia@test.dev'],
    ['Tara Assistant', 'tara@test.dev'],
    ['Omar Assistant', 'omar@test.dev'],
  ]) {
    await lms.createUser({ name: name!, email: email!, password: PASSWORD });
  }
  await school.teacher.post(`${base}/participants`, { emails: ['sam@test.dev', 'kim@test.dev', 'lee@test.dev', 'nia@test.dev'] });
  await school.teacher.post(`${base}/participants`, { emails: ['tara@test.dev', 'omar@test.dev'], role: 'assistant' });
  lee = await login(lms, 'lee@test.dev');
  nia = await login(lms, 'nia@test.dev');
  tara = await login(lms, 'tara@test.dev');
  omar = await login(lms, 'omar@test.dev');
  ids = {
    sam: await idOf(school.sam),
    kim: await idOf(school.kim),
    lee: await idOf(lee),
    nia: await idOf(nia),
    tara: await idOf(tara),
    omar: await idOf(omar),
  };
  groupA = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
  groupB = (await school.teacher.post(`${base}/groups`, { name: 'Team B' })).body.id;
  await school.teacher.post(`${base}/groups/${groupA}/members`, { userIds: [ids.sam, ids.lee, ids.tara] });
  await school.teacher.post(`${base}/groups/${groupB}/members`, { userIds: [ids.kim, ids.lee] });
});

afterEach(async () => {
  await lms.close();
});

describe('group mode settings', () => {
  it('gives teachers and administrators course:accessAllGroups, but not assistants or students', async () => {
    const caps = async (client: Client) => (await client.get<CourseDetail>(base)).body.capabilities;
    expect(await caps(school.teacher)).toContain('course:accessAllGroups');
    expect(await caps(school.admin)).toContain('course:accessAllGroups');
    expect(await caps(tara)).not.toContain('course:accessAllGroups');
    expect(await caps(school.sam)).not.toContain('course:accessAllGroups');
  });

  it('lets teachers set the course default and each activity override it', async () => {
    expect((await school.teacher.get<CourseDetail>(base)).body.groupMode).toBe('none');
    expect((await school.teacher.patch(base, { groupMode: 'separate' })).status).toBe(200);
    expect((await school.sam.get<CourseDetail>(base)).body.groupMode).toBe('separate');
    expect((await tara.patch(base, { groupMode: 'none' })).status).toBe(403);
    expect((await school.sam.patch(base, { groupMode: 'none' })).status).toBe(403);
    expect((await school.teacher.patch(base, { groupMode: 'sometimes' })).status).toBe(400);

    const forum = await activity({ type: 'forum', title: 'Talk', groupMode: 'visible' });
    const detail = (await school.teacher.get<ActivityDetail>(`/api/activities/${forum}`)).body;
    expect(detail.groupMode).toBe('visible');
    expect(detail.groups?.mode).toBe('visible');
    expect((await school.teacher.patch(`/api/activities/${forum}`, { groupMode: null })).status).toBe(200);
    expect((await school.sam.get<ActivityDetail>(`/api/activities/${forum}`)).body.groups?.mode).toBe('separate');
    // Students don't see the staff-only settings.
    expect((await school.sam.get<ActivityDetail>(`/api/activities/${forum}`)).body.groupMode).toBeUndefined();
    expect((await school.sam.patch(`/api/activities/${forum}`, { groupMode: 'none' })).status).toBe(403);
    expect((await tara.patch(`/api/activities/${forum}`, { groupIds: [groupA] })).status).toBe(403);
  });
});

describe('group-restricted activities', () => {
  let onlyA: string;
  let onlyB: string;

  beforeEach(async () => {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    onlyA = await activity({ type: 'assignment', title: 'Team A brief', dueAt: due, maxGrade: 10, groupIds: [groupA] });
    await activity({ type: 'lesson', title: 'Open lesson', settings: { body: 'Hi' } });
    onlyB = await activity({ type: 'lesson', title: 'Team B notes', settings: { body: 'Secret plan' }, groupIds: [groupB] });
  });

  it('only lists them for members of their groups, and for staff with a badge', async () => {
    expect(await titles(school.sam)).toEqual(['Team A brief', 'Open lesson']);
    expect(await titles(school.kim)).toEqual(['Open lesson', 'Team B notes']);
    expect(await titles(lee)).toEqual(['Team A brief', 'Open lesson', 'Team B notes']);
    expect(await titles(nia)).toEqual(['Open lesson']);
    for (const staff of [school.teacher, tara, omar, school.admin]) {
      expect(await titles(staff)).toEqual(['Team A brief', 'Open lesson', 'Team B notes']);
    }
    const teacherView = (await school.teacher.get<CourseDetail>(base)).body.sections[0]!.activities;
    expect(teacherView.map((a) => a.groupRestriction?.map((g) => g.name))).toEqual([['Team A'], [], ['Team B']]);
    const samView = (await school.sam.get<CourseDetail>(base)).body.sections[0]!.activities;
    expect(samView.every((a) => a.groupRestriction === undefined && a.groupMode === undefined)).toBe(true);

    // Someone who isn't enrolled only sees the outline, without restricted activities.
    await lms.createUser({ name: 'Visitor', email: 'visitor@test.dev', password: PASSWORD });
    const visitor = await login(lms, 'visitor@test.dev');
    expect(await titles(visitor)).toEqual(['Open lesson']);
  });

  it("can't be opened, submitted or navigated to by students outside the groups", async () => {
    expect((await school.kim.get(`/api/activities/${onlyA}`)).status).toBe(404);
    expect((await nia.get(`/api/activities/${onlyA}`)).status).toBe(404);
    expect((await school.kim.put(`/api/activities/${onlyA}/submission`, { text: 'Let me in' })).status).toBe(404);
    expect((await school.sam.get(`/api/activities/${onlyB}`)).status).toBe(404);
    expect((await school.sam.post(`/api/activities/${onlyB}/complete`)).status).toBe(404);
    expect((await school.sam.put(`/api/activities/${onlyA}/submission`, { text: 'Done' })).status).toBe(200);
    expect((await lee.get(`/api/activities/${onlyB}`)).status).toBe(200);
    expect((await tara.get(`/api/activities/${onlyB}`)).status).toBe(200);

    // Previous/next skip what the student can't see.
    const open = (await school.kim.get<CourseDetail>(base)).body.sections[0]!.activities.find((a) => a.title === 'Open lesson')!;
    const kimNav = (await school.kim.get<ActivityDetail>(`/api/activities/${open.id}`)).body;
    expect([kimNav.prev, kimNav.next?.title]).toEqual([null, 'Team B notes']);
    const samNav = (await school.sam.get<ActivityDetail>(`/api/activities/${open.id}`)).body;
    expect([samNav.prev?.title, samNav.next]).toEqual(['Team A brief', null]);
  });

  it('leaves them out of the calendar, the dashboard timeline and search for students outside the groups', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const calendar = async (client: Client) =>
      (await client.get(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body.map(
        (e: { title: string }) => e.title,
      );
    expect(await calendar(school.sam)).toContain('Team A brief due');
    expect(await calendar(school.kim)).not.toContain('Team A brief due');
    expect(await calendar(school.teacher)).toContain('Team A brief due');

    const timeline = async (client: Client) => (await client.get('/api/dashboard')).body.timeline.map((t: { title: string }) => t.title);
    expect(await timeline(school.sam)).toEqual(['Team A brief']);
    expect(await timeline(school.kim)).toEqual([]);

    const search = async (client: Client, q: string) =>
      (await client.get(`/api/search?q=${q}`)).body.activities.map((a: { title: string }) => a.title);
    expect(await search(school.kim, 'team')).toEqual(['Team B notes']);
    expect(await search(school.sam, 'team')).toEqual(['Team A brief']);
    expect(await search(nia, 'team')).toEqual([]);
    expect((await search(school.teacher, 'team')).sort()).toEqual(['Team A brief', 'Team B notes']);
  });

  it('marks gradebook cells not applicable and keeps them out of totals, averages, exports and grading', async () => {
    await school.teacher.put(`/api/activities/${onlyA}/grades/${ids.sam}`, { score: 8 });
    await school.teacher.put(`/api/activities/${onlyA}/grades/${ids.lee}`, { score: 6 });
    // Kim can't be graded in Team A's assignment, so she is never notified about it either.
    const refused = await school.teacher.put(`/api/activities/${onlyA}/grades/${ids.kim}`, { score: 5 });
    expect(refused.status).toBe(400);
    expect((await school.teacher.put(`${base}/grades/${onlyA}/${ids.kim}`, { score: 5 })).status).toBe(400);
    const grades = (await school.kim.get('/api/notifications')).body.items.filter((n: { type: string }) => n.type === 'grade');
    expect(grades).toEqual([]);

    const book = (await school.teacher.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    const row = (id: string) => book.rows.find((r) => r.user.id === id)!;
    expect(row(ids.kim).cells[onlyA]).toMatchObject({ notApplicable: true, score: null });
    expect(row(ids.nia).cells[onlyA]?.notApplicable).toBe(true);
    expect(row(ids.sam).cells[onlyA]).toMatchObject({ score: 8 });
    expect(row(ids.sam).cells[onlyA]?.notApplicable).toBeUndefined();
    expect(row(ids.sam).percentage).toBe(80);
    expect(row(ids.kim)).toMatchObject({ percentage: null, total: 0, max: 0 });
    expect(book.averages[onlyA]).toBe(7);

    const csv = await lms.app.request(`${base}/grades/export.csv`, { headers: { cookie: school.teacher.cookie } });
    const lines = (await csv.text()).split('\n');
    expect(lines.find((l) => l.startsWith('Kim Student'))).toContain('N/A');
    expect(lines.find((l) => l.startsWith('Sam Student'))).not.toContain('N/A');

    // Students only see their own applicable grades.
    const kimGrades = (await school.kim.get<{ grades: MyGrades }>(`${base}/grades`)).body.grades;
    expect(kimGrades.items.map((i) => i.title)).toEqual([]);
    const samGrades = (await school.sam.get<{ grades: MyGrades }>(`${base}/grades`)).body.grades;
    expect(samGrades.items.map((i) => i.title)).toEqual(['Team A brief']);
    // A grade given before the restriction doesn't count once the student is outside it.
    await school.teacher.post(`${base}/groups/${groupA}/members`, { userIds: [ids.kim] });
    await school.teacher.put(`/api/activities/${onlyA}/grades/${ids.kim}`, { score: 5 });
    await del(school.teacher, `${base}/groups/${groupA}/members/${ids.kim}`);
    expect((await school.kim.get<{ grades: MyGrades }>(`${base}/grades`)).body.grades.percentage).toBeNull();
    const after = (await school.teacher.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    expect(after.rows.find((r) => r.user.id === ids.kim)!.cells[onlyA]).toMatchObject({ notApplicable: true, score: null });
  });

  it('only counts available activities towards progress and course completion', async () => {
    const open = (await school.teacher.get<CourseDetail>(base)).body.sections[0]!.activities.find((a) => a.title === 'Open lesson')!.id;
    await school.teacher.patch(`/api/activities/${onlyA}`, { completion: 'none' });
    await school.teacher.put(`${base}/completion/settings`, {
      enabled: true,
      mode: 'all',
      activityIds: [],
      minGrade: null,
      certificate: { enabled: false, title: 'Certificate', body: '{name}', signatureName: '', signatureTitle: '' },
    });
    expect((await school.sam.post(`/api/activities/${open}/complete`)).status).toBe(200);
    expect((await school.kim.post(`/api/activities/${open}/complete`)).status).toBe(200);
    await completionEngineFor(lms.events)!.idle();

    const sam = (await school.sam.get(`${base}/completion`)).body;
    expect(sam.criteria.map((c: { title: string }) => c.title)).toEqual(['Open lesson']);
    expect(sam.completed).toBe(true);
    const kim = (await school.kim.get(`${base}/completion`)).body;
    expect(kim.criteria.map((c: { title: string }) => c.title)).toEqual(['Open lesson', 'Team B notes']);
    expect(kim.completed).toBe(false);

    const participants = (await school.teacher.get(`${base}/participants`)).body as Array<{ user: { id: string }; progress: number }>;
    const progress = (id: string) => participants.find((p) => p.user.id === id)!.progress;
    expect([progress(ids.sam), progress(ids.kim), progress(ids.nia)]).toEqual([100, 50, 0]);
    const mine = (await school.sam.get('/api/courses/mine')).body;
    expect(mine[0].progress).toBe(100);

    const report = (await school.teacher.get(`${base}/completion/report`)).body;
    const reportRow = (id: string) => report.rows.find((r: { user: { id: string } }) => r.user.id === id);
    expect(reportRow(ids.sam)).toMatchObject({ activitiesDone: 1, activitiesTotal: 1, progress: 100 });
    expect(reportRow(ids.kim)).toMatchObject({ activitiesDone: 1, activitiesTotal: 2, progress: 50 });

    // Finishing the group's lesson completes the course for Kim.
    expect((await school.kim.post(`/api/activities/${onlyB}/complete`)).status).toBe(200);
    await completionEngineFor(lms.events)!.idle();
    expect((await school.kim.get(`${base}/completion`)).body.completed).toBe(true);
  });

  it('saves nothing when a change is refused, so a refused restriction never opens the activity', async () => {
    const lesson = await activity({ type: 'lesson', title: 'Draft', settings: { body: 'Soon' }, visible: false });
    const gone = (await school.teacher.post(`${base}/groups`, { name: 'Gone' })).body.id;
    expect((await del(school.teacher, `${base}/groups/${gone}`)).status).toBe(200);
    const refused = await school.teacher.patch(`/api/activities/${lesson}`, {
      title: 'Renamed',
      visible: true,
      groupMode: 'separate',
      groupIds: [gone],
    });
    expect(refused.status).toBe(400);
    const detail = (await school.teacher.get<ActivityDetail>(`/api/activities/${lesson}`)).body;
    expect(detail).toMatchObject({ title: 'Draft', visible: false, groupMode: null });
    expect((await nia.get(`/api/activities/${lesson}`)).status).toBe(404);

    // A quiz's maximum grade isn't saved (nor its grades left unscaled) when the groups are refused.
    const quiz = await activity({ type: 'quiz', title: 'Check', maxGrade: 10 });
    expect((await school.teacher.patch(`/api/activities/${quiz}`, { maxGrade: 20, groupIds: ['nope'] })).status).toBe(400);
    expect((await school.teacher.get<ActivityDetail>(`/api/activities/${quiz}`)).body.maxGrade).toBe(10);

    expect((await school.teacher.patch(`/api/activities/${lesson}`, { visible: true, groupIds: [groupA] })).status).toBe(200);
    expect((await nia.get(`/api/activities/${lesson}`)).status).toBe(404);
    expect((await school.sam.get(`/api/activities/${lesson}`)).status).toBe(200);
  });

  it('validates the groups, and keeps a restriction to a deleted group closed', async () => {
    const other = await school.teacher.post<{ id: string }>('/api/courses', { title: 'Other course', visibility: 'published' });
    const foreign = (await school.teacher.post(`/api/courses/${other.body.id}/groups`, { name: 'Elsewhere' })).body.id;
    expect((await school.teacher.patch(`/api/activities/${onlyA}`, { groupIds: [foreign] })).status).toBe(400);
    expect((await school.teacher.patch(`/api/activities/${onlyA}`, { groupIds: ['nope'] })).status).toBe(400);
    expect(
      (await school.teacher.post(`${base}/activities`, { sectionId: school.sectionId, type: 'lesson', title: 'X', groupIds: [foreign] }))
        .status,
    ).toBe(400);

    const groupC = (await school.teacher.post(`${base}/groups`, { name: 'Team C' })).body.id;
    await school.teacher.patch(`/api/activities/${onlyB}`, { groupIds: [groupC] });
    expect(await titles(school.kim)).toEqual(['Open lesson']);
    expect((await del(school.teacher, `${base}/groups/${groupC}`)).status).toBe(200);
    expect(await titles(school.kim)).toEqual(['Open lesson']);
    expect(await titles(lee)).toEqual(['Team A brief', 'Open lesson']);
    const restricted = (await school.teacher.get<ActivityDetail>(`/api/activities/${onlyB}`)).body.groupRestriction;
    expect(restricted).toEqual([{ id: groupC, name: 'Deleted group' }]);
    // Saving with the deleted group still in the list is fine; clearing it opens the activity to everyone.
    expect((await school.teacher.patch(`/api/activities/${onlyB}`, { groupIds: [groupC, groupB] })).status).toBe(200);
    expect(await titles(school.kim)).toEqual(['Open lesson', 'Team B notes']);
    expect((await school.teacher.patch(`/api/activities/${onlyB}`, { groupIds: [] })).status).toBe(200);
    expect(await titles(nia)).toEqual(['Open lesson', 'Team B notes']);
  });
});

describe('separate groups for work', () => {
  let essay: string;

  beforeEach(async () => {
    essay = await activity({ type: 'assignment', title: 'Essay', maxGrade: 10, groupMode: 'separate' });
    for (const student of [school.sam, school.kim, lee, nia]) {
      expect((await student.put(`/api/activities/${essay}/submission`, { text: 'My essay' })).status).toBe(200);
    }
  });

  const names = async (client: Client, query = '') => {
    const res = await client.get(`/api/activities/${essay}/submissions${query}`);
    return res.status === 200 ? res.body.map((r: { user: { name: string } }) => r.user.name).sort() : res.status;
  };

  it("limits assistants to their own groups' students, and lets teachers pick any group", async () => {
    expect(await names(tara)).toEqual(['Lee Student', 'Sam Student']);
    expect(await names(tara, `?groupId=${groupA}`)).toEqual(['Lee Student', 'Sam Student']);
    expect(await names(tara, `?groupId=${groupB}`)).toBe(404);
    expect(await names(omar)).toEqual([]);
    expect(await names(school.teacher)).toEqual(['Kim Student', 'Lee Student', 'Nia Student', 'Sam Student']);
    expect(await names(school.teacher, `?groupId=${groupB}`)).toEqual(['Kim Student', 'Lee Student']);
    expect(await names(school.admin)).toHaveLength(4);
    expect(await names(school.sam)).toBe(403);

    const taView = (await tara.get<ActivityDetail>(`/api/activities/${essay}`)).body;
    expect(taView.submissionStats).toMatchObject({ participants: 2, submitted: 2 });
    expect(taView.groups).toMatchObject({ mode: 'separate', allParticipants: false, groups: [{ id: groupA, name: 'Team A' }] });
    const teacherView = (await school.teacher.get<ActivityDetail>(`/api/activities/${essay}`)).body;
    expect(teacherView.submissionStats).toMatchObject({ participants: 4, submitted: 4 });
    expect(teacherView.groups?.allParticipants).toBe(true);
  });

  it("stops assistants grading other groups' students, in the activity and the gradebook", async () => {
    expect((await tara.put(`/api/activities/${essay}/grades/${ids.kim}`, { score: 5 })).status).toBe(404);
    expect((await tara.put(`${base}/grades/${essay}/${ids.kim}`, { score: 5 })).status).toBe(404);
    expect((await omar.put(`/api/activities/${essay}/grades/${ids.sam}`, { score: 5 })).status).toBe(404);
    expect((await tara.put(`/api/activities/${essay}/grades/${ids.sam}`, { score: 7 })).status).toBe(200);
    expect((await school.teacher.put(`/api/activities/${essay}/grades/${ids.kim}`, { score: 9 })).status).toBe(200);

    const book = (await tara.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    const row = (id: string) => book.rows.find((r) => r.user.id === id)!;
    // The course itself has no groups, so Tara sees every student, but not Kim's grade in the separate-groups essay.
    expect(book.rows).toHaveLength(4);
    expect(row(ids.kim).cells[essay]).toMatchObject({ hidden: true, score: null });
    expect(row(ids.kim)).toMatchObject({ totalsHidden: true, percentage: null });
    expect(row(ids.sam).cells[essay]).toMatchObject({ score: 7 });
    expect(book.averages[essay]).toBe(7);
    const csv = await (await lms.app.request(`${base}/grades/export.csv`, { headers: { cookie: tara.cookie } })).text();
    expect(csv).not.toContain('9');

    const teacherBook = (await school.teacher.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    expect(teacherBook.rows.find((r) => r.user.id === ids.kim)!.cells[essay]).toMatchObject({ score: 9 });
    expect(teacherBook.averages[essay]).toBe(8);
  });

  it("counts only the work the viewer sees in the dashboard's To grade, with a fixed number of queries", async () => {
    const restricted = await activity({ type: 'assignment', title: 'Team A task', maxGrade: 10, groupIds: [groupA] });
    expect((await school.sam.put(`/api/activities/${restricted}/submission`, { text: 'Done' })).status).toBe(200);
    const toGrade = async (client: Client) =>
      Object.fromEntries(
        (await client.get('/api/dashboard')).body.toGrade.map((t: { title: string; count: number }) => [t.title, t.count]),
      );
    expect(await toGrade(school.teacher)).toEqual({ Essay: 4, 'Team A task': 1 });
    expect(await toGrade(tara)).toEqual({ Essay: 2, 'Team A task': 1 });
    expect(await toGrade(omar)).toEqual({ 'Team A task': 1 });

    // More taught courses with work to grade (with and without groups) don't add queries.
    const { StatementSync } = await import('node:sqlite');
    const queries = async (client: Client) => {
      const all = vi.spyOn(StatementSync.prototype, 'all');
      const iterate = vi.spyOn(StatementSync.prototype, 'iterate');
      try {
        expect((await client.get('/api/dashboard')).status).toBe(200);
        return all.mock.calls.length + iterate.mock.calls.length;
      } finally {
        all.mockRestore();
        iterate.mockRestore();
      }
    };
    const addCourse = async (n: number, grouped: boolean) => {
      const course = (await school.teacher.post('/api/courses', { title: `Extra ${n}`, visibility: 'published' })).body;
      const courseBase = `/api/courses/${course.id}`;
      await school.teacher.post(`${courseBase}/participants`, { emails: ['sam@test.dev'] });
      await school.teacher.post(`${courseBase}/participants`, { emails: ['tara@test.dev'], role: 'assistant' });
      const sectionId = (await school.teacher.get<CourseDetail>(courseBase)).body.sections[0]!.id;
      if (grouped) await school.teacher.patch(courseBase, { groupMode: 'separate' });
      const work = (
        await school.teacher.post(`${courseBase}/activities`, { sectionId, type: 'assignment', title: `Work ${n}`, maxGrade: 10 })
      ).body.id;
      expect((await school.sam.put(`/api/activities/${work}/submission`, { text: 'Hi' })).status).toBe(200);
    };
    await addCourse(1, false);
    await addCourse(2, true);
    const before = { teacher: await queries(school.teacher), tara: await queries(tara) };
    await addCourse(3, false);
    await addCourse(4, true);
    expect(await queries(school.teacher)).toBe(before.teacher);
    expect(await queries(tara)).toBe(before.tara);
    expect(await toGrade(school.teacher)).toMatchObject({ 'Work 1': 1, 'Work 2': 1, 'Work 3': 1, 'Work 4': 1 });
    // Tara is in no group of the separate-groups courses, so she doesn't see Sam's work there.
    expect(await toGrade(tara)).toEqual({ Essay: 2, 'Team A task': 1, 'Work 1': 1, 'Work 3': 1 });
  });

  it('shows assistants everyone in visible groups mode', async () => {
    await school.teacher.patch(`/api/activities/${essay}`, { groupMode: 'visible' });
    expect(await names(tara)).toEqual(['Kim Student', 'Lee Student', 'Nia Student', 'Sam Student']);
    expect(await names(tara, `?groupId=${groupB}`)).toEqual(['Kim Student', 'Lee Student']);
    expect((await tara.put(`/api/activities/${essay}/grades/${ids.kim}`, { score: 5 })).status).toBe(200);
  });

  it("limits the gradebook's rows to an assistant's groups when the course uses separate groups", async () => {
    await school.teacher.patch(base, { groupMode: 'separate' });
    const book = (await tara.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    expect(book.rows.map((r) => r.user.name).sort()).toEqual(['Lee Student', 'Sam Student']);
    expect(book.groupChoice).toEqual({ groups: [{ id: groupA, name: 'Team A' }], allParticipants: false });
    expect((await tara.get(`${base}/grades?groupId=${groupB}`)).status).toBe(404);
    expect((await omar.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook.rows).toEqual([]);
    const teacherBook = (await school.teacher.get<{ gradebook: Gradebook }>(`${base}/grades`)).body.gradebook;
    expect(teacherBook.rows).toHaveLength(4);
    expect(teacherBook.groupChoice?.allParticipants).toBe(true);
  });

  it("limits quiz attempts and reports to an assistant's groups", async () => {
    const quiz = await activity({ type: 'quiz', title: 'Check', groupMode: 'separate' });
    await school.teacher.put(`/api/activities/${quiz}/questions`, {
      questions: [
        {
          type: 'truefalse',
          prompt: 'Groups are useful',
          points: 1,
          options: [
            { text: 'True', correct: true },
            { text: 'False', correct: false },
          ],
        },
      ],
    });
    const attempt = async (student: Client) => {
      const started = await student.post(`/api/activities/${quiz}/attempts`);
      expect(started.status).toBe(201);
      expect((await student.post(`/api/attempts/${started.body.id}/submit`, { answers: {} })).status).toBe(200);
      return started.body.id as string;
    };
    const samAttempt = await attempt(school.sam);
    const kimAttempt = await attempt(school.kim);

    const attempts = async (client: Client) =>
      (await client.get(`/api/activities/${quiz}/attempts?all=1`)).body.map((a: { user: { name: string } }) => a.user.name).sort();
    expect(await attempts(tara)).toEqual(['Sam Student']);
    expect(await attempts(omar)).toEqual([]);
    expect(await attempts(school.teacher)).toEqual(['Kim Student', 'Sam Student']);
    expect((await tara.get(`/api/attempts/${kimAttempt}`)).status).toBe(404);
    expect((await tara.get(`/api/attempts/${samAttempt}`)).status).toBe(200);
    expect((await school.teacher.get(`/api/attempts/${kimAttempt}`)).status).toBe(200);
    expect((await school.sam.get(`/api/attempts/${kimAttempt}`)).status).toBe(404);
    expect((await tara.get(`/api/activities/${quiz}/grading`)).status).toBe(200);
    expect((await tara.get(`/api/activities/${quiz}/grading?groupId=${groupB}`)).status).toBe(404);
  });
});

describe('forums with groups', () => {
  let forum: string;
  let everyone: string;
  let teamB: string;

  beforeEach(async () => {
    forum = await activity({ type: 'forum', title: 'Team rooms', groupMode: 'separate' });
    everyone = (await school.teacher.post(`/api/activities/${forum}/discussions`, { title: 'Welcome', body: 'Hello all', groupId: null }))
      .body.id;
    teamB = (await school.teacher.post(`/api/activities/${forum}/discussions`, { title: 'B plan', body: 'For B', groupId: groupB })).body
      .id;
  });

  const list = async (client: Client, query = '') => {
    const res = await client.get<Discussion[]>(`/api/activities/${forum}/discussions${query}`);
    return res.status === 200 ? res.body.map((d) => d.title).sort() : res.status;
  };

  it('puts new discussions in one of the poster’s groups', async () => {
    const start = (client: Client, body: Record<string, unknown>) =>
      client.post(`/api/activities/${forum}/discussions`, { title: 'Idea', body: 'Text', ...body });
    const samPost = await start(school.sam, {});
    expect(samPost.status).toBe(201);
    expect((await school.teacher.get<DiscussionDetail>(`/api/discussions/${samPost.body.id}`)).body.group).toEqual({
      id: groupA,
      name: 'Team A',
    });
    expect((await start(lee, {})).status).toBe(400); // in two groups: must choose
    expect((await start(lee, { groupId: groupB })).status).toBe(201);
    expect((await start(nia, {})).status).toBe(403); // in no group
    expect((await start(school.sam, { groupId: groupB })).status).toBe(403);
    expect((await start(school.sam, { groupId: null })).status).toBe(201); // null: their own group
    expect((await start(tara, { groupId: groupB })).status).toBe(403);
    expect((await start(omar, {})).status).toBe(403);
    expect((await start(school.teacher, { groupId: 'nope' })).status).toBe(400);

    const info = (await lee.get<ActivityDetail>(`/api/activities/${forum}`)).body.groups!;
    expect(info).toMatchObject({ mode: 'separate', postToAll: false, allParticipants: false });
    expect(info.postGroups.map((g) => g.name)).toEqual(['Team A', 'Team B']);
    expect((await school.teacher.get<ActivityDetail>(`/api/activities/${forum}`)).body.groups).toMatchObject({ postToAll: true });
  });

  it("hides other groups' discussions in separate groups, everywhere", async () => {
    const samA = (await school.sam.post(`/api/activities/${forum}/discussions`, { title: 'A plan', body: 'For A' })).body.id;
    expect(await list(school.sam)).toEqual(['A plan', 'Welcome']);
    expect(await list(school.kim)).toEqual(['B plan', 'Welcome']);
    expect(await list(lee)).toEqual(['A plan', 'B plan', 'Welcome']);
    expect(await list(nia)).toEqual(['Welcome']);
    expect(await list(tara)).toEqual(['A plan', 'Welcome']);
    expect(await list(omar)).toEqual(['Welcome']);
    expect(await list(school.teacher)).toEqual(['A plan', 'B plan', 'Welcome']);
    expect(await list(school.admin)).toEqual(['A plan', 'B plan', 'Welcome']);
    expect(await list(school.teacher, `?groupId=${groupA}`)).toEqual(['A plan', 'Welcome']);
    expect(await list(lee, `?groupId=${groupB}`)).toEqual(['B plan', 'Welcome']);
    expect(await list(school.sam, `?groupId=${groupB}`)).toBe(404);

    // Kim can't open, reply to, edit, move or delete Team A's discussion.
    expect((await school.kim.get(`/api/discussions/${samA}`)).status).toBe(404);
    expect((await school.kim.post(`/api/discussions/${samA}/posts`, { body: 'Sneaky' })).status).toBe(404);
    expect((await school.kim.patch(`/api/discussions/${samA}`, { title: 'Mine now' })).status).toBe(404);
    expect((await del(school.kim, `/api/discussions/${samA}`)).status).toBe(404);
    const rootPost = (await school.sam.get<DiscussionDetail>(`/api/discussions/${samA}`)).body.posts[0]!.id;
    expect((await school.kim.patch(`/api/posts/${rootPost}`, { body: 'Changed' })).status).toBe(404);
    expect((await omar.get(`/api/discussions/${samA}`)).status).toBe(404);
    expect((await tara.get(`/api/discussions/${samA}`)).status).toBe(200);

    // Counts only include what the viewer can see.
    const meta = async (client: Client) =>
      (await client.get<CourseDetail>(base)).body.sections[0]!.activities.find((a) => a.id === forum)!.meta;
    expect(await meta(nia)).toBe('1 discussion');
    expect(await meta(school.kim)).toBe('2 discussions');
    expect(await meta(school.teacher)).toBe('3 discussions');
    expect((await nia.get<ActivityDetail>(`/api/activities/${forum}`)).body.forum).toEqual({ discussionCount: 1, postCount: 1 });
  });

  it('lets students reply only in their own groups, and staff also to discussions for everyone', async () => {
    expect((await school.kim.post(`/api/discussions/${teamB}/posts`, { body: 'On it' })).status).toBe(201);
    // In separate groups, a reply to an all-participants discussion would reach every group.
    expect((await school.kim.post(`/api/discussions/${everyone}/posts`, { body: 'Hi!' })).status).toBe(403);
    const view = (await school.kim.get<DiscussionDetail>(`/api/discussions/${everyone}`)).body;
    expect(view.canReply).toBe(false);
    expect(view.replyNote).toMatch(/Only the teaching team/);
    expect((await school.kim.get<DiscussionDetail>(`/api/discussions/${teamB}`)).body.canReply).toBe(true);
    expect((await tara.post(`/api/discussions/${everyone}/posts`, { body: 'Welcome from the TA' })).status).toBe(201);
    expect((await school.teacher.post(`/api/discussions/${teamB}/posts`, { body: 'Nice' })).status).toBe(201);
  });

  it('only notifies people who can still see the discussion', async () => {
    const leeB = (await lee.post(`/api/activities/${forum}/discussions`, { title: 'Lee in B', body: 'Ideas', groupId: groupB })).body.id;
    await del(school.teacher, `${base}/groups/${groupB}/members/${ids.lee}`);
    expect((await lee.get(`/api/discussions/${leeB}`)).status).toBe(404);
    expect((await school.kim.post(`/api/discussions/${leeB}/posts`, { body: 'Reply for Lee' })).status).toBe(201);
    const forumNotes = async (client: Client) =>
      (await client.get('/api/notifications')).body.items.filter((n: { type: string }) => n.type === 'forum');
    expect(await forumNotes(lee)).toEqual([]);
    // Back in the group, Lee hears about the next reply.
    await school.teacher.post(`${base}/groups/${groupB}/members`, { userIds: [ids.lee] });
    expect((await school.kim.post(`/api/discussions/${leeB}/posts`, { body: 'Welcome back' })).status).toBe(201);
    expect(await forumNotes(lee)).toHaveLength(1);
  });

  it('lets teachers move a discussion to another group', async () => {
    expect((await school.kim.patch(`/api/discussions/${teamB}`, { groupId: null })).status).toBe(403);
    expect((await tara.patch(`/api/discussions/${everyone}`, { groupId: groupA })).status).toBe(403);
    expect((await school.teacher.patch(`/api/discussions/${teamB}`, { groupId: groupA })).status).toBe(200);
    expect(await list(school.kim)).toEqual(['Welcome']);
    expect(await list(school.sam)).toEqual(['B plan', 'Welcome']);
  });

  it('shows every discussion in visible groups, but students only take part in their own groups', async () => {
    await school.teacher.patch(`/api/activities/${forum}`, { groupMode: 'visible' });
    expect(await list(school.sam)).toEqual(['B plan', 'Welcome']);
    expect(await list(nia)).toEqual(['B plan', 'Welcome']);
    expect(await list(school.sam, `?groupId=${groupB}`)).toEqual(['B plan', 'Welcome']);
    expect((await school.sam.get<DiscussionDetail>(`/api/discussions/${teamB}`)).body.canReply).toBe(false);
    expect((await school.sam.post(`/api/discussions/${teamB}/posts`, { body: 'Can I help?' })).status).toBe(403);
    expect((await school.sam.post(`/api/discussions/${everyone}/posts`, { body: 'Hi all' })).status).toBe(201);
    expect((await school.sam.post(`/api/activities/${forum}/discussions`, { title: 'X', body: 'Y', groupId: groupB })).status).toBe(403);
    expect((await nia.post(`/api/activities/${forum}/discussions`, { title: 'X', body: 'Y' })).status).toBe(403);
    expect((await tara.post(`/api/discussions/${teamB}/posts`, { body: 'Hello B' })).status).toBe(403);
  });

  it('treats every discussion as open to all when the forum has no groups', async () => {
    await school.teacher.patch(`/api/activities/${forum}`, { groupMode: 'none' });
    expect(await list(nia)).toEqual(['B plan', 'Welcome']);
    expect((await school.sam.post(`/api/discussions/${teamB}/posts`, { body: 'Joining in' })).status).toBe(201);
    expect((await nia.post(`/api/activities/${forum}/discussions`, { title: 'Open', body: 'Anyone' })).status).toBe(201);
  });
});

describe('files follow the rules of their activity', () => {
  it("keeps a restricted resource's file from students outside its groups", async () => {
    const fileId = await upload(school.teacher, 'activity');
    const resource = await activity({ type: 'resource', title: 'Team A slides', settings: { kind: 'file', fileId }, groupIds: [groupA] });
    expect(await download(school.sam, fileId)).toBe(200);
    expect(await download(lee, fileId)).toBe(200);
    expect(await download(school.kim, fileId)).toBe(404);
    expect(await download(nia, fileId)).toBe(404);
    expect(await download(omar, fileId)).toBe(200);

    // A file swapped in later is tied to the activity too.
    const replacement = await upload(school.teacher, 'activity');
    expect((await school.teacher.patch(`/api/activities/${resource}`, { settings: { fileId: replacement } })).status).toBe(200);
    expect(await download(school.kim, replacement)).toBe(404);
    expect(await download(school.sam, replacement)).toBe(200);
    // Hidden activities' files are hidden from students too.
    expect((await school.teacher.patch(`/api/activities/${resource}`, { visible: false })).status).toBe(200);
    expect(await download(school.sam, fileId)).toBe(404);
  });

  it('only gives staff the submitted files of students they see in the activity', async () => {
    const essay = await activity({ type: 'assignment', title: 'Essay', maxGrade: 10, groupMode: 'separate' });
    const fileId = await upload(school.kim, 'submission');
    expect((await school.kim.put(`/api/activities/${essay}/submission`, { fileIds: [fileId] })).status).toBe(200);
    expect(await download(school.kim, fileId)).toBe(200);
    expect(await download(school.teacher, fileId)).toBe(200);
    expect(await download(school.admin, fileId)).toBe(200);
    expect(await download(tara, fileId)).toBe(404);
    expect(await download(omar, fileId)).toBe(404);
    expect(await download(school.sam, fileId)).toBe(404);
    await school.teacher.patch(`/api/activities/${essay}`, { groupMode: 'visible' });
    expect(await download(tara, fileId)).toBe(200);
  });

  it('keeps forum uploads in the forum and the discussion they were posted in', async () => {
    const teamForum = await activity({ type: 'forum', title: 'Team A room', groupIds: [groupA] });
    const samFile = await upload(school.sam, 'post');
    const started = await school.sam.post(`/api/activities/${teamForum}/discussions`, {
      title: 'Notes',
      body: `See [notes](/api/files/${samFile})`,
    });
    expect(started.status).toBe(201);
    expect(await download(lee, samFile)).toBe(200);
    expect(await download(school.kim, samFile)).toBe(404);

    const separate = await activity({ type: 'forum', title: 'Rooms', groupMode: 'separate' });
    const kimFile = await upload(school.kim, 'post');
    const discussion = (await school.kim.post(`/api/activities/${separate}/discussions`, { title: 'B notes', body: 'Hi' })).body.id;
    const reply = await school.kim.post(`/api/discussions/${discussion}/posts`, { body: `![plan](/api/files/${kimFile})` });
    expect(reply.status).toBe(201);
    expect(await download(lee, kimFile)).toBe(200);
    expect(await download(school.teacher, kimFile)).toBe(200);
    expect(await download(school.sam, kimFile)).toBe(404);
    expect(await download(nia, kimFile)).toBe(404);
    expect(await download(tara, kimFile)).toBe(404);

    // Linking someone else's upload from another discussion doesn't move it.
    await school.sam.post(`/api/activities/${separate}/discussions`, { title: 'A notes', body: `[x](/api/files/${kimFile})` });
    expect(await download(school.sam, kimFile)).toBe(404);
  });
});

describe('changing group membership', () => {
  it("is for teachers only, so assistants can't widen their own view or a restriction", async () => {
    await school.teacher.patch(base, { groupMode: 'separate' });
    const essay = await activity({ type: 'assignment', title: 'Essay', maxGrade: 10 });
    const lesson = await activity({ type: 'lesson', title: 'Team A notes', settings: { body: 'A' }, groupIds: [groupA] });
    expect((await school.kim.put(`/api/activities/${essay}/submission`, { text: 'Mine' })).status).toBe(200);

    expect((await tara.post(`${base}/groups/${groupB}/members`, { userIds: [ids.tara] })).status).toBe(403);
    expect((await omar.post(`${base}/groups/${groupA}/members`, { userIds: [ids.nia] })).status).toBe(403);
    expect((await del(tara, `${base}/groups/${groupA}/members/${ids.sam}`)).status).toBe(403);
    expect((await del(tara, `${base}/groups/${groupA}`)).status).toBe(403);
    expect((await tara.post(`${base}/groups/auto`, { split: 'groups', size: 2 })).status).toBe(403);
    expect((await tara.patch(`${base}/groups/${groupA}`, { name: 'Renamed' })).status).toBe(403);
    expect((await tara.post(`${base}/groups`, { name: 'Mine' })).status).toBe(403);

    expect((await tara.put(`/api/activities/${essay}/grades/${ids.kim}`, { score: 5 })).status).toBe(404);
    expect((await nia.get(`/api/activities/${lesson}`)).status).toBe(404);
    const groups = (await tara.get(`${base}/groups`)).body;
    expect(groups.canManage).toBe(false);
    expect(groups.groups.map((g: { name: string }) => g.name)).toEqual(['Team A', 'Team B']);
  });
});

describe('reports of the new activity types', () => {
  it("limits a package's staff report to the assistant's own groups in separate groups", async () => {
    const pkg = await activity({ type: 'package', title: 'Module', maxGrade: 10, groupMode: 'separate' });
    const rows = async (client: Client) => {
      const res = await client.get(`/api/packages/${pkg}/report`);
      expect(res.status).toBe(200);
      return (res.body.rows as Array<{ user: { id: string } }>).map((r) => r.user.id).sort();
    };
    expect(await rows(school.teacher)).toEqual([ids.sam, ids.kim, ids.lee, ids.nia].sort());
    expect(await rows(tara)).toEqual([ids.sam, ids.lee].sort()); // Team A
    expect(await rows(omar)).toEqual([]); // in no group
    expect(
      (await school.teacher.get(`/api/packages/${pkg}/report?groupId=${groupB}`)).body.rows
        .map((r: { user: { id: string } }) => r.user.id)
        .sort(),
    ).toEqual([ids.kim, ids.lee].sort());
  });
});
