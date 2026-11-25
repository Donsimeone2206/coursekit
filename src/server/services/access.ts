import { getCourseCapabilities, type CourseCapability } from '../../shared/permissions.js';
import type { CourseRole } from '../../shared/types.js';
import type { DB } from '../db/index.js';
import type { ActivityRow, CourseRow, EnrolmentRow, UserRow } from '../db/schema.js';
import { forbidden, notFound } from '../lib/http.js';

export interface CourseAccess {
  course: CourseRow;
  user: UserRow;
  /** The user's active enrolment, if any. */
  enrolment: EnrolmentRow | null;
  role: CourseRole | null;
  capabilities: CourseCapability[];
  /** Archived courses are read-only for everyone except course managers. */
  readOnly: boolean;
  can(cap: CourseCapability): boolean;
}

export interface ActivityAccess extends CourseAccess {
  activity: ActivityRow;
}

export async function findCourse(db: DB, idOrSlug: string): Promise<CourseRow | undefined> {
  return db
    .selectFrom('courses')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', idOrSlug), eb('slug', '=', idOrSlug)]))
    .executeTakeFirst();
}

export async function loadCourseAccess(db: DB, user: UserRow, idOrSlug: string): Promise<CourseAccess> {
  const course = await findCourse(db, idOrSlug);
  if (!course) throw notFound('Course');

  const enrolment =
    (await db
      .selectFrom('enrolments')
      .selectAll()
      .where('courseId', '=', course.id)
      .where('userId', '=', user.id)
      .where('status', '=', 'active')
      .executeTakeFirst()) ?? null;

  const role = enrolment?.role ?? null;
  const capabilities = getCourseCapabilities(user.role, role);
  const can = (cap: CourseCapability) => capabilities.includes(cap);

  if (course.visibility === 'draft' && !can('course:viewHidden')) throw notFound('Course');

  return {
    course,
    user,
    enrolment,
    role,
    capabilities,
    readOnly: course.visibility === 'archived' && !can('course:update'),
    can,
  };
}

export function assertCan(access: CourseAccess, cap: CourseCapability, message?: string): void {
  if (!access.can(cap)) throw forbidden(message);
}

export function assertWritable(access: CourseAccess): void {
  if (access.readOnly) throw forbidden('This course is archived and read-only.');
}

/** Loads an activity and checks that the user may view it (enrolled, and visible unless they can see hidden items). */
export async function loadActivityAccess(db: DB, user: UserRow, activityId: string): Promise<ActivityAccess> {
  const activity = await db.selectFrom('activities').selectAll().where('id', '=', activityId).executeTakeFirst();
  if (!activity) throw notFound('Activity');
  const access = await loadCourseAccess(db, user, activity.courseId);
  if (!access.can('course:view')) throw forbidden('Enrol in this course to open its activities.');
  if (!access.can('course:viewHidden')) {
    const section = await db.selectFrom('sections').select('visible').where('id', '=', activity.sectionId).executeTakeFirst();
    if (!activity.visible || !section?.visible) throw notFound('Activity');
  }
  return { ...access, activity };
}
