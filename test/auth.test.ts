import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { client, createTestLms, login, PASSWORD } from './helpers.js';

let lms: Coursekit;
beforeEach(async () => {
  lms = await createTestLms();
});
afterEach(async () => {
  await lms.close();
});

describe('first-run setup', () => {
  it('reports that setup is needed and creates the first administrator', async () => {
    const anon = client(lms);
    expect((await anon.get('/api/auth/session')).body.needsSetup).toBe(true);

    const res = await anon.post('/api/auth/setup', { siteName: 'Test Academy', name: 'Ada', email: 'ADA@Test.dev', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ada@test.dev', role: 'admin' });
    expect(res.body.site.name).toBe('Test Academy');

    const again = await anon.post('/api/auth/setup', { siteName: 'X', name: 'Eve', email: 'eve@test.dev', password: PASSWORD });
    expect(again.status).toBe(403);
  });
});

describe('sign in', () => {
  beforeEach(async () => {
    await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: PASSWORD });
  });

  it('signs in with the right password and returns the session', async () => {
    const sam = await login(lms, 'sam@test.dev');
    const session = await sam.get('/api/auth/session');
    expect(session.body.user.name).toBe('Sam');
    expect(session.body.needsSetup).toBe(false);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const anon = client(lms);
    const wrong = await anon.post('/api/auth/login', { email: 'sam@test.dev', password: 'nope-nope' });
    const missing = await anon.post('/api/auth/login', { email: 'ghost@test.dev', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.error.message).toBe(missing.body.error.message);
  });

  it('signs out and invalidates the session', async () => {
    const sam = await login(lms, 'sam@test.dev');
    await sam.post('/api/auth/logout');
    expect((await sam.get('/api/dashboard')).status).toBe(401);
  });

  it('blocks suspended accounts', async () => {
    await lms.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
    const admin = await login(lms, 'admin@test.dev');
    const sam = await login(lms, 'sam@test.dev');
    const users = await admin.get('/api/admin/users?q=sam');
    await admin.patch(`/api/admin/users/${users.body.items[0].id}`, { status: 'suspended' });
    expect((await sam.get('/api/dashboard')).status).toBe(401);
    const res = await client(lms).post('/api/auth/login', { email: 'sam@test.dev', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('registration', () => {
  it('can be turned off by an administrator', async () => {
    await lms.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
    const anon = client(lms);
    expect((await anon.post('/api/auth/register', { name: 'New', email: 'new@test.dev', password: PASSWORD })).status).toBe(201);

    const admin = await login(lms, 'admin@test.dev');
    await admin.put('/api/admin/settings', { allowSignup: false });
    expect((await anon.post('/api/auth/register', { name: 'Late', email: 'late@test.dev', password: PASSWORD })).status).toBe(403);
  });

  it('validates input', async () => {
    const res = await client(lms).post('/api/auth/register', { name: '', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('administration', () => {
  it('lets admins log in as other users and switch back', async () => {
    await lms.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
    const sam = await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: PASSWORD });
    const admin = await login(lms, 'admin@test.dev');

    const res = await lms.app.request(`/api/admin/users/${sam.id}/impersonate`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const asSam = client(lms, res.headers.get('set-cookie')!.split(';')[0]!);
    const session = await asSam.get('/api/auth/session');
    expect(session.body.user.name).toBe('Sam');
    expect(session.body.impersonator.name).toBe('Admin');

    const back = await asSam.post('/api/auth/stop-impersonating');
    expect(back.body.user.name).toBe('Admin');
  });

  it('keeps non-admins out of the admin API', async () => {
    await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: PASSWORD });
    const sam = await login(lms, 'sam@test.dev');
    expect((await sam.get('/api/admin/overview')).status).toBe(403);
  });
});
