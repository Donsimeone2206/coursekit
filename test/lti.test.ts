import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import type { Coursekit } from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';
import { del } from './completion-helpers.js';
import { login, setupSchool, type Client } from './helpers.js';
import { AGS, createLtiLms, DL, ISS, LTI, MockTool, NRPS_SCOPE, readForm, REDIRECT_URI, TOOL_ORIGIN, unique } from './lti-helpers.js';

const ROLES = {
  learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  ta: 'http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant',
};
const ALL_AGS = [`${AGS}lineitem`, `${AGS}lineitem.readonly`, `${AGS}result.readonly`, `${AGS}score`];
const MEDIA = {
  container: 'application/vnd.ims.lis.v2.lineitemcontainer+json',
  lineItem: 'application/vnd.ims.lis.v2.lineitem+json',
  score: 'application/vnd.ims.lis.v1.score+json',
  results: 'application/vnd.ims.lis.v2.resultcontainer+json',
  members: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
};

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let tool: MockTool;
let courseId: string;
let activityId: string;
let samId: string;
let kimId: string;

async function userId(email: string) {
  return (await lms.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

async function addLtiActivity(as: Client, body: Record<string, unknown> = {}) {
  const res = await as.post(`/api/courses/${courseId}/activities`, {
    sectionId: school.sectionId,
    type: 'lti',
    title: 'Coding lab',
    maxGrade: 50,
    settings: { toolId: tool.toolId, launchUrl: `${TOOL_ORIGIN}/labs/1`, custom: { lab: '1' }, presentation: 'embed' },
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const score = (user: string, given: number | null, extra: Record<string, unknown> = {}) => ({
  userId: user,
  ...(given == null ? {} : { scoreGiven: given, scoreMaximum: 10 }),
  activityProgress: 'Completed',
  gradingProgress: 'FullyGraded',
  timestamp: new Date().toISOString(),
  ...extra,
});

beforeEach(async () => {
  lms = await createLtiLms();
  school = await setupSchool(lms);
  courseId = school.course.id;
  await school.sam.post(`/api/courses/${courseId}/enrol`);
  await school.kim.post(`/api/courses/${courseId}/enrol`);
  samId = await userId('sam@test.dev');
  kimId = await userId('kim@test.dev');
  tool = await MockTool.create(lms);
  await tool.register(school.admin);
  activityId = await addLtiActivity(school.teacher);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await lms.close();
});

describe('tool registry', () => {
  it('is for administrators only and shows the platform details', async () => {
    expect((await school.teacher.get('/api/admin/lti/tools')).status).toBe(403);
    const list = await school.admin.get('/api/admin/lti/tools');
    expect(list.status).toBe(200);
    expect(list.body.platform).toEqual({
      configured: true,
      issuer: ISS,
      authUrl: `${ISS}/lti/auth`,
      tokenUrl: `${ISS}/lti/token`,
      jwksUrl: `${ISS}/lti/jwks`,
      deepLinkReturnUrl: `${ISS}/lti/deep-link/return`,
    });
    expect(list.body.tools).toHaveLength(1);
    expect(list.body.tools[0]).toMatchObject({ name: 'Mock lab', clientId: tool.clientId, activityCount: 1, status: 'active' });
  });

  it('refuses private keys, bad URLs and a missing JWKS URL', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const base = { name: 'X', toolUrl: 'https://x.test', loginUrl: 'https://x.test/login', redirectUris: ['https://x.test/cb'] };
    expect(
      (await school.admin.post('/api/admin/lti/tools', { ...base, keyType: 'key', publicKey: JSON.stringify(privateJwk) })).status,
    ).toBe(400);
    expect((await school.admin.post('/api/admin/lti/tools', { ...base, keyType: 'key', publicKey: 'not a key' })).status).toBe(400);
    expect((await school.admin.post('/api/admin/lti/tools', { ...base, keyType: 'jwks' })).status).toBe(400);
    expect(
      (
        await school.admin.post('/api/admin/lti/tools', {
          ...base,
          loginUrl: 'javascript:alert(1)',
          keyType: 'jwks',
          jwksUrl: 'https://x.test/k',
        })
      ).status,
    ).toBe(400);
  });

  it('explains how to set the public URL when it is missing, and launches fail clearly', async () => {
    const bare = await createLtiLms(null);
    try {
      const s = await setupSchool(bare);
      const list = await s.admin.get('/api/admin/lti/tools');
      expect(list.body.platform.configured).toBe(false);
      expect(list.body.platform.issuer).toBeNull();
      const page = await bare.app.request('/lti/auth?client_id=x');
      expect(await page.text()).toContain('COURSEKIT_PUBLIC_URL');
    } finally {
      await bare.close();
    }
  });

  it('validates the activity: a tool is needed and the launch URL must be on its domain', async () => {
    const post = (settings: Record<string, unknown>) =>
      school.teacher.post(`/api/courses/${courseId}/activities`, { sectionId: school.sectionId, type: 'lti', title: 'T', settings });
    expect((await post({})).status).toBe(400);
    expect((await post({ toolId: 'nope' })).status).toBe(400);
    expect((await post({ toolId: tool.toolId, launchUrl: 'https://evil.test/x' })).status).toBe(400);
    const ok = await post({ toolId: tool.toolId, launchUrl: 'https://labs.tool.test/x' });
    expect(ok.status).toBe(201);
    const ungraded = await school.teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'lti',
      title: 'Ungraded',
      maxGrade: null,
      settings: { toolId: tool.toolId },
    });
    expect((await school.teacher.get(`/api/activities/${ungraded.body.id}`)).body.maxGrade).toBeNull();
    // Teachers can make it graded later, and ungraded again.
    expect((await school.teacher.patch(`/api/activities/${ungraded.body.id}`, { maxGrade: 20 })).status).toBe(200);
    expect((await school.teacher.patch(`/api/activities/${ungraded.body.id}`, { maxGrade: null })).status).toBe(200);
    expect((await school.teacher.get(`/api/activities/${ungraded.body.id}`)).body.maxGrade).toBeNull();
    // Other graded types still need a maximum.
    const essay = await school.teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'E',
    });
    expect((await school.teacher.patch(`/api/activities/${essay.body.id}`, { maxGrade: null })).status).toBe(400);
  });

  it('explains invalid custom parameter names', async () => {
    const message = 'Custom parameter names use letters, digits and underscores';
    const created = await school.teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'lti',
      title: 'T',
      settings: { toolId: tool.toolId, custom: { 'chapter-id': '3' } },
    });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toBe(`custom.chapter-id: ${message}`);
    const patched = await school.admin.patch(`/api/admin/lti/tools/${tool.toolId}`, { customParams: { 'my-param': 'x' } });
    expect(patched.status).toBe(400);
    expect(patched.body.error.message).toContain(message);
  });

  it('lists tools for teachers without keys or secrets', async () => {
    const res = await school.teacher.get(`/api/courses/${courseId}/lti/tools`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: tool.toolId,
        name: 'Mock lab',
        description: 'A tool used in tests',
        toolUrl: `${TOOL_ORIGIN}/launch`,
        deepLinking: true,
        grades: true,
        status: 'active',
      },
    ]);
    expect((await school.sam.get(`/api/courses/${courseId}/lti/tools`)).status).toBe(403);
  });
});

