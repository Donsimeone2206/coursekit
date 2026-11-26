/**
 * Coursekit's internal LTI tokens and single-use values.
 *
 * The launch hint (lti_message_hint) and the deep linking `data` value travel through the browser and
 * the tool, so they are JWTs signed with the platform's internal secret (HMAC; tools never see the
 * secret and Coursekit never accepts HMAC-signed tokens from tools). Each carries a jti that can only
 * be used once, recorded in lti_used_tokens until the token expires.
 */
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { DB } from '../../db/types.js';
import { newId, now, sha256 } from '../../lib/util.js';
import { internalSecret } from './keys.js';

const INTERNAL_ISSUER = 'coursekit-lti';
export const HINT_SECONDS = 120;
export const DATA_SECONDS = 3600;

export type HintKind = 'launch' | 'deeplink';

export interface LaunchHint {
  /** The user the launch is for (also the login_hint). */
  userId: string;
  toolId: string;
  clientId: string;
  courseId: string;
  kind: HintKind;
  /** launch: the activity; deeplink: the activity being edited, if any. */
  activityId: string | null;
  /** deeplink: where new activities go. */
  sectionId: string | null;
  target: 'iframe' | 'window';
  jti: string;
  exp: number;
}

export interface DeepLinkData {
  userId: string;
  toolId: string;
  courseId: string;
  sectionId: string | null;
  activityId: string | null;
  jti: string;
  exp: number;
}

async function sign(db: DB, purpose: string, claims: Record<string, unknown>, seconds: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: purpose })
    .setIssuer(INTERNAL_ISSUER)
    .setAudience(purpose)
    .setJti(newId(20))
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(await internalSecret(db));
}

async function verify(db: DB, purpose: string, token: string): Promise<JWTPayload | null> {
  if (!token || token.length > 4096) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, await internalSecret(db), {
      algorithms: ['HS256'],
      issuer: INTERNAL_ISSUER,
      audience: purpose,
      requiredClaims: ['jti', 'exp', 'sub'],
    });
    return protectedHeader.typ === purpose ? payload : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function signLaunchHint(db: DB, hint: Omit<LaunchHint, 'jti' | 'exp'>): Promise<string> {
  return sign(
    db,
    'lti-hint',
    {
      sub: hint.userId,
      tool: hint.toolId,
      cid: hint.clientId,
      course: hint.courseId,
      kind: hint.kind,
      act: hint.activityId,
      sec: hint.sectionId,
      target: hint.target,
    },
    HINT_SECONDS,
  );
}

/** Checks the signature and expiry. Single use is enforced separately with `useOnce`. */
export async function verifyLaunchHint(db: DB, token: string): Promise<LaunchHint | null> {
  const p = await verify(db, 'lti-hint', token);
  if (!p) return null;
  const userId = str(p.sub);
  const toolId = str(p.tool);
  const clientId = str(p.cid);
  const courseId = str(p.course);
  const kind = p.kind === 'launch' || p.kind === 'deeplink' ? p.kind : null;
  if (!userId || !toolId || !clientId || !courseId || !kind) return null;
  return {
    userId,
    toolId,
    clientId,
    courseId,
    kind,
    activityId: str(p.act),
    sectionId: str(p.sec),
    target: p.target === 'iframe' ? 'iframe' : 'window',
    jti: p.jti!,
    exp: p.exp!,
  };
}

export async function signDeepLinkData(db: DB, data: Omit<DeepLinkData, 'jti' | 'exp'>): Promise<string> {
  return sign(
    db,
    'lti-dl-data',
    { sub: data.userId, tool: data.toolId, course: data.courseId, sec: data.sectionId, act: data.activityId },
    DATA_SECONDS,
  );
}

export async function verifyDeepLinkData(db: DB, token: string): Promise<DeepLinkData | null> {
  const p = await verify(db, 'lti-dl-data', token);
  if (!p) return null;
  const userId = str(p.sub);
  const toolId = str(p.tool);
  const courseId = str(p.course);
  if (!userId || !toolId || !courseId) return null;
  return { userId, toolId, courseId, sectionId: str(p.sec), activityId: str(p.act), jti: p.jti!, exp: p.exp! };
}

const lastCleanup = new WeakMap<DB, number>();

/** Deletes expired single-use values and access tokens, at most every ten minutes. */
async function cleanup(db: DB): Promise<void> {
  const last = lastCleanup.get(db) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  lastCleanup.set(db, Date.now());
  const ts = now();
  await db.deleteFrom('ltiUsedTokens').where('expiresAt', '<', ts).execute();
  await db.deleteFrom('ltiAccessTokens').where('expiresAt', '<', ts).execute();
}

/**
 * Records a single-use value (a hint or data jti, a nonce, a client assertion jti) until `expSeconds`
 * (a Unix time). Returns false when it was already used.
 */
export async function useOnce(db: DB, key: string, expSeconds: number): Promise<boolean> {
  await cleanup(db);
  const expiresAt = new Date((expSeconds + 120) * 1000).toISOString();
  const result = await db
    .insertInto('ltiUsedTokens')
    .values({ key: key.length > 200 ? `sha256:${sha256(key)}` : key, expiresAt })
    .onConflict((oc) => oc.column('key').doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}
