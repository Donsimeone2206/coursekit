/**
 * LTI Dynamic Registration 1.0, with Coursekit as the platform. It builds on OpenID Connect Dynamic Client
 * Registration 1.0 and RFC 7591.
 *
 * 1. An administrator pastes a tool's registration URL. Coursekit opens it (in a frame, or a window) with
 *    `openid_configuration` (the platform's configuration, a public document) and `registration_token`:
 *    random, single use, valid for an hour, bound to that administrator and stored only as a SHA-256 hash.
 * 2. The tool reads the configuration and posts its client registration to the registration endpoint, with
 *    the token as a bearer token.
 * 3. Coursekit checks the request, creates the tool turned off with a new client ID and deployment ID,
 *    grants only the scopes it asked for that Coursekit supports, shares names and emails only when it asked
 *    for those claims, and answers with what it recorded. An administrator reviews the tool and turns it on.
 *
 * Nothing here fetches a tool URL: the tool's JWKS is fetched later, by the limited fetcher in tools.ts.
 */
import { z } from 'zod';
import type {
  LtiRegisteredMessage,
  LtiRegistrationState,
  LtiRegistrationStatus,
  LtiToolRegistration,
} from '../../../shared/lti-registration.js';
import type { LtiRegistrationRow, LtiToolRow } from '../../db/schema-lti.js';
import type { UserRow } from '../../db/schema.js';
import type { DB } from '../../db/types.js';
import { addressInRanges } from '../../lib/client-address.js';
import { badRequest } from '../../lib/http.js';
import { newId, now, parseJson, randomToken, sha256 } from '../../lib/util.js';
import { isAgsScope, SCOPES, SUPPORTED_SCOPES } from './messages.js';
import { ltiCustomParamsSchema } from './settings.js';
import { checkToolKeys, TOOL_ALGORITHMS, toolInputSchema, type ToolInput } from './tools.js';

export const TOOL_CONFIGURATION = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
export const PLATFORM_CONFIGURATION = 'https://purl.imsglobal.org/spec/lti-platform-configuration';
export const RESOURCE_LINK = 'LtiResourceLinkRequest';
export const DEEP_LINKING = 'LtiDeepLinkingRequest';
/** Where Coursekit offers content selection: when a teacher adds an activity to a course. */
export const CONTENT_AREA = 'ContentArea';
/** How long a registration token works. */
export const REGISTRATION_SECONDS = 3600;
/** Largest registration request accepted. */
export const REGISTRATION_BODY_BYTES = 64 * 1024;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NAME_CLAIMS = ['name', 'given_name', 'family_name'];
const MAX_URL = 2000;

// ---- the platform's configuration ----------------------------------------------------------------

export const configurationUrl = (issuer: string) => `${issuer}/lti/openid-configuration`;
export const registrationEndpoint = (issuer: string) => `${issuer}/lti/registration`;

