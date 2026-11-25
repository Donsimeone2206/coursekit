import { sql, type Kysely } from 'kysely';

/**
 * Course groups and site cohorts (0.2.0). Only adds tables, so sites upgrading from 0.1.x keep all their data.
 * Portable column types only, as in 001_initial, so the same migration runs on SQLite and PostgreSQL.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('course_groups')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  // Group names are unique within a course, ignoring case. (Expression indexes work on SQLite and PostgreSQL.)
  await sql`create unique index course_groups_course_name_uq on course_groups (course_id, lower(name))`.execute(db);

  await s
    .createTable('course_group_members')
    .addColumn('group_id', 'text', (c) => c.notNull().references('course_groups.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('course_group_members_pk', ['group_id', 'user_id'])
    .execute();
  await s.createIndex('course_group_members_course_user_idx').on('course_group_members').columns(['course_id', 'user_id']).execute();

  await s
    .createTable('cohorts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await sql`create unique index cohorts_name_uq on cohorts (lower(name))`.execute(db);

  await s
    .createTable('cohort_members')
    .addColumn('cohort_id', 'text', (c) => c.notNull().references('cohorts.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('cohort_members_pk', ['cohort_id', 'user_id'])
    .execute();
  await s.createIndex('cohort_members_user_idx').on('cohort_members').column('user_id').execute();

  // A cohort linked to a course: its members are enrolled with `role`, now and whenever they join the cohort later.
  await s
    .createTable('cohort_courses')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('cohort_id', 'text', (c) => c.notNull().references('cohorts.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('student'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('cohort_courses_cohort_course_uq', ['cohort_id', 'course_id'])
    .execute();
  await s.createIndex('cohort_courses_course_idx').on('cohort_courses').column('course_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['cohort_courses', 'cohort_members', 'cohorts', 'course_group_members', 'course_groups']) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
