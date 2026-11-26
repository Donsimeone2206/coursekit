/**
 * LTI 1.3 Advantage, with Coursekit as the platform. Mounted at the root:
 *
 * Inside /api (session, CSRF and no-store come from the /api middleware):
 * - /api/admin/lti/tools: the tool registry (administrators only)
 * - /api/courses/:courseId/lti/tools: tools teachers can pick for an External tool activity
 * - /api/lti/activities/:activityId: what the activity page needs to launch
 *
 * Outside /api, because tools post to them from their own sites (no Origin check applies: signed JWTs,
 * single-use hints and bearer tokens are the protection) or because they are public documents:
 * - GET  /lti/jwks: the platform's public key set
 * - GET  /lti/launch/:activityId: starts a launch (third-party initiated login), signed-in users
 * - GET  /lti/deep-link/start: starts content selection (Deep Linking 2.0) for a teacher
 * - GET|POST /lti/auth: the OIDC authorization endpoint; answers with a signed id_token
 * - POST /lti/deep-link/return: the tool's LtiDeepLinkingResponse
 * - POST /lti/token: OAuth 2.0 client credentials with a client assertion, for the services
 * - /lti/ags/:courseId/lineitems...: Assignment and Grade Services 2.0
 * - GET  /lti/nrps/:courseId/memberships: Names and Role Provisioning Services 2.0
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { decodeJwt, errors as joseErrors, type JWTPayload } from 'jose';
import { z } from 'zod';
import { DEFAULT_COMPLETION } from '../../shared/constants.js';
import type { LtiLaunchInfo, LtiToolDetail, LtiToolList, LtiToolOption } from '../../shared/lti.js';
import type { Grade, LtiSettings } from '../../shared/types.js';
import { sessionMiddleware } from '../auth/session.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { ActivityRow, CourseRow, UserRow } from '../db/schema.js';
import type { LtiToolRow } from '../db/schema-lti.js';
import { clientAddress, rateLimitKey } from '../lib/client-address.js';
import { ApiError, badRequest, forbidden, notFound, parse, readBody, readQuery } from '../lib/http.js';
import { newId, now, num, randomToken, sha256 } from '../lib/util.js';
import { assertCan, assertWritable, loadActivityAccess, loadCourseAccess } from '../services/access.js';
import { activityTypes, parseSettings } from '../services/activity-types.js';
import { escapeHtml, sendAutoPost, sendError, sendPage } from '../services/lti/html.js';
import { platformKey } from '../services/lti/keys.js';
import {
  allowedScopes,
  deepLinkingClaims,
  DL_CLAIM,
  LTI_CLAIM,
  resourceLinkClaims,
  SCOPES,
  signIdToken,
} from '../services/lti/messages.js';
import {
  checkResourceLink,
  findLineItem,
  lineItemJson,
  listLineItems,
  listMembers,
  listResults,
  MEDIA,
  recordScore,
} from '../services/lti/services.js';
import { isOnToolDomain, LTI_CUSTOM_KEY, LTI_NOT_CONFIGURED, ltiIssuer, platformDetails } from '../services/lti/settings.js';
import { signDeepLinkData, signLaunchHint, useOnce, verifyDeepLinkData, verifyLaunchHint } from '../services/lti/tokens.js';
import {
  activityToolId,
  checkToolKeys,
  CLOCK_SKEW,
  courseUsesTool,
  toLtiTool,
  toolActivityCounts,
  toolInputSchema,
  toolRedirectUris,
  verifyToolJwt,
} from '../services/lti/tools.js';
import { markCompleted } from '../services/progress.js';

const TOKEN_SECONDS = 3600;
const SMALL_BODY = 64 * 1024;
const DEEP_LINK_BODY = 1024 * 1024;
const MAX_CONTENT_ITEMS = 50;

function errorJson(message: string, code: string) {
  return { error: { message, code } };
}

/** Fixed-window counter per key, kept in memory for this instance. */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const t = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/** True when the Accept header allows `mediaType` (or plain JSON, or anything). */
function accepts(c: Context, mediaType: string): boolean {
  const accept = c.req.header('accept');
  if (!accept) return true;
  return accept.split(',').some((part) => {
    const type = part.split(';')[0]!.trim().toLowerCase();
    return type === mediaType || type === 'application/json' || type === '*/*' || type === 'application/*';
  });
}

function hasContentType(c: Context, mediaType: string): boolean {
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return type === mediaType || type === 'application/json';
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('The request body must be valid JSON.');
  }
}

/** String fields of a form post (or of the query string for GET). */
async function formParams(c: Context): Promise<Record<string, string>> {
  const source: Record<string, unknown> = c.req.method === 'POST' ? await c.req.parseBody().catch(() => ({})) : c.req.query();
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

class ServiceError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 406 | 415,
    message: string,
    readonly code: string,
    readonly authenticate?: string,
  ) {
    super(message);
  }
}

const pagingSchema = {
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
};

const lineItemSchema = z.object({
  label: z.string().trim().min(1, 'label is required').max(200),
  scoreMaximum: z.number().positive().max(1_000_000),
  resourceId: z.string().max(256).nullish(),
  tag: z.string().max(256).nullish(),
  resourceLinkId: z.string().max(64).nullish(),
  startDateTime: z.iso.datetime({ offset: true }).nullish(),
  endDateTime: z.iso.datetime({ offset: true }).nullish(),
});

