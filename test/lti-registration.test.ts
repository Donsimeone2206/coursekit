import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { sha256 } from '../src/server/lib/util.js';
import { del } from './completion-helpers.js';
import { login, setupSchool, type Client } from './helpers.js';
import { AGS, createLtiLms, DL, ISS, LTI, MockTool, NRPS_SCOPE, REDIRECT_URI, TOOL_ORIGIN } from './lti-helpers.js';
import {
  JWKS_URL,
  PLATFORM_CONFIG,
  postRegistration,
  REGISTER_URL,
  registerFromOpenUrl,
  registrationRequest,
  serveToolKeys,
  startRegistration,
  TOOL_CONFIG,
} from './lti-registration-helpers.js';

const ALL_AGS = [`${AGS}lineitem`, `${AGS}lineitem.readonly`, `${AGS}result.readonly`, `${AGS}score`];

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  lms = await createLtiLms();
  school = await setupSchool(lms);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await lms.close();
});

async function userId(email: string) {
  return (await lms.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

async function registerTool(body: unknown = registrationRequest()) {
  const started = await startRegistration(school.admin);
  const res = await postRegistration(lms, started.token, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const tool = await lms.db.selectFrom('ltiTools').selectAll().where('clientId', '=', res.body.client_id).executeTakeFirstOrThrow();
  return { started, res, tool };
}

describe('OpenID configuration', () => {
  it('describes what Coursekit supports, as a public document with CORS', async () => {
    const res = await lms.app.request('/lti/openid-configuration', { headers: { origin: 'https://tool.test' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const config = (await res.json()) as Record<string, any>;
    expect(config).toEqual({
      issuer: ISS,
      authorization_endpoint: `${ISS}/lti/auth`,
      token_endpoint: `${ISS}/lti/token`,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: expect.arrayContaining(['RS256']),
      jwks_uri: `${ISS}/lti/jwks`,
      registration_endpoint: `${ISS}/lti/registration`,
      scopes_supported: ['openid', ...ALL_AGS, NRPS_SCOPE],
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      claims_supported: ['iss', 'sub', 'name', 'email'],
      [PLATFORM_CONFIG]: {
        product_family_code: 'coursekit',
        version: lms.version,
        messages_supported: [{ type: 'LtiResourceLinkRequest' }, { type: 'LtiDeepLinkingRequest', placements: ['ContentArea'] }],
      },
    });
    expect(config.token_endpoint_auth_signing_alg_values_supported).not.toContain('HS256');
    expect(config.token_endpoint_auth_signing_alg_values_supported).not.toContain('none');
    // The endpoints it names exist.
    expect((await lms.app.request('/lti/jwks')).status).toBe(200);
    const preflight = await lms.app.request('/lti/registration', {
      method: 'OPTIONS',
      headers: { origin: 'https://tool.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
  });

  it('can be read from the browser with the registration token as a bearer token, as some tools send it', async () => {
    const preflight = await lms.app.request('/lti/openid-configuration', {
      method: 'OPTIONS',
      headers: { origin: 'https://tool.test', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    const started = await startRegistration(school.admin);
    const res = await lms.app.request('/lti/openid-configuration', {
      headers: { origin: 'https://tool.test', authorization: `Bearer ${started.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await res.json()) as Record<string, unknown>).issuer).toBe(ISS);
    // Reading it doesn't use the token up.
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(201);
  });

  it("isn't available until the site has a public URL", async () => {
    const bare = await createLtiLms(null);
    try {
      expect((await bare.app.request('/lti/openid-configuration')).status).toBe(404);
      const s = await setupSchool(bare);
      const res = await s.admin.post('/api/admin/lti/registrations', { url: REGISTER_URL });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('COURSEKIT_PUBLIC_URL');
    } finally {
      await bare.close();
    }
  });
});

describe('starting a registration', () => {
  it('is for administrators and opens the tool with the two parameters of the specification', async () => {
    expect((await school.teacher.post('/api/admin/lti/registrations', { url: REGISTER_URL })).status).toBe(403);
    const res = await school.admin.post('/api/admin/lti/registrations', { url: `${REGISTER_URL}?product=labs#top` });
    expect(res.status).toBe(201);
    const open = new URL(res.body.openUrl);
    expect(open.origin + open.pathname).toBe(REGISTER_URL);
    expect(open.hash).toBe('');
    expect(open.searchParams.get('product')).toBe('labs');
    expect(open.searchParams.get('openid_configuration')).toBe(`${ISS}/lti/openid-configuration`);
    const token = open.searchParams.get('registration_token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expires = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(expires).toBeGreaterThan(59 * 60_000);
    expect(expires).toBeLessThanOrEqual(60 * 60_000);

    // Only a hash of the token is stored.
    const row = await lms.db.selectFrom('ltiRegistrations').selectAll().where('id', '=', res.body.id).executeTakeFirstOrThrow();
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.createdBy).toBe(await userId('admin@test.dev'));
    expect((await school.admin.get(`/api/admin/lti/registrations/${res.body.id}`)).body).toMatchObject({
      status: 'pending',
      toolId: null,
    });
    expect((await school.teacher.get(`/api/admin/lti/registrations/${res.body.id}`)).status).toBe(403);
  });

  it('needs https (http only for localhost) and a URL of the tool, not of this site', async () => {
    for (const url of [
      'http://tool.test/register',
      'ftp://tool.test/register',
      'javascript:alert(1)',
      'tool.test/register',
      'https://user:secret@tool.test/register',
      `${ISS}/admin/external-tools`,
      '',
    ]) {
      const res = await school.admin.post('/api/admin/lti/registrations', { url });
      expect(res.status, url).toBe(400);
    }
    for (const url of ['http://localhost:4000/register', 'http://127.0.0.1:4000/register', 'http://lab.localhost/register']) {
      expect((await school.admin.post('/api/admin/lti/registrations', { url })).status, url).toBe(201);
    }
  });

  it('can be cancelled until the tool uses it, which turns its token off', async () => {
    const started = await startRegistration(school.admin);
    expect((await del(lms, school.teacher, `/api/admin/lti/registrations/${started.id}`)).status).toBe(403);
    expect((await del(lms, school.admin, `/api/admin/lti/registrations/${started.id}`)).status).toBe(200);
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(401);
    expect((await school.admin.get(`/api/admin/lti/registrations/${started.id}`)).status).toBe(404);

    const { started: used } = await registerTool();
    const cancel = await del(lms, school.admin, `/api/admin/lti/registrations/${used.id}`);
    expect(cancel.status).toBe(409);
  });
});

describe('the registration flow', () => {
  it('registers a tool turned off, which launches and gets tokens once an administrator turns it on', async () => {
    const mock = await MockTool.create(lms, 'registered-key');
    const fetchSpy = serveToolKeys(mock);

    // The tool reads the configuration and registers, without Coursekit fetching anything.
    const started = await startRegistration(school.admin);
    const reg = await registerFromOpenUrl(lms, started.openUrl);
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = reg.body;
    expect(body.client_id).toMatch(/^[a-z0-9]{20}$/);
    const deploymentId = body[TOOL_CONFIG].deployment_id;
    expect(deploymentId).toMatch(/^[a-z0-9]{12}$/);
    expect(body).toMatchObject({
      application_type: 'web',
      response_types: ['id_token'],
      grant_types: ['implicit', 'client_credentials'],
      initiate_login_uri: `${TOOL_ORIGIN}/login`,
      redirect_uris: [REDIRECT_URI],
      client_name: 'Registered lab',
      jwks_uri: JWKS_URL,
      token_endpoint_auth_method: 'private_key_jwt',
      logo_uri: `${TOOL_ORIGIN}/logo.png`,
      contacts: ['support@tool.test'],
      policy_uri: `${TOOL_ORIGIN}/privacy`,
      tos_uri: `${TOOL_ORIGIN}/terms`,
      scope: `${AGS}lineitem ${AGS}score ${NRPS_SCOPE}`,
      [TOOL_CONFIG]: {
        domain: 'tool.test',
        target_link_uri: `${TOOL_ORIGIN}/launch`,
        custom_parameters: { color: 'green' },
        claims: ['iss', 'sub', 'name'],
        messages: [{ type: 'LtiDeepLinkingRequest', target_link_uri: `${TOOL_ORIGIN}/deep-link`, placements: ['ContentArea'] }],
      },
    });
    mock.clientId = body.client_id;
    mock.deploymentId = deploymentId;

    // Turned off, marked as registered automatically, with what it asked for.
    const list = await school.admin.get('/api/admin/lti/tools');
    const listed = list.body.tools.find((t: any) => t.clientId === body.client_id);
    expect(listed).toMatchObject({
      name: 'Registered lab',
      status: 'disabled',
      keyType: 'jwks',
      jwksUrl: JWKS_URL,
      toolUrl: `${TOOL_ORIGIN}/launch`,
      loginUrl: `${TOOL_ORIGIN}/login`,
      redirectUris: [REDIRECT_URI],
      deepLinkingUrl: `${TOOL_ORIGIN}/deep-link`,
      customParams: { color: 'green' },
      shareName: true,
      shareEmail: false,
      allowAgs: true,
      allowNrps: true,
      deploymentId,
    });
    mock.toolId = listed.id;
    expect((await school.admin.get('/api/admin/lti/registrations')).body).toEqual([
      { toolId: listed.id, registeredAt: expect.any(String) },
    ]);
    expect((await school.admin.get(`/api/admin/lti/registrations/${started.id}`)).body).toMatchObject({
      status: 'completed',
      toolId: listed.id,
      toolName: 'Registered lab',
    });
    const review = await school.admin.get(`/api/admin/lti/tools/${listed.id}/registration`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      url: REGISTER_URL,
      startedBy: { name: 'Admin' },
      clientName: 'Registered lab',
      description: 'Labs in the browser',
      logoUri: `${TOOL_ORIGIN}/logo.png`,
      clientUri: `${TOOL_ORIGIN}/`,
      domain: 'tool.test',
      contacts: ['support@tool.test'],
      requestedScopes: [`${AGS}lineitem`, `${AGS}score`, NRPS_SCOPE],
      grantedScopes: [`${AGS}lineitem`, `${AGS}score`, NRPS_SCOPE],
      requestedClaims: ['iss', 'sub', 'name'],
      outsideDomains: [],
    });
    expect(review.body.messages).toEqual([
      {
        type: 'LtiDeepLinkingRequest',
        label: 'Add a lab',
        targetLinkUri: `${TOOL_ORIGIN}/deep-link`,
        placements: ['ContentArea'],
        used: true,
      },
    ]);
    expect((await school.teacher.get(`/api/admin/lti/tools/${listed.id}/registration`)).status).toBe(403);
    // A tool added by hand has nothing to review.
    const manual = await MockTool.create(lms, 'manual-key');
    await manual.register(school.admin);
    expect((await school.admin.get(`/api/admin/lti/tools/${manual.toolId}/registration`)).status).toBe(404);

    // While it's off, nothing works.
    const courseId = school.course.id;
    await school.sam.post(`/api/courses/${courseId}/enrol`);
    const activity = await school.teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'lti',
      title: 'Registered lab',
      maxGrade: 10,
      settings: { toolId: listed.id, presentation: 'window' },
    });
    expect(activity.status, JSON.stringify(activity.body)).toBe(201);
    expect((await mock.open(`/lti/launch/${activity.body.id}`, school.sam.cookie)).status).toBe(403);
    expect((await mock.requestToken([`${AGS}score`])).status).toBe(401);

    // An administrator turns it on: launches and the services work through the existing flows.
    expect((await school.admin.patch(`/api/admin/lti/tools/${listed.id}`, { status: 'active' })).body.tool.status).toBe('active');
    const claims = await mock.launch(`/lti/launch/${activity.body.id}`, school.sam.cookie);
    expect(claims[`${LTI}deployment_id`]).toBe(deploymentId);
    expect(claims[`${LTI}target_link_uri`]).toBe(`${TOOL_ORIGIN}/launch`);
    expect(claims[`${LTI}custom`]).toEqual({ color: 'green' });
    expect(claims.name).toBe('Sam Student');
    expect(claims.email).toBeUndefined();
    // Only the grade scopes it asked for are offered.
    expect(claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint']).toMatchObject({ scope: [`${AGS}lineitem`, `${AGS}score`] });
    expect(claims['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice']).toBeDefined();

    const token = await mock.requestToken([...ALL_AGS, NRPS_SCOPE]);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(token.body.scope.split(' ').sort()).toEqual([`${AGS}lineitem`, `${AGS}score`, NRPS_SCOPE].sort());
    expect((await mock.requestToken([`${AGS}result.readonly`])).body.error).toBe('invalid_scope');
    expect(fetchSpy).toHaveBeenCalledWith(JWKS_URL, expect.anything());
    const score = await mock.call(token.body.access_token, 'POST', `/lti/ags/${courseId}/lineitems/${activity.body.id}/scores`, {
      type: 'application/vnd.ims.lis.v1.score+json',
      body: {
        userId: await userId('sam@test.dev'),
        scoreGiven: 7,
        scoreMaximum: 10,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: new Date().toISOString(),
      },
    });
    expect(score.status).toBe(204);
    expect((await school.sam.get(`/api/lti/activities/${activity.body.id}`)).body.grade).toMatchObject({ score: 7, maxGrade: 10 });

    // The teacher's tool list says it can send grades.
    const options = await school.teacher.get(`/api/courses/${courseId}/lti/tools`);
    expect(options.body.find((t: any) => t.id === listed.id)).toMatchObject({ grades: true, deepLinking: true });
  });

  it('grants only the supported scopes it asked for, and shares only the claims it asked for', async () => {
    const { res, tool } = await registerTool(
      registrationRequest(
        {
          scope: `${AGS}lineitem.readonly  https://purl.imsglobal.org/spec/lti/scope/noticehandlers openid ${AGS}lineitem.readonly unknown`,
        },
        {
          claims: ['sub', 'email', 'picture', 'locale'],
          messages: [
            { type: 'LtiSubmissionReviewRequest', target_link_uri: 'not even a url' },
            { type: 'LtiDeepLinkingRequest', target_link_uri: `${TOOL_ORIGIN}/editor`, placements: ['RichTextEditor'] },
            { type: 'LtiResourceLinkRequest', target_link_uri: `${TOOL_ORIGIN}/launch/v2` },
            { type: 'LtiResourceLinkRequest', target_link_uri: `${TOOL_ORIGIN}/ignored` },
          ],
        },
      ),
    );
    expect(res.body.scope).toBe(`${AGS}lineitem.readonly`);
    expect(res.body[TOOL_CONFIG].claims).toEqual(['iss', 'sub', 'email']);
    expect(res.body[TOOL_CONFIG].messages).toEqual([{ type: 'LtiResourceLinkRequest', target_link_uri: `${TOOL_ORIGIN}/launch/v2` }]);
    expect(tool).toMatchObject({
      shareName: 0,
      shareEmail: 1,
      allowAgs: 1,
      allowNrps: 0,
      deepLinkingUrl: null,
      toolUrl: `${TOOL_ORIGIN}/launch/v2`,
      status: 'disabled',
    });
    expect(JSON.parse(tool.scopes!)).toEqual([`${AGS}lineitem.readonly`]);

    // Even with the class list turned on later, it can only get what it asked for.
    await school.admin.patch(`/api/admin/lti/tools/${tool.id}`, { status: 'active', allowNrps: true });
    const mock = await MockTool.create(lms, 'scoped-key');
    mock.clientId = tool.clientId;
    serveToolKeys(mock);
    const granted = await mock.requestToken([...ALL_AGS, NRPS_SCOPE]);
    expect(granted.body.scope).toBe(`${AGS}lineitem.readonly`);
    const options = await school.teacher.get(`/api/courses/${school.course.id}/lti/tools`);
    expect(options.body.find((t: any) => t.id === tool.id)).toMatchObject({ grades: false, deepLinking: false });

    // No scope and no claims at all is fine: launches only, nothing personal.
    const bare = await registerTool(registrationRequest({ scope: undefined }, { claims: undefined, messages: undefined }));
    expect(bare.res.body.scope).toBe('');
    expect(bare.res.body[TOOL_CONFIG].claims).toEqual(['iss', 'sub']);
    expect(bare.tool).toMatchObject({ shareName: 0, shareEmail: 0, allowAgs: 0, allowNrps: 0, scopes: '[]' });
  });

  it('accepts given_name and family_name as asking for names, and leaves out unsafe links', async () => {
    const { res, tool } = await registerTool(
      registrationRequest(
        {
          logo_uri: 'http://cdn.tool.test/logo.png',
          policy_uri: 'javascript:alert(1)',
          tos_uri: 42,
          contacts: ['support@tool.test', 'not an email', 'support@tool.test'],
        },
        { claims: ['given_name', 'family_name'] },
      ),
    );
    expect(tool.shareName).toBe(1);
    expect(res.body.logo_uri).toBeUndefined();
    expect(res.body.policy_uri).toBeUndefined();
    expect(res.body.tos_uri).toBeUndefined();
    expect(res.body.contacts).toEqual(['support@tool.test']);
    expect(res.body[TOOL_CONFIG].claims).toEqual(['iss', 'sub', 'name']);
  });

  it('points out URLs outside the domains the tool declared', async () => {
    const { tool } = await registerTool(
      registrationRequest(
        { jwks_uri: 'https://keys.example.net/jwks.json' },
        { domain: 'tool.test', secondary_domains: ['cdn.example.org'] },
      ),
    );
    const review = await school.admin.get(`/api/admin/lti/tools/${tool.id}/registration`);
    expect(review.body.secondaryDomains).toEqual(['cdn.example.org']);
    expect(review.body.outsideDomains).toEqual(['keys.example.net']);
  });
});

describe('registration tokens', () => {
  it('refuses missing, malformed, wrong, reused and expired tokens', async () => {
    const missing = await postRegistration(lms, null, registrationRequest());
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(missing.body.error).toBe('invalid_token');
    const basic = await postRegistration(lms, null, registrationRequest(), { authorization: 'Basic dXNlcjpwYXNz' });
    expect(basic.status).toBe(401);
    for (const token of ['short', 'x'.repeat(43), 'a b', `${'A'.repeat(43)}=`]) {
      const res = await postRegistration(lms, token, registrationRequest());
      expect(res.status, token).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    }

    const started = await startRegistration(school.admin);
    // A token from another registration, or a tampered one.
    expect(
      (await postRegistration(lms, `${started.token.slice(0, -1)}${started.token.endsWith('A') ? 'B' : 'A'}`, registrationRequest()))
        .status,
    ).toBe(401);
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(201);
    const reused = await postRegistration(lms, started.token, registrationRequest({ client_name: 'Second try' }));
    expect(reused.status).toBe(401);
    expect(reused.body.error).toBe('invalid_token');
    expect(await lms.db.selectFrom('ltiTools').select('name').where('name', '=', 'Second try').execute()).toEqual([]);

    const later = await startRegistration(school.admin);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect((await postRegistration(lms, later.token, registrationRequest())).status).toBe(401);
    expect((await school.admin.get(`/api/admin/lti/registrations/${later.id}`)).body.status).toBe('expired');
  });

  it('lets only one of two registrations racing with one token through', async () => {
    const started = await startRegistration(school.admin);
    const results = await Promise.all([
      postRegistration(lms, started.token, registrationRequest({ client_name: 'Racer one' })),
      postRegistration(lms, started.token, registrationRequest({ client_name: 'Racer two' })),
      postRegistration(lms, started.token, registrationRequest({ client_name: 'Racer three' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 401, 401]);
    const tools = await lms.db.selectFrom('ltiTools').select('name').where('name', 'like', 'Racer%').execute();
    expect(tools).toHaveLength(1);
  });

  it("stops working when the administrator who started it isn't an administrator any more", async () => {
    await lms.createUser({ name: 'Second admin', email: 'admin2@test.dev', password: 'test-password', role: 'admin' });
    const second = await login(lms, 'admin2@test.dev');
    const secondId = await userId('admin2@test.dev');

    const demoted = await startRegistration(second);
    await school.admin.patch(`/api/admin/users/${secondId}`, { role: 'instructor' });
    expect((await postRegistration(lms, demoted.token, registrationRequest())).status).toBe(401);
    await school.admin.patch(`/api/admin/users/${secondId}`, { role: 'admin' });
    expect((await postRegistration(lms, demoted.token, registrationRequest())).status).toBe(201);

    const suspended = await startRegistration(second);
    await school.admin.patch(`/api/admin/users/${secondId}`, { status: 'suspended' });
    expect((await postRegistration(lms, suspended.token, registrationRequest())).status).toBe(401);
    await school.admin.patch(`/api/admin/users/${secondId}`, { status: 'active' });

    const deleted = await startRegistration(await login(lms, 'admin2@test.dev'));
    expect((await del(lms, school.admin, `/api/admin/users/${secondId}`)).status).toBe(200);
    expect((await postRegistration(lms, deleted.token, registrationRequest())).status).toBe(401);
  });

  it('counts failed requests per client address', async () => {
    const proxied = await createCoursekit({
      databaseUrl: 'sqlite::memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'coursekit-lti-reg-')),
      webDir: false,
      publicUrl: ISS,
      trustProxy: 'loopback',
    });
    try {
      const viaProxy = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
      const send = (ip: string) => postRegistration(proxied, 'x'.repeat(43), registrationRequest(), { 'x-forwarded-for': ip }, viaProxy);
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await send('203.0.113.1')).status;
      expect(last).toBe(429);
      expect((await send('203.0.113.2')).status).toBe(401);
    } finally {
      await proxied.close();
    }
  });
});

describe('invalid registrations', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no client_name', registrationRequest({ client_name: undefined }), 'invalid_client_metadata'],
    ['an empty client_name', registrationRequest({ client_name: '   ' }), 'invalid_client_metadata'],
    ['a client_name that is too long', registrationRequest({ client_name: 'x'.repeat(201) }), 'invalid_client_metadata'],
    ['no initiate_login_uri', registrationRequest({ initiate_login_uri: undefined }), 'invalid_client_metadata'],
    ['an http initiate_login_uri', registrationRequest({ initiate_login_uri: 'http://tool.test/login' }), 'invalid_client_metadata'],
    ['a javascript: initiate_login_uri', registrationRequest({ initiate_login_uri: 'javascript:alert(1)' }), 'invalid_client_metadata'],
    ['no redirect_uris', registrationRequest({ redirect_uris: undefined }), 'invalid_redirect_uri'],
    ['empty redirect_uris', registrationRequest({ redirect_uris: [] }), 'invalid_redirect_uri'],
    ['a redirect URI that is not a URL', registrationRequest({ redirect_uris: ['/callback'] }), 'invalid_redirect_uri'],
    ['an http redirect URI', registrationRequest({ redirect_uris: ['http://tool.test/callback'] }), 'invalid_redirect_uri'],
    ['a data: redirect URI', registrationRequest({ redirect_uris: ['data:text/html,hi'] }), 'invalid_redirect_uri'],
    ['a redirect URI with a fragment', registrationRequest({ redirect_uris: [`${REDIRECT_URI}#x`] }), 'invalid_redirect_uri'],
    ['a redirect URI with a password', registrationRequest({ redirect_uris: ['https://a:b@tool.test/cb'] }), 'invalid_redirect_uri'],
    [
      'too many redirect URIs',
      registrationRequest({ redirect_uris: Array.from({ length: 21 }, (_, i) => `${TOOL_ORIGIN}/cb${i}`) }),
      'invalid_redirect_uri',
    ],
    ['no jwks_uri', registrationRequest({ jwks_uri: undefined }), 'invalid_client_metadata'],
    ['an ftp jwks_uri', registrationRequest({ jwks_uri: 'ftp://tool.test/jwks' }), 'invalid_client_metadata'],
    ['a URL that is too long', registrationRequest({ jwks_uri: `${TOOL_ORIGIN}/${'k'.repeat(2000)}` }), 'invalid_client_metadata'],
    ['response_types without id_token', registrationRequest({ response_types: ['code'] }), 'invalid_client_metadata'],
    ['no response_types', registrationRequest({ response_types: undefined }), 'invalid_client_metadata'],
    ['grant_types without implicit', registrationRequest({ grant_types: ['client_credentials'] }), 'invalid_client_metadata'],
    [
      'grant_types without client_credentials',
      registrationRequest({ grant_types: ['implicit', 'authorization_code'] }),
      'invalid_client_metadata',
    ],
    ['grant_types as a string', registrationRequest({ grant_types: 'implicit client_credentials' }), 'invalid_client_metadata'],
    ['a native application', registrationRequest({ application_type: 'native' }), 'invalid_client_metadata'],
    ['a client secret', registrationRequest({ token_endpoint_auth_method: 'client_secret_basic' }), 'invalid_client_metadata'],
    ['no token_endpoint_auth_method', registrationRequest({ token_endpoint_auth_method: undefined }), 'invalid_client_metadata'],
    ['HS256 assertions', registrationRequest({ token_endpoint_auth_signing_alg: 'HS256' }), 'invalid_client_metadata'],
    ['ES256 id_tokens', registrationRequest({ id_token_signed_response_alg: 'ES256' }), 'invalid_client_metadata'],
    ['no LTI tool configuration', registrationRequest({ [TOOL_CONFIG]: undefined }), 'invalid_client_metadata'],
    ['no domain', registrationRequest({}, { domain: undefined }), 'invalid_client_metadata'],
    ['a domain with a scheme', registrationRequest({}, { domain: 'https://tool.test' }), 'invalid_client_metadata'],
    ['a domain with a path', registrationRequest({}, { domain: 'tool.test/labs' }), 'invalid_client_metadata'],
    ['a bad secondary domain', registrationRequest({}, { secondary_domains: ['ok.test', 'not a domain'] }), 'invalid_client_metadata'],
    ['no target_link_uri', registrationRequest({}, { target_link_uri: undefined }), 'invalid_client_metadata'],
    ['an http target_link_uri', registrationRequest({}, { target_link_uri: 'http://tool.test/launch' }), 'invalid_client_metadata'],
    [
      'a bad message URL',
      registrationRequest({}, { messages: [{ type: 'LtiDeepLinkingRequest', target_link_uri: 'http://x.test/dl' }] }),
      'invalid_client_metadata',
    ],
    [
      'a message without a type',
      registrationRequest({}, { messages: [{ target_link_uri: `${TOOL_ORIGIN}/dl` }] }),
      'invalid_client_metadata',
    ],
    ['bad custom parameter names', registrationRequest({}, { custom_parameters: { 'not ok': 'x' } }), 'invalid_client_metadata'],
    ['custom parameters that are not text', registrationRequest({}, { custom_parameters: { count: 3 } }), 'invalid_client_metadata'],
    ['a description that is too long', registrationRequest({}, { description: 'x'.repeat(2001) }), 'invalid_client_metadata'],
    ['too many claims', registrationRequest({}, { claims: Array.from({ length: 51 }, (_, i) => `c${i}`) }), 'invalid_client_metadata'],
    ['a JSON array', [registrationRequest()], 'invalid_client_metadata'],
    ['JSON null', null, 'invalid_client_metadata'],
    // On a public site, nothing may point at Coursekit itself or at this server's machine (the JWKS URL is fetched).
    ['a URL on Coursekit itself', registrationRequest({ initiate_login_uri: `${ISS}/api/auth/logout` }), 'invalid_client_metadata'],
    [
      'http on localhost on a public site',
      registrationRequest({ initiate_login_uri: 'http://localhost:4000/login' }),
      'invalid_client_metadata',
    ],
    ['an https loopback JWKS URL', registrationRequest({ jwks_uri: 'https://127.0.0.1/jwks' }), 'invalid_client_metadata'],
    ['a loopback address written as a number', registrationRequest({ jwks_uri: 'https://2130706433/jwks' }), 'invalid_client_metadata'],
    ['an IPv4-mapped loopback address', registrationRequest({ jwks_uri: 'https://[::ffff:127.0.0.1]/jwks' }), 'invalid_client_metadata'],
    ['the unspecified address', registrationRequest({ jwks_uri: 'https://0.0.0.0/jwks' }), 'invalid_client_metadata'],
    ['a link-local (cloud metadata) address', registrationRequest({ jwks_uri: 'https://169.254.169.254/jwks' }), 'invalid_client_metadata'],
    ['an IPv6 loopback redirect URI', registrationRequest({ redirect_uris: ['https://[::1]/callback'] }), 'invalid_redirect_uri'],
    ['localhost with a trailing dot', registrationRequest({ redirect_uris: ['https://localhost./callback'] }), 'invalid_redirect_uri'],
    ['a localhost subdomain', registrationRequest({}, { target_link_uri: 'https://lab.localhost/launch' }), 'invalid_client_metadata'],
  ];

  it.each(cases)('refuses %s and keeps the token for a corrected request', async (_name, body, error) => {
    const started = await startRegistration(school.admin);
    const res = await postRegistration(lms, started.token, body);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe(error);
    expect(typeof res.body.error_description).toBe('string');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await lms.db.selectFrom('ltiTools').select('id').where('name', '=', 'Registered lab').execute()).toEqual([]);
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(201);
  });

  it('refuses bodies that are not JSON, too large, or sent as something else', async () => {
    const started = await startRegistration(school.admin);
    expect((await postRegistration(lms, started.token, '{"client_name":')).status).toBe(400);
    const form = await postRegistration(lms, started.token, 'client_name=x', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    const huge = await postRegistration(lms, started.token, registrationRequest({ padding: 'x'.repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe('invalid_client_metadata');
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(201);
  });

  it('accepts the misspelled "implict" grant type of the specification examples, and no application_type', async () => {
    const { res } = await registerTool(
      registrationRequest({ grant_types: ['implict', 'client_credentials'], application_type: undefined }),
    );
    expect(res.body.grant_types).toEqual(['implicit', 'client_credentials']);
    expect(res.body.application_type).toBe('web');
  });

  it('accepts tools on localhost while Coursekit itself runs on localhost', async () => {
    const local = await createLtiLms('http://localhost:3000');
    try {
      const s = await setupSchool(local);
      const localTool = registrationRequest(
        {
          initiate_login_uri: 'http://localhost:4000/login',
          redirect_uris: ['http://localhost:4000/callback'],
          jwks_uri: 'http://127.0.0.1:4000/jwks',
          logo_uri: 'http://localhost:4000/logo.png',
        },
        { domain: 'localhost:4000', target_link_uri: 'http://localhost:4000/launch' },
      );
      const started = await startRegistration(s.admin, 'http://localhost:4000/register');
      expect(new URL(started.configUrl).origin).toBe('http://localhost:3000');
      const res = await postRegistration(local, started.token, localTool);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.logo_uri).toBe('http://localhost:4000/logo.png');
      // Plain http elsewhere, and Coursekit's own address, are still refused.
      const again = await startRegistration(s.admin, 'http://localhost:4000/register');
      expect((await postRegistration(local, again.token, { ...localTool, jwks_uri: 'http://tool.test/jwks' })).status).toBe(400);
      expect((await postRegistration(local, again.token, { ...localTool, jwks_uri: 'http://localhost:3000/lti/jwks' })).status).toBe(400);
    } finally {
      await local.close();
    }
  });
});

describe('tools that registered themselves', () => {
  /** Registers a tool with `body`, turns it on, and returns a mock tool that acts as it. */
  async function registeredMock(body: unknown, kid: string) {
    const { res, tool } = await registerTool(body);
    expect((await school.admin.patch(`/api/admin/lti/tools/${tool.id}`, { status: 'active' })).status).toBe(200);
    const mock = await MockTool.create(lms, kid);
    mock.clientId = tool.clientId;
    mock.deploymentId = res.body[TOOL_CONFIG].deployment_id;
    mock.toolId = tool.id;
    return mock;
  }

  /** Starts content selection as the teacher, like choosing the tool when adding an activity: its deep linking settings. */
  async function startContentSelection(mock: MockTool) {
    const query = new URLSearchParams({ courseId: school.course.id, toolId: mock.toolId, sectionId: school.sectionId });
    const login = await mock.open(`/lti/deep-link/start?${query}`, school.teacher.cookie);
    expect(login.form, login.html.slice(0, 300)).toBeTruthy();
    const auth = await mock.authorize(login.form!.fields);
    expect(auth.form, auth.html.slice(0, 300)).toBeTruthy();
    const claims = await mock.verifyIdToken(auth.form!.fields.id_token!, auth.nonce);
    return claims[`${DL}deep_linking_settings`] as Record<string, any>;
  }

  const activityNamed = (title: string) => lms.db.selectFrom('activities').selectAll().where('title', '=', title).executeTakeFirst();

  it('are offered grade columns in content selection only when they may send scores', async () => {
    const readOnly = await registeredMock(
      registrationRequest({ client_name: 'Read-only lab', scope: `${AGS}lineitem.readonly` }),
      'ro-key',
    );
    const scoring = await registeredMock(registrationRequest({ client_name: 'Scoring lab', scope: `${AGS}score` }), 'score-key');
    serveToolKeys(readOnly, scoring);
    const item = (title: string) => ({
      type: 'ltiResourceLink',
      title,
      url: `${TOOL_ORIGIN}/labs/1`,
      lineItem: { scoreMaximum: 20, resourceId: 'lab-1', tag: 'labs' },
    });

    // Line items are offered to the tool that can send scores only, and only its line item makes a grade column.
    const readOnlySettings = await startContentSelection(readOnly);
    expect(readOnlySettings.accept_lineitem).toBe(false);
    const sent = await readOnly.postDeepLink(
      await readOnly.sign(readOnly.deepLinkingResponse(readOnlySettings.data, [item('No grades here')])),
    );
    expect(sent.status).toBe(200);
    const ungraded = await activityNamed('No grades here');
    expect(ungraded).toMatchObject({ maxGrade: null });
    expect(JSON.parse(ungraded!.settings)).toMatchObject({ lineItemResourceId: null, lineItemTag: null });

    const scoringSettings = await startContentSelection(scoring);
    expect(scoringSettings.accept_lineitem).toBe(true);
    expect(
      (await scoring.postDeepLink(await scoring.sign(scoring.deepLinkingResponse(scoringSettings.data, [item('Graded lab')])))).status,
    ).toBe(200);
    const graded = await activityNamed('Graded lab');
    expect(graded).toMatchObject({ maxGrade: 20 });
    expect(JSON.parse(graded!.settings)).toMatchObject({ lineItemResourceId: 'lab-1', lineItemTag: 'labs' });
  });

  it('may have launch URLs and content on the domains they declared', async () => {
    const mock = await registeredMock(
      registrationRequest(
        {},
        { domain: 'tool.test', secondary_domains: ['cdn.example.org'], target_link_uri: 'https://lti.tool.test/launch' },
      ),
      'domains-key',
    );
    serveToolKeys(mock);
    const tool = await lms.db.selectFrom('ltiTools').selectAll().where('id', '=', mock.toolId).executeTakeFirstOrThrow();
    expect(tool.toolUrl).toBe('https://lti.tool.test/launch');
    expect(JSON.parse(tool.domains!)).toEqual(['tool.test', 'cdn.example.org']);
    const addActivity = (toolId: string, launchUrl: string) =>
      school.teacher.post(`/api/courses/${school.course.id}/activities`, {
        sectionId: school.sectionId,
        type: 'lti',
        title: 'Lab',
        settings: { toolId, launchUrl, presentation: 'window' },
      });
    for (const url of [
      'https://tool.test/labs/1',
      'https://www.tool.test/labs/1',
      'https://lti.tool.test/labs/1',
      'https://cdn.example.org/1',
    ]) {
      expect((await addActivity(mock.toolId, url)).status, url).toBe(201);
    }
    const outside = await addActivity(mock.toolId, 'https://example.org/labs/1');
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toContain('lti.tool.test or tool.test or cdn.example.org');

    // Content selection: items on the declared domain are added, others are still skipped.
    const settings = await startContentSelection(mock);
    const items = [
      { type: 'ltiResourceLink', title: 'On the primary domain', url: 'https://tool.test/labs/2' },
      { type: 'ltiResourceLink', title: 'Somewhere else', url: 'https://elsewhere.test/labs/2' },
    ];
    const res = await mock.postDeepLink(await mock.sign(mock.deepLinkingResponse(settings.data, items)));
    expect(res.status).toBe(200);
    expect(res.html).toContain('1 item was skipped');
    expect(await activityNamed('On the primary domain')).toBeDefined();
    expect(await activityNamed('Somewhere else')).toBeUndefined();

    // A tool added by hand still only has its tool URL's host.
    const manual = await MockTool.create(lms, 'manual-key');
    await manual.register(school.admin);
    expect(
      (await lms.db.selectFrom('ltiTools').select('domains').where('id', '=', manual.toolId).executeTakeFirstOrThrow()).domains,
    ).toBeNull();
    expect((await addActivity(manual.toolId, 'https://cdn.example.org/1')).status).toBe(400);
    expect((await addActivity(manual.toolId, 'https://www.tool.test/1')).status).toBe(201);
  });
});

describe('the web UI', () => {
  it("keeps the same-origin opener policy, so windows opened from a tool's frame can't reach Coursekit", async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'coursekit-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Coursekit</title>');
    const web = await createCoursekit({
      databaseUrl: 'sqlite::memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'coursekit-web-data-')),
      webDir,
    });
    try {
      for (const path of ['/', '/admin/external-tools']) {
        const res = await web.app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get('cross-origin-opener-policy'), path).toBe('same-origin');
      }
      expect((await web.app.request('/api/health')).headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect((await web.app.request('/lti/openid-configuration')).headers.get('cross-origin-opener-policy')).toBe('same-origin');
    } finally {
      await web.close();
    }
  });
});
