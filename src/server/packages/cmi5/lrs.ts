/**
 * The cmi5 side of the xAPI LRS (/xapi/, xapi.ts calls these hooks): session credentials from the fetch URL,
 * the statement rules of sections 9 and 10.2.2 for statements sent with them, and the documents only the LMS
 * may write (LMS.LaunchData and cmi5LearnerPreferences).
 *
 * Rules are checked statement by statement, in the order sent, against the session and the registration; a
 * statement that breaks one is rejected with 403 (as the ADL cmi5 player does) and nothing of its request is
 * stored. The state changes they cause (initialized, completed, passed, failed, terminated) are claimed with
 * conditional updates inside the transaction that stores the statements, so concurrent requests can't both
 * win (two "completed" statements, or a statement after "terminated").
 *
 * Session credentials are limited to the session's registration: statements, State API documents and statement
 * queries of the learner's other registrations are out of their reach. Only Normal sessions of a course that
 * isn't archived count: Browse and Review sessions never change the AU's time, the attempt or the grade.
 */
import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { AppDeps } from '../../context.js';
import type { ActivityRow, Database } from '../../db/schema.js';
import type { Cmi5AuStateRow, Cmi5SessionRow } from '../../db/schema-cmi5.js';
import type { PackageAttemptRow, XapiDocumentRow } from '../../db/schema-packages.js';
import type { DB } from '../../db/types.js';
import { now } from '../../lib/util.js';
import { loadActivityAccess } from '../../services/access.js';
import { refreshAttempt } from '../service.js';
import type { PackageToken } from '../tokens.js';
import {
  CATEGORY_CMI5,
  CATEGORY_MOVE_ON,
  EXT_MASTERY_SCORE,
  EXT_SESSION_ID,
  LAUNCH_DATA,
  LEARNER_PREFERENCES,
  LMS_VERBS,
  SESSION_TIMEOUT_HOURS,
  TERMINATED_GRACE_SECONDS,
  VERBS,
} from './constants.js';
import { abandonSession, newlySatisfied } from './launch.js';
import { loadAuStates } from './results.js';
import { lmsBase, durationSeconds, storeLmsStatements } from './statements.js';
import { allAus, courseOfVersion, type Cmi5Au, type Cmi5Course } from './structure.js';
import { cmi5Secret, verifyCmi5Token } from './tokens.js';

type Deps = Pick<AppDeps, 'db' | 'events' | 'storage' | 'config'>;
type Status = 400 | 401 | 403 | 404 | 409 | 412 | 413;

/** A request the cmi5 rules refuse. xapi.ts answers it like its own errors. */
export class Cmi5Rejection extends Error {
  constructor(
    readonly status: Status,
    message: string,
  ) {
    super(message);
  }
}

export function cmi5Rejection(err: unknown): { status: Status; message: string } | null {
  return err instanceof Cmi5Rejection ? { status: err.status, message: err.message } : null;
}

const reject = (message: string, status: Status = 403): never => {
  throw new Cmi5Rejection(status, message);
};

/** What the LRS knows about a request made with cmi5 session credentials. */
export interface Cmi5Lrs {
  session: Cmi5SessionRow;
  au: Cmi5Au;
  course: Cmi5Course;
  /** The course is archived: nothing that counts can be recorded. */
  readOnly: boolean;
}

/** Whether what the session records counts: a Normal session of a course that isn't archived. */
const countsIn = (cmi5: Cmi5Lrs) => cmi5.session.launchMode === 'Normal' && !cmi5.readOnly;

/** The LRS context xapi.ts works with (the same shape as its Lrs). */
export interface Cmi5LrsContext {
  token: PackageToken;
  activity: ActivityRow;
  attempt: PackageAttemptRow | null;
  records: boolean;
  homePage: string;
  user: { id: string; name: string };
  cmi5: Cmi5Lrs;
}

const ended = 'This session has ended. Go back to the activity and open it again.';

