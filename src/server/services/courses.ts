import type { CourseSummary, PublicUser } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import type { CourseRow, UserRow } from '../db/schema.js';
import { num, slugify } from '../lib/util.js';
import { progressByCourse } from './progress.js';

/** Builds catalog/dashboard cards for a list of courses, as seen by `user`. */
export async function summarizeCourses(db: DB, user: UserRow | null, courses: CourseRow[]): Promise<CourseSummary[]> {
  if (courses.length === 0) return [];
  const ids = courses.map((c) => c.id);
  const categoryIds = [...new Set(courses.map((c) => c.categoryId).filter((id): id is string => !!id))];

  const [teacherRows, studentRows, activityRows, myEnrolments, categories] = await Promise.all([
    db
      .selectFrom('enrolments')
      .innerJoin('users', 'users.id', 'enrolments.userId')
      .select(['enrolments.courseId', 'users.id', 'users.name', 'users.avatarUrl'])
      .where('enrolments.courseId', 'in', ids)
      .where('enrolments.role', '=', 'teacher')
      .where('enrolments.status', '=', 'active')
      .orderBy('enrolments.createdAt', 'asc')
      .execute(),
    db
      .selectFrom('enrolments')
      .select(['courseId', (eb) => eb.fn.countAll().as('n')])
      .where('courseId', 'in', ids)
      .where('role', '=', 'student')
      .where('status', '=', 'active')
      .groupBy('courseId')
      .execute(),
    db
      .selectFrom('activities')
      .select(['courseId', (eb) => eb.fn.countAll().as('n')])
      .where('courseId', 'in', ids)
      .where('visible', '=', 1)
      .groupBy('courseId')
      .execute(),
    user
      ? db
          .selectFrom('enrolments')
          .select(['courseId', 'role', 'lastAccessAt'])
          .where('userId', '=', user.id)
          .where('courseId', 'in', ids)
          .where('status', '=', 'active')
          .execute()
      : Promise.resolve([]),
    categoryIds.length ? db.selectFrom('categories').select(['id', 'name']).where('id', 'in', categoryIds).execute() : Promise.resolve([]),
  ]);

  const teachers = new Map<string, PublicUser[]>();
  for (const t of teacherRows) {
    const list = teachers.get(t.courseId) ?? [];
    list.push({ id: t.id, name: t.name, avatarUrl: t.avatarUrl });
    teachers.set(t.courseId, list);
  }
  const students = new Map(studentRows.map((r) => [r.courseId, num(r.n)]));
  const activities = new Map(activityRows.map((r) => [r.courseId, num(r.n)]));
  const mine = new Map(myEnrolments.map((e) => [e.courseId, e]));
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const progress = user
    ? await progressByCourse(
        db,
        user.id,
        myEnrolments.filter((e) => e.role === 'student').map((e) => e.courseId),
      )
    : new Map<string, number>();

  return courses.map((c) => {
    const enrolment = mine.get(c.id);
    return {
      id: c.id,
      slug: c.slug,
      title: c.title,
      coverColor: c.coverColor,
      summary: c.summary,
      categoryId: c.categoryId,
      categoryName: c.categoryId ? (categoryNames.get(c.categoryId) ?? null) : null,
      coverImageUrl: c.coverImageUrl,
      visibility: c.visibility,
      enrolment: c.enrolment,
      startDate: c.startDate,
      endDate: c.endDate,
      teachers: teachers.get(c.id) ?? [],
      studentCount: students.get(c.id) ?? 0,
      activityCount: activities.get(c.id) ?? 0,
      myRole: enrolment?.role ?? null,
      progress: enrolment?.role === 'student' ? (progress.get(c.id) ?? 0) : null,
      lastAccessAt: enrolment?.lastAccessAt ?? null,
    };
  });
}

/** Returns `base`, or `base-2`, `base-3`, ... if it is taken. */
export async function uniqueCourseSlug(db: DB, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base, 'course');
  const rows = await db
    .selectFrom('courses')
    .select(['id', 'slug'])
    .where((eb) => eb.or([eb('slug', '=', root), eb('slug', 'like', `${root}-%`)]))
    .execute();
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}
