/**
 * Registered external tools: serialising them, validating what administrators enter, finding the
 * activities that use them, and the tools' public keys (pasted, or fetched from a JWKS URL and cached).
 */
import { createPublicKey } from 'node:crypto';
import { createLocalJWKSet, errors, importJWK, jwtVerify, type JWK, type JWTPayload, type JWTVerifyOptions } from 'jose';
import { z } from 'zod';
import type { LtiTool } from '../../../shared/lti.js';
import type { ActivityRow } from '../../db/schema.js';
import type { LtiToolRow } from '../../db/schema-lti.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';
import { num, parseJson } from '../../lib/util.js';
import { ltiCustomParamsSchema } from './settings.js';

/** Signature algorithms accepted from tools: asymmetric only (never `none` or HS*). */
export const TOOL_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384'];
/** Allowed difference between the tool's clock and ours, in seconds. */
export const CLOCK_SKEW = 60;

const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_AGE_MS = 10 * 60_000;
const JWKS_REFETCH_MS = 60_000;

const httpUrl = z.url({ protocol: /^https?$/, message: 'Enter a valid http(s) URL' }).max(2000);
const optionalUrl = z.preprocess((v) => (v === '' ? null : v), httpUrl.nullable());

export const toolInputSchema = z.object({
  name: z.string().trim().min(1, 'Add a name').max(200),
  description: z.string().trim().max(2000).default(''),
  toolUrl: httpUrl,
  loginUrl: httpUrl,
  redirectUris: z
    .array(httpUrl)
    .min(1, 'Add at least one redirect URI')
    .max(20)
    .transform((list) => [...new Set(list)]),
  keyType: z.enum(['jwks', 'key']),
  jwksUrl: optionalUrl.default(null),
  publicKey: z
    .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(20_000).nullable())
    .default(null),
  deepLinkingUrl: optionalUrl.default(null),
  customParams: ltiCustomParamsSchema.default({}),
  shareName: z.boolean().default(false),
  shareEmail: z.boolean().default(false),
  allowAgs: z.boolean().default(false),
  allowNrps: z.boolean().default(false),
  status: z.enum(['active', 'disabled']).default('active'),
});

export type ToolInput = z.output<typeof toolInputSchema>;

/** Checks the key settings and returns the public key to store (normalised JWK JSON for a JWK, PEM as given). */
export function checkToolKeys(input: Pick<ToolInput, 'keyType' | 'jwksUrl' | 'publicKey'>): {
  jwksUrl: string | null;
  publicKey: string | null;
} {
  if (input.keyType === 'jwks') {
    if (!input.jwksUrl) throw badRequest("Add the tool's JWKS URL.");
    return { jwksUrl: input.jwksUrl, publicKey: null };
  }
  if (!input.publicKey) throw badRequest("Paste the tool's public key (PEM or JWK).");
  const jwk = publicKeyToJwk(input.publicKey);
  return { jwksUrl: null, publicKey: input.publicKey.trim().startsWith('{') ? JSON.stringify(jwk) : input.publicKey.trim() };
}

/** Parses a pasted PEM or JWK public key. Private and symmetric keys are refused. */
export function publicKeyToJwk(text: string): JWK {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('{')) {
      const jwk = JSON.parse(trimmed) as JWK;
      if (jwk.d || jwk.kty === 'oct' || jwk.k) throw badRequest('That is a private or shared key. Paste the public key only.');
      const exported = createPublicKey({ key: jwk as never, format: 'jwk' }).export({ format: 'jwk' }) as JWK;
      return { ...exported, ...(jwk.kid ? { kid: jwk.kid } : {}), ...(jwk.alg ? { alg: jwk.alg } : {}) };
    }
    if (/PRIVATE KEY/.test(trimmed)) throw badRequest('That is a private key. Paste the public key only.');
    return createPublicKey(trimmed).export({ format: 'jwk' }) as JWK;
  } catch (err) {
    if (err instanceof Error && 'status' in err) throw err;
    throw badRequest('The public key could not be read. Paste a PEM ("-----BEGIN PUBLIC KEY-----") or a JWK.');
  }
}

