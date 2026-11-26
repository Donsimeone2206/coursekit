/**
 * A small Learning Record Store for xAPI packages, outside /api under /xapi/: About, Statements
 * (PUT, POST, GET, voiding), the Activity State API and the Activity and Agent Profile APIs.
 *
 * Packages authenticate with the Basic credentials minted at launch: a signed token bound to the
 * learner, the activity and the attempt (its registration). They can only write statements for their
 * own actor and registration, and only read their own statements and documents. Preview and review
 * credentials read but record nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from '../context.js';
import type { ActivityRow } from '../db/schema.js';
import type { PackageAttemptRow, XapiDocumentRow } from '../db/schema-packages.js';
import { newId, now, parseJson } from '../lib/util.js';
import { loadActivityAccess } from '../services/access.js';
import {
  afterCmi5Plan,
  applyCmi5Plan,
  checkCmi5Statements,
  cmi5LmsStatementCount,
  cmi5Lrs,
  cmi5Rejection,
  guardCmi5Document,
  guardCmi5Registration,
  noteCmi5DocumentRead,
  previewCmi5Statements,
  PROTECTED_STATE_ID,
  type Cmi5Lrs,
} from './cmi5/lrs.js';
import { nextStoredTimes } from './cmi5/statements.js';
import { isCmi5Credential } from './cmi5/tokens.js';
import { refreshAttempt, xapiActor } from './service.js';
import { packageSecret, SESSION_GRACE_SECONDS, verifyToken, type PackageToken } from './tokens.js';

const VERSIONS = ['1.0.3', '2.0.0'];
const MAX_BODY = 1024 * 1024;
const MAX_BATCH = 200;
const MAX_STATEMENTS_PER_ATTEMPT = 10_000;
const MAX_STATEMENT_BYTES = 32 * 1024;
const MAX_ATTEMPT_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENTS = 1000;
/** Most bytes (as stored, base64) the state and profile documents of one learner in one activity may take. */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/**
 * Longest activityId and stateId or profileId of a document, in UTF-8 bytes. Both are in the documents' unique
 * index, whose entries PostgreSQL limits to 2704 bytes; counting bytes keeps the limits the same on SQLite.
 */
const MAX_DOCUMENT_IRI_BYTES = 2048;
const MAX_DOCUMENT_ID_BYTES = 500;
const VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_IRI = /^[a-z][a-z0-9+.-]*:\S+$/i;
const RE_DURATION =
  /^P(?=\d|T\d)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/;
const RE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

class XapiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 413,
    message: string,
  ) {
    super(message);
  }
}

interface Lrs {
  token: PackageToken;
  activity: ActivityRow;
  attempt: PackageAttemptRow | null;
  /** Statements and documents are stored (false for previews and reviews). */
  records: boolean;
  homePage: string;
  user: { id: string; name: string };
  /** Set for cmi5 session credentials: the cmi5 statement and document rules apply (cmi5/lrs.ts). */
  cmi5?: Cmi5Lrs;
}

const sha1 = (data: Uint8Array | string) => createHash('sha1').update(data).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function sameAgent(agent: unknown, lrs: Lrs): boolean {
  if (!isObject(agent) || (agent.objectType !== undefined && agent.objectType !== 'Agent')) return false;
  const account = agent.account;
  if (!isObject(account) || agent.mbox || agent.mbox_sha1sum || agent.openid) return false;
  return String(account.homePage ?? '').replace(/\/+$/, '') === lrs.homePage && account.name === lrs.user.id;
}

function parseAgentParam(raw: string | undefined, lrs: Lrs): void {
  if (!raw) throw new XapiError(400, 'The agent parameter is required.');
  let agent: unknown;
  try {
    agent = JSON.parse(raw);
  } catch {
    throw new XapiError(400, 'The agent parameter must be JSON.');
  }
  if (!sameAgent(agent, lrs)) throw new XapiError(403, 'These credentials can only use the launched learner.');
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], what: string) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new XapiError(400, `Unexpected property "${key}" in ${what}.`);
}

function checkLanguageMap(value: unknown, what: string) {
  if (value === undefined) return;
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== 'string'))
    throw new XapiError(400, `${what} must be a language map.`);
}