/** Checks cmi5 session credentials (the password of the Basic credentials the fetch URL handed out). */
export async function cmi5Lrs(deps: Deps, _c: Context, password: string): Promise<Cmi5LrsContext> {
  const { db } = deps;
  const check = verifyCmi5Token(await cmi5Secret(db), 'auth', password);
  if (!check.ok) return reject('These credentials have expired or are not valid. Open the activity again.', 401);
  const session = await db.selectFrom('cmi5Sessions').selectAll().where('id', '=', check.sessionId).executeTakeFirst();
  if (!session || !session.fetchedAt) return reject('These credentials are not valid. Open the activity again.', 401);
  // The credentials last as long as the session (section 8.2.1).
  if (session.abandonedAt) return reject(ended, 401);
  if (session.terminatedAt && Date.now() - Date.parse(session.terminatedAt) > TERMINATED_GRACE_SECONDS * 1000) return reject(ended, 401);
  if (!session.terminatedAt && Date.parse(session.lastActivityAt) < Date.now() - SESSION_TIMEOUT_HOURS * 3600_000) {
    if ((await abandonSession(deps, session)) && session.attemptId) await refreshAttempt(deps, session.attemptId);
    return reject(ended, 401);
  }
  const activity = await db.selectFrom('activities').selectAll().where('id', '=', session.activityId).executeTakeFirst();
  const user = await db.selectFrom('users').selectAll().where('id', '=', session.userId).executeTakeFirst();
  if (!activity || !user || user.status !== 'active') return reject('These credentials are no longer valid.', 401);
  let readOnly = false;
  try {
    // The learner must still be allowed to open the activity (enrolment, visibility and group restrictions).
    const access = await loadActivityAccess(db, user, activity.id);
    if (session.attemptId && access.enrolment?.role !== 'student') throw new Error('not a learner');
    readOnly = access.readOnly;
  } catch {
    return reject('You can no longer open this activity.', 403);
  }
  let attempt: PackageAttemptRow | null = null;
  if (session.attemptId) {
    attempt = (await db.selectFrom('packageAttempts').selectAll().where('id', '=', session.attemptId).executeTakeFirst()) ?? null;
    if (!attempt || attempt.userId !== user.id || attempt.activityId !== activity.id)
      return reject('These credentials are no longer valid.', 401);
  }
  const version = await db.selectFrom('packageVersions').selectAll().where('id', '=', session.versionId).executeTakeFirst();
  const course = version && courseOfVersion(version);
  const au = course && allAus(course.children).find((a) => a.key === session.auKey);
  if (!course || !au) return reject('These credentials are no longer valid.', 401);
  // Requests keep the session alive (it is abandoned after SESSION_TIMEOUT_HOURS without any).
  if (Date.now() - Date.parse(session.lastActivityAt) > 30_000) {
    await db.updateTable('cmi5Sessions').set({ lastActivityAt: now() }).where('id', '=', session.id).execute();
  }
  return {
    token: { p: 'xapi', a: activity.id, v: session.versionId, u: user.id, t: attempt?.id ?? '', i: attempt ? 'xapi' : 'readonly', x: 0 },
    activity,
    attempt,
    records: !!attempt,
    homePage: session.homePage,
    user: { id: user.id, name: user.name },
    cmi5: { session, au, course, readOnly },
  };
}

// ----- statements -----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const activityIds = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(isObject).map((a) => a.id);
const VERB_NAMES = new Map<string, string>(Object.entries(VERBS).map(([name, id]) => [id, name]));
const nameOf = (verbId: string) => VERB_NAMES.get(verbId) ?? verbId;
const AU_VERBS: readonly string[] = [VERBS.initialized, VERBS.completed, VERBS.passed, VERBS.failed, VERBS.terminated];
const RESULT_VERBS: readonly string[] = [VERBS.completed, VERBS.passed, VERBS.failed];

type Claim =
  | { verb: 'initialized' }
  | { verb: 'terminated'; seconds: number }
  | { verb: 'completed' }
  | { verb: 'passed' | 'failed'; score: number | null };

export interface Cmi5Plan {
  cmi5: Cmi5Lrs;
  attempt: PackageAttemptRow | null;
  claims: Claim[];
}

interface Prepared {
  id: string;
  raw: Record<string, unknown>;
}

