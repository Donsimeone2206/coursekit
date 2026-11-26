import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import type { Coursekit } from '../src/server/index.js';
import { createTestLms, setupSchool } from './helpers.js';
import { createPackageActivity, fetchRaw, runRuntime, scorm2004Zip, tokenOf, uploadPackage } from './package-helpers.js';
import { manifest, sco, sequencedZip } from './sequencing-helpers.js';

it('upgrades a 0.3.0 database: package attempts are kept and get no sequencing state until they are used', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    const names = Object.keys(migrations).filter((name) => name <= '011_open_badges');
    expect(names).toContain('011_open_badges');
    const v030 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v030.migrateToLatest()).error).toBeUndefined();

    // Raw SQL with the 0.3.0 column names.
    const raw = db.withoutPlugins();
    const ts = new Date().toISOString();
    const insert = (table: string, values: Record<string, unknown>) =>
      raw
        .insertInto(table as never)
        .values(values as never)
        .execute();
    await insert('users', {
      id: 'u1',
      email: 'old@test.dev',
      name: 'Old Timer',
      role: 'student',
      status: 'active',
      created_at: ts,
      updated_at: ts,
    });
    await insert('courses', {
      id: 'c1',
      slug: 'old',
      title: 'Old course',
      summary: '',
      description: '',
      cover_color: 'indigo',
      visibility: 'published',
      enrolment: 'open',
      created_at: ts,
      updated_at: ts,
    });
    await insert('sections', { id: 's1', course_id: 'c1', title: 'One', summary: '', position: 0, visible: 1, created_at: ts });
    await insert('activities', {
      id: 'a1',
      course_id: 'c1',
      section_id: 's1',
      type: 'package',
      title: 'Package',
      description: '',
      position: 0,
      visible: 1,
      settings: '{}',
      completion: 'auto',
      created_at: ts,
      updated_at: ts,
    });
    const structure = { kind: 'scorm2004', edition: '4th', title: 'Old', items: [], activityId: null };
    await insert('package_versions', {
      id: 'v1',
      activity_id: 'a1',
      course_id: 'c1',
      version: 1,
      kind: 'scorm2004',
      edition: '4th',
      title: 'Old',
      file_name: 'old.zip',
      structure: JSON.stringify(structure),
      file_count: 1,
      total_bytes: 10,
      storage_prefix: 'packages/a1/v1/',
      created_at: ts,
    });
    await insert('package_attempts', {
      id: 't1',
      activity_id: 'a1',
      course_id: 'c1',
      user_id: 'u1',
      version_id: 'v1',
      attempt_number: 1,
      registration: '00000000-0000-4000-8000-000000000000',
      status: 'in_progress',
      started_at: ts,
      last_accessed_at: ts,
    });
    await insert('package_sco_states', {
      attempt_id: 't1',
      item_id: 'one',
      data: '{"values":{"cmi.location":"3"},"counts":{}}',
      updated_at: ts,
    });

    const results = await migrateToLatest(db);
    expect(results.map((r) => [r.migrationName, r.status])).toEqual(
      Object.keys(migrations)
        .filter((name) => name > '011_open_badges')
        .map((name) => [name, 'Success']),
    );
    expect(await db.selectFrom('packageAttempts').select(['id', 'status']).execute()).toEqual([{ id: 't1', status: 'in_progress' }]);
    expect(await db.selectFrom('packageScoStates').select('data').execute()).toEqual([
      { data: '{"values":{"cmi.location":"3"},"counts":{}}' },
    ]);
    expect(await db.selectFrom('packageSequencingStates').selectAll().execute()).toEqual([]);
    // The state is attempt data: it goes with its attempt.
    await db.insertInto('packageSequencingStates').values({ attemptId: 't1', state: '{}', revision: 0, updatedAt: ts }).execute();
    await db.deleteFrom('packageAttempts').where('id', '=', 't1').execute();
    expect(await db.selectFrom('packageSequencingStates').selectAll().execute()).toEqual([]);
  } finally {
    await db.destroy();
  }
});

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
});

