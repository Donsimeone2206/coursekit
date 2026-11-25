import type { Kysely } from 'kysely';

/**
 * Course completion, certificates and badges. Only adds tables, so sites upgrading from 0.1.x keep
 * all their data; completion tracking stays off for every course until a teacher turns it on.
 * Portable column types only (text, integer, double precision), like 001_initial.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('course_completion_settings')
    .addColumn('course_id', 'text', (c) => c.primaryKey().references('courses.id').onDelete('cascade'))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('mode', 'text', (c) => c.notNull().defaultTo('all'))
    .addColumn('activity_ids', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('min_grade', 'double precision')
    .addColumn('certificate_enabled', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('certificate_title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('certificate_body', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('certificate_signature_name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('certificate_signature_title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('updated_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .execute();

  await s
    .createTable('course_completions')
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('completed_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('course_completions_pk', ['course_id', 'user_id'])
    .execute();
  await s.createIndex('course_completions_user_idx').on('course_completions').column('user_id').execute();

  await s
    .createTable('certificates')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('code', 'text', (c) => c.notNull())
    .addColumn('course_id', 'text', (c) => c.references('courses.id').onDelete('set null'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('recipient_name', 'text', (c) => c.notNull())
    .addColumn('course_title', 'text', (c) => c.notNull())
    .addColumn('site_name', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('signature_name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('signature_title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('completed_at', 'text', (c) => c.notNull())
    .addColumn('issued_at', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'text')
    .addColumn('revoked_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('revoke_reason', 'text')
    .addUniqueConstraint('certificates_code_uq', ['code'])
    .addUniqueConstraint('certificates_course_user_uq', ['course_id', 'user_id'])
    .execute();
  await s.createIndex('certificates_user_idx').on('certificates').column('user_id').execute();

  await s
    .createTable('badges')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.references('courses.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('icon', 'text', (c) => c.notNull())
    .addColumn('color', 'text', (c) => c.notNull())
    .addColumn('criteria', 'text', (c) => c.notNull().defaultTo('manual'))
    .addColumn('criteria_course_ids', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('badges_course_idx').on('badges').column('course_id').execute();

  await s
    .createTable('badge_awards')
    .addColumn('badge_id', 'text', (c) => c.notNull().references('badges.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('awarded_at', 'text', (c) => c.notNull())
    .addColumn('awarded_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('note', 'text')
    .addColumn('revoked_at', 'text')
    .addColumn('revoked_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addPrimaryKeyConstraint('badge_awards_pk', ['badge_id', 'user_id'])
    .execute();
  await s.createIndex('badge_awards_user_idx').on('badge_awards').column('user_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['badge_awards', 'badges', 'certificates', 'course_completions', 'course_completion_settings']) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