/** The platform's OpenID configuration. Everything in it is what Coursekit does. */
export function openIdConfiguration(issuer: string, version: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/lti/auth`,
    token_endpoint: `${issuer}/lti/token`,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: TOOL_ALGORITHMS,
    jwks_uri: `${issuer}/lti/jwks`,
    registration_endpoint: registrationEndpoint(issuer),
    scopes_supported: ['openid', ...SUPPORTED_SCOPES],
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    // Identity claims only (LTI claims aren't listed); name and email go to tools allowed to have them.
    claims_supported: ['iss', 'sub', 'name', 'email'],
    [PLATFORM_CONFIGURATION]: {
      product_family_code: 'coursekit',
      version,
      messages_supported: [{ type: RESOURCE_LINK }, { type: DEEP_LINKING, placements: [CONTENT_AREA] }],
    },
  };
}

// ---- URLs ----------------------------------------------------------------------------------------

const bareHost = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
const isLocalhostName = (host: string) => host === 'localhost' || host.endsWith('.localhost');

/** localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  return isLocalhostName(host) || addressInRanges(host, ['loopback']);
}

/** This machine or its local link: loopback, unspecified (0.0.0.0, ::) and link-local addresses (cloud metadata). */
const LOCAL_RANGES: readonly string[] = Object.freeze(['loopback', 'linklocal', '0.0.0.0/8', '::/128']);
const isLocalHost = (hostname: string) => {
  const host = bareHost(hostname);
  return isLocalhostName(host) || addressInRanges(host, LOCAL_RANGES);
};

/**
 * Where a registering tool's URLs may point. On a public site: https only, never Coursekit itself and never
 * this machine or its local link, since the server fetches the tool's JWKS URL later. While Coursekit itself
 * runs on localhost, http on localhost works too, for developing tools.
 */
export interface UrlPolicy {
  development: boolean;
  platformOrigin: string;
}

export function urlPolicy(issuer: string): UrlPolicy {
  const url = new URL(issuer);
  return { development: isLoopbackHost(url.hostname), platformOrigin: url.origin };
}

function toolUrl(text: string, policy: UrlPolicy): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.origin === policy.platformOrigin) return null;
  const local = isLocalHost(url.hostname);
  if (policy.development) return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url : null;
  return url.protocol === 'https:' && !local ? url : null;
}

const urlRule = (policy: UrlPolicy) =>
  policy.development
    ? 'an https URL (or http on localhost) of the tool, without a user name or password'
    : 'an https URL of the tool, without a user name or password. Local addresses such as localhost only work while Coursekit itself runs on localhost';

/** Checks the registration URL an administrator pasted. */
export function checkRegistrationUrl(input: string, issuer: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw badRequest('Paste the whole registration URL, starting with https://.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw badRequest('The registration URL must start with https:// (http:// only works for localhost).');
  }
  if (url.username || url.password) throw badRequest('Remove the user name and password from the registration URL.');
  if (url.origin === new URL(issuer).origin) {
    throw badRequest("That's an address on this site. Paste the registration URL the tool's provider gave you.");
  }
  url.hash = '';
  return url.toString();
}

/** The URL Coursekit opens: the tool's registration URL with the two query parameters of the specification. */
export function registrationOpenUrl(url: string, issuer: string, token: string): string {
  const open = new URL(url);
  open.searchParams.set('openid_configuration', configurationUrl(issuer));
  open.searchParams.set('registration_token', token);
  return open.toString();
}

// ---- the client registration request ---------------------------------------------------------------

export type RegistrationErrorCode = 'invalid_redirect_uri' | 'invalid_client_metadata';

/** An RFC 7591 error: answered with 400 and `{ error, error_description }`. */
export class RegistrationError extends Error {
  constructor(
    readonly code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** Null counts as absent, as many JSON encoders write it for unset fields. */
const present = (v: unknown) => v !== undefined && v !== null;

function fail(message: string, code: RegistrationErrorCode = 'invalid_client_metadata'): never {
  throw new RegistrationError(code, message);
}

function text(obj: Json, key: string, max: number, label = key): string | null {
  const value = obj[key];
  if (!present(value)) return null;
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${label} is too long (${max.toLocaleString('en')} characters at most).`);
  return trimmed || null;
}

function requiredText(obj: Json, key: string, max: number, label = key): string {
  return text(obj, key, max, label) ?? fail(`${label} is required.`);
}

function stringList(obj: Json, key: string, maxItems: number, maxLength: number, label = key): string[] | null {
  const value = obj[key];
  if (!present(value)) return null;
  if (!Array.isArray(value)) fail(`${label} must be an array of strings.`);
  if (value.length > maxItems) fail(`${label} has too many entries (${maxItems} at most).`);
  return value.map((item) => {
    if (typeof item !== 'string') fail(`${label} must be an array of strings.`);
    if (item.length > maxLength) fail(`${label} has an entry that is too long (${maxLength} characters at most).`);
    return item.trim();
  });
}