/** Applies the cmi5 rules to statements sent with session credentials (in order). Throws Cmi5Rejection. */
function plan(
  cmi5: Cmi5Lrs,
  session: Cmi5SessionRow,
  state: Pick<Cmi5AuStateRow, 'completedAt' | 'passedAt'> | undefined,
  statements: Prepared[],
): Claim[] {
  let initialized = !!session.initializedAt;
  let terminated = !!session.terminatedAt;
  let sessionCompleted = session.completed === 1;
  let sessionResult = session.resultVerb;
  let auCompleted = !!state?.completedAt;
  let auPassed = !!state?.passedAt;
  const claims: Claim[] = [];
  for (const { raw: st } of statements) {
    const verbId = String((st.verb as { id?: unknown } | undefined)?.id ?? '');
    const verb = `"${nameOf(verbId)}"`;
    // 6.3: cmi5 credentials can't void statements.
    if (verbId === VERBS.voided) reject('Statements sent with cmi5 launch credentials cannot void statements.');
    // 9.1 and 9.7: an id and a UTC timestamp.
    if (st.id === undefined) reject('Every statement needs an id (a UUID).');
    if (typeof st.timestamp !== 'string') reject('Every statement needs a timestamp.');
    if (!/(Z|\+00(:?00)?)$/.test(st.timestamp as string)) reject('The timestamp must be in UTC (ending in Z).');
    // 9.6: the registration and the launch's context template (publisher id grouping, session id).
    const context = st.context;
    if (!isObject(context)) return reject('Statements need a context with the registration and the context template from LMS.LaunchData.');
    if (String(context.registration ?? '').toLowerCase() !== session.registration) {
      reject('These credentials can only send statements for the launched registration.');
    }
    const activities = isObject(context.contextActivities) ? context.contextActivities : null;
    if (!activities) return reject('context.contextActivities from the context template in LMS.LaunchData is missing.');
    if (!activityIds(activities.grouping).includes(session.auId)) {
      reject("context.contextActivities.grouping must include the AU's publisher id from the context template.");
    }
    const extensions = isObject(context.extensions) ? context.extensions : {};
    if (extensions[EXT_SESSION_ID] === undefined) reject('The sessionid context extension from the context template is missing.');
    if (extensions[EXT_SESSION_ID] !== session.id) reject('The sessionid context extension is not the one of this session.');
    const categories = activityIds(activities.category);
    const isDefined = categories.includes(CATEGORY_CMI5);
    const moveOn = categories.includes(CATEGORY_MOVE_ON);
    // 9.6.2.2: the moveOn category only on cmi5 defined completed, passed and failed statements.
    if (moveOn && (!isDefined || !RESULT_VERBS.includes(verbId))) {
      reject('Only cmi5 defined "completed", "passed" and "failed" statements can have the moveon category.');
    }
    // 9.3: "initialized" first, nothing after "terminated".
    if (terminated) reject('This session was terminated: no statements can follow "terminated".');
    if (!initialized && !(isDefined && verbId === VERBS.initialized)) {
      reject('The first statement of a session must be the cmi5 defined "initialized" statement.');
    }
    if (!isDefined) continue; // a cmi5 allowed statement

    // cmi5 defined statements. An actor without objectType is an Agent (xAPI 1.0.3, 2.4.2.1).
    const actor = st.actor;
    if (!isObject(actor) || (actor.objectType !== undefined && actor.objectType !== 'Agent') || !isObject(actor.account)) {
      reject('The actor of cmi5 defined statements must be an Agent with an account (objectType "Agent").');
    }
    if (LMS_VERBS.includes(verbId)) reject(`Only the LMS can send ${verb} statements.`);
    if (!AU_VERBS.includes(verbId)) {
      reject(`${verb} isn't a cmi5 verb: send it without the cmi5 category (as a cmi5 allowed statement).`);
    }
    const object = st.object;
    if (!isObject(object) || object.id !== session.auLmsId) {
      reject('The object of cmi5 defined statements must be the AU: the activityId from the launch URL.');
    }
    const counts = RESULT_VERBS.includes(verbId);
    if (counts && session.launchMode !== 'Normal') reject(`${verb} statements can't be sent in ${session.launchMode} mode.`);
    if (counts && cmi5.readOnly) reject(`This course is archived: ${verb} can't be recorded.`);
    const result = isObject(st.result) ? st.result : undefined;
    if (result?.completion !== undefined && verbId !== VERBS.completed)
      reject('Only "completed" statements can include result.completion.');
    if (result?.success !== undefined && verbId !== VERBS.passed && verbId !== VERBS.failed) {
      reject('Only "passed" and "failed" statements can include result.success.');
    }
    if (result?.score !== undefined && verbId !== VERBS.passed && verbId !== VERBS.failed) {
      reject('Only "passed" and "failed" statements can include a score.');
    }
    if ((result?.completion !== undefined || result?.success !== undefined) && !moveOn) {
      reject(`${verb} statements with result.success or result.completion need the moveon category.`);
    }
    const seconds = durationSeconds(result?.duration);
    if (verbId !== VERBS.initialized && seconds === null) reject(`${verb} statements need result.duration.`);

    if (verbId === VERBS.initialized) {
      if (initialized) reject('This session was already initialized.');
      initialized = true;
      claims.push({ verb: 'initialized' });
    } else if (verbId === VERBS.terminated) {
      terminated = true;
      claims.push({ verb: 'terminated', seconds: seconds! });
    } else if (verbId === VERBS.completed) {
      if (result?.completion !== true) reject('"completed" statements need result.completion set to true.');
      if (sessionCompleted || auCompleted) reject('This AU was already completed in this registration.');
      sessionCompleted = auCompleted = true;
      claims.push({ verb: 'completed' });
    } else {
      const passed = verbId === VERBS.passed;
      if (result?.success !== passed) reject(`${verb} statements need result.success set to ${passed}.`);
      const score = isObject(result?.score) ? result!.score : undefined;
      if (score && typeof score.scaled === 'number' && (score.scaled < 0 || score.scaled > 1)) {
        reject('result.score.scaled must be between 0 and 1.');
      }
      if (score && score.raw !== undefined && (score.min === undefined || score.max === undefined)) {
        reject('A raw score needs min and max.');
      }
      // 9.5.1: raw is an integer between min and max.
      if (score && score.raw !== undefined && !Number.isInteger(score.raw)) reject('result.score.raw must be an integer.');
      const mastery = session.masteryScore;
      const given = extensions[EXT_MASTERY_SCORE];
      if (mastery !== null) {
        if ((score || given !== undefined) && given !== mastery) {
          reject('The masteryscore context extension must be the masteryScore from LMS.LaunchData.');
        }
        const scaled = score && typeof score.scaled === 'number' ? score.scaled : undefined;
        if (scaled !== undefined && passed && scaled < mastery)
          reject(`"passed" needs a scaled score of at least the mastery score (${mastery}).`);
        if (scaled !== undefined && !passed && scaled >= mastery)
          reject(`"failed" needs a scaled score below the mastery score (${mastery}).`);
      }
      if (sessionResult) reject('A session can only have one "passed" or "failed" statement.');
      if (auPassed) {
        reject(
          passed ? 'This AU was already passed in this registration.' : 'A "failed" statement cannot follow "passed" in a registration.',
        );
      }
      sessionResult = passed ? 'passed' : 'failed';
      if (passed) auPassed = true;
      // The grade uses result.score.scaled only: it is what the mastery score was checked against.
      claims.push({ verb: passed ? 'passed' : 'failed', score: typeof score?.scaled === 'number' ? score.scaled : null });
    }
  }
  return claims;
}

