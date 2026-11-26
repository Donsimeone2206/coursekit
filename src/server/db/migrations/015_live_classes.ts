import type { Kysely } from 'kysely';

/**
 * Live classes (0.4.0): scheduled online class sessions, the provider rooms behind them, attendance and recordings.
 *
 * Only adds tables, so nothing needs converting when a 0.3.0 site upgrades: there are no live classes yet. Live class
 * activities are ordinary `activities` rows of type `live`; provider settings and secrets go in the `settings` table
 * under `live.` when an administrator saves them. Portable column types only, like the earlier migrations.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  // One scheduled session of a live class. Cancelled sessions are kept (status) so calendars can be told.
  await s
    .createTable('live_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('activity_id', 'text', (c) => c.notNull().references('activities.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    // Sessions created together by one repeat share it.
    .addColumn('series_id', 'text')
    .addColumn('title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('agenda', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('starts_at', 'text', (c) => c.notNull())
    .addColumn('ends_at', 'text', (c) => c.notNull())
    .addColumn('duration_minutes', 'integer', (c) => c.notNull())
    // The IANA time zone it was scheduled in (used for repeats and in notifications).
    .addColumn('time_zone', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('scheduled'))
    // Meeting link provider: this session's own link (null uses the class's link).
    .addColumn('meeting_url', 'text')
    // iCalendar SEQUENCE: goes up on every change, so calendar apps replace the old copy.
    .addColumn('sequence', 'integer', (c) => c.notNull().defaultTo(0))
    // Set by the one process that claims the reminder (conditional update), so it is sent once.
    .addColumn('reminded_at', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('live_sessions_activity_idx').on('live_sessions').columns(['activity_id', 'starts_at']).execute();
  await s.createIndex('live_sessions_course_idx').on('live_sessions').columns(['course_id', 'starts_at']).execute();
  await s.createIndex('live_sessions_status_idx').on('live_sessions').columns(['status', 'starts_at']).execute();

  // A provider-side room for a session: one for the whole class, or one per group (group_key is '' or the group id).
  // session_id and activity_id become null when the session or the class is deleted, so the background worker can
  // still delete the meeting at the provider before it removes the row.
  await s
    .createTable('live_rooms')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('session_id', 'text', (c) => c.references('live_sessions.id').onDelete('set null'))
    .addColumn('activity_id', 'text', (c) => c.references('activities.id').onDelete('set null'))
    .addColumn('course_id', 'text')
    .addColumn('group_key', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('group_id', 'text')
    .addColumn('provider', 'text', (c) => c.notNull())
    // BigBlueButton meetingID, Jitsi room name: random and unguessable.
    .addColumn('room_key', 'text', (c) => c.notNull().unique())
    // Zoom meeting id.
    .addColumn('external_id', 'text')
    // BigBlueButton createTime of the current run.
    .addColumn('run_id', 'text')
    // Zoom join URL for participants. Never sent to the browser except as the redirect of a join.
    .addColumn('join_url', 'text')
    // Zoom host the meeting was created for.
    .addColumn('host', 'text')
    // Hash of what was last sent to the provider, so changes are only pushed when something changed.
    .addColumn('synced_hash', 'text')
    // active, or delete (to be deleted at the provider).
    .addColumn('state', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('sync_error', 'text')
    .addColumn('sync_attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_sync_at', 'text')
    // Lease of the process working on the room (conditional update), so two servers never create two meetings.
    .addColumn('claim_id', 'text')
    .addColumn('claimed_until', 'text')
    .addColumn('started_at', 'text')
    .addColumn('ended_at', 'text')
    .addColumn('last_polled_at', 'text')
    // Fetching recordings and attendance after the meeting: how often it was tried and when to try again.
    .addColumn('follow_up_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_follow_up_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('live_rooms_session_group_uq', ['session_id', 'group_key'])
    .execute();
  await s.createIndex('live_rooms_external_idx').on('live_rooms').column('external_id').execute();
  await s.createIndex('live_rooms_activity_idx').on('live_rooms').column('activity_id').execute();
  await s.createIndex('live_rooms_state_idx').on('live_rooms').columns(['state', 'next_sync_at']).execute();

  // Evidence that someone was in a session: Coursekit's join log (source `join`) and what the provider reports
  // (BigBlueButton's meeting info and analytics, Zoom's webhooks and participant report). source_key makes repeated
  // deliveries of the same event idempotent. user_id is null for people who don't match a course participant.
  await s
    .createTable('live_presence')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('session_id', 'text', (c) => c.notNull().references('live_sessions.id').onDelete('cascade'))
    .addColumn('room_id', 'text')
    .addColumn('group_key', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('source_key', 'text', (c) => c.notNull())
    .addColumn('name', 'text')
    .addColumn('role', 'text')
    .addColumn('joined_at', 'text', (c) => c.notNull())
    .addColumn('left_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('live_presence_source_uq', ['session_id', 'source', 'source_key'])
    .execute();
  await s.createIndex('live_presence_user_idx').on('live_presence').columns(['user_id', 'session_id']).execute();

  // Attendance a teacher marked by hand. It wins over the provider and the join log.
  await s
    .createTable('live_attendance')
    .addColumn('session_id', 'text', (c) => c.notNull().references('live_sessions.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('marked_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('marked_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('live_attendance_pk', ['session_id', 'user_id'])
    .execute();
  await s.createIndex('live_attendance_user_idx').on('live_attendance').column('user_id').execute();
  await s.createIndex('live_attendance_course_idx').on('live_attendance').column('course_id').execute();

  // Recordings of a session: from the provider (external_id is its recording id) or links staff added.
  // Removed provider recordings keep a row (removed_at) so fetching them again doesn't bring them back.
  await s
    .createTable('live_recordings')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('session_id', 'text', (c) => c.notNull().references('live_sessions.id').onDelete('cascade'))
    .addColumn('course_id', 'text', (c) => c.notNull().references('courses.id').onDelete('cascade'))
    .addColumn('room_id', 'text')
    .addColumn('group_key', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('external_id', 'text')
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('passcode', 'text')
    .addColumn('duration_minutes', 'integer')
    .addColumn('recorded_at', 'text')
    .addColumn('hidden', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('removed_at', 'text')
    .addColumn('added_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('live_recordings_external_uq', ['session_id', 'source', 'external_id'])
    .execute();
  await s.createIndex('live_recordings_course_idx').on('live_recordings').column('course_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['live_recordings', 'live_attendance', 'live_presence', 'live_rooms', 'live_sessions']) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
