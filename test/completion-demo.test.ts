import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { client, createTestLms, login, type Client } from './helpers.js';

let lms: Coursekit;
let alex: Client;
let maya: Client;

beforeAll(async () => {
  lms = await createTestLms();
  await lms.seedDemo({ password: 'demo-password' });
  alex = await login(lms, 'alex.johnson@coursekit.test', 'demo-password');
  maya = await login(lms, 'maya.chen@coursekit.test', 'demo-password');
});
afterAll(async () => {
  await lms.close();
});

it('has a course with completion, certificates and students who completed it', async () => {
  const spanish = await alex.get('/api/courses/spanish-for-beginners/completion');
  expect(spanish.body).toMatchObject({ enabled: true, completed: true, certificateEnabled: true, certificate: { revoked: false } });
  expect(spanish.body.criteria).toEqual([
    expect.objectContaining({ kind: 'activity', title: 'Greetings and introductions', done: true }),
    expect.objectContaining({ kind: 'activity', title: 'Vocabulary check', done: true }),
    expect.objectContaining({ kind: 'grade', minGrade: 60, met: true }),
  ]);
  const certificates = await lms.db.selectFrom('certificates').selectAll().execute();
  expect(certificates.length).toBeGreaterThanOrEqual(2);
  const check = await client(lms).get(`/api/certificates/verify/${spanish.body.certificate.code}`);
  expect(check.body).toMatchObject({ valid: true, recipientName: 'Alex Johnson', courseTitle: 'Spanish for Beginners' });
  // Completion dates are in the past, when the last requirement was met.
  const completions = await lms.db.selectFrom('courseCompletions').selectAll().execute();
  expect(completions.every((c) => c.completedAt <= new Date().toISOString())).toBe(true);
});

it('tracks Modern Web Development, which nobody has finished yet', async () => {
  const web = await alex.get('/api/courses/modern-web-development/completion');
  expect(web.body).toMatchObject({ enabled: true, completed: false });
  expect(web.body.progress).toBeGreaterThan(0);
  const report = await maya.get('/api/courses/modern-web-development/completion/report');
  expect(report.body.summary).toMatchObject({ students: 12, completed: 0 });
});

it('has course and site badges with awards', async () => {
  const mine = await alex.get('/api/me/badges');
  expect(mine.body.map((b: { badge: { name: string } }) => b.badge.name).sort()).toEqual(
    ['Community helper', 'Landing page pro', 'Language explorer', '¡Hola!'].sort(),
  );
  const courseBadges = await maya.get('/api/courses/modern-web-development/badges');
  expect(courseBadges.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Landing page pro', recipientCount: 3 }),
      expect.objectContaining({ name: 'Web developer', criteria: 'completion', recipientCount: 0 }),
    ]),
  );
  const notes = await alex.get('/api/notifications');
  expect(notes.body.items.filter((n: { type: string }) => n.type === 'badge').length).toBe(4);
});