async function currentState(db: Kysely<Database>, cmi5: Cmi5Lrs) {
  const session = await db.selectFrom('cmi5Sessions').selectAll().where('id', '=', cmi5.session.id).executeTakeFirstOrThrow();
  const state = session.attemptId
    ? await db
        .selectFrom('cmi5AuStates')
        .select(['completedAt', 'passedAt'])
        .where('attemptId', '=', session.attemptId)
        .where('auKey', '=', session.auKey)
        .executeTakeFirst()
    : undefined;
  return { session, state };
}

/** Checks statements about to be stored with cmi5 credentials. Returns what they change, for applyCmi5Plan. */
export async function checkCmi5Statements(deps: Pick<AppDeps, 'db'>, cmi5: Cmi5Lrs, statements: Prepared[]): Promise<Cmi5Plan> {
  const { session, state } = await currentState(deps.db, cmi5);
  if (session.abandonedAt) reject(ended, 403);
  // 11.0: the AU reads the learner preferences on startup, before it sends statements (as the ADL cmi5 player asks).
  if (!session.preferencesReadAt) {
    reject(`Read the learner preferences (the ${LEARNER_PREFERENCES} agent profile) before sending statements.`);
  }
  const attempt = session.attemptId
    ? ((await deps.db.selectFrom('packageAttempts').selectAll().where('id', '=', session.attemptId).executeTakeFirst()) ?? null)
    : null;
  return { cmi5: { ...cmi5, session }, attempt, claims: plan(cmi5, session, state, statements) };
}

