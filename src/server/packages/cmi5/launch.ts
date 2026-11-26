/**
 * Launching cmi5 AUs (section 8 and 10 of the specification) and ending their sessions.
 *
 * Every launch is a new session of the registration (the Coursekit attempt): open sessions of the registration
 * are abandoned first, the LMS.LaunchData state document and the learner preferences agent profile are written,
 * the "launched" statement is recorded, and the AU's URL gets endpoint, fetch, actor, registration and activityId.
 * Staff previews launch in Browse mode with a preview registration and record nothing; learners reviewing a
 * finished AU, or any AU of an archived course, launch in Review mode, where nothing that counts is recorded
 * (no AU time, results, satisfaction or grade). The mode is decided per AU: in a finished attempt (the course is
 * satisfied), AUs the learner hasn't finished still launch in Normal mode.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Cmi5Launch, Cmi5LaunchMode } from '../../../shared/cmi5.js';
import type { PackageLaunchInput } from '../../../shared/packages.js';
import type { AppDeps } from '../../context.js';
import type { Cmi5SessionRow } from '../../db/schema-cmi5.js';
import type { PackageAttemptRow, PackageVersionRow } from '../../db/schema-packages.js';
import type { DB } from '../../db/types.js';
import { badRequest, forbidden } from '../../lib/http.js';
import { newId, now, parseJson } from '../../lib/util.js';
import type { ActivityAccess } from '../../services/access.js';
import { parseSettings } from '../../services/activity-types.js';
import { CONTENT_PREFIX, refreshAttempt, structureOf, toVersionInfo } from '../service.js';
import { packageSecret, signToken, type TokenPurpose } from '../tokens.js';
import {
  DEFAULT_LANGUAGE,
  EXT_SESSION_ID,
  FETCH_MINUTES,
  LAUNCH_DATA,
  LEARNER_PREFERENCES,
  MAX_SESSIONS_PER_ATTEMPT,
  SESSION_TIMEOUT_HOURS,
} from './constants.js';
import { auFinished, loadAuStates, satisfiedParts, type AuStates } from './results.js';
import {
  abandonedStatement,
  auLmsId,
  blockLmsId,
  cmi5Actor,
  courseLmsId,
  launchedStatement,
  lmsBase,
  satisfiedStatement,
  storeLmsStatements,
  type LmsStatement,
  type StatementOwner,
} from './statements.js';
import { allAus, cmi5Of, type Cmi5Course } from './structure.js';
import { cmi5Secret, signCmi5Token } from './tokens.js';

type Deps = Pick<AppDeps, 'db' | 'events' | 'storage' | 'config'>;

export interface Cmi5LaunchInput extends PackageLaunchInput {
  /** The learner's languages (an Accept-Language header), for the learner preferences document. */
  languages?: string | null | undefined;
}

export interface Cmi5LaunchContext {
  attempt: PackageAttemptRow | null;
  purpose: TokenPurpose;
  version: PackageVersionRow;
  input: Cmi5LaunchInput;
  origin: string;
}

