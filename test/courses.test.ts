import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { createTestLms, setupSchool } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
});
afterEach(async () => {
  await lms.close();
});

describe('courses', () => {
  it('only lets instructors and admins create courses', async () => {
    const res = await school.sam.post('/api/courses', { title: 'My course' });
    expect(res.status).toBe(403);
  });

  it('gives the creator the teacher role and a first section', async () => {
    const detail = await school.teacher.get(`/api/courses/${school.course.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.myRole).toBe('teacher');
    expect(detail.body.sections).toHaveLength(1);
    expect(detail.body.capabilities).toContain('course:manageContent');
  });

  it('hides drafts from students and the catalog', async () => {
    const draft = await school.teacher.post('/api/courses', { title: 'Secret draft' });
    expect((await school.sam.get(`/api/courses/${draft.body.id}`)).status).toBe(404);
    const catalog = await school.sam.get('/api/courses');
    expect(catalog.body.items.map((c: { title: string }) => c.title)).toEqual(['Testing 101']);
  });

  it('gives unique slugs to courses with the same title', async () => {
    const again = await school.teacher.post('/api/courses', { title: 'Testing 101' });
    expect(again.body.slug).toBe('testing-101-2');
  });
});

describe('enrolment', () => {
  it('shows only the outline before enrolling, then the full course', async () => {
    const before = await school.sam.get(`/api/courses/${school.course.id}`);
    expect(before.body.outlineOnly).toBe(true);
    expect(before.body.canEnrol).toBe(true);

    expect((await school.sam.post(`/api/courses/${school.course.id}/enrol`)).status).toBe(201);
    const after = await school.sam.get(`/api/courses/${school.course.id}`);
    expect(after.body.outlineOnly).toBe(false);
    expect(after.body.myRole).toBe('student');
    expect(after.body.progress).toBe(0);
  });

  it('requires the right enrolment key', async () => {
    await school.teacher.patch(`/api/courses/${school.course.id}`, { enrolment: 'key', enrolmentKey: 'open-sesame' });
    expect((await school.sam.post(`/api/courses/${school.course.id}/enrol`, { key: 'wrong' })).status).toBe(400);
    expect((await school.sam.post(`/api/courses/${school.course.id}/enrol`, { key: 'open-sesame' })).status).toBe(201);
  });

  it('lets teachers enrol people by email and notifies them', async () => {
    const res = await school.teacher.post(`/api/courses/${school.course.id}/participants`, {
      emails: ['kim@test.dev', 'nobody@test.dev'],
      role: 'student',
    });
    expect(res.body).toMatchObject({ added: 1, notFound: ['nobody@test.dev'] });
    const notes = await school.kim.get('/api/notifications');
    expect(notes.body.unreadCount).toBe(1);
  });

  it('hides participant emails from students', async () => {
    await school.sam.post(`/api/courses/${school.course.id}/enrol`);
    const asStudent = await school.sam.get(`/api/courses/${school.course.id}/participants`);
    expect(asStudent.body.every((p: { user: { email: string | null } }) => p.user.email === null)).toBe(true);
    const asTeacher = await school.teacher.get(`/api/courses/${school.course.id}/participants`);
    expect(asTeacher.body.some((p: { user: { email: string | null } }) => p.user.email === 'sam@test.dev')).toBe(true);
  });
});

describe('course content', () => {
  it('validates activity settings and rejects unsafe links', async () => {
    const bad = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'resource',
      title: 'Bad link',
      settings: { kind: 'link', url: 'javascript:alert(1)' },
    });
    expect(bad.status).toBe(400);
  });

  it('tracks manual completion and course progress', async () => {
    await school.sam.post(`/api/courses/${school.course.id}/enrol`);
    const a = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'lesson',
      title: 'Read me',
      settings: { body: '# Hello' },
    });
    await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'lesson',
      title: 'Read me too',
      settings: { body: '# Hello again' },
    });
    await school.sam.post(`/api/activities/${a.body.id}/complete`);
    const detail = await school.sam.get(`/api/courses/${school.course.id}`);
    expect(detail.body.progress).toBe(50);
  });

  it('does not let students edit content or see hidden activities', async () => {
    await school.sam.post(`/api/courses/${school.course.id}/enrol`);
    const hidden = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'lesson',
      title: 'Not yet',
      visible: false,
    });
    expect((await school.sam.get(`/api/activities/${hidden.body.id}`)).status).toBe(404);
    expect((await school.sam.patch(`/api/activities/${hidden.body.id}`, { title: 'Hacked' })).status).toBe(404);
    const detail = await school.sam.get(`/api/courses/${school.course.id}`);
    expect(detail.body.sections[0].activities).toHaveLength(0);
  });
});
