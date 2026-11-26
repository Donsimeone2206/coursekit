/**
 * Demo data for cmi5: the hand-written "Screen reader basics" course (generated as a zip, so the demo works
 * offline) at the end of the Accessibility section of UX Design Principles (made by demo-packages.ts), and a
 * finished registration for Lucas Silva: the reading completed, the quiz failed once and then passed.
 * Alex Johnson has no attempt, so the course can be played.
 */
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../context.js';
import type { ActivityRow, UserRow } from '../db/schema.js';
import { EventBus } from '../lib/events.js';
import { newId } from '../lib/util.js';
import { CATEGORY_CMI5, CATEGORY_MOVE_ON, EXT_MASTERY_SCORE, EXT_SESSION_ID, LAUNCH_DATA, VERBS } from '../packages/cmi5/constants.js';
import { writeLmsDocument } from '../packages/cmi5/launch.js';
import {
  auLmsId,
  blockLmsId,
  courseLmsId,
  launchedStatement,
  lmsBase,
  satisfiedStatement,
  storeLmsStatements,
  type LmsStatement,
  type StatementOwner,
} from '../packages/cmi5/statements.js';
import { allAus, cmi5Of, type Cmi5Au, type Cmi5Block } from '../packages/cmi5/structure.js';
import { CONTENT_PREFIX, importPackage, refreshAttempt, structureOf } from '../packages/service.js';
import { packageSecret, signToken } from '../packages/tokens.js';
import { screenReaderCmi5Zip } from './demo-cmi5-content.js';

const DAY = 86_400_000;
const at = (days: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.getTime();
};

export async function seedCmi5Demo(base: Pick<AppDeps, 'db' | 'events'>): Promise<void> {
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
  if (!section) return;
  const people = new Map(
    (await db.selectFrom('users').selectAll().where('email', 'like', '%@coursekit.test').execute()).map((u) => [u.email.split('@')[0]!, u]),
  );
  const maya = people.get('maya.chen');
  if (!maya) return;

  // At the end of the section, whatever else it has by now.
  const last = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  const created = new Date(at(8, 9)).toISOString();
  const activity: ActivityRow = {
    id: newId(),
    courseId: course.id,
    sectionId: section.id,
    type: 'package',
    title: 'Screen reader basics',
    description: 'A short cmi5 course: how people use the web with a screen reader, and a four-question quiz. Get three right to pass.',
    position: last?.m === null || last?.m === undefined ? 0 : Number(last.m) + 1,
    visible: 1,
    settings: JSON.stringify({ display: 'embed', attemptsAllowed: 0, gradingMethod: 'highest', requirePass: false }),
    dueAt: null,
    maxGrade: 10,
    completion: 'auto',
    groupMode: null,
    createdBy: maya.id,
    createdAt: created,
    updatedAt: created,
  };
  await db.insertInto('activities').values(activity).execute();
  const version = await importPackage(deps, activity, maya, screenReaderCmi5Zip(), 'screen-reader-basics-cmi5.zip');
  await db.updateTable('packageVersions').set({ createdAt: created }).where('id', '=', version.id).execute();

  const lucas = people.get('lucas.silva');
  if (lucas) await finishedRegistration(deps, activity, version.id, lucas);
}

