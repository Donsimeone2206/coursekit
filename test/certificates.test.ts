import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCertificateCode } from '../src/shared/completion.js';
import type { Coursekit } from '../src/server/index.js';
import { addActivities, certificate, del, finishEverything, settings, settle, type CompletionCourse } from './completion-helpers.js';
import { client, createTestLms, setupSchool } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let acts: CompletionCourse;
let courseId: string;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  courseId = school.course.id;
  await school.sam.post(`/api/courses/${courseId}/enrol`);
  await school.kim.post(`/api/courses/${courseId}/enrol`);
  acts = await addActivities(school.teacher, courseId, school.sectionId);
});
afterEach(async () => {
  await lms.close();
});

async function completeWithCertificate() {
  await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ certificate }));
  await finishEverything(school.sam, acts);
  await settle(lms);
  const status = await school.sam.get(`/api/courses/${courseId}/completion`);
  expect(status.body.certificate).toEqual({
    id: expect.any(String),
    code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/),
    revoked: false,
  });
  return status.body.certificate as { id: string; code: string };
}

describe('certificates', () => {
  it('issues one certificate on completion with a snapshot of the name and course', async () => {
    const issued: string[] = [];
    lms.events.on('certificate.issued', (e) => void issued.push(e.certificateId));
    const ref = await completeWithCertificate();

    const own = await school.sam.get(`/api/certificates/${ref.id}`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      code: ref.code,
      recipientName: 'Sam Student',
      courseTitle: 'Testing 101',
      title: 'Certificate of Completion',
      body: certificate.body,
      signatureName: 'Tina Teacher',
      signatureTitle: 'Course lead',
      revokedAt: null,
      canManage: false,
    });
    expect(issued).toEqual([ref.id]);

    // Later edits to the name, the course and the template don't change an issued certificate.
    await school.sam.patch('/api/auth/me', { name: 'Samantha Student' });
    await school.teacher.patch(`/api/courses/${courseId}`, { title: 'Testing 102' });
    await school.teacher.put(
      `/api/courses/${courseId}/completion/settings`,
      settings({ certificate: { ...certificate, title: 'Diploma' } }),
    );
    const later = await school.sam.get(`/api/certificates/${ref.id}`);
    expect(later.body).toMatchObject({ recipientName: 'Sam Student', courseTitle: 'Testing 101', title: 'Certificate of Completion' });
    expect((await lms.db.selectFrom('certificates').selectAll().execute()).length).toBe(1);
    await settle(lms);
    expect(issued).toEqual([ref.id]);

    const mine = await school.sam.get('/api/me/certificates');
    expect(mine.body).toEqual([
      expect.objectContaining({ id: ref.id, courseTitle: 'Testing 101', course: expect.objectContaining({ id: courseId }) }),
    ]);
    expect((await school.kim.get('/api/me/certificates')).body).toEqual([]);
  });

  it('only shows a certificate to its owner, the course staff and administrators', async () => {
    const ref = await completeWithCertificate();
    expect((await school.kim.get(`/api/certificates/${ref.id}`)).status).toBe(404);
    expect((await client(lms).get(`/api/certificates/${ref.id}`)).status).toBe(401);
    const asTeacher = await school.teacher.get(`/api/certificates/${ref.id}`);
    expect(asTeacher.status).toBe(200);
    expect(asTeacher.body.canManage).toBe(true);
    expect((await school.admin.get(`/api/certificates/${ref.id}`)).body.canManage).toBe(true);
    const list = await school.teacher.get(`/api/courses/${courseId}/certificates`);
    expect(list.body).toEqual([expect.objectContaining({ id: ref.id, recipientName: 'Sam Student' })]);
  });

  it('can be verified publicly without revealing anything private', async () => {
    const ref = await completeWithCertificate();
    const anonymous = client(lms);
    for (const code of [ref.code, ref.code.toLowerCase(), ref.code.replace(/-/g, ' ')]) {
      const res = await anonymous.get(`/api/certificates/verify/${encodeURIComponent(code)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: ref.code,
        valid: true,
        status: 'valid',
        recipientName: 'Sam Student',
        courseTitle: 'Testing 101',
        completedAt: expect.any(String),
      });
    }
    const text = JSON.stringify((await anonymous.get(`/api/certificates/verify/${ref.code}`)).body);
    for (const secret of ['sam@test.dev', ref.id, courseId, 'Tina Teacher', 'This certifies']) expect(text).not.toContain(secret);

    expect((await anonymous.get('/api/certificates/verify/AAAA-BBBB-CCCC')).status).toBe(404);
    expect((await anonymous.get('/api/certificates/verify/not-a-code')).status).toBe(404);
    expect(normalizeCertificateCode(' 7qk2-m9xd-4tpo ')).toBe('7QK2M9XD4TP0');
    expect(normalizeCertificateCode('ABC')).toBeNull();
  });

  it('lets teachers revoke and restore, and verification shows it', async () => {
    const ref = await completeWithCertificate();
    expect((await school.sam.post(`/api/certificates/${ref.id}/revoke`, {})).status).toBe(403);
    expect((await school.kim.post(`/api/certificates/${ref.id}/revoke`, {})).status).toBe(404);

    const revoked = await school.teacher.post(`/api/certificates/${ref.id}/revoke`, { reason: 'Issued by mistake' });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revokedAt: expect.any(String), revokeReason: 'Issued by mistake' });
    const check = await client(lms).get(`/api/certificates/verify/${ref.code}`);
    expect(check.body).toMatchObject({ valid: false, status: 'revoked' });
    expect(JSON.stringify(check.body)).not.toContain('mistake');

    // Re-evaluating doesn't issue a new certificate for a revoked one.
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ certificate }));
    expect((await lms.db.selectFrom('certificates').selectAll().execute()).length).toBe(1);

    const restored = await school.teacher.post(`/api/certificates/${ref.id}/restore`);
    expect(restored.body.revokedAt).toBeNull();
    expect((await client(lms).get(`/api/certificates/verify/${ref.code}`)).body.valid).toBe(true);
  });

  it('issues certificates to people who completed before certificates were turned on', async () => {
    await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings());
    await finishEverything(school.sam, acts);
    await settle(lms);
    expect((await school.sam.get(`/api/courses/${courseId}/completion`)).body).toMatchObject({ completed: true, certificate: null });

    const res = await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ certificate }));
    expect(res.body).toMatchObject({ newlyCompleted: 0, certificatesIssued: 1 });
    const again = await school.teacher.put(`/api/courses/${courseId}/completion/settings`, settings({ certificate }));
    expect(again.body.certificatesIssued).toBe(0);
    const notes = await school.sam.get('/api/notifications');
    expect(notes.body.items.filter((n: { title: string }) => n.title.startsWith('Your certificate'))).toHaveLength(1);
  });

  it('stays verifiable after the course is deleted', async () => {
    const ref = await completeWithCertificate();
    expect((await del(lms, school.teacher, `/api/courses/${courseId}`)).status).toBe(200);
    const check = await client(lms).get(`/api/certificates/verify/${ref.code}`);
    expect(check.body).toMatchObject({ valid: true, courseTitle: 'Testing 101' });
    const own = await school.sam.get(`/api/certificates/${ref.id}`);
    expect(own.body).toMatchObject({ course: null, courseTitle: 'Testing 101' });
    expect((await school.teacher.get(`/api/certificates/${ref.id}`)).status).toBe(404);
  });
});
