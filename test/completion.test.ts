import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { evaluateCompletion } from '../src/server/services/completion.js';
import { courseTotals } from '../src/server/services/course-total.js';
import { addActivities, certificate, del, finishEverything, settings, settle, type CompletionCourse } from './completion-helpers.js';
import { createTestLms, login, PASSWORD, setupSchool } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let acts: CompletionCourse;
let samId: string;
let kimId: string;
let courseId: string;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  courseId = school.course.id;
  await school.sam.post(`/api/courses/${courseId}/enrol`);
  await school.kim.post(`/api/courses/${courseId}/enrol`);
  acts = await addActivities(school.teacher, courseId, school.sectionId);
  const people = await school.teacher.get(`/api/courses/${courseId}/participants`);
  const idOf = (email: string) => people.body.find((p: { user: { email: string } }) => p.user.email === email).user.id as string;
  samId = idOf('sam@test.dev');
  kimId = idOf('kim@test.dev');
});
afterEach(async () => {
  await lms.close();
});

const status = async (client = school.sam) => (await client.get(`/api/courses/${courseId}/completion`)).body;

describe('course totals', () => {
  it('match the gradebook percentage and are null until something is graded', async () => {
    const quiz = await school.teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'Second essay',
      maxGrade: 30,
      settings: { submissionTypes: ['text'] },
    });
    expect((await courseTotals(lms.db, courseId, [samId, kimId])).get(samId)).toBeNull();
    await school.teacher.put(`/api/courses/${courseId}/grades/${acts.assignment}/${samId}`, { score: 15 });
    await school.teacher.put(`/api/courses/${courseId}/grades/${quiz.body.id}/${samId}`, { score: 11 });
    const totals = await courseTotals(lms.db, courseId, [samId, kimId, 'nobody']);
    expect(totals.get(samId)).toBe(52);
    expect(totals.get(kimId)).toBeNull();
    expect(totals.get('nobody')).toBeNull();
    const book = await school.teacher.get(`/api/courses/${courseId}/grades`);
    const row = book.body.gradebook.rows.find((r: { user: { id: string } }) => r.user.id === samId);
    expect(row.percentage).toBe(52);
  });
});