async function finishedRegistration(
  deps: Pick<AppDeps, 'db' | 'events' | 'storage' | 'config'>,
  activity: ActivityRow,
  versionId: string,
  user: UserRow,
): Promise<void> {
  const { db } = deps;
  const version = await db.selectFrom('packageVersions').selectAll().where('id', '=', versionId).executeTakeFirstOrThrow();
  const structure = structureOf(version);
  const course = cmi5Of(structure)!;
  const [reading, quiz] = allAus(course.children) as [Cmi5Au, Cmi5Au];
  const block = course.children[0] as Cmi5Block;
  const homePage = (deps.config.publicUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  const base = lmsBase(homePage, activity.id);
  const attemptId = newId();
  const registration = randomUUID();
  const started = new Date(at(6, 14)).toISOString();
  await db
    .insertInto('packageAttempts')
    .values({
      id: attemptId,
      activityId: activity.id,
      courseId: activity.courseId,
      userId: user.id,
      versionId,
      attemptNumber: 1,
      registration,
      status: 'in_progress',
      completionStatus: 'not attempted',
      successStatus: 'unknown',
      score: null,
      totalSeconds: 0,
      lastItemId: null,
      startedAt: started,
      lastAccessedAt: started,
      finishedAt: null,
    })
    .execute();
  const owner: StatementOwner = { activityId: activity.id, courseId: activity.courseId, user, attemptId, registration, homePage };
  const secret = await packageSecret(db);

  /** One AU session: launched, initialized, the AU's result statements and terminated, from `start` on. */
  const session = async (
    au: Cmi5Au,
    start: number,
    minutes: number,
    results: Array<'completed' | number>,
    extra: (sessionId: string) => LmsStatement[] = () => [],
  ) => {
    const sessionId = randomUUID();
    const item = structure.items.find((i) => i.id === au.key)!;
    const token = signToken(secret, { a: activity.id, v: versionId, u: user.id, t: attemptId, p: 'play', i: au.key });
    const launchUrl = `${homePage}${CONTENT_PREFIX}${token}/${item.href}`;
    const auActivityId = auLmsId(base, au.key);
    const duration = `PT${minutes * 60}S`;
    const context = (moveOn: boolean, extensions: Record<string, unknown> = {}) => ({
      registration,
      contextActivities: {
        grouping: [{ id: au.id }],
        category: [{ id: CATEGORY_CMI5 }, ...(moveOn ? [{ id: CATEGORY_MOVE_ON }] : [])],
      },
      extensions: { [EXT_SESSION_ID]: sessionId, ...extensions },
    });
    const statement = (
      verb: keyof typeof VERBS,
      result?: Record<string, unknown>,
      moveOn = false,
      extensions?: Record<string, unknown>,
    ) => ({
      verb: { id: VERBS[verb], display: { 'en-US': verb } },
      object: { objectType: 'Activity', id: auActivityId },
      ...(result ? { result } : {}),
      context: context(moveOn, extensions),
    });
    const list: LmsStatement[] = [
      launchedStatement({
        registration,
        sessionId,
        publisherId: au.id,
        auLmsId: auActivityId,
        title: au.title,
        description: au.description,
        activityType: au.activityType,
        launchMode: 'Normal',
        launchUrl,
        moveOn: au.moveOn,
        masteryScore: au.masteryScore,
        launchParameters: au.launchParameters,
      }),
      statement('initialized'),
    ];
    let completed = false;
    let resultVerb: 'passed' | 'failed' | null = null;
    for (const r of results) {
      if (r === 'completed') {
        completed = true;
        list.push(statement('completed', { completion: true, duration }, true));
      } else {
        resultVerb = r >= (au.masteryScore ?? 0.5) ? 'passed' : 'failed';
        list.push(
          statement(
            resultVerb,
            { score: { scaled: r, raw: Math.round(r * 4), min: 0, max: 4 }, success: resultVerb === 'passed', duration },
            true,
            { [EXT_MASTERY_SCORE]: au.masteryScore },
          ),
        );
      }
    }
    list.push(...extra(sessionId));
    list.push(statement('terminated', { duration }));
    await storeLmsStatements(db, owner, list, start);
    const iso = (offset: number) => new Date(start + offset).toISOString();
    await db
      .insertInto('cmi5Sessions')
      .values({
        id: sessionId,
        activityId: activity.id,
        courseId: activity.courseId,
        userId: user.id,
        versionId,
        attemptId,
        registration,
        auKey: au.key,
        auId: au.id,
        auLmsId: auActivityId,
        homePage,
        launchMode: 'Normal',
        launchMethod: au.launchMethod,
        moveOn: au.moveOn,
        masteryScore: au.masteryScore,
        launchUrl,
        fetchedAt: iso(1500),
        preferencesReadAt: iso(1800),
        launchedAt: iso(0),
        initializedAt: iso(2000),
        terminatedAt: iso(minutes * 60_000),
        abandonedAt: null,
        lastActivityAt: iso(minutes * 60_000),
        completed: completed ? 1 : 0,
        resultVerb,
        durationSeconds: minutes * 60,
      })
      .execute();
    await writeLmsDocument(
      db,
      { activityId: activity.id, kind: 'state', ownerId: user.id, activityIri: auActivityId, registration, docId: LAUNCH_DATA },
      {
        contextTemplate: { contextActivities: { grouping: [{ id: au.id }] }, extensions: { [EXT_SESSION_ID]: sessionId } },
        launchMode: 'Normal',
        launchMethod: au.launchMethod,
        moveOn: au.moveOn,
        ...(au.masteryScore !== null ? { masteryScore: au.masteryScore } : {}),
        returnURL: `${homePage}/cmi5/return/ux-design-principles/${activity.id}`,
        ...(au.launchParameters ? { launchParameters: au.launchParameters } : {}),
      },
    );
    return { sessionId, end: iso(minutes * 60_000) };
  };

  const reads = await session(reading, at(6, 14), 9, ['completed']);
  const fails = await session(quiz, at(6, 14, 20), 4, [0.5]);
  // Passing the quiz satisfied the block and the course, in that session.
  const ids = [randomUUID(), randomUUID()];
  const passes = await session(quiz, at(5, 10), 3, [0.75], (sessionId) => [
    {
      id: ids[0],
      ...satisfiedStatement({
        kind: 'block',
        lmsId: blockLmsId(base, block.key),
        publisherId: block.id,
        title: block.title,
        description: block.description,
        registration,
        sessionId,
      }),
    },
    {
      id: ids[1],
      ...satisfiedStatement({
        kind: 'course',
        lmsId: courseLmsId(base),
        publisherId: course.id,
        title: course.title,
        description: course.description,
        registration,
        sessionId,
      }),
    },
  ]);

  await db
    .insertInto('cmi5AuStates')
    .values([
      {
        attemptId,
        auKey: reading.key,
        completedAt: reads.end,
        passedAt: null,
        failedAt: null,
        score: null,
        sessions: 1,
        totalSeconds: 9 * 60,
        firstLaunchedAt: new Date(at(6, 14)).toISOString(),
        lastLaunchedAt: new Date(at(6, 14)).toISOString(),
        updatedAt: reads.end,
      },
      {
        attemptId,
        auKey: quiz.key,
        completedAt: null,
        passedAt: passes.end,
        failedAt: fails.end,
        score: 0.75,
        sessions: 2,
        totalSeconds: 7 * 60,
        firstLaunchedAt: new Date(at(6, 14, 20)).toISOString(),
        lastLaunchedAt: new Date(at(5, 10)).toISOString(),
        updatedAt: passes.end,
      },
    ])
    .execute();
  await db
    .insertInto('cmi5Satisfied')
    .values([
      { attemptId, nodeKey: block.key, kind: 'block', sessionId: passes.sessionId, statementId: ids[0]!, satisfiedAt: passes.end },
      { attemptId, nodeKey: '', kind: 'course', sessionId: passes.sessionId, statementId: ids[1]!, satisfiedAt: passes.end },
    ])
    .execute();
  await refreshAttempt(deps, attemptId);
  await db
    .updateTable('packageAttempts')
    .set({ lastItemId: quiz.key, lastAccessedAt: passes.end, finishedAt: passes.end })
    .where('id', '=', attemptId)
    .execute();
}