describe('launch', () => {
  it('sends a signed resource link launch with the right claims', async () => {
    const login = await tool.open(`/lti/launch/${activityId}?target=iframe`, school.sam.cookie);
    expect(login.form!.action).toBe(`${TOOL_ORIGIN}/login`);
    expect(login.form!.fields).toMatchObject({
      iss: ISS,
      login_hint: samId,
      target_link_uri: `${TOOL_ORIGIN}/labs/1`,
      client_id: tool.clientId,
      lti_deployment_id: tool.deploymentId,
    });
    const auth = await tool.authorize(login.form!.fields);
    expect(auth.form!.action).toBe(REDIRECT_URI);
    expect(auth.form!.fields.state).toBe('state-123');
    const claims = await tool.verifyIdToken(auth.form!.fields.id_token!, auth.nonce);
    expect(claims.sub).toBe(samId);
    expect(claims.exp! - claims.iat!).toBe(300);
    expect(claims[`${LTI}message_type`]).toBe('LtiResourceLinkRequest');
    expect(claims[`${LTI}version`]).toBe('1.3.0');
    expect(claims[`${LTI}deployment_id`]).toBe(tool.deploymentId);
    expect(claims[`${LTI}target_link_uri`]).toBe(`${TOOL_ORIGIN}/labs/1`);
    expect(claims[`${LTI}resource_link`]).toMatchObject({ id: activityId, title: 'Coding lab' });
    expect(claims[`${LTI}roles`]).toEqual([ROLES.learner]);
    expect(claims[`${LTI}context`]).toMatchObject({ id: courseId, title: 'Testing 101' });
    expect(claims[`${LTI}custom`]).toEqual({ color: 'blue', lab: '1' });
    expect(claims[`${LTI}launch_presentation`]).toMatchObject({ document_target: 'iframe' });
    expect(claims[`${LTI}tool_platform`]).toMatchObject({ product_family_code: 'coursekit' });
    expect(claims.name).toBe('Sam Student');
    expect(claims.email).toBeUndefined();
    expect(claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint']).toEqual({
      scope: ALL_AGS,
      lineitems: `${ISS}/lti/ags/${courseId}/lineitems`,
      lineitem: `${ISS}/lti/ags/${courseId}/lineitems/${activityId}`,
    });
    expect(claims['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice']).toEqual({
      context_memberships_url: `${ISS}/lti/nrps/${courseId}/memberships`,
      service_versions: ['2.0'],
    });
  });

  it('gives teachers, assistants and administrators their roles', async () => {
    expect((await tool.launch(`/lti/launch/${activityId}`, school.teacher.cookie))[`${LTI}roles`]).toEqual([ROLES.instructor]);
    await lms.createUser({ name: 'Tess Assistant', email: 'ta@test.dev', password: 'test-password' });
    const taId = await userId('ta@test.dev');
    await lms.db
      .insertInto('enrolments')
      .values({
        id: newId(),
        courseId,
        userId: taId,
        role: 'assistant',
        status: 'active',
        lastAccessAt: null,
        createdAt: new Date().toISOString(),
      })
      .execute();
    const ta = await login(lms, 'ta@test.dev');
    expect((await tool.launch(`/lti/launch/${activityId}`, ta.cookie))[`${LTI}roles`]).toEqual([ROLES.instructor, ROLES.ta]);
    const adminRoles = (await tool.launch(`/lti/launch/${activityId}`, school.admin.cookie))[`${LTI}roles`] as string[];
    expect(adminRoles).toContain(ROLES.instructor);
    expect(adminRoles).toContain('http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator');
    expect(adminRoles).toContain('http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator');
  });

  it('completes an ungraded activity on launch and shares email only when allowed', async () => {
    const ungraded = await addLtiActivity(school.teacher, { title: 'Reading', maxGrade: null, completion: 'auto' });
    await tool.launch(`/lti/launch/${ungraded}`, school.sam.cookie);
    expect((await school.sam.get(`/api/activities/${ungraded}`)).body.completed).toBe(true);
    await school.admin.patch(`/api/admin/lti/tools/${tool.toolId}`, { shareEmail: true, shareName: false, allowAgs: false });
    const claims = await tool.launch(`/lti/launch/${ungraded}`, school.sam.cookie);
    expect(claims.email).toBe('sam@test.dev');
    expect(claims.name).toBeUndefined();
    expect(claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint']).toBeUndefined();
  });

  it('works over GET too and escapes values placed in the page', async () => {
    const login = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    const res = await lms.app.request(
      `/lti/auth?${new URLSearchParams({
        scope: 'openid',
        response_type: 'id_token',
        client_id: tool.clientId,
        redirect_uri: REDIRECT_URI,
        login_hint: samId,
        state: '"><script>alert(1)</script>',
        response_mode: 'form_post',
        nonce: 'n-1',
        prompt: 'none',
        lti_message_hint: login.form!.fields.lti_message_hint!,
      })}`,
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(readForm(html).fields.state).toBe('"><script>alert(1)</script>');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses an unregistered redirect_uri, a wrong client_id and bad request parameters', async () => {
    const login = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    const fields = login.form!.fields;
    const bad = async (overrides: Record<string, string>) => {
      const res = await tool.authorize(fields, overrides);
      expect(res.form).toBeNull();
      return res.status;
    };
    expect(await bad({ redirect_uri: 'https://evil.test/callback' })).toBe(400);
    expect(await bad({ redirect_uri: `${REDIRECT_URI}/extra` })).toBe(400);
    expect(await bad({ client_id: 'not-a-client' })).toBe(400);
    expect(await bad({ response_type: 'code' })).toBe(400);
    expect(await bad({ scope: 'profile' })).toBe(400);
    expect(await bad({ response_mode: 'query' })).toBe(400);
    expect(await bad({ prompt: 'login' })).toBe(400);
    expect(await bad({ nonce: '' })).toBe(400);
    expect(await bad({ login_hint: kimId })).toBe(400);
    // None of that used up the hint.
    expect((await tool.authorize(fields)).form?.fields.id_token).toBeTruthy();
  });

  it('refuses expired, reused and tampered hints', async () => {
    const first = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    expect((await tool.authorize(first.form!.fields)).status).toBe(200);
    const reused = await tool.authorize(first.form!.fields);
    expect(reused.status).toBe(400);
    expect(reused.html).toContain('already used');

    const second = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    const hint = second.form!.fields.lti_message_hint!;
    const tampered = hint.slice(0, -3) + (hint.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await tool.authorize(second.form!.fields, { lti_message_hint: tampered })).status).toBe(400);
    // The payload can't be swapped for another user's either.
    const [h, , s] = hint.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: kimId })).toString('base64url')}.${s}`;
    expect((await tool.authorize(second.form!.fields, { lti_message_hint: forged, login_hint: kimId })).status).toBe(400);

    const third = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    const late = await tool.authorize(third.form!.fields);
    expect(late.status).toBe(400);
    expect(late.html).toContain('expired');
  });

  it('refuses a hint when someone else is signed in', async () => {
    const login = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    const res = await tool.authorize(login.form!.fields, {}, school.kim.cookie);
    expect(res.status).toBe(403);
    expect(res.form).toBeNull();
    // Signed in as the same person is fine.
    expect((await tool.authorize(login.form!.fields, {}, school.sam.cookie)).status).toBe(200);
  });

  it('refuses disabled tools and students who cannot see the activity', async () => {
    const page = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    await school.teacher.patch(`/api/activities/${activityId}`, { visible: false });
    expect((await tool.authorize(page.form!.fields)).status).toBe(404);
    expect((await tool.open(`/lti/launch/${activityId}`, school.sam.cookie)).status).toBe(404);
    expect((await school.sam.get(`/api/lti/activities/${activityId}`)).status).toBe(404);
    await school.teacher.patch(`/api/activities/${activityId}`, { visible: true });

    const before = await tool.open(`/lti/launch/${activityId}`, school.sam.cookie);
    await school.admin.patch(`/api/admin/lti/tools/${tool.toolId}`, { status: 'disabled' });
    expect((await tool.authorize(before.form!.fields)).status).toBe(403);
    expect((await tool.open(`/lti/launch/${activityId}`, school.sam.cookie)).status).toBe(403);
    expect((await school.sam.get(`/api/lti/activities/${activityId}`)).body).toMatchObject({ available: false });

    // Not signed in, or not enrolled.
    expect((await tool.open(`/lti/launch/${activityId}`)).status).toBe(401);
    await lms.createUser({ name: 'Out Sider', email: 'out@test.dev', password: 'test-password' });
    const outsider = await login(lms, 'out@test.dev');
    expect((await tool.open(`/lti/launch/${activityId}`, outsider.cookie)).status).toBe(403);
  });

  it('asks for a click when a launch link comes from another site', async () => {
    const res = await lms.app.request(`/lti/launch/${activityId}`, {
      headers: { cookie: school.sam.cookie, 'sec-fetch-site': 'cross-site' },
    });
    const html = await res.text();
    expect(html).not.toContain('lti_message_hint');
    expect(html).toContain(`href="/lti/launch/${activityId}"`);
  });
});

describe('deep linking', () => {
  async function startDeepLink(query: Record<string, string>) {
    const login = await tool.open(
      `/lti/deep-link/start?${new URLSearchParams({ courseId, toolId: tool.toolId, ...query })}`,
      school.teacher.cookie,
    );
    expect(login.form, login.html.slice(0, 300)).toBeTruthy();
    expect(login.form!.fields.target_link_uri).toBe(`${TOOL_ORIGIN}/deep-link`);
    const auth = await tool.authorize(login.form!.fields);
    const claims = await tool.verifyIdToken(auth.form!.fields.id_token!, auth.nonce);
    expect(claims[`${LTI}message_type`]).toBe('LtiDeepLinkingRequest');
    const settings = claims[`${DL}deep_linking_settings`] as Record<string, any>;
    expect(settings.deep_link_return_url).toBe(`${ISS}/lti/deep-link/return`);
    expect(settings.accept_types).toEqual(['ltiResourceLink']);
    return settings.data as string;
  }

  const item = (extra: Record<string, unknown> = {}) => ({
    type: 'ltiResourceLink',
    title: 'Lab 2: loops',
    text: 'Practise for loops.',
    url: `${TOOL_ORIGIN}/labs/2`,
    custom: { lab: 2 },
    lineItem: { scoreMaximum: 20, resourceId: 'lab-2', tag: 'labs' },
    iframe: { height: 600 },
    ...extra,
  });

  it('creates activities from the selected content and shows the tool message', async () => {
    const data = await startDeepLink({ sectionId: school.sectionId });
    const jwt = await tool.sign(
      tool.deepLinkingResponse(
        data,
        [item(), item({ title: 'Lab 3', url: undefined, lineItem: undefined, iframe: undefined }), { type: 'html', html: '<p>x</p>' }],
        { [`${DL}msg`]: 'Two labs added <b>!</b>' },
      ),
    );
    const res = await tool.postDeepLink(jwt);
    expect(res.status).toBe(200);
    expect(res.html).toContain('Two labs added &lt;b&gt;!&lt;/b&gt;');
    expect(res.html).toContain('Lab 2: loops');
    const course = await school.teacher.get(`/api/courses/${courseId}`);
    const all = course.body.sections.flatMap((s: any) => s.activities);
    const lab2 = all.find((a: any) => a.title === 'Lab 2: loops');
    const lab3 = all.find((a: any) => a.title === 'Lab 3');
    expect(lab2).toMatchObject({ type: 'lti', maxGrade: 20 });
    expect(lab3).toMatchObject({ type: 'lti', maxGrade: null });
    const detail = await school.teacher.get(`/api/activities/${lab2.id}`);
    expect(detail.body.settings).toMatchObject({
      toolId: tool.toolId,
      launchUrl: `${TOOL_ORIGIN}/labs/2`,
      custom: { lab: '2' },
      presentation: 'embed',
      lineItemResourceId: 'lab-2',
      lineItemTag: 'labs',
    });
    expect(detail.body.description).toBe('Practise for loops.');
  });

  it('updates the activity being edited', async () => {
    const data = await startDeepLink({ activityId });
    const res = await tool.postDeepLink(
      await tool.sign(tool.deepLinkingResponse(data, [item({ title: 'Lab 9', window: {}, iframe: undefined })])),
    );
    expect(res.status).toBe(200);
    const detail = await school.teacher.get(`/api/activities/${activityId}`);
    expect(detail.body).toMatchObject({ title: 'Lab 9', maxGrade: 20 });
    expect(detail.body.settings).toMatchObject({ launchUrl: `${TOOL_ORIGIN}/labs/2`, presentation: 'window' });
  });

  it('refuses unsigned, HS256, wrongly addressed, replayed, tampered and expired responses', async () => {
    const data = await startDeepLink({ sectionId: school.sectionId });
    const claims = tool.deepLinkingResponse(data, [item()]);
    const count = async () => (await lms.db.selectFrom('activities').select('id').where('courseId', '=', courseId).execute()).length;
    const before = await count();

    const none = new UnsecuredJWT(claims).setIssuer(tool.clientId).setAudience(ISS).setIssuedAt().setExpirationTime('5m').encode();
    expect((await tool.postDeepLink(none)).status).toBe(400);
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(tool.clientId)
      .setAudience(ISS)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough!'));
    expect((await tool.postDeepLink(hs)).status).toBe(400);
    expect((await tool.postDeepLink(await tool.sign(claims, { aud: 'https://other-lms.test' }))).status).toBe(400);
    const other = await MockTool.create(lms, 'other-key');
    other.clientId = tool.clientId;
    expect((await tool.postDeepLink(await other.sign(claims))).status).toBe(400); // signed with a key that isn't the tool's
    expect((await tool.postDeepLink(await tool.sign({ ...claims, [`${LTI}deployment_id`]: 'other' }))).status).toBe(400);
    expect((await tool.postDeepLink(await tool.sign({ ...claims, nonce: unique('n'), [`${DL}data`]: `${data}x` }))).status).toBe(400);
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await tool.postDeepLink(await tool.sign(claims, { iat: past - 60, exp: past }))).status).toBe(400);
    expect(await count()).toBe(before);

    const good = await tool.sign(claims);
    expect((await tool.postDeepLink(good)).status).toBe(200);
    expect(await count()).toBe(before + 1);
    // The same nonce, or the same data with a new nonce, can't be used again.
    expect((await tool.postDeepLink(good)).html).toContain('already used');
    expect((await tool.postDeepLink(await tool.sign({ ...claims, nonce: unique('n') }))).html).toContain('already used');
    expect(await count()).toBe(before + 1);
  });

  it('only lets course managers start content selection', async () => {
    const res = await tool.open(
      `/lti/deep-link/start?${new URLSearchParams({ courseId, toolId: tool.toolId, sectionId: school.sectionId })}`,
      school.sam.cookie,
    );
    expect(res.status).toBe(403);
    expect(res.form).toBeNull();
  });
});

describe('services', () => {
  it('issues tokens for allowed scopes only and refuses bad client assertions', async () => {
    const res = await tool.requestToken([...ALL_AGS, NRPS_SCOPE, 'https://example.test/other']);
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.scope.split(' ').sort()).toEqual([...ALL_AGS, NRPS_SCOPE].sort());
    const stored = await lms.db.selectFrom('ltiAccessTokens').select('id').execute();
    expect(stored.map((t) => t.id)).not.toContain(res.body.access_token);

    const jti = unique('jti');
    expect((await tool.requestToken(ALL_AGS, await tool.clientAssertion({ jti }))).status).toBe(200);
    expect((await tool.requestToken(ALL_AGS, await tool.clientAssertion({ jti }))).status).toBe(401); // replayed jti
    expect((await tool.requestToken(ALL_AGS, await tool.clientAssertion({ aud: `${ISS}/lti/auth` }))).status).toBe(401);
    const none = new UnsecuredJWT({})
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(`${ISS}/lti/token`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(unique('j'))
      .encode();
    expect((await tool.requestToken(ALL_AGS, none)).status).toBe(401);
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(`${ISS}/lti/token`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(unique('j'))
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough!'));
    expect((await tool.requestToken(ALL_AGS, hs)).status).toBe(401);

    // A tool without NRPS can't get the membership scope.
    await school.admin.patch(`/api/admin/lti/tools/${tool.toolId}`, { allowNrps: false });
    expect((await tool.requestToken([NRPS_SCOPE])).body.error).toBe('invalid_scope');
    const agsOnly = await tool.token([...ALL_AGS, NRPS_SCOPE]);
    expect((await tool.call(agsOnly, 'GET', `/lti/nrps/${courseId}/memberships`)).status).toBe(403);
    // Turning a service off also stops tokens issued before.
    const nrpsToken = res.body.access_token as string;
    expect((await tool.call(nrpsToken, 'GET', `/lti/nrps/${courseId}/memberships`)).status).toBe(403);
    expect((await tool.call('not-a-real-token-value-at-all', 'GET', `/lti/ags/${courseId}/lineitems`)).status).toBe(401);
  });

  it('rate limits the token endpoint without letting junk naming a tool lock it out', async () => {
    // Junk signed with someone else's key but naming the tool's (public) client_id, all from one
    // address, as every request is behind a reverse proxy.
    const garbage = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(tool.clientId)
      .sign((await generateKeyPair('RS256')).privateKey);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await tool.requestToken(ALL_AGS, garbage)).status;
    expect(last).toBe(429);
    // The tool itself still gets tokens, up to its own limit.
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await tool.requestToken(ALL_AGS)).status);
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(statuses[60]).toBe(429);
  });

  it("rescales the tool's grades when the activity's maximum grade changes", async () => {
    const token = await tool.token(ALL_AGS);
    const lineItem = `/lti/ags/${courseId}/lineitems/${activityId}`;
    expect((await tool.call(token, 'POST', `${lineItem}/scores`, { type: MEDIA.score, body: score(samId, 8) })).status).toBe(204);
    expect((await school.teacher.put(`/api/courses/${courseId}/grades/${activityId}/${kimId}`, { score: 25 })).status).toBe(200);
    const cells = async () => {
      const book = await school.teacher.get(`/api/courses/${courseId}/grades`);
      return Object.fromEntries(book.body.gradebook.rows.map((row: any) => [row.user.id, row.cells[activityId]?.score]));
    };
    expect(await cells()).toMatchObject({ [samId]: 40, [kimId]: 25 });

    // 8/10 from the tool becomes 8 of 10; the teacher's 25 of 50 becomes 5 of 10.
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { maxGrade: 10 })).status).toBe(200);
    expect(await cells()).toMatchObject({ [samId]: 8, [kimId]: 5 });
    const results = await tool.call(token, 'GET', `${lineItem}/results?user_id=${samId}`);
    expect(results.body).toEqual([expect.objectContaining({ resultScore: 8, resultMaximum: 10 })]);
    expect((await school.sam.get(`/api/lti/activities/${activityId}`)).body.grade).toMatchObject({ score: 8, maxGrade: 10 });

    // Ungraded and graded again: the tool's grade is recomputed from its score.
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { maxGrade: null })).status).toBe(200);
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { maxGrade: 20 })).status).toBe(200);
    expect((await cells())[samId]).toBe(16);
  });

  it('serves line items, takes scores into the gradebook and reports results', async () => {
    const token = await tool.token(ALL_AGS);
    const container = `/lti/ags/${courseId}/lineitems`;
    const list = await tool.call(token, 'GET', container, { accept: MEDIA.container });
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toBe(MEDIA.container);
    expect(list.body).toEqual([
      { id: `${ISS}${container}/${activityId}`, label: 'Coding lab', scoreMaximum: 50, resourceLinkId: activityId },
    ]);
    expect((await tool.call(token, 'GET', container, { accept: 'text/html' })).status).toBe(406);

    // A line item of the tool's own, then paging and filters.
    const created = await tool.call(token, 'POST', container, {
      type: MEDIA.lineItem,
      body: { label: 'Bonus', scoreMaximum: 5, tag: 'extra', resourceLinkId: activityId },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ label: 'Bonus', scoreMaximum: 5, tag: 'extra', resourceLinkId: activityId });
    expect((await tool.call(token, 'POST', container, { type: 'text/plain', body: { label: 'X', scoreMaximum: 1 } })).status).toBe(415);
    expect(
      (
        await tool.call(token, 'POST', container, {
          type: MEDIA.lineItem,
          body: { label: 'X', scoreMaximum: 1, resourceLinkId: 'elsewhere' },
        })
      ).status,
    ).toBe(400);
    const page1 = await tool.call(token, 'GET', `${container}?limit=1`);
    expect(page1.body).toHaveLength(1);
    const next = /<([^>]+)>; rel="next"/.exec(page1.headers.get('link') ?? '')?.[1];
    expect(next).toBe(`${ISS}${container}?limit=1&page=2`);
    const page2 = await tool.call(token, 'GET', next!);
    expect(page2.body.map((i: any) => i.label)).toEqual(['Bonus']);
    expect(page2.headers.get('link')).toBeNull();
    expect((await tool.call(token, 'GET', `${container}?tag=extra`)).body).toHaveLength(1);
    expect((await tool.call(token, 'GET', `${container}?resource_link_id=${activityId}`)).body).toHaveLength(2);

    // Scores: 8/10 becomes 40/50 in the gradebook, and Completed completes the activity.
    const lineItem = `${ISS}${container}/${activityId}`;
    const scored = await tool.call(token, 'POST', `${lineItem}/scores`, {
      type: MEDIA.score,
      body: score(samId, 8, { comment: 'Nice loops' }),
    });
    expect(scored.status).toBe(204);
    const book = await school.teacher.get(`/api/courses/${courseId}/grades`);
    const samRow = book.body.gradebook.rows.find((row: any) => row.user.id === samId);
    expect(samRow.cells[activityId]).toMatchObject({ score: 40, feedback: 'Nice loops' });
    expect((await school.sam.get(`/api/activities/${activityId}`)).body.completed).toBe(true);
    expect((await school.sam.get(`/api/lti/activities/${activityId}`)).body.grade).toMatchObject({ score: 40, maxGrade: 50 });

    // An older score is ignored; a newer one replaces it; pending scores don't touch the gradebook.
    await tool.call(token, 'POST', `${lineItem}/scores`, {
      type: MEDIA.score,
      body: score(samId, 2, { timestamp: new Date(Date.now() - 60_000).toISOString() }),
    });
    await tool.call(token, 'POST', `${lineItem}/scores`, {
      type: MEDIA.score,
      body: score(kimId, 5, { gradingProgress: 'Pending', activityProgress: 'Submitted' }),
    });
    const results = await tool.call(token, 'GET', `${lineItem}/results`, { accept: MEDIA.results });
    expect(results.headers.get('content-type')).toBe(MEDIA.results);
    expect(results.body).toEqual([
      { id: `${lineItem}/results/${samId}`, scoreOf: lineItem, userId: samId, resultScore: 40, resultMaximum: 50, comment: 'Nice loops' },
    ]);
    await tool.call(token, 'POST', `${lineItem}/scores`, {
      type: MEDIA.score,
      body: score(samId, 10, { timestamp: new Date(Date.now() + 1000).toISOString() }),
    });
    expect((await tool.call(token, 'GET', `${lineItem}/results?user_id=${samId}`)).body[0].resultScore).toBe(50);
    expect((await school.kim.get(`/api/activities/${activityId}`)).body.completed).toBe(false);

    // Malformed scores and unknown users.
    expect(
      (await tool.call(token, 'POST', `${lineItem}/scores`, { type: MEDIA.score, body: { ...score(samId, 5), scoreMaximum: undefined } }))
        .status,
    ).toBe(400);
    expect((await tool.call(token, 'POST', `${lineItem}/scores`, { type: MEDIA.score, body: score('nobody', 5) })).status).toBe(400);
    expect(
      (await tool.call(token, 'POST', `${lineItem}/scores`, { type: MEDIA.score, body: { ...score(samId, 5), timestamp: 'yesterday' } }))
        .status,
    ).toBe(400);

    // The tool's own line item keeps its scores out of the gradebook.
    const bonus = created.body.id as string;
    await tool.call(token, 'POST', `${bonus}/scores`, { type: MEDIA.score, body: { ...score(samId, 4), scoreMaximum: 5 } });
    expect((await tool.call(token, 'GET', `${bonus}/results`)).body[0]).toMatchObject({ userId: samId, resultScore: 4, resultMaximum: 5 });

    // Updating and deleting.
    const updated = await tool.call(token, 'PUT', bonus, { type: MEDIA.lineItem, body: { label: 'Bonus round', scoreMaximum: 10 } });
    expect(updated.body).toMatchObject({ label: 'Bonus round', scoreMaximum: 10 });
    const managed = await tool.call(token, 'PUT', lineItem, {
      type: MEDIA.lineItem,
      body: { label: 'Renamed', scoreMaximum: 1, tag: 'graded' },
    });
    expect(managed.body).toMatchObject({ label: 'Coding lab', scoreMaximum: 50, tag: 'graded' });
    expect((await tool.call(token, 'DELETE', lineItem)).status).toBe(403);
    expect((await tool.call(token, 'DELETE', bonus)).status).toBe(204);
    expect((await tool.call(token, 'GET', bonus)).status).toBe(404);
  });

  it('needs the right scope for each service call', async () => {
    const readOnly = await tool.token([`${AGS}lineitem.readonly`]);
    const container = `/lti/ags/${courseId}/lineitems`;
    expect((await tool.call(readOnly, 'GET', container)).status).toBe(200);
    expect((await tool.call(readOnly, 'POST', container, { type: MEDIA.lineItem, body: { label: 'X', scoreMaximum: 1 } })).status).toBe(
      403,
    );
    expect(
      (await tool.call(readOnly, 'POST', `${container}/${activityId}/scores`, { type: MEDIA.score, body: score(samId, 1) })).status,
    ).toBe(403);
    expect((await tool.call(readOnly, 'GET', `${container}/${activityId}/results`)).status).toBe(403);
    const res = await tool.call(readOnly, 'GET', `/lti/nrps/${courseId}/memberships`);
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it("can't reach a course that doesn't use the tool, or another tool's activities", async () => {
    const token = await tool.token([...ALL_AGS, NRPS_SCOPE]);
    const other = await school.teacher.post('/api/courses', { title: 'Other course', summary: 'x', visibility: 'published' });
    expect((await tool.call(token, 'GET', `/lti/ags/${other.body.id}/lineitems`)).status).toBe(404);
    expect((await tool.call(token, 'GET', `/lti/nrps/${other.body.id}/memberships`)).status).toBe(404);

    // A second tool used in this course doesn't see the first tool's line items.
    const second = await MockTool.create(lms, 'second-key');
    await second.register(school.admin, { name: 'Second tool' });
    await addLtiActivity(school.teacher, { title: 'Second activity', settings: { toolId: second.toolId } });
    const secondToken = await second.token(ALL_AGS);
    const items = await second.call(secondToken, 'GET', `/lti/ags/${courseId}/lineitems`);
    expect(items.body.map((i: any) => i.label)).toEqual(['Second activity']);
    expect((await second.call(secondToken, 'GET', `/lti/ags/${courseId}/lineitems/${activityId}`)).status).toBe(404);
    expect(
      (
        await second.call(secondToken, 'POST', `/lti/ags/${courseId}/lineitems/${activityId}/scores`, {
          type: MEDIA.score,
          body: score(samId, 1),
        })
      ).status,
    ).toBe(404);

    // Once the course's last activity for the tool is deleted, the course is closed to it.
    expect((await del(lms, school.teacher, `/api/activities/${activityId}`)).status).toBe(200);
    expect((await tool.call(token, 'GET', `/lti/ags/${courseId}/lineitems`)).status).toBe(404);
  });

  it('lists course members with role filters and paging, sharing only what the tool may have', async () => {
    const token = await tool.token([NRPS_SCOPE]);
    const url = `/lti/nrps/${courseId}/memberships`;
    const res = await tool.call(token, 'GET', url, { accept: MEDIA.members });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MEDIA.members);
    expect(res.body.context).toEqual({ id: courseId, label: school.course.slug, title: 'Testing 101' });
    expect(res.body.members).toHaveLength(3);
    const sam = res.body.members.find((m: any) => m.user_id === samId);
    expect(sam).toEqual({ status: 'Active', user_id: samId, roles: [ROLES.learner], name: 'Sam Student' });
    const learners = await tool.call(token, 'GET', `${url}?role=${encodeURIComponent(ROLES.learner)}`);
    expect(learners.body.members.map((m: any) => m.user_id).sort()).toEqual([samId, kimId].sort());
    expect((await tool.call(token, 'GET', `${url}?role=Instructor`)).body.members).toHaveLength(1);
    const page = await tool.call(token, 'GET', `${url}?limit=2`);
    expect(page.body.members).toHaveLength(2);
    expect(page.headers.get('link')).toContain('page=2');
    expect((await tool.call(token, 'GET', `${url}?limit=2&page=2`)).body.members).toHaveLength(1);
    expect((await tool.call(token, 'GET', url, { accept: 'text/html' })).status).toBe(406);
  });

  it('fetches a JWKS URL once, caches it and refetches an unknown kid at most once a minute', async () => {
    const jwksTool = await MockTool.create(lms, 'jwks-key');
    await jwksTool.register(school.admin, { name: 'JWKS tool', keyType: 'jwks', jwksUrl: `${TOOL_ORIGIN}/jwks.json`, publicKey: null });
    await addLtiActivity(school.teacher, { title: 'JWKS activity', settings: { toolId: jwksTool.toolId } });
    let keys = [jwksTool.publicJwk];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }));
    expect((await jwksTool.requestToken(ALL_AGS)).status).toBe(200);
    expect((await jwksTool.requestToken(ALL_AGS)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The tool rotates its key: an unknown kid refetches, but not more than once a minute.
    const rotated = await MockTool.create(lms, 'jwks-key-2');
    rotated.clientId = jwksTool.clientId;
    keys = [rotated.publicJwk];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30_000);
    expect((await rotated.requestToken(ALL_AGS)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await rotated.requestToken(ALL_AGS)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses an oversized JWKS', async () => {
    const jwksTool = await MockTool.create(lms, 'big-key');
    await jwksTool.register(school.admin, { name: 'Big JWKS tool', keyType: 'jwks', jwksUrl: `${TOOL_ORIGIN}/big.json`, publicKey: null });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ keys: [jwksTool.publicJwk], pad: 'x'.repeat(100_000) })),
    );
    expect((await jwksTool.requestToken(ALL_AGS)).status).toBe(401);
  });
});

describe('upgrade', () => {
  it('migrates a 0.2.0 database with existing data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coursekit-lti-upgrade-'));
    const { db } = await createDatabase(`sqlite://${join(dir, 'old.db')}`);
    try {
      const upTo006 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= '006_grade_categories'));
      const old = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => upTo006 } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      const ts = new Date().toISOString();
      const [user, course, section, activity] = [newId(), newId(), newId(), newId()];
      await db
        .insertInto('users')
        .values({
          id: user,
          email: 'old@test.dev',
          name: 'Old',
          passwordHash: null,
          role: 'student',
          avatarUrl: null,
          bio: null,
          status: 'active',
          lastLoginAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();
      await db
        .insertInto('courses')
        .values({
          id: course,
          slug: 'old',
          title: 'Old',
          summary: '',
          description: '',
          categoryId: null,
          coverColor: 'indigo',
          coverImageUrl: null,
          visibility: 'published',
          enrolment: 'open',
          enrolmentKey: null,
          startDate: null,
          endDate: null,
          createdBy: user,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();
      await db
        .insertInto('sections')
        .values({ id: section, courseId: course, title: 'S', summary: '', position: 0, visible: 1, createdAt: ts })
        .execute();
      await db
        .insertInto('activities')
        .values({
          id: activity,
          courseId: course,
          sectionId: section,
          type: 'assignment',
          title: 'A',
          description: '',
          position: 0,
          visible: 1,
          settings: '{}',
          dueAt: null,
          maxGrade: 10,
          completion: 'auto',
          createdBy: user,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();

      const results = await migrateToLatest(db);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['007_lti', 'Success']);
      expect(results.every((r) => r.status === 'Success')).toBe(true);
      expect(await db.selectFrom('ltiTools').selectAll().execute()).toEqual([]);
      expect((await db.selectFrom('activities').select('title').where('id', '=', activity).executeTakeFirstOrThrow()).title).toBe('A');
      expect(await migrateToLatest(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
