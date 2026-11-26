import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import * as cmi5Migration from '../src/server/db/migrations/013_cmi5.js';

it('upgrades a 0.3.0 database to cmi5 without changing its package data', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    // A site created by 0.3.0: the migrations up to and including 011_open_badges have run.
    const names = Object.keys(migrations).filter((name) => name <= '011_open_badges');
    expect(names).toContain('011_open_badges');
    const v030 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v030.migrateToLatest()).error).toBeUndefined();

    // Raw rows with the 0.3.0 column names, so the test doesn't depend on the new table types.
    const raw = db.withoutPlugins();
    const ts = '2026-05-01T10:00:00.000Z';
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
      title: 'Module',
      description: '',
      position: 0,
      visible: 1,
      settings: '{"display":"embed","attemptsAllowed":0,"gradingMethod":"highest","requirePass":false}',
      completion: 'auto',
      max_grade: 10,
      created_at: ts,
      updated_at: ts,
    });
    const structure = JSON.stringify({ kind: 'xapi', edition: null, title: 'Old xAPI', items: [], activityId: 'https://example.test/old' });
    await insert('package_versions', {
      id: 'v1',
      activity_id: 'a1',
      course_id: 'c1',
      version: 1,
      kind: 'xapi',
      edition: null,
      title: 'Old xAPI',
      file_name: 'old.zip',
      structure,
      file_count: 1,
      total_bytes: 10,
      storage_prefix: 'packages/a1/v1/',
      uploaded_by: 'u1',
      created_at: ts,
    });
    await insert('package_files', { version_id: 'v1', path: 'index.html', size: 10 });
    await insert('package_attempts', {
      id: 't1',
      activity_id: 'a1',
      course_id: 'c1',
      user_id: 'u1',
      version_id: 'v1',
      attempt_number: 1,
      registration: '11111111-2222-4333-8444-555555555555',
      status: 'finished',
      completion_status: 'completed',
      success_status: 'passed',
      score: 0.8,
      total_seconds: 60,
      started_at: ts,
      last_accessed_at: ts,
      finished_at: ts,
    });
    await insert('package_sco_states', { attempt_id: 't1', item_id: 'xapi', data: '{}', updated_at: ts });
    await insert('xapi_statements', {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      activity_id: 'a1',
      course_id: 'c1',
      user_id: 'u1',
      attempt_id: 't1',
      registration: '11111111-2222-4333-8444-555555555555',
      verb_id: 'http://adlnet.gov/expapi/verbs/completed',
      object_id: 'https://example.test/old',
      voided: 0,
      statement: '{"verb":{"id":"http://adlnet.gov/expapi/verbs/completed"}}',
      timestamp: ts,
      stored: ts,
    });
    await insert('xapi_documents', {
      id: 'd1',
      activity_id: 'a1',
      kind: 'state',
      owner_id: 'u1',
      activity_iri: 'https://example.test/old',
      registration: '',
      doc_id: 'bookmark',
      content_type: 'application/json',
      content: Buffer.from('{"page":2}').toString('base64'),
      etag: 'e1',
      updated_at: ts,
    });
    const before: Record<string, unknown[]> = {};
    const tables = [
      'package_versions',
      'package_files',
      'package_attempts',
      'package_sco_states',
      'xapi_statements',
      'xapi_documents',
      'activities',
    ];
    for (const t of tables)
      before[t] = await raw
        .selectFrom(t as never)
        .selectAll()
        .execute();
    // A document of a learner deleted under 0.3.0, which deleting the user left behind: the upgrade deletes it.
    await insert('xapi_documents', {
      id: 'd2',
      activity_id: 'a1',
      kind: 'state',
      owner_id: 'u-deleted',
      activity_iri: 'https://example.test/old',
      registration: '',
      doc_id: 'bookmark',
      content_type: 'application/json',
      content: Buffer.from('{"page":5}').toString('base64'),
      etag: 'e2',
      updated_at: ts,
    });
    const ownerIndex = async () =>
      (await sql<{ name: string }>`select name from sqlite_master where type = 'index' and name = 'xapi_documents_owner_idx'`.execute(raw))
        .rows.length;

    const results = await migrateToLatest(db);
    expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['013_cmi5', 'Success']);
    expect(results.every((r) => r.status === 'Success')).toBe(true);
    for (const t of tables)
      expect(
        await raw
          .selectFrom(t as never)
          .selectAll()
          .execute(),
        t,
      ).toEqual(before[t]);
    expect(await ownerIndex()).toBe(1);
    expect(await db.selectFrom('cmi5Sessions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('cmi5AuStates').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('cmi5Satisfied').selectAll().execute()).toEqual([]);

    // The new tables take rows for the old attempt, and go with it.
    await db
      .insertInto('cmi5AuStates')
      .values({
        attemptId: 't1',
        auKey: 'k1',
        completedAt: ts,
        passedAt: null,
        failedAt: null,
        score: null,
        sessions: 1,
        totalSeconds: 5,
        firstLaunchedAt: ts,
        lastLaunchedAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db.deleteFrom('packageAttempts').where('id', '=', 't1').execute();
    expect(await db.selectFrom('cmi5AuStates').selectAll().execute()).toEqual([]);

    // down() removes only the cmi5 tables and the documents' owner index.
    await cmi5Migration.down(raw);
    expect(await ownerIndex()).toBe(0);
    expect(
      await raw
        .selectFrom('package_versions' as never)
        .selectAll()
        .execute(),
    ).toHaveLength(1);
    await expect(
      raw
        .selectFrom('cmi5_sessions' as never)
        .selectAll()
        .execute(),
    ).rejects.toThrow();
  } finally {
    await db.destroy();
  }
});
