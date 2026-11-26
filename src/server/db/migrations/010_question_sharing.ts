import type { Kysely } from 'kysely';

/**
 * Question sharing (0.3.0): a course's question category (with everything below it) can be shared with other
 * courses, which use it read-only. `course_id` is the course it's shared with; null shares it with every course
 * on the site (administrators only). Nothing to carry forward: existing banks start unshared.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('question_category_shares')
    .addColumn('id', 'text', (c) => c.primaryKey().notNull())
    .addColumn('category_id', 'text', (c) => c.notNull().references('question_categories.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.references('courses.id').onDelete('cascade'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('question_category_shares_category_idx').on('question_category_shares').column('category_id').execute();
  await db.schema.createIndex('question_category_shares_course_idx').on('question_category_shares').column('course_id').execute();
  // When a share ends, random slots of other courses' quizzes keep the questions they could pick then (a JSON array of ids).
  await db.schema
    .createTable('quiz_slot_pools')
    .addColumn('slot_id', 'text', (c) => c.primaryKey().notNull().references('quiz_slots.id').onDelete('cascade'))
    .addColumn('question_ids', 'text', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('quiz_slot_pools').execute();
  await db.schema.dropTable('question_category_shares').execute();
}
