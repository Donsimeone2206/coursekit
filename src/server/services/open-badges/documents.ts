/**
 * The public Open Badges documents:
 *  - Open Badges 2.0 hosted verification: issuer Profile, BadgeClass and Assertion (JSON-LD).
 *  - Open Badges 3.0: an OpenBadgeCredential (W3C Verifiable Credential 2.0) signed as a VC-JWT, the issuer Profile,
 *    the Achievement, a Bitstring Status List for revocation and the public signing key.
 */
import { gzipSync } from 'node:zlib';
import { SignJWT } from 'jose';
import type { BadgeRow } from '../../db/schema-completion.js';
import type { DB } from '../../db/types.js';
import { sha256 } from '../../lib/util.js';
import { criteriaCourseIds } from '../badges.js';
import type { Issuer } from './issuer.js';
import { SIGNING_ALG, type IssuerKey } from './keys.js';
import { revokedStatusIndexes, STATUS_LIST_SIZE, type ShareState } from './shares.js';

export const OB2_CONTEXT = 'https://w3id.org/openbadges/v2';
export const VC2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
export const OB3_CONTEXT = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json';
export const OB3_SCHEMA = 'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json';

export type OpenBadgeUrls = ReturnType<typeof openBadgeUrls>;

/** Every public URL, from the site's public base URL. */
export function openBadgeUrls(base: string) {
  const ob = `${base}/openbadges`;
  return {
    ob2Issuer: `${ob}/v2/issuer`,
    ob2Badge: (badgeId: string) => `${ob}/v2/badges/${badgeId}`,
    badgeImage: (badgeId: string) => `${ob}/v2/badges/${badgeId}/image.svg`,
    ob2Assertion: (shareId: string) => `${ob}/v2/assertions/${shareId}`,
    ob2BakedImage: (shareId: string) => `${ob}/v2/assertions/${shareId}/badge.svg`,
    ob3Issuer: `${ob}/v3/issuer`,
    ob3Achievement: (badgeId: string) => `${ob}/v3/achievements/${badgeId}`,
    ob3Credential: (shareId: string) => `${ob}/v3/credentials/${shareId}`,
    ob3BakedImage: (shareId: string) => `${ob}/v3/credentials/${shareId}/badge.svg`,
    ob3Key: (keyId: string) => `${ob}/v3/keys/${keyId}`,
    ob3Jwks: `${ob}/v3/jwks.json`,
    statusList: `${ob}/v3/status/1`,
    page: (shareId: string) => `${base}/verify-badge/${shareId}`,
  };
}

/** `sha256$<hex>` of the lower-cased email followed by the salt (Open Badges 2.0 IdentityHash / 3.0 identityHash). */
export function hashedEmail(email: string, salt: string): string {
  return `sha256$${sha256(email.trim().toLowerCase() + salt)}`;
}

/** ISO-8601 without fractional seconds, so JWT `nbf` (whole seconds) and `validFrom` say exactly the same. */
function wholeSeconds(iso: string): { iso: string; seconds: number } {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return { iso: new Date(seconds * 1000).toISOString().replace('.000Z', 'Z'), seconds };
}

export interface BadgeText {
  description: string;
  criteria: string;
}

/**
 * The badge's description (never empty: Open Badges require one) and how it is earned, in words. Only published
 * courses are named: `courseTitle` is null for a draft or archived course, and other courses are just counted.
 */
