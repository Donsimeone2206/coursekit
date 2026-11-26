import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { packageSecret, signToken } from '../src/server/packages/tokens.js';
import { settle } from './completion-helpers.js';
import { createTestLms, setupSchool, type Client } from './helpers.js';
import { createPackageActivity, fetchRaw, page, uploadPackage, zip } from './package-helpers.js';

const ACTIVITY = 'https://example.test/xapi/course';
const TINCAN = `<?xml version="1.0"?><tincan xmlns="http://projecttincan.com/tincan.xsd"><activities>
<activity id="${ACTIVITY}" type="http://adlnet.gov/expapi/activities/course"><name>Tin Can course</name><launch lang="en-us">story.html</launch></activity>
</activities></tincan>`;

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let activityId: string;

interface Launch {
  endpoint: string;
  auth: string;
  actor: Record<string, unknown>;
  registration: string;
  activityId: string;
}

async function launchAs(as: Client, body: Record<string, unknown> = {}): Promise<Launch> {
  const res = await as.post(`/api/packages/${activityId}/launch`, body);
  expect(res.status).toBe(200);
  const url = new URL(res.body.url, 'http://localhost');
  return {
    endpoint: url.searchParams.get('endpoint')!,
    auth: url.searchParams.get('auth')!,
    actor: JSON.parse(url.searchParams.get('actor')!),
    registration: url.searchParams.get('registration')!,
    activityId: url.searchParams.get('activity_id')!,
  };
}

function lrs(launch: Launch) {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetchRaw(lms, `/xapi/${path}`, {
      method,
      headers: {
        authorization: launch.auth,
        'x-experience-api-version': '1.0.3',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return {
    get: (path: string, headers?: Record<string, string>) => call('GET', path, undefined, headers),
    post: (path: string, body: unknown, headers?: Record<string, string>) => call('POST', path, body, headers),
    put: (path: string, body: unknown, headers?: Record<string, string>) => call('PUT', path, body, headers),
    delete: (path: string, headers?: Record<string, string>) => call('DELETE', path, undefined, headers),
  };
}

const verb = (name: string) => ({ id: `http://adlnet.gov/expapi/verbs/${name}`, display: { 'en-US': name } });
const statement = (launch: Launch, name: string, extra: Record<string, unknown> = {}) => ({
  actor: launch.actor,
  verb: verb(name),
  object: { objectType: 'Activity', id: ACTIVITY },
  context: { registration: launch.registration },
  ...extra,
});

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
  activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, {}, 20);
  const res = await uploadPackage(
    lms,
    school.teacher,
    school.course.id,
    activityId,
    zip({ 'tincan.xml': TINCAN, 'story.html': page('Story') }),
  );
  expect(res.body).toMatchObject({ kind: 'xapi', title: 'Tin Can course' });
});
afterEach(async () => {
  await lms.close();
});

describe('the xAPI launch', () => {
  it('passes the LRS endpoint, credentials, an account actor and the registration', async () => {
    const launch = await launchAs(school.sam);
    expect(launch.endpoint).toBe('http://localhost/xapi/');
    expect(launch.auth).toMatch(/^Basic /);
    expect(launch.actor).toEqual({
      objectType: 'Agent',
      name: 'Sam Student',
      account: { homePage: 'http://localhost', name: expect.any(String) },
    });
    expect(JSON.stringify(launch.actor)).not.toContain('@');
    expect(launch.registration).toMatch(/^[0-9a-f-]{36}$/);
    expect(launch.activityId).toBe(ACTIVITY);
    // Resuming keeps the registration.
    expect((await launchAs(school.sam)).registration).toBe(launch.registration);
  });
});

