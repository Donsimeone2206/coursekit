/**
 * Statements Coursekit makes itself for cmi5 registrations (launched, abandoned, satisfied), with Coursekit as
 * the authority, and the ids it generates for the course, blocks and AUs (sections 8.1.5 and 9.4: never the
 * publisher's ids, which go in the grouping context activities instead).
 */
import { randomUUID } from 'node:crypto';
import type { Cmi5LaunchMode, Cmi5MoveOn } from '../../../shared/cmi5.js';
import type { DB } from '../../db/types.js';
import { round } from '../../lib/util.js';
import {
  ACTIVITY_TYPE_BLOCK,
  ACTIVITY_TYPE_COURSE,
  CATEGORY_CMI5,
  EXT_LAUNCH_MODE,
  EXT_LAUNCH_PARAMETERS,
  EXT_LAUNCH_URL,
  EXT_MASTERY_SCORE,
  EXT_MOVE_ON,
  EXT_SESSION_ID,
  MAX_LMS_STATEMENT_BYTES,
  VERBS,
} from './constants.js';
import { isIri, pickTag, type LangMap } from './structure.js';

/** The learner as cmi5 statements name them: an account on the site, never an email address (like xapiActor). */
export function cmi5Actor(user: { id: string; name: string }, homePage: string) {
  return { objectType: 'Agent' as const, name: user.name, account: { homePage, name: user.id } };
}

/** Base IRI of the ids Coursekit generates for one package activity's cmi5 course, blocks and AUs. */
export const lmsBase = (homePage: string, activityId: string) => `${homePage}/xapi/activities/cmi5/${activityId}`;
export const courseLmsId = (base: string) => `${base}/course`;
export const blockLmsId = (base: string, key: string) => `${base}/block/${key}`;
export const auLmsId = (base: string, key: string) => `${base}/au/${key}`;

export const isoDuration = (seconds: number) => `PT${round(Math.max(0, seconds), 2)}S`;

