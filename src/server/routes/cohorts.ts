import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import { readBody, readQuery } from '../lib/http.js';
import { courseRoleSchema, pageSchema } from '../lib/schemas.js';
import { assertCan, loadCourseAccess } from '../services/access.js';
import {
  addCohortMembers,
  availableCohorts,
  cohortDetail,
  courseCohortLinks,
  createCohort,
  deleteCohort,
  linkCohort,
  listCohortMembers,
  listCohorts,
  loadCohort,
  loadCohortLink,
  removeCohortMember,
  searchCohortCandidates,
  syncCohortLink,
  unlinkCohort,
  updateCohort,
} from '../services/cohorts.js';

const cohortName = z.string().trim().min(1, 'Enter a name').max(100);
const description = z.string().trim().max(1000);

/** Site cohorts, for administrators: `/api/admin/cohorts`. */
export function cohortRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.use('*', async (c, next) => {
    requireAdmin(c);
    await next();
  });

  r.get('/', async (c) => {
    const q = readQuery(c, z.object({ q: z.string().max(100).optional(), ...pageSchema }));
    return c.json(await listCohorts(db, q));
  });

  r.post('/', async (c) => {
    const input = await readBody(c, z.object({ name: cohortName, description: description.default('') }));
    const cohort = await createCohort(deps, input);
    return c.json(await cohortDetail(db, cohort), 201);
  });

  r.get('/:cohortId', async (c) => c.json(await cohortDetail(db, await loadCohort(db, c.req.param('cohortId')))));

  r.patch('/:cohortId', async (c) => {
    const cohort = await loadCohort(db, c.req.param('cohortId'));
    const input = await readBody(c, z.object({ name: cohortName.optional(), description: description.optional() }));
    return c.json(await cohortDetail(db, await updateCohort(deps, cohort, input)));
  });

  /** Deletes the cohort and its course links. Everyone it enrolled stays enrolled. */
  r.delete('/:cohortId', async (c) => {
    await deleteCohort(deps, await loadCohort(db, c.req.param('cohortId')));
    return c.json({ ok: true });
  });

  r.get('/:cohortId/members', async (c) => {
    const cohort = await loadCohort(db, c.req.param('cohortId'));
    const q = readQuery(c, z.object({ q: z.string().max(100).optional(), ...pageSchema }));
    return c.json(await listCohortMembers(db, cohort.id, q));
  });

  /** People to add: search by name or email. Members are marked. */
  r.get('/:cohortId/candidates', async (c) => {
    const cohort = await loadCohort(db, c.req.param('cohortId'));
    const { q } = readQuery(c, z.object({ q: z.string().trim().min(1, 'Type a name or email').max(100) }));
    return c.json(await searchCohortCandidates(db, cohort.id, q));
  });

  /** Adds people by id and/or email. New members are enrolled in the courses the cohort is linked to. */
  r.post('/:cohortId/members', async (c) => {
    const admin = requireUser(c);
    const cohort = await loadCohort(db, c.req.param('cohortId'));
    const input = await readBody(
      c,
      z
        .object({
          userIds: z.array(z.string().min(1).max(40)).max(1000).default([]),
          emails: z.array(z.string().max(320)).max(1000).default([]),
        })
        .refine((v) => v.userIds.length > 0 || v.emails.some((e) => e.trim()), 'Add at least one person'),
    );
    return c.json(await addCohortMembers(deps, cohort, input, admin));
  });

  /** Removes someone from the cohort. Their course enrolments are kept. */
  r.delete('/:cohortId/members/:userId', async (c) => {
    const cohort = await loadCohort(db, c.req.param('cohortId'));
    await removeCohortMember(deps, cohort, c.req.param('userId'));
    return c.json({ ok: true });
  });

  return r;
}

/** Cohort enrolment for one course: `/api/courses/:courseId/cohorts`, with `course:manageParticipants`. */
export function courseCohortRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function manager(c: AppContext) {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId')!);
    assertCan(access, 'course:manageParticipants', 'Only teachers can link cohorts to a course.');
    return access;
  }

  r.get('/:courseId/cohorts', async (c) => {
    const access = await manager(c);
    return c.json(await courseCohortLinks(db, access.course.id));
  });

  /** Cohorts that can still be linked. Teachers see names and member counts, never member lists. */
  r.get('/:courseId/cohorts/available', async (c) => {
    const access = await manager(c);
    return c.json(await availableCohorts(db, access.course.id));
  });

  /** Links a cohort: every member is enrolled now, and members who join later are enrolled when added. */
  r.post('/:courseId/cohorts', async (c) => {
    const access = await manager(c);
    const input = await readBody(
      c,
      z.object({ cohortId: z.string().min(1, 'Choose a cohort').max(40), role: courseRoleSchema.default('student') }),
    );
    const cohort = await loadCohort(db, input.cohortId);
    return c.json(await linkCohort(deps, access.course, cohort, input.role, access.user), 201);
  });

  /** Enrols members who aren't in the course, for example after a teacher removed them. */
  r.post('/:courseId/cohorts/:linkId/sync', async (c) => {
    const access = await manager(c);
    const link = await loadCohortLink(db, access.course.id, c.req.param('linkId'));
    return c.json({ enrolled: await syncCohortLink(deps, access.course, link, access.user) });
  });

  /** Unlinks the cohort. Everyone it enrolled stays enrolled. */
  r.delete('/:courseId/cohorts/:linkId', async (c) => {
    const access = await manager(c);
    await unlinkCohort(deps, await loadCohortLink(db, access.course.id, c.req.param('linkId')));
    return c.json({ ok: true });
  });

  return r;
}