const claimed = (res: { numUpdatedRows: bigint }, message: string) => {
  if (Number(res.numUpdatedRows) === 0) reject(message);
};

/** Claims the state changes of checked statements, in the transaction that stores them. */
export async function applyCmi5Plan(trx: Kysely<Database>, p: Cmi5Plan): Promise<void> {
  const { session } = p.cmi5;
  const ts = now();
  const sessionUpdate = () => trx.updateTable('cmi5Sessions').where('id', '=', session.id);
  const open = (q: ReturnType<typeof sessionUpdate>) => q.where('terminatedAt', 'is', null).where('abandonedAt', 'is', null);
  if (p.claims[0]?.verb === 'initialized') {
    claimed(
      await open(sessionUpdate().set({ initializedAt: ts, lastActivityAt: ts }))
        .where('initializedAt', 'is', null)
        .executeTakeFirst(),
      'This session was already initialized, or it has ended.',
    );
  } else {
    claimed(
      await open(sessionUpdate().set({ lastActivityAt: ts }))
        .where('initializedAt', 'is not', null)
        .executeTakeFirst(),
      'This session has ended, or it was not initialized.',
    );
  }
  const auUpdate = () =>
    trx
      .updateTable('cmi5AuStates')
      .where('attemptId', '=', session.attemptId ?? '')
      .where('auKey', '=', session.auKey);
  for (const c of p.claims) {
    if (c.verb === 'completed') {
      await sessionUpdate().set({ completed: 1 }).execute();
      if (session.attemptId) {
        claimed(
          await auUpdate().set({ completedAt: ts, updatedAt: ts }).where('completedAt', 'is', null).executeTakeFirst(),
          'This AU was already completed in this registration.',
        );
      }
    } else if (c.verb === 'passed' || c.verb === 'failed') {
      claimed(
        await sessionUpdate().set({ resultVerb: c.verb }).where('resultVerb', 'is', null).executeTakeFirst(),
        'A session can only have one "passed" or "failed" statement.',
      );
      if (session.attemptId) {
        const set =
          c.verb === 'passed'
            ? { passedAt: ts, score: c.score, updatedAt: ts }
            : c.score === null
              ? { failedAt: ts, updatedAt: ts }
              : { failedAt: ts, score: c.score, updatedAt: ts };
        claimed(
          await auUpdate().set(set).where('passedAt', 'is', null).executeTakeFirst(),
          c.verb === 'passed' ? 'This AU was already passed in this registration.' : 'A "failed" statement cannot follow "passed".',
        );
      }
    } else if (c.verb === 'terminated') {
      claimed(
        await open(sessionUpdate().set({ terminatedAt: ts, durationSeconds: c.seconds })).executeTakeFirst(),
        'This session has already ended.',
      );
      // Review time doesn't count (nor time in a course archived since the launch).
      if (session.attemptId && countsIn(p.cmi5)) {
        await auUpdate()
          .set((eb) => ({ totalSeconds: eb('totalSeconds', '+', c.seconds), updatedAt: ts }))
          .execute();
      }
    }
  }
}

/**
 * After the statements are stored: "satisfied" for blocks and the course the session newly satisfied, then the
 * attempt's results (refreshAttempt, which also syncs the grade) when the statements changed something that
 * counts: results or time in a Normal session of a course that isn't archived. Browse and Review sessions, and
 * statements that change nothing (initialized, cmi5 allowed statements), leave the attempt and the grade alone.
 */