/** Seconds of an ISO 8601 duration (PnYnMnWnDTnHnMnS), or null when it isn't one. */
export function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!m || value === 'P' || value.endsWith('T')) return null;
  const [y, mo, w, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as number[];
  const total = ((((y! * 365 + mo! * 30 + w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) as number;
  return Number.isFinite(total) ? total : null;
}

const display = (verb: string) => ({ 'en-US': verb });
const nonEmpty = (map: LangMap) => (Object.keys(map).length ? map : undefined);

interface ContextOptions {
  registration: string;
  sessionId: string;
  /** The publisher id of the AU, block or course the statement is about. */
  publisherId: string;
  extensions?: Record<string, unknown>;
}

function cmi5Context(o: ContextOptions) {
  return {
    registration: o.registration,
    contextActivities: { category: [{ id: CATEGORY_CMI5 }], grouping: [{ id: o.publisherId }] },
    extensions: { [EXT_SESSION_ID]: o.sessionId, ...o.extensions },
  };
}

export type LmsStatement = Record<string, unknown> & {
  verb: { id: string; [k: string]: unknown };
  object: { id: string; [k: string]: unknown };
};

export interface LaunchedInput extends ContextOptions {
  auLmsId: string;
  title: LangMap;
  description: LangMap;
  activityType: string | null;
  launchMode: Cmi5LaunchMode;
  launchUrl: string;
  moveOn: Cmi5MoveOn;
  masteryScore: number | null;
  launchParameters: string | null;
}

export function launchedStatement(i: LaunchedInput): LmsStatement {
  const extensions: Record<string, unknown> = {
    [EXT_LAUNCH_MODE]: i.launchMode,
    [EXT_LAUNCH_URL]: i.launchUrl,
    [EXT_MOVE_ON]: i.moveOn,
  };
  if (i.masteryScore !== null) extensions[EXT_MASTERY_SCORE] = i.masteryScore;
  if (i.launchParameters) extensions[EXT_LAUNCH_PARAMETERS] = i.launchParameters;
  return {
    verb: { id: VERBS.launched, display: display('launched') },
    object: {
      objectType: 'Activity',
      id: i.auLmsId,
      definition: {
        name: nonEmpty(i.title),
        description: nonEmpty(i.description),
        ...(i.activityType && isIri(i.activityType) ? { type: i.activityType } : {}),
      },
    },
    context: cmi5Context({ ...i, extensions }),
  };
}

export function abandonedStatement(i: ContextOptions & { auLmsId: string; seconds: number }): LmsStatement {
  return {
    verb: { id: VERBS.abandoned, display: display('abandoned') },
    object: { objectType: 'Activity', id: i.auLmsId },
    result: { duration: isoDuration(i.seconds) },
    context: cmi5Context(i),
  };
}

export function satisfiedStatement(
  i: ContextOptions & { kind: 'block' | 'course'; lmsId: string; title: LangMap; description: LangMap },
): LmsStatement {
  return {
    verb: { id: VERBS.satisfied, display: display('satisfied') },
    object: {
      objectType: 'Activity',
      id: i.lmsId,
      definition: {
        type: i.kind === 'block' ? ACTIVITY_TYPE_BLOCK : ACTIVITY_TYPE_COURSE,
        name: nonEmpty(i.title),
        description: nonEmpty(i.description),
      },
    },
    context: cmi5Context(i),
  };
}

export interface StatementOwner {
  activityId: string;
  courseId: string;
  user: { id: string; name: string };
  attemptId: string;
  registration: string;
  homePage: string;
}

/**
 * Stored times for `count` new statements of a cmi5 registration: one millisecond apart and after every
 * statement the registration already has, so the LRS lists a registration's statements in the order they came
 * (a batch keeps its order, and "satisfied" follows the AU statement that caused it).
 */
export async function nextStoredTimes(db: DB, attemptId: string, count: number, at = Date.now()): Promise<string[]> {
  const latest = await db
    .selectFrom('xapiStatements')
    .select((eb) => eb.fn.max('stored').as('m'))
    .where('attemptId', '=', attemptId)
    .executeTakeFirst();
  const start = Math.max(at, latest?.m ? Date.parse(String(latest.m)) + 1 : 0);
  return Array.from({ length: count }, (_, i) => new Date(start + i).toISOString());
}

const oneLanguage = (map: unknown, length: number): LangMap | undefined => {
  if (!map || typeof map !== 'object') return undefined;
  const tag = pickTag(map as LangMap);
  return tag === undefined ? undefined : { [tag]: String((map as LangMap)[tag] ?? '').slice(0, length) };
};

/**
 * Keeps a statement Coursekit makes within MAX_LMS_STATEMENT_BYTES, the limit of the statements AUs send: a
 * course structure with many or long titles and descriptions keeps one language of them, shortened, and very
 * long launch parameters (always in LMS.LaunchData) are left out of the "launched" statement.
 */
export function fitLmsStatement<T extends Record<string, unknown>>(statement: T): T {
  const size = () => JSON.stringify(statement).length;
  if (size() <= MAX_LMS_STATEMENT_BYTES) return statement;
  const definition = (statement.object as { definition?: Record<string, unknown> } | undefined)?.definition;
  if (definition) {
    for (const key of ['name', 'description'] as const) {
      const short = oneLanguage(definition[key], 500);
      if (short) definition[key] = short;
      else delete definition[key];
    }
  }
  const extensions = (statement.context as { extensions?: Record<string, unknown> } | undefined)?.extensions;
  if (size() > MAX_LMS_STATEMENT_BYTES && extensions) delete extensions[EXT_LAUNCH_PARAMETERS];
  return statement;
}

/** Stores statements Coursekit makes in the registration, in the given order. Returns their ids. */
export async function storeLmsStatements(db: DB, owner: StatementOwner, statements: LmsStatement[], at?: number): Promise<string[]> {
  if (!statements.length) return [];
  const times = await nextStoredTimes(db, owner.attemptId, statements.length, at);
  const actor = cmi5Actor(owner.user, owner.homePage);
  const authority = { objectType: 'Agent', name: 'Coursekit', account: { homePage: owner.homePage, name: 'coursekit' } };
  const rows = statements.map((s, i) => {
    const { id: given, ...rest } = s;
    const id = typeof given === 'string' ? given : randomUUID();
    const stored = times[i]!;
    const statement = fitLmsStatement({ id, actor, ...rest, timestamp: stored, stored, authority, version: '1.0.0' });
    return {
      id,
      activityId: owner.activityId,
      courseId: owner.courseId,
      userId: owner.user.id,
      attemptId: owner.attemptId,
      registration: owner.registration,
      verbId: s.verb.id,
      objectId: s.object.id,
      voided: 0,
      voidsId: null,
      statement: JSON.stringify(statement),
      timestamp: stored,
      stored,
    };
  });
  await db.insertInto('xapiStatements').values(rows).execute();
  return rows.map((r) => r.id);
}
