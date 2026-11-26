import type { Kysely } from 'kysely';

/**
 * LTI Dynamic Registration (0.4.0).
 *
 * - `lti_tools.scopes`: the service scopes a tool may be granted, as a JSON array. Dynamic Registration sets
 *   it to the scopes the tool asked for that Coursekit supports; it is null for every existing tool and for
 *   tools added by hand, which keeps their behaviour: every scope of the services an administrator allowed.
 * - `lti_tools.domains`: the domains a tool that registered itself declared (its domain and secondary domains),
 *   as a JSON array. Launch URLs and selected content may be on them as well as on the tool URL's host. Null
 *   for every existing tool and for tools added by hand: only the tool URL's host, as before.
 * - `lti_registrations`: one row per registration an administrator starts. Only a SHA-256 hash of the
 *   registration token is stored. The row is bound to the administrator, pending until the tool registers
 *   (or the token expires), and then keeps what the tool asked for, for the administrator's review.
 *
 * Existing data needs no conversion. Portable column types only, like the earlier migrations.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s.alterTable('lti_tools').addColumn('scopes', 'text').execute();
  await s.alterTable('lti_tools').addColumn('domains', 'text').execute();

  await s
    .createTable('lti_registrations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    // pending | completed
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('completed_at', 'text')
    .addColumn('tool_id', 'text', (c) => c.references('lti_tools.id').onDelete('cascade'))
    // JSON: what the tool asked for, as recorded.
    .addColumn('metadata', 'text')
    .execute();
  await s.createIndex('lti_registrations_tool_idx').on('lti_registrations').column('tool_id').execute();
  await s.createIndex('lti_registrations_expires_idx').on('lti_registrations').columns(['status', 'expires_at']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lti_registrations').ifExists().execute();
  await db.schema.alterTable('lti_tools').dropColumn('domains').execute();
  await db.schema.alterTable('lti_tools').dropColumn('scopes').execute();
}