/** A URL the tool needs to work: refused when it breaks the URL policy. */
function requiredUrl(value: unknown, label: string, policy: UrlPolicy, code: RegistrationErrorCode = 'invalid_client_metadata'): string {
  if (!present(value)) fail(`${label} is required.`, code);
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a URL.`, code);
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL) fail(`${label} is too long (2,000 characters at most).`, code);
  if (!toolUrl(trimmed, policy)) fail(`${label} must be ${urlRule(policy)}.`, code);
  return trimmed;
}

/** A link shown to administrators (logo, website, policies): left out when it isn't a safe URL. */
function optionalLink(value: unknown, policy: UrlPolicy): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= MAX_URL && toolUrl(trimmed, policy) ? trimmed : null;
}

/** A host name (optionally with a port), without a scheme or path. */
function checkDomain(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a host name, such as tool.example.com.`);
  const host = value.trim().toLowerCase();
  let url: URL | null = null;
  if (host.length <= 253 && !/[\s/?#@\\]/.test(host)) {
    try {
      url = new URL(`https://${host}`);
    } catch {
      url = null;
    }
  }
  if (!url || url.pathname !== '/' || url.search || url.hash)
    fail(`${label} must be a host name, such as tool.example.com, without https://.`);
  return host;
}

const hostOf = (domain: string) => new URL(`https://${domain}`).hostname;

function onDomains(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => {
      const h = hostOf(d);
      return host === h || host.endsWith(`.${h}`);
    });
  } catch {
    return false;
  }
}

const emailSchema = z.email().max(254);

export interface ParsedRegistration {
  clientName: string;
  initiateLoginUri: string;
  redirectUris: string[];
  jwksUri: string;
  logoUri: string | null;
  clientUri: string | null;
  policyUri: string | null;
  tosUri: string | null;
  contacts: string[];
  requestedScopes: string[];
  grantedScopes: string[];
  domain: string;
  secondaryDomains: string[];
  targetLinkUri: string;
  customParameters: Record<string, string>;
  description: string | null;
  requestedClaims: string[];
  messages: LtiRegisteredMessage[];
  resourceLink: LtiRegisteredMessage | null;
  deepLinking: LtiRegisteredMessage | null;
  /** The tool as the manual form would save it (checked with toolInputSchema). */
  tool: ToolInput;
}

function parseMessages(value: unknown, defaultTarget: string, policy: UrlPolicy): LtiRegisteredMessage[] {
  const label = `${TOOL_CONFIGURATION}.messages`;
  if (!present(value)) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > 20) fail(`${label} has too many entries (20 at most).`);
  let resourceLink = false;
  let deepLinking = false;
  return value.map((raw, i) => {
    const where = `${label}[${i}]`;
    if (!isObject(raw)) fail(`${where} must be an object.`);
    const type = requiredText(raw, 'type', 100, `${where}.type`);
    const supported = type === RESOURCE_LINK || type === DEEP_LINKING;
    // Unsupported message types are ignored, so only their type is checked.
    const placements = supported ? (stringList(raw, 'placements', 20, 100, `${where}.placements`) ?? []) : [];
    const messageLabel = supported ? text(raw, 'label', 200, `${where}.label`) : null;
    const target = supported && present(raw.target_link_uri) ? requiredUrl(raw.target_link_uri, `${where}.target_link_uri`, policy) : null;
    // The first definition of a type wins; for content selection, the first one Coursekit has a place for.
    let used = false;
    if (type === RESOURCE_LINK && !resourceLink) used = resourceLink = true;
    if (type === DEEP_LINKING && !deepLinking && (placements.length === 0 || placements.includes(CONTENT_AREA))) {
      used = deepLinking = true;
    }
    return { type, label: messageLabel, targetLinkUri: target ?? (supported ? defaultTarget : null), placements, used };
  });
}

