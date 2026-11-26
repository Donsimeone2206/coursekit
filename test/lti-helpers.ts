import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import type { Client } from './helpers.js';

export const ISS = 'https://lms.test';
export const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
export const DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
export const AGS = 'https://purl.imsglobal.org/spec/lti-ags/scope/';
export const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
export const TOOL_ORIGIN = 'https://tool.test';
export const REDIRECT_URI = `${TOOL_ORIGIN}/callback`;

/** A Coursekit instance with a public URL, which LTI needs. */
export async function createLtiLms(publicUrl: string | null = ISS): Promise<Coursekit> {
  return createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-lti-')),
    webDir: false,
    publicUrl: publicUrl ?? undefined,
  });
}

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Reads the auto-submitting form of an LTI page. */
export function readForm(html: string): { action: string; fields: Record<string, string> } {
  const action = /<form[^>]*action="([^"]*)"/.exec(html)?.[1];
  if (!action) throw new Error(`No form in page: ${html.slice(0, 500)}`);
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g))
    fields[decodeEntities(m[1]!)] = decodeEntities(m[2]!);
  return { action: decodeEntities(action), fields };
}

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

/** A mock LTI tool: its own key pair, and the requests a real tool would make. */
export class MockTool {
  clientId = '';
  deploymentId = '';
  toolId = '';

  private constructor(
    readonly lms: Coursekit,
    readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
    readonly kid: string,
  ) {}

  static async create(lms: Coursekit, kid = 'tool-key-1') {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    return new MockTool(lms, privateKey, publicJwk, kid);
  }

  /** Registers the tool as an administrator. */
  async register(admin: Client, overrides: Record<string, unknown> = {}) {
    const res = await admin.post('/api/admin/lti/tools', {
      name: 'Mock lab',
      description: 'A tool used in tests',
      toolUrl: `${TOOL_ORIGIN}/launch`,
      loginUrl: `${TOOL_ORIGIN}/login`,
      redirectUris: [REDIRECT_URI],
      keyType: 'key',
      publicKey: JSON.stringify(this.publicJwk),
      deepLinkingUrl: `${TOOL_ORIGIN}/deep-link`,
      customParams: { color: 'blue' },
      shareName: true,
      shareEmail: false,
      allowAgs: true,
      allowNrps: true,
      ...overrides,
    });
    if (res.status !== 201) throw new Error(`Register failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.clientId = res.body.tool.clientId;
    this.deploymentId = res.body.tool.deploymentId;
    this.toolId = res.body.tool.id;
    return res.body;
  }

  /** Opens a Coursekit page as the signed-in user (cookie) and reads its form. */
  async open(path: string, cookie?: string) {
    const res = await this.lms.app.request(path, { headers: cookie ? { cookie } : {} });
    const html = await res.text();
    return { status: res.status, html, form: res.status === 200 && html.includes('<form') ? readForm(html) : null };
  }

  /** The tool's answer to the login initiation: the authentication request, posted to the platform. */
  async authorize(login: Record<string, string>, overrides: Record<string, string> = {}, cookie?: string) {
    const nonce = unique('nonce');
    const params = new URLSearchParams({
      scope: 'openid',
      response_type: 'id_token',
      client_id: login.client_id!,
      redirect_uri: REDIRECT_URI,
      login_hint: login.login_hint!,
      state: 'state-123',
      response_mode: 'form_post',
      nonce,
      prompt: 'none',
      lti_message_hint: login.lti_message_hint!,
      ...overrides,
    });
    const res = await this.lms.app.request('/lti/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: params.toString(),
    });
    const html = await res.text();
    return { status: res.status, html, nonce, form: res.status === 200 && html.includes('<form') ? readForm(html) : null };
  }

  /** Verifies the platform's id_token against the published JWKS, like a tool does. */
  async verifyIdToken(idToken: string, nonce: string): Promise<JWTPayload> {
    const jwks = (await (await this.lms.app.request('/lti/jwks')).json()) as { keys: JWK[] };
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: ISS, audience: this.clientId, algorithms: ['RS256'] });
    if (payload.nonce !== nonce) throw new Error('nonce mismatch');
    return payload;
  }

  /** Full launch as `cookie`'s user; returns the verified id_token claims. */
  async launch(path: string, cookie: string): Promise<JWTPayload> {
    const login = await this.open(path, cookie);
    if (!login.form) throw new Error(`Launch page failed: ${login.status} ${login.html.slice(0, 300)}`);
    const auth = await this.authorize(login.form.fields);
    if (!auth.form) throw new Error(`Authorization failed: ${auth.status} ${auth.html.slice(0, 300)}`);
    return this.verifyIdToken(auth.form.fields.id_token!, auth.nonce);
  }

  sign(claims: Record<string, unknown>, options: { aud?: string; exp?: string | number; iat?: number; kid?: string } = {}) {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? this.kid })
      .setIssuer(this.clientId)
      .setAudience(options.aud ?? ISS)
      .setExpirationTime(options.exp ?? '5m');
    if (options.iat !== undefined) jwt.setIssuedAt(options.iat);
    else jwt.setIssuedAt();
    return jwt.sign(this.privateKey);
  }

  deepLinkingResponse(data: string, items: unknown[], extra: Record<string, unknown> = {}) {
    return {
      nonce: unique('dl'),
      [`${LTI}message_type`]: 'LtiDeepLinkingResponse',
      [`${LTI}version`]: '1.3.0',
      [`${LTI}deployment_id`]: this.deploymentId,
      [`${DL}data`]: data,
      [`${DL}content_items`]: items,
      ...extra,
    };
  }

  async postDeepLink(jwt: string) {
    const res = await this.lms.app.request('/lti/deep-link/return', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ JWT: jwt }).toString(),
    });
    return { status: res.status, html: await res.text() };
  }

  async clientAssertion(options: { aud?: string; jti?: string; kid?: string } = {}) {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? this.kid })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(options.aud ?? `${ISS}/lti/token`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(options.jti ?? unique('jti'))
      .sign(this.privateKey);
  }

  async requestToken(scopes: string[], assertion?: string) {
    const res = await this.lms.app.request('/lti/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion ?? (await this.clientAssertion()),
        scope: scopes.join(' '),
      }).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async token(scopes: string[]): Promise<string> {
    const res = await this.requestToken(scopes);
    if (res.status !== 200) throw new Error(`Token failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.access_token as string;
  }

  /** A service call with a bearer token. `url` may be absolute (from a claim) or a path. */
  async call(token: string, method: string, url: string, options: { accept?: string; type?: string; body?: unknown } = {}) {
    const path = url.startsWith(ISS) ? url.slice(ISS.length) : url;
    const res = await this.lms.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.accept ? { accept: options.accept } : {}),
        ...(options.body !== undefined ? { 'content-type': options.type ?? 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body, headers: res.headers };
  }
}
