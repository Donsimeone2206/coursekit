import type { Kysely } from 'kysely';

/**
 * cmi5 courses in package activities (0.4.0).
 *
 * New tables, so 0.3.0 package data (versions, attempts, SCO states, xAPI statements and documents) is carried
 * forward unchanged, apart from the xAPI documents of deleted learners (below). A cmi5 registration is a package
 * attempt and uses its `registration` UUID:
 *  - `cmi5_sessions`: one row per AU launch (the cmi5 session), with its launch mode, the generated activity
 *    id, the one-time fetch URL's use, whether the AU read the learner preferences, and where the session ended
 *    (terminated or abandoned);
 *  - `cmi5_au_states`: what each registration recorded for each AU (completed, passed, failed, score, time);
 *  - `cmi5_satisfied`: the blocks and the course a registration satisfied.
 * Deleting a learner now deletes their xAPI documents (State, profiles, and cmi5's LMS.LaunchData and learner
 * preferences), which have no foreign key: `xapi_documents_owner_idx` finds them, and the documents that deleting
 * a learner left behind before 0.4.0 are deleted here.
 * Portable column types only, like the earlier migrations.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('cmi5_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('version_id', 'text', (c) => c.notNull().references('package_versions.id').onDelete('cascade'))
    .addColumn('attempt_id', 'text', (c) => c.references('package_attempts.id').onDelete('cascade'))
    .addColumn('registration', 'text', (c) => c.notNull())
    .addColumn('au_key', 'text', (c) => c.notNull())
    .addColumn('au_id', 'text', (c) => c.notNull())
    .addColumn('au_lms_id', 'text', (c) => c.notNull())
    .addColumn('home_page', 'text', (c) => c.notNull())
    .addColumn('launch_mode', 'text', (c) => c.notNull())
    .addColumn('launch_method', 'text', (c) => c.notNull())
    .addColumn('move_on', 'text', (c) => c.notNull())
    .addColumn('mastery_score', 'double precision')
    .addColumn('launch_url', 'text', (c) => c.notNull())
    .addColumn('fetched_at', 'text')
    .addColumn('preferences_read_at', 'text')
    .addColumn('launched_at', 'text', (c) => c.notNull())
    .addColumn('initialized_at', 'text')
    .addColumn('terminated_at', 'text')
    .addColumn('abandoned_at', 'text')
    .addColumn('last_activity_at', 'text', (c) => c.notNull())
    .addColumn('completed', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('result_verb', 'text')
    .addColumn('duration_seconds', 'double precision', (c) => c.notNull().defaultTo(0))
    .execute();
  await s.createIndex('cmi5_sessions_attempt_idx').on('cmi5_sessions').column('attempt_id').execute();
  await s.createIndex('cmi5_sessions_user_idx').on('cmi5_sessions').columns(['activity_id', 'user_id']).execute();
  // Deleting a package version, a course or a user finds its sessions with these.
  await s.createIndex('cmi5_sessions_version_idx').on('cmi5_sessions').column('version_id').execute();
  await s.createIndex('cmi5_sessions_course_idx').on('cmi5_sessions').column('course_id').execute();
  await s.createIndex('cmi5_sessions_user_id_idx').on('cmi5_sessions').column('user_id').execute();

  await s
    .createTable('cmi5_au_states')
    .addColumn('attempt_id', 'text', (c) => c.notNull().references('package_attempts.id').onDelete('cascade'))
    .addColumn('au_key', 'text', (c) => c.notNull())
    .addColumn('completed_at', 'text')
    .addColumn('passed_at', 'text')
    .addColumn('failed_at', 'text')
    .addColumn('score', 'double precision')
    .addColumn('sessions', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('total_seconds', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('first_launched_at', 'text')
    .addColumn('last_launched_at', 'text')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('cmi5_au_states_pk', ['attempt_id', 'au_key'])
    .execute();

  await s
    .createTable('cmi5_satisfied')
    .addColumn('attempt_id', 'text', (c) => c.notNull().references('package_attempts.id').onDelete('cascade'))
    .addColumn('node_key', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('session_id', 'text', (c) => c.notNull())
    .addColumn('statement_id', 'text', (c) => c.notNull())
    .addColumn('satisfied_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('cmi5_satisfied_pk', ['attempt_id', 'node_key'])
    .execute();

  await db
    .deleteFrom('xapi_documents')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('users').select('users.id').whereRef('users.id', '=', 'xapi_documents.owner_id'))))
    .execute();
  await s.createIndex('xapi_documents_owner_idx').on('xapi_documents').column('owner_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('xapi_documents_owner_idx').ifExists().execute();
  for (const table of ['cmi5_satisfied', 'cmi5_au_states', 'cmi5_sessions']) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
