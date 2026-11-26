import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { sha256 } from '../src/server/lib/util.js';
import { del } from './completion-helpers.js';
import { client, createTestLms, login, PASSWORD, setupSchool } from './helpers.js';

const BASE = 'https://learn.example.org';

async function createPublicLms(): Promise<Coursekit> {
  return createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
    webDir: false,
    publicUrl: BASE,
  });
}

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let badgeId: string;
let samId: string;

/** GET a public document by its absolute URL, the way a backpack or verifier would (no cookie). */
async function fetchPublic(url: string, headers: Record<string, string> = {}) {
  const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
  const res = await lms.app.request(path, { headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function share(as = school.sam, id = badgeId) {
  const res = await as.post(`/api/badges/${id}/share`);
  expect(res.status).toBe(200);
  return res.body.share as { id: string; links: Record<string, string> };
}

async function jwks(): Promise<JSONWebKeySet> {
  return (await fetchPublic(`${BASE}/openbadges/v3/jwks.json`)).json;
}

/** The revocation bit of a status list slot, read the way a verifier does. */
async function revokedBit(index: number): Promise<number> {
  const res = await fetchPublic(`${BASE}/openbadges/v3/status/1`);
  expect(res.status).toBe(200);
  const { payload } = await jwtVerify(res.text, createLocalJWKSet(await jwks()));
  const encoded = (payload.credentialSubject as { encodedList: string }).encodedList;
  expect(encoded.startsWith('u')).toBe(true);
  const bits = gunzipSync(Buffer.from(encoded.slice(1), 'base64url'));
  expect(bits.length * 8).toBeGreaterThanOrEqual(131_072);
  return (bits[index >> 3]! >> (7 - (index & 7))) & 1;
}

async function statusIndexOf(shareId: string): Promise<number> {
  return (await lms.db.selectFrom('openBadgeShares').select('statusIndex').where('id', '=', shareId).executeTakeFirstOrThrow()).statusIndex;
}

async function credentialOf(shareId: string) {
  const res = await fetchPublic(`${BASE}/openbadges/v3/credentials/${shareId}`);
  expect(res.status).toBe(200);
  return res.text;
}

function parseSvg(text: string) {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, msg) => void (level !== 'warning' && errors.push(msg)) }).parseFromString(
    text,
    'image/svg+xml',
  );
  expect(errors).toEqual([]);
  return doc;
}

beforeEach(async () => {
  lms = await createPublicLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
  const people = await school.teacher.get(`/api/courses/${school.course.id}/participants`);
  samId = people.body.find((p: { user: { email: string } }) => p.user.email === 'sam@test.dev').user.id;
  const created = await school.teacher.post(`/api/courses/${school.course.id}/badges`, {
    name: 'Bug hunter',
    description: 'Found a real bug',
    icon: 'target',
    color: 'emerald',
  });
  badgeId = created.body.id;
  await school.teacher.post(`/api/badges/${badgeId}/awards`, { userIds: [samId], note: 'Great catch!' });
});
afterEach(async () => {
  await lms.close();
});

