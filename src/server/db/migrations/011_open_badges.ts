import { sql, type Kysely } from 'kysely';

/**
 * Open Badges export (0.3.0): one row per time a recipient shared one of their badges publicly.
 *
 * Only adds a table, so nothing changes for existing sites: no award is public until its recipient shares it.
 * Rows are kept after the recipient stops sharing (withdrawn_at) and after the badge or the account is deleted
 * (the references become null), so the public documents can answer "revoked" and the credential's slot in the
 * revocation list stays set. A share belongs to one awarding of the badge (awarded_at): restoring a revoked award
 * awards it anew, so the shares made before stay revoked for good. At most one live share per awarding (unique index).
 * Portable column types only, like the earlier migrations.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('open_badge_shares')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('badge_id', 'text', (c) => c.references('badges.id').onDelete('set null'))
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('salt', 'text', (c) => c.notNull())
    .addColumn('subject_id', 'text', (c) => c.notNull())
    .addColumn('awarded_at', 'text', (c) => c.notNull())
    .addColumn('status_index', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('withdrawn_at', 'text')
    .addUniqueConstraint('open_badge_shares_status_index_uq', ['status_index'])
    .execute();
  await db.schema.createIndex('open_badge_shares_award_idx').on('open_badge_shares').columns(['badge_id', 'user_id']).execute();
  await db.schema.createIndex('open_badge_shares_user_idx').on('open_badge_shares').column('user_id').execute();
  await db.schema
    .createIndex('open_badge_shares_live_uq')
    .on('open_badge_shares')
    .columns(['badge_id', 'user_id', 'awarded_at'])
    .unique()
    .where(sql.ref('withdrawn_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('open_badge_shares').ifExists().execute();
}
