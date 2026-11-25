import type { DB } from '../db/types.js';
import { newId, now } from '../lib/util.js';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  link?: string | null;
}

/** Sends an in-app notification to each user (deduplicated). */
export async function notify(db: DB, userIds: Iterable<string>, input: NotificationInput): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const createdAt = now();
  const rows = ids.map((userId) => ({
    id: newId(),
    userId,
    type: input.type,
    title: input.title.slice(0, 200),
    body: (input.body ?? '').slice(0, 500),
    link: input.link ?? null,
    readAt: null,
    createdAt,
  }));
  // Stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < rows.length; i += 400) {
    await db
      .insertInto('notifications')
      .values(rows.slice(i, i + 400))
      .execute();
  }
}

export async function courseMemberIds(db: DB, courseId: string, roles: string[] = ['student']): Promise<string[]> {
  const rows = await db
    .selectFrom('enrolments')
    .select('userId')
    .where('courseId', '=', courseId)
    .where('status', '=', 'active')
    .where('role', 'in', roles as never[])
    .execute();
  return rows.map((r) => r.userId);
}
