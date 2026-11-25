/**
 * The email service of one Coursekit instance: queues notification emails, runs the background worker
 * that delivers the outbox and sends digests, and backs the admin page.
 */
import { emailCategoryOf, type EmailAdminStatus, type EmailCategoryId, type EmailSiteSettings } from '../../../shared/email.js';
import type { ResolvedConfig } from '../../config.js';
import type { DB } from '../../db/types.js';
import type { EventBus } from '../../lib/events.js';
import { getSiteSettings } from '../settings.js';
import { addressOf } from './config.js';
import { digestSchedule, queueDueDigests, type DigestRunResult } from './digests.js';
import {
  claimDueEmails,
  enqueueEmails,
  errorText,
  isPermanentError,
  markFailed,
  markSent,
  outboxStats,
  pruneOutbox,
  releaseClaim,
  type NewEmail,
} from './outbox.js';
import { getEmailSettings, parseCategories } from './preferences.js';
import { emailSecret, signUnsubscribeToken } from './tokens.js';
import { createSender, type Sender } from './transport.js';
import {
  absoluteUrl,
  headerText,
  normalizeBaseUrl,
  renderNotificationEmail,
  renderTestEmail,
  type EmailBrand,
  type EmailLinks,
} from './templates.js';

export type { DigestRunResult } from './digests.js';

export interface OutboxRunResult {
  /** Messages delivered. */
  sent: number;
  /** Messages that failed for good. */
  failed: number;
  /** Messages that failed and will be tried again later. */
  retrying: number;
}

/** `coursekit.email`: programmatic control over outgoing email. */
export interface CoursekitEmail {
  /** True when a transport is configured. Everything else is a no-op while email is off. */
  readonly enabled: boolean;
  /**
   * Queues the daily and weekly digests that are due (at the site's digest hour, or now with `force`),
   * skipping people with nothing new. Safe to call from several processes or a cron job.
   */
  sendDigests(options?: { now?: Date | undefined; force?: boolean | undefined }): Promise<DigestRunResult>;
  /** Delivers queued email now, including retries whose backoff has passed. */
  processOutbox(options?: { now?: Date | undefined }): Promise<OutboxRunResult>;
  /** Queues a test message, e.g. to check SMTP settings. Resolves with the outbox id. */
  sendTestEmail(to: string): Promise<{ id: string }>;
  /** Starts the background worker (it starts by itself unless `email.worker` is false). */
  startWorker(): void;
  /** Stops the background worker, waiting briefly for a delivery in progress. */
  stopWorker(): Promise<void>;
}

export interface EmailServiceDeps {
  db: DB;
  config: ResolvedConfig;
  events: EventBus;
}

const POLL_MS = 15_000;
const DIGEST_CHECK_MS = 60_000;
const PRUNE_MS = 3_600_000;
const BATCH_SIZE = 20;
const RUN_BUDGET_MS = 25_000;
export const SEND_TIMEOUT_MS = 2 * 60_000;
/** After this many failures in a row the server is probably down: stop and try again later. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** What every email needs to render: branding, links and the signing secret. */
export interface RenderContext {
  brand: EmailBrand;
  base: string | null;
  from: string;
  settings: EmailSiteSettings;
  linksFor(userId: string | null, category?: EmailCategoryId | null): EmailLinks;
}

function quoteName(name: string): string {
  return `"${headerText(name, 100).replace(/["\\]/g, '\\$&')}"`;
}

