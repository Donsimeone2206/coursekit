/**
 * Signed tokens of a cmi5 session: the one-time fetch URL ("c5f.") and the LRS credentials the fetch URL hands
 * out ("c5a."). Both carry only the session id and an expiry, signed with an HMAC secret kept in the settings
 * table (key `cmi5.secret`); everything else (the user, the registration, whether the session is still open)
 * is checked against the session row on every use.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from '../../db/types.js';
import { randomToken } from '../../lib/util.js';

const SECRET_KEY = 'cmi5.secret';
export type Cmi5TokenKind = 'fetch' | 'auth';
const PREFIX: Record<Cmi5TokenKind, string> = { fetch: 'c5f', auth: 'c5a' };

interface Payload {
  /** Session id. */
  s: string;
  /** Expiry, seconds since the epoch. */
  x: number;
}

const cache = new WeakMap<DB, string>();

export async function cmi5Secret(db: DB): Promise<string> {
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
  if (!secret) throw new Error('Could not create the cmi5 signing secret.');
  cache.set(db, secret);
  return secret;
}

const sign = (secret: string, kind: Cmi5TokenKind, body: string) =>
  createHmac('sha256', secret).update(`coursekit-cmi5\n${kind}\n${body}`).digest('base64url');

export function signCmi5Token(secret: string, kind: Cmi5TokenKind, sessionId: string, seconds: number): string {
  const payload: Payload = { s: sessionId, x: Math.floor(Date.now() / 1000) + Math.round(seconds) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${PREFIX[kind]}.${body}.${sign(secret, kind, body)}`;
}

export type Cmi5TokenCheck = { ok: true; sessionId: string } | { ok: false; reason: 'invalid' | 'expired' };

/** Checks a token's signature and expiry. */
export function verifyCmi5Token(secret: string, kind: Cmi5TokenKind, token: string): Cmi5TokenCheck {
  if (token.length > 2000) return { ok: false, reason: 'invalid' };
  const match = /^(c5[fa])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || match[1] !== PREFIX[kind]) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(secret, kind, match[2]!));
  const given = Buffer.from(match[3]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(match[2]!, 'base64url').toString('utf8')) as Payload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!payload || typeof payload.s !== 'string' || typeof payload.x !== 'number') return { ok: false, reason: 'invalid' };
  if (payload.x * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, sessionId: payload.s };
}

/** Whether the password of Basic credentials is a cmi5 session credential (rather than a package token). */
export const isCmi5Credential = (password: string) => password.startsWith(`${PREFIX.auth}.`);
