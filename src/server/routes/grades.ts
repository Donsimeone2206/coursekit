import { Hono } from 'hono';
import { z } from 'zod';
import { categoriesWithItems, usesCategories } from '../../shared/grades.js';
import type { Gradebook } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { DB } from '../db/types.js';
import { badRequest, notFound, readBody, readQuery } from '../lib/http.js';
import { assertCan, loadCourseAccess, type CourseAccess } from '../services/access.js';
import { buildCourseGradebook, buildStudentGrades } from '../services/gradebook.js';
import { upsertGrade } from '../services/grades.js';
import { findVisibleGroup, groupMemberIds } from '../services/groups.js';
import { notify } from '../services/notify.js';

/** Grade items, categories and totals come from services/gradebook.ts (course totals: services/course-total.ts). */
async function buildGradebook(db: DB, access: CourseAccess, groupId?: string): Promise<Gradebook> {
  // With a group, rows and averages cover only its members.
  const group = groupId ? await findVisibleGroup(db, access, groupId) : null;
  const students = await db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
    .where('enrolments.courseId', '=', access.course.id)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .$if(!!group, (q) => q.where('enrolments.userId', 'in', groupMemberIds(db, group!.id)))
    .orderBy('users.name', 'asc')
    .execute();
  return buildCourseGradebook(db, access.course.id, students);
}

const groupQuery = z.object({ groupId: z.string().max(40).optional() });

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function gradeRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.get('/:courseId/grades', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:view');
    if (access.can('grades:viewAll')) {
      const { groupId } = readQuery(c, groupQuery);
      return c.json({ kind: 'gradebook' as const, gradebook: await buildGradebook(db, access, groupId) });
    }
    return c.json({ kind: 'mine' as const, grades: await buildStudentGrades(db, access.course.id, user.id) });
  });

  r.get('/:courseId/grades/export.csv', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'grades:viewAll');
    const book = await buildGradebook(db, access, readQuery(c, groupQuery).groupId);
    // Courses that use categories get a subtotal column per category, just before the total.
    const groups = usesCategories(book) ? categoriesWithItems(book.categories, book.items) : [];
    const header = [
      'Name',
      'Email',
      ...book.items.map((i) => `${i.title} (/${i.maxGrade})`),
      ...groups.map((g) => `${g.name} total (%)`),
      'Total',
      'Percentage',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const row of book.rows) {
      lines.push(
        [
          row.user.name,
          row.user.email,
          ...book.items.map((i) => row.cells[i.activityId]?.score ?? ''),
          ...groups.map((g) => row.categories[g.id]?.percentage ?? ''),
          row.total,
          row.percentage ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${access.course.slug}-grades.csv"`);
    return c.body(lines.join('\n'));
  });

  /** Set (or clear) a grade directly from the gradebook. */
  r.put('/:courseId/grades/:activityId/:userId', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'grades:edit');
    const input = await readBody(
      c,
      z.object({ score: z.number().min(0).nullable(), feedback: z.string().max(20_000).nullable().optional() }),
    );
    const activity = await db
      .selectFrom('activities')
      .selectAll()
      .where('id', '=', c.req.param('activityId'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!activity || activity.maxGrade == null) throw notFound('Grade item');
    if (input.score != null && input.score > activity.maxGrade) throw badRequest(`The maximum grade is ${activity.maxGrade}.`);
    const student = await db
      .selectFrom('enrolments')
      .select('userId')
      .where('courseId', '=', access.course.id)
      .where('userId', '=', c.req.param('userId'))
      .where('role', '=', 'student')
      .executeTakeFirst();
    if (!student) throw notFound('Student');

    await upsertGrade(deps, {
      activityId: activity.id,
      courseId: access.course.id,
      userId: student.userId,
      score: input.score,
      feedback: input.feedback,
      gradedBy: user.id,
    });
    if (input.score != null) {
      await notify(db, [student.userId], {
        type: 'grade',
        title: `New grade for ${activity.title}`,
        body: `You received ${input.score} / ${activity.maxGrade}.`,
        link: `/courses/${access.course.slug}/grades`,
      });
    }
    return c.json({ ok: true });
  });

  return r;
}