export async function badgeText(db: DB, badge: BadgeRow, courseTitle: string | null, issuerName: string): Promise<BadgeText> {
  const description =
    badge.description.trim() || (courseTitle ? `A badge from the course “${courseTitle}”.` : `A badge from ${issuerName}.`);
  let criteria: string;
  if (badge.criteria === 'completion') {
    criteria = courseTitle
      ? `Earned by completing the course “${courseTitle}” on ${issuerName}.`
      : `Earned by completing a course on ${issuerName}.`;
  } else if (badge.criteria === 'courses') {
    const ids = criteriaCourseIds(badge);
    const rows = ids.length ? await db.selectFrom('courses').select(['id', 'title', 'visibility']).where('id', 'in', ids).execute() : [];
    const courses = ids.flatMap((id) => rows.find((r) => r.id === id) ?? []);
    const titles = courses.filter((r) => r.visibility === 'published').map((r) => `“${r.title}”`);
    const others = courses.length - titles.length;
    const named = [...titles, ...(others ? [others === 1 ? '1 other course' : `${others} other courses`] : [])];
    criteria =
      titles.length === 0
        ? others > 1
          ? `Earned by completing ${others} courses on ${issuerName}.`
          : others === 1
            ? `Earned by completing a course on ${issuerName}.`
            : `Earned by completing a set of courses on ${issuerName}.`
        : named.length === 1
          ? `Earned by completing the course ${titles[0]} on ${issuerName}.`
          : `Earned by completing all of these courses on ${issuerName}: ${named.slice(0, -1).join(', ')} and ${named.at(-1)}.`;
  } else {
    criteria = courseTitle
      ? `Awarded by the teachers of the course “${courseTitle}” on ${issuerName}.`
      : badge.courseId
        ? `Awarded by the teachers of a course on ${issuerName}.`
        : `Awarded by the administrators of ${issuerName}.`;
  }
  return { description, criteria };
}

// ---- Open Badges 2.0 ---------------------------------------------------------------------------

export function ob2Issuer(urls: OpenBadgeUrls, issuer: Issuer) {
  return {
    '@context': OB2_CONTEXT,
    type: 'Issuer',
    id: urls.ob2Issuer,
    name: issuer.name,
    url: issuer.url,
    ...(issuer.email ? { email: issuer.email } : {}),
    ...(issuer.description ? { description: issuer.description } : {}),
  };
}

export function ob2BadgeClass(urls: OpenBadgeUrls, badge: BadgeRow, text: BadgeText) {
  return {
    '@context': OB2_CONTEXT,
    type: 'BadgeClass',
    id: urls.ob2Badge(badge.id),
    name: badge.name,
    description: text.description,
    image: urls.badgeImage(badge.id),
    criteria: { narrative: text.criteria },
    issuer: urls.ob2Issuer,
  };
}

/** The hosted assertion of a valid share. */
export function ob2Assertion(urls: OpenBadgeUrls, state: ShareState) {
  const { share, badge, user, award } = state;
  return {
    '@context': OB2_CONTEXT,
    type: 'Assertion',
    id: urls.ob2Assertion(share.id),
    recipient: { type: 'email', hashed: true, salt: share.salt, identity: hashedEmail(user!.email, share.salt) },
    badge: urls.ob2Badge(badge!.id),
    verification: { type: 'hosted' },
    issuedOn: award!.awardedAt,
    ...(award!.note ? { narrative: award!.note } : {}),
  };
}

/** What a revoked (or withdrawn) hosted assertion answers, with HTTP 410. */
export function ob2Revoked(urls: OpenBadgeUrls, shareId: string, reason: string) {
  return { '@context': OB2_CONTEXT, type: 'Assertion', id: urls.ob2Assertion(shareId), revoked: true, revocationReason: reason };
}

// ---- Open Badges 3.0 ---------------------------------------------------------------------------

export function ob3Profile(urls: OpenBadgeUrls, issuer: Issuer) {
  return {
    id: urls.ob3Issuer,
    type: ['Profile'],
    name: issuer.name,
    url: issuer.url,
    ...(issuer.email ? { email: issuer.email } : {}),
    ...(issuer.description ? { description: issuer.description } : {}),
  };
}

export function ob3Achievement(urls: OpenBadgeUrls, badge: BadgeRow, text: BadgeText, issuer: Issuer) {
  return {
    id: urls.ob3Achievement(badge.id),
    type: ['Achievement'],
    achievementType: 'Badge',
    name: badge.name,
    description: text.description,
    criteria: { narrative: text.criteria },
    image: { id: urls.badgeImage(badge.id), type: 'Image' },
    creator: ob3Profile(urls, issuer),
  };
}