/**
 * Checks a client registration request (the tool's metadata) against the specification and Coursekit's
 * limits. Throws a RegistrationError for anything that can't be registered; unknown properties are ignored.
 * `issuer` is the platform's: it decides which tool URLs are allowed (see UrlPolicy).
 */
export function parseRegistrationRequest(body: unknown, issuer: string): ParsedRegistration {
  if (!isObject(body)) fail('The registration must be a JSON object.');
  const policy = urlPolicy(issuer);

  const applicationType = text(body, 'application_type', 100);
  if (applicationType && applicationType !== 'web') fail('application_type must be "web".');

  const responseTypes = stringList(body, 'response_types', 20, 100);
  if (!responseTypes?.includes('id_token')) fail('response_types must include "id_token".');
  const grantTypes = stringList(body, 'grant_types', 20, 100);
  // The specification's own examples misspell "implicit", and some tools copied them.
  if (!grantTypes || !(grantTypes.includes('implicit') || grantTypes.includes('implict')) || !grantTypes.includes('client_credentials')) {
    fail('grant_types must include "implicit" and "client_credentials".');
  }
  const authMethod = text(body, 'token_endpoint_auth_method', 100);
  if (authMethod !== 'private_key_jwt') fail('token_endpoint_auth_method must be "private_key_jwt".');
  const idTokenAlg = text(body, 'id_token_signed_response_alg', 20);
  if (idTokenAlg && idTokenAlg !== 'RS256') fail('id_token_signed_response_alg must be "RS256": Coursekit signs id_tokens with RS256.');
  const assertionAlg = text(body, 'token_endpoint_auth_signing_alg', 20);
  if (assertionAlg && !TOOL_ALGORITHMS.includes(assertionAlg)) {
    fail(`token_endpoint_auth_signing_alg must be one of ${TOOL_ALGORITHMS.join(', ')}.`);
  }

  const clientName = requiredText(body, 'client_name', 200);
  const initiateLoginUri = requiredUrl(body.initiate_login_uri, 'initiate_login_uri', policy);
  if (!present(body.redirect_uris)) fail('redirect_uris is required.', 'invalid_redirect_uri');
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    fail('redirect_uris must be a non-empty array of URLs.', 'invalid_redirect_uri');
  }
  if (body.redirect_uris.length > 20) fail('redirect_uris has too many entries (20 at most).', 'invalid_redirect_uri');
  const redirectUris = [
    ...new Set(
      body.redirect_uris.map((uri, i) => {
        const checked = requiredUrl(uri, `redirect_uris[${i}]`, policy, 'invalid_redirect_uri');
        if (new URL(checked).hash) fail(`redirect_uris[${i}] must not contain a fragment.`, 'invalid_redirect_uri');
        return checked;
      }),
    ),
  ];
  const jwksUri = requiredUrl(body.jwks_uri, 'jwks_uri', policy);

  const contactList = stringList(body, 'contacts', 10, 254) ?? [];
  const contacts = [...new Set(contactList.filter((c) => emailSchema.safeParse(c).success))];
  const scopeText = text(body, 'scope', 4000) ?? '';
  const requestedScopes = [...new Set(scopeText.split(/\s+/).filter(Boolean))];
  if (requestedScopes.length > 50) fail('scope has too many scopes (50 at most).');
  const grantedScopes = requestedScopes.filter((s) => SUPPORTED_SCOPES.includes(s));

  const config = body[TOOL_CONFIGURATION];
  if (!present(config)) fail(`${TOOL_CONFIGURATION} is required.`);
  if (!isObject(config)) fail(`${TOOL_CONFIGURATION} must be an object.`);
  const domain = checkDomain(config.domain, `${TOOL_CONFIGURATION}.domain`);
  const secondaryList = stringList(config, 'secondary_domains', 20, 253, `${TOOL_CONFIGURATION}.secondary_domains`) ?? [];
  const secondaryDomains = [...new Set(secondaryList.map((d, i) => checkDomain(d, `${TOOL_CONFIGURATION}.secondary_domains[${i}]`)))];
  const targetLinkUri = requiredUrl(config.target_link_uri, `${TOOL_CONFIGURATION}.target_link_uri`, policy);
  let customParameters: Record<string, string> = {};
  if (present(config.custom_parameters)) {
    const custom = ltiCustomParamsSchema.safeParse(config.custom_parameters);
    if (!custom.success) {
      fail(
        `${TOOL_CONFIGURATION}.custom_parameters: ${custom.error.issues[0]?.message ?? 'invalid'}. Use up to 50 names of letters, digits and underscores with text values of up to 1,000 characters.`,
      );
    }
    customParameters = custom.data;
  }
  const description = text(config, 'description', 2000, `${TOOL_CONFIGURATION}.description`);
  const requestedClaims = [...new Set(stringList(config, 'claims', 50, 100, `${TOOL_CONFIGURATION}.claims`) ?? [])];
  const messages = parseMessages(config.messages, targetLinkUri, policy);
  const resourceLink = messages.find((m) => m.used && m.type === RESOURCE_LINK) ?? null;
  const deepLinking = messages.find((m) => m.used && m.type === DEEP_LINKING) ?? null;

  const draft = {
    name: clientName,
    description: description ?? '',
    toolUrl: resourceLink?.targetLinkUri ?? targetLinkUri,
    loginUrl: initiateLoginUri,
    redirectUris,
    keyType: 'jwks' as const,
    jwksUrl: jwksUri,
    publicKey: null,
    deepLinkingUrl: deepLinking?.targetLinkUri ?? null,
    customParams: customParameters,
    shareName: requestedClaims.some((claim) => NAME_CLAIMS.includes(claim)),
    shareEmail: requestedClaims.includes('email'),
    allowAgs: grantedScopes.some(isAgsScope),
    allowNrps: grantedScopes.includes(SCOPES.memberships),
    status: 'disabled' as const,
  };
  // The same rules as a tool added by hand.
  const checked = toolInputSchema.safeParse(draft);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    fail(
      `${path ? `${path}: ` : ''}${issue?.message ?? 'invalid'}`,
      path.startsWith('redirectUris') ? 'invalid_redirect_uri' : 'invalid_client_metadata',
    );
  }
  try {
    checkToolKeys(checked.data);
  } catch {
    fail('jwks_uri is required.');
  }

  return {
    clientName,
    initiateLoginUri,
    redirectUris,
    jwksUri,
    logoUri: optionalLink(body.logo_uri, policy),
    clientUri: optionalLink(body.client_uri, policy),
    policyUri: optionalLink(body.policy_uri, policy),
    tosUri: optionalLink(body.tos_uri, policy),
    contacts,
    requestedScopes,
    grantedScopes,
    domain,
    secondaryDomains,
    targetLinkUri,
    customParameters,
    description,
    requestedClaims,
    messages,
    resourceLink,
    deepLinking,
    tool: checked.data,
  };
}

