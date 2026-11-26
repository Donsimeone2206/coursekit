import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { attendanceFor } from '../src/server/services/live/attendance.js';
import { loadLiveConfig } from '../src/server/services/live/config.js';
import { ensureRoom } from '../src/server/services/live/rooms.js';

it('upgrades a 0.3.0 database to live classes, keeping everything that was there', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    // A site created by 0.3.0: the migrations up to and including 011_open_badges have run.
    const names = Object.keys(migrations).filter((name) => name <= '011_open_badges');
    expect(names).toContain('011_open_badges');
    expect(names).not.toContain('015_live_classes');
    const v030 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v030.migrateToLatest()).error).toBeUndefined();

    // Raw SQL with the 0.3.0 column names, so the test doesn't depend on the new table types.
    const raw = db.withoutPlugins();
    const ts = new Date().toISOString();
    await raw
      .insertInto('users' as never)
      .values([
        { id: 'u1', email: 'teacher@test.dev', name: 'Old Teacher', role: 'instructor', status: 'active', created_at: ts, updated_at: ts },
        { id: 'u2', email: 'student@test.dev', name: 'Old Student', role: 'student', status: 'active', created_at: ts, updated_at: ts },
      ] as never)
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
        group_mode: 'separate',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('enrolments' as never)
      .values([
        { id: 'e1', course_id: 'c1', user_id: 'u1', role: 'teacher', status: 'active', created_at: ts },
        { id: 'e2', course_id: 'c1', user_id: 'u2', role: 'student', status: 'active', created_at: ts },
      ] as never)
      .execute();
    await raw
      .insertInto('sections' as never)
      .values({ id: 's1', course_id: 'c1', title: 'One', summary: '', position: 0, visible: 1, created_at: ts } as never)
      .execute();
    await raw
      .insertInto('activities' as never)
      .values({
        id: 'a1',
        course_id: 'c1',
        section_id: 's1',
        type: 'lesson',
        title: 'Lesson',
        description: '',
        position: 0,
        visible: 1,
        settings: '{"body":"Hi"}',
        completion: 'manual',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('calendar_events' as never)
      .values({
        id: 'ev1',
        course_id: 'c1',
        user_id: null,
        title: 'Live Q&A (old event)',
        starts_at: ts,
        created_by: 'u1',
        created_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('settings' as never)
      .values({ key: 'site.name', value: '"Old school"' } as never)
      .execute();

    const results = await migrateToLatest(db);
    expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['015_live_classes', 'Success']);

    // Everything from before is still there, and nothing is a live class yet.
    expect(await db.selectFrom('activities').select(['id', 'type', 'settings']).execute()).toEqual([
      { id: 'a1', type: 'lesson', settings: '{"body":"Hi"}' },
    ]);
    expect(await db.selectFrom('calendarEvents').select('title').execute()).toEqual([{ title: 'Live Q&A (old event)' }]);
    expect((await db.selectFrom('settings').selectAll().where('key', '=', 'site.name').executeTakeFirst())?.value).toBe('"Old school"');
    for (const table of ['liveSessions', 'liveRooms', 'livePresence', 'liveAttendance', 'liveRecordings'] as const) {
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
    // No provider settings were written: the defaults apply (meeting links on, the rest off).
    const config = await loadLiveConfig(db);
    expect(config.link.enabled).toBe(true);
    expect(config.bbb.enabled || config.zoom.enabled || config.jitsi.enabled).toBe(false);

    // The new tables work with the old rows: a live class in the old course, a session, a room and attendance.
    await db
      .insertInto('activities')
      .values({
        id: 'live1',
        courseId: 'c1',
        sectionId: 's1',
        type: 'live',
        title: 'Live class',
        description: '',
        position: 1,
        visible: 1,
        settings: '{"provider":"link"}',
        dueAt: null,
        maxGrade: null,
        completion: 'auto',
        createdBy: 'u1',
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await db
      .insertInto('liveSessions')
      .values({
        id: 'ls1',
        activityId: 'live1',
        courseId: 'c1',
        seriesId: null,
        startsAt: ts,
        endsAt: ts,
        durationMinutes: 60,
        timeZone: 'UTC',
        meetingUrl: null,
        remindedAt: null,
        createdBy: 'u1',
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    const session = await db.selectFrom('liveSessions').selectAll().executeTakeFirstOrThrow();
    expect(session).toMatchObject({ status: 'scheduled', sequence: 0, title: '', agenda: '' });
    const room = await ensureRoom(db, session, 'link', null);
    expect((await ensureRoom(db, session, 'link', null)).id).toBe(room.id);
    await db
      .insertInto('liveAttendance')
      .values({ sessionId: 'ls1', userId: 'u2', courseId: 'c1', status: 'present', markedBy: 'u1', markedAt: ts })
      .execute();
    expect((await attendanceFor(db, ['ls1'])).get('ls1')?.get('u2')).toMatchObject({ status: 'present', source: 'manual' });

    // Deleting the class keeps its room (to be removed at the provider), detached from the gone session.
    await db.deleteFrom('activities').where('id', '=', 'live1').execute();
    expect(await db.selectFrom('liveSessions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('liveAttendance').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('liveRooms').select(['id', 'sessionId', 'activityId']).execute()).toEqual([
      { id: room.id, sessionId: null, activityId: null },
    ]);

    // And the migration can be undone.
    const down = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => migrations } });
    expect((await down.migrateDown()).error).toBeUndefined();
    const tables = (await db.introspection.getTables()).map((t) => t.name);
    expect(tables).not.toContain('live_sessions');
    expect(tables).toContain('activities');
  } finally {
    await db.destroy();
  }
});
