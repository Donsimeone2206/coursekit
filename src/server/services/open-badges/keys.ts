/**
 * The issuer's signing key for Open Badges 3.0 credentials (VC-JWT, RS256). Created on first use and kept in the
 * settings table, like the email signing secret, so credentials stay verifiable across restarts and servers.
 * Only the public half ever leaves this module.
 */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import type { DB } from '../../db/types.js';
import { now } from '../../lib/util.js';

const KEY_SETTING = 'openBadges.signingKey';
export const SIGNING_ALG = 'RS256';

export interface IssuerKey {
  /** RFC 7638 thumbprint of the public key; the last segment of the published key URL. */
  id: string;
  privateKey: CryptoKey;
  /** Public parameters only (kty, n, e). */
  publicJwk: { kty: string; n: string; e: string };
  createdAt: string;
}

interface StoredKey {
  privateJwk: JWK;
  createdAt: string;
}

const cache = new WeakMap<DB, Promise<IssuerKey>>();

export function issuerKey(db: DB): Promise<IssuerKey> {
  let key = cache.get(db);
  if (!key) {
    key = loadOrCreate(db);
    cache.set(db, key);
    key.catch(() => cache.delete(db));
  }
  return key;
}

async function read(db: DB): Promise<StoredKey | null> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', KEY_SETTING).executeTakeFirst();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<StoredKey>;
    const jwk = value.privateJwk;
    if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e || !jwk.d || typeof value.createdAt !== 'string') return null;
    return { privateJwk: jwk, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

async function loadOrCreate(db: DB): Promise<IssuerKey> {
  let stored = await read(db);
  if (!stored) {
    const { privateKey } = await generateKeyPair(SIGNING_ALG, { modulusLength: 2048, extractable: true });
    const value: StoredKey = { privateJwk: await exportJWK(privateKey), createdAt: now() };
    // Several processes may race to create the key: the first insert wins and everyone reads it back.
    await db
      .insertInto('settings')
      .values({ key: KEY_SETTING, value: JSON.stringify(value) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    stored = await read(db);
    if (!stored) throw new Error('Could not create the Open Badges signing key.');
  }
  const { privateJwk } = stored;
  const publicJwk = { kty: 'RSA', n: privateJwk.n!, e: privateJwk.e! };
  const privateKey = (await importJWK({ ...privateJwk, alg: SIGNING_ALG }, SIGNING_ALG)) as CryptoKey;
  return { id: await calculateJwkThumbprint(publicJwk), privateKey, publicJwk, createdAt: stored.createdAt };
}
