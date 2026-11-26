import type { Kysely } from 'kysely';

/**
 * Group modes and group-restricted activities (0.3.0).
 *
 * Nothing needs converting when a 0.2.x site upgrades: every course starts with "no groups", every activity
 * follows its course, no activity is restricted to groups and every existing discussion is for all participants.
 * Portable column types only, as in 001_initial, so the same migration runs on SQLite and PostgreSQL.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  // The course's default group mode: none, separate or visible.
  await s
    .alterTable('courses')
    .addColumn('group_mode', 'text', (c) => c.notNull().defaultTo('none'))
    .execute();
  // An activity's own group mode; null follows the course.
  await s.alterTable('activities').addColumn('group_mode', 'text').execute();
  // The group a discussion belongs to; null is a discussion for all participants. Not a foreign key on purpose:
  // when a group is deleted its discussions stay private, and only staff who can access all groups see them.
  await s.alterTable('discussions').addColumn('group_id', 'text').execute();
  await s.createIndex('discussions_activity_group_idx').on('discussions').columns(['activity_id', 'group_id']).execute();

  // An activity limited to the members of these groups (no rows: everyone). group_id is not a foreign key either:
  // an activity restricted to a group that was deleted stays restricted (to nobody) until a teacher changes it.
  await s
    .createTable('activity_groups')
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('activity_groups_pk', ['activity_id', 'group_id'])
    .execute();
  await s.createIndex('activity_groups_course_idx').on('activity_groups').column('course_id').execute();

  // The activity (and forum discussion) a file belongs to, so downloading it follows the activity's rules: hidden,
  // limited to groups, or another group's work. Null for course images, avatars and files not attached to anything.
  await s.alterTable('files').addColumn('activity_id', 'text').execute();
  await s.alterTable('files').addColumn('discussion_id', 'text').execute();
  await linkExistingFiles(db);
}

/** Links the files 0.2.x attached: resource files, submission files, and the uploads forum posts link to. */
async function linkExistingFiles(db: Kysely<any>): Promise<void> {
  const parse = (text: unknown): any => {
    try {
      return JSON.parse(String(text));
    } catch {
      return null;
    }
  };
  const link = async (ids: unknown, context: string, values: Record<string, string>, ownerId?: string) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
    if (list.length === 0) return;
    await db
      .updateTable('files')
      .set(values)
      .where('id', 'in', list)
      .where('context', '=', context)
      .where('activity_id', 'is', null)
      .$if(!!ownerId, (q) => q.where('owner_id', '=', ownerId!))
      .execute();
  };
  const resources = await db.selectFrom('activities').select(['id', 'settings']).where('type', '=', 'resource').execute();
  for (const r of resources) await link([parse(r.settings)?.fileId], 'activity', { activity_id: r.id });
  const submissions = await db.selectFrom('submissions').select(['activity_id', 'file_ids']).where('file_ids', '!=', '[]').execute();
  for (const sub of submissions) await link(parse(sub.file_ids), 'submission', { activity_id: sub.activity_id });
  const posts = await db
    .selectFrom('posts')
    .innerJoin('discussions', 'discussions.id', 'posts.discussion_id')
    .select(['posts.body', 'posts.user_id', 'posts.discussion_id', 'discussions.activity_id'])
    .where('posts.body', 'like', '%/api/files/%')
    .execute();
  for (const p of posts) {
    const ids = [...String(p.body).matchAll(/\/api\/files\/([A-Za-z0-9_-]{1,40})/g)].map((m) => m[1]);
    await link(ids, 'post', { activity_id: p.activity_id, discussion_id: p.discussion_id }, p.user_id);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('files').dropColumn('discussion_id').execute();
  await db.schema.alterTable('files').dropColumn('activity_id').execute();
  await db.schema.dropTable('activity_groups').ifExists().execute();
  await db.schema.dropIndex('discussions_activity_group_idx').ifExists().execute();
  await db.schema.alterTable('discussions').dropColumn('group_id').execute();
  await db.schema.alterTable('activities').dropColumn('group_mode').execute();
  await db.schema.alterTable('courses').dropColumn('group_mode').execute();
}
