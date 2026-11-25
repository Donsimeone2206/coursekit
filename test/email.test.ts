import { afterEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { notify } from '../src/server/services/notify.js';
import { emailSecret, signUnsubscribeToken, verifyUnsubscribeToken } from '../src/server/services/email/tokens.js';
import { emailCategoryOf } from '../src/shared/email.js';
import { createEmailLms, memoryTransport, outbox, PUBLIC_URL, tokenFrom, type MemoryTransport } from './email-helpers.js';
import { client, createTestLms, setupSchool } from './helpers.js';

let lms: Coursekit;
let transport: MemoryTransport;

afterEach(async () => {
  await lms.close();
});

async function school(options: Parameters<typeof createEmailLms>[1] = {}) {
  transport = memoryTransport();
  lms = await createEmailLms(transport, options);
  const s = await setupSchool(lms);
  await s.sam.post(`/api/courses/${s.course.id}/enrol`);
  await s.kim.post(`/api/courses/${s.course.id}/enrol`);
  return s;
}

const announce = (s: Awaited<ReturnType<typeof school>>, title = 'Exam moved', body = 'The exam is now on Friday.') =>
  s.teacher.post(`/api/courses/${s.course.id}/announcements`, { title, body });

describe('immediate notification emails', () => {
  it('queues one email per recipient who wants them immediately, and delivers it from the outbox', async () => {
    const s = await school();
    await s.kim.put('/api/email/preferences', { frequency: 'daily' });
    expect((await announce(s)).status).toBe(201);

    const rows = await outbox(lms);
    expect(rows.map((r) => [r.toAddress, r.kind, r.status])).toEqual([['sam@test.dev', 'notification', 'pending']]);
    expect(rows[0]!.notificationId).toBeTruthy();
    expect(transport.sent).toHaveLength(0); // nothing is sent during the request

    expect(await lms.email.processOutbox()).toEqual({ sent: 1, failed: 0, retrying: 0 });
    const [message] = transport.sent;
    expect(message!.to).toBe('sam@test.dev');
    expect(message!.from).toBe('"Coursekit" <no-reply@learn.example.test>');
    expect(message!.subject).toBe('Testing 101: Exam moved');
    expect(message!.html).toContain(`${PUBLIC_URL}/courses/testing-101/announcements`);
    expect(message!.text).toContain('The exam is now on Friday.');
    expect(message!.text).toContain(`Manage email preferences: ${PUBLIC_URL}/profile?section=email`);
    expect(message!.headers['List-Unsubscribe']).toMatch(/^<https:\/\/learn\.example\.test\/unsubscribe\?token=[^>]+>$/);
    expect(message!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(message!.headers['Auto-Submitted']).toBe('auto-generated');
    expect((await outbox(lms))[0]).toMatchObject({ status: 'sent', attempts: 1, lockId: null });
  });

  it('respects "off", per-category opt-outs and suspended accounts', async () => {
    const s = await school();
    await s.sam.put('/api/email/preferences', { disabledCategories: ['announcements'] });
    await s.kim.put('/api/email/preferences', { frequency: 'off' });
    await announce(s);
    expect(await outbox(lms)).toHaveLength(0);

    // Grades are a different category, so Sam still gets those.
    const sam = await lms.db.selectFrom('users').select('id').where('email', '=', 'sam@test.dev').executeTakeFirstOrThrow();
    await notify(lms.db, [sam.id], {
      type: 'grade',
      title: 'New grade for Essay',
      body: 'You received 9 / 10.',
      link: '/courses/testing-101/grades',
    });
    expect((await outbox(lms)).map((r) => r.subject)).toEqual(['New grade for Essay']);

    await lms.db.updateTable('users').set({ status: 'suspended' }).where('id', '=', sam.id).execute();
    await notify(lms.db, [sam.id], { type: 'grade', title: 'Another grade' });
    expect(await outbox(lms)).toHaveLength(1);
  });

  it('follows the site default until someone chooses, and the admin can change the default', async () => {
    const s = await school();
    const before = await s.sam.get('/api/email/preferences');
    expect(before.body).toMatchObject({ frequency: 'immediately', isDefault: true, siteDefault: 'immediately', deliveryEnabled: true });

    expect((await s.admin.put('/api/admin/email/settings', { defaultFrequency: 'weekly' })).status).toBe(200);
    await s.kim.put('/api/email/preferences', { frequency: 'immediately' });
    expect((await s.sam.get('/api/email/preferences')).body).toMatchObject({ frequency: 'weekly', isDefault: true });

    await announce(s);
    expect((await outbox(lms)).map((r) => r.toAddress)).toEqual(['kim@test.dev']);
  });

  it('escapes notification content and keeps headers on one line', async () => {
    const s = await school();
    await announce(s, 'Read <script>alert(1)</script>\r\nBcc: victim@example.test & "this"', 'Line one\n<img src=x onerror=alert(1)>');
    await lms.email.processOutbox();
    const [message] = transport.sent;
    expect(message!.subject).toBe('Testing 101: Read <script>alert(1)</script> Bcc: victim@example.test & "this"');
    expect(message!.html).not.toContain('<script>');
    expect(message!.html).not.toContain('<img src=x');
    expect(message!.html).toContain('Read &lt;script&gt;alert(1)&lt;/script&gt; Bcc: victim@example.test &amp; &quot;this&quot;');
    expect(message!.html).toContain('Line one<br>&lt;img src=x onerror=alert(1)&gt;');
    expect(message!.text).toContain('Line one\n<img src=x onerror=alert(1)>');
  });

  it('sends emails without links when the site has no public URL', async () => {
    const s = await school({ publicUrl: undefined });
    await announce(s);
    await lms.email.processOutbox();
    const [message] = transport.sent;
    expect(message!.html).not.toMatch(/href=/);
    expect(message!.text).not.toMatch(/https?:\/\//);
    expect(message!.text).toContain('Sign in to Coursekit to see the details.');
    expect(message!.headers['List-Unsubscribe']).toBeUndefined();
    const status = await s.admin.get('/api/admin/email');
    expect(status.body.publicUrl).toBeNull();
  });

  it('queues nothing while email is off', async () => {
    lms = await createTestLms();
    const s = await setupSchool(lms);
    await s.sam.post(`/api/courses/${s.course.id}/enrol`);
    await announce(s as Awaited<ReturnType<typeof school>>);
    expect(await outbox(lms)).toHaveLength(0);
    expect(lms.email.enabled).toBe(false);
    expect(await lms.email.sendDigests({ force: true })).toEqual({ daily: 0, weekly: 0, skipped: 0 });
    expect((await s.sam.get('/api/email/preferences')).body.deliveryEnabled).toBe(false);
  });

  it('puts notification types into categories', () => {
    expect(emailCategoryOf('announcement')).toBe('announcements');
    expect(emailCategoryOf('forum')).toBe('discussions');
    expect(emailCategoryOf('grade')).toBe('grades');
    expect(emailCategoryOf('enrolment')).toBe('courses');
    expect(emailCategoryOf('badge.awarded')).toBe('achievements');
    expect(emailCategoryOf('certificate_issued')).toBe('achievements');
    expect(emailCategoryOf('constructor')).toBe('courses');
    expect(emailCategoryOf('something-new')).toBe('courses');
  });
});

describe('email preferences API', () => {
  it('requires a session and validates input', async () => {
    const s = await school();
    expect((await client(lms).get('/api/email/preferences')).status).toBe(401);
    expect((await client(lms).put('/api/email/preferences', { frequency: 'off' })).status).toBe(401);
    expect((await s.sam.put('/api/email/preferences', { frequency: 'hourly' })).status).toBe(400);
    expect((await s.sam.put('/api/email/preferences', { disabledCategories: ['spam'] })).status).toBe(400);

    const saved = await s.sam.put('/api/email/preferences', {
      frequency: 'daily',
      disabledCategories: ['grades', 'grades', 'discussions'],
    });
    expect(saved.body).toMatchObject({ frequency: 'daily', isDefault: false, disabledCategories: ['discussions', 'grades'] });
    expect(saved.body.address).toBe('sam@test.dev');
    expect(new Date(saved.body.nextDigests.daily).getTime()).toBeGreaterThan(Date.now());
    // Only categories change: the frequency stays.
    expect((await s.sam.put('/api/email/preferences', { disabledCategories: [] })).body).toMatchObject({
      frequency: 'daily',
      disabledCategories: [],
    });
  });
});

describe('unsubscribe links', () => {
  it('signs tokens and rejects tampered ones', async () => {
    lms = await createEmailLms();
    const secret = await emailSecret(lms.db);
    expect(await emailSecret(lms.db)).toBe(secret);
    const token = signUnsubscribeToken(secret, { userId: 'abc123', category: 'grades' });
    expect(verifyUnsubscribeToken(secret, token)).toEqual({ userId: 'abc123', category: 'grades' });
    expect(verifyUnsubscribeToken(secret, token.replace('grades', 'forums'))).toBeNull();
    expect(verifyUnsubscribeToken(secret, token.replace('abc123', 'abc124'))).toBeNull();
    expect(verifyUnsubscribeToken(`${secret}x`, token)).toBeNull();
    expect(verifyUnsubscribeToken(secret, 'nonsense')).toBeNull();
    const all = signUnsubscribeToken(secret, { userId: 'abc123', category: null });
    expect(verifyUnsubscribeToken(secret, all)).toEqual({ userId: 'abc123', category: null });
  });

  it('shows and applies an unsubscribe without signing in', async () => {
    const s = await school();
    await announce(s);
    await lms.email.processOutbox();
    const token = tokenFrom(transport.sent.find((m) => m.to === 'sam@test.dev')!);
    const anon = client(lms);

    const info = await anon.get(`/api/email/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      siteName: 'Coursekit',
      maskedEmail: 's•••@test.dev',
      category: { id: 'announcements', label: 'Announcements' },
      unsubscribed: false,
      categoryDisabled: false,
    });

    const onlyCategory = await anon.post('/api/email/unsubscribe', { token, scope: 'category' });
    expect(onlyCategory.body).toMatchObject({ unsubscribed: false, categoryDisabled: true });
    expect((await s.sam.get('/api/email/preferences')).body).toMatchObject({
      frequency: 'immediately',
      disabledCategories: ['announcements'],
    });

    const all = await anon.post('/api/email/unsubscribe', { token });
    expect(all.body).toMatchObject({ unsubscribed: true });
    expect((await s.sam.get('/api/email/preferences')).body.frequency).toBe('off');

    expect((await anon.get('/api/email/unsubscribe?token=bad.token')).status).toBe(400);
    expect((await anon.post('/api/email/unsubscribe', { token: `${token.slice(0, -2)}xx` })).body.error.code).toBe('invalid_token');
  });

  it('supports RFC 8058 one-click unsubscribe from mail providers', async () => {
    const s = await school();
    await announce(s);
    await lms.email.processOutbox();
    const url = transport.sent.find((m) => m.to === 'sam@test.dev')!.headers['List-Unsubscribe']!.slice(1, -1);
    // Mail providers POST a form body with no Origin header or cookies.
    const res = await lms.app.request(url.replace(PUBLIC_URL, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unsubscribed: true });
    expect((await s.sam.get('/api/email/preferences')).body.frequency).toBe('off');

    const forged = await lms.app.request('/unsubscribe?token=abc.all.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', { method: 'POST' });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('invalid_token');

    // Nothing more is emailed to Sam.
    await announce(s, 'Second');
    expect((await outbox(lms)).filter((r) => r.status === 'pending')).toHaveLength(1); // Kim's only
  });
});

describe('admin email page API', () => {
  it('is for administrators only', async () => {
    const s = await school();
    for (const user of [s.teacher, s.sam]) {
      expect((await user.get('/api/admin/email')).status).toBe(403);
      expect((await user.put('/api/admin/email/settings', { digestHour: 7 })).status).toBe(403);
      expect((await user.post('/api/admin/email/test', { to: 'x@test.dev' })).status).toBe(403);
      expect((await user.post('/api/admin/email/retry-failed')).status).toBe(403);
    }
    expect((await client(lms).get('/api/admin/email')).status).toBe(401);
  });

  it('reports the transport, outbox counts and the last error', async () => {
    const s = await school();
    const status = await s.admin.get('/api/admin/email');
    expect(status.body).toMatchObject({
      enabled: true,
      transport: 'custom',
      transportName: 'Memory',
      from: '"Coursekit" <no-reply@learn.example.test>',
      fromIsDefault: true,
      publicUrl: PUBLIC_URL,
      worker: false,
      outbox: { pending: 0, sending: 0, sent: 0, failed: 0 },
      lastError: null,
      settings: { defaultFrequency: 'immediately', digestHour: 8, digestWeekday: 1 },
    });

    transport.failWith = () => Object.assign(new Error('550 Mailbox unavailable'), { responseCode: 550 });
    await announce(s);
    await lms.email.processOutbox();
    const after = await s.admin.get('/api/admin/email');
    expect(after.body.outbox).toMatchObject({ failed: 2 });
    expect(after.body.lastError).toMatchObject({ message: '550 Mailbox unavailable', status: 'failed' });

    transport.failWith = null;
    expect((await s.admin.post('/api/admin/email/retry-failed')).body).toEqual({ requeued: 2 });
    await lms.email.processOutbox();
    expect((await s.admin.get('/api/admin/email')).body.outbox).toMatchObject({ sent: 2, failed: 0 });
  });

  it('validates and saves the digest schedule', async () => {
    const s = await school();
    expect((await s.admin.put('/api/admin/email/settings', { digestHour: 24 })).status).toBe(400);
    expect((await s.admin.put('/api/admin/email/settings', { digestWeekday: 7 })).status).toBe(400);
    expect((await s.admin.put('/api/admin/email/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await s.admin.put('/api/admin/email/settings', { defaultFrequency: 'sometimes' })).status).toBe(400);
    const saved = await s.admin.put('/api/admin/email/settings', { digestHour: 17, digestWeekday: 5, timezone: 'Asia/Tokyo' });
    expect(saved.body.settings).toEqual({ defaultFrequency: 'immediately', digestHour: 17, digestWeekday: 5, timezone: 'Asia/Tokyo' });
    // 17:00 in Tokyo is 08:00 UTC.
    expect(saved.body.nextDigests.daily).toMatch(/T08:00:00\.000Z$/);
  });

  it('sends a test email through the outbox and reports how it went', async () => {
    const s = await school();
    expect((await s.admin.post('/api/admin/email/test', { to: 'not-an-email' })).status).toBe(400);
    const queued = await s.admin.post('/api/admin/email/test', {});
    expect(queued.status).toBe(202);
    const before = await s.admin.get(`/api/admin/email/messages/${queued.body.id}`);
    expect(before.body).toMatchObject({ kind: 'test', to: 'admin@test.dev', status: 'pending' });

    await lms.email.processOutbox();
    const after = await s.admin.get(`/api/admin/email/messages/${queued.body.id}`);
    expect(after.body).toMatchObject({ status: 'sent', attempts: 1 });
    expect(transport.sent[0]!.subject).toBe('Test email from Coursekit');
    expect(transport.sent[0]!.html).toContain('Email is working');
    expect((await s.admin.get('/api/admin/email/messages/nope')).status).toBe(404);

    // A failing test email isn't retried, so the page can show the error straight away.
    transport.failWith = () => new Error('Connection refused');
    const failing = await s.admin.post('/api/admin/email/test', { to: 'someone@else.test' });
    await lms.email.processOutbox();
    expect((await s.admin.get(`/api/admin/email/messages/${failing.body.id}`)).body).toMatchObject({
      status: 'failed',
      lastError: 'Connection refused',
    });
  });

  it('refuses a test email while email is off', async () => {
    lms = await createTestLms();
    const s = await setupSchool(lms);
    const res = await s.admin.post('/api/admin/email/test', {});
    expect(res.status).toBe(409);
    const status = await s.admin.get('/api/admin/email');
    expect(status.body).toMatchObject({ enabled: false, transport: 'none', transportName: 'Off', worker: false });
  });
});
