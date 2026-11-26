/**
 * cmi5 routes.
 *
 * Outside /api (mounted with app.route('/', ...)), called by AUs from any origin, without cookies:
 *  - POST /cmi5/fetch/<token>: the one-time fetch URL of a launch (section 8.2). It answers once with the
 *    auth-token JSON and afterwards with the specification's error JSON (always HTTP 200, as 8.2.1 asks).
 *  - GET /cmi5/return/<course slug>/<activity id>: the returnURL of LMS.LaunchData. It tells the player that
 *    the AU finished (postMessage) or, opened in a window of its own, goes back to the activity page.
 *
 * Under /api (session, CSRF): GET /api/packages/:activityId/cmi5 (course structure and statuses),
 * POST /api/packages/:activityId/cmi5/launch and GET /api/packages/:activityId/cmi5/report.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Cmi5Info, Cmi5Report, Cmi5ReportAttempt, Cmi5TocNode } from '../../../shared/cmi5.js';
import { requireUser, type AppDeps, type AppEnv } from '../../context.js';
import type { PackageAttemptRow, PackageVersionRow } from '../../db/schema-packages.js';
import { badRequest, readBody } from '../../lib/http.js';
import { now, randomToken, round } from '../../lib/util.js';
import { assertCan, loadActivityAccess, type ActivityAccess } from '../../services/access.js';
import { studentScope, whereInScope, type StudentScope } from '../../services/group-modes.js';
import { currentVersion, launch, toAttemptInfos } from '../service.js';
import { CREDENTIAL_DAYS } from './constants.js';
import { abandonTimedOut, type Cmi5LaunchInput } from './launch.js';
import {
  auFinished,
  auSatisfied,
  auScore,
  auStatus,
  blockStatus,
  courseSatisfied,
  loadAuStates,
  nodeSatisfied,
  type AuStates,
} from './results.js';
import { allAus, courseOfVersion, pickLang, type Cmi5Course, type Cmi5Node } from './structure.js';
import { cmi5Secret, signCmi5Token, verifyCmi5Token } from './tokens.js';

const percent = (scaled: number | null) => (scaled === null ? null : round(scaled * 100, 2));

function publicHeaders(c: Context) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'no-store');
  // AUs hosted elsewhere call the fetch URL from their own origin.
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex');
}

export function cmi5PublicRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.options('/cmi5/fetch/:token', (c) => {
    publicHeaders(c);
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Experience-API-Version');
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  });

  r.post(
    '/cmi5/fetch/:token',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => {
        publicHeaders(c);
        return c.json({ 'error-code': '3', 'error-text': 'The request is too large.' });
      },
    }),
    async (c) => {
      publicHeaders(c);
      const fail = (code: '1' | '2' | '3', text: string) => c.json({ 'error-code': code, 'error-text': text });
      const secret = await cmi5Secret(db);
      const check = verifyCmi5Token(secret, 'fetch', c.req.param('token'));
      if (!check.ok) {
        return check.reason === 'expired'
          ? fail('1', 'This launch has expired. Go back to the activity and open it again.')
          : fail('2', 'This launch link is not valid.');
      }
      const session = await db.selectFrom('cmi5Sessions').selectAll().where('id', '=', check.sessionId).executeTakeFirst();
      if (!session) return fail('2', 'This launch link is not valid.');
      if (session.abandonedAt || session.terminatedAt)
        return fail('1', 'This session has ended. Go back to the activity and open it again.');
      const user = await db.selectFrom('users').selectAll().where('id', '=', session.userId).executeTakeFirst();
      let allowed = !!user && user.status === 'active';
      if (user && allowed) {
        try {
          const access = await loadActivityAccess(db, user, session.activityId);
          allowed = !session.attemptId || access.enrolment?.role === 'student';
        } catch {
          allowed = false;
        }
      }
      if (!allowed) return fail('2', 'You can no longer open this activity.');
      const ts = now();
      const claimed = await db
        .updateTable('cmi5Sessions')
        .set({ fetchedAt: ts, lastActivityAt: ts })
        .where('id', '=', session.id)
        .where('fetchedAt', 'is', null)
        .where('terminatedAt', 'is', null)
        .where('abandonedAt', 'is', null)
        .executeTakeFirst();
      // The fetch URL is a one-time URL (section 8.2.3).
      if (Number(claimed.numUpdatedRows) === 0) return fail('1', 'The authorization token has already been returned.');
      const auth = signCmi5Token(secret, 'auth', session.id, CREDENTIAL_DAYS * 86_400);
      return c.json({ 'auth-token': Buffer.from(`cmi5:${auth}`).toString('base64') });
    },
  );

  r.all('/cmi5/fetch/:token', (c) => {
    publicHeaders(c);
    c.header('Allow', 'POST, OPTIONS');
    return c.json({ 'error-code': '3', 'error-text': 'Use POST to get the authorization token.' }, 405);
  });

  r.get('/cmi5/return/:slug/:activityId', (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('activityId');
    const path = /^[a-z0-9-]{1,160}$/.test(slug) && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `/courses/${slug}/activities/${id}` : '/';
    const nonce = randomToken(16);
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    );
    const target = JSON.stringify(path).replace(/</g, '\\u003c');
    return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Back to Coursekit</title>
<style nonce="${nonce}">:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7fb;color:#151826}
@media (prefers-color-scheme:dark){body{background:#12131a;color:#eceef6}a{color:#8b85ff}}main{max-width:420px;text-align:center}a{color:#4f46e5;font-weight:600}</style>
</head>
<body>
<main><h1 style="font-size:18px">You're done here</h1><p>Taking you back to the activity… <a href="${path}">Go back to the activity</a></p></main>
<script nonce="${nonce}">(function () {
  var message = { source: 'coursekit-cmi5', type: 'returned' };
  if (window.top !== window) { window.top.postMessage(message, '*'); return; }
  try { if (window.opener) window.opener.postMessage(message, '*'); } catch (e) {}
  window.close();
  setTimeout(function () { location.replace(${target}); }, 300);
})();</script>
</body>
</html>`);
  });

  // Everything else under /cmi5 is answered here (never by the web app's fallback).
  r.all('/cmi5', (c) => c.json({ error: { message: 'Not found.' } }, 404));
  r.all('/cmi5/*', (c) => c.json({ error: { message: 'Not found.' } }, 404));
  return r;
}

// ----- the API -----

const isLearner = (access: ActivityAccess) => access.enrolment?.role === 'student';

function tocNodes(course: Cmi5Course, states: AuStates | null, reviewAll: boolean): Cmi5TocNode[] {
  const out: Cmi5TocNode[] = [];
  const walk = (nodes: Cmi5Node[], depth: number) => {
    for (const n of nodes) {
      const base = { key: n.key, title: pickLang(n.title) || 'Untitled', description: pickLang(n.description), depth };
      if (n.type === 'block') {
        out.push({
          ...base,
          kind: 'block',
          status: states ? blockStatus(n, states) : 'not attempted',
          satisfied: states ? nodeSatisfied(n, states) : false,
          score: null,
          moveOn: null,
          masteryScore: null,
          launchMethod: null,
          external: false,
          review: false,
        });
        walk(n.children, depth + 1);
        continue;
      }
      const state = states?.get(n.key);
      out.push({
        ...base,
        kind: 'au',
        status: states ? auStatus(n, state) : 'not attempted',
        satisfied: states ? auSatisfied(n, state) : false,
        score: percent(auScore(state)),
        moveOn: n.moveOn,
        masteryScore: n.masteryScore,
        launchMethod: n.launchMethod,
        external: n.external,
        review: reviewAll || (!!states && auFinished(n, state)),
      });
    }
  };
  walk(course.children, 0);
  return out;
}

async function versionById(deps: AppDeps, id: string): Promise<PackageVersionRow | undefined> {
  return deps.db.selectFrom('packageVersions').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function cmi5Info(deps: AppDeps, access: ActivityAccess): Promise<Cmi5Info> {
  const { db } = deps;
  const { activity } = access;
  let attempt: PackageAttemptRow | null = null;
  let version: PackageVersionRow | undefined;
  if (isLearner(access)) {
    const attempts = await db
      .selectFrom('packageAttempts')
      .selectAll()
      .where('activityId', '=', activity.id)
      .where('userId', '=', access.user.id)
      .orderBy('attemptNumber', 'asc')
      .execute();
    attempt = attempts.find((a) => a.status === 'in_progress') ?? attempts[attempts.length - 1] ?? null;
    if (attempt) {
      version = await versionById(deps, attempt.versionId);
      if (version?.kind !== 'cmi5') attempt = null;
      else {
        await abandonTimedOut(deps, { activityId: activity.id, attemptIds: [attempt.id] });
        attempt = (await db.selectFrom('packageAttempts').selectAll().where('id', '=', attempt.id).executeTakeFirst()) ?? null;
      }
    }
  }
  if (!attempt) version = await currentVersion(db, activity.id);
  const course = version && courseOfVersion(version);
  if (!version || !course) throw badRequest('This activity has no cmi5 course yet.');
  const states = attempt ? await loadAuStates(db, attempt.id) : null;
  // As launchCmi5 decides: Review for the AUs the learner finished, and everywhere in an archived course. A
  // finished attempt (the course is satisfied) still opens the other AUs in Normal mode.
  const reviewAll = !!attempt && access.readOnly;
  return {
    activityId: activity.id,
    attemptId: attempt?.id ?? null,
    attemptNumber: attempt?.attemptNumber ?? null,
    attemptStatus: attempt?.status ?? null,
    version: version.version,
    course: {
      title: pickLang(course.title) || version.title,
      description: pickLang(course.description),
      satisfied: states ? courseSatisfied(course, states) : false,
    },
    nodes: tocNodes(course, states, reviewAll),
  };
}

export async function cmi5Report(
  deps: AppDeps,
  access: ActivityAccess,
  scope?: Pick<StudentScope, 'groupIds' | 'restrictedTo'>,
): Promise<Cmi5Report> {
  const { db } = deps;
  const { activity } = access;
  await abandonTimedOut(deps, { activityId: activity.id });
  let studentsQuery = db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
    .where('enrolments.courseId', '=', activity.courseId)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .orderBy('users.name', 'asc');
  if (scope) studentsQuery = whereInScope(db, studentsQuery, 'enrolments.userId', scope);
  const students = await studentsQuery.execute();
  const ids = students.map((s) => s.id);
  const [attempts, grades, completions] = ids.length
    ? await Promise.all([
        db
          .selectFrom('packageAttempts')
          .selectAll()
          .where('activityId', '=', activity.id)
          .where('userId', 'in', ids)
          .orderBy('attemptNumber', 'asc')
          .execute(),
        db.selectFrom('grades').select(['userId', 'score']).where('activityId', '=', activity.id).where('userId', 'in', ids).execute(),
        db.selectFrom('completions').select('userId').where('activityId', '=', activity.id).where('userId', 'in', ids).execute(),
      ])
    : [[], [], []];
  const infos = await toAttemptInfos(db, attempts);
  const versionIds = [...new Set(attempts.map((a) => a.versionId))];
  const versions = versionIds.length ? await db.selectFrom('packageVersions').selectAll().where('id', 'in', versionIds).execute() : [];
  const courses = new Map(versions.map((v) => [v.id, courseOfVersion(v)]));
  const attemptIds = attempts.filter((a) => courses.get(a.versionId)).map((a) => a.id);
  const stateRows = attemptIds.length ? await db.selectFrom('cmi5AuStates').selectAll().where('attemptId', 'in', attemptIds).execute() : [];
  const statesOf = new Map<string, AuStates>();
  for (const row of stateRows) {
    const map = statesOf.get(row.attemptId) ?? new Map();
    map.set(row.auKey, row);
    statesOf.set(row.attemptId, map);
  }
  const byUser = new Map<string, Cmi5ReportAttempt[]>();
  for (const [i, a] of attempts.entries()) {
    const course = courses.get(a.versionId);
    const states = statesOf.get(a.id) ?? new Map();
    const aus: Cmi5ReportAttempt['aus'] = {};
    if (course)
      for (const au of allAus(course.children))
        aus[au.key] = { status: auStatus(au, states.get(au.key)), score: percent(auScore(states.get(au.key))) };
    const list = byUser.get(a.userId) ?? [];
    list.push({ ...infos[i]!, satisfied: !!course && courseSatisfied(course, states), aus });
    byUser.set(a.userId, list);
  }
  const current = await currentVersion(db, activity.id);
  const currentCourse = current && courseOfVersion(current);
  const gradeMap = new Map(grades.map((g) => [g.userId, g.score]));
  const done = new Set(completions.map((c) => c.userId));
  return {
    maxGrade: activity.maxGrade,
    aus: currentCourse ? allAus(currentCourse.children).map((au) => ({ key: au.key, title: pickLang(au.title) || 'Untitled' })) : [],
    rows: students.map((s) => ({
      user: { id: s.id, name: s.name, avatarUrl: s.avatarUrl, email: s.email },
      attempts: byUser.get(s.id) ?? [],
      grade: gradeMap.get(s.id) ?? null,
      completed: done.has(s.id),
    })),
  };
}

export function cmi5ApiRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function packageAccess(c: Parameters<typeof requireUser>[0]) {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId')!);
    if (access.activity.type !== 'package') throw badRequest('This activity is not a SCORM, xAPI or cmi5 package.');
    return access;
  }

  r.get('/packages/:activityId/cmi5', async (c) => c.json(await cmi5Info(deps, await packageAccess(c))));

  r.post('/packages/:activityId/cmi5/launch', async (c) => {
    const access = await packageAccess(c);
    const input = await readBody(
      c,
      z.object({
        itemId: z.string().max(500).optional(),
        attemptId: z.string().max(64).optional(),
        newAttempt: z.boolean().optional(),
        preview: z.boolean().optional(),
      }),
    );
    // The learner's languages go into the cmi5LearnerPreferences document.
    const body: Cmi5LaunchInput = { ...input, languages: c.req.header('accept-language')?.slice(0, 500) ?? null };
    // 409 for a version that isn't a cmi5 course (the page was open while the teacher replaced it).
    return c.json(await launch(deps, access, body, new URL(c.req.url).origin, { kind: 'cmi5' }));
  });

  r.get('/packages/:activityId/cmi5/report', async (c) => {
    const access = await packageAccess(c);
    assertCan(access, 'grades:viewAll');
    // Separate groups: teaching assistants only see the students of their own groups.
    const scope = await studentScope(db, access, c.req.query('groupId'));
    return c.json(await cmi5Report(deps, access, scope));
  });

  return r;
}
