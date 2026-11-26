import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { AuSim, VERB, createCmi5Activity, launchAu } from './cmi5-helpers.js';
import { createTestLms, setupSchool } from './helpers.js';

// Coursekit mounted in another Hono app, as the README shows: `host.route('/', lms.app)`. The host matches
// routes with its own path, so what lms.app's own options do (like collapsing "//" under /xapi/) has to
// hold there too.

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let host: Hono;
/** Requests through the host app instead of lms.fetch. */
let viaHost: Coursekit;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  host = new Hono();
  host.route('/', lms.app);
  viaHost = { fetch: (request: Request) => host.fetch(request) } as unknown as Coursekit;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await lms.close();
});

it('answers AUs that join the LRS endpoint and the path with "/" through the host', async () => {
  const { activityId } = await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId);
  const { launch } = await launchAu(lms, school.sam, activityId, {}, false);
  const au = new AuSim(viaHost, launch.url);
  expect(au.endpoint).toBe('http://localhost/xapi/');
  expect((await au.fetchToken()).status).toBe(200);

  // ${endpoint}/activities/state: /xapi//activities/state.
  const launchData = await au.call('GET', `/${au.stateUrl('LMS.LaunchData')}`);
  expect(launchData.status).toBe(200);
  au.launchData = launchData.body;
  const prefs = `/agents/profile?profileId=cmi5LearnerPreferences&agent=${encodeURIComponent(JSON.stringify(au.actor))}`;
  expect((await au.call('GET', prefs)).status).toBe(200);
  expect((await au.call('POST', '/statements', au.statement(VERB.initialized))).status).toBe(200);
  expect((await au.call('GET', '/statements')).body.statements.map((s: { verb: { id: string } }) => s.verb.id)).toEqual([
    VERB.initialized,
    VERB.launched,
  ]);

  // /about needs no version header, and the LRS stays readable from the content's opaque origin.
  const about = await host.fetch(new Request('http://localhost/xapi//about'));
  expect(about.status).toBe(200);
  expect(about.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  expect(about.headers.get('access-control-allow-origin')).toBe('*');
  const missing = await au.call('GET', '/nothing');
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({ error: { message: 'Not found.' } });

  // An unexpected error still gets Coursekit's JSON body.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(lms.db, 'selectFrom').mockImplementation(() => {
    throw new Error('database down');
  });
  const failed = await au.call('GET', '/statements');
  expect(failed.status).toBe(500);
  expect(failed.body).toMatchObject({ error: { code: 'internal_error' } });
});

it('leaves the rest of Coursekit as it is through the host', async () => {
  expect(await (await host.fetch(new Request('http://localhost/api/health'))).json()).toMatchObject({ ok: true });
  // Repeated slashes collapse only under /xapi/.
  expect((await host.fetch(new Request('http://localhost/api//health'))).status).toBe(404);
});
