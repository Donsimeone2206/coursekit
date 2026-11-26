import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionInfo } from '../../shared/types.js';
import { endSession, startSession } from '../auth/session.js';
import { requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { limitAddress } from '../lib/client-address.js';
import { ApiError, badRequest, forbidden } from '../lib/http.js';
import { readBody } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createFailureLimiter, createRateLimiter } from '../lib/rate-limit.js';
import { emailSchema, imageUrlSchema, nameSchema, passwordSchema } from '../lib/schemas.js';
import { now, num } from '../lib/util.js';
import { seedDemo } from '../seed/demo.js';
import { toPublicUser, toUser } from '../services/serialize.js';
import { getSiteSettings, updateSiteSettings } from '../services/settings.js';
import { createUser, normalizeEmail } from '../services/users.js';

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
/** Per client address (see the trustProxy option), on top of the limits per email: failed sign-ins, and sign-ups. */
const ADDRESS_SIGN_IN_FAILURES = 100;
const ADDRESS_SIGN_UPS = 50;
const SIGN_UP_WINDOW_MS = 60 * 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

/** Small in-memory limiter for credential endpoints. */
function rateLimit(key: string) {
  const t = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.resetAt < t) attempts.delete(k);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < t) {
    attempts.set(key, { count: 1, resetAt: t + WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) {
    throw new ApiError(429, 'Too many attempts. Please wait a few minutes and try again.', 'rate_limited');
  }
}

export function authRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, config } = deps;
  // A whole school can sit behind one address, so these are generous. An address that doesn't tell clients
  // apart (unknown, or behind a proxy while trustProxy is off: see limitAddress) only gets the limits per email.
  const failedSignIns = createFailureLimiter(ADDRESS_SIGN_IN_FAILURES, WINDOW_MS);
  const signUps = createRateLimiter(ADDRESS_SIGN_UPS, SIGN_UP_WINDOW_MS);
  const tooManyFromAddress = (what: string) =>
    new ApiError(429, `Too many ${what} from your network. Please wait a few minutes and try again.`, 'rate_limited');

  async function userCount() {
    const row = await db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    return num(row?.n);
  }

  async function sessionInfo(c: AppContext): Promise<SessionInfo> {
    const user = c.get('user');
    const session = c.get('session');
    let impersonator = null;
    if (session?.impersonatorId) {
      const row = await db
        .selectFrom('users')
        .select(['id', 'name', 'avatarUrl'])
        .where('id', '=', session.impersonatorId)
        .executeTakeFirst();
      impersonator = row ? toPublicUser(row) : null;
    }
    return {
      user: user ? toUser(user) : null,
      impersonator,
      site: await getSiteSettings(db),
      needsSetup: user ? false : (await userCount()) === 0,
      version: deps.version,
    };
  }

  r.get('/session', async (c) => c.json(await sessionInfo(c)));

  /** First-run setup: creates the administrator account. Only works while there are no users. */
  r.post('/setup', async (c) => {
    if ((await userCount()) > 0) throw forbidden('This site has already been set up.');
    const input = await readBody(
      c,
      z.object({
        siteName: z.string().trim().min(1, 'Enter a site name').max(80),
        name: nameSchema,
        email: emailSchema,
        password: passwordSchema,
        demo: z.boolean().default(false),
      }),
    );
    const user = await createUser(deps, { name: input.name, email: input.email, password: input.password, role: 'admin' });
    await updateSiteSettings(db, { name: input.siteName });
    if (input.demo) await seedDemo(deps, { admin: user });
    await startSession(c, deps, user);
    return c.json(await sessionInfo(c), 201);
  });

  r.post('/login', async (c) => {
    const input = await readBody(
      c,
      z.object({ email: z.string().trim().min(1, 'Enter your email').max(254), password: z.string().min(1).max(200) }),
    );
    const email = normalizeEmail(input.email);
    rateLimit(`login:${email}`);
    // A place among the failed sign-ins allowed per address, taken before the password check (so requests sent at
    // the same time can't get past the limit) and kept only if the password is wrong.
    const address = limitAddress(c, config);
    const end = address ? await failedSignIns.begin(address) : () => {};
    if (!end) throw tooManyFromAddress('failed sign-ins');
    let user: UserRow | undefined;
    let valid: boolean | undefined;
    try {
      user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
      valid = await verifyPassword(input.password, user?.passwordHash);
    } finally {
      end(valid === false);
    }
    if (!user || !valid) throw new ApiError(401, 'That email and password combination is not correct.', 'invalid_credentials');
    if (user.status !== 'active') throw forbidden('This account is suspended. Contact your administrator.');

    attempts.delete(`login:${email}`);
    const lastLoginAt = now();
    await db.updateTable('users').set({ lastLoginAt }).where('id', '=', user.id).execute();
    await startSession(c, deps, { ...user, lastLoginAt });
    deps.events.emit('user.login', { userId: user.id });
    return c.json(await sessionInfo(c));
  });

  r.post('/register', async (c) => {
    const site = await getSiteSettings(db);
    if (!site.allowSignup) throw forbidden('Self-registration is turned off on this site.');
    const input = await readBody(c, z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }));
    const address = limitAddress(c, config);
    if (address && !signUps.hit(address)) throw tooManyFromAddress('sign-ups');
    rateLimit(`register:${normalizeEmail(input.email)}`);
    const user = await createUser(deps, { ...input, role: 'student' });
    await startSession(c, deps, user);
    return c.json(await sessionInfo(c), 201);
  });

  r.post('/logout', async (c) => {
    await endSession(c, deps);
    return c.json({ ok: true });
  });

  r.patch('/me', async (c) => {
    const user = requireUser(c);
    const input = await readBody(
      c,
      z.object({
        name: nameSchema.optional(),
        bio: z.string().trim().max(2000).nullable().optional(),
        avatarUrl: imageUrlSchema.nullable().optional(),
      }),
    );
    await db
      .updateTable('users')
      .set({ ...input, updatedAt: now() })
      .where('id', '=', user.id)
      .execute();
    const updated = await db.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirstOrThrow();
    c.set('user', updated);
    return c.json(await sessionInfo(c));
  });

  r.post('/me/password', async (c) => {
    const user = requireUser(c);
    const input = await readBody(c, z.object({ currentPassword: z.string().max(200).default(''), newPassword: passwordSchema }));
    rateLimit(`password:${user.id}`);
    if (user.passwordHash && !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw badRequest('Your current password is not correct.');
    }
    await db
      .updateTable('users')
      .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: now() })
      .where('id', '=', user.id)
      .execute();
    // Sign out everywhere else.
    const current = c.get('session');
    await db
      .deleteFrom('sessions')
      .where('userId', '=', user.id)
      .$if(!!current, (q) => q.where('id', '!=', current!.id))
      .execute();
    return c.json({ ok: true });
  });

  r.post('/stop-impersonating', async (c) => {
    const session = c.get('session');
    if (!session?.impersonatorId) throw badRequest('You are not logged in as another user.');
    const admin = await db.selectFrom('users').selectAll().where('id', '=', session.impersonatorId).executeTakeFirst();
    const canReturn = !!admin && admin.status === 'active';
    await endSession(c, deps, { replacing: canReturn });
    if (canReturn) await startSession(c, deps, admin);
    return c.json(await sessionInfo(c));
  });

  return r;
}
