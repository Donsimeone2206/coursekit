/**
 * Signed unsubscribe tokens. A token names a person and, optionally, one email category, and is signed
 * with a per-site secret kept in the settings table, so links keep working across restarts and servers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EMAIL_CATEGORY_IDS, type EmailCategoryId } from '../../../shared/email.js';
import type { DB } from '../../db/types.js';
import { randomToken } from '../../lib/util.js';

const SECRET_KEY = 'email.unsubscribeSecret';
const TOKEN_RE = /^([0-9a-z]{1,40})\.([a-z]{1,20})\.([A-Za-z0-9_-]{43})$/;

export interface UnsubscribeTarget {
  userId: string;
  /** null: every email. */
  category: EmailCategoryId | null;
}

const cache = new WeakMap<DB, string>();

/** The site's signing secret, created on first use (safely, if several processes race), then cached. */
export async function emailSecret(db: DB): Promise<string> {
  const cached = cache.get(db);
  if (cached) return cached;
  const secret = await loadOrCreateSecret(db);
  cache.set(db, secret);
  return secret;
}

async function loadOrCreateSecret(db: DB): Promise<string> {
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
  const existing = await read();
  if (existing) return existing;
  await db
    .insertInto('settings')
    .values({ key: SECRET_KEY, value: JSON.stringify(randomToken(32)) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
  const created = await read();
  if (!created) throw new Error('Could not create the email signing secret.');
  return created;
}

function signature(secret: string, userId: string, scope: string): string {
  return createHmac('sha256', secret).update(`coursekit-unsubscribe\n${userId}\n${scope}`).digest('base64url');
}

export function signUnsubscribeToken(secret: string, target: UnsubscribeTarget): string {
  const scope = target.category ?? 'all';
  return `${target.userId}.${scope}.${signature(secret, target.userId, scope)}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeTarget | null {
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return null;
  const [, userId, scope, sig] = m as unknown as [string, string, string, string];
  if (scope !== 'all' && !EMAIL_CATEGORY_IDS.includes(scope as EmailCategoryId)) return null;
  const expected = Buffer.from(signature(secret, userId, scope));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { userId, category: scope === 'all' ? null : (scope as EmailCategoryId) };
}
