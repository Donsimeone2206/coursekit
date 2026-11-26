import type { Kysely } from 'kysely';

/**
 * SCORM 1.2, SCORM 2004 and xAPI content packages (0.3.0).
 *
 * New tables only: existing data is untouched. A package activity keeps every uploaded version
 * (attempts stay on the version they started with); the files of a version live in file storage
 * under its `storage_prefix`, listed in `package_files`. xAPI statements and documents (state,
 * activity and agent profiles) are scoped to the Coursekit activity whose package wrote them.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('package_versions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('edition', 'text')
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('file_name', 'text', (c) => c.notNull())
    .addColumn('structure', 'text', (c) => c.notNull())
    .addColumn('file_count', 'integer', (c) => c.notNull())
    .addColumn('total_bytes', 'double precision', (c) => c.notNull())
    .addColumn('storage_prefix', 'text', (c) => c.notNull())
    .addColumn('uploaded_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('package_versions_activity_idx').on('package_versions').columns(['activity_id', 'version']).unique().execute();

  await s
    .createTable('package_files')
    .addColumn('version_id', 'text', (c) => c.notNull().references('package_versions.id').onDelete('cascade'))
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('size', 'double precision', (c) => c.notNull())
    .addPrimaryKeyConstraint('package_files_pk', ['version_id', 'path'])
    .execute();

  await s
    .createTable('package_attempts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('version_id', 'text', (c) => c.notNull().references('package_versions.id').onDelete('cascade'))
    .addColumn('attempt_number', 'integer', (c) => c.notNull())
    .addColumn('registration', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('in_progress'))
    .addColumn('completion_status', 'text', (c) => c.notNull().defaultTo('not attempted'))
    .addColumn('success_status', 'text', (c) => c.notNull().defaultTo('unknown'))
    .addColumn('score', 'double precision')
    .addColumn('total_seconds', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('last_item_id', 'text')
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('last_accessed_at', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'text')
    .execute();
  await s
    .createIndex('package_attempts_user_idx')
    .on('package_attempts')
    .columns(['activity_id', 'user_id', 'attempt_number'])
    .unique()
    .execute();
  await s.createIndex('package_attempts_version_idx').on('package_attempts').column('version_id').execute();

  await s
    .createTable('package_sco_states')
    .addColumn('attempt_id', 'text', (c) => c.notNull().references('package_attempts.id').onDelete('cascade'))
    .addColumn('item_id', 'text', (c) => c.notNull())
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('completion_status', 'text', (c) => c.notNull().defaultTo('not attempted'))
    .addColumn('success_status', 'text', (c) => c.notNull().defaultTo('unknown'))
    .addColumn('score', 'double precision')
    .addColumn('total_seconds', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('last_exit', 'text')
    .addColumn('sessions', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('session_id', 'text')
    .addColumn('seq', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('terminated_session_id', 'text')
    // Seconds that session added to total_seconds, so a later Finish of the same session corrects it.
    .addColumn('session_seconds', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('package_sco_states_pk', ['attempt_id', 'item_id'])
    .execute();

  await s
    .createTable('xapi_statements')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('attempt_id', 'text')
    .addColumn('registration', 'text')
    .addColumn('verb_id', 'text', (c) => c.notNull())
    .addColumn('object_id', 'text')
    .addColumn('voided', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('voids_id', 'text')
    .addColumn('statement', 'text', (c) => c.notNull())
    .addColumn('timestamp', 'text', (c) => c.notNull())
    .addColumn('stored', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('xapi_statements_user_idx').on('xapi_statements').columns(['activity_id', 'user_id', 'stored']).execute();
  await s.createIndex('xapi_statements_attempt_idx').on('xapi_statements').column('attempt_id').execute();

  await s
    .createTable('xapi_documents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    // The user the document belongs to ('' for activity profiles, which every learner shares).
    .addColumn('owner_id', 'text', (c) => c.notNull())
    .addColumn('activity_iri', 'text', (c) => c.notNull())
    .addColumn('registration', 'text', (c) => c.notNull())
    .addColumn('doc_id', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull())
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('etag', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s
    .createIndex('xapi_documents_key_idx')
    .on('xapi_documents')
    .columns(['activity_id', 'kind', 'owner_id', 'activity_iri', 'registration', 'doc_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'xapi_documents',
    'xapi_statements',
    'package_sco_states',
    'package_attempts',
    'package_files',
    'package_versions',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
