import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoursekit, type Coursekit } from '../src/server/index.js';

let lms: Coursekit;

beforeEach(async () => {
  // A stand-in for the built web UI: an index page, one hashed asset and a favicon.
  const webDir = mkdtempSync(join(tmpdir(), 'coursekit-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  lms = await createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-data-')),
    webDir,
  });
});
afterEach(async () => {
  await lms.close();
});

const get = (path: string) => lms.fetch(new Request(`http://localhost${path}`));

describe('serving the web UI', () => {
  it('serves the app for app routes', async () => {
    for (const path of ['/', '/courses/modern-web-development', '/admin/users']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it('serves build assets with a long-lived cache', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('returns 404 for missing files instead of the app page', async () => {
    // e.g. a page file from an older build, requested by a tab opened before an upgrade
    for (const path of ['/assets/CourseLayout-old456.js', '/assets/missing.css', '/favicon.ico', '/robots.txt']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type')).not.toContain('text/html');
    }
  });

  it('keeps API 404s as JSON', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('programmatic API', () => {
  it('createUser returns the public user without the password hash', async () => {
    const user = await lms.createUser({ name: 'Lib Admin', email: 'lib@coursekit.test', password: 'library-pass-123', role: 'admin' });
    expect(user).toMatchObject({ name: 'Lib Admin', email: 'lib@coursekit.test', role: 'admin', status: 'active' });
    expect(user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(user)).not.toContain('scrypt');
  });
});
