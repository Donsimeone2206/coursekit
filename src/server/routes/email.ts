/**
 * Email routes, mounted at the root:
 * - /api/email/preferences: the signed-in person's delivery preferences
 * - /api/email/unsubscribe: the unsubscribe page's API (no sign-in; the signed token is the credential)
 * - POST /unsubscribe: RFC 8058 one-click unsubscribe, posted by mail providers to the List-Unsubscribe URL.
 *   It lives outside /api because those requests carry no Origin header, which /api's CSRF check requires.
 * - /api/admin/email: delivery status, settings and test emails for administrators
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  EMAIL_CATEGORIES,
  EMAIL_CATEGORY_IDS,
  EMAIL_FREQUENCIES,
  type EmailCategoryId,
  type EmailFrequency,
  type EmailMessageInfo,
  type EmailPreferences,
  type UnsubscribeInfo,
} from '../../shared/email.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { ApiError, conflict, notFound, readBody, readQuery } from '../lib/http.js';
import { emailSchema } from '../lib/schemas.js';
import { digestSchedule } from '../services/email/digests.js';
import { retryFailedEmails } from '../services/email/outbox.js';
import { getEmailSettings, isValidTimeZone, loadPreference, savePreference, updateEmailSettings } from '../services/email/preferences.js';
import { createEmailService, emailServiceFor } from '../services/email/service.js';
import { emailSecret, verifyUnsubscribeToken, type UnsubscribeTarget } from '../services/email/tokens.js';
import { getSiteSettings } from '../services/settings.js';

const frequencySchema = z.enum(EMAIL_FREQUENCIES as [EmailFrequency, ...EmailFrequency[]]);
const categorySchema = z.enum(EMAIL_CATEGORY_IDS as [EmailCategoryId, ...EmailCategoryId[]]);
const tokenSchema = z.string().trim().min(1, 'The unsubscribe link is incomplete.').max(200);

const invalidToken = () =>
  new ApiError(
    400,
    'This unsubscribe link is not valid. Use the link from a recent email, or change your email preferences in your profile.',
    'invalid_token',
  );

/** "a•••@example.com" */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