/** The registration staff previews use: the same for one person and activity, so their documents are reused. */
export function previewRegistration(activityId: string, userId: string): string {
  const h = createHash('sha256').update(`coursekit-cmi5-preview\n${activityId}\n${userId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Language tags from an Accept-Language header, best first ("en-GB,en,fr"), or null. */
export function languagePreference(header: string | null | undefined): string | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .slice(0, 20)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([01](\.\d{0,3})?)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: (tag ?? '').trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((t) => t.q > 0 && /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(t.tag))
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((t) => t.tag);
  const unique = [...new Set(tags)].slice(0, 10);
  return unique.length ? unique.join(',') : null;
}

function withQuery(url: string, params: Array<[string, string]>): string {
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const hashAt = url.indexOf('#');
  const [main, hash] = hashAt < 0 ? [url, ''] : [url.slice(0, hashAt), url.slice(hashAt)];
  return `${main}${main.includes('?') ? (main.endsWith('?') || main.endsWith('&') ? '' : '&') : '?'}${query}${hash}`;
}

interface DocumentKey {
  activityId: string;
  kind: 'state' | 'agent_profile';
  ownerId: string;
  activityIri: string;
  registration: string;
  docId: string;
}

/** Writes (or replaces) a JSON document of the LRS on the LMS's behalf. */
export async function writeLmsDocument(db: DB, key: DocumentKey, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  const row = {
    contentType: 'application/json',
    content: bytes.toString('base64'),
    etag: createHash('sha1').update(bytes).digest('hex'),
    updatedAt: now(),
  };
  await db
    .insertInto('xapiDocuments')
    .values({ id: newId(), ...key, ...row })
    .onConflict((oc) => oc.columns(['activityId', 'kind', 'ownerId', 'activityIri', 'registration', 'docId']).doUpdateSet(row))
    .execute();
}

/**
 * The cmi5LearnerPreferences agent profile (section 11.0), a JSON object with both languagePreference and
 * audioPreference. The languages come from the learner's browser; a launch without them keeps the languages of
 * an earlier launch, or uses DEFAULT_LANGUAGE.
 */
async function writeLearnerPreferences(db: DB, activityId: string, userId: string, languages: string | null) {
  const key: DocumentKey = {
    activityId,
    kind: 'agent_profile',
    ownerId: userId,
    activityIri: '',
    registration: '',
    docId: LEARNER_PREFERENCES,
  };
  const existing = await db
    .selectFrom('xapiDocuments')
    .select('content')
    .where('activityId', '=', key.activityId)
    .where('kind', '=', key.kind)
    .where('ownerId', '=', key.ownerId)
    .where('activityIri', '=', '')
    .where('registration', '=', '')
    .where('docId', '=', key.docId)
    .executeTakeFirst();
  if (existing && !languages) {
    const current = parseJson<Record<string, unknown> | null>(Buffer.from(existing.content, 'base64').toString('utf8'), null);
    if (typeof current?.languagePreference === 'string' && current.languagePreference && typeof current.audioPreference === 'string') {
      return;
    }
  }
  await writeLmsDocument(db, key, { languagePreference: languages ?? DEFAULT_LANGUAGE, audioPreference: 'on' });
}

/** Whether the course is archived: its sessions record nothing that counts. */
async function isArchived(db: DB, courseId: string): Promise<boolean> {
  const course = await db.selectFrom('courses').select('visibility').where('id', '=', courseId).executeTakeFirst();
  return course?.visibility === 'archived';
}

async function ownerOf(
  db: DB,
  session: Pick<Cmi5SessionRow, 'activityId' | 'courseId' | 'userId' | 'attemptId' | 'registration' | 'homePage'>,
) {
  if (!session.attemptId) return null;
  const user = await db.selectFrom('users').select(['id', 'name']).where('id', '=', session.userId).executeTakeFirst();
  if (!user) return null;
  return {
    activityId: session.activityId,
    courseId: session.courseId,
    user,
    attemptId: session.attemptId,
    registration: session.registration,
    homePage: session.homePage,
  } satisfies StatementOwner;
}

/**
 * Abandons a session that ended without "terminated" (section 9.3.6): records the abandoned statement with the
 * time from the launch to the session's last request and, for a Normal session of a course that isn't archived,
 * adds that time to the AU. Returns true when it added time, so the caller updates the attempt (refreshAttempt);
 * false for sessions that had already ended, previews, Review sessions and archived courses.
 */
export async function abandonSession(deps: Pick<AppDeps, 'db'>, session: Cmi5SessionRow): Promise<boolean> {
  const { db } = deps;
  const ts = now();
  const seconds = Math.max(0, (Date.parse(session.lastActivityAt) - Date.parse(session.launchedAt)) / 1000);
  const res = await db
    .updateTable('cmi5Sessions')
    .set({ abandonedAt: ts, durationSeconds: seconds })
    .where('id', '=', session.id)
    .where('terminatedAt', 'is', null)
    .where('abandonedAt', 'is', null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) return false;
  const owner = await ownerOf(db, session);
  if (!owner) return false; // previews record nothing
  // Review time, and time in an archived course, doesn't count.
  const counts = session.launchMode === 'Normal' && !(await isArchived(db, session.courseId));
  if (counts) {
    await db
      .updateTable('cmi5AuStates')
      .set((eb) => ({ totalSeconds: eb('totalSeconds', '+', seconds), updatedAt: ts }))
      .where('attemptId', '=', owner.attemptId)
      .where('auKey', '=', session.auKey)
      .execute();
  }
  await storeLmsStatements(db, owner, [
    abandonedStatement({
      registration: session.registration,
      sessionId: session.id,
      publisherId: session.auId,
      auLmsId: session.auLmsId,
      seconds,
    }),
  ]);
  return counts;
}

/** Abandons open sessions nobody used for SESSION_TIMEOUT_HOURS, then updates the attempts whose time changed. */
export async function abandonTimedOut(deps: Deps, scope: { activityId: string; attemptIds?: string[] }): Promise<void> {
  if (scope.attemptIds && !scope.attemptIds.length) return;
  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_HOURS * 3600_000).toISOString();
  let q = deps.db
    .selectFrom('cmi5Sessions')
    .selectAll()
    .where('activityId', '=', scope.activityId)
    .where('terminatedAt', 'is', null)
    .where('abandonedAt', 'is', null)
    .where('lastActivityAt', '<', cutoff);
  if (scope.attemptIds) q = q.where('attemptId', 'in', scope.attemptIds);
  const stale = await q.limit(500).execute();
  const attempts = new Set<string>();
  for (const s of stale) if ((await abandonSession(deps, s)) && s.attemptId) attempts.add(s.attemptId);
  for (const id of attempts) await refreshAttempt(deps, id);
}

/**
 * Records "satisfied" for the blocks and the course the registration newly satisfies (section 9.3.9), once
 * per registration, with the given session id. Returns the statements to store (in order).
 */
export async function newlySatisfied(
  db: DB,
  attemptId: string,
  course: Cmi5Course,
  states: AuStates,
  ctx: { registration: string; sessionId: string; base: string },
): Promise<LmsStatement[]> {
  const parts = satisfiedParts(course, states);
  if (!parts.length) return [];
  const done = new Set(
    (await db.selectFrom('cmi5Satisfied').select('nodeKey').where('attemptId', '=', attemptId).execute()).map((r) => r.nodeKey),
  );
  const out: LmsStatement[] = [];
  for (const part of parts) {
    const nodeKey = part.kind === 'course' ? '' : part.block.key;
    if (done.has(nodeKey)) continue;
    const node = part.kind === 'course' ? course : part.block;
    const statementId = randomUUID();
    const inserted = await db
      .insertInto('cmi5Satisfied')
      .values({ attemptId, nodeKey, kind: part.kind, sessionId: ctx.sessionId, statementId, satisfiedAt: now() })
      .onConflict((oc) => oc.columns(['attemptId', 'nodeKey']).doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) continue; // another request recorded it
    out.push({
      id: statementId,
      ...satisfiedStatement({
        kind: part.kind,
        lmsId: part.kind === 'course' ? courseLmsId(ctx.base) : blockLmsId(ctx.base, part.block.key),
        publisherId: node.id,
        title: node.title,
        description: node.description,
        registration: ctx.registration,
        sessionId: ctx.sessionId,
      }),
    });
  }
  return out;
}

export async function launchCmi5(deps: Deps, access: ActivityAccess, ctx: Cmi5LaunchContext): Promise<Cmi5Launch> {
  const { db, config } = deps;
  const { activity, user } = access;
  const { attempt, version } = ctx;
  const structure = structureOf(version);
  const course = cmi5Of(structure);
  if (!course) throw badRequest('This package has nothing to launch.');
  const aus = allAus(course.children);
  const settings = parseSettings('package', activity.settings);
  const homePage = (config.publicUrl ?? ctx.origin).replace(/\/+$/, '');
  const states: AuStates = attempt ? await loadAuStates(db, attempt.id) : new Map();
  const sessionCount = attempt
    ? Number(
        (
          await db
            .selectFrom('cmi5Sessions')
            .select((eb) => eb.fn.countAll().as('n'))
            .where('attemptId', '=', attempt.id)
            .executeTakeFirst()
        )?.n ?? 0,
      )
    : 0;
  // Every launch adds a session and Coursekit's own statements to the attempt: launches are bounded.
  if (sessionCount >= MAX_SESSIONS_PER_ATTEMPT) {
    throw forbidden(`This attempt has been opened ${MAX_SESSIONS_PER_ATTEMPT.toLocaleString('en')} times, which is the most it can be.`);
  }

  let au = ctx.input.itemId ? aus.find((a) => a.key === ctx.input.itemId) : undefined;
  // An attempt nothing was launched in yet starts on the current version, whose AUs may differ from the ones the
  // learner saw last ("Start a new attempt" after the course was replaced): it starts with its first AU instead.
  if (ctx.input.itemId && !au && !(attempt && sessionCount === 0)) throw badRequest('That part of the course does not exist.');
  au ??= aus.find((a) => !auFinished(a, states.get(a.key))) ?? aus[0];
  const item = au && structure.items.find((i) => i.id === au!.key && i.launchable);
  if (!au || !item || (!au.external && !item.href)) throw badRequest('This package has nothing to launch.');
  if (au.external && new URL(au.url).origin === new URL(homePage).origin) {
    throw badRequest(
      "This AU's address is on this Coursekit site, which isn't allowed for AUs hosted elsewhere. Ask your teacher to fix the package.",
    );
  }

  // Decided per AU, before anything is recorded (the registration's first launch may satisfy the course): Review
  // is for revisiting an AU the learner finished (section 10.2.2), and for archived courses. A finished attempt
  // (the course is satisfied) still launches the AUs the learner hasn't finished in Normal mode.
  const launchMode: Cmi5LaunchMode =
    ctx.purpose === 'preview' ? 'Browse' : access.readOnly || auFinished(au, states.get(au.key)) ? 'Review' : 'Normal';
  const counts = !!attempt && launchMode === 'Normal';
  const registration = attempt ? attempt.registration.toLowerCase() : previewRegistration(activity.id, user.id);
  const base = lmsBase(homePage, activity.id);
  const auActivityId = auLmsId(base, au.key);
  const sessionId = randomUUID();

  // A registration has one session at a time (section 9.3.6): earlier open sessions are abandoned.
  let open = db
    .selectFrom('cmi5Sessions')
    .selectAll()
    .where('activityId', '=', activity.id)
    .where('terminatedAt', 'is', null)
    .where('abandonedAt', 'is', null);
  open = attempt ? open.where('attemptId', '=', attempt.id) : open.where('userId', '=', user.id).where('attemptId', 'is', null);
  let timeAdded = false;
  for (const s of await open.execute()) if (await abandonSession(deps, s)) timeAdded = true;
  if (!attempt) {
    // Old preview sessions are of no use once they ended.
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    await db
      .deleteFrom('cmi5Sessions')
      .where('activityId', '=', activity.id)
      .where('userId', '=', user.id)
      .where('attemptId', 'is', null)
      .where('launchedAt', '<', dayAgo)
      .execute();
  }

  const secret = await packageSecret(db);
  let target: string;
  if (au.external) target = au.url;
  else {
    const purpose: TokenPurpose = launchMode === 'Browse' ? 'preview' : launchMode === 'Review' ? 'review' : 'play';
    const token = signToken(secret, { a: activity.id, v: version.id, u: user.id, t: attempt?.id ?? '', p: purpose, i: au.key });
    target = `${CONTENT_PREFIX}${token}/${item.href}`;
  }
  const launchUrl = au.external ? target : `${homePage}${target}`;
  const ts = now();
  await db
    .insertInto('cmi5Sessions')
    .values({
      id: sessionId,
      activityId: activity.id,
      courseId: activity.courseId,
      userId: user.id,
      versionId: version.id,
      attemptId: attempt?.id ?? null,
      registration,
      auKey: au.key,
      auId: au.id,
      auLmsId: auActivityId,
      homePage,
      launchMode,
      launchMethod: au.launchMethod,
      moveOn: au.moveOn,
      masteryScore: au.masteryScore,
      launchUrl,
      fetchedAt: null,
      preferencesReadAt: null,
      launchedAt: ts,
      initializedAt: null,
      terminatedAt: null,
      abandonedAt: null,
      lastActivityAt: ts,
      completed: 0,
      resultVerb: null,
      durationSeconds: 0,
    })
    .execute();

  // LMS.LaunchData (section 10) and the learner preferences (section 11), before the AU opens.
  await writeLmsDocument(
    db,
    { activityId: activity.id, kind: 'state', ownerId: user.id, activityIri: auActivityId, registration, docId: LAUNCH_DATA },
    {
      contextTemplate: { contextActivities: { grouping: [{ id: au.id }] }, extensions: { [EXT_SESSION_ID]: sessionId } },
      launchMode,
      launchMethod: au.launchMethod,
      moveOn: au.moveOn,
      ...(au.masteryScore !== null ? { masteryScore: au.masteryScore } : {}),
      returnURL: `${homePage}/cmi5/return/${encodeURIComponent(access.course.slug)}/${encodeURIComponent(activity.id)}`,
      ...(au.launchParameters ? { launchParameters: au.launchParameters } : {}),
      ...(au.entitlementKey ? { entitlementKey: { courseStructure: au.entitlementKey } } : {}),
    },
  );
  await writeLearnerPreferences(db, activity.id, user.id, languagePreference(ctx.input.languages));

  if (attempt) {
    // Only Normal launches count: Review sessions leave the AU's state (sessions, first launch) as it was.
    let satisfied: LmsStatement[] = [];
    if (counts) {
      await db
        .insertInto('cmi5AuStates')
        .values({
          attemptId: attempt.id,
          auKey: au.key,
          completedAt: null,
          passedAt: null,
          failedAt: null,
          score: null,
          sessions: 0,
          totalSeconds: 0,
          firstLaunchedAt: ts,
          lastLaunchedAt: ts,
          updatedAt: ts,
        })
        .onConflict((oc) => oc.columns(['attemptId', 'auKey']).doNothing())
        .execute();
      await db
        .updateTable('cmi5AuStates')
        .set((eb) => ({ sessions: eb('sessions', '+', 1), lastLaunchedAt: ts, updatedAt: ts }))
        .where('attemptId', '=', attempt.id)
        .where('auKey', '=', au.key)
        .execute();
      // moveOn is evaluated for the registration (section 9.6.1): NotApplicable AUs may satisfy blocks and the
      // course straight away. Those statements aren't part of this AU session, so they get a session id of their own.
      satisfied = await newlySatisfied(db, attempt.id, course, await loadAuStates(db, attempt.id), {
        registration,
        sessionId: randomUUID(),
        base,
      });
    }
    const owner: StatementOwner = {
      activityId: activity.id,
      courseId: activity.courseId,
      user,
      attemptId: attempt.id,
      registration,
      homePage,
    };
    await storeLmsStatements(db, owner, [
      ...satisfied,
      launchedStatement({
        registration,
        sessionId,
        publisherId: au.id,
        auLmsId: auActivityId,
        title: au.title,
        description: au.description,
        activityType: au.activityType,
        launchMode,
        launchUrl,
        moveOn: au.moveOn,
        masteryScore: au.masteryScore,
        launchParameters: au.launchParameters,
      }),
    ]);
    if (counts) {
      await db.updateTable('packageAttempts').set({ lastItemId: au.key, lastAccessedAt: ts }).where('id', '=', attempt.id).execute();
    }
    // A launch changes the attempt's results only with the registration's first launch, the blocks and the course
    // a registration-time evaluation satisfied, or the time of an abandoned Normal session. Otherwise the attempt
    // and the grade (which may be a teacher's override) are left alone.
    if ((counts && (attempt.completionStatus === 'not attempted' || satisfied.length > 0)) || timeAdded) {
      await refreshAttempt(deps, attempt.id);
    }
  }

  const fetchToken = signCmi5Token(await cmi5Secret(db), 'fetch', sessionId, FETCH_MINUTES * 60);
  const url = withQuery(target, [
    ['endpoint', `${homePage}/xapi/`],
    ['fetch', `${homePage}/cmi5/fetch/${fetchToken}`],
    ['actor', JSON.stringify(cmi5Actor(user, homePage))],
    ['registration', registration],
    ['activityId', auActivityId],
  ]);
  return {
    url,
    attemptId: attempt?.id ?? null,
    itemId: au.key,
    mode: launchMode === 'Normal' ? 'normal' : launchMode === 'Review' ? 'review' : 'browse',
    display: au.launchMethod === 'OwnWindow' ? 'window' : settings.display,
    items: toVersionInfo(version).items,
    cmi5: { launchMode, launchMethod: au.launchMethod, external: au.external, sessionId },
  };
}