export async function afterCmi5Plan(deps: Deps, p: Cmi5Plan): Promise<void> {
  const { session, course } = p.cmi5;
  if (!p.attempt || !countsIn(p.cmi5) || !p.claims.some((c) => c.verb !== 'initialized')) return;
  if (p.claims.some((c) => c.verb === 'completed' || c.verb === 'passed')) {
    const user = await deps.db.selectFrom('users').select(['id', 'name']).where('id', '=', session.userId).executeTakeFirst();
    if (user) {
      const statements = await newlySatisfied(deps.db, p.attempt.id, course, await loadAuStates(deps.db, p.attempt.id), {
        registration: session.registration,
        sessionId: session.id,
        base: lmsBase(session.homePage, session.activityId),
      });
      await storeLmsStatements(
        deps.db,
        {
          activityId: session.activityId,
          courseId: session.courseId,
          user,
          attemptId: p.attempt.id,
          registration: session.registration,
          homePage: session.homePage,
        },
        statements,
      );
    }
  }
  await refreshAttempt(deps, p.attempt.id);
}

/**
 * How many statements of a registration Coursekit made itself: "launched" for each session, "abandoned" for each
 * abandoned one and "satisfied" for each satisfied block and the course. They don't use up the AU's allowance of
 * statements per attempt (xapi.ts), so launching often can't lock the AU out.
 */
export async function cmi5LmsStatementCount(db: DB, attemptId: string): Promise<number> {
  const sessions = await db
    .selectFrom('cmi5Sessions')
    .select((eb) => [eb.fn.countAll().as('n'), eb.fn.count('abandonedAt').as('abandoned')])
    .where('attemptId', '=', attemptId)
    .executeTakeFirst();
  const satisfied = await db
    .selectFrom('cmi5Satisfied')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('attemptId', '=', attemptId)
    .executeTakeFirst();
  return Number(sessions?.n ?? 0) + Number(sessions?.abandoned ?? 0) + Number(satisfied?.n ?? 0);
}

/** Staff previews store nothing, but the session still follows the rules (initialized first, and so on). */
export async function previewCmi5Statements(deps: Pick<AppDeps, 'db'>, cmi5: Cmi5Lrs, statements: Prepared[]): Promise<void> {
  const p = await checkCmi5Statements(deps, cmi5, statements);
  await deps.db.transaction().execute((trx) => applyCmi5Plan(trx, p));
}

// ----- documents and queries -----

/** The LMS writes LMS.LaunchData and cmi5LearnerPreferences; AUs may only read them (sections 10 and 11). */
export function guardCmi5Document(kind: XapiDocumentRow['kind'], docId: string | undefined): void {
  if (kind === 'state' && docId === LAUNCH_DATA) reject('LMS.LaunchData is written by the LMS: AUs can only read it.');
  if (kind === 'agent_profile' && docId === LEARNER_PREFERENCES) {
    reject('The learner preferences are kept by the LMS: AUs can only read them.');
  }
}

/**
 * State API requests made with session credentials name the session's registration (section 8.1.4, as the ADL
 * cmi5 player checks): the documents of the learner's other registrations are out of reach.
 */
export function guardCmi5Registration(cmi5: Cmi5Lrs, registration: string): void {
  if (registration.toLowerCase() !== cmi5.session.registration) reject('These credentials can only use the launched registration.');
}

/** Notes that the AU read its learner preferences (section 11.0), which statements of the session wait for. */
export async function noteCmi5DocumentRead(db: DB, cmi5: Cmi5Lrs, kind: XapiDocumentRow['kind'], docId: string | undefined) {
  if (kind !== 'agent_profile' || docId !== LEARNER_PREFERENCES || cmi5.session.preferencesReadAt) return;
  await db
    .updateTable('cmi5Sessions')
    .set({ preferencesReadAt: now() })
    .where('id', '=', cmi5.session.id)
    .where('preferencesReadAt', 'is', null)
    .execute();
}

/** State documents a cmi5 AU may delete all at once (everything but LMS.LaunchData). */
export const PROTECTED_STATE_ID = LAUNCH_DATA;
