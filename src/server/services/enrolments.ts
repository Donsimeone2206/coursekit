import type { CourseRole } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { CourseRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { newId, now } from '../lib/util.js';
import { notify } from './notify.js';

type Course = Pick<CourseRow, 'id' | 'slug' | 'title'>;

// Rows per insert, to stay well under SQLite's bound-parameter limit.
const CHUNK = 400;

/**
 * Inserts active enrolments for the users who aren't enrolled in the course yet, and returns their ids.
 * Anyone who already has an enrolment (any role, active or suspended) is left as they are. Pass a transaction
 * to make this part of a larger change, then call {@link announceEnrolments} once it has committed.
 */
export async function insertEnrolments(db: DB, course: Course, userIds: Iterable<string>, role: CourseRole): Promise<string[]> {
  const ids = [...new Set(userIds)];
  const added: string[] = [];
  const ts = now();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .insertInto('enrolments')
      .values(
        ids.slice(i, i + CHUNK).map((userId) => ({
          id: newId(),
          courseId: course.id,
          userId,
          role,
          status: 'active' as const,
          lastAccessAt: null,
          createdAt: ts,
        })),
      )
      .onConflict((oc) => oc.columns(['courseId', 'userId']).doNothing())
      .returning('userId')
      .execute();
    for (const row of rows) added.push(row.userId);
  }
  return added;
}

export interface EnrolmentAnnouncement {
  /** Who enrolled them, named in the notification. */
  actor: { name: string } | null;
  /** How they were enrolled, e.g. "through the cohort Class of 2027". */
  via?: string | undefined;
}

/** Notifies newly enrolled people and emits `enrolment.created` for each of them. */
export async function announceEnrolments(
  deps: Pick<AppDeps, 'db' | 'events'>,
  course: Course,
  userIds: string[],
  role: CourseRole,
  { actor, via }: EnrolmentAnnouncement,
): Promise<void> {
  if (userIds.length === 0) return;
  const as = role === 'assistant' ? 'teaching assistant' : role;
  await notify(deps.db, userIds, {
    type: 'enrolment',
    title: `You were added to ${course.title}`,
    body: `${actor ? `${actor.name} enrolled you` : 'You were enrolled'} as a ${as}${via ? ` ${via}` : ''}.`,
    link: `/courses/${course.slug}`,
  });
  for (const userId of userIds) deps.events.emit('enrolment.created', { courseId: course.id, userId, role });
}

/**
 * Enrols other people in a course: the one code path behind "Enrol people" and cohort enrolment.
 * Skips anyone already enrolled, notifies the new participants and emits `enrolment.created` for each.
 * Returns the ids of the people who were newly enrolled.
 */
export async function enrolUsers(
  deps: Pick<AppDeps, 'db' | 'events'>,
  input: { course: Course; userIds: Iterable<string>; role: CourseRole } & EnrolmentAnnouncement,
): Promise<string[]> {
  const ids = [...new Set(input.userIds)];
  if (ids.length === 0) return [];
  const added = await deps.db.transaction().execute((trx) => insertEnrolments(trx, input.course, ids, input.role));
  await announceEnrolments(deps, input.course, added, input.role, input);
  return added;
}
