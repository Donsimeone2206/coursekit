import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { createCmi5Activity, launchAu, type AuSim } from './cmi5-helpers.js';
import { del } from './completion-helpers.js';
import { freshDatabase } from './email-helpers.js';
import { setupSchool } from './helpers.js';

/**
 * State and profile documents of the LRS, on SQLite, and on PostgreSQL when COURSEKIT_TEST_POSTGRES_URL is set
 * (PostgreSQL limits the size of the documents' unique index entries).
 */
let lms: Coursekit;
let drop: () => Promise<void>;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  const database = await freshDatabase();
  drop = database.drop;
  lms = await createCoursekit({ databaseUrl: database.url, dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')), webDir: false });
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
  await drop();
});

const userId = async (email: string) =>
  (await lms.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
/** A learner's documents as kind:docId, with their ETags, in code point order (not the database's collation). */
const documentsOf = async (ownerId: string) =>
  (await lms.db.selectFrom('xapiDocuments').select(['kind', 'docId', 'etag']).where('ownerId', '=', ownerId).execute())
    .map((d) => ({ key: `${d.kind}:${d.docId}`, etag: d.etag }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** An IRI of `bytes` random (incompressible) ASCII bytes. */
const iri = (bytes: number) => {
  const prefix = 'https://example.test/';
  return (
    prefix +
    randomBytes(bytes)
      .toString('base64url')
      .slice(0, bytes - prefix.length)
  );
};
/** `bytes` UTF-8 bytes of random CJK characters (3 bytes each), topped up with ASCII. */
const cjk = (bytes: number) =>
  Array.from(randomBytes(Math.floor(bytes / 3)), (b) => String.fromCodePoint(0x4e00 + b * 37)).join('') + 'x'.repeat(bytes % 3);

const statePath = (au: AuSim, stateId: string, activityId: string) =>
  `activities/state?stateId=${encodeURIComponent(stateId)}&activityId=${encodeURIComponent(activityId)}&agent=${encodeURIComponent(JSON.stringify(au.actor))}&registration=${au.registration}`;
const profilePath = (profileId: string, activityId: string) =>
  `activities/profile?profileId=${encodeURIComponent(profileId)}&activityId=${encodeURIComponent(activityId)}`;

describe('LRS documents', () => {
  it("deletes a learner's documents with the learner, and only theirs", async () => {
    const { activityId } = await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId);
    const { au: samAu } = await launchAu(lms, school.sam, activityId);
    await launchAu(lms, school.kim, activityId);
    expect((await samAu.call('PUT', samAu.stateUrl('bookmark'), { page: 2 })).status).toBe(204);
    expect((await samAu.call('PUT', profilePath('notes', samAu.activityId), { a: 1 }, { 'if-none-match': '*' })).status).toBe(204);

    const sam = await userId('sam@test.dev');
    const kim = await userId('kim@test.dev');
    expect((await documentsOf(sam)).map((d) => d.key)).toEqual([
      'activity_profile:notes',
      'agent_profile:cmi5LearnerPreferences',
      'state:LMS.LaunchData',
      'state:bookmark',
    ]);
    const kims = await documentsOf(kim);
    expect(kims.map((d) => d.key)).toEqual(['agent_profile:cmi5LearnerPreferences', 'state:LMS.LaunchData']);

    expect((await del(lms, school.admin, '/api/admin/users/no-such-user')).status).toBe(404);
    expect((await del(lms, school.admin, `/api/admin/users/${sam}`)).status).toBe(200);
    expect(await documentsOf(sam)).toEqual([]);
    expect(await documentsOf(kim)).toEqual(kims);
  });

  it('limits activityId and document ids in bytes, so the longest ones store on every database', async () => {
    const { activityId } = await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId);
    const { au } = await launchAu(lms, school.sam, activityId);
    const longest = iri(2048);
    const longestId = cjk(500);
    expect([Buffer.byteLength(longest), Buffer.byteLength(longestId)]).toEqual([2048, 500]);

    // State: 2048 bytes of activityId and 500 bytes of stateId fit the unique index, on PostgreSQL too.
    expect((await au.call('PUT', statePath(au, longestId, longest), { a: 1 })).status).toBe(204);
    const stored = await au.call('GET', statePath(au, longestId, longest));
    expect([stored.status, stored.body]).toEqual([200, { a: 1 }]);
    const tooLongIri = await au.call('PUT', statePath(au, 'bookmark', iri(2049)), { a: 1 });
    expect([tooLongIri.status, tooLongIri.body]).toEqual([
      400,
      { error: { message: 'The activityId parameter must be at most 2048 bytes.' } },
    ]);
    // Fewer than 2048 characters but more than 2048 bytes.
    expect((await au.call('PUT', statePath(au, 'bookmark', `https://example.test/${cjk(3000)}`), { a: 1 })).status).toBe(400);
    const tooLongId = await au.call('PUT', statePath(au, cjk(501), longest), { a: 1 });
    expect([tooLongId.status, tooLongId.body]).toEqual([400, { error: { message: 'The stateId parameter must be at most 500 bytes.' } }]);

    // Activity profiles: the same limits.
    expect((await au.call('PUT', profilePath(longestId, longest), { b: 2 }, { 'if-none-match': '*' })).status).toBe(204);
    expect((await au.call('GET', profilePath(longestId, longest))).body).toEqual({ b: 2 });
    expect((await au.call('PUT', profilePath('notes', iri(2049)), { b: 2 }, { 'if-none-match': '*' })).status).toBe(400);
    expect(
      (await au.call('PUT', profilePath('notes', `https://example.test/${cjk(3000)}`), { b: 2 }, { 'if-none-match': '*' })).status,
    ).toBe(400);
    const tooLongProfileId = await au.call('PUT', profilePath(cjk(501), longest), { b: 2 }, { 'if-none-match': '*' });
    expect([tooLongProfileId.status, tooLongProfileId.body]).toEqual([
      400,
      { error: { message: 'The profileId parameter must be at most 500 bytes.' } },
    ]);

    expect((await documentsOf(await userId('sam@test.dev'))).filter((d) => d.key.endsWith(`:${longestId}`)).map((d) => d.key)).toEqual([
      `activity_profile:${longestId}`,
      `state:${longestId}`,
    ]);
  });
});
