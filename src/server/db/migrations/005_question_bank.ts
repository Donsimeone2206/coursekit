import type { Kysely } from 'kysely';
import { newId } from '../../lib/util.js';

/**
 * Question banks (0.2.0). Questions move out of individual quizzes into a bank per course, organised in
 * categories. A quiz becomes an ordered list of slots: a bank question, or N random questions from a
 * category. Attempts keep a snapshot of the questions they use, so later edits never change them.
 *
 * Existing data is carried forward: each quiz's questions keep their ids and move into a category named
 * after the quiz, they become that quiz's slots (same order and marks), and every attempt gets a snapshot
 * of the questions it used.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // PostgreSQL runs each migration in a transaction already. SQLite doesn't, so make this one atomic there too.
  if (db.isTransaction) await migrate(db);
  else await db.transaction().execute(migrate);
}

interface LegacyQuestion {
  id: string;
  activity_id: string;
  type: string;
  prompt: string;
  points: number;
  options: string;
  accepted_answers: string;
  tolerance: number | null;
  explanation: string | null;
  position: number;
}

function parse<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function migrate(db: Kysely<any>): Promise<void> {
  const s = db.schema;
  const ts = new Date().toISOString();

  await s.alterTable('questions').renameTo('questions_v1').execute();

  await s
    .createTable('question_categories')
    .addColumn('id', 'text', (c) => c.primaryKey().notNull())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('parent_id', 'text', (c) => c.references('question_categories.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('question_categories_course_idx').on('question_categories').column('course_id').execute();

  // The primary key is named explicitly: on PostgreSQL the renamed table still owns "questions_pkey".
  await s
    .createTable('questions')
    .addColumn('id', 'text', (c) => c.notNull())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('category_id', 'text', (c) => c.notNull().references('question_categories.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('prompt', 'text', (c) => c.notNull())
    .addColumn('points', 'double precision', (c) => c.notNull().defaultTo(1))
    .addColumn('options', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('accepted_answers', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('tolerance', 'double precision')
    .addColumn('explanation', 'text')
    .addColumn('settings', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('questions_bank_pk', ['id'])
    .execute();
  await s.createIndex('questions_course_idx').on('questions').column('course_id').execute();
  await s.createIndex('questions_category_idx').on('questions').column('category_id').execute();

  await s
    .createTable('quiz_slots')
    .addColumn('id', 'text', (c) => c.primaryKey().notNull())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('question_id', 'text', (c) => c.references('questions.id').onDelete('cascade'))
    .addColumn('category_id', 'text', (c) => c.references('question_categories.id').onDelete('cascade'))
    .addColumn('question_count', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('include_subcategories', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('points', 'double precision', (c) => c.notNull().defaultTo(1))
    .execute();
  await s.createIndex('quiz_slots_activity_idx').on('quiz_slots').column('activity_id').execute();
  await s.createIndex('quiz_slots_question_idx').on('quiz_slots').column('question_id').execute();
  await s.createIndex('quiz_slots_category_idx').on('quiz_slots').column('category_id').execute();

  await s
    .alterTable('quiz_attempts')
    .addColumn('snapshot', 'text', (c) => c.notNull().defaultTo('[]'))
    .execute();

  // Carry 0.1.x quizzes forward, one quiz at a time.
  const quizzes = await db
    .selectFrom('activities as a')
    .select(['a.id', 'a.course_id', 'a.title', 'a.created_by', 'a.created_at'])
    .where((eb) => eb.exists(eb.selectFrom('questions_v1 as q').select('q.id').whereRef('q.activity_id', '=', 'a.id')))
    .orderBy('a.course_id')
    .orderBy('a.created_at')
    .orderBy('a.id')
    .execute();

  const namesByCourse = new Map<string, Set<string>>();
  for (const quiz of quizzes) {
    const names = namesByCourse.get(quiz.course_id) ?? new Set<string>();
    namesByCourse.set(quiz.course_id, names);
    const base = String(quiz.title).trim().slice(0, 90) || 'Quiz';
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    names.add(name.toLowerCase());

    const categoryId = newId();
    await db
      .insertInto('question_categories')
      .values({
        id: categoryId,
        course_id: quiz.course_id,
        parent_id: null,
        name,
        description: `Questions from the quiz “${base}”.`,
        position: names.size - 1,
        created_at: ts,
      })
      .execute();

    const legacy = (await db
      .selectFrom('questions_v1')
      .selectAll()
      .where('activity_id', '=', quiz.id)
      .orderBy('position')
      .orderBy('id')
      .execute()) as LegacyQuestion[];

    for (let i = 0; i < legacy.length; i += 50) {
      await db
        .insertInto('questions')
        .values(
          legacy.slice(i, i + 50).map((q) => ({
            id: q.id,
            course_id: quiz.course_id,
            category_id: categoryId,
            type: q.type,
            name: '',
            prompt: q.prompt,
            points: q.points,
            options: q.options,
            accepted_answers: q.accepted_answers,
            tolerance: q.tolerance,
            explanation: q.explanation,
            settings: '{}',
            created_by: quiz.created_by,
            created_at: quiz.created_at,
            updated_at: ts,
          })),
        )
        .execute();
      await db
        .insertInto('quiz_slots')
        .values(
          legacy.slice(i, i + 50).map((q, j) => ({
            id: newId(),
            activity_id: quiz.id,
            position: i + j,
            kind: 'question',
            question_id: q.id,
            category_id: null,
            question_count: 1,
            include_subcategories: 0,
            points: q.points,
          })),
        )
        .execute();
    }

    // Snapshot the questions each attempt used, as they are now (0.1.x kept no history).
    const byId = new Map(legacy.map((q) => [q.id, q]));
    let after = '';
    for (;;) {
      const attempts = await db
        .selectFrom('quiz_attempts')
        .select(['id', 'question_order'])
        .where('activity_id', '=', quiz.id)
        .where('id', '>', after)
        .orderBy('id')
        .limit(500)
        .execute();
      if (attempts.length === 0) break;
      for (const attempt of attempts) {
        const snapshot = parse<string[]>(attempt.question_order, [])
          .map((id) => byId.get(id))
          .filter((q): q is LegacyQuestion => !!q)
          .map((q) => ({
            id: q.id,
            type: q.type,
            prompt: q.prompt,
            points: q.points,
            options: parse<unknown[]>(q.options, []),
            acceptedAnswers: parse<string[]>(q.accepted_answers, []),
            tolerance: q.tolerance,
            explanation: q.explanation,
            settings: {},
          }));
        await db
          .updateTable('quiz_attempts')
          .set({ snapshot: JSON.stringify(snapshot) })
          .where('id', '=', attempt.id)
          .execute();
      }
      after = attempts[attempts.length - 1]!.id;
    }
  }

  await s.dropTable('questions_v1').execute();
}