/** The OpenBadgeCredential of a valid share (unsigned). */
export function ob3Credential(urls: OpenBadgeUrls, state: ShareState, text: BadgeText, issuer: Issuer) {
  const { share, badge, user, award } = state;
  const awarded = wholeSeconds(award!.awardedAt);
  return {
    '@context': [VC2_CONTEXT, OB3_CONTEXT],
    id: urls.ob3Credential(share.id),
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: ob3Profile(urls, issuer),
    validFrom: awarded.iso,
    awardedDate: awarded.iso,
    name: badge!.name,
    credentialSubject: {
      id: `urn:uuid:${share.subjectId}`,
      type: ['AchievementSubject'],
      identifier: [
        {
          type: 'IdentityObject',
          identityHash: hashedEmail(user!.email, share.salt),
          identityType: 'emailAddress',
          hashed: true,
          salt: share.salt,
        },
      ],
      achievement: ob3Achievement(urls, badge!, text, issuer),
    },
    ...(award!.note ? { evidence: [{ type: ['Evidence'], narrative: award!.note }] } : {}),
    credentialSchema: [{ id: OB3_SCHEMA, type: '1EdTechJsonSchemaValidator2019' }],
    credentialStatus: {
      id: `${urls.statusList}#${share.statusIndex}`,
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: String(share.statusIndex),
      statusListCredential: urls.statusList,
    },
  };
}

/** The public key as published (JWK with its URL as `kid`). */
export function publicJwk(urls: OpenBadgeUrls, key: IssuerKey) {
  return { ...key.publicJwk, kid: urls.ob3Key(key.id), alg: SIGNING_ALG, use: 'sig' };
}

/**
 * VC-JWT as Open Badges 3.0 §8.2 describes it: the credential is the JWT payload, with `iss`, `jti`, `sub` and
 * `nbf` (and `exp`, when there is a validUntil) mirroring it, and a JOSE header with alg, typ and the key (kid, jwk).
 */
async function signCredential(
  urls: OpenBadgeUrls,
  key: IssuerKey,
  credential: { id: string; validFrom: string; issuer: string | { id: string }; credentialSubject: { id: string } },
): Promise<string> {
  return new SignJWT(credential as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: SIGNING_ALG, typ: 'JWT', kid: urls.ob3Key(key.id), jwk: key.publicJwk })
    .setIssuer(typeof credential.issuer === 'string' ? credential.issuer : credential.issuer.id)
    .setJti(credential.id)
    .setSubject(credential.credentialSubject.id)
    .setNotBefore(wholeSeconds(credential.validFrom).seconds)
    .sign(key.privateKey);
}

export function signedCredential(urls: OpenBadgeUrls, key: IssuerKey, state: ShareState, text: BadgeText, issuer: Issuer) {
  return signCredential(urls, key, ob3Credential(urls, state, text, issuer));
}

/** The revocation list (Bitstring Status List v1.0, 131,072 entries) as a signed BitstringStatusListCredential. */
export async function signedStatusList(db: DB, urls: OpenBadgeUrls, key: IssuerKey): Promise<string> {
  const bits = new Uint8Array(STATUS_LIST_SIZE / 8);
  for (const index of await revokedStatusIndexes(db)) {
    // Index 0 is the left-most (most significant) bit of the first byte.
    if (index >= 0 && index < STATUS_LIST_SIZE) bits[index >> 3] = (bits[index >> 3] ?? 0) | (0x80 >> (index & 7));
  }
  const credential = {
    '@context': [VC2_CONTEXT],
    id: urls.statusList,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: urls.ob3Issuer,
    validFrom: wholeSeconds(key.createdAt).iso,
    credentialSubject: {
      id: `${urls.statusList}#list`,
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      // Multibase base64url (no padding, prefix "u") of the GZIP-compressed bitstring.
      encodedList: `u${gzipSync(bits).toString('base64url')}`,
    },
  };
  return signCredential(urls, key, credential);
}
