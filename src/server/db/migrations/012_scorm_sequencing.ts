import type { Kysely } from 'kysely';

/**
 * SCORM 2004 sequencing and navigation (0.4.0): the sequencing tracking state of each package attempt.
 *
 * Only adds a table. Attempts that started under 0.3.0 get their row the first time they are opened or
 * save progress again: it is built from their stored run-time data, so they carry on where they were.
 * `revision` lets concurrent requests (a commit and a navigation) detect each other.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('package_sequencing_states')
    .addColumn('attempt_id', 'text', (c) => c.primaryKey().references('package_attempts.id').onDelete('cascade'))
    // JSON SequencingState (see src/server/packages/sequencing/types.ts).
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('revision', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('package_sequencing_states').ifExists().execute();
}