export function toLtiTool(row: LtiToolRow, activityCount: number): LtiTool {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    toolUrl: row.toolUrl,
    loginUrl: row.loginUrl,
    redirectUris: parseJson<string[]>(row.redirectUris, []),
    keyType: row.jwksUrl ? 'jwks' : 'key',
    jwksUrl: row.jwksUrl,
    publicKey: row.publicKey,
    deepLinkingUrl: row.deepLinkingUrl,
    customParams: parseJson<Record<string, string>>(row.customParams, {}),
    shareName: !!row.shareName,
    shareEmail: !!row.shareEmail,
    allowAgs: !!row.allowAgs,
    allowNrps: !!row.allowNrps,
    status: row.status,
    clientId: row.clientId,
    deploymentId: row.deploymentId,
    activityCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toolCustomParams(tool: LtiToolRow): Record<string, string> {
  return parseJson<Record<string, string>>(tool.customParams, {});
}

export function toolRedirectUris(tool: LtiToolRow): string[] {
  return parseJson<string[]>(tool.redirectUris, []);
}

/** The tool id an External tool activity points at (without full settings parsing). */
export function activityToolId(activity: Pick<ActivityRow, 'type' | 'settings'>): string | null {
  if (activity.type !== 'lti') return null;
  const s = parseJson<{ toolId?: unknown }>(activity.settings, {});
  return typeof s.toolId === 'string' ? s.toolId : null;
}

/** External tool activities of a course that use the tool (hidden ones included). */
export async function toolActivitiesInCourse(db: DB, courseId: string, toolId: string): Promise<ActivityRow[]> {
  const rows = await db.selectFrom('activities').selectAll().where('courseId', '=', courseId).where('type', '=', 'lti').execute();
  return rows.filter((a) => activityToolId(a) === toolId);
}

/** The privacy boundary: a tool reaches a course's services only while one of its activities uses the tool. */
export async function courseUsesTool(db: DB, courseId: string, toolId: string): Promise<boolean> {
  return (await toolActivitiesInCourse(db, courseId, toolId)).length > 0;
}

/** Number of External tool activities per tool id. */
export async function toolActivityCounts(db: DB): Promise<Map<string, number>> {
  const rows = await db.selectFrom('activities').select(['type', 'settings']).where('type', '=', 'lti').execute();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = activityToolId(row);
    if (id) counts.set(id, num(counts.get(id)) + 1);
  }
  return counts;
}

// ---- tool keys -----------------------------------------------------------------------------------

interface JwksEntry {
  keys: JWK[];
  fetchedAt: number;
  pending: Promise<JWK[]> | null;
}

const jwksCaches = new WeakMap<DB, Map<string, JwksEntry>>();

async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error('The key set is too large.');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('The key set is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetches a tool's JWKS with a short timeout and a size limit. Only public signing keys are kept. */
export async function fetchJwks(url: string): Promise<JWK[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The tool's key set answered with HTTP ${res.status}.`);
  const data = JSON.parse(await readLimited(res, JWKS_MAX_BYTES)) as { keys?: unknown };
  if (!Array.isArray(data.keys)) throw new Error("The tool's key set has no keys.");
  return (data.keys as JWK[]).filter(
    (k) => k && typeof k === 'object' && !k.d && (k.kty === 'RSA' || k.kty === 'EC') && (!k.use || k.use === 'sig'),
  );
}

async function jwksKeys(db: DB, tool: LtiToolRow, forceRefresh: boolean): Promise<JWK[]> {
  const url = tool.jwksUrl!;
  let cache = jwksCaches.get(db);
  if (!cache) jwksCaches.set(db, (cache = new Map()));
  const cacheKey = `${tool.id} ${url}`;
  const entry = cache.get(cacheKey);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  // Refetch when the cache is old, or on an unknown key id, but at most about once a minute.
  const due = !entry || age > JWKS_MAX_AGE_MS || (forceRefresh && age > JWKS_REFETCH_MS);
  if (!due) return entry.keys;
  if (entry?.pending) return entry.pending;
  const next: JwksEntry = entry ?? { keys: [], fetchedAt: 0, pending: null };
  next.pending = fetchJwks(url)
    .then((keys) => {
      next.keys = keys;
      return keys;
    })
    .catch((err: unknown) => {
      if (next.keys.length) return next.keys; // keep using the keys we had
      throw err;
    })
    .finally(() => {
      next.fetchedAt = Date.now();
      next.pending = null;
    });
  cache.set(cacheKey, next);
  return next.pending;
}

/**
 * Verifies a JWT signed by the tool, with its registered keys and allowed algorithms only.
 * `options` adds the issuer, audience and other claim checks.
 */
export async function verifyToolJwt(db: DB, tool: LtiToolRow, jwt: string, options: JWTVerifyOptions): Promise<JWTPayload> {
  const verifyOptions: JWTVerifyOptions = { clockTolerance: CLOCK_SKEW, ...options, algorithms: TOOL_ALGORITHMS };
  if (!tool.jwksUrl) {
    const jwk = publicKeyToJwk(tool.publicKey ?? '');
    const { payload } = await jwtVerify(
      jwt,
      async (header) => {
        if (jwk.alg && jwk.alg !== header.alg) throw new errors.JOSEAlgNotAllowed('The token uses a different algorithm than the key.');
        return importJWK(jwk, header.alg);
      },
      verifyOptions,
    );
    return payload;
  }
  const attempt = async (refresh: boolean) => {
    const keys = await jwksKeys(db, tool, refresh);
    return (await jwtVerify(jwt, createLocalJWKSet({ keys }), verifyOptions)).payload;
  };
  try {
    return await attempt(false);
  } catch (err) {
    if (err instanceof errors.JWKSNoMatchingKey) return attempt(true);
    throw err;
  }
}