describe('sharing', () => {
  it('publishes nothing until the recipient shares, and only they can share', async () => {
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}`)).status).toBe(404);
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}/image.svg`)).status).toBe(404);
    expect((await fetchPublic(`${BASE}/openbadges/v3/achievements/${badgeId}`)).status).toBe(404);
    expect((await school.sam.get(`/api/badges/${badgeId}/share`)).body).toEqual({ earned: true, unavailableReason: null, share: null });
    expect((await school.sam.get('/api/me/badge-shares')).body).toEqual([]);

    // Nobody can share someone else's award: not another student, not the teacher who awarded it.
    expect((await school.kim.post(`/api/badges/${badgeId}/share`)).status).toBe(403);
    expect((await school.teacher.post(`/api/badges/${badgeId}/share`)).status).toBe(403);
    expect((await client(lms).post(`/api/badges/${badgeId}/share`)).status).toBe(401);
    expect((await school.sam.post('/api/badges/nope!/share')).status).toBe(403);

    const shared = await share();
    expect(shared.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(shared.links.assertion).toBe(`${BASE}/openbadges/v2/assertions/${shared.id}`);
    expect(shared.links.page).toBe(`${BASE}/verify-badge/${shared.id}`);
    // Sharing again keeps the same public id.
    expect((await share()).id).toBe(shared.id);

    // Others see no share of Sam's award.
    expect((await school.kim.get(`/api/badges/${badgeId}/share`)).body).toMatchObject({ earned: false, share: null });
    expect((await school.teacher.get(`/api/badges/${badgeId}/share`)).body).toMatchObject({ earned: false, share: null });
    expect((await school.kim.get('/api/me/badge-shares')).body).toEqual([]);
    expect((await school.sam.get('/api/me/badge-shares')).body).toEqual([{ badgeId, share: expect.objectContaining({ id: shared.id }) }]);

    // A shared badge's verification page shows the name; a made-up id shows nothing.
    const page = await client(lms).get(`/api/open-badges/shares/${shared.id}`);
    expect(page.body).toMatchObject({ status: 'valid', recipientName: 'Sam Student', note: 'Great catch!', badge: { name: 'Bug hunter' } });
    expect((await client(lms).get('/api/open-badges/shares/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await client(lms).get('/api/open-badges/shares/not-a-share')).status).toBe(404);
  });

  it('is not offered to someone signed in as the recipient by an administrator', async () => {
    const res = await lms.app.request(`/api/admin/users/${samId}/impersonate`, {
      method: 'POST',
      headers: { cookie: school.admin.cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const asSam = client(lms, res.headers.get('set-cookie')!.split(';')[0]!);
    expect((await asSam.post(`/api/badges/${badgeId}/share`)).status).toBe(403);
  });

  it('creates a single share when the recipient shares several times at once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => school.sam.post(`/api/badges/${badgeId}/share`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.share.id)).size).toBe(1);
    const live = await lms.db
      .selectFrom('openBadgeShares')
      .select('id')
      .where('badgeId', '=', badgeId)
      .where('withdrawnAt', 'is', null)
      .execute();
    expect(live).toEqual([{ id: results[0]!.body.share.id }]);
  });
});

describe('Open Badges 2.0', () => {
  it('serves the issuer, badge class and hosted assertion with a salted email hash', async () => {
    const shared = await share();
    const assertion = await fetchPublic(shared.links.assertion);
    expect(assertion.status).toBe(200);
    expect(assertion.headers.get('access-control-allow-origin')).toBe('*');
    expect(assertion.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const salt: string = assertion.json.recipient.salt;
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(assertion.json).toEqual({
      '@context': 'https://w3id.org/openbadges/v2',
      type: 'Assertion',
      id: shared.links.assertion,
      recipient: { type: 'email', hashed: true, salt, identity: `sha256$${sha256(`sam@test.dev${salt}`)}` },
      badge: `${BASE}/openbadges/v2/badges/${badgeId}`,
      verification: { type: 'hosted' },
      issuedOn: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      narrative: 'Great catch!',
    });
    expect(JSON.stringify(assertion.json)).not.toContain('sam@test.dev');

    const badgeClass = await fetchPublic(assertion.json.badge);
    expect(badgeClass.json).toEqual({
      '@context': 'https://w3id.org/openbadges/v2',
      type: 'BadgeClass',
      id: `${BASE}/openbadges/v2/badges/${badgeId}`,
      name: 'Bug hunter',
      description: 'Found a real bug',
      image: `${BASE}/openbadges/v2/badges/${badgeId}/image.svg`,
      criteria: { narrative: 'Awarded by the teachers of the course “Testing 101” on Coursekit.' },
      issuer: `${BASE}/openbadges/v2/issuer`,
    });
    const issuer = await fetchPublic(badgeClass.json.issuer);
    expect(issuer.json).toEqual({
      '@context': 'https://w3id.org/openbadges/v2',
      type: 'Issuer',
      id: `${BASE}/openbadges/v2/issuer`,
      name: 'Coursekit',
      url: BASE,
    });
    const image = await fetchPublic(badgeClass.json.image);
    expect(image.headers.get('content-type')).toContain('image/svg+xml');
    expect(image.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(parseSvg(image.text).documentElement!.getElementsByTagName('svg')).toHaveLength(1); // the icon

    // A browser following the link lands on the verification page.
    const browser = await fetchPublic(shared.links.assertion, { accept: 'text/html,application/xhtml+xml' });
    expect(browser.status).toBe(303);
    expect(browser.headers.get('location')).toBe(shared.links.page);
  });

  it('tells caches that the assertion URL answers according to the Accept header', async () => {
    const shared = await share();
    expect((await fetchPublic(shared.links.assertion)).headers.get('vary')).toMatch(/\bAccept\b/);
    expect((await fetchPublic(shared.links.assertion, { accept: 'text/html' })).headers.get('vary')).toMatch(/\bAccept\b/);
    await del(lms, school.sam, `/api/badges/${badgeId}/share`);
    const withdrawn = await fetchPublic(shared.links.assertion);
    expect(withdrawn.status).toBe(410);
    expect(withdrawn.headers.get('vary')).toMatch(/\bAccept\b/);
  });

  it('bakes the assertion into the badge image', async () => {
    const shared = await share();
    const baked = await fetchPublic(`${shared.links.badgeImage}?download`);
    expect(baked.status).toBe(200);
    expect(baked.headers.get('content-disposition')).toBe('attachment; filename="bug-hunter-open-badge-2.svg"');
    const doc = parseSvg(baked.text);
    const elements = doc.getElementsByTagNameNS('http://openbadges.org', 'assertion');
    expect(elements).toHaveLength(1);
    expect(elements[0]!.getAttribute('verify')).toBe(shared.links.assertion);
    const embedded = JSON.parse(elements[0]!.textContent!);
    expect(embedded).toEqual((await fetchPublic(shared.links.assertion)).json);
  });

  it('keeps a note with markup safe inside the baked image', async () => {
    const created = await school.teacher.post(`/api/courses/${school.course.id}/badges`, { name: 'Tricky <b>' });
    await school.teacher.post(`/api/badges/${created.body.id}/awards`, { userIds: [samId], note: ']]><script>alert(1)</script>' });
    const shared = await share(school.sam, created.body.id);
    const doc = parseSvg((await fetchPublic(shared.links.badgeImage)).text);
    expect(doc.getElementsByTagName('script')).toHaveLength(0);
    const element = doc.getElementsByTagNameNS('http://openbadges.org', 'assertion')[0]!;
    expect(JSON.parse(element.textContent!).narrative).toBe(']]><script>alert(1)</script>');
  });

  it('keeps the images well-formed XML when names and notes hold characters XML can’t carry', async () => {
    // A vertical tab (pasted from a word processor) in the name, a noncharacter in the note: XML 1.0 forbids both.
    const created = await school.teacher.post(`/api/courses/${school.course.id}/badges`, { name: 'Line\u000bbreak' });
    await school.teacher.post(`/api/badges/${created.body.id}/awards`, { userIds: [samId], note: 'Odd \uffff note' });
    const shared = await share(school.sam, created.body.id);
    const notXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
    for (const url of [
      `${BASE}/openbadges/v2/badges/${created.body.id}/image.svg`,
      shared.links.badgeImage,
      shared.links.credentialImage,
    ]) {
      const res = await fetchPublic(url);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(notXml);
      parseSvg(res.text);
    }
    const doc = parseSvg((await fetchPublic(shared.links.badgeImage)).text);
    const element = doc.getElementsByTagNameNS('http://openbadges.org', 'assertion')[0]!;
    expect(JSON.parse(element.textContent!).narrative).toBe('Odd \uffff note');
  });
});

describe('Open Badges 3.0', () => {
  it('issues an OpenBadgeCredential as a VC-JWT that verifies against the published key', async () => {
    const shared = await share();
    const jwt = await credentialOf(shared.id);
    const header = decodeProtectedHeader(jwt);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(header.jwk).not.toHaveProperty('d');
    // The kid is a URL that dereferences to the public key, which is also in the JWKS.
    const key = await fetchPublic(header.kid!);
    expect(key.status).toBe(200);
    expect(key.json).not.toHaveProperty('d');
    expect((await jwks()).keys).toEqual([key.json]);

    const { payload } = await jwtVerify(jwt, createLocalJWKSet(await jwks()), { issuer: `${BASE}/openbadges/v3/issuer` });
    const credential = payload as any;
    expect(credential['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
    ]);
    expect(credential.type).toEqual(['VerifiableCredential', 'OpenBadgeCredential']);
    expect(credential.id).toBe(`${BASE}/openbadges/v3/credentials/${shared.id}`);
    expect(credential.jti).toBe(credential.id);
    expect(credential.iss).toBe(credential.issuer.id);
    expect(credential.sub).toBe(credential.credentialSubject.id);
    expect(credential.nbf).toBe(Date.parse(credential.validFrom) / 1000);
    expect(credential.issuer).toEqual({ id: `${BASE}/openbadges/v3/issuer`, type: ['Profile'], name: 'Coursekit', url: BASE });
    const identity = credential.credentialSubject.identifier[0];
    expect(identity).toEqual({
      type: 'IdentityObject',
      identityHash: `sha256$${sha256(`sam@test.dev${identity.salt}`)}`,
      identityType: 'emailAddress',
      hashed: true,
      salt: identity.salt,
    });
    expect(credential.credentialSubject.achievement).toMatchObject({
      id: `${BASE}/openbadges/v3/achievements/${badgeId}`,
      type: ['Achievement'],
      name: 'Bug hunter',
      description: 'Found a real bug',
      criteria: { narrative: expect.stringContaining('Testing 101') },
      image: { id: `${BASE}/openbadges/v2/badges/${badgeId}/image.svg`, type: 'Image' },
    });
    expect(credential.credentialStatus).toMatchObject({
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListCredential: `${BASE}/openbadges/v3/status/1`,
    });
    expect(JSON.stringify(credential)).not.toContain('sam@test.dev');
    expect((await fetchPublic(credential.credentialSubject.achievement.id)).json).toMatchObject({ name: 'Bug hunter' });
    expect((await fetchPublic(credential.issuer.id)).json).toMatchObject({ type: ['Profile'], name: 'Coursekit' });
    expect(await revokedBit(Number(credential.credentialStatus.statusListIndex))).toBe(0);

    // A tampered credential, or one signed with another key, does not verify.
    const [h, p, s] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ ...credential, name: 'Something else' })).toString('base64url');
    await expect(jwtVerify(`${h}.${forged}.${s}`, createLocalJWKSet(await jwks()))).rejects.toThrow();
    expect(p).toBeTruthy();
    const other = await generateKeyPair('RS256', { extractable: true });
    const impostor = await new SignJWT(credential)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: header.kid!, jwk: await exportJWK(other.publicKey) })
      .sign(other.privateKey);
    await expect(jwtVerify(impostor, createLocalJWKSet(await jwks()))).rejects.toThrow();
  });

  it('bakes the credential into the badge image', async () => {
    const shared = await share();
    const doc = parseSvg((await fetchPublic(shared.links.credentialImage)).text);
    const elements = doc.getElementsByTagNameNS('https://purl.imsglobal.org/ob/v3p0', 'credential');
    expect(elements).toHaveLength(1);
    const jwt = elements[0]!.getAttribute('verify')!;
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(await jwks()));
    expect(payload.jti).toBe(`${BASE}/openbadges/v3/credentials/${shared.id}`);
  });
});

