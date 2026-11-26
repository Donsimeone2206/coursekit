/**
 * LTI Dynamic Registration (see services/lti/registration.ts). Mounted at the root, before ltiRoutes, whose
 * /lti/* catch-all would otherwise answer these paths first.
 *
 * Inside /api (session, CSRF and no-store come from the /api middleware), administrators only:
 * - POST   /api/admin/lti/registrations: starts a registration from the tool's registration URL
 * - GET    /api/admin/lti/registrations: the tools that registered themselves
 * - GET    /api/admin/lti/registrations/:id: how a registration is doing (the dialog polls it)
 * - DELETE /api/admin/lti/registrations/:id: cancels one the tool hasn't used
 * - GET    /api/admin/lti/tools/:toolId/registration: what the tool asked for, for review
 *
 * Outside /api, for tools (CORS and no cookies: the registration token is the only credential):
 * - GET  /lti/openid-configuration: the platform's OpenID configuration (public)
 * - POST /lti/registration: the registration endpoint
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { LtiRegisteredTool, LtiRegistrationStarted } from '../../shared/lti-registration.js';
import { requireAdmin, type AppDeps, type AppEnv } from '../context.js';
import { clientAddress, rateLimitKey } from '../lib/client-address.js';
import { badRequest, conflict, notFound, readBody } from '../lib/http.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import {
  checkRegistrationUrl,
  completeRegistration,
  openIdConfiguration,
  parseRegistrationRequest,
  REGISTRATION_BODY_BYTES,
  RegistrationError,
  registrationOpenUrl,
  registrationResponse,
  registrationState,
  startRegistration,
  toToolRegistration,
  usableRegistration,
  type ParsedRegistration,
} from '../services/lti/registration.js';
import { LTI_NOT_CONFIGURED, ltiIssuer } from '../services/lti/settings.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** A CORS preflight answer: tools may call these endpoints from the browser, with the token as a bearer token. */
const preflight = (methods: string, headers: string) => ({
  ...CORS,
  'Access-Control-Allow-Methods': methods,
  'Access-Control-Allow-Headers': headers,
  'Access-Control-Max-Age': '600',
});