/** The registration response: the client ID and the configuration as Coursekit recorded it. */
export function registrationResponse(p: ParsedRegistration, tool: Pick<LtiToolRow, 'clientId' | 'deploymentId'>) {
  const used = [p.resourceLink, p.deepLinking].filter((m): m is LtiRegisteredMessage => !!m);
  return {
    client_id: tool.clientId,
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['implicit', 'client_credentials'],
    initiate_login_uri: p.initiateLoginUri,
    redirect_uris: p.redirectUris,
    client_name: p.clientName,
    jwks_uri: p.jwksUri,
    token_endpoint_auth_method: 'private_key_jwt',
    id_token_signed_response_alg: 'RS256',
    ...(p.logoUri ? { logo_uri: p.logoUri } : {}),
    ...(p.clientUri ? { client_uri: p.clientUri } : {}),
    ...(p.policyUri ? { policy_uri: p.policyUri } : {}),
    ...(p.tosUri ? { tos_uri: p.tosUri } : {}),
    ...(p.contacts.length ? { contacts: p.contacts } : {}),
    scope: p.grantedScopes.join(' '),
    [TOOL_CONFIGURATION]: {
      domain: p.domain,
      ...(p.secondaryDomains.length ? { secondary_domains: p.secondaryDomains } : {}),
      deployment_id: tool.deploymentId,
      target_link_uri: p.targetLinkUri,
      ...(Object.keys(p.customParameters).length ? { custom_parameters: p.customParameters } : {}),
      ...(p.description ? { description: p.description } : {}),
      claims: ['iss', 'sub', ...(p.tool.shareName ? ['name'] : []), ...(p.tool.shareEmail ? ['email'] : [])],
      messages: used.map((m) => ({
        type: m.type,
        target_link_uri: m.targetLinkUri,
        ...(m.type === DEEP_LINKING && m.placements.length ? { placements: [CONTENT_AREA] } : {}),
      })),
    },
  };
}