it('lets an attempt that started under 0.3.0 carry on where the learner was', async () => {
  const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
  expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip())).status).toBe(201);
  // What 0.3.0 stored: no sequencing definitions in the version, no sequencing state, run-time data per SCO.
  const version = await lms.db.selectFrom('packageVersions').selectAll().executeTakeFirstOrThrow();
  const { sequencing: _sequencing, ...old } = JSON.parse(version.structure);
  await lms.db
    .updateTable('packageVersions')
    .set({ structure: JSON.stringify(old) })
    .execute();
  const sam = await lms.db.selectFrom('users').select('id').where('email', '=', 'sam@test.dev').executeTakeFirstOrThrow();
  const ts = new Date().toISOString();
  await lms.db
    .insertInto('packageAttempts')
    .values({
      id: 'old-attempt',
      activityId,
      courseId: school.course.id,
      userId: sam.id,
      versionId: version.id,
      attemptNumber: 1,
      registration: '00000000-0000-4000-8000-000000000001',
      status: 'in_progress',
      completionStatus: 'incomplete',
      successStatus: 'unknown',
      score: null,
      totalSeconds: 300,
      lastItemId: 'two',
      startedAt: ts,
      lastAccessedAt: ts,
      finishedAt: null,
    })
    .execute();
  const row = (itemId: string, values: Record<string, string>, completionStatus: 'completed' | 'incomplete', lastExit: string) => ({
    attemptId: 'old-attempt',
    itemId,
    data: JSON.stringify({ values, counts: {} }),
    completionStatus,
    successStatus: 'unknown' as const,
    score: null,
    totalSeconds: 150,
    lastExit,
    sessions: 1,
    sessionId: `${itemId}-session`,
    seq: 1,
    terminatedSessionId: `${itemId}-session`,
    sessionSeconds: 150,
    updatedAt: ts,
  });
  await lms.db
    .insertInto('packageScoStates')
    .values([
      row('one', { 'cmi.progress_measure': '0.9' }, 'completed', ''),
      row('two', { 'cmi.location': 'slide-7', 'cmi.suspend_data': 'abc', 'cmi.completion_status': 'incomplete' }, 'incomplete', 'suspend'),
    ])
    .execute();

  const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
  expect(launch.status).toBe(200);
  expect(launch.body).toMatchObject({ attemptId: 'old-attempt', itemId: 'two', mode: 'normal' });
  expect(launch.body.sequencing.toc.find((e: { id: string }) => e.id === 'one')).toMatchObject({ completionStatus: 'completed' });
  const win = runRuntime(await (await fetchRaw(lms, `/content/${tokenOf(launch.body.url)}/__coursekit/runtime.js`)).text());
  const api = win.API_1484_11!;
  api.Initialize('');
  expect(api.GetValue('cmi.entry')).toBe('resume');
  expect(api.GetValue('cmi.location')).toBe('slide-7');
  expect(api.GetValue('cmi.suspend_data')).toBe('abc');
  // The manifest was read again, and the sequencing definitions kept with the version.
  const upgraded = await lms.db.selectFrom('packageVersions').select('structure').executeTakeFirstOrThrow();
  expect(JSON.parse(upgraded.structure).sequencing.activities).toHaveLength(5);
  expect(await lms.db.selectFrom('packageSequencingStates').select('attemptId').execute()).toEqual([{ attemptId: 'old-attempt' }]);
});