describe('the LRS', () => {
  it('answers About and CORS preflights, and wants the version header', async () => {
    const about = await fetchRaw(lms, '/xapi/about');
    expect(await about.json()).toEqual({ version: ['1.0.3', '2.0.0'] });
    const preflight = await fetchRaw(lms, '/xapi/statements', {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const launch = await launchAs(school.sam);
    const noVersion = await fetchRaw(lms, '/xapi/statements', { headers: { authorization: launch.auth } });
    expect(noVersion.status).toBe(400);
    const v2 = await fetchRaw(lms, '/xapi/statements', { headers: { authorization: launch.auth, 'x-experience-api-version': '2.0.0' } });
    expect(v2.status).toBe(200);
    expect(v2.headers.get('x-experience-api-version')).toBe('2.0.0');
    expect((await fetchRaw(lms, '/xapi/statements', { headers: { 'x-experience-api-version': '1.0.3' } })).status).toBe(401);
  });

  it('stores statements, turns completion into a grade and answers queries', async () => {
    const launch = await launchAs(school.sam);
    const api = lrs(launch);
    const launched = await api.post('statements', statement(launch, 'launched'));
    expect(launched.status).toBe(200);
    expect(launched.body).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    const id = randomUUID();
    const done = statement(launch, 'completed', {
      id,
      result: { score: { scaled: 0.8 }, success: true, completion: true, duration: 'PT5M' },
    });
    expect((await api.put(`statements?statementId=${id}`, done)).status).toBe(204);
    expect((await api.put(`statements?statementId=${id}`, done)).status).toBe(204);
    expect((await api.put(`statements?statementId=${id}`, { ...done, verb: verb('failed') })).status).toBe(409);
    await settle(lms);

    const attempt = await lms.db.selectFrom('packageAttempts').selectAll().executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ status: 'finished', completionStatus: 'completed', successStatus: 'passed', score: 0.8 });
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(16);
    expect(await lms.db.selectFrom('completions').selectAll().where('activityId', '=', activityId).execute()).toHaveLength(1);

    const one = await api.get(`statements?statementId=${id}`);
    expect(one.body).toMatchObject({ id, stored: expect.any(String), authority: { objectType: 'Agent' }, version: '1.0.0' });
    const byVerb = await api.get(`statements?verb=${encodeURIComponent(verb('launched').id)}`);
    expect(byVerb.body.statements).toHaveLength(1);
    const page1 = await api.get('statements?limit=1');
    expect(page1.body.statements).toHaveLength(1);
    expect(page1.body.more).toMatch(/^\/xapi\/statements\?/);
    expect(page1.headers.get('x-experience-api-consistent-through')).toBeTruthy();
    const page2 = await api.get(page1.body.more.slice('/xapi/'.length));
    expect(page2.body.statements).toHaveLength(1);
    expect(page2.body.statements[0].id).not.toBe(page1.body.statements[0].id);
    expect(page2.body.more).toBe('');
    const ascending = await api.get(
      `statements?ascending=true&registration=${launch.registration}&agent=${encodeURIComponent(JSON.stringify(launch.actor))}`,
    );
    expect(ascending.body.statements.map((s: { verb: { id: string } }) => s.verb.id.split('/').pop())).toEqual(['launched', 'completed']);
    expect((await api.get(`statements?activity=${encodeURIComponent(ACTIVITY)}&since=2000-01-01T00:00:00Z`)).body.statements).toHaveLength(
      2,
    );

    // Voiding hides the statement from queries; it stays available as voided.
    const voiding = await api.post('statements', statement(launch, 'voided', { object: { objectType: 'StatementRef', id } }));
    expect(voiding.status).toBe(200);
    expect((await api.get(`statements?statementId=${id}`)).status).toBe(404);
    expect((await api.get(`statements?voidedStatementId=${id}`)).body.id).toBe(id);
    expect((await api.get('statements')).body.statements.map((s: { verb: { id: string } }) => s.verb.id.split('/').pop())).toEqual([
      'voided',
      'launched',
    ]);
    expect(
      (await api.post('statements', statement(launch, 'voided', { object: { objectType: 'StatementRef', id: voiding.body[0] } }))).status,
    ).toBe(400);
  });

  it('only accepts statements about the launched learner and registration', async () => {
    const launch = await launchAs(school.sam);
    const api = lrs(launch);
    const other = { objectType: 'Agent', account: { homePage: 'http://localhost', name: 'someone-else' } };
    expect((await api.post('statements', statement(launch, 'completed', { actor: other }))).status).toBe(403);
    expect((await api.post('statements', statement(launch, 'completed', { actor: { mbox: 'mailto:sam@test.dev' } }))).status).toBe(403);
    expect((await api.post('statements', statement(launch, 'completed', { context: { registration: randomUUID() } }))).status).toBe(403);
    expect((await api.post('statements', statement(launch, 'completed', { context: {} }))).status).toBe(403);
    expect((await api.post('statements', { ...statement(launch, 'completed'), result: { score: { scaled: 2 } } })).status).toBe(400);
    expect((await api.post('statements', { ...statement(launch, 'completed'), extra: 1 })).status).toBe(400);
    expect((await api.post('statements', 'not json')).status).toBe(400);
    expect(
      (
        await api.post(
          'statements',
          Array.from({ length: 201 }, () => statement(launch, 'experienced')),
        )
      ).status,
    ).toBe(413);
    expect(
      (await api.post('statements', [statement(launch, 'experienced', { result: { response: 'x'.repeat(1024 * 1024) } })])).status,
    ).toBe(413);
    expect(await lms.db.selectFrom('xapiStatements').selectAll().execute()).toEqual([]);

    // Kim's credentials don't see Sam's statements; tampered credentials are refused.
    await api.post('statements', statement(launch, 'experienced'));
    const kim = await launchAs(school.kim);
    expect((await lrs(kim).get('statements')).body.statements).toEqual([]);
    expect((await lrs(kim).get(`statements?agent=${encodeURIComponent(JSON.stringify(launch.actor))}`)).body.statements).toEqual([]);
    const forged = {
      ...kim,
      auth: `Basic ${Buffer.from(`coursekit:${Buffer.from(kim.auth.slice(6), 'base64').toString().split(':')[1]!.replace(/.$/, 'x')}`).toString('base64')}`,
    };
    expect((await lrs(forged).get('statements')).status).toBe(401);
  });

  it('keeps activity state with ETags and concurrency checks', async () => {
    const launch = await launchAs(school.sam);
    const api = lrs(launch);
    const agent = encodeURIComponent(JSON.stringify(launch.actor));
    const base = `activities/state?activityId=${encodeURIComponent(ACTIVITY)}&agent=${agent}&registration=${launch.registration}`;
    expect((await api.put(`${base}&stateId=bookmark`, { page: 1 }, { 'if-none-match': '*' })).status).toBe(204);
    expect((await api.put(`${base}&stateId=bookmark`, { page: 2 }, { 'if-none-match': '*' })).status).toBe(412);
    const got = await api.get(`${base}&stateId=bookmark`);
    expect(got.body).toEqual({ page: 1 });
    const etag = got.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect((await api.put(`${base}&stateId=bookmark`, { page: 3 }, { 'if-match': '"nope"' })).status).toBe(412);
    expect((await api.put(`${base}&stateId=bookmark`, { page: 3 }, { 'if-match': etag })).status).toBe(204);
    expect((await api.post(`${base}&stateId=bookmark`, { seen: ['intro'] })).status).toBe(204);
    expect((await api.get(`${base}&stateId=bookmark`)).body).toEqual({ page: 3, seen: ['intro'] });
    await api.put(`${base}&stateId=notes`, 'plain text', { 'content-type': 'text/plain' });
    expect((await api.post(`${base}&stateId=notes`, { a: 1 })).status).toBe(400);
    expect((await api.get(base)).body).toEqual(['bookmark', 'notes']);
    expect((await api.delete(`${base}&stateId=notes`)).status).toBe(204);
    expect((await api.get(base)).body).toEqual(['bookmark']);
    expect((await api.delete(base)).status).toBe(204);
    expect((await api.get(`${base}&stateId=bookmark`)).status).toBe(404);
    // Another learner's agent is refused.
    const other = encodeURIComponent(JSON.stringify({ objectType: 'Agent', account: { homePage: 'http://localhost', name: 'x' } }));
    expect((await api.get(`activities/state?activityId=${encodeURIComponent(ACTIVITY)}&agent=${other}`)).status).toBe(403);

    // Activity and agent profiles.
    const profile = `activities/profile?activityId=${encodeURIComponent(ACTIVITY)}&profileId=p1`;
    expect((await api.put(profile, { shared: true })).status).toBe(204);
    expect((await api.put(profile, { shared: false })).status).toBe(409);
    expect((await api.get(profile)).body).toEqual({ shared: true });
    const agentProfile = `agents/profile?agent=${agent}&profileId=prefs`;
    expect((await api.put(agentProfile, { theme: 'dark' })).status).toBe(204);
    expect((await api.get(agentProfile)).body).toEqual({ theme: 'dark' });
    expect((await api.get(`agents?agent=${agent}`)).body).toMatchObject({ objectType: 'Person', name: ['Sam Student'] });
  });

  it('refuses credentials once the activity is hidden', async () => {
    const launch = await launchAs(school.sam);
    expect((await lrs(launch).post('statements', statement(launch, 'launched'))).status).toBe(200);
    await school.teacher.patch(`/api/activities/${activityId}`, { visible: false });
    expect((await lrs(launch).post('statements', statement(launch, 'completed'))).status).toBe(403);
  });

  it('accepts but records nothing for staff previews', async () => {
    const launch = await launchAs(school.teacher);
    const api = lrs(launch);
    const res = await api.post('statements', statement(launch, 'completed', { result: { completion: true } }));
    expect(res.status).toBe(200);
    expect(await lms.db.selectFrom('xapiStatements').selectAll().execute()).toEqual([]);
    const base = `activities/state?activityId=${encodeURIComponent(ACTIVITY)}&agent=${encodeURIComponent(JSON.stringify(launch.actor))}&stateId=s`;
    expect((await api.put(base, { a: 1 })).status).toBe(204);
    expect((await api.get(base)).status).toBe(404);
  });
});