describe('revocation', () => {
  it('follows the award: revoked, restored, withdrawn, badge and account deleted', async () => {
    const first = await share();
    const index = Number(
      ((await jwtVerify(await credentialOf(first.id), createLocalJWKSet(await jwks()))).payload as any).credentialStatus.statusListIndex,
    );

    // Revoked by the teacher.
    expect((await del(lms, school.teacher, `/api/badges/${badgeId}/awards/${samId}`)).status).toBe(200);
    let assertion = await fetchPublic(first.links.assertion);
    expect(assertion.status).toBe(410);
    expect(assertion.json).toMatchObject({
      id: first.links.assertion,
      revoked: true,
      revocationReason: 'This badge was revoked by the issuer.',
    });
    expect((await fetchPublic(first.links.credential)).status).toBe(410);
    expect((await fetchPublic(first.links.badgeImage)).status).toBe(410);
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}`)).status).toBe(404);
    expect(await revokedBit(index)).toBe(1);
    const page = await client(lms).get(`/api/open-badges/shares/${first.id}`);
    expect(page.body).toMatchObject({ status: 'revoked', recipientName: null, badge: null, note: null });
    expect((await school.sam.post(`/api/badges/${badgeId}/share`)).status).toBe(403);

    // Restored: revocation is permanent. The old share stays revoked and the badge is no longer shared.
    await school.teacher.post(`/api/badges/${badgeId}/awards`, { userIds: [samId], note: 'Restored after review' });
    assertion = await fetchPublic(first.links.assertion);
    expect(assertion.status).toBe(410);
    expect(assertion.json.revocationReason).toBe('This badge was revoked by the issuer.');
    expect((await fetchPublic(first.links.credential)).status).toBe(410);
    expect((await fetchPublic(first.links.badgeImage)).status).toBe(410);
    expect(await revokedBit(index)).toBe(1);
    expect((await client(lms).get(`/api/open-badges/shares/${first.id}`)).body).toMatchObject({ status: 'revoked', note: null });
    expect((await school.sam.get(`/api/badges/${badgeId}/share`)).body).toMatchObject({ earned: true, share: null });
    expect((await school.sam.get('/api/me/badge-shares')).body).toEqual([]);
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}`)).status).toBe(404);
    expect((await school.admin.get('/api/admin/open-badges')).body.activeShares).toBe(0);

    // Sharing it again creates a new share and credential, with the restored award's details.
    const second = await share();
    expect(second.id).not.toBe(first.id);
    const restored = await fetchPublic(second.links.assertion);
    expect(restored.status).toBe(200);
    expect(restored.json.narrative).toBe('Restored after review');
    const secondIndex = await statusIndexOf(second.id);
    expect(await revokedBit(secondIndex)).toBe(0);
    expect(await revokedBit(index)).toBe(1);
    expect((await fetchPublic(first.links.assertion)).status).toBe(410);

    // The recipient stops sharing; sharing again creates a new public id, and the old ones stay revoked.
    const stopped = await del(lms, school.sam, `/api/badges/${badgeId}/share`);
    expect(stopped.body).toMatchObject({ earned: true, share: null });
    assertion = await fetchPublic(second.links.assertion);
    expect(assertion.status).toBe(410);
    expect(assertion.json.revocationReason).toBe('The recipient stopped sharing this badge.');
    expect((await fetchPublic(first.links.assertion)).json.revocationReason).toBe('This badge was revoked by the issuer.');
    expect(await revokedBit(secondIndex)).toBe(1);
    const third = await share();
    expect(third.id).not.toBe(second.id);
    expect((await fetchPublic(second.links.assertion)).status).toBe(410);
    expect((await fetchPublic(third.links.assertion)).status).toBe(200);

    // The badge is deleted.
    expect((await del(lms, school.teacher, `/api/badges/${badgeId}`)).status).toBe(200);
    assertion = await fetchPublic(third.links.assertion);
    expect(assertion.status).toBe(410);
    expect(assertion.json.revocationReason).toBe('This badge no longer exists.');
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}`)).status).toBe(404);
    expect(await revokedBit(await statusIndexOf(third.id))).toBe(1);
  });

  it('revokes the shares of a deleted account', async () => {
    const shared = await share();
    expect((await del(lms, school.admin, `/api/admin/users/${samId}`)).status).toBe(200);
    const assertion = await fetchPublic(shared.links.assertion);
    expect(assertion.status).toBe(410);
    expect(assertion.json.revocationReason).toBe('The recipient’s account no longer exists.');
    const row = await lms.db.selectFrom('openBadgeShares').selectAll().where('id', '=', shared.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ userId: null, badgeId });
    expect(await revokedBit(row.statusIndex)).toBe(1);
  });
});

describe('issuer settings', () => {
  it('are for administrators and appear in the issuer profiles', async () => {
    expect((await school.teacher.get('/api/admin/open-badges')).status).toBe(403);
    expect((await school.teacher.put('/api/admin/open-badges', { name: 'Mine', email: '', description: '' })).status).toBe(403);
    const info = await school.admin.get('/api/admin/open-badges');
    expect(info.body).toEqual({
      settings: { name: '', email: '', description: '' },
      defaults: { name: 'Coursekit', email: null },
      publicUrl: BASE,
      issuerUrl: `${BASE}/openbadges/v2/issuer`,
      activeShares: 0,
    });
    expect((await school.admin.put('/api/admin/open-badges', { name: 'Acme', email: 'not an email', description: '' })).status).toBe(400);
    const saved = await school.admin.put('/api/admin/open-badges', {
      name: ' Acme Academy ',
      email: 'badges@acme.example',
      description: 'Courses for curious people.',
    });
    expect(saved.body.settings).toEqual({ name: 'Acme Academy', email: 'badges@acme.example', description: 'Courses for curious people.' });
    expect((await fetchPublic(`${BASE}/openbadges/v2/issuer`)).json).toMatchObject({
      name: 'Acme Academy',
      email: 'badges@acme.example',
      description: 'Courses for curious people.',
      url: BASE,
    });
    expect((await fetchPublic(`${BASE}/openbadges/v3/issuer`)).json).toMatchObject({ type: ['Profile'], name: 'Acme Academy' });
  });
});

describe('issuer email', () => {
  it('publishes the outgoing email address as the contact until an administrator sets one (Open Badges 2.0 requires one)', async () => {
    const withEmail = await createCoursekit({
      databaseUrl: 'sqlite::memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
      webDir: false,
      publicUrl: BASE,
      email: { transport: 'none', worker: false, from: 'Coursekit <hello@learn.example.org>' },
    });
    try {
      await withEmail.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
      const admin = await login(withEmail, 'admin@test.dev');
      // The admin card shows this address as the published default.
      expect((await admin.get('/api/admin/open-badges')).body.defaults).toEqual({ name: 'Coursekit', email: 'hello@learn.example.org' });
      const issuer = async () => JSON.parse(await (await withEmail.app.request('/openbadges/v2/issuer')).text());
      expect((await issuer()).email).toBe('hello@learn.example.org');
      await admin.put('/api/admin/open-badges', { name: '', email: 'badges@acme.example', description: '' });
      expect((await issuer()).email).toBe('badges@acme.example');
      expect(JSON.stringify(await issuer())).not.toContain('hello@learn.example.org');
    } finally {
      await withEmail.close();
    }
  });
});

describe('course titles', () => {
  it('are public only for published courses', async () => {
    const draft = (await school.teacher.post('/api/courses', { title: 'Secret plans', visibility: 'draft' })).body;
    const archived = (await school.teacher.post('/api/courses', { title: 'Old stuff', visibility: 'archived' })).body;
    const created = await school.admin.post('/api/badges', {
      name: 'Triple',
      criteria: 'courses',
      courseIds: [school.course.id, draft.id, archived.id],
    });
    expect(created.status).toBe(201);
    await school.admin.post(`/api/badges/${created.body.id}/awards`, { userIds: [samId] });
    const shared = await share(school.sam, created.body.id);
    const badgeClass = (await fetchPublic(`${BASE}/openbadges/v2/badges/${created.body.id}`)).json;
    expect(badgeClass.criteria.narrative).toBe(
      'Earned by completing all of these courses on Coursekit: “Testing 101” and 2 other courses.',
    );
    const page = (await client(lms).get(`/api/open-badges/shares/${shared.id}`)).body;
    expect(page.badge.criteria).toBe(badgeClass.criteria.narrative);
    const credential = (await jwtVerify(await credentialOf(shared.id), createLocalJWKSet(await jwks()))).payload;
    const achievement = (await fetchPublic(`${BASE}/openbadges/v3/achievements/${created.body.id}`)).json;
    const everything = JSON.stringify([badgeClass, page, credential, achievement]);
    expect(everything).not.toContain('Secret plans');
    expect(everything).not.toContain('Old stuff');

    // The badge's own course goes back to draft: its title is no longer published either.
    const own = await share();
    expect((await school.teacher.patch(`/api/courses/${school.course.id}`, { visibility: 'draft' })).status).toBe(200);
    const ownClass = (await fetchPublic(`${BASE}/openbadges/v2/badges/${badgeId}`)).json;
    expect(ownClass.criteria.narrative).toBe('Awarded by the teachers of a course on Coursekit.');
    const ownPage = (await client(lms).get(`/api/open-badges/shares/${own.id}`)).body;
    expect(ownPage.badge).toMatchObject({ course: null, criteria: ownClass.criteria.narrative });
    const ownCredential = (await jwtVerify(await credentialOf(own.id), createLocalJWKSet(await jwks()))).payload;
    expect(JSON.stringify([ownClass, ownPage, ownCredential, (await fetchPublic(shared.links.assertion)).json])).not.toContain(
      'Testing 101',
    );
    expect((await fetchPublic(`${BASE}/openbadges/v2/badges/${created.body.id}`)).json.criteria.narrative).toBe(
      'Earned by completing 3 courses on Coursekit.',
    );
  });
});

describe('without a public URL', () => {
  it('sharing is unavailable and nothing is published', async () => {
    const plain = await createTestLms();
    try {
      await plain.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
      await plain.createUser({ name: 'Sam Student', email: 'sam@test.dev', password: PASSWORD });
      const admin = await login(plain, 'admin@test.dev');
      const sam = await login(plain, 'sam@test.dev');
      const badge = (await admin.post('/api/badges', { name: 'Helper' })).body;
      const samUserId = (await sam.get('/api/auth/session')).body.user.id;
      await admin.post(`/api/badges/${badge.id}/awards`, { userIds: [samUserId] });
      const status = await sam.get(`/api/badges/${badge.id}/share`);
      expect(status.body).toMatchObject({ earned: true, share: null, unavailableReason: expect.stringContaining('COURSEKIT_PUBLIC_URL') });
      const res = await sam.post(`/api/badges/${badge.id}/share`);
      expect(res.status).toBe(409);
      expect((await plain.app.request('/openbadges/v2/issuer')).status).toBe(404);
      expect((await plain.app.request('/openbadges/v3/status/1')).status).toBe(404);
      expect((await admin.get('/api/admin/open-badges')).body).toMatchObject({ publicUrl: null, issuerUrl: null });
    } finally {
      await plain.close();
    }
  });
});

it('upgrades a 0.2.0 database to Open Badges sharing without touching its badges', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    const upTo006 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= '006_grade_categories'));
    const v02 = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => upTo006 } });
    expect((await v02.migrateToLatest()).error).toBeUndefined();
    const ts = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u1',
        email: 'old@test.dev',
        name: 'Old Timer',
        passwordHash: null,
        role: 'student',
        avatarUrl: null,
        bio: null,
        status: 'active',
        lastLoginAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db
      .insertInto('badges')
      .values({
        id: 'b1',
        courseId: null,
        name: 'Pioneer',
        description: '',
        icon: 'rocket',
        color: 'sky',
        criteria: 'manual',
        criteriaCourseIds: '[]',
        createdBy: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db
      .insertInto('badgeAwards')
      .values({ badgeId: 'b1', userId: 'u1', awardedAt: ts, awardedBy: null, note: null, revokedAt: null, revokedBy: null })
      .execute();

    const results = await migrateToLatest(db);
    expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['011_open_badges', 'Success']);
    expect(results.every((r) => r.status === 'Success')).toBe(true);
    expect(await db.selectFrom('badgeAwards').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('openBadgeShares').selectAll().execute()).toEqual([]);

    // Deleting a badge keeps its shares as revoked tombstones.
    await db
      .insertInto('openBadgeShares')
      .values({
        id: 's1',
        badgeId: 'b1',
        userId: 'u1',
        awardedAt: ts,
        salt: 'x',
        subjectId: 'y',
        statusIndex: 7,
        createdAt: ts,
        withdrawnAt: null,
      })
      .execute();
    await db.deleteFrom('badges').where('id', '=', 'b1').execute();
    expect(await db.selectFrom('openBadgeShares').selectAll().executeTakeFirst()).toMatchObject({ id: 's1', badgeId: null, userId: 'u1' });
    expect(await migrateToLatest(db)).toEqual([]);
  } finally {
    await db.destroy();
  }
});

it('demo: Alex has shared one badge', async () => {
  const demo = await createPublicLms();
  try {
    await demo.seedDemo({ password: 'demo-password' });
    const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
    const shares = (await alex.get('/api/me/badge-shares')).body;
    expect(shares).toHaveLength(1);
    const res = await demo.app.request(new URL(shares[0].share.links.assertion).pathname);
    expect(res.status).toBe(200);
    const page = await client(demo).get(`/api/open-badges/shares/${shares[0].share.id}`);
    expect(page.body).toMatchObject({ status: 'valid', recipientName: 'Alex Johnson', badge: { name: 'Landing page pro' } });
  } finally {
    await demo.close();
  }
});
