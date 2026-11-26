/**
 * Signed, expiring tokens for package content and xAPI launch credentials. A token is bound to a
 * purpose, the activity, the package version, the user, the attempt and the item, and signed with an
 * HMAC secret kept in the settings table (key `packages.secret`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db/types.js';
import { randomToken } from '../lib/util.js';

const SECRET_KEY = 'packages.secret';

/** play: a learner's attempt (recorded); review: a finished attempt; preview: staff, recorded nowhere; xapi: LRS credentials. */
export type TokenPurpose = 'play' | 'review' | 'preview' | 'xapi';

export interface PackageToken {
  p: TokenPurpose;
  /** Activity id. */
  a: string;
  /** Package version id. */
  v: string;
  /** User id. */
  u: string;
  /** Attempt id ('' for previews). */
  t: string;
  /** Item id. */
  i: string;
  /** SCORM 2004: the delivery of the item this token opens (sequencing state), so older deliveries can't record. */
  n?: number;
  /** Expiry, seconds since the epoch. */
  x: number;
}

export const TOKEN_HOURS = 6;
/**
 * How long after expiry a token still records progress (run-time commits and the xAPI LRS): a page left
 * open overnight keeps saving. Opening content still needs an unexpired token.
 */
export const SESSION_GRACE_SECONDS = 7 * 24 * 3600;
const cache = new WeakMap<DB, string>();

export async function packageSecret(db: DB): Promise<string> {
  const cached = cache.get(db);
  if (cached) return cached;
  const read = async () => {
    const row = await db.selectFrom('settings').select('value').where('key', '=', SECRET_KEY).executeTakeFirst();
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(row.value);
      return typeof value === 'string' && value.length >= 32 ? value : null;
    } catch {
      return null;
    }
  };
  let secret = await read();
  if (!secret) {
    await db
      .insertInto('settings')
      .values({ key: SECRET_KEY, value: JSON.stringify(randomToken(32)) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    secret = await read();
  }
  if (!secret) throw new Error('Could not create the package signing secret.');
  cache.set(db, secret);
  return secret;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`coursekit-package\n${body}`).digest('base64url');
}

export function signToken(secret: string, payload: Omit<PackageToken, 'x'>, hours = TOKEN_HOURS): string {
  const full: PackageToken = { ...payload, x: Math.floor(Date.now() / 1000) + Math.round(hours * 3600) };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Returns the payload of a valid token that has not expired (or expired less than graceSeconds ago), or null. */
export function verifyToken(secret: string, token: string, graceSeconds = 0): PackageToken | null {
  if (token.length > 4000) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = Buffer.from(sign(secret, match[1]!));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: PackageToken;
  try {
    payload = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as PackageToken;
  } catch {
    return null;
  }
  if (!payload || typeof payload.x !== 'number' || (payload.x + graceSeconds) * 1000 < Date.now()) return null;
  if (!['play', 'review', 'preview', 'xapi'].includes(payload.p)) return null;
  for (const key of ['a', 'v', 'u', 't', 'i'] as const) if (typeof payload[key] !== 'string') return null;
  if (payload.n !== undefined && !Number.isInteger(payload.n)) return null;
  return payload;
}