/** Turns an uploaded version into what 0.3.0 stored, with an attempt in progress and its SCO rows. */
async function oldAttempt(
  activityId: string,
  lastItemId: string,
  rows: Array<{ itemId: string; completionStatus: 'completed' | 'incomplete' | 'not attempted'; lastExit: string | null }>,
) {
  const version = await lms.db.selectFrom('packageVersions').selectAll().where('activityId', '=', activityId).executeTakeFirstOrThrow();
  const { sequencing: _sequencing, ...old } = JSON.parse(version.structure);
  await lms.db
    .updateTable('packageVersions')
    .set({ structure: JSON.stringify(old) })
    .where('id', '=', version.id)
    .execute();
  const sam = await lms.db.selectFrom('users').select('id').where('email', '=', 'sam@test.dev').executeTakeFirstOrThrow();
  const ts = new Date().toISOString();
  const attemptId = `old-${activityId}`;
  await lms.db
    .insertInto('packageAttempts')
    .values({
      id: attemptId,
      activityId,
      courseId: school.course.id,
      userId: sam.id,
      versionId: version.id,
      attemptNumber: 1,
      registration: '00000000-0000-4000-8000-000000000002',
      status: 'in_progress',
      completionStatus: 'incomplete',
      successStatus: 'unknown',
      score: null,
      totalSeconds: 60,
      lastItemId,
      startedAt: ts,
      lastAccessedAt: ts,
      finishedAt: null,
    })
    .execute();
  await lms.db
    .insertInto('packageScoStates')
    .values(
      rows.map((r) => ({
        attemptId,
        itemId: r.itemId,
        // 0.3.0 inserted a "not attempted" row as soon as a SCO was opened.
        data: JSON.stringify({
          values: r.completionStatus === 'incomplete' ? { 'cmi.completion_status': 'incomplete', 'cmi.location': 'p3' } : {},
          counts: {},
        }),
        completionStatus: r.completionStatus,
        successStatus: 'unknown' as const,
        score: null,
        totalSeconds: 30,
        lastExit: r.lastExit,
        sessions: 1,
        sessionId: `${r.itemId}-session`,
        seq: 1,
        terminatedSessionId: `${r.itemId}-session`,
        sessionSeconds: 30,
        updatedAt: ts,
      })),
    )
    .execute();
  return attemptId;
}

it("doesn't complete or pass the SCO a 0.3.0 attempt was still in", async () => {
  const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
  expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, sequencedZip(manifest(sco('only'))))).status).toBe(201);
  const attemptId = await oldAttempt(activityId, 'only', [{ itemId: 'only', completionStatus: 'not attempted', lastExit: null }]);

  const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
  expect(launch.body).toMatchObject({
    attemptId,
    itemId: 'only',
    sequencing: { ended: false, completionStatus: 'incomplete', successStatus: 'unknown' },
  });
  expect(launch.body.sequencing.toc).toMatchObject([{ id: 'only', completionStatus: 'incomplete', successStatus: 'unknown' }]);
  expect(await lms.db.selectFrom('packageAttempts').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow()).toMatchObject({
    status: 'in_progress',
    completionStatus: 'incomplete',
    successStatus: 'unknown',
  });
  expect(await lms.db.selectFrom('completions').selectAll().where('activityId', '=', activityId).execute()).toEqual([]);
});

it('keeps the suspended and the current SCOs of a 0.3.0 attempt unfinished', async () => {
  const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
  expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip())).status).toBe(201);
  const attemptId = await oldAttempt(activityId, 'two', [
    { itemId: 'one', completionStatus: 'incomplete', lastExit: 'suspend' },
    { itemId: 'two', completionStatus: 'not attempted', lastExit: null },
  ]);

  const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
  expect(launch.body).toMatchObject({ attemptId, itemId: 'two', sequencing: { completionStatus: 'incomplete', successStatus: 'unknown' } });
  const toc = Object.fromEntries(
    launch.body.sequencing.toc.map((e: { id: string; completionStatus: string; successStatus: string; suspended: boolean }) => [
      e.id,
      [e.completionStatus, e.successStatus, e.suspended],
    ]),
  );
  expect(toc).toMatchObject({
    one: ['incomplete', 'unknown', true],
    two: ['incomplete', 'unknown', false],
    three: ['not attempted', 'unknown', false],
  });
  // Part one carries on where it was suspended, with its data.
  const one = await school.sam.post(`/api/packages/${activityId}/launch`, {
    attemptId,
    nav: 'choice',
    itemId: 'one',
    deliveryId: launch.body.sequencing.deliveryId,
  });
  expect(one.body.itemId).toBe('one');
  const win = runRuntime(await (await fetchRaw(lms, `/content/${tokenOf(one.body.url)}/__coursekit/runtime.js`)).text());
  win.API_1484_11!.Initialize('');
  expect(win.API_1484_11!.GetValue('cmi.entry')).toBe('resume');
  expect(win.API_1484_11!.GetValue('cmi.location')).toBe('p3');
  expect(await lms.db.selectFrom('completions').selectAll().where('activityId', '=', activityId).execute()).toEqual([]);
});
