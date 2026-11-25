import type { Kysely } from 'kysely';

/**
 * Gradebook categories and weights (0.2.0).
 *
 * Nothing needs converting when a 0.1.x site upgrades: a course without a `grade_settings` row
 * keeps natural (points) aggregation, an activity without a `grade_items` row sits in the course's
 * default category and is weighted by its points, so every existing course total stays the same.
 * The default category's row (id = course id) is only written once a teacher saves the setup.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('grade_settings')
    .addColumn('course_id', 'text', (c) => c.primaryKey().references('courses.id').onDelete('cascade'))
    .addColumn('aggregation', 'text', (c) => c.notNull().defaultTo('natural'))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('grade_categories')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('weight', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('drop_lowest', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('grade_categories_course_idx').on('grade_categories').column('course_id').execute();

  await s
    .createTable('grade_items')
    .addColumn('activity_id', 'text', (c) => c.primaryKey().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('category_id', 'text', (c) => c.references('grade_categories.id').onDelete('set null'))
    .addColumn('weight', 'double precision')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('grade_items_course_idx').on('grade_items').column('course_id').execute();
  await s.createIndex('grade_items_category_idx').on('grade_items').column('category_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['grade_items', 'grade_categories', 'grade_settings']) await db.schema.dropTable(table).ifExists().execute();
}
