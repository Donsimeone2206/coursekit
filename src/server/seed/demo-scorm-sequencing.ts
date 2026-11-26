/**
 * Demo data for SCORM 2004 sequencing: the "Inclusive design" package (demo-sequencing-content.ts) at
 * the end of the Accessibility section of UX Design Principles (made by demo-packages.ts), and an
 * attempt in progress for Lucas Silva, played through the real launch and commit code: his pre-test
 * showed he knows module 1 (so it was skipped), he finished the first lesson of module 2 and suspended
 * in the second. Alex Johnson has no attempt, so the package can be played from the start.
 */
import type { AppDeps } from '../context.js';
import type { ActivityRow } from '../db/schema.js';
import { EventBus } from '../lib/events.js';
import { newId } from '../lib/util.js';
import { applyCommit, importPackage, launch as launchPackage, loadRuntimeContext } from '../packages/service.js';
import { packageSecret, verifyToken } from '../packages/tokens.js';
import { loadActivityAccess } from '../services/access.js';
import type { PackageLaunch } from '../../shared/packages.js';
import { inclusiveDesignZip } from './demo-sequencing-content.js';

const DAY = 86_400_000;
const daysAgo = (days: number, hour = 10, minute = 0) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

export async function seedScormSequencingDemo(base: Pick<AppDeps, 'db' | 'events'>): Promise<void> {
  const full = base as Partial<AppDeps>;
  if (!full.storage || !full.config) return; // the package files need file storage
  // Demo history is recorded quietly, without notifications or events.
  const deps = { db: base.db, events: new EventBus(), storage: full.storage, config: full.config };
  const { db } = deps;
  const course = await db.selectFrom('courses').selectAll().where('slug', '=', 'ux-design-principles').executeTakeFirst();
  if (!course) return;
  const section = await db
    .selectFrom('sections')
    .selectAll()
    .where('courseId', '=', course.id)
    .where('title', '=', 'Accessibility')
    .executeTakeFirst();
  const maya = await db.selectFrom('users').selectAll().where('email', '=', 'maya.chen@coursekit.test').executeTakeFirst();
  if (!section || !maya) return;

  const last = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  const activity: ActivityRow = {
    id: newId(),
    courseId: course.id,
    sectionId: section.id,
    type: 'package',
    title: 'Inclusive design',
    description:
      'A short SCORM 2004 course with sequencing: a pre-test skips the modules you already know, the two modules open in order, and the final quiz (80% to pass) unlocks once both are done.',
    position: last?.m == null ? 0 : Number(last.m) + 1,
    visible: 1,
    settings: JSON.stringify({ display: 'embed', attemptsAllowed: 0, gradingMethod: 'highest', requirePass: true }),
    dueAt: null,
    maxGrade: 100,
    completion: 'auto',
    groupMode: null,
    createdBy: maya.id,
    createdAt: daysAgo(8),
    updatedAt: daysAgo(8),
  };
  await db.insertInto('activities').values(activity).execute();
  const version = await importPackage(deps, activity, maya, inclusiveDesignZip(), 'inclusive-design-scorm2004.zip');
  await db
    .updateTable('packageVersions')
    .set({ createdAt: daysAgo(8) })
    .where('id', '=', version.id)
    .execute();

  const lucas = await db.selectFrom('users').selectAll().where('email', '=', 'lucas.silva@coursekit.test').executeTakeFirst();
  if (!lucas) return;
  const access = await loadActivityAccess(db, lucas, activity.id).catch(() => null);
  if (!access || access.enrolment?.role !== 'student') return;
  const origin = (deps.config.publicUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  const secret = await packageSecret(db);

  /** One session of the part the launch opened: the SCO's data, how it ends, and what it asks for next. */
  const play = async (opened: PackageLaunch, ops: Array<[string, string]>, end: { exit: string; nav?: string; lms?: boolean }) => {
    const token = verifyToken(secret, opened.url.split('/')[2] ?? '');
    const ctx = token && (await loadRuntimeContext(db, token));
    if (!ctx) throw new Error(`The demo couldn't open ${opened.itemId}.`);
    const all: Array<[string, string]> = [...ops, ['cmi.exit', end.exit], ['cmi.session_time', 'PT4M30S']];
    if (end.nav) all.push(['adl.nav.request', end.nav]);
    await applyCommit(deps, ctx, { sid: newId(), seq: 1, ops: all, terminate: true, elapsed: 270, unload: false, lms: !!end.lms });
  };
  const next = (attemptId: string, nav: 'continue' | 'suspendAll' | '_none_' = '_none_') =>
    launchPackage(deps, access, { attemptId, nav }, origin);

  const pretest = await launchPackage(deps, access, { newAttempt: true }, origin);
  const attemptId = pretest.attemptId!;
  await play(
    pretest,
    [
      ['cmi.objectives.1.success_status', 'passed'],
      ['cmi.objectives.2.success_status', 'failed'],
      ['cmi.score.scaled', '0.75'],
      ['cmi.completion_status', 'completed'],
      ['cmi.success_status', 'passed'],
      [
        'cmi.suspend_data',
        JSON.stringify({ page: 0, answers: { p1: 1, p2: 2, p3: 0, p4: 1 }, done: true, topics: { who: true, how: false } }),
      ],
    ],
    { exit: '', nav: 'continue' },
  );
  // Module 1 is skipped: the first lesson of module 2 opens.
  const exclusion = await next(attemptId);
  await play(
    exclusion,
    [
      ['cmi.completion_status', 'completed'],
      ['cmi.success_status', 'passed'],
      ['cmi.location', '1'],
      ['cmi.suspend_data', JSON.stringify({ page: 1, answers: {}, done: true })],
    ],
    { exit: '', nav: 'continue' },
  );
  const extend = await next(attemptId);
  await play(
    extend,
    [
      ['cmi.completion_status', 'incomplete'],
      ['cmi.location', '1'],
      ['cmi.suspend_data', JSON.stringify({ page: 1, answers: {}, done: false })],
    ],
    { exit: 'suspend', lms: true },
  );
  await next(attemptId, 'suspendAll');
  await db
    .updateTable('packageAttempts')
    .set({ startedAt: daysAgo(1, 15), lastAccessedAt: daysAgo(1, 15, 20) })
    .where('id', '=', attemptId)
    .execute();
}
