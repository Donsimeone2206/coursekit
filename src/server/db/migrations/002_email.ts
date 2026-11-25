import type { Kysely } from 'kysely';

/**
 * Email notifications: per-person delivery preferences and an outbox that the background worker
 * delivers from. Existing people get no preference row, which means "use the site default", so sites
 * upgrading from 0.1.x need no data changes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('email_preferences')
    .addColumn('user_id', 'text', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    // null: follow the site default
    .addColumn('frequency', 'text')
    // JSON array of category ids the person opted out of
    .addColumn('disabled_categories', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('last_digest_at', 'text')
    // Set while a digest run owns the row, so two processes never send the same digest
    .addColumn('digest_claim', 'text')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('email_preferences_claim_idx').on('email_preferences').column('digest_claim').execute();

  await s
    .createTable('email_outbox')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('notification_id', 'text', (c) => c.references('notifications.id').onDelete('cascade'))
    .addColumn('to_address', 'text', (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('html', 'text', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull())
    // JSON object of extra headers (List-Unsubscribe, ...)
    .addColumn('headers', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (c) => c.notNull().defaultTo(8))
    .addColumn('next_attempt_at', 'text', (c) => c.notNull())
    .addColumn('lock_id', 'text')
    .addColumn('locked_until', 'text')
    .addColumn('last_error', 'text')
    .addColumn('last_error_at', 'text')
    .addColumn('sent_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('email_outbox_due_idx').on('email_outbox').columns(['status', 'next_attempt_at']).execute();
  await s.createIndex('email_outbox_lock_idx').on('email_outbox').column('lock_id').execute();
  await s.createIndex('email_outbox_notification_idx').on('email_outbox').column('notification_id').execute();
  await s.createIndex('email_outbox_user_idx').on('email_outbox').column('user_id').execute();
  await s.createIndex('email_outbox_error_idx').on('email_outbox').column('last_error_at').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('email_outbox').ifExists().execute();
  await db.schema.dropTable('email_preferences').ifExists().execute();
}
