import type { Kysely } from 'kysely';

/**
 * LTI 1.3 Advantage, with Coursekit as the platform (0.3.0).
 *
 * New tables only, so nothing needs converting when an older site upgrades. External tool activities
 * are ordinary `activities` rows of type `lti` whose settings name the tool. The platform's signing
 * key and internal secret are created in the `settings` table on first use, not here.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('lti_tools')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('tool_url', 'text', (c) => c.notNull())
    .addColumn('login_url', 'text', (c) => c.notNull())
    // JSON array of exact redirect URIs.
    .addColumn('redirect_uris', 'text', (c) => c.notNull())
    .addColumn('jwks_url', 'text')
    // A public key as PEM or JWK (JSON), used when there is no JWKS URL.
    .addColumn('public_key', 'text')
    .addColumn('deep_linking_url', 'text')
    // JSON object of custom parameters sent with every launch.
    .addColumn('custom_params', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('share_name', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('share_email', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('allow_ags', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('allow_nrps', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('client_id', 'text', (c) => c.notNull().unique())
    .addColumn('deployment_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  // Line items a tool created through Assignment and Grade Services. The gradebook's own line item of a
  // graded External tool activity isn't stored here: it is the activity itself.
  await s
    .createTable('lti_line_items')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tool_id', 'text', (c) => c.notNull().references('lti_tools.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('resource_link_id', 'text', (c) => c.references('activities.id').onDelete('set null'))
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('score_maximum', 'double precision', (c) => c.notNull())
    .addColumn('resource_id', 'text')
    .addColumn('tag', 'text')
    .addColumn('start_date_time', 'text')
    .addColumn('end_date_time', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('lti_line_items_course_tool_idx').on('lti_line_items').columns(['course_id', 'tool_id']).execute();

  // The latest score a tool sent for a line item and user. `line_item_id` is an lti_line_items id, or the
  // activity id for an activity's gradebook line item (then `activity_id` is set too, so it goes with the activity).
  await s
    .createTable('lti_scores')
    .addColumn('line_item_id', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('tool_id', 'text', (c) => c.notNull().references('lti_tools.id').onDelete('cascade'))
    .addColumn('activity_id', 'text', (c) => c.references('activities.id').onDelete('cascade'))
    .addColumn('score_given', 'double precision')
    .addColumn('score_maximum', 'double precision')
    .addColumn('comment', 'text')
    .addColumn('activity_progress', 'text', (c) => c.notNull())
    .addColumn('grading_progress', 'text', (c) => c.notNull())
    .addColumn('score_timestamp', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('lti_scores_pk', ['line_item_id', 'user_id'])
    .execute();

  // Service access tokens; only a SHA-256 hash of each token is stored.
  await s
    .createTable('lti_access_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tool_id', 'text', (c) => c.notNull().references('lti_tools.id').onDelete('cascade'))
    // JSON array of granted scopes.
    .addColumn('scopes', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('lti_access_tokens_expires_idx').on('lti_access_tokens').column('expires_at').execute();

  // Single-use values (launch hints, deep linking nonces and data, client assertion ids), kept until they expire.
  await s
    .createTable('lti_used_tokens')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('lti_used_tokens_expires_idx').on('lti_used_tokens').column('expires_at').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['lti_used_tokens', 'lti_access_tokens', 'lti_scores', 'lti_line_items', 'lti_tools']) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
