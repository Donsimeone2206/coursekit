import { Hono } from 'hono';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import { readBody } from '../lib/http.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import { getGradebookSetup, gradebookSetupSchema, saveGradebookSetup } from '../services/grade-categories.js';

/** Gradebook setup: grade categories, weights, drop-lowest rules and the course total's aggregation. */
export function gradeCategoryRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.get('/:courseId/grades/setup', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'grades:viewAll');
    return c.json(await getGradebookSetup(db, access.course.id));
  });

  r.put('/:courseId/grades/setup', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'grades:manage', 'Only teachers can change how grades are calculated.');
    assertWritable(access);
    const input = await readBody(c, gradebookSetupSchema);
    const setup = await saveGradebookSetup(db, access.course.id, input);
    deps.events.emit('gradebook.setup.updated', { courseId: access.course.id, userId: user.id });
    return c.json(setup);
  });

  return r;
}
