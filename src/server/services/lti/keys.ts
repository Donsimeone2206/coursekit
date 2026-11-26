/**
 * The platform's own secrets, kept in the settings table under `lti.` so they survive restarts and
 * are shared by every server process: the RSA key pair that signs id_tokens (published as a JWKS),
 * a secret for Coursekit's internal tokens (launch hints, deep linking data) and the platform GUID.
 * Each is created on first use; if several processes race, the first insert wins and everyone reads it.
 */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import type { DB } from '../../db/types.js';
import { newId, randomToken } from '../../lib/util.js';

const KEY_SETTING = 'lti.platformKey';
const SECRET_SETTING = 'lti.internalSecret';
const GUID_SETTING = 'lti.platformGuid';

export interface PlatformKey {
  kid: string;
  privateKey: CryptoKey;
  /** Public part only, with kid, alg and use. */
  publicJwk: JWK;
}

interface StoredKey {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  createdAt: string;
}

const keyCache = new WeakMap<DB, Promise<PlatformKey>>();
const secretCache = new WeakMap<DB, Promise<Uint8Array>>();
const guidCache = new WeakMap<DB, Promise<string>>();

/** Reads a setting, creating it with `create()` when it is missing. Values are JSON text. */
async function settingOnce<T>(db: DB, key: string, create: () => Promise<T> | T, valid: (v: unknown) => v is T): Promise<T> {
  const read = async (): Promise<T | null> => {
    const row = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(row.value);
      return valid(value) ? value : null;
    } catch {
      return null;
    }
  };
  const existing = await read();
  if (existing) return existing;
  const value = await create();
  await db
    .insertInto('settings')
    .values({ key, value: JSON.stringify(value) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
  const stored = await read();
  if (!stored) throw new Error(`Could not create the ${key} setting.`);
  return stored;
}

function cached<T>(cache: WeakMap<DB, Promise<T>>, db: DB, load: () => Promise<T>): Promise<T> {
  let promise = cache.get(db);
  if (!promise) {
    promise = load();
    promise.catch(() => cache.delete(db));
    cache.set(db, promise);
  }
  return promise;
}

async function createKey(): Promise<StoredKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { kid, privateJwk, publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' }, createdAt: new Date().toISOString() };
}

const isStoredKey = (v: unknown): v is StoredKey =>
  !!v && typeof v === 'object' && typeof (v as StoredKey).kid === 'string' && !!(v as StoredKey).privateJwk && !!(v as StoredKey).publicJwk;

/** The platform's RSA signing key (2048 bits), generated on first use. */
export function platformKey(db: DB): Promise<PlatformKey> {
  return cached(keyCache, db, async () => {
    const stored = await settingOnce(db, KEY_SETTING, createKey, isStoredKey);
    const privateKey = (await importJWK(stored.privateJwk, 'RS256')) as CryptoKey;
    const { kid, kty, n, e } = stored.publicJwk;
    return { kid: stored.kid, privateKey, publicJwk: { kty, n, e, kid: kid ?? stored.kid, alg: 'RS256', use: 'sig' } };
  });
}

const isSecret = (v: unknown): v is string => typeof v === 'string' && v.length >= 43;

/** Secret for Coursekit's internal tokens. Never shared with tools. */
export function internalSecret(db: DB): Promise<Uint8Array> {
  return cached(secretCache, db, async () => {
    const secret = await settingOnce(db, SECRET_SETTING, () => randomToken(32), isSecret);
    return new Uint8Array(Buffer.from(secret, 'base64url'));
  });
}

const isGuid = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Stable id of this platform instance (tool_platform.guid). */
export function platformGuid(db: DB): Promise<string> {
  return cached(guidCache, db, () => settingOnce(db, GUID_SETTING, () => newId(24), isGuid));
}