describe('completion criteria', () => {
  it('completes the course once every tracked activity is done, and only once', async () => {
    const completed: string[] = [];
    lms.events.on('course.completed', (e) => void completed.push(e.userId));
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());

    await school.sam.post(`/api/activities/${acts.lessonA}/complete`);
    await settle(lms);
    expect(await status()).toMatchObject({ enabled: true, completed: false, progress: 33 });

    await finishEverything(school.sam, acts);
    await settle(lms);
    const done = await status();
    expect(done.completed).toBe(true);
    expect(done.completedAt).toEqual(expect.any(String));
    expect(done.criteria.every((c: { done: boolean }) => c.done)).toBe(true);
    expect(completed).toEqual([samId]);

    // More events, re-saving the settings and opening the report don't complete it again.
    await del(lms, school.sam, `/api/activities/${acts.lessonA}/complete`);
    await school.sam.post(`/api/activities/${acts.lessonA}/complete`);
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await school.teacher.get(`/api/courses/${courseId}/completion/report`);
    await settle(lms);
    expect(completed).toEqual([samId]);
    const notes = await school.sam.get('/api/notifications');
    expect(notes.body.items.filter((n: { type: string }) => n.type === 'completion')).toHaveLength(1);
    const rows = await lms.db.selectFrom('courseCompletions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect((await status(school.kim)).completed).toBe(false);
  });

  it('ignores hidden activities and activities without completion tracking', async () => {
    await school.teacher.patch(`/api/activities/${acts.lessonB}`, { visible: false });
    await school.teacher.patch(`/api/activities/${acts.assignment}`, { completion: 'none' });
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    expect((await status()).criteria).toHaveLength(1);
    await school.sam.post(`/api/activities/${acts.lessonA}/complete`);
    await settle(lms);
    expect((await status()).completed).toBe(true);
  });

  it('only requires the selected activities in "selected" mode', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ mode: 'selected', activityIds: [acts.lessonB] }));
    await school.sam.post(`/api/activities/${acts.lessonA}/complete`);
    await settle(lms);
    expect((await status()).completed).toBe(false);
    await school.sam.post(`/api/activities/${acts.lessonB}/complete`);
    await settle(lms);
    const s = await status();
    expect(s.completed).toBe(true);
    expect(s.criteria).toEqual([expect.objectContaining({ kind: 'activity', activityId: acts.lessonB, done: true })]);
  });

  it('waits for the minimum course grade and completes when a grade changes', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ minGrade: 70 }));
    await finishEverything(school.sam, acts);
    await school.teacher.put(`/api/activities/${acts.assignment}/grades/${samId}`, { score: 12 });
    await settle(lms);
    let s = await status();
    expect(s.completed).toBe(false);
    expect(s.criteria.at(-1)).toEqual({ kind: 'grade', minGrade: 70, current: 60, met: false });

    // The teacher raises the grade from the gradebook: grade.updated triggers the check.
    await school.teacher.put(`/api/courses/${courseId}/grades/${acts.assignment}/${samId}`, { score: 14 });
    await settle(lms);
    s = await status();
    expect(s.completed).toBe(true);
    expect(s.criteria.at(-1)).toMatchObject({ kind: 'grade', current: 70, met: true });
  });

  it('re-evaluates everyone when the criteria change, and keeps earlier completions', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    for (const student of [school.sam, school.kim]) await student.post(`/api/activities/${acts.lessonA}/complete`);
    await settle(lms);
    expect((await status()).completed).toBe(false);

    const res = await school.teacher.put(
      `/api/courses/${courseId}/completion/settings`,
      settings({ mode: 'selected', activityIds: [acts.lessonA] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.newlyCompleted).toBe(2);
    expect((await status(school.kim)).completed).toBe(true);

    // Stricter criteria later don't take a completion away.
    const again = await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ minGrade: 90 }));
    expect(again.body.newlyCompleted).toBe(0);
    expect((await status()).completed).toBe(true);
  });

  it('records nothing while completion tracking is off, and only for students', async () => {
    await finishEverything(school.sam, acts);
    await settle(lms);
    expect(await status()).toMatchObject({ enabled: false, completed: false, criteria: [] });

    await school.teacher.post(`/api/activities/${acts.lessonA}/complete`);
    await school.teacher.post(`/api/activities/${acts.lessonB}/complete`);
    const res = await school.teacher.put(
      `/api/courses/${courseId}/completion/settings`,
      settings({ mode: 'selected', activityIds: [acts.lessonA] }),
    );
    expect(res.body.newlyCompleted).toBe(1);
    const rows = await lms.db.selectFrom('courseCompletions').select('userId').execute();
    expect(rows.map((r) => r.userId)).toEqual([samId]);
  });

  it('cannot be completed when there is nothing to complete', async () => {
    for (const id of Object.values(acts)) await school.teacher.patch(`/api/activities/${id}`, { completion: 'none' });
    const res = await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    expect(res.body.newlyCompleted).toBe(0);
    expect((await status()).completed).toBe(false);
  });

  it('completes once, with one certificate and one award, when checks run at the same time', async () => {
    await school.teacher.post(`/api/courses/${courseId}/badges`, {
      name: 'Graduate',
      icon: 'award',
      color: 'gold',
      criteria: 'completion',
    });
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ certificate }));
    const ts = new Date().toISOString();
    // Sam has done everything, recorded without events so that only the checks below run.
    await lms.db
      .insertInto('completions')
      .values(Object.values(acts).map((activityId) => ({ activityId, userId: samId, courseId, completedAt: ts })))
      .execute();
    const deps = { db: lms.db, events: lms.events };
    const results = await Promise.all([
      evaluateCompletion(deps, courseId, [samId]),
      evaluateCompletion(deps, courseId),
      evaluateCompletion(deps, courseId, [samId, kimId]),
      school.sam.get(`/api/courses/${courseId}/completion`),
    ]);
    expect(results.slice(0, 3).flat()).toEqual([samId]);
    expect(await lms.db.selectFrom('courseCompletions').selectAll().execute()).toHaveLength(1);
    expect(await lms.db.selectFrom('certificates').selectAll().execute()).toHaveLength(1);
    expect(await lms.db.selectFrom('badgeAwards').selectAll().execute()).toHaveLength(1);
    const notes = (await school.sam.get('/api/notifications')).body.items.map((n: { type: string }) => n.type);
    expect(notes.filter((t: string) => t === 'completion')).toHaveLength(1);
    expect(notes.filter((t: string) => t === 'badge')).toHaveLength(1);
  });

  it('suspended students are not completed', async () => {
    const people = await school.teacher.get(`/api/courses/${courseId}/participants`);
    const sam = people.body.find((p: { user: { id: string } }) => p.user.id === samId);
    await finishEverything(school.sam, acts);
    await school.teacher.patch(`/api/courses/${courseId}/participants/${sam.enrolmentId}`, { status: 'suspended' });
    const res = await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    expect(res.body.newlyCompleted).toBe(0);
  });
});