// ---- registrations in the database ---------------------------------------------------------------

/** What is kept for the administrator's review (lti_registrations.metadata). */
type RecordedRegistration = Omit<
  ParsedRegistration,
  'tool' | 'resourceLink' | 'deepLinking' | 'initiateLoginUri' | 'redirectUris' | 'jwksUri' | 'targetLinkUri' | 'customParameters'
> & {
  urls: string[];
};

export async function startRegistration(
  db: DB,
  admin: Pick<UserRow, 'id'>,
  url: string,
): Promise<{ row: LtiRegistrationRow; token: string }> {
  // Unused registrations are kept a day after they expire, so a dialog left open can still say "expired".
  await db
    .deleteFrom('ltiRegistrations')
    .where('status', '=', 'pending')
    .where('expiresAt', '<', new Date(Date.now() - 86_400_000).toISOString())
    .execute();
  const token = randomToken(32);
  const t = Date.now();
  const row: LtiRegistrationRow = {
    id: newId(),
    tokenHash: sha256(token),
    url,
    createdBy: admin.id,
    status: 'pending',
    expiresAt: new Date(t + REGISTRATION_SECONDS * 1000).toISOString(),
    createdAt: new Date(t).toISOString(),
    completedAt: null,
    toolId: null,
    metadata: null,
  };
  await db.insertInto('ltiRegistrations').values(row).execute();
  return { row, token };
}

/**
 * The pending registration a token belongs to, while it can still be used: not expired, not used, and the
 * administrator who started it is still an active administrator.
 */
export async function usableRegistration(db: DB, token: string): Promise<LtiRegistrationRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db.selectFrom('ltiRegistrations').selectAll().where('tokenHash', '=', sha256(token)).executeTakeFirst();
  if (!row || row.status !== 'pending' || row.expiresAt <= now() || !row.createdBy) return null;
  const admin = await db.selectFrom('users').select(['role', 'status']).where('id', '=', row.createdBy).executeTakeFirst();
  return admin?.role === 'admin' && admin.status === 'active' ? row : null;
}

/**
 * Uses the token and creates the tool, turned off, in one transaction. Returns null when the token was used
 * (or expired) in the meantime: only one registration can ever win a token.
 */
