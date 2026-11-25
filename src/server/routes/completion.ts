import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_CERTIFICATE, type CourseCompletionSettingsResponse } from '../../shared/completion.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import { readBody } from '../lib/http.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import { summarizeCertificates } from '../services/certificates.js';
import {
  completionActivities,
  completionReport,
  completionStatus,
  evaluateCompletion,
  loadCompletionSettings,
  saveCompletionSettings,
  toCompletionSettings,
} from '../services/completion.js';

const settingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['all', 'selected']).default('all'),
  activityIds: z.array(z.string().max(40)).max(1000).default([]),
  minGrade: z.number().min(0, 'Use a grade from 0 to 100').max(100, 'Use a grade from 0 to 100').nullable().default(null),
  certificate: z
    .object({
      enabled: z.boolean().default(false),
      title: z.string().trim().min(1, 'Add a certificate title').max(120),
      body: z.string().trim().min(1, 'Add the certificate text').max(2000),
      signatureName: z.string().trim().max(100).default(''),
      signatureTitle: z.string().trim().max(100).default(''),
    })
    .default({ ...DEFAULT_CERTIFICATE }),
});

/** Course completion: criteria settings, the student's checklist, the teacher's report and issued certificates. */
export function completionRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  /** The signed-in user's status. Students are checked on the spot, so the card is never out of date. */
  r.get('/:courseId/completion', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:view');
    if (access.role === 'student') await evaluateCompletion(deps, access.course.id, [user.id]);
    return c.json(await completionStatus(db, access.course.id, user.id));
  });

  r.get('/:courseId/completion/report', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'completion:viewReport');
    // Catches completions that structural changes (an activity hidden or deleted) made possible.
    await evaluateCompletion(deps, access.course.id);
    return c.json(await completionReport(db, access.course.id));
  });

  r.get('/:courseId/completion/settings', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'completion:manage');
    const [row, activities] = await Promise.all([loadCompletionSettings(db, access.course.id), completionActivities(db, access.course.id)]);
    const body: CourseCompletionSettingsResponse = { settings: toCompletionSettings(row), activities };
    return c.json(body);
  });

  r.put('/:courseId/completion/settings', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'completion:manage');
    assertWritable(access);
    const input = await readBody(c, settingsSchema);
    return c.json(await saveCompletionSettings(deps, access.course, input, user.id));
  });

  /** Certificates issued in this course, including revoked ones and those of people who have left. */
  r.get('/:courseId/certificates', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'completion:viewReport');
    const rows = await db
      .selectFrom('certificates')
      .selectAll()
      .where('courseId', '=', access.course.id)
      .orderBy('issuedAt', 'desc')
      .orderBy('recipientName', 'asc')
      .execute();
    return c.json(await summarizeCertificates(db, rows));
  });

  return r;
}
