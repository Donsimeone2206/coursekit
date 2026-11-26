import { vi } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import type { Client } from './helpers.js';
import { AGS, ISS, MockTool, NRPS_SCOPE, REDIRECT_URI, TOOL_ORIGIN } from './lti-helpers.js';

export const TOOL_CONFIG = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
export const PLATFORM_CONFIG = 'https://purl.imsglobal.org/spec/lti-platform-configuration';
export const JWKS_URL = `${TOOL_ORIGIN}/jwks.json`;
export const REGISTER_URL = `${TOOL_ORIGIN}/register`;

/** A client registration request as a tool sends it. `config` goes into the LTI tool configuration. */
export function registrationRequest(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['implicit', 'client_credentials'],
    initiate_login_uri: `${TOOL_ORIGIN}/login`,
    redirect_uris: [REDIRECT_URI],
    client_name: 'Registered lab',
    jwks_uri: JWKS_URL,
    logo_uri: `${TOOL_ORIGIN}/logo.png`,
    token_endpoint_auth_method: 'private_key_jwt',
    contacts: ['support@tool.test'],
    client_uri: `${TOOL_ORIGIN}/`,
    policy_uri: `${TOOL_ORIGIN}/privacy`,
    tos_uri: `${TOOL_ORIGIN}/terms`,
    scope: `${AGS}lineitem ${AGS}score ${NRPS_SCOPE}`,
    [TOOL_CONFIG]: {
      domain: 'tool.test',
      target_link_uri: `${TOOL_ORIGIN}/launch`,
      custom_parameters: { color: 'green' },
      claims: ['iss', 'sub', 'name'],
      description: 'Labs in the browser',
      messages: [
        { type: 'LtiDeepLinkingRequest', target_link_uri: `${TOOL_ORIGIN}/deep-link`, label: 'Add a lab', placements: ['ContentArea'] },
      ],
      ...config,
    },
    ...overrides,
  };
}

export interface StartedRegistration {
  id: string;
  openUrl: string;
  configUrl: string;
  token: string;
}

/** Starts a registration as an administrator, like pasting the URL into the dialog. */
export async function startRegistration(admin: Client, url = REGISTER_URL): Promise<StartedRegistration> {
  const res = await admin.post('/api/admin/lti/registrations', { url });
  if (res.status !== 201) throw new Error(`Starting the registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  const open = new URL(res.body.openUrl);
  return {
    id: res.body.id,
    openUrl: res.body.openUrl,
    configUrl: open.searchParams.get('openid_configuration')!,
    token: open.searchParams.get('registration_token')!,
  };
}

const path = (url: string) => (url.startsWith(ISS) ? url.slice(ISS.length) : url);

/** POST to the registration endpoint. `token: null` sends no Authorization header. */
export async function postRegistration(
  lms: Coursekit,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
  env?: unknown,
) {
  const res = await lms.app.request(
    '/lti/registration',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token !== null ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/**
 * What a tool does with the URL Coursekit opens: read the OpenID configuration (checking it belongs to the
 * issuer, as the specification asks of tools), then post its registration with the token.
 */
export async function registerFromOpenUrl(lms: Coursekit, openUrl: string, body: unknown = registrationRequest()) {
  const open = new URL(openUrl);
  const configUrl = open.searchParams.get('openid_configuration')!;
  const token = open.searchParams.get('registration_token')!;
  const configRes = await lms.app.request(path(configUrl));
  if (configRes.status !== 200) throw new Error(`OpenID configuration: ${configRes.status}`);
  const config = (await configRes.json()) as Record<string, any>;
  if (!configUrl.startsWith(config.issuer)) throw new Error('The configuration URL is not under the issuer');
  if (!String(config.registration_endpoint).startsWith(config.issuer)) throw new Error('Unexpected registration endpoint');
  const res = await lms.app.request(path(config.registration_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, config };
}

/** Serves the tool's JWKS at JWKS_URL to Coursekit's key fetcher; every other URL is a 404. */
export function serveToolKeys(...tools: MockTool[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: tools.map((t) => t.publicJwk) }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  });
}