function checkActivity(obj: Record<string, unknown>) {
  if (typeof obj.id !== 'string' || !RE_IRI.test(obj.id) || obj.id.length > 2048) throw new XapiError(400, 'An activity needs an IRI id.');
  checkKeys(obj, ['objectType', 'id', 'definition'], 'the activity');
  if (obj.definition !== undefined) {
    if (!isObject(obj.definition)) throw new XapiError(400, 'The activity definition must be an object.');
    checkLanguageMap(obj.definition.name, 'definition.name');
    checkLanguageMap(obj.definition.description, 'definition.description');
  }
}

function checkObject(object: unknown, lrs: Lrs, sub: boolean) {
  if (!isObject(object)) throw new XapiError(400, 'The statement needs an object.');
  const type = object.objectType ?? 'Activity';
  if (type === 'Activity') checkActivity(object);
  else if (type === 'StatementRef') {
    if (typeof object.id !== 'string' || !RE_UUID.test(object.id)) throw new XapiError(400, 'A StatementRef needs a statement id.');
  } else if (type === 'Agent' || type === 'Group') {
    if (!object.account && !object.mbox && !object.mbox_sha1sum && !object.openid && type === 'Agent') {
      throw new XapiError(400, 'An agent needs an identifier.');
    }
  } else if (type === 'SubStatement' && !sub) {
    for (const key of ['id', 'stored', 'version', 'authority'])
      if (key in object) throw new XapiError(400, `A SubStatement can't have "${key}".`);
    checkStatement(object, lrs, true);
  } else {
    throw new XapiError(400, `Unknown object type "${String(type)}".`);
  }
}

function checkResult(result: unknown) {
  if (result === undefined) return;
  if (!isObject(result)) throw new XapiError(400, 'result must be an object.');
  checkKeys(result, ['score', 'success', 'completion', 'response', 'duration', 'extensions'], 'result');
  if (result.success !== undefined && typeof result.success !== 'boolean')
    throw new XapiError(400, 'result.success must be true or false.');
  if (result.completion !== undefined && typeof result.completion !== 'boolean')
    throw new XapiError(400, 'result.completion must be true or false.');
  if (result.duration !== undefined && (typeof result.duration !== 'string' || !RE_DURATION.test(result.duration))) {
    throw new XapiError(400, 'result.duration must be an ISO 8601 duration.');
  }
  const score = result.score;
  if (score !== undefined) {
    if (!isObject(score)) throw new XapiError(400, 'result.score must be an object.');
    checkKeys(score, ['scaled', 'raw', 'min', 'max'], 'result.score');
    for (const key of ['scaled', 'raw', 'min', 'max']) {
      if (score[key] !== undefined && (typeof score[key] !== 'number' || !Number.isFinite(score[key])))
        throw new XapiError(400, `result.score.${key} must be a number.`);
    }
    const { scaled, raw, min, max } = score as Record<string, number | undefined>;
    if (scaled !== undefined && (scaled < -1 || scaled > 1)) throw new XapiError(400, 'result.score.scaled must be between -1 and 1.');
    if (min !== undefined && max !== undefined && min > max) throw new XapiError(400, 'result.score.min is above max.');
    if (raw !== undefined && ((min !== undefined && raw < min) || (max !== undefined && raw > max)))
      throw new XapiError(400, 'result.score.raw is outside min and max.');
  }
}

