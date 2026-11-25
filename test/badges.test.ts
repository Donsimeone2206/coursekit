import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { addActivities, del, finishEverything, settings, settle, type CompletionCourse } from './completion-helpers.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let acts: CompletionCourse;
let courseId: string;
let samId: string;
let kimId: string;

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

const badge = (overrides: Record<string, unknown> = {}) => ({
  name: 'Bug hunter',
  description: 'Found a real bug',
  icon: 'target',
  color: 'emerald',
  ...overrides,
});

const badgeNotes = async (student: Client) =>
  (await student.get('/api/notifications')).body.items.filter((n: { type: string }) => n.type === 'badge');

describe('course badges', () => {
  it('are created by teachers and validated', async () => {
    expect((await school.sam.post(`/api/courses/${courseId}/badges`, badge())).status).toBe(403);
    expect((await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ icon: 'skull' }))).status).toBe(400);
    expect((await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ color: '#ff0000' }))).status).toBe(400);
    expect((await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ name: ' ' }))).status).toBe(400);
    expect(
      (await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ criteria: 'courses', courseIds: [courseId] }))).status,
    ).toBe(400);

    const created = await school.teacher.post(`/api/courses/${courseId}/badges`, badge());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Bug hunter', criteria: 'manual', recipientCount: 0, canManage: true, recipients: [] });
    const asStudent = await school.sam.get(`/api/courses/${courseId}/badges`);
    expect(asStudent.body).toEqual([expect.objectContaining({ id: created.body.id, recipientCount: null, earnedAt: null })]);

    const edited = await school.teacher.patch(`/api/badges/${created.body.id}`, { name: 'Bug squasher', color: 'rose' });
    expect(edited.body).toMatchObject({ name: 'Bug squasher', color: 'rose', icon: 'target' });
    expect((await school.sam.patch(`/api/badges/${created.body.id}`, { name: 'Mine' })).status).toBe(403);
    expect((await del(lms, school.sam, `/api/badges/${created.body.id}`)).status).toBe(403);
    expect((await del(lms, school.teacher, `/api/badges/${created.body.id}`)).status).toBe(200);
    expect((await school.teacher.get(`/api/badges/${created.body.id}`)).status).toBe(404);
  });

  it('are awarded manually once, notify the student, and can be revoked and restored', async () => {
    const events: string[] = [];
    lms.events.on('badge.awarded', (e) => void events.push(`+${e.userId}`));
    lms.events.on('badge.revoked', (e) => void events.push(`-${e.userId}`));
    const { body } = await school.teacher.post(`/api/courses/${courseId}/badges`, badge());

    expect((await school.sam.post(`/api/badges/${body.id}/awards`, { userIds: [samId] })).status).toBe(403);
    const first = await school.teacher.post(`/api/badges/${body.id}/awards`, { userIds: [samId], note: 'Great catch!' });
    expect(first.body).toEqual({ awarded: 1, alreadyAwarded: 0 });
    const second = await school.teacher.post(`/api/badges/${body.id}/awards`, { userIds: [samId] });
    expect(second.body).toEqual({ awarded: 0, alreadyAwarded: 1 });
    expect(await badgeNotes(school.sam)).toHaveLength(1);

    const mine = await school.sam.get('/api/me/badges');
    expect(mine.body).toEqual([expect.objectContaining({ note: 'Great catch!', badge: expect.objectContaining({ id: body.id }) })]);
    const detail = await school.sam.get(`/api/badges/${body.id}`);
    expect(detail.body).toMatchObject({ earnedAt: expect.any(String), earnedNote: 'Great catch!', recipients: null, canAward: false });

    // Only staff see who has the badge.
    const staffView = await school.teacher.get(`/api/badges/${body.id}`);
    expect(staffView.body.recipients).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: samId, email: 'sam@test.dev' }),
        awardedBy: expect.objectContaining({ name: 'Tina Teacher' }),
      }),
    ]);

    expect((await del(lms, school.kim, `/api/badges/${body.id}/awards/${samId}`)).status).toBe(403);
    expect((await del(lms, school.teacher, `/api/badges/${body.id}/awards/${samId}`)).status).toBe(200);
    expect((await del(lms, school.teacher, `/api/badges/${body.id}/awards/${samId}`)).status).toBe(200);
    expect((await del(lms, school.teacher, `/api/badges/${body.id}/awards/${kimId}`)).status).toBe(404);
    expect((await school.sam.get('/api/me/badges')).body).toEqual([]);
    expect((await school.teacher.get(`/api/badges/${body.id}`)).body).toMatchObject({
      recipientCount: 0,
      recipients: [expect.objectContaining({ revokedAt: expect.any(String) })],
    });

    const restored = await school.teacher.post(`/api/badges/${body.id}/awards`, { userIds: [samId] });
    expect(restored.body.awarded).toBe(1);
    expect(await badgeNotes(school.sam)).toHaveLength(2);
    await settle(lms);
    expect(events).toEqual([`+${samId}`, `-${samId}`, `+${samId}`]);
  });

  it('only go to people enrolled in the course', async () => {
    const { body } = await school.teacher.post(`/api/courses/${courseId}/badges`, badge());
    await lms.createUser({ name: 'Out Sider', email: 'out@test.dev', password: PASSWORD });
    const outsider = await login(lms, 'out@test.dev');
    const outsiderId = (await outsider.get('/api/auth/session')).body.user.id;
    expect((await school.teacher.post(`/api/badges/${body.id}/awards`, { userIds: [outsiderId] })).status).toBe(400);
    expect((await school.teacher.post(`/api/badges/${body.id}/awards`, { userIds: [] })).status).toBe(400);
    // Outsiders can't see the course's badges.
    expect((await outsider.get(`/api/badges/${body.id}`)).status).toBe(404);
    expect((await outsider.get(`/api/courses/${courseId}/badges`)).status).toBe(403);
  });

  it('let teaching assistants award but not create or edit badges', async () => {
    await lms.createUser({ name: 'Ann Assistant', email: 'ann@test.dev', password: PASSWORD });
    await school.teacher.post(`/api/courses/${courseId}/participants`, { emails: ['ann@test.dev'], role: 'assistant' });
    const ann = await login(lms, 'ann@test.dev');
    const { body } = await school.teacher.post(`/api/courses/${courseId}/badges`, badge());
    expect((await ann.post(`/api/courses/${courseId}/badges`, badge())).status).toBe(403);
    expect((await ann.patch(`/api/badges/${body.id}`, { name: 'x' })).status).toBe(403);
    expect((await ann.post(`/api/badges/${body.id}/awards`, { userIds: [kimId] })).body.awarded).toBe(1);
    const forKim = await ann.get(`/api/courses/${courseId}/badges?for=${kimId}`);
    expect(forKim.body[0]).toMatchObject({ earnedAt: expect.any(String), recipientCount: 1 });
    expect((await school.sam.get(`/api/courses/${courseId}/badges?for=${kimId}`)).status).toBe(403);
  });

  it('are awarded automatically on completing the course, once, and revoked awards stay revoked', async () => {
    const { body } = await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ name: 'Graduate', criteria: 'completion' }));
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await finishEverything(school.sam, acts);
    await settle(lms);
    expect((await school.sam.get('/api/me/badges')).body).toEqual([
      expect.objectContaining({ badge: expect.objectContaining({ id: body.id }) }),
    ]);
    const auto = (await school.teacher.get(`/api/badges/${body.id}`)).body.recipients[0];
    expect(auto.awardedBy).toBeNull();

    await del(lms, school.teacher, `/api/badges/${body.id}/awards/${samId}`);
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await school.teacher.patch(`/api/badges/${body.id}`, { description: 'Finished the course' });
    await settle(lms);
    expect((await school.sam.get('/api/me/badges')).body).toEqual([]);
    expect(await badgeNotes(school.sam)).toHaveLength(1);
  });

  it('created after people completed the course are awarded to them', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await finishEverything(school.sam, acts);
    await settle(lms);
    const created = await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ criteria: 'completion' }));
    expect(created.body.recipientCount).toBe(1);
    const manual = await school.teacher.post(`/api/courses/${courseId}/badges`, badge({ name: 'Helper' }));
    expect(manual.body.recipientCount).toBe(0);
    const switched = await school.teacher.patch(`/api/badges/${manual.body.id}`, { criteria: 'completion' });
    expect(switched.body.recipientCount).toBe(1);
  });
});