const scoreSchema = z
  .object({
    userId: z.string().min(1).max(64),
    scoreGiven: z.number().min(0).max(1_000_000_000).nullish(),
    scoreMaximum: z.number().positive().max(1_000_000_000).nullish(),
    comment: z.string().max(20_000).nullish(),
    activityProgress: z.enum(['Initialized', 'Started', 'InProgress', 'Submitted', 'Completed']),
    gradingProgress: z.enum(['FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady']),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .refine((s) => s.scoreGiven == null || s.scoreMaximum != null, {
    message: 'scoreMaximum is required with scoreGiven',
    path: ['scoreMaximum'],
  });

const contentItemSchema = z.looseObject({
  type: z.string().max(100),
  title: z.string().max(2000).nullish(),
  text: z.string().max(20_000).nullish(),
  url: z.string().max(2000).nullish(),
  custom: z.record(z.string(), z.unknown()).nullish(),
  lineItem: z
    .looseObject({
      scoreMaximum: z.number().positive().max(10_000),
      resourceId: z.string().max(256).nullish(),
      tag: z.string().max(256).nullish(),
    })
    .nullish(),
  iframe: z.looseObject({}).nullish(),
  window: z.looseObject({}).nullish(),
});

type ContentItem = z.output<typeof contentItemSchema>;

export function ltiRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, config } = deps;
  // Token requests: a verified tool is limited by its own bucket only; failed requests count per client
  // address (behind a reverse proxy, set trustProxy), so junk naming a tool can't lock it out.
  const limitByTool = rateLimiter(60, 60_000);
  const limitFailures = rateLimiter(60, 60_000);

  const findTool = (id: string | null | undefined) =>
    id ? db.selectFrom('ltiTools').selectAll().where('id', '=', id).executeTakeFirst() : Promise.resolve(undefined);
  const findToolByClient = (clientId: string) => db.selectFrom('ltiTools').selectAll().where('clientId', '=', clientId).executeTakeFirst();

  async function toolDetail(tool: LtiToolRow): Promise<LtiToolDetail> {
    const counts = await toolActivityCounts(db);
    return { platform: platformDetails(config), tool: toLtiTool(tool, counts.get(tool.id) ?? 0) };
  }

  // ---- administration ------------------------------------------------------------------------

  r.get('/api/admin/lti/tools', async (c) => {
    requireAdmin(c);
    const [rows, counts] = await Promise.all([
      db.selectFrom('ltiTools').selectAll().orderBy('name', 'asc').execute(),
      toolActivityCounts(db),
    ]);
    const body: LtiToolList = { platform: platformDetails(config), tools: rows.map((t) => toLtiTool(t, counts.get(t.id) ?? 0)) };
    return c.json(body);
  });

  r.post('/api/admin/lti/tools', async (c) => {
    const admin = requireAdmin(c);
    const input = await readBody(c, toolInputSchema);
    const keys = checkToolKeys(input);
    const ts = now();
    const row: LtiToolRow = {
      id: newId(),
      name: input.name,
      description: input.description,
      toolUrl: input.toolUrl,
      loginUrl: input.loginUrl,
      redirectUris: JSON.stringify(input.redirectUris),
      jwksUrl: keys.jwksUrl,
      publicKey: keys.publicKey,
      deepLinkingUrl: input.deepLinkingUrl,
      customParams: JSON.stringify(input.customParams),
      shareName: input.shareName ? 1 : 0,
      shareEmail: input.shareEmail ? 1 : 0,
      allowAgs: input.allowAgs ? 1 : 0,
      allowNrps: input.allowNrps ? 1 : 0,
      clientId: newId(20),
      deploymentId: newId(12),
      status: input.status,
      scopes: null, // every scope of the services allowed (Dynamic Registration narrows it to what the tool asked for)
      domains: null, // only the tool URL's host (Dynamic Registration adds the domains the tool declared)
      createdBy: admin.id,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.insertInto('ltiTools').values(row).execute();
    return c.json(await toolDetail(row), 201);
  });

  r.get('/api/admin/lti/tools/:toolId', async (c) => {
    requireAdmin(c);
    const tool = await findTool(c.req.param('toolId'));
    if (!tool) throw notFound('Tool');
    return c.json(await toolDetail(tool));
  });

  r.patch('/api/admin/lti/tools/:toolId', async (c) => {
    requireAdmin(c);
    const tool = await findTool(c.req.param('toolId'));
    if (!tool) throw notFound('Tool');
    const patch = await readBody(c, z.record(z.string(), z.unknown()));
    const current = toLtiTool(tool, 0);
    const input = parse(toolInputSchema, { ...current, ...patch });
    const keys = checkToolKeys(input);
    const update = {
      name: input.name,
      description: input.description,
      toolUrl: input.toolUrl,
      loginUrl: input.loginUrl,
      redirectUris: JSON.stringify(input.redirectUris),
      jwksUrl: keys.jwksUrl,
      publicKey: keys.publicKey,
      deepLinkingUrl: input.deepLinkingUrl,
      customParams: JSON.stringify(input.customParams),
      shareName: input.shareName ? 1 : 0,
      shareEmail: input.shareEmail ? 1 : 0,
      allowAgs: input.allowAgs ? 1 : 0,
      allowNrps: input.allowNrps ? 1 : 0,
      status: input.status,
      updatedAt: now(),
    };
    await db.updateTable('ltiTools').set(update).where('id', '=', tool.id).execute();
    // Services the tool may no longer use stop working straight away (tokens are checked against the tool too).
    return c.json(await toolDetail({ ...tool, ...update }));
  });

  // ---- teachers and the activity page ------------------------------------------------------------

  r.get('/api/courses/:courseId/lti/tools', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:manageContent');
    const [rows, used] = await Promise.all([
      db.selectFrom('ltiTools').selectAll().orderBy('name', 'asc').execute(),
      db.selectFrom('activities').select(['type', 'settings']).where('courseId', '=', access.course.id).where('type', '=', 'lti').execute(),
    ]);
    const usedIds = new Set(used.map(activityToolId));
    const options: LtiToolOption[] = rows
      .filter((t) => t.status === 'active' || usedIds.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        toolUrl: t.toolUrl,
        deepLinking: !!t.deepLinkingUrl,
        grades: allowedScopes(t).includes(SCOPES.score),
        status: t.status,
      }));
    return c.json(options);
  });

  r.get('/api/lti/activities/:activityId', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    const { activity } = access;
    if (activity.type !== 'lti') throw badRequest('This activity is not an external tool.');
    const settings = parseSettings('lti', activity.settings);
    const tool = await findTool(settings.toolId);
    const staff = access.can('course:manageContent');
    let problem: string | null = null;
    if (!ltiIssuer(config))
      problem = staff ? LTI_NOT_CONFIGURED : "External tools aren't set up on this site yet. Please let your teacher know.";
    else if (!tool) problem = staff ? 'Pick a tool for this activity: choose Edit.' : "This activity isn't ready yet.";
    else if (tool.status !== 'active') problem = 'An administrator has turned this tool off, so it cannot be opened right now.';
    let grade: Grade | null = null;
    if (activity.maxGrade != null) {
      const row = await db
        .selectFrom('grades')
        .selectAll()
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      if (row) grade = { score: row.score, maxGrade: activity.maxGrade, feedback: row.feedback, gradedBy: null, gradedAt: row.gradedAt };
    }
    const info: LtiLaunchInfo = {
      toolName: tool?.name ?? null,
      available: !problem,
      problem,
      presentation: settings.presentation,
      windowUrl: `/lti/launch/${activity.id}`,
      embedUrl: `/lti/launch/${activity.id}?target=iframe`,
      grade,
    };
    return c.json(info);
  });

  // ---- outside /api ------------------------------------------------------------------------------

  r.use('/lti/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  const smallBody = bodyLimit({ maxSize: SMALL_BODY, onError: (c) => c.json(errorJson('Request body is too large.', 'too_large'), 413) });
  const deepLinkBody = bodyLimit({
    maxSize: DEEP_LINK_BODY,
    onError: (c) => c.json(errorJson('Request body is too large.', 'too_large'), 413),
  });
  r.use('/lti/*', (c, next) => (c.req.path === '/lti/deep-link/return' ? deepLinkBody(c, next) : smallBody(c, next)));
  r.use('/lti/launch/*', sessionMiddleware(deps));
  r.use('/lti/deep-link/*', sessionMiddleware(deps));
  r.use('/lti/auth', sessionMiddleware(deps));

  r.get('/lti/jwks', async (c) => {
    const key = await platformKey(db);
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json({ keys: [key.publicJwk] });
  });

  /** Browser pages show ApiErrors (access checks) as an error page. */
  function errorPage(c: Context, err: unknown): Response {
    if (err instanceof ApiError) {
      const status = ([400, 401, 403, 404] as const).find((s) => s === err.status) ?? 400;
      return sendError(c, err.message, status);
    }
    throw err;
  }

  const signInPage = (c: Context) =>
    sendPage(c, {
      title: 'Please sign in',
      status: 401,
      body: '<h1>Please sign in</h1><p>Sign in to Coursekit, then open the activity again.</p><a class="button" href="/login">Sign in</a>',
    });

  /** A launch link opened from another site needs one click on Coursekit's own page first. */
  function crossSiteGate(c: Context, toolName: string): Response | null {
    if (c.req.header('sec-fetch-site') !== 'cross-site') return null;
    const url = c.req.path + (c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : '');
    return sendPage(c, {
      title: `Open ${toolName}`,
      body: `<h1>Open ${escapeHtml(toolName)}?</h1><p>A link from another site wants to open this tool with your Coursekit account.</p><a class="button" href="${escapeHtml(url)}">Open ${escapeHtml(toolName)}</a>`,
    });
  }

  r.get('/lti/launch/:activityId', async (c) => {
    const user = c.get('user');
    if (!user) return signInPage(c);
    const iss = ltiIssuer(config);
    if (!iss) return sendError(c, LTI_NOT_CONFIGURED);
    try {
      const access = await loadActivityAccess(db, user, c.req.param('activityId'));
      const { activity, course } = access;
      if (activity.type !== 'lti') return sendError(c, 'This activity is not an external tool.');
      const settings = parseSettings('lti', activity.settings);
      const tool = await findTool(settings.toolId);
      if (!tool) return sendError(c, 'This activity has no tool yet.');
      if (tool.status !== 'active') return sendError(c, 'An administrator has turned this tool off.', 403);
      const gate = crossSiteGate(c, tool.name);
      if (gate) return gate;
      const target = c.req.query('target') === 'iframe' ? 'iframe' : 'window';
      const hint = await signLaunchHint(db, {
        userId: user.id,
        toolId: tool.id,
        clientId: tool.clientId,
        courseId: course.id,
        kind: 'launch',
        activityId: activity.id,
        sectionId: null,
        target,
      });
      return sendAutoPost(
        c,
        tool.loginUrl,
        {
          iss,
          login_hint: user.id,
          target_link_uri: settings.launchUrl ?? tool.toolUrl,
          lti_message_hint: hint,
          client_id: tool.clientId,
          lti_deployment_id: tool.deploymentId,
        },
        `Opening ${tool.name}…`,
      );
    } catch (err) {
      return errorPage(c, err);
    }
  });

  r.get('/lti/deep-link/start', async (c) => {
    const user = c.get('user');
    if (!user) return signInPage(c);
    const iss = ltiIssuer(config);
    if (!iss) return sendError(c, LTI_NOT_CONFIGURED);
    try {
      const q = readQuery(
        c,
        z.object({
          courseId: z.string().min(1).max(100),
          toolId: z.string().min(1).max(64),
          sectionId: z.string().max(64).optional(),
          activityId: z.string().max(64).optional(),
        }),
      );
      const access = await loadCourseAccess(db, user, q.courseId);
      assertCan(access, 'course:manageContent');
      assertWritable(access);
      const tool = await findTool(q.toolId);
      if (!tool || tool.status !== 'active') return sendError(c, 'That tool is not available.');
      if (!tool.deepLinkingUrl) return sendError(c, "This tool doesn't support selecting content. Enter its launch URL instead.");
      let sectionId = q.sectionId ?? null;
      let activityId: string | null = null;
      if (q.activityId) {
        const activity = await db
          .selectFrom('activities')
          .selectAll()
          .where('id', '=', q.activityId)
          .where('courseId', '=', access.course.id)
          .executeTakeFirst();
        if (!activity || activity.type !== 'lti') return sendError(c, 'That activity is not an external tool in this course.');
        activityId = activity.id;
        sectionId = activity.sectionId;
      } else {
        const section = sectionId
          ? await db
              .selectFrom('sections')
              .select('id')
              .where('id', '=', sectionId)
              .where('courseId', '=', access.course.id)
              .executeTakeFirst()
          : undefined;
        if (!section) return sendError(c, 'That section does not exist in this course.');
      }
      const gate = crossSiteGate(c, tool.name);
      if (gate) return gate;
      const hint = await signLaunchHint(db, {
        userId: user.id,
        toolId: tool.id,
        clientId: tool.clientId,
        courseId: access.course.id,
        kind: 'deeplink',
        activityId,
        sectionId,
        target: 'window',
      });
      return sendAutoPost(
        c,
        tool.loginUrl,
        {
          iss,
          login_hint: user.id,
          target_link_uri: tool.deepLinkingUrl,
          lti_message_hint: hint,
          client_id: tool.clientId,
          lti_deployment_id: tool.deploymentId,
        },
        `Opening ${tool.name}…`,
      );
    } catch (err) {
      return errorPage(c, err);
    }
  });

  /** OIDC authorization endpoint (the second step of the LTI launch). */
  r.on(['GET', 'POST'], '/lti/auth', async (c) => {
    const iss = ltiIssuer(config);
    if (!iss) return sendError(c, LTI_NOT_CONFIGURED);
    const p = await formParams(c);
    const tool = p.client_id ? await findToolByClient(p.client_id) : undefined;
    if (!tool) return sendError(c, 'The tool sent an unknown client_id.');
    if (tool.status !== 'active') return sendError(c, 'An administrator has turned this tool off.', 403);
    const redirectUri = p.redirect_uri ?? '';
    // Never send anything to a redirect URI that isn't registered for the tool.
    if (!toolRedirectUris(tool).includes(redirectUri)) return sendError(c, 'The redirect URI is not registered for this tool.');
    if (p.response_type !== 'id_token') return sendError(c, 'The tool must ask for response_type=id_token.');
    if (!(p.scope ?? '').split(/\s+/).includes('openid')) return sendError(c, 'The tool must ask for the openid scope.');
    if (p.response_mode !== 'form_post') return sendError(c, 'The tool must ask for response_mode=form_post.');
    if (p.prompt !== 'none') return sendError(c, 'The tool must ask for prompt=none.');
    if (!p.nonce || p.nonce.length > 1024) return sendError(c, 'The tool must send a nonce.');
    if ((p.state ?? '').length > 4096) return sendError(c, 'The state value is too long.');

    const expired = 'This launch has expired or is not valid. Go back to Coursekit and open the activity again.';
    const hint = await verifyLaunchHint(db, p.lti_message_hint ?? '');
    if (!hint || hint.toolId !== tool.id || hint.clientId !== tool.clientId) return sendError(c, expired);
    if (p.login_hint !== hint.userId) return sendError(c, expired);
    const signedIn = c.get('user');
    if (signedIn && signedIn.id !== hint.userId) {
      return sendError(c, "You're signed in to Coursekit as someone else. Open the activity again from your own account.", 403);
    }
    if (!(await useOnce(db, `hint:${hint.jti}`, hint.exp))) {
      return sendError(c, 'This launch was already used. Go back to Coursekit and open the activity again.');
    }
    const user = await db.selectFrom('users').selectAll().where('id', '=', hint.userId).executeTakeFirst();
    if (!user || user.status !== 'active') return sendError(c, expired, 403);

    try {
      let claims: Record<string, unknown>;
      if (hint.kind === 'launch') {
        const access = await loadActivityAccess(db, user, hint.activityId ?? '');
        const { activity, course } = access;
        const settings = parseSettings('lti', activity.settings);
        if (activity.type !== 'lti' || settings.toolId !== tool.id || course.id !== hint.courseId) return sendError(c, expired);
        claims = await resourceLinkClaims(
          { db, issuer: iss, version: deps.version, tool, user, course, courseRole: access.role, nonce: p.nonce },
          activity,
          settings,
          hint.target,
        );
        // Ungraded tools can't report completion, so opening them completes them.
        if (access.enrolment && activity.maxGrade == null && activity.completion === 'auto') await markCompleted(deps, activity, user.id);
      } else {
        const access = await loadCourseAccess(db, user, hint.courseId);
        assertCan(access, 'course:manageContent');
        assertWritable(access);
        if (!tool.deepLinkingUrl) return sendError(c, "This tool doesn't support selecting content.");
        const data = await signDeepLinkData(db, {
          userId: user.id,
          toolId: tool.id,
          courseId: access.course.id,
          sectionId: hint.sectionId,
          activityId: hint.activityId,
        });
        claims = await deepLinkingClaims(
          { db, issuer: iss, version: deps.version, tool, user, course: access.course, courseRole: access.role, nonce: p.nonce },
          data,
          !!hint.activityId,
        );
      }
      const idToken = await signIdToken(db, claims);
      return sendAutoPost(c, redirectUri, { id_token: idToken, state: p.state }, `Opening ${tool.name}…`);
    } catch (err) {
      return errorPage(c, err);
    }
  });

  // ---- Deep Linking response -------------------------------------------------------------------

  async function applyContentItems(
    user: UserRow,
    course: CourseRow,
    tool: LtiToolRow,
    sectionId: string,
    editing: ActivityRow | null,
    items: ContentItem[],
  ): Promise<{ titles: string[]; ids: string[]; skipped: number; updated: boolean }> {
    const links = items.filter((i) => i.type === 'ltiResourceLink');
    const titles: string[] = [];
    const ids: string[] = [];
    let skipped = items.length - links.length;
    let updated = false;
    // A line item (a grade column) only for a tool that may send scores to it, as deep_linking_settings says.
    const canScore = allowedScopes(tool).includes(SCOPES.score);
    for (const item of links) {
      if (item.url && !isOnToolDomain(item.url, tool)) {
        skipped++;
        continue;
      }
      const lineItem = canScore ? item.lineItem : null;
      const custom = Object.fromEntries(
        Object.entries(item.custom ?? {})
          .filter(([k, v]) => LTI_CUSTOM_KEY.test(k) && ['string', 'number', 'boolean'].includes(typeof v))
          .slice(0, 50)
          .map(([k, v]) => [k, String(v).slice(0, 1000)]),
      );
      const target = editing && !updated ? editing : null;
      const previous = target ? parseSettings('lti', target.settings) : null;
      const parsed = activityTypes.lti.settings.safeParse({
        toolId: tool.id,
        launchUrl: item.url || null,
        custom,
        presentation: item.iframe ? 'embed' : item.window ? 'window' : (previous?.presentation ?? 'window'),
        lineItemResourceId: lineItem?.resourceId ?? null,
        lineItemTag: lineItem?.tag ?? null,
      } satisfies LtiSettings);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const title = (item.title?.trim() || tool.name).slice(0, 200);
      const ts = now();
      if (target) {
        const graded = await db.selectFrom('grades').select('userId').where('activityId', '=', target.id).limit(1).executeTakeFirst();
        await db
          .updateTable('activities')
          .set({
            title: item.title?.trim() ? title : target.title,
            ...(item.text != null ? { description: item.text } : {}),
            settings: JSON.stringify(parsed.data),
            ...(lineItem && !graded ? { maxGrade: lineItem.scoreMaximum } : {}),
            updatedAt: ts,
          })
          .where('id', '=', target.id)
          .execute();
        updated = true;
        titles.push(title);
        ids.push(target.id);
        continue;
      }
      const max = await db
        .selectFrom('activities')
        .select((eb) => eb.fn.max('position').as('m'))
        .where('sectionId', '=', sectionId)
        .executeTakeFirst();
      const activity: ActivityRow = {
        id: newId(),
        courseId: course.id,
        sectionId,
        type: 'lti',
        title,
        description: item.text ?? '',
        position: max?.m == null ? 0 : num(max.m) + 1,
        visible: 1,
        settings: JSON.stringify(parsed.data),
        dueAt: null,
        maxGrade: lineItem ? lineItem.scoreMaximum : null,
        completion: DEFAULT_COMPLETION.lti,
        groupMode: null, // follow the course's group mode
        createdBy: user.id,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.insertInto('activities').values(activity).execute();
      deps.events.emit('activity.created', { activityId: activity.id, courseId: course.id, type: 'lti' });
      titles.push(title);
      ids.push(activity.id);
    }
    return { titles, ids, skipped, updated };
  }

  r.post('/lti/deep-link/return', async (c) => {
    const iss = ltiIssuer(config);
    if (!iss) return sendError(c, LTI_NOT_CONFIGURED);
    const title = "We couldn't add this content";
    const fail = (message: string, status: 400 | 403 = 400) => sendError(c, message, status, title);
    const form = await formParams(c);
    const jwt = form.JWT ?? form.jwt ?? '';
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(jwt);
    } catch {
      return fail('The tool sent a response Coursekit could not read.');
    }
    const tool = typeof unverified.iss === 'string' ? await findToolByClient(unverified.iss) : undefined;
    if (!tool || tool.status !== 'active') return fail('The response came from a tool that is not registered or is turned off.');
    let payload: JWTPayload;
    try {
      payload = await verifyToolJwt(db, tool, jwt, {
        issuer: tool.clientId,
        audience: iss,
        requiredClaims: ['exp', 'iat', 'nonce'],
        maxTokenAge: '1h',
      });
    } catch {
      return fail("The tool's response could not be verified. Ask the tool's administrator to check its keys.");
    }
    if (payload[`${LTI_CLAIM}message_type`] !== 'LtiDeepLinkingResponse') return fail('The tool sent the wrong kind of message.');
    if (payload[`${LTI_CLAIM}version`] !== '1.3.0') return fail('The tool sent an unsupported LTI version.');
    if (payload[`${LTI_CLAIM}deployment_id`] !== tool.deploymentId) return fail('The tool sent the wrong deployment ID.');
    const nonce = payload.nonce;
    if (typeof nonce !== 'string' || !nonce || nonce.length > 1024) return fail('The tool must send a nonce.');
    if (!(await useOnce(db, `dl-nonce:${tool.id}:${nonce}`, payload.exp!))) return fail('This response was already used.');
    const dataToken = payload[`${DL_CLAIM}data`];
    const data = typeof dataToken === 'string' ? await verifyDeepLinkData(db, dataToken) : null;
    const again = 'Go back to Coursekit and select the content again.';
    if (!data || data.toolId !== tool.id)
      return fail(`The response doesn't match a content selection Coursekit started, or it expired. ${again}`);
    if (!(await useOnce(db, `dl-data:${data.jti}`, data.exp))) return fail(`This content selection was already used. ${again}`);
    const signedIn = c.get('user');
    if (signedIn && signedIn.id !== data.userId) return fail("You're signed in to Coursekit as someone else.", 403);
    const user = await db.selectFrom('users').selectAll().where('id', '=', data.userId).executeTakeFirst();
    if (!user || user.status !== 'active') return fail('Your account is not active.', 403);

    const rawItems = payload[`${DL_CLAIM}content_items`];
    const items = z
      .array(contentItemSchema)
      .max(MAX_CONTENT_ITEMS)
      .safeParse(rawItems ?? []);
    if (!items.success) return fail('The tool sent content Coursekit could not read.');
    const msg = typeof payload[`${DL_CLAIM}msg`] === 'string' ? (payload[`${DL_CLAIM}msg`] as string).slice(0, 2000) : null;
    const errormsg = typeof payload[`${DL_CLAIM}errormsg`] === 'string' ? (payload[`${DL_CLAIM}errormsg`] as string).slice(0, 2000) : null;

    let result: Awaited<ReturnType<typeof applyContentItems>>;
    let course: CourseRow;
    try {
      const access = await loadCourseAccess(db, user, data.courseId);
      assertCan(access, 'course:manageContent');
      assertWritable(access);
      course = access.course;
      const editing = data.activityId
        ? ((await db
            .selectFrom('activities')
            .selectAll()
            .where('id', '=', data.activityId)
            .where('courseId', '=', course.id)
            .where('type', '=', 'lti')
            .executeTakeFirst()) ?? null)
        : null;
      const sectionId = editing?.sectionId ?? data.sectionId;
      const section = sectionId
        ? await db.selectFrom('sections').select('id').where('id', '=', sectionId).where('courseId', '=', course.id).executeTakeFirst()
        : undefined;
      if (!section) return fail('The course section no longer exists.');
      result = await applyContentItems(user, course, tool, section.id, editing, items.data);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status === 403 ? 403 : 400);
      throw err;
    }

    const heading = result.ids.length === 0 ? 'Nothing was added' : result.updated ? 'Activity updated' : 'Content added';
    const list = result.titles.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    const message = JSON.stringify({
      type: 'coursekit-lti-deep-link',
      courseId: course.id,
      activityIds: result.ids,
      msg,
      errormsg,
    }).replace(/</g, '\\u003c');
    return sendPage(c, {
      title: heading,
      body: `<h1>${escapeHtml(heading)}</h1>
${msg ? `<p>${escapeHtml(msg)}</p>` : ''}
${errormsg ? `<p class="error">${escapeHtml(errormsg)}</p>` : ''}
${list ? `<ul>${list}</ul>` : ''}
${result.skipped ? `<p>${result.skipped} item${result.skipped === 1 ? ' was' : 's were'} skipped: Coursekit can only add tool links on the tool's own domain.</p>` : ''}
<p>You can close this window and go back to ${escapeHtml(course.title)}.</p>
<button type="button" id="close">Close window</button> <a class="button" href="/courses/${encodeURIComponent(course.slug)}">Back to the course</a>`,
      script: `try{new BroadcastChannel('coursekit-lti').postMessage(${message})}catch(e){}
document.getElementById('close').addEventListener('click',function(){window.close()});`,
    });
  });

  // ---- OAuth 2.0 token endpoint ----------------------------------------------------------------

  r.post('/lti/token', async (c) => {
    const oauthError = (error: string, description: string, status: 400 | 401 | 429 = 400) =>
      c.json({ error, error_description: description }, status, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const iss = ltiIssuer(config);
    if (!iss) return oauthError('invalid_request', LTI_NOT_CONFIGURED);
    const form = await formParams(c);
    const tooMany = () => {
      c.header('Retry-After', '60');
      return oauthError('invalid_request', 'Too many token requests. Try again in a minute.', 429);
    };
    const address = rateLimitKey(clientAddress(c, config) ?? 'unknown');
    // Counted only once a request has failed, never before verification: the client_id is public.
    const failed = (error: string, description: string, status: 400 | 401 = 401) =>
      limitFailures(address) ? oauthError(error, description, status) : tooMany();
    if (form.grant_type !== 'client_credentials') return failed('unsupported_grant_type', 'Use grant_type=client_credentials.', 400);
    if (form.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
      return failed('invalid_request', 'Use client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer.', 400);
    }
    const assertion = form.client_assertion ?? '';
    let clientId = '';
    try {
      const claims = decodeJwt(assertion);
      clientId = typeof claims.iss === 'string' ? claims.iss.slice(0, 100) : '';
    } catch {
      // reported below
    }
    if (!clientId || assertion.length > 8192) return failed('invalid_client', 'The client assertion is missing or malformed.');
    const tool = await findToolByClient(clientId);
    if (!tool || tool.status !== 'active') return failed('invalid_client', 'Unknown or disabled client.');
    let payload: JWTPayload;
    try {
      payload = await verifyToolJwt(db, tool, assertion, {
        issuer: tool.clientId,
        subject: tool.clientId,
        audience: `${iss}/lti/token`,
        requiredClaims: ['exp', 'iat', 'jti'],
        maxTokenAge: '1h',
      });
    } catch (err) {
      const reason = err instanceof joseErrors.JOSEError ? err.code : 'invalid';
      return failed('invalid_client', `The client assertion could not be verified (${reason}).`);
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : '';
    if (!jti || jti.length > 256) return failed('invalid_client', 'The client assertion needs a jti.');
    // Remember the jti for as long as the assertion could be accepted.
    const acceptedUntil = Math.min(payload.exp!, payload.iat! + 3600) + CLOCK_SKEW;
    if (!(await useOnce(db, `jti:${tool.id}:${jti}`, acceptedUntil))) {
      return failed('invalid_client', 'This client assertion was already used.');
    }
    if (!limitByTool(tool.id)) return tooMany();
    const allowed = allowedScopes(tool);
    const requested = (form.scope ?? '').split(/\s+/).filter(Boolean);
    const granted = [...new Set(requested.filter((s) => allowed.includes(s)))];
    if (granted.length === 0) return oauthError('invalid_scope', 'None of the requested scopes are allowed for this tool.');
    const token = randomToken(32);
    const ts = Date.now();
    await db
      .insertInto('ltiAccessTokens')
      .values({
        id: sha256(token),
        toolId: tool.id,
        scopes: JSON.stringify(granted),
        expiresAt: new Date(ts + TOKEN_SECONDS * 1000).toISOString(),
        createdAt: new Date(ts).toISOString(),
      })
      .execute();
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_SECONDS, scope: granted.join(' ') }, 200, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  });

  // ---- services --------------------------------------------------------------------------------

  interface ServiceContext {
    iss: string;
    tool: LtiToolRow;
    course: CourseRow;
  }

  async function serviceAccess(c: Context, need: string[]): Promise<ServiceContext> {
    const iss = ltiIssuer(config);
    if (!iss) throw new ServiceError(404, LTI_NOT_CONFIGURED, 'not_configured');
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(c.req.header('authorization') ?? '');
    const invalid = () =>
      new ServiceError(401, 'The access token is missing, invalid or expired.', 'invalid_token', 'Bearer error="invalid_token"');
    if (!m) throw invalid();
    const row = await db.selectFrom('ltiAccessTokens').selectAll().where('id', '=', sha256(m[1]!)).executeTakeFirst();
    if (!row || row.expiresAt <= now()) throw invalid();
    const tool = await findTool(row.toolId);
    if (!tool || tool.status !== 'active') throw invalid();
    // Scopes the token was granted that the tool is still allowed to use.
    const allowed = allowedScopes(tool);
    const scopes = (JSON.parse(row.scopes) as string[]).filter((s) => allowed.includes(s));
    if (!need.some((s) => scopes.includes(s))) {
      throw new ServiceError(403, 'The access token does not allow this.', 'insufficient_scope', 'Bearer error="insufficient_scope"');
    }
    const course = await db
      .selectFrom('courses')
      .selectAll()
      .where('id', '=', c.req.param('courseId') ?? '')
      .executeTakeFirst();
    // The privacy boundary: only courses with an activity that uses this tool.
    if (!course || !(await courseUsesTool(db, course.id, tool.id))) {
      throw new ServiceError(404, 'Course not found, or it has no activity that uses this tool.', 'not_found');
    }
    return { iss, tool, course };
  }

  function service(need: string[], handler: (c: Context<AppEnv>, ctx: ServiceContext) => Promise<Response>) {
    return async (c: Context<AppEnv>) => {
      try {
        return await handler(c, await serviceAccess(c, need));
      } catch (err) {
        if (err instanceof ServiceError) {
          return c.json(errorJson(err.message, err.code), err.status, err.authenticate ? { 'WWW-Authenticate': err.authenticate } : {});
        }
        throw err;
      }
    };
  }

  const negotiate = (c: Context, mediaType: string) => {
    if (!accepts(c, mediaType)) throw new ServiceError(406, `This resource is available as ${mediaType}.`, 'not_acceptable');
  };
  const requireBody = (c: Context, mediaType: string) => {
    if (!hasContentType(c, mediaType)) throw new ServiceError(415, `Send the body as ${mediaType}.`, 'unsupported_media_type');
  };
  const writable = (course: CourseRow) => {
    if (course.visibility === 'archived') throw forbidden('This course is archived and read-only.');
  };
  const sendJson = (c: Context, body: unknown, mediaType: string, status: 200 | 201 = 200) =>
    c.body(JSON.stringify(body), status, { 'Content-Type': mediaType });

  /** Adds a Link: rel="next" header when there is another page. */
  function linkNext(c: Context, iss: string, page: number, hasMore: boolean) {
    if (!hasMore) return;
    const params = new URLSearchParams(c.req.query());
    params.set('page', String(page + 1));
    c.header('Link', `<${iss}${c.req.path}?${params.toString()}>; rel="next"`);
  }

  const READ_LINE_ITEMS = [SCOPES.lineItem, SCOPES.lineItemReadOnly];

  r.get(
    '/lti/ags/:courseId/lineitems',
    service(READ_LINE_ITEMS, async (c, { iss, tool, course }) => {
      negotiate(c, MEDIA.lineItemContainer);
      const q = readQuery(
        c,
        z.object({
          resource_link_id: z.string().max(64).optional(),
          resource_id: z.string().max(256).optional(),
          tag: z.string().max(256).optional(),
          ...pagingSchema,
        }),
      );
      const items = (await listLineItems(db, tool.id, course.id)).filter(
        (i) =>
          (q.resource_link_id === undefined || i.resourceLinkId === q.resource_link_id) &&
          (q.resource_id === undefined || i.resourceId === q.resource_id) &&
          (q.tag === undefined || i.tag === q.tag),
      );
      const limit = q.limit ?? items.length;
      const pageItems = q.limit ? items.slice((q.page - 1) * limit, q.page * limit) : items;
      linkNext(c, iss, q.page, !!q.limit && q.page * limit < items.length);
      return sendJson(
        c,
        pageItems.map((i) => lineItemJson(iss, course.id, i)),
        MEDIA.lineItemContainer,
      );
    }),
  );

  r.post(
    '/lti/ags/:courseId/lineitems',
    service([SCOPES.lineItem], async (c, { iss, tool, course }) => {
      requireBody(c, MEDIA.lineItem);
      writable(course);
      const input = parse(lineItemSchema, await jsonBody(c));
      const ts = now();
      const row = {
        id: newId(),
        toolId: tool.id,
        courseId: course.id,
        resourceLinkId: await checkResourceLink(db, tool.id, course.id, input.resourceLinkId),
        label: input.label,
        scoreMaximum: input.scoreMaximum,
        resourceId: input.resourceId ?? null,
        tag: input.tag ?? null,
        startDateTime: input.startDateTime ?? null,
        endDateTime: input.endDateTime ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.insertInto('ltiLineItems').values(row).execute();
      const item = await findLineItem(db, tool.id, course.id, row.id);
      return sendJson(c, lineItemJson(iss, course.id, item!), MEDIA.lineItem, 201);
    }),
  );

  r.get(
    '/lti/ags/:courseId/lineitems/:lineItemId',
    service(READ_LINE_ITEMS, async (c, { iss, tool, course }) => {
      negotiate(c, MEDIA.lineItem);
      const item = await findLineItem(db, tool.id, course.id, c.req.param('lineItemId') ?? '');
      if (!item) throw notFound('Line item');
      return sendJson(c, lineItemJson(iss, course.id, item), MEDIA.lineItem);
    }),
  );

  r.put(
    '/lti/ags/:courseId/lineitems/:lineItemId',
    service([SCOPES.lineItem], async (c, { iss, tool, course }) => {
      requireBody(c, MEDIA.lineItem);
      writable(course);
      const item = await findLineItem(db, tool.id, course.id, c.req.param('lineItemId') ?? '');
      if (!item) throw notFound('Line item');
      const body = await jsonBody(c);
      if (item.managed && item.activity) {
        // The gradebook owns the label and maximum of an activity's line item; the tool may set resourceId and tag.
        const input = parse(z.looseObject({ resourceId: z.string().max(256).nullish(), tag: z.string().max(256).nullish() }), body);
        const settings = parseSettings('lti', item.activity.settings);
        const next = { ...settings, lineItemResourceId: input.resourceId ?? null, lineItemTag: input.tag ?? null };
        await db
          .updateTable('activities')
          .set({ settings: JSON.stringify(next), updatedAt: now() })
          .where('id', '=', item.activity.id)
          .execute();
      } else {
        const input = parse(lineItemSchema, body);
        await db
          .updateTable('ltiLineItems')
          .set({
            label: input.label,
            scoreMaximum: input.scoreMaximum,
            resourceId: input.resourceId ?? null,
            tag: input.tag ?? null,
            resourceLinkId: await checkResourceLink(db, tool.id, course.id, input.resourceLinkId),
            startDateTime: input.startDateTime ?? null,
            endDateTime: input.endDateTime ?? null,
            updatedAt: now(),
          })
          .where('id', '=', item.id)
          .execute();
      }
      const fresh = await findLineItem(db, tool.id, course.id, item.id);
      return sendJson(c, lineItemJson(iss, course.id, fresh!), MEDIA.lineItem);
    }),
  );

  r.delete(
    '/lti/ags/:courseId/lineitems/:lineItemId',
    service([SCOPES.lineItem], async (c, { tool, course }) => {
      writable(course);
      const item = await findLineItem(db, tool.id, course.id, c.req.param('lineItemId') ?? '');
      if (!item) throw notFound('Line item');
      if (item.managed)
        throw forbidden(
          'This line item belongs to an activity in the Coursekit gradebook. A teacher can delete the activity in Coursekit.',
        );
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('ltiScores').where('lineItemId', '=', item.id).execute();
        await trx.deleteFrom('ltiLineItems').where('id', '=', item.id).execute();
      });
      return c.body(null, 204);
    }),
  );

  r.post(
    '/lti/ags/:courseId/lineitems/:lineItemId/scores',
    service([SCOPES.score], async (c, { tool, course }) => {
      requireBody(c, MEDIA.score);
      writable(course);
      const item = await findLineItem(db, tool.id, course.id, c.req.param('lineItemId') ?? '');
      if (!item) throw notFound('Line item');
      const input = parse(scoreSchema, await jsonBody(c));
      await recordScore(deps, tool, course, item, input);
      return c.body(null, 204);
    }),
  );

  r.get(
    '/lti/ags/:courseId/lineitems/:lineItemId/results',
    service([SCOPES.resultReadOnly], async (c, { iss, tool, course }) => {
      negotiate(c, MEDIA.resultContainer);
      const item = await findLineItem(db, tool.id, course.id, c.req.param('lineItemId') ?? '');
      if (!item) throw notFound('Line item');
      const q = readQuery(c, z.object({ user_id: z.string().max(64).optional(), ...pagingSchema }));
      const results = await listResults(db, iss, course.id, item, q.user_id);
      const limit = q.limit ?? results.length;
      const pageResults = q.limit ? results.slice((q.page - 1) * limit, q.page * limit) : results;
      linkNext(c, iss, q.page, !!q.limit && q.page * limit < results.length);
      return sendJson(c, pageResults, MEDIA.resultContainer);
    }),
  );

  r.get(
    '/lti/nrps/:courseId/memberships',
    service([SCOPES.memberships], async (c, { iss, tool, course }) => {
      negotiate(c, MEDIA.membershipContainer);
      const q = readQuery(c, z.object({ role: z.string().max(300).optional(), ...pagingSchema }));
      const limit = q.limit ?? 1000;
      const { members, hasMore } = await listMembers(db, tool, course, { role: q.role, limit, page: q.page });
      linkNext(c, iss, q.page, hasMore);
      return sendJson(
        c,
        {
          id: `${iss}/lti/nrps/${course.id}/memberships`,
          context: { id: course.id, label: course.slug, title: course.title },
          members,
        },
        MEDIA.membershipContainer,
      );
    }),
  );

  // Unknown /lti paths are a 404, not the web UI.
  r.all('/lti/*', (c) => c.json(errorJson('Not found.', 'not_found'), 404));

  return r;
}