function checkStatement(st: Record<string, unknown>, lrs: Lrs, sub: boolean) {
  checkKeys(
    st,
    sub
      ? ['objectType', 'actor', 'verb', 'object', 'result', 'context', 'timestamp', 'attachments']
      : ['id', 'actor', 'verb', 'object', 'result', 'context', 'timestamp', 'stored', 'authority', 'version', 'attachments', 'objectType'],
    'the statement',
  );
  if (!sub && st.objectType !== undefined) throw new XapiError(400, 'A statement has no objectType.');
  if (st.attachments !== undefined) throw new XapiError(400, 'Statement attachments are not supported.');
  if (!sub && st.id !== undefined && (typeof st.id !== 'string' || !RE_UUID.test(st.id)))
    throw new XapiError(400, 'The statement id must be a UUID.');
  if (!sub && !sameAgent(st.actor, lrs)) throw new XapiError(403, 'These credentials can only send statements about the launched learner.');
  if (sub && !isObject(st.actor)) throw new XapiError(400, 'The statement needs an actor.');
  const verb = st.verb;
  if (!isObject(verb) || typeof verb.id !== 'string' || !RE_IRI.test(verb.id))
    throw new XapiError(400, 'The statement needs a verb with an IRI id.');
  checkKeys(verb, ['id', 'display'], 'the verb');
  checkLanguageMap(verb.display, 'verb.display');
  checkObject(st.object, lrs, sub);
  checkResult(st.result);
  if (st.context !== undefined && !isObject(st.context)) throw new XapiError(400, 'context must be an object.');
  if (
    st.timestamp !== undefined &&
    (typeof st.timestamp !== 'string' || !RE_TIMESTAMP.test(st.timestamp) || Number.isNaN(Date.parse(st.timestamp)))
  ) {
    throw new XapiError(400, 'timestamp must be an ISO 8601 date and time.');
  }
  if (!sub && st.version !== undefined && (typeof st.version !== 'string' || !/^(1\.0|2\.0)(\.\d+)?$/.test(st.version))) {
    throw new XapiError(400, 'Unsupported statement version.');
  }
  if (!sub) {
    const registration = isObject(st.context) ? st.context.registration : undefined;
    if (registration !== undefined && (typeof registration !== 'string' || !RE_UUID.test(registration))) {
      throw new XapiError(400, 'context.registration must be a UUID.');
    }
    if (lrs.attempt && String(registration ?? '').toLowerCase() !== lrs.attempt.registration.toLowerCase()) {
      throw new XapiError(403, 'These credentials can only send statements for the launched registration.');
    }
  }
}

function errorResponse(c: Context, err: XapiError) {
  return c.json({ error: { message: err.message } }, err.status);
}