export function ltiRegistrationRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, config } = deps;
  // Failed registration requests per client address (see trustProxy). Tokens can't be guessed; this keeps junk cheap.
  const failures = createRateLimiter(30, 60_000);

  // ---- administration ------------------------------------------------------------------------

  r.post('/api/admin/lti/registrations', async (c) => {
    const admin = requireAdmin(c);
    const iss = ltiIssuer(config);
    if (!iss) throw badRequest(LTI_NOT_CONFIGURED);
    const input = await readBody(
      c,
      z.object({
        url: z.string().trim().min(1, 'Paste the registration URL').max(2000, 'That URL is too long (2,000 characters at most)'),
      }),
    );
    const url = checkRegistrationUrl(input.url, iss);
    const { row, token } = await startRegistration(db, admin, url);
    const body: LtiRegistrationStarted = { id: row.id, openUrl: registrationOpenUrl(url, iss, token), expiresAt: row.expiresAt };
    return c.json(body, 201);
  });

  r.get('/api/admin/lti/registrations', async (c) => {
    requireAdmin(c);
    const rows = await db
      .selectFrom('ltiRegistrations')
      .select(['toolId', 'completedAt', 'createdAt'])
      .where('status', '=', 'completed')
      .where('toolId', 'is not', null)
      .execute();
    const body: LtiRegisteredTool[] = rows.map((row) => ({ toolId: row.toolId!, registeredAt: row.completedAt ?? row.createdAt }));
    return c.json(body);
  });

  r.get('/api/admin/lti/registrations/:id', async (c) => {
    requireAdmin(c);
    const state = await registrationState(db, c.req.param('id'));
    if (!state) throw notFound('Registration');
    return c.json(state);
  });

  r.delete('/api/admin/lti/registrations/:id', async (c) => {
    requireAdmin(c);
    const id = c.req.param('id');
    // Only an unused registration can be cancelled; its token stops working straight away.
    const result = await db.deleteFrom('ltiRegistrations').where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (Number(result.numDeletedRows) > 0) return c.json({ ok: true });
    if (!(await registrationState(db, id))) throw notFound('Registration');
    throw conflict('This tool has already registered. You can find it in the list, turned off.');
  });

  r.get('/api/admin/lti/tools/:toolId/registration', async (c) => {
    requireAdmin(c);
    const row = await db
      .selectFrom('ltiRegistrations')
      .selectAll()
      .where('toolId', '=', c.req.param('toolId'))
      .where('status', '=', 'completed')
      .executeTakeFirst();
    if (!row) throw notFound('Registration');
    const startedBy = row.createdBy
      ? await db.selectFrom('users').select(['id', 'name']).where('id', '=', row.createdBy).executeTakeFirst()
      : undefined;
    return c.json(toToolRegistration(row, startedBy ?? null));
  });

  // ---- for tools ------------------------------------------------------------------------------

  // Public. Tools built for platforms that require it (Canvas) send the registration token here too: it is ignored,
  // but browsers ask first (the preflight below) because of that header.
  r.get('/lti/openid-configuration', (c) => {
    const iss = ltiIssuer(config);
    if (!iss) return c.json({ error: 'not_found', error_description: LTI_NOT_CONFIGURED }, 404, { ...CORS, ...NO_STORE });
    return c.json(openIdConfiguration(iss, deps.version), 200, { ...CORS, 'Cache-Control': 'public, max-age=300' });
  });
  r.options('/lti/openid-configuration', (c) => c.body(null, 204, preflight('GET', 'Authorization, Accept')));

  // Tools may register from the browser too: the bearer token, never a cookie, is what counts.
  r.options('/lti/registration', (c) => c.body(null, 204, preflight('POST', 'Authorization, Content-Type')));

  const registrationBody = bodyLimit({
    maxSize: REGISTRATION_BODY_BYTES,
    onError: (c) =>
      c.json({ error: 'invalid_client_metadata', error_description: 'The registration is too large (64 KB at most).' }, 413, {
        ...CORS,
        ...NO_STORE,
      }),
  });

  r.post('/lti/registration', registrationBody, async (c) => {
    const reply = (body: object, status: 201 | 400 | 401 | 404 | 415 | 429, headers: Record<string, string> = {}) =>
      c.json(body, status, { ...CORS, ...NO_STORE, ...headers });
    const iss = ltiIssuer(config);
    if (!iss) return reply({ error: 'not_found', error_description: LTI_NOT_CONFIGURED }, 404);
    const address = rateLimitKey(clientAddress(c, config) ?? 'unknown');
    // RFC 6750: a missing token gets a bare challenge, a bad one error="invalid_token".
    const refuse = (description: string, presented: boolean) =>
      failures.hit(address)
        ? reply({ error: 'invalid_token', error_description: description }, 401, {
            'WWW-Authenticate': presented ? 'Bearer error="invalid_token"' : 'Bearer',
          })
        : reply({ error: 'invalid_request', error_description: 'Too many failed registration requests. Try again in a minute.' }, 429, {
            'Retry-After': '60',
          });
    const auth = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!auth) return refuse('Send the registration token from the registration URL as a bearer token.', false);
    const notUsable = 'The registration token is not valid, has expired or was used already. Start the registration again in Coursekit.';
    const registration = await usableRegistration(db, auth[1]!.trim());
    if (!registration) return refuse(notUsable, true);

    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      return reply({ error: 'invalid_client_metadata', error_description: 'Send the registration as application/json.' }, 415);
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return reply({ error: 'invalid_client_metadata', error_description: 'The registration is not valid JSON.' }, 400);
    }
    let parsed: ParsedRegistration;
    try {
      parsed = parseRegistrationRequest(body, iss);
    } catch (err) {
      if (err instanceof RegistrationError) return reply({ error: err.code, error_description: err.message }, 400);
      throw err;
    }
    // Uses the token for good; when two requests race with one token, only one of them gets here with a tool.
    const tool = await completeRegistration(db, registration, parsed);
    if (!tool) return refuse(notUsable, true);
    return reply(registrationResponse(parsed, tool), 201);
  });

  return r;
}