export function emailRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;
  // createCoursekit() registers the service first; this covers apps built with createApp() directly.
  const service = () => emailServiceFor(db) ?? createEmailService(deps);

  async function preferencesFor(user: UserRow): Promise<EmailPreferences> {
    const [settings, pref] = await Promise.all([getEmailSettings(db), loadPreference(db, user.id)]);
    const schedule = digestSchedule(new Date(), settings);
    return {
      frequency: pref?.frequency ?? settings.defaultFrequency,
      isDefault: !pref?.frequency,
      siteDefault: settings.defaultFrequency,
      disabledCategories: pref?.disabledCategories ?? [],
      deliveryEnabled: service().enabled,
      address: user.email,
      nextDigests: { daily: schedule.nextDaily.toISOString(), weekly: schedule.nextWeekly.toISOString() },
    };
  }

  r.get('/api/email/preferences', async (c) => {
    const user = requireUser(c);
    return c.json(await preferencesFor(user));
  });

  r.put('/api/email/preferences', async (c) => {
    const user = requireUser(c);
    const input = await readBody(
      c,
      z.object({
        frequency: frequencySchema.optional(),
        disabledCategories: z.array(categorySchema).max(EMAIL_CATEGORY_IDS.length).optional(),
      }),
    );
    await savePreference(db, user.id, input, await getEmailSettings(db), new Date());
    return c.json(await preferencesFor(user));
  });

  // ---- unsubscribe ---------------------------------------------------------------------------------

  async function resolveToken(token: string): Promise<{ target: UnsubscribeTarget; user: Pick<UserRow, 'id' | 'email'> }> {
    const target = verifyUnsubscribeToken(await emailSecret(db), token);
    if (!target) throw invalidToken();
    const user = await db.selectFrom('users').select(['id', 'email']).where('id', '=', target.userId).executeTakeFirst();
    if (!user) throw new ApiError(404, 'The account this link was for no longer exists.', 'not_found');
    return { target, user };
  }

  async function unsubscribeInfo(target: UnsubscribeTarget, email: string): Promise<UnsubscribeInfo> {
    const [site, settings, pref] = await Promise.all([getSiteSettings(db), getEmailSettings(db), loadPreference(db, target.userId)]);
    const category = target.category ? EMAIL_CATEGORIES.find((cat) => cat.id === target.category)! : null;
    return {
      siteName: site.name,
      maskedEmail: maskEmail(email),
      category: category ? { id: category.id, label: category.label } : null,
      unsubscribed: (pref?.frequency ?? settings.defaultFrequency) === 'off',
      categoryDisabled: !!category && !!pref?.disabledCategories.includes(category.id),
    };
  }

  async function unsubscribe(target: UnsubscribeTarget, scope: 'all' | 'category') {
    const settings = await getEmailSettings(db);
    if (scope === 'category' && target.category) {
      const pref = await loadPreference(db, target.userId);
      const disabled = new Set(pref?.disabledCategories ?? []);
      disabled.add(target.category);
      await savePreference(db, target.userId, { disabledCategories: [...disabled] }, settings, new Date());
    } else {
      await savePreference(db, target.userId, { frequency: 'off' }, settings, new Date());
    }
  }

  r.get('/api/email/unsubscribe', async (c) => {
    const { token } = readQuery(c, z.object({ token: tokenSchema }));
    const { target, user } = await resolveToken(token);
    return c.json(await unsubscribeInfo(target, user.email));
  });

  r.post('/api/email/unsubscribe', async (c) => {
    const input = await readBody(c, z.object({ token: tokenSchema, scope: z.enum(['all', 'category']).default('all') }));
    const { target, user } = await resolveToken(input.token);
    await unsubscribe(target, input.scope);
    return c.json(await unsubscribeInfo(target, user.email));
  });

  // The body is "List-Unsubscribe=One-Click"; the token in the URL is what counts. One click stops all email.
  r.post('/unsubscribe', async (c) => {
    c.header('Cache-Control', 'no-store');
    const target = verifyUnsubscribeToken(await emailSecret(db), c.req.query('token') ?? '');
    if (!target) throw invalidToken();
    const exists = await db.selectFrom('users').select('id').where('id', '=', target.userId).executeTakeFirst();
    if (exists) await unsubscribe(target, 'all');
    return c.json({ ok: true, unsubscribed: true });
  });

  // ---- admin ---------------------------------------------------------------------------------------

  r.get('/api/admin/email', async (c) => {
    requireAdmin(c);
    return c.json(await service().status());
  });

  r.put('/api/admin/email/settings', async (c) => {
    requireAdmin(c);
    const input = await readBody(
      c,
      z.object({
        defaultFrequency: frequencySchema.optional(),
        digestHour: z.number().int().min(0).max(23).optional(),
        digestWeekday: z.number().int().min(0).max(6).optional(),
        timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, 'Choose a valid time zone').optional(),
      }),
    );
    await updateEmailSettings(db, input);
    return c.json(await service().status());
  });

  r.post('/api/admin/email/test', async (c) => {
    const admin = requireAdmin(c);
    const input = await readBody(c, z.object({ to: emailSchema.optional() }));
    const email = service();
    if (!email.enabled) throw conflict('Email is not set up on this server. Configure a transport first.');
    const { id } = await email.sendTestEmail(input.to ?? admin.email);
    return c.json({ id }, 202);
  });

  r.get('/api/admin/email/messages/:id', async (c) => {
    requireAdmin(c);
    const row = await db
      .selectFrom('emailOutbox')
      .select(['id', 'kind', 'toAddress', 'subject', 'status', 'attempts', 'lastError', 'createdAt', 'sentAt'])
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!row) throw notFound('Email');
    const info: EmailMessageInfo = {
      id: row.id,
      kind: row.kind,
      to: row.toAddress,
      subject: row.subject,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    };
    return c.json(info);
  });

  r.post('/api/admin/email/retry-failed', async (c) => {
    requireAdmin(c);
    const requeued = await retryFailedEmails(db, new Date());
    if (requeued) service().wake();
    return c.json({ requeued });
  });

  return r;
}
