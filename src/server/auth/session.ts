import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext, AppDeps, AppEnv } from '../context.js';
import type { SessionRow, UserRow } from '../db/schema.js';
import { addDays, now, randomToken, sha256 } from '../lib/util.js';

export const SESSION_COOKIE = 'coursekit_session';
const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

function writeCookie(c: AppContext, deps: AppDeps, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: deps.config.secureCookies,
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

/**
 * Creates a session for the user, sets the session cookie and makes the user current
 * for the rest of the request. Only a hash of the token is stored.
 */
export async function startSession(c: AppContext, deps: AppDeps, user: UserRow, impersonatorId: string | null = null) {
  const token = randomToken();
  const session: SessionRow = {
    id: sha256(token),
    userId: user.id,
    impersonatorId,
    expiresAt: addDays(new Date(), SESSION_DAYS).toISOString(),
    createdAt: now(),
    userAgent: c.req.header('user-agent')?.slice(0, 255) ?? null,
  };
  await deps.db.insertInto('sessions').values(session).execute();
  writeCookie(c, deps, token);
  c.set('session', session);
  c.set('user', user);
}

/**
 * Ends the current session. Pass `{ replacing: true }` when a new session is started right
 * after (impersonation), so the response doesn't carry a redundant cookie deletion.
 */
export async function endSession(c: AppContext, deps: AppDeps, options: { replacing?: boolean } = {}) {
  const session = c.get('session');
  if (session) await deps.db.deleteFrom('sessions').where('id', '=', session.id).execute();
  if (!options.replacing) deleteCookie(c, SESSION_COOKIE, { path: '/' });
  c.set('session', null);
  c.set('user', null);
}

/** Resolves the signed-in user (if any) from the session cookie. Sessions slide forward when used. */
export function sessionMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    c.set('session', null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const id = sha256(token);
      const session = await deps.db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
      if (session && session.expiresAt > now()) {
        const user = await deps.db.selectFrom('users').selectAll().where('id', '=', session.userId).executeTakeFirst();
        if (user && user.status === 'active') {
          c.set('user', user);
          c.set('session', session);
          if (new Date(session.expiresAt).getTime() - Date.now() < (SESSION_DAYS / 2) * DAY_MS) {
            await deps.db
              .updateTable('sessions')
              .set({ expiresAt: addDays(new Date(), SESSION_DAYS).toISOString() })
              .where('id', '=', id)
              .execute();
            writeCookie(c, deps, token);
          }
        }
      } else if (session) {
        await deps.db.deleteFrom('sessions').where('id', '=', id).execute();
      }
    }
    await next();
  };
}