describe('fixes from review', () => {
  it('keeps activity profiles per learner', async () => {
    const sam = lrs(await launchAs(school.sam));
    const kim = lrs(await launchAs(school.kim));
    const profile = `activities/profile?activityId=${encodeURIComponent(ACTIVITY)}&profileId=config`;
    expect((await sam.put(profile, { answerKey: 'from-sam' })).status).toBe(204);
    expect((await kim.get(profile)).status).toBe(404);
    expect((await kim.put(profile, { answerKey: 'from-kim' })).status).toBe(204);
    expect((await kim.delete(profile)).status).toBe(204);
    expect((await sam.get(profile)).body).toEqual({ answerKey: 'from-sam' });
  });

  it('limits the bytes of documents a learner stores', async () => {
    const launch = await launchAs(school.sam);
    const api = lrs(launch);
    const base = `activities/state?activityId=${encodeURIComponent(ACTIVITY)}&agent=${encodeURIComponent(JSON.stringify(launch.actor))}`;
    const big = 'x'.repeat(1_000_000);
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) {
      statuses.push((await api.put(`${base}&stateId=s${i}`, big, { 'content-type': 'text/plain' })).status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 204)).toBe(true);
    expect(statuses[16]).toBe(413);
    // Replacing a stored document counts only the difference.
    expect((await api.put(`${base}&stateId=s0`, 'small', { 'content-type': 'text/plain' })).status).toBe(204);
  });

  it("counts session time once, not the root activity's duration as well", async () => {
    const launch = await launchAs(school.sam);
    const api = lrs(launch);
    expect(
      (await api.post('statements', statement(launch, 'completed', { result: { completion: true, duration: 'PT2M50S' } }))).status,
    ).toBe(200);
    expect((await api.post('statements', statement(launch, 'terminated', { result: { duration: 'PT3M5S' } }))).status).toBe(200);
    const attempt = await lms.db.selectFrom('packageAttempts').select('totalSeconds').executeTakeFirstOrThrow();
    expect(attempt.totalSeconds).toBe(185);
  });

  it('accepts recording credentials for a while after they expire', async () => {
    const launch = await launchAs(school.sam);
    const decoded = Buffer.from(launch.auth.replace(/^Basic /, ''), 'base64').toString('utf8');
    const raw = decoded.slice(decoded.indexOf(':') + 1);
    const { x: _x, ...payload } = JSON.parse(Buffer.from(raw.split('.')[0]!, 'base64url').toString());
    const secret = await packageSecret(lms.db);
    const authFor = (hours: number) => `Basic ${Buffer.from(`coursekit:${signToken(secret, payload, hours)}`).toString('base64')}`;
    expect((await lrs({ ...launch, auth: authFor(-1) }).post('statements', statement(launch, 'launched'))).status).toBe(200);
    expect((await lrs({ ...launch, auth: authFor(-24 * 8) }).post('statements', statement(launch, 'launched'))).status).toBe(401);
    expect(await lms.db.selectFrom('xapiStatements').selectAll().execute()).toHaveLength(1);
  });
});