/** The From header: the configured sender, named after the site when it has no name of its own. */
export function fromHeader(configured: string | null, siteName: string, base: string | null): { from: string; isDefault: boolean } {
  const clean = configured ? headerText(configured, 300) : null;
  if (clean && /<[^<>]+>\s*$/.test(clean)) return { from: clean, isDefault: false };
  let host = 'localhost';
  try {
    if (base) host = new URL(base).hostname || host;
  } catch {
    // keep localhost
  }
  const address = (clean && addressOf(clean)) || `no-reply@${host}`;
  return { from: `${quoteName(siteName)} <${address}>`, isDefault: !clean };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Sending timed out after ${Math.round(ms / 1000)} seconds`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class EmailService implements CoursekitEmail {
  readonly enabled: boolean;
  readonly sender: Sender | null;
  /** Why the transport can't send, e.g. nodemailer is missing. */
  transportError: string | null = null;
  #deps: EmailServiceDeps;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #active = false;
  #lastDigestCheck = 0;
  #digestSlotsDone: string | null = null;
  #lastPrune = 0;

  constructor(deps: EmailServiceDeps, sender: Sender | null = createSender(deps.config.email, deps.config.dataDir)) {
    this.#deps = deps;
    this.sender = sender;
    this.enabled = sender !== null;
  }

  get workerRunning(): boolean {
    return this.#active;
  }

  get db(): DB {
    return this.#deps.db;
  }

  /** Branding, links and secret for rendering, read through `db` (pass a transaction to stay inside it). */
  async renderContext(db: DB = this.#deps.db): Promise<RenderContext> {
    const [site, settings, secret] = await Promise.all([getSiteSettings(db), getEmailSettings(db), emailSecret(db)]);
    const base = normalizeBaseUrl(this.#deps.config.publicUrl);
    return {
      brand: { name: site.name, brandColor: site.brandColor },
      base,
      from: fromHeader(this.#deps.config.email.from, site.name, base).from,
      settings,
      linksFor: (userId, category = null) => ({
        preferences: absoluteUrl(base, '/profile?section=email'),
        unsubscribe: userId ? absoluteUrl(base, `/unsubscribe?token=${signUnsubscribeToken(secret, { userId, category })}`) : null,
      }),
    };
  }

  // ---- background worker -------------------------------------------------------------------------

  startWorker(): void {
    if (!this.sender || this.#active) return;
    this.#active = true;
    this.sender.ready().then(
      () => {
        this.transportError = null;
      },
      (err) => {
        this.transportError = errorText(err);
        console.error(`[coursekit] Email can't be sent: ${this.transportError}`);
      },
    );
    this.#schedule(1000);
  }

  async stopWorker(): Promise<void> {
    this.#active = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#running) await Promise.race([this.#running, sleep(5000)]);
  }

  /** Delivers soon instead of at the next poll, e.g. right after something was queued. */
  wake(): void {
    if (!this.#active) return;
    if (this.#running) this.#again = true;
    else this.#schedule(25);
  }

  async close(): Promise<void> {
    await this.stopWorker();
    await this.sender?.close();
  }

  #schedule(ms: number) {
    if (!this.#active) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#tick(), ms);
    this.#timer.unref();
  }

  #tick() {
    this.#timer = null;
    if (!this.#active || this.#running) return;
    this.#running = this.runOnce()
      .catch((err) => console.error('[coursekit] Email worker error:', err))
      .finally(() => {
        this.#running = null;
        const soon = this.#again;
        this.#again = false;
        this.#schedule(soon ? 25 : POLL_MS);
      });
  }

  /** One worker pass: digests (once a minute), delivery, and an hourly clean-up of old messages. */
  async runOnce(now = new Date()): Promise<void> {
    if (now.getTime() - this.#lastDigestCheck >= DIGEST_CHECK_MS) {
      this.#lastDigestCheck = now.getTime();
      // Once a run finds nobody due, the current slots are done: skip the scan until the next slot.
      const schedule = digestSchedule(now, await getEmailSettings(this.#deps.db));
      const slots = `${schedule.daily.toISOString()}|${schedule.weekly.toISOString()}`;
      if (slots !== this.#digestSlotsDone) {
        const result = await this.sendDigests({ now });
        if (result.daily + result.weekly + result.skipped === 0) this.#digestSlotsDone = slots;
      }
    }
    await this.processOutbox();
    if (now.getTime() - this.#lastPrune >= PRUNE_MS) {
      this.#lastPrune = now.getTime();
      await pruneOutbox(this.#deps.db, now);
    }
  }

  // ---- delivery ----------------------------------------------------------------------------------

  async processOutbox(options: { now?: Date | undefined } = {}): Promise<OutboxRunResult> {
    const result: OutboxRunResult = { sent: 0, failed: 0, retrying: 0 };
    const sender = this.sender;
    if (!sender) return result;
    try {
      await sender.ready();
      this.transportError = null;
    } catch (err) {
      // Leave messages queued (without using up attempts) until the transport works.
      this.transportError = errorText(err);
      return result;
    }
    const { db, events } = this.#deps;
    const clock = () => options.now ?? new Date();
    const site = await getSiteSettings(db);
    const from = fromHeader(this.#deps.config.email.from, site.name, normalizeBaseUrl(this.#deps.config.publicUrl)).from;
    const started = Date.now();
    let failuresInARow = 0;

    while (Date.now() - started < RUN_BUDGET_MS) {
      const { lockId, rows } = await claimDueEmails(db, clock(), BATCH_SIZE);
      if (!rows.length) break;
      for (const [index, row] of rows.entries()) {
        const base = { emailId: row.id, kind: row.kind, userId: row.userId, to: row.toAddress };
        try {
          let headers: Record<string, string> = {};
          try {
            headers = JSON.parse(row.headers) as Record<string, string>;
          } catch {
            // send without extra headers
          }
          await withTimeout(
            Promise.resolve(
              sender.send({ id: row.id, from, to: row.toAddress, subject: row.subject, html: row.html, text: row.text, headers }),
            ),
            SEND_TIMEOUT_MS,
          );
          await markSent(db, row.id, lockId, clock());
          result.sent++;
          failuresInARow = 0;
          events.emit('email.sent', base);
        } catch (err) {
          const { willRetry, error } = await markFailed(db, row, lockId, err, clock());
          if (willRetry) result.retrying++;
          else result.failed++;
          events.emit('email.failed', { ...base, error, willRetry });
          failuresInARow = isPermanentError(err) ? 0 : failuresInARow + 1;
          if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
            console.warn(`[coursekit] Email delivery is failing (${error}); trying again later.`);
            await releaseClaim(
              db,
              lockId,
              rows.slice(index + 1).map((r) => r.id),
              clock(),
            );
            return result;
          }
        }
      }
    }
    return result;
  }

  // ---- digests and tests -------------------------------------------------------------------------

  async sendDigests(options: { now?: Date | undefined; force?: boolean | undefined } = {}): Promise<DigestRunResult> {
    if (!this.enabled) return { daily: 0, weekly: 0, skipped: 0 };
    const ctx = await this.renderContext();
    const result = await queueDueDigests(this.#deps.db, ctx, { now: options.now ?? new Date(), force: options.force });
    if (result.daily + result.weekly > 0) this.wake();
    return result;
  }

  async sendTestEmail(to: string): Promise<{ id: string }> {
    if (!this.sender) throw new Error('Email is not set up on this server.');
    const db = this.#deps.db;
    const address = headerText(to, 254).toLowerCase();
    const ctx = await this.renderContext();
    const user = await db.selectFrom('users').select('id').where('email', '=', address).executeTakeFirst();
    const now = new Date();
    const rendered = renderTestEmail({
      brand: ctx.brand,
      links: ctx.linksFor(user?.id ?? null),
      transportName: this.sender.name,
      sentAt: now.toISOString(),
      timezone: ctx.settings.timezone,
    });
    // One try only, so the admin page reports a problem straight away.
    const [id] = await enqueueEmails(
      db,
      [{ kind: 'test', userId: user?.id ?? null, notificationId: null, to: address, ...rendered, maxAttempts: 1 }],
      now,
    );
    this.wake();
    return { id: id! };
  }

  // ---- admin -------------------------------------------------------------------------------------

  async status(now = new Date()): Promise<EmailAdminStatus> {
    const db = this.#deps.db;
    const config = this.#deps.config;
    const [site, settings, stats] = await Promise.all([getSiteSettings(db), getEmailSettings(db), outboxStats(db)]);
    // Checks the transport can start (e.g. nodemailer is installed) without sending anything.
    if (this.sender) {
      this.transportError = await this.sender.ready().then(
        () => null,
        (err: unknown) => errorText(err),
      );
    }
    const base = normalizeBaseUrl(config.publicUrl);
    const from = fromHeader(config.email.from, site.name, base);
    const schedule = digestSchedule(now, settings);
    return {
      enabled: this.enabled,
      transport: config.email.transport,
      transportName: this.sender?.name ?? 'Off',
      transportDetail: this.sender?.detail ?? null,
      transportError: this.transportError,
      worker: this.#active,
      from: from.from,
      fromIsDefault: from.isDefault,
      publicUrl: base,
      settings,
      outbox: stats.counts,
      lastSentAt: stats.lastSentAt,
      lastError: stats.lastError,
      nextDigests: { daily: schedule.nextDaily.toISOString(), weekly: schedule.nextWeekly.toISOString() },
    };
  }
}

// ---- one service per database ------------------------------------------------------------------------

const services = new WeakMap<object, EmailService>();

/**
 * Creates the email service for a Coursekit instance and registers it with the database handle, which is
 * how notify() finds it. Starts the background worker when email is configured and the worker is enabled.
 */
export function createEmailService(deps: EmailServiceDeps, options: { startWorker?: boolean } = {}): EmailService {
  const service = new EmailService(deps);
  services.set(deps.db, service);
  if (service.enabled && (options.startWorker ?? deps.config.email.worker)) service.startWorker();
  return service;
}

export function emailServiceFor(db: DB): EmailService | undefined {
  return services.get(db);
}

export interface NotificationForEmail {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
}

/**
 * Queues an email for each notification whose recipient wants one immediately and hasn't switched its
 * category off. Called by notify(); a no-op while email is off. Never throws: a notification must not
 * fail because of email. (Pass the instance's own `db`: inside a transaction there is no email service.)
 */
export async function queueNotificationEmails(db: DB, notifications: NotificationForEmail[], now = new Date()): Promise<number> {
  const service = emailServiceFor(db);
  if (!service?.enabled || notifications.length === 0) return 0;
  try {
    const ctx = await service.renderContext(db);
    const userIds = [...new Set(notifications.map((n) => n.userId))];
    const recipients = new Map<string, { email: string; frequency: string | null; disabled: EmailCategoryId[] }>();
    for (let i = 0; i < userIds.length; i += 500) {
      const rows = await db
        .selectFrom('users')
        .leftJoin('emailPreferences', 'emailPreferences.userId', 'users.id')
        .select(['users.id', 'users.email', 'emailPreferences.frequency', 'emailPreferences.disabledCategories'])
        .where('users.id', 'in', userIds.slice(i, i + 500))
        .where('users.status', '=', 'active')
        .execute();
      for (const r of rows)
        recipients.set(r.id, { email: r.email, frequency: r.frequency, disabled: parseCategories(r.disabledCategories) });
    }

    const emails: NewEmail[] = [];
    for (const n of notifications) {
      const person = recipients.get(n.userId);
      if (!person || (person.frequency ?? ctx.settings.defaultFrequency) !== 'immediately') continue;
      const category = emailCategoryOf(n.type);
      if (person.disabled.includes(category)) continue;
      const rendered = renderNotificationEmail({
        brand: ctx.brand,
        links: ctx.linksFor(n.userId, category),
        base: ctx.base,
        title: n.title,
        body: n.body,
        link: n.link,
        category,
      });
      emails.push({ kind: 'notification', userId: n.userId, notificationId: n.id, to: person.email, ...rendered });
    }
    if (!emails.length) return 0;
    await enqueueEmails(db, emails, now);
    service.wake();
    return emails.length;
  } catch (err) {
    console.error('[coursekit] Could not queue notification emails:', err);
    return 0;
  }
}
