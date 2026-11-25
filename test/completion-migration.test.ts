import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { EventBus } from '../src/server/lib/events.js';
import { evaluateCompletion } from '../src/server/services/completion.js';

it('upgrades a 0.1.x database to completion and badges without touching its data', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    // A site created by 0.1.x: only the initial migration has run.
    const v01 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => ({ '001_initial': migrations['001_initial']! }) },
    });
    expect((await v01.migrateToLatest()).error).toBeUndefined();
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
      .insertInto('courses')
      .values({
        id: 'c1',
        slug: 'old',
        title: 'Old course',
        summary: '',
        description: '',
        categoryId: null,
        coverColor: 'indigo',
        coverImageUrl: null,
        visibility: 'published',
        enrolment: 'open',
        enrolmentKey: null,
        startDate: null,
        endDate: null,
        createdBy: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db
      .insertInto('sections')
      .values({ id: 's1', courseId: 'c1', title: 'One', summary: '', position: 0, visible: 1, createdAt: ts })
      .execute();
    await db
      .insertInto('activities')
      .values({
        id: 'a1',
        courseId: 'c1',
        sectionId: 's1',
        type: 'lesson',
        title: 'Read',
        description: '',
        position: 0,
        visible: 1,
        settings: '{}',
        dueAt: null,
        maxGrade: null,
        completion: 'manual',
        createdBy: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db
      .insertInto('enrolments')
      .values({ id: 'e1', courseId: 'c1', userId: 'u1', role: 'student', status: 'active', lastAccessAt: null, createdAt: ts })
      .execute();
    await db.insertInto('completions').values({ activityId: 'a1', userId: 'u1', courseId: 'c1', completedAt: ts }).execute();

    const results = await migrateToLatest(db);
    // 0.1.x had only 001, so every later migration runs; all must succeed.
    expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['004_completion_badges', 'Success']);
    expect(results.every((r) => r.status === 'Success')).toBe(true);

    expect(await db.selectFrom('completions').selectAll().execute()).toHaveLength(1);
    expect((await db.selectFrom('users').select('name').executeTakeFirstOrThrow()).name).toBe('Old Timer');
    for (const table of ['courseCompletionSettings', 'courseCompletions', 'certificates', 'badges', 'badgeAwards'] as const) {
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
    // Completion tracking stays off until a teacher turns it on, so existing progress completes nothing.
    expect(await evaluateCompletion({ db, events: new EventBus() }, 'c1')).toEqual([]);
    // Running it again is a no-op.
    expect(await migrateToLatest(db)).toEqual([]);
  } finally {
    await db.destroy();
  }
});