export async function completeRegistration(db: DB, registration: LtiRegistrationRow, p: ParsedRegistration): Promise<LtiToolRow | null> {
  return db.transaction().execute(async (trx) => {
    const ts = now();
    const claimed = await trx
      .updateTable('ltiRegistrations')
      .set({ status: 'completed', completedAt: ts })
      .where('id', '=', registration.id)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', ts)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) return null;
    const input = p.tool;
    const tool: LtiToolRow = {
      id: newId(),
      name: input.name,
      description: input.description,
      toolUrl: input.toolUrl,
      loginUrl: input.loginUrl,
      redirectUris: JSON.stringify(input.redirectUris),
      jwksUrl: input.jwksUrl,
      publicKey: null,
      deepLinkingUrl: input.deepLinkingUrl,
      customParams: JSON.stringify(input.customParams),
      shareName: input.shareName ? 1 : 0,
      shareEmail: input.shareEmail ? 1 : 0,
      allowAgs: input.allowAgs ? 1 : 0,
      allowNrps: input.allowNrps ? 1 : 0,
      clientId: newId(20),
      deploymentId: newId(12),
      status: 'disabled',
      scopes: JSON.stringify(p.grantedScopes),
      // Launch URLs and selected content may be on these too (the administrator sees them before turning it on).
      domains: JSON.stringify([p.domain, ...p.secondaryDomains]),
      createdBy: registration.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await trx.insertInto('ltiTools').values(tool).execute();
    const recorded: RecordedRegistration = {
      clientName: p.clientName,
      description: p.description,
      logoUri: p.logoUri,
      clientUri: p.clientUri,
      policyUri: p.policyUri,
      tosUri: p.tosUri,
      contacts: p.contacts,
      domain: p.domain,
      secondaryDomains: p.secondaryDomains,
      requestedScopes: p.requestedScopes,
      grantedScopes: p.grantedScopes,
      requestedClaims: p.requestedClaims,
      messages: p.messages,
      urls: [
        p.initiateLoginUri,
        ...p.redirectUris,
        p.jwksUri,
        p.targetLinkUri,
        ...p.messages.flatMap((m) => (m.used && m.targetLinkUri ? [m.targetLinkUri] : [])),
      ],
    };
    await trx
      .updateTable('ltiRegistrations')
      .set({ toolId: tool.id, metadata: JSON.stringify(recorded) })
      .where('id', '=', registration.id)
      .execute();
    return tool;
  });
}

export function registrationStatus(row: Pick<LtiRegistrationRow, 'status' | 'expiresAt'>): LtiRegistrationStatus {
  if (row.status === 'completed') return 'completed';
  return row.expiresAt <= now() ? 'expired' : 'pending';
}

export async function registrationState(db: DB, id: string): Promise<LtiRegistrationState | null> {
  const row = await db
    .selectFrom('ltiRegistrations')
    .leftJoin('ltiTools', 'ltiTools.id', 'ltiRegistrations.toolId')
    .select([
      'ltiRegistrations.id',
      'ltiRegistrations.status',
      'ltiRegistrations.expiresAt',
      'ltiRegistrations.toolId',
      'ltiTools.name as toolName',
    ])
    .where('ltiRegistrations.id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id, status: registrationStatus(row), expiresAt: row.expiresAt, toolId: row.toolId, toolName: row.toolName ?? null };
}

export function toToolRegistration(row: LtiRegistrationRow, startedBy: { id: string; name: string } | null): LtiToolRegistration {
  const m = parseJson<Partial<RecordedRegistration>>(row.metadata, {});
  const domains = [m.domain ?? '', ...(m.secondaryDomains ?? [])].filter(Boolean);
  const outside = new Set<string>();
  for (const url of m.urls ?? []) {
    if (!onDomains(url, domains)) {
      try {
        outside.add(new URL(url).host);
      } catch {
        // recorded URLs were checked when the tool registered
      }
    }
  }
  return {
    id: row.id,
    url: row.url,
    registeredAt: row.completedAt ?? row.createdAt,
    startedBy,
    clientName: m.clientName ?? '',
    description: m.description ?? null,
    logoUri: m.logoUri ?? null,
    clientUri: m.clientUri ?? null,
    policyUri: m.policyUri ?? null,
    tosUri: m.tosUri ?? null,
    contacts: m.contacts ?? [],
    domain: m.domain ?? '',
    secondaryDomains: m.secondaryDomains ?? [],
    requestedScopes: m.requestedScopes ?? [],
    grantedScopes: m.grantedScopes ?? [],
    requestedClaims: m.requestedClaims ?? [],
    messages: m.messages ?? [],
    outsideDomains: [...outside],
  };
}