export function xapiRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, config } = deps;

  r.use('/xapi/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header(
      'Access-Control-Expose-Headers',
      'ETag, Last-Modified, Content-Type, X-Experience-API-Version, X-Experience-API-Consistent-Through',
    );
    c.header('Cache-Control', 'no-store');
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Experience-API-Version, If-Match, If-None-Match');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }
    const requested = c.req.header('x-experience-api-version');
    const version = requested && (/^2\.0(\.\d+)?$/.test(requested) ? '2.0.0' : /^1\.0(\.\d+)?$/.test(requested) ? '1.0.3' : null);
    c.header('X-Experience-API-Version', version || '1.0.3');
    if (c.req.path !== '/xapi/about') {
      if (!requested) return c.json({ error: { message: 'The X-Experience-API-Version header is required.' } }, 400);
      if (!version) return c.json({ error: { message: `Unsupported xAPI version ${requested}.` } }, 400);
    }
    await next();
  });
  r.use('/xapi/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: { message: 'The request body is too large.' } }, 413) }));

  r.get('/xapi/about', (c) => c.json({ version: VERSIONS }));

  async function auth(c: Context): Promise<Lrs> {
    const header = c.req.header('authorization') ?? '';
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
    if (!match) throw new XapiError(401, 'Authentication is required.');
    const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
    // Recording credentials keep working for a grace period after expiry, so a page left open keeps saving.
    const raw = decoded.slice(decoded.indexOf(':') + 1);
    if (isCmi5Credential(raw)) return cmi5Lrs(deps, c, raw);
    const secret = await packageSecret(db);
    let token = verifyToken(secret, raw);
    if (!token) {
      const late = verifyToken(secret, raw, SESSION_GRACE_SECONDS);
      if (late?.t && late.i === 'xapi') token = late;
    }
    if (!token || token.p !== 'xapi') throw new XapiError(401, 'These credentials have expired or are not valid. Open the activity again.');
    const activity = await db.selectFrom('activities').selectAll().where('id', '=', token.a).executeTakeFirst();
    const user = await db.selectFrom('users').selectAll().where('id', '=', token.u).executeTakeFirst();
    if (!activity || !user || user.status !== 'active') throw new XapiError(401, 'These credentials are no longer valid.');
    // The learner must still be allowed to open the activity (enrolment, visibility and group restrictions).
    try {
      const access = await loadActivityAccess(db, user, activity.id);
      if (token.p === 'xapi' && token.i === 'xapi' && access.enrolment?.role !== 'student') throw new Error('not a learner');
    } catch {
      throw new XapiError(403, 'You can no longer open this activity.');
    }
    let attempt: PackageAttemptRow | null = null;
    if (token.t) {
      attempt = (await db.selectFrom('packageAttempts').selectAll().where('id', '=', token.t).executeTakeFirst()) ?? null;
      if (!attempt || attempt.userId !== user.id || attempt.activityId !== activity.id)
        throw new XapiError(401, 'These credentials are no longer valid.');
    }
    const homePage = (config.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, '');
    return { token, activity, attempt, records: !!attempt && token.i === 'xapi', homePage, user };
  }

  function handle(fn: (c: Context, lrs: Lrs) => Promise<Response>) {
    return async (c: Context) => {
      try {
        return await fn(c, await auth(c));
      } catch (err) {
        if (err instanceof XapiError) return errorResponse(c, err);
        const cmi5 = cmi5Rejection(err);
        if (cmi5) return errorResponse(c, new XapiError(cmi5.status, cmi5.message));
        throw err;
      }
    };
  }

  async function readJson(c: Context): Promise<unknown> {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/json')) throw new XapiError(400, 'Statements must be sent as application/json.');
    try {
      return JSON.parse(await c.req.text());
    } catch {
      throw new XapiError(400, 'The request body is not valid JSON.');
    }
  }

  /** Validates and stores statements (all or none). Returns their ids. */
  async function store(lrs: Lrs, input: Record<string, unknown>[], fixedId?: string): Promise<string[]> {
    if (input.length > MAX_BATCH) throw new XapiError(413, `Send at most ${MAX_BATCH} statements at a time.`);
    const ids = new Set<string>();
    const prepared = input.map((raw) => {
      if (!isObject(raw)) throw new XapiError(400, 'Each statement must be an object.');
      if (fixedId) {
        if (raw.id !== undefined && String(raw.id).toLowerCase() !== fixedId)
          throw new XapiError(400, 'The statementId parameter and the statement id differ.');
        raw.id = fixedId;
      }
      checkStatement(raw, lrs, false);
      if (JSON.stringify(raw).length > MAX_STATEMENT_BYTES) throw new XapiError(413, 'A statement is too large.');
      const id = (typeof raw.id === 'string' ? raw.id : randomUUID()).toLowerCase();
      if (ids.has(id)) throw new XapiError(400, 'The same statement id appears twice.');
      ids.add(id);
      return { id, raw };
    });
    if (!lrs.records) {
      if (lrs.cmi5) await previewCmi5Statements(deps, lrs.cmi5, prepared);
      return prepared.map((p) => p.id);
    }

    const existing = await db
      .selectFrom('xapiStatements')
      .select(['id', 'statement', 'activityId', 'userId'])
      .where('id', 'in', [...ids])
      .execute();
    const existingIds = new Set<string>();
    for (const row of existing) {
      const mine = prepared.find((p) => p.id === row.id)!;
      const stored = parseJson<Record<string, unknown>>(row.statement, {});
      const { stored: _s, authority: _a, version: _v, timestamp: _t, ...a } = stored;
      const { stored: _s2, authority: _a2, version: _v2, timestamp: _t2, ...b } = { ...mine.raw, id: mine.id } as Record<string, unknown>;
      if (row.activityId !== lrs.activity.id || row.userId !== lrs.user.id || JSON.stringify(sortKeys(a)) !== JSON.stringify(sortKeys(b))) {
        throw new XapiError(409, `A different statement with id ${row.id} already exists.`);
      }
      existingIds.add(row.id);
    }
    const fresh = prepared.filter((p) => !existingIds.has(p.id));
    if (!fresh.length) return prepared.map((p) => p.id);
    const cmi5Plan = lrs.cmi5 ? await checkCmi5Statements(deps, lrs.cmi5, fresh) : null;
    const usage = await db
      .selectFrom('xapiStatements')
      .select((eb) => [eb.fn.countAll().as('n'), eb.fn.sum(eb.fn('length', ['statement'])).as('bytes')])
      .where('attemptId', '=', lrs.attempt!.id)
      .executeTakeFirst();
    const freshBytes = fresh.reduce((sum, p) => sum + JSON.stringify(p.raw).length, 0);
    // cmi5: Coursekit's own statements (launched, abandoned, satisfied) don't count toward the AU's allowance.
    const lmsMade = lrs.cmi5 ? await cmi5LmsStatementCount(db, lrs.attempt!.id) : 0;
    if (
      Number(usage?.n ?? 0) - lmsMade + fresh.length > MAX_STATEMENTS_PER_ATTEMPT ||
      Number(usage?.bytes ?? 0) + freshBytes > MAX_ATTEMPT_BYTES
    ) {
      throw new XapiError(403, 'This attempt has sent too many statements.');
    }

    const storedNow = now();
    // cmi5 registrations keep their statements in order (one millisecond apart, see cmi5/statements.ts).
    const cmi5Times = lrs.cmi5 ? await nextStoredTimes(db, lrs.attempt!.id, fresh.length) : null;
    const authority = { objectType: 'Agent', name: 'Coursekit', account: { homePage: lrs.homePage, name: 'coursekit' } };
    const voids: string[] = [];
    const rows = fresh.map(({ id, raw }, i) => {
      const stored = cmi5Times?.[i] ?? storedNow;
      const object = raw.object as Record<string, unknown>;
      const verbId = (raw.verb as { id: string }).id;
      if (verbId === VOIDED) {
        if (object.objectType !== 'StatementRef') throw new XapiError(400, 'A voiding statement must point to a statement.');
        voids.push(String(object.id).toLowerCase());
      }
      const statement = { ...raw, id, timestamp: raw.timestamp ?? stored, stored, authority, version: raw.version ?? '1.0.0' };
      return {
        id,
        activityId: lrs.activity.id,
        courseId: lrs.activity.courseId,
        userId: lrs.user.id,
        attemptId: lrs.attempt!.id,
        registration: lrs.attempt!.registration,
        verbId,
        objectId: typeof object.id === 'string' ? object.id : null,
        voided: 0,
        voidsId: verbId === VOIDED ? String(object.id).toLowerCase() : null,
        statement: JSON.stringify(statement),
        timestamp: new Date(String(statement.timestamp)).toISOString(),
        stored,
      };
    });
    if (voids.length) {
      const targets = await db
        .selectFrom('xapiStatements')
        .select(['id', 'verbId', 'userId', 'activityId'])
        .where('id', 'in', voids)
        .execute();
      for (const t of targets) {
        if (t.verbId === VOIDED) throw new XapiError(400, "A voiding statement can't be voided.");
        if (t.userId !== lrs.user.id || t.activityId !== lrs.activity.id)
          throw new XapiError(403, 'You can only void your own statements.');
      }
    }
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('xapiStatements').values(rows).execute();
      if (voids.length) {
        await trx
          .updateTable('xapiStatements')
          .set({ voided: 1 })
          .where('id', 'in', voids)
          .where('userId', '=', lrs.user.id)
          .where('verbId', '!=', VOIDED)
          .execute();
      }
      if (cmi5Plan) await applyCmi5Plan(trx, cmi5Plan);
    });
    // cmi5: "satisfied" statements, and the attempt only when something that counts changed (cmi5/lrs.ts).
    if (cmi5Plan) await afterCmi5Plan(deps, cmi5Plan);
    else await refreshAttempt(deps, lrs.attempt!.id);
    return prepared.map((p) => p.id);
  }

  r.put(
    '/xapi/statements',
    handle(async (c, lrs) => {
      const id = (c.req.query('statementId') ?? '').toLowerCase();
      if (!RE_UUID.test(id)) throw new XapiError(400, 'The statementId parameter must be a UUID.');
      const body = await readJson(c);
      if (!isObject(body)) throw new XapiError(400, 'Send one statement.');
      await store(lrs, [body], id);
      return c.body(null, 204);
    }),
  );

  r.post(
    '/xapi/statements',
    handle(async (c, lrs) => {
      const body = await readJson(c);
      const list = Array.isArray(body) ? body : [body];
      return c.json(await store(lrs, list as Record<string, unknown>[]));
    }),
  );

  r.get(
    '/xapi/statements',
    handle(async (c, lrs) => {
      const q = c.req.query();
      c.header('X-Experience-API-Consistent-Through', now());
      const scope = () =>
        db
          .selectFrom('xapiStatements')
          .select(['id', 'statement', 'stored'])
          .where('activityId', '=', lrs.activity.id)
          .where('userId', '=', lrs.user.id)
          .where('attemptId', 'is not', null)
          // cmi5 session credentials only read their own registration.
          .$if(!!lrs.cmi5, (q) => q.where('registration', '=', lrs.cmi5!.session.registration));
      if (q.statementId !== undefined || q.voidedStatementId !== undefined) {
        const allowed = ['statementId', 'voidedStatementId', 'format', 'attachments'];
        if (Object.keys(q).some((k) => !allowed.includes(k)) || (q.statementId !== undefined && q.voidedStatementId !== undefined)) {
          throw new XapiError(400, 'statementId and voidedStatementId cannot be combined with other filters.');
        }
        const voided = q.voidedStatementId !== undefined;
        const id = String(q.statementId ?? q.voidedStatementId).toLowerCase();
        if (!RE_UUID.test(id)) throw new XapiError(400, 'The statement id must be a UUID.');
        const row = await scope()
          .where('id', '=', id)
          .where('voided', '=', voided ? 1 : 0)
          .executeTakeFirst();
        if (!row) throw new XapiError(404, 'No statement with that id.');
        c.header('Last-Modified', new Date(row.stored).toUTCString());
        return c.json(JSON.parse(row.statement));
      }
      const limit = q.limit === undefined || q.limit === '0' ? 100 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 0) throw new XapiError(400, 'limit must be a whole number.');
      const pageSize = Math.min(limit, 500);
      const ascending = q.ascending === 'true';
      let query = scope().where('voided', '=', 0);
      if (q.agent !== undefined) {
        let agent: unknown;
        try {
          agent = JSON.parse(q.agent);
        } catch {
          throw new XapiError(400, 'The agent parameter must be JSON.');
        }
        if (!sameAgent(agent, lrs)) return c.json({ statements: [], more: '' });
      }
      if (q.verb) query = query.where('verbId', '=', q.verb);
      if (q.activity) query = query.where('objectId', '=', q.activity);
      if (q.registration) query = query.where('registration', '=', q.registration.toLowerCase());
      const isoParam = (value: string, name: string) => {
        const t = Date.parse(value);
        if (Number.isNaN(t)) throw new XapiError(400, `${name} must be a timestamp.`);
        return new Date(t).toISOString();
      };
      if (q.since) query = query.where('stored', '>', isoParam(q.since, 'since'));
      if (q.until) query = query.where('stored', '<=', isoParam(q.until, 'until'));
      if (q.cursor) {
        const cursor = parseJson<{ s?: string; i?: string }>(Buffer.from(q.cursor, 'base64url').toString('utf8'), {});
        if (typeof cursor.s !== 'string' || typeof cursor.i !== 'string') throw new XapiError(400, 'The more link is not valid.');
        const { s, i } = cursor as { s: string; i: string };
        query = query.where((eb) =>
          ascending
            ? eb.or([eb('stored', '>', s), eb.and([eb('stored', '=', s), eb('id', '>', i)])])
            : eb.or([eb('stored', '<', s), eb.and([eb('stored', '=', s), eb('id', '<', i)])]),
        );
      }
      const rows = await query
        .orderBy('stored', ascending ? 'asc' : 'desc')
        .orderBy('id', ascending ? 'asc' : 'desc')
        .limit(pageSize + 1)
        .execute();
      const page = rows.slice(0, pageSize);
      let more = '';
      if (rows.length > pageSize && page.length) {
        const last = page[page.length - 1]!;
        const params = new URLSearchParams(Object.entries(q).filter(([k]) => k !== 'cursor'));
        params.set('cursor', Buffer.from(JSON.stringify({ s: last.stored, i: last.id })).toString('base64url'));
        more = `/xapi/statements?${params.toString()}`;
      }
      return c.json({ statements: page.map((r) => JSON.parse(r.statement)), more });
    }),
  );

  // ----- documents: state, activity profile, agent profile -----

  type DocKind = XapiDocumentRow['kind'];
  interface DocKey {
    kind: DocKind;
    ownerId: string;
    activityIri: string;
    registration: string;
  }

  function stateKey(c: Context, lrs: Lrs): DocKey {
    const activityId = c.req.query('activityId') ?? '';
    if (!RE_IRI.test(activityId)) throw new XapiError(400, 'The activityId parameter must be an IRI.');
    if (Buffer.byteLength(activityId) > MAX_DOCUMENT_IRI_BYTES)
      throw new XapiError(400, `The activityId parameter must be at most ${MAX_DOCUMENT_IRI_BYTES} bytes.`);
    parseAgentParam(c.req.query('agent'), lrs);
    const registration = (c.req.query('registration') ?? '').toLowerCase();
    if (registration && !RE_UUID.test(registration)) throw new XapiError(400, 'The registration parameter must be a UUID.');
    if (lrs.cmi5) guardCmi5Registration(lrs.cmi5, registration);
    return { kind: 'state', ownerId: lrs.user.id, activityIri: activityId, registration };
  }
  /**
   * Activity profiles are kept per learner: the credentials belong to one learner, and a profile shared by
   * the whole class would let any learner read, change or delete what every other learner's package uses.
   */
  function activityProfileKey(c: Context, lrs: Lrs): DocKey {
    const activityId = c.req.query('activityId') ?? '';
    if (!RE_IRI.test(activityId)) throw new XapiError(400, 'The activityId parameter must be an IRI.');
    if (Buffer.byteLength(activityId) > MAX_DOCUMENT_IRI_BYTES)
      throw new XapiError(400, `The activityId parameter must be at most ${MAX_DOCUMENT_IRI_BYTES} bytes.`);
    return { kind: 'activity_profile', ownerId: lrs.user.id, activityIri: activityId, registration: '' };
  }
  function agentProfileKey(c: Context, lrs: Lrs): DocKey {
    parseAgentParam(c.req.query('agent'), lrs);
    return { kind: 'agent_profile', ownerId: lrs.user.id, activityIri: '', registration: '' };
  }

  const docQuery = (lrs: Lrs, key: DocKey) =>
    db
      .selectFrom('xapiDocuments')
      .selectAll()
      .where('activityId', '=', lrs.activity.id)
      .where('kind', '=', key.kind)
      .where('ownerId', '=', key.ownerId)
      .where('activityIri', '=', key.activityIri)
      .where('registration', '=', key.registration);

  function checkPreconditions(c: Context, existing: XapiDocumentRow | undefined, requireForProfiles: boolean) {
    const ifMatch = c.req.header('if-match');
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifMatch !== undefined) {
      const tags = ifMatch.split(',').map((t) => t.trim());
      if (!existing || !(tags.includes('*') || tags.includes(`"${existing.etag}"`) || tags.includes(existing.etag))) {
        throw new XapiError(412, 'The document changed (If-Match failed).');
      }
    }
    if (ifNoneMatch !== undefined && existing && (ifNoneMatch.trim() === '*' || ifNoneMatch.includes(existing.etag))) {
      throw new XapiError(412, 'The document already exists (If-None-Match failed).');
    }
    if (requireForProfiles && existing && ifMatch === undefined && ifNoneMatch === undefined) {
      throw new XapiError(409, 'Send If-Match or If-None-Match to change an existing document.');
    }
  }

  function documentRoutes(path: string, keyOf: (c: Context, lrs: Lrs) => DocKey, idParam: 'stateId' | 'profileId') {
    const isProfile = idParam === 'profileId';
    r.get(
      path,
      handle(async (c, lrs) => {
        const key = keyOf(c, lrs);
        const docId = c.req.query(idParam);
        if (lrs.cmi5) await noteCmi5DocumentRead(db, lrs.cmi5, key.kind, docId);
        if (docId === undefined) {
          let q = docQuery(lrs, key);
          const since = c.req.query('since');
          if (since) {
            if (Number.isNaN(Date.parse(since))) throw new XapiError(400, 'since must be a timestamp.');
            q = q.where('updatedAt', '>', new Date(since).toISOString());
          }
          const rows = await q.select('docId').orderBy('docId', 'asc').execute();
          return c.json(rows.map((d) => d.docId));
        }
        const doc = await docQuery(lrs, key).where('docId', '=', docId).executeTakeFirst();
        if (!doc) throw new XapiError(404, 'No document with that id.');
        c.header('Content-Type', doc.contentType);
        c.header('ETag', `"${doc.etag}"`);
        c.header('Last-Modified', new Date(doc.updatedAt).toUTCString());
        return c.body(Buffer.from(doc.content, 'base64'));
      }),
    );

    const write = (merge: boolean) =>
      handle(async (c, lrs) => {
        const key = keyOf(c, lrs);
        const docId = c.req.query(idParam);
        if (!docId) throw new XapiError(400, `The ${idParam} parameter is required.`);
        if (Buffer.byteLength(docId) > MAX_DOCUMENT_ID_BYTES)
          throw new XapiError(400, `The ${idParam} parameter must be at most ${MAX_DOCUMENT_ID_BYTES} bytes.`);
        if (lrs.cmi5) guardCmi5Document(key.kind, docId);
        const body = new Uint8Array(await c.req.arrayBuffer());
        const type = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase().slice(0, 120);
        const existing = await docQuery(lrs, key).where('docId', '=', docId).executeTakeFirst();
        checkPreconditions(c, existing, isProfile && !merge);
        let bytes = body;
        let contentType = type;
        if (merge) {
          let incoming: unknown;
          try {
            incoming = JSON.parse(Buffer.from(body).toString('utf8'));
          } catch {
            incoming = undefined;
          }
          if (existing) {
            if (!existing.contentType.startsWith('application/json') || !isObject(incoming)) {
              throw new XapiError(400, 'POST merges JSON objects; the stored or sent document is not one.');
            }
            const current = parseJson<unknown>(Buffer.from(existing.content, 'base64').toString('utf8'), null);
            if (!isObject(current)) throw new XapiError(400, 'The stored document is not a JSON object.');
            bytes = Buffer.from(JSON.stringify({ ...current, ...incoming }));
            contentType = 'application/json';
          } else if (type.startsWith('application/json') && !isObject(incoming)) {
            throw new XapiError(400, 'The document is not a JSON object.');
          }
        }
        if (!lrs.records) return c.body(null, 204);
        const content = Buffer.from(bytes).toString('base64');
        const total = await db
          .selectFrom('xapiDocuments')
          .select((eb) => [eb.fn.countAll().as('n'), eb.fn.sum(eb.fn('length', ['content'])).as('bytes')])
          .where('activityId', '=', lrs.activity.id)
          .where('ownerId', '=', key.ownerId)
          .executeTakeFirst();
        if (!existing && Number(total?.n ?? 0) >= MAX_DOCUMENTS)
          throw new XapiError(403, 'Too many documents are stored for this activity.');
        if (Number(total?.bytes ?? 0) - (existing?.content.length ?? 0) + content.length > MAX_DOCUMENT_BYTES) {
          throw new XapiError(413, 'The documents stored for this activity are too large.');
        }
        const row = {
          content,
          contentType,
          etag: sha1(bytes),
          updatedAt: now(),
        };
        if (existing) await db.updateTable('xapiDocuments').set(row).where('id', '=', existing.id).execute();
        else
          await db
            .insertInto('xapiDocuments')
            .values({ id: newId(), activityId: lrs.activity.id, ...key, docId, ...row })
            .execute();
        return c.body(null, 204);
      });
    r.put(path, write(false));
    r.post(path, write(true));

    r.delete(
      path,
      handle(async (c, lrs) => {
        const key = keyOf(c, lrs);
        const docId = c.req.query(idParam);
        if (docId === undefined && isProfile) throw new XapiError(400, `The ${idParam} parameter is required.`);
        if (lrs.cmi5) guardCmi5Document(key.kind, docId);
        if (docId !== undefined) {
          const existing = await docQuery(lrs, key).where('docId', '=', docId).executeTakeFirst();
          checkPreconditions(c, existing, false);
        }
        if (!lrs.records) return c.body(null, 204);
        let q = db
          .deleteFrom('xapiDocuments')
          .where('activityId', '=', lrs.activity.id)
          .where('kind', '=', key.kind)
          .where('ownerId', '=', key.ownerId)
          .where('activityIri', '=', key.activityIri)
          .where('registration', '=', key.registration);
        if (docId !== undefined) q = q.where('docId', '=', docId);
        else if (lrs.cmi5) q = q.where('docId', '!=', PROTECTED_STATE_ID); // LMS.LaunchData stays
        await q.execute();
        return c.body(null, 204);
      }),
    );
  }

  documentRoutes('/xapi/activities/state', stateKey, 'stateId');
  documentRoutes('/xapi/activities/profile', activityProfileKey, 'profileId');
  documentRoutes('/xapi/agents/profile', agentProfileKey, 'profileId');

  r.get(
    '/xapi/activities',
    handle(async (c) => {
      const id = c.req.query('activityId') ?? '';
      if (!RE_IRI.test(id)) throw new XapiError(400, 'The activityId parameter must be an IRI.');
      return c.json({ objectType: 'Activity', id });
    }),
  );

  r.get(
    '/xapi/agents',
    handle(async (c, lrs) => {
      parseAgentParam(c.req.query('agent'), lrs);
      const actor = xapiActor(lrs.user, lrs.homePage);
      return c.json({ objectType: 'Person', name: [actor.name], account: [actor.account] });
    }),
  );

  r.all('/xapi/*', (c) => c.json({ error: { message: 'Not found.' } }, 404));
  return r;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  return value;
}