describe('site badges', () => {
  it('are managed by administrators only', async () => {
    expect((await school.teacher.post('/api/badges', badge())).status).toBe(403);
    expect((await school.teacher.get('/api/badges')).status).toBe(403);
    expect((await school.admin.post('/api/badges', badge({ criteria: 'completion' }))).status).toBe(400);
    expect((await school.admin.post('/api/badges', badge({ criteria: 'courses', courseIds: [] }))).status).toBe(400);
    expect((await school.admin.post('/api/badges', badge({ criteria: 'courses', courseIds: ['nope'] }))).status).toBe(400);
    const created = await school.admin.post('/api/badges', badge({ name: 'Helper' }));
    expect(created.status).toBe(201);
    expect(created.body.course).toBeNull();
    expect((await school.admin.get('/api/badges')).body).toHaveLength(1);
    expect((await school.teacher.post(`/api/badges/${created.body.id}/awards`, { userIds: [samId] })).status).toBe(403);
    expect((await school.admin.post(`/api/badges/${created.body.id}/awards`, { userIds: [samId, kimId] })).body.awarded).toBe(2);
    // Anyone signed in can open a site badge, but only administrators see the recipients.
    expect((await school.kim.get(`/api/badges/${created.body.id}`)).body).toMatchObject({ earnedAt: expect.any(String), recipients: null });
    expect((await school.admin.get(`/api/badges/${created.body.id}`)).body.recipients).toHaveLength(2);
  });

  it('are awarded when someone has completed every listed course', async () => {
    const second = await school.teacher.post('/api/courses', { title: 'Testing 201', visibility: 'published' });
    const secondDetail = await school.teacher.get(`/api/courses/${second.body.id}`);
    const secondLesson = await school.teacher.post(`/api/courses/${second.body.id}/activities`, {
      sectionId: secondDetail.body.sections[0].id,
      type: 'lesson',
      title: 'Only lesson',
    });
    await school.sam.post(`/api/courses/${second.body.id}/enrol`);
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await school.teacher.put(`/api/courses/${second.body.id}/completion/settings`, settings());
    const { body } = await school.admin.post(
      '/api/badges',
      badge({ name: 'Test master', criteria: 'courses', courseIds: [courseId, second.body.id] }),
    );
    expect(body.criteriaCourses.map((c: { id: string }) => c.id)).toEqual([courseId, second.body.id]);

    await finishEverything(school.sam, acts);
    await settle(lms);
    expect((await school.sam.get('/api/me/badges')).body).toEqual([]);
    await school.sam.post(`/api/activities/${secondLesson.body.id}/complete`);
    await settle(lms);
    expect((await school.sam.get('/api/me/badges')).body).toEqual([
      expect.objectContaining({ badge: expect.objectContaining({ id: body.id }) }),
    ]);
    expect(await badgeNotes(school.sam)).toHaveLength(1);

    // Deleting one of the courses removes it from the criteria.
    await del(lms, school.teacher, `/api/courses/${second.body.id}`);
    await settle(lms);
    const after = await school.admin.get(`/api/badges/${body.id}`);
    expect(after.body.criteriaCourses.map((c: { id: string }) => c.id)).toEqual([courseId]);
  });
});
