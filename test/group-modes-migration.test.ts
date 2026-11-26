import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { loadAvailability } from '../src/server/services/group-modes.js';

it('upgrades a 0.2.0 database to group modes without changing who sees what', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    // A site created by 0.2.0: the migrations up to and including 006_grade_categories have run.
    const names = Object.keys(migrations).filter((name) => name <= '006_grade_categories');
    expect(names).toContain('006_grade_categories');
    const v020 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v020.migrateToLatest()).error).toBeUndefined();

    // Raw SQL with the 0.2.0 column names, so the test doesn't depend on the new table types.
    const raw = db.withoutPlugins();
    const ts = new Date().toISOString();
    await raw
      .insertInto('users' as never)
      .values({
        id: 'u1',
        email: 'old@test.dev',
        name: 'Old Timer',
        role: 'student',
        status: 'active',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('courses' as never)
      .values({
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
      } as never)
      .execute();
    await raw
      .insertInto('sections' as never)
      .values({ id: 's1', course_id: 'c1', title: 'One', summary: '', position: 0, visible: 1, created_at: ts } as never)
      .execute();
    await raw
      .insertInto('activities' as never)
      .values({
        id: 'f1',
        course_id: 'c1',
        section_id: 's1',
        type: 'forum',
        title: 'Forum',
        description: '',
        position: 0,
        visible: 1,
        settings: '{}',
        completion: 'none',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('discussions' as never)
      .values({
        id: 'd1',
        activity_id: 'f1',
        course_id: 'c1',
        user_id: 'u1',
        title: 'Hello',
        pinned: 0,
        locked: 0,
        reply_count: 0,
        last_post_at: ts,
        created_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('course_groups' as never)
      .values({ id: 'g1', course_id: 'c1', name: 'Team', description: '', created_at: ts, updated_at: ts } as never)
      .execute();

    // Files 0.2.0 attached: a resource's file, submitted work, an upload linked from a forum post, and one that isn't.
    const activity = (id: string, type: string, settings: string) =>
      raw
        .insertInto('activities' as never)
        .values({
          id,
          course_id: 'c1',
          section_id: 's1',
          type,
          title: id,
          description: '',
          position: 1,
          visible: 1,
          settings,
          completion: 'none',
          created_at: ts,
          updated_at: ts,
        } as never)
        .execute();
    await activity('r1', 'resource', JSON.stringify({ kind: 'file', fileId: 'file-r' }));
    await activity('a1', 'assignment', '{}');
    for (const [id, context] of [
      ['file-r', 'activity'],
      ['file-s', 'submission'],
      ['file-p', 'post'],
      ['file-c', 'course'],
    ]) {
      await raw
        .insertInto('files' as never)
        .values({
          id,
          owner_id: 'u1',
          course_id: 'c1',
          context,
          name: 'x.txt',
          mime: 'text/plain',
          size: 1,
          storage_key: id,
          created_at: ts,
        } as never)
        .execute();
    }
    await raw
      .insertInto('submissions' as never)
      .values({
        id: 'sub1',
        activity_id: 'a1',
        course_id: 'c1',
        user_id: 'u1',
        file_ids: '["file-s"]',
        submitted_at: ts,
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('posts' as never)
      .values({
        id: 'p1',
        discussion_id: 'd1',
        course_id: 'c1',
        user_id: 'u1',
        body: 'See [x](/api/files/file-p)',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();

    const results = await migrateToLatest(db);
    // Every migration after 006 runs (not only this one), and all succeed.
    expect(results.map((r) => r.migrationName)).toContain('009_group_modes');
    expect(results.every((r) => r.status === 'Success')).toBe(true);
    expect(results.map((r) => r.migrationName)).toEqual(Object.keys(migrations).filter((n) => n > '006_grade_categories'));

    // Existing courses have no groups, activities follow the course, discussions are for everyone.
    expect(await db.selectFrom('courses').select(['id', 'groupMode']).execute()).toEqual([{ id: 'c1', groupMode: 'none' }]);
    expect(await db.selectFrom('activities').select(['id', 'groupMode']).orderBy('id').execute()).toEqual([
      { id: 'a1', groupMode: null },
      { id: 'f1', groupMode: null },
      { id: 'r1', groupMode: null },
    ]);
    expect(await db.selectFrom('discussions').select(['id', 'groupId', 'title']).execute()).toEqual([
      { id: 'd1', groupId: null, title: 'Hello' },
    ]);
    expect(await db.selectFrom('activityGroups').selectAll().execute()).toEqual([]);
    expect((await loadAvailability(db, 'c1')).isAvailable('f1', 'u1')).toBe(true);
    // Attached files are tied to their activity (and forum discussion), so downloads follow its rules.
    expect(await db.selectFrom('files').select(['id', 'activityId', 'discussionId']).orderBy('id').execute()).toEqual([
      { id: 'file-c', activityId: null, discussionId: null },
      { id: 'file-p', activityId: 'f1', discussionId: 'd1' },
      { id: 'file-r', activityId: 'r1', discussionId: null },
      { id: 'file-s', activityId: 'a1', discussionId: null },
    ]);

    // Restrictions work on the upgraded database.
    await db.insertInto('activityGroups').values({ activityId: 'f1', groupId: 'g1', courseId: 'c1', createdAt: ts }).execute();
    expect((await loadAvailability(db, 'c1')).isAvailable('f1', 'u1')).toBe(false);
    // Deleting the activity removes its restriction rows.
    await db.deleteFrom('activities').where('id', '=', 'f1').execute();
    expect(await db.selectFrom('activityGroups').selectAll().execute()).toEqual([]);

    expect(await migrateToLatest(db)).toEqual([]);
  } finally {
    await db.destroy();
  }
});