describe('completion report and settings', () => {
  it('shows each student’s progress, grade and completion', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ minGrade: 50 }));
    await finishEverything(school.sam, acts);
    await school.teacher.put(`/api/activities/${acts.assignment}/grades/${samId}`, { score: 18 });
    await school.kim.post(`/api/activities/${acts.lessonA}/complete`);
    await settle(lms);
    const report = await school.teacher.get(`/api/courses/${courseId}/completion/report`);
    expect(report.status).toBe(200);
    expect(report.body.summary).toEqual({ students: 2, completed: 1, inProgress: 1, notStarted: 0 });
    const sam = report.body.rows.find((r: { user: { id: string } }) => r.user.id === samId);
    expect(sam).toMatchObject({ activitiesDone: 3, activitiesTotal: 3, grade: 90, gradeMet: true, progress: 100 });
    expect(sam.completedAt).toEqual(expect.any(String));
    const kim = report.body.rows.find((r: { user: { id: string } }) => r.user.id === kimId);
    expect(kim).toMatchObject({ activitiesDone: 1, grade: null, gradeMet: false, progress: 25, completedAt: null });
  });

  it('lists activities for the settings form and validates the criteria', async () => {
    const res = await school.teacher.get(`/api/courses/${courseId}/completion/settings`);
    expect(res.body.settings).toMatchObject({ enabled: false, mode: 'all', minGrade: null });
    expect(res.body.activities.map((a: { id: string }) => a.id)).toEqual([acts.lessonA, acts.lessonB, acts.assignment]);

    const other = await school.teacher.post('/api/courses', { title: 'Other course' });
    const otherDetail = await school.teacher.get(`/api/courses/${other.body.id}`);
    const foreign = await school.teacher.post(`/api/courses/${other.body.id}/activities`, {
      sectionId: otherDetail.body.sections[0].id,
      type: 'lesson',
      title: 'Elsewhere',
    });
    const put = (body: unknown) => school.teacher.put(`/api/courses/${courseId}/completion/settings`, body);
    expect((await put(settings({ mode: 'selected', activityIds: [foreign.body.id] }))).status).toBe(400);
    expect((await put(settings({ mode: 'selected', activityIds: [] }))).status).toBe(400);
    expect((await put(settings({ minGrade: 120 }))).status).toBe(400);
    expect((await put(settings({ mode: 'sometimes' }))).status).toBe(400);
    expect((await put({ ...settings(), certificate: { enabled: true, title: '', body: 'x' } })).status).toBe(400);
    expect((await put(settings({ mode: 'selected', activityIds: [acts.lessonA, acts.lessonA] }))).body.settings.activityIds).toEqual([
      acts.lessonA,
    ]);
  });

  it('checks permissions on every endpoint', async () => {
    await lms.createUser({ name: 'Ann Assistant', email: 'ann@test.dev', password: PASSWORD });
    await school.teacher.post(`/api/courses/${courseId}/participants`, { emails: ['ann@test.dev'], role: 'assistant' });
    const ann = await login(lms, 'ann@test.dev');
    await lms.createUser({ name: 'Out Sider', email: 'out@test.dev', password: PASSWORD });
    const outsider = await login(lms, 'out@test.dev');

    expect((await school.sam.get(`/api/courses/${courseId}/completion/report`)).status).toBe(403);
    expect((await school.sam.get(`/api/courses/${courseId}/completion/settings`)).status).toBe(403);
    expect((await school.sam.put(`/api/courses/${courseId}/completion/settings`, settings())).status).toBe(403);
    expect((await school.sam.get(`/api/courses/${courseId}/certificates`)).status).toBe(403);
    expect((await ann.get(`/api/courses/${courseId}/completion/report`)).status).toBe(200);
    expect((await ann.get(`/api/courses/${courseId}/certificates`)).status).toBe(200);
    expect((await ann.put(`/api/courses/${courseId}/completion/settings`, settings())).status).toBe(403);
    expect((await outsider.get(`/api/courses/${courseId}/completion`)).status).toBe(403);
    expect((await outsider.get(`/api/courses/${courseId}/completion/report`)).status).toBe(403);
    expect((await school.admin.put(`/api/courses/${courseId}/completion/settings`, settings())).status).toBe(200);
    expect((await lms.app.request(`/api/courses/${courseId}/completion`)).status).toBe(401);
  });
});
