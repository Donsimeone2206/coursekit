import { Hono } from 'hono';
import { z } from 'zod';
import type { Gradebook, GradebookItem, GradebookRow, MyGrades } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { DB } from '../db/index.js';
import { badRequest, notFound, readBody } from '../lib/http.js';
import { round } from '../lib/util.js';
import { assertCan, loadCourseAccess, type CourseAccess } from '../services/access.js';
import { upsertGrade } from '../services/grades.js';
import { notify } from '../services/notify.js';

/** Graded activities in course order. Hidden items are only included for staff. */
async function gradeItems(db: DB, courseId: string, includeHidden: boolean): Promise<GradebookItem[]> {
  const rows = await db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .select([
      'activities.id',
      'activities.title',
      'activities.type',
      'activities.maxGrade',
      'activities.dueAt',
      'activities.visible',
      'sections.visible as sectionVisible',
    ])
    .where('activities.courseId', '=', courseId)
    .where('activities.maxGrade', 'is not', null)
    .orderBy('sections.position', 'asc')
    .orderBy('activities.position', 'asc')
    .execute();
  return rows
    .filter((r) => includeHidden || (r.visible && r.sectionVisible))
    .map((r) => ({ activityId: r.id, title: r.title, type: r.type, maxGrade: r.maxGrade ?? 0, dueAt: r.dueAt }));
}

async function buildGradebook(db: DB, access: CourseAccess): Promise<Gradebook> {
  const items = await gradeItems(db, access.course.id, true);
  const students = await db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
    .where('enrolments.courseId', '=', access.course.id)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .orderBy('users.name', 'asc')
    .execute();
  const grades = await db.selectFrom('grades').selectAll().where('courseId', '=', access.course.id).execute();
  const byKey = new Map(grades.map((g) => [`${g.activityId}:${g.userId}`, g]));

  const rows: GradebookRow[] = students.map((s) => {
    const cells: GradebookRow['cells'] = {};
    let total = 0;
    let max = 0;
    for (const item of items) {
      const g = byKey.get(`${item.activityId}:${s.id}`);
      cells[item.activityId] = { score: g?.score ?? null, feedback: g?.feedback ?? null };
      if (g?.score != null) {
        total += g.score;
        max += item.maxGrade;
      }
    }
    return {
      user: { id: s.id, name: s.name, email: s.email, avatarUrl: s.avatarUrl },
      cells,
      total: round(total),
      max: round(max),
      percentage: max > 0 ? round((total / max) * 100, 1) : null,
    };
  });

  const averages: Gradebook['averages'] = {};
  for (const item of items) {
    const scores = rows.map((r) => r.cells[item.activityId]?.score).filter((s): s is number => s != null);
    averages[item.activityId] = scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  }
  const percents = rows.map((r) => r.percentage).filter((p): p is number => p != null);
  return {
    items,
    rows,
    averages,
    courseAverage: percents.length ? round(percents.reduce((a, b) => a + b, 0) / percents.length, 1) : null,
  };
}

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
    if (access.can('grades:viewAll')) return c.json({ kind: 'gradebook' as const, gradebook: await buildGradebook(db, access) });

    const items = await gradeItems(db, access.course.id, false);
    const grades = await db
      .selectFrom('grades')
      .selectAll()
      .where('courseId', '=', access.course.id)
      .where('userId', '=', user.id)
      .execute();
    const byActivity = new Map(grades.map((g) => [g.activityId, g]));
    let total = 0;
    let max = 0;
    const mine: MyGrades = {
      items: items.map((item) => {
        const g = byActivity.get(item.activityId);
        if (g?.score != null) {
          total += g.score;
          max += item.maxGrade;
        }
        return { ...item, score: g?.score ?? null, feedback: g?.feedback ?? null, gradedAt: g?.gradedAt ?? null };
      }),
      total: round(total),
      max: round(max),
      percentage: max > 0 ? round((total / max) * 100, 1) : null,
    };
    return c.json({ kind: 'mine' as const, grades: mine });
  });

  r.get('/:courseId/grades/export.csv', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'grades:viewAll');
    const book = await buildGradebook(db, access);
    const header = ['Name', 'Email', ...book.items.map((i) => `${i.title} (/${i.maxGrade})`), 'Total', 'Percentage'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of book.rows) {
      lines.push(
        [row.user.name, row.user.email, ...book.items.map((i) => row.cells[i.activityId]?.score ?? ''), row.total, row.percentage ?? '']
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
