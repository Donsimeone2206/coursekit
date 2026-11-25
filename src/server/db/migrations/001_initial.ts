import type { Kysely } from 'kysely';

/**
 * Initial schema. Uses only portable column types (text, integer, double precision)
 * so the same migration runs on SQLite and PostgreSQL.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('student'))
    .addColumn('avatar_url', 'text')
    .addColumn('bio', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('last_login_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('impersonator_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('user_agent', 'text')
    .execute();
  await s.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await s
    .createTable('categories')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('courses')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('category_id', 'text', (c) => c.references('categories.id').onDelete('set null'))
    .addColumn('cover_color', 'text', (c) => c.notNull().defaultTo('indigo'))
    .addColumn('cover_image_url', 'text')
    .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('enrolment', 'text', (c) => c.notNull().defaultTo('open'))
    .addColumn('enrolment_key', 'text')
    .addColumn('start_date', 'text')
    .addColumn('end_date', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('courses_category_idx').on('courses').column('category_id').execute();

  await s
    .createTable('enrolments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('student'))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('last_access_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('enrolments_course_user_uq', ['course_id', 'user_id'])
    .execute();
  await s.createIndex('enrolments_user_idx').on('enrolments').column('user_id').execute();

  await s
    .createTable('sections')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('visible', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('sections_course_idx').on('sections').column('course_id').execute();

  await s
    .createTable('activities')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('section_id', 'text', (c) => c.notNull().references('sections.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('visible', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('settings', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('due_at', 'text')
    .addColumn('max_grade', 'double precision')
    .addColumn('completion', 'text', (c) => c.notNull().defaultTo('none'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('activities_course_idx').on('activities').column('course_id').execute();
  await s.createIndex('activities_section_idx').on('activities').column('section_id').execute();
  await s.createIndex('activities_due_idx').on('activities').column('due_at').execute();

  await s
    .createTable('completions')
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('completed_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('completions_pk', ['activity_id', 'user_id'])
    .execute();
  await s.createIndex('completions_user_course_idx').on('completions').columns(['user_id', 'course_id']).execute();

  await s
    .createTable('files')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('course_id', 'text', (c) => c.references('courses.id').onDelete('cascade'))
    .addColumn('context', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('mime', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('storage_key', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('submissions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('text', 'text')
    .addColumn('file_ids', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('submitted_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('submissions_activity_user_uq', ['activity_id', 'user_id'])
    .execute();
  await s.createIndex('submissions_course_idx').on('submissions').column('course_id').execute();

  await s
    .createTable('grades')
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('score', 'double precision')
    .addColumn('feedback', 'text')
    .addColumn('graded_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('graded_at', 'text')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('grades_pk', ['activity_id', 'user_id'])
    .execute();
  await s.createIndex('grades_course_idx').on('grades').column('course_id').execute();
  await s.createIndex('grades_user_idx').on('grades').column('user_id').execute();

  await s
    .createTable('questions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('prompt', 'text', (c) => c.notNull())
    .addColumn('points', 'double precision', (c) => c.notNull().defaultTo(1))
    .addColumn('options', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('accepted_answers', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('tolerance', 'double precision')
    .addColumn('explanation', 'text')
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await s.createIndex('questions_activity_idx').on('questions').column('activity_id').execute();

  await s
    .createTable('quiz_attempts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('attempt_number', 'integer', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('question_order', 'text', (c) => c.notNull())
    .addColumn('answers', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('results', 'text')
    .addColumn('score', 'double precision')
    .addColumn('max_score', 'double precision', (c) => c.notNull())
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('deadline_at', 'text')
    .addColumn('finished_at', 'text')
    .execute();
  await s.createIndex('quiz_attempts_activity_user_idx').on('quiz_attempts').columns(['activity_id', 'user_id']).execute();

  await s
    .createTable('discussions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('pinned', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('locked', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('reply_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_post_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('discussions_activity_idx').on('discussions').column('activity_id').execute();

  await s
    .createTable('posts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('discussion_id', 'text', (c) => c.notNull().references('discussions.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('parent_id', 'text', (c) => c.references('posts.id').onDelete('cascade'))
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('posts_discussion_idx').on('posts').column('discussion_id').execute();

  await s
    .createTable('announcements')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('announcements_course_idx').on('announcements').columns(['course_id', 'created_at']).execute();

  await s
    .createTable('notifications')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('link', 'text')
    .addColumn('read_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('notifications_user_idx').on('notifications').columns(['user_id', 'created_at']).execute();

  await s
    .createTable('calendar_events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('course_id', 'text', (c) => c.references('courses.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('starts_at', 'text', (c) => c.notNull())
    .addColumn('ends_at', 'text')
    .addColumn('created_by', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('calendar_events_course_idx').on('calendar_events').column('course_id').execute();
  await s.createIndex('calendar_events_user_idx').on('calendar_events').column('user_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const tables = [
    'calendar_events',
    'notifications',
    'announcements',
    'posts',
    'discussions',
    'quiz_attempts',
    'questions',
    'grades',
    'submissions',
    'files',
    'completions',
    'activities',
    'sections',
    'enrolments',
    'courses',
    'categories',
    'sessions',
    'users',
    'settings',
  ];
  for (const table of tables) await db.schema.dropTable(table).ifExists().execute();
}
