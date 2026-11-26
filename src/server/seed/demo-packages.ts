/**
 * Demo data for SCORM and xAPI packages: an "Accessibility" section in UX Design Principles with the
 * hand-written SCORM 1.2 module and xAPI challenge (generated as zips, so the demo works offline),
 * and attempts for a couple of students. Alex Johnson has no attempts, so the demo can be played.
 */
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../context.js';
import type { ActivityRow, UserRow } from '../db/schema.js';
import { EventBus } from '../lib/events.js';
import { newId } from '../lib/util.js';
import { createModel } from '../packages/runtime.js';
import { importPackage, refreshAttempt, scoResult, structureOf, xapiActor } from '../packages/service.js';
import { accessibilityScormFiles, contrastXapiFiles, DEMO_XAPI_ACTIVITY, zipFiles } from './demo-package-content.js';

const DAY = 86_400_000;
const daysAgo = (days: number, hour = 10) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

export async function seedPackagesDemo(base: Pick<AppDeps, 'db' | 'events'>): Promise<void> {
  const full = base as Partial<AppDeps>;
  if (!full.storage || !full.config) return; // the package files need file storage
  // Demo history is recorded quietly, without notifications or events.
  const deps = { db: base.db, events: new EventBus(), storage: full.storage, config: full.config };
  const { db } = deps;
  const course = await db.selectFrom('courses').selectAll().where('slug', '=', 'ux-design-principles').executeTakeFirst();
  if (!course) return;
  const people = new Map(
    (await db.selectFrom('users').selectAll().where('email', 'like', '%@coursekit.test').execute()).map((u) => [u.email.split('@')[0]!, u]),
  );
  const maya = people.get('maya.chen');
  if (!maya) return;

  const position = await db
    .selectFrom('sections')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('courseId', '=', course.id)
    .executeTakeFirst();
  const sectionId = newId();
  await db
    .insertInto('sections')
    .values({
      id: sectionId,
      courseId: course.id,
      title: 'Accessibility',
      summary: 'Two short interactive modules: the WCAG basics and a colour contrast challenge.',
      position: Number(position?.m ?? 0) + 1,
      visible: 1,
      createdAt: daysAgo(9),
    })
    .execute();

  const activity = async (title: string, description: string, positionInSection: number, maxGrade: number): Promise<ActivityRow> => {
    const row: ActivityRow = {
      id: newId(),
      courseId: course.id,
      sectionId,
      type: 'package',
      title,
      description,
      position: positionInSection,
      visible: 1,
      settings: JSON.stringify({ display: 'embed', attemptsAllowed: 0, gradingMethod: 'highest', requirePass: false }),
      dueAt: null,
      maxGrade,
      completion: 'auto',
      groupMode: null,
      createdBy: maya.id,
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
    };
    await db.insertInto('activities').values(row).execute();
    return row;
  };

  const scorm = await activity(
    'Accessibility basics',
    'A short SCORM module on the four WCAG principles, with a five-question quiz at the end. You need 80% to pass.',
    0,
    100,
  );
  const xapi = await activity(
    'Colour contrast challenge',
    'Four colour pairs: which ones are readable as body text? (An xAPI activity.)',
    1,
    10,
  );
  const scormVersion = await importPackage(deps, scorm, maya, zipFiles(accessibilityScormFiles()), 'accessibility-basics-scorm12.zip');
  const xapiVersion = await importPackage(deps, xapi, maya, zipFiles(contrastXapiFiles()), 'colour-contrast-challenge-xapi.zip');
  await db
    .updateTable('packageVersions')
    .set({ createdAt: daysAgo(9) })
    .where('id', 'in', [scormVersion.id, xapiVersion.id])
    .execute();

  const attempt = async (activityRow: ActivityRow, versionId: string, user: UserRow, number: number, started: number) => {
    const id = newId();
    await db
      .insertInto('packageAttempts')
      .values({
        id,
        activityId: activityRow.id,
        courseId: course.id,
        userId: user.id,
        versionId,
        attemptNumber: number,
        registration: randomUUID(),
        status: 'in_progress',
        completionStatus: 'not attempted',
        successStatus: 'unknown',
        score: null,
        totalSeconds: 0,
        lastItemId: null,
        startedAt: daysAgo(started),
        lastAccessedAt: daysAgo(started),
        finishedAt: null,
      })
      .execute();
    return id;
  };

  const item = structureOf(scormVersion).items.find((i) => i.launchable)!;
  const scoState = async (attemptId: string, set: Record<string, string>, seconds: number, exit: string, when: number) => {
    const model = createModel('1.2', {});
    for (const [k, v] of Object.entries(set)) model.set(k, v);
    const result = scoResult('1.2', item, { values: model.values });
    await db
      .insertInto('packageScoStates')
      .values({
        attemptId,
        itemId: item.id,
        data: JSON.stringify({ values: model.values, counts: model.counts }),
        completionStatus: result.completionStatus,
        successStatus: result.successStatus,
        score: result.scaled,
        totalSeconds: seconds,
        lastExit: exit,
        sessions: 1,
        sessionId: newId(),
        seq: 1,
        terminatedSessionId: null,
        sessionSeconds: seconds,
        updatedAt: daysAgo(when),
      })
      .execute();
  };
  const quiz = (answers: string[], score: number, status: string) => {
    const out: Record<string, string> = {
      'cmi.core.lesson_location': '5',
      'cmi.core.score.min': '0',
      'cmi.core.score.max': '100',
      'cmi.core.score.raw': String(score),
      'cmi.core.lesson_status': status,
    };
    const correct = ['c', 'b', 'b', 'b', 'c'];
    answers.forEach((a, i) => {
      out[`cmi.interactions.${i}.id`] = `q${i + 1}`;
      out[`cmi.interactions.${i}.type`] = 'choice';
      out[`cmi.interactions.${i}.student_response`] = a;
      out[`cmi.interactions.${i}.result`] = a === correct[i] ? 'correct' : 'wrong';
    });
    return out;
  };

  // Sofia passed on her second attempt; Olivia is halfway through the pages.
  const sofia = people.get('sofia.martinez');
  const olivia = people.get('olivia.brown');
  const ava = people.get('ava.thompson');
  if (sofia) {
    const first = await attempt(scorm, scormVersion.id, sofia, 1, 7);
    await scoState(first, quiz(['c', 'a', 'b', 'd', 'c'], 60, 'failed'), 14 * 60 + 5, '', 7);
    const second = await attempt(scorm, scormVersion.id, sofia, 2, 6);
    await scoState(second, quiz(['c', 'b', 'b', 'b', 'a'], 80, 'passed'), 9 * 60 + 40, '', 6);
    for (const id of [first, second]) {
      await refreshAttempt(deps, id, { sessionEnded: true });
      await db
        .updateTable('packageAttempts')
        .set({ lastAccessedAt: daysAgo(id === first ? 7 : 6, 11), finishedAt: daysAgo(id === first ? 7 : 6, 11) })
        .where('id', '=', id)
        .execute();
    }
  }
  if (olivia) {
    const id = await attempt(scorm, scormVersion.id, olivia, 1, 2);
    await scoState(
      id,
      {
        'cmi.core.lesson_status': 'incomplete',
        'cmi.core.lesson_location': '2',
        'cmi.suspend_data': JSON.stringify({ page: 2, answers: {}, done: false }),
      },
      6 * 60 + 12,
      'suspend',
      2,
    );
    await refreshAttempt(deps, id);
    await db
      .updateTable('packageAttempts')
      .set({ lastAccessedAt: daysAgo(2, 12) })
      .where('id', '=', id)
      .execute();
  }

  // Ava finished the contrast challenge with 3 of 4.
  if (ava) {
    const id = await attempt(xapi, xapiVersion.id, ava, 1, 3);
    const registration = (await db.selectFrom('packageAttempts').select('registration').where('id', '=', id).executeTakeFirstOrThrow())
      .registration;
    const homePage = (deps.config.publicUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    const actor = xapiActor(ava, homePage);
    const authority = { objectType: 'Agent', name: 'Coursekit', account: { homePage, name: 'coursekit' } };
    const statements = [
      { verb: 'launched', result: undefined },
      {
        verb: 'completed',
        result: { score: { scaled: 0.75, raw: 3, min: 0, max: 4 }, success: true, completion: true, duration: 'PT2M50S' },
      },
      { verb: 'passed', result: { score: { scaled: 0.75, raw: 3, min: 0, max: 4 }, success: true, completion: true, duration: 'PT2M50S' } },
      { verb: 'terminated', result: { duration: 'PT3M5S' } },
    ];
    const ts = daysAgo(3);
    await db
      .insertInto('xapiStatements')
      .values(
        statements.map((s, i) => {
          const statementId = randomUUID();
          const stored = new Date(Date.parse(ts) + i * 60_000).toISOString();
          const verbId = `http://adlnet.gov/expapi/verbs/${s.verb}`;
          const statement = {
            id: statementId,
            actor,
            verb: { id: verbId, display: { 'en-US': s.verb } },
            object: { objectType: 'Activity', id: DEMO_XAPI_ACTIVITY },
            ...(s.result ? { result: s.result } : {}),
            context: { registration },
            timestamp: stored,
            stored,
            authority,
            version: '1.0.0',
          };
          return {
            id: statementId,
            activityId: xapi.id,
            courseId: course.id,
            userId: ava.id,
            attemptId: id,
            registration,
            verbId,
            objectId: DEMO_XAPI_ACTIVITY,
            voided: 0,
            voidsId: null,
            statement: JSON.stringify(statement),
            timestamp: stored,
            stored,
          };
        }),
      )
      .execute();
    await refreshAttempt(deps, id);
    await db
      .updateTable('packageAttempts')
      .set({ lastAccessedAt: daysAgo(3, 11), finishedAt: daysAgo(3, 11) })
      .where('id', '=', id)
      .execute();
  }
}
