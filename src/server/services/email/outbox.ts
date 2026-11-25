/**
 * The email outbox. Requests only insert rows; the background worker (or `coursekit send-digests`) claims
 * due rows and delivers them, so a slow or failing mail server never holds up a request.
 *
 * Claiming is a conditional UPDATE that re-checks the row is still due, so on PostgreSQL a second process
 * waiting on the same row skips it once the first commits, and SQLite serialises writers anyway: two
 * processes never send the same message. A claim expires after LOCK_MS, so a crashed process's messages
 * are picked up again.
 */
import type { ExpressionBuilder } from 'kysely';
import type { EmailMessageStatus } from '../../../shared/email.js';
import type { Database, EmailOutboxRow, EmailOutboxTable } from '../../db/schema.js';
import type { DB } from '../../db/types.js';
import { newId, num } from '../../lib/util.js';

export type EmailKind = EmailOutboxTable['kind'];

export const DEFAULT_MAX_ATTEMPTS = 8;
/** Longer than any send is allowed to take (see SEND_TIMEOUT_MS in the service). */
export const LOCK_MS = 10 * 60_000;
/** Kept for the admin page's counts, then deleted. */
export const OUTBOX_RETENTION_DAYS = 30;
/** Queued messages older than this are stale: they are marked failed instead of sent. */
export const EXPIRE_DAYS = 7;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000];

/** Backoff before the next try after `attempt` failed tries, with ±20% jitter so retries spread out. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.max(0, Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1))]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Errors not worth retrying: `permanent: true`, or an SMTP 5xx reply other than an authentication failure. */
export function isPermanentError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { permanent?: unknown; responseCode?: unknown; code?: unknown };
  if (e.permanent === true) return true;
  if (e.code === 'EAUTH' || e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET') return false;
  return typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600;
}

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  return (
    message
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 500) || 'Unknown error'
  );
}

export interface NewEmail {
  kind: EmailKind;
  userId: string | null;
  notificationId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  maxAttempts?: number;
}

export async function enqueueEmails(db: DB, emails: NewEmail[], now: Date): Promise<string[]> {
  const nowIso = now.toISOString();
  const rows = emails.map((e) => ({
    id: newId(),
    kind: e.kind,
    userId: e.userId,
    notificationId: e.notificationId,
    toAddress: e.to,
    subject: e.subject,
    html: e.html,
    text: e.text,
    headers: JSON.stringify(e.headers),
    status: 'pending' as const,
    attempts: 0,
    maxAttempts: e.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: nowIso,
    lockId: null,
    lockedUntil: null,
    lastError: null,
    lastErrorAt: null,
    sentAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  // 20 columns a row: stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < rows.length; i += 50) {
    await db
      .insertInto('emailOutbox')
      .values(rows.slice(i, i + 50))
      .execute();
  }
  return rows.map((r) => r.id);
}

function isDue(nowIso: string) {
  return (eb: ExpressionBuilder<Database, 'emailOutbox'>) =>
    eb.or([
      eb.and([eb('status', '=', 'pending'), eb('nextAttemptAt', '<=', nowIso)]),
      eb.and([eb('status', '=', 'sending'), eb('lockedUntil', '<', nowIso)]),
    ]);
}

/** Claims up to `limit` due messages for this run. Each claim counts as an attempt. */
export async function claimDueEmails(db: DB, now: Date, limit: number): Promise<{ lockId: string; rows: EmailOutboxRow[] }> {
  const nowIso = now.toISOString();
  const lockId = newId();
  // Another process may claim the same candidates first; then look again rather than stop.
  for (let tries = 0; tries < 5; tries++) {
    const candidates = await db.selectFrom('emailOutbox').select('id').where(isDue(nowIso)).orderBy('nextAttemptAt').limit(limit).execute();
    if (!candidates.length) break;
    await db
      .updateTable('emailOutbox')
      .set((eb) => ({
        status: 'sending',
        lockId,
        lockedUntil: new Date(now.getTime() + LOCK_MS).toISOString(),
        attempts: eb('attempts', '+', 1),
        updatedAt: nowIso,
      }))
      .where(
        'id',
        'in',
        candidates.map((c) => c.id),
      )
      // Re-checked here: a row another process claimed in the meantime no longer matches.
      .where(isDue(nowIso))
      .execute();
    const rows = await db
      .selectFrom('emailOutbox')
      .selectAll()
      .where('lockId', '=', lockId)
      .where('status', '=', 'sending')
      .orderBy('nextAttemptAt')
      .execute();
    if (rows.length) return { lockId, rows };
  }
  return { lockId, rows: [] };
}

export async function markSent(db: DB, id: string, lockId: string, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await db
    .updateTable('emailOutbox')
    .set({ status: 'sent', sentAt: nowIso, lockId: null, lockedUntil: null, updatedAt: nowIso })
    .where('id', '=', id)
    .where('lockId', '=', lockId)
    .execute();
}

/** Records a failed try: schedules a retry with backoff, or gives up. */
export async function markFailed(
  db: DB,
  row: Pick<EmailOutboxRow, 'id' | 'attempts' | 'maxAttempts'>,
  lockId: string,
  err: unknown,
  now: Date,
): Promise<{ willRetry: boolean; error: string }> {
  const nowIso = now.toISOString();
  const error = errorText(err);
  const willRetry = !isPermanentError(err) && row.attempts < row.maxAttempts;
  await db
    .updateTable('emailOutbox')
    .set({
      status: willRetry ? 'pending' : 'failed',
      ...(willRetry ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)).toISOString() } : {}),
      lockId: null,
      lockedUntil: null,
      lastError: error,
      lastErrorAt: nowIso,
      updatedAt: nowIso,
    })
    .where('id', '=', row.id)
    .where('lockId', '=', lockId)
    .execute();
  return { willRetry, error };
}

/** Hands claimed-but-unsent messages back without counting the attempt (e.g. when the server is down). */
export async function releaseClaim(db: DB, lockId: string, ids: string[], now: Date): Promise<void> {
  if (!ids.length) return;
  await db
    .updateTable('emailOutbox')
    .set((eb) => ({ status: 'pending', lockId: null, lockedUntil: null, attempts: eb('attempts', '-', 1), updatedAt: now.toISOString() }))
    .where('lockId', '=', lockId)
    .where('status', '=', 'sending')
    .where('id', 'in', ids)
    .execute();
}

export async function retryFailedEmails(db: DB, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db
    .updateTable('emailOutbox')
    .set({ status: 'pending', attempts: 0, nextAttemptAt: nowIso, updatedAt: nowIso })
    .where('status', '=', 'failed')
    .executeTakeFirst();
  return num(result.numUpdatedRows);
}

/**
 * Deletes delivered and failed messages after OUTBOX_RETENTION_DAYS, and gives up on messages still queued
 * after EXPIRE_DAYS (e.g. while the transport could not start), so a long outage can't flood inboxes later.
 */
export async function pruneOutbox(db: DB, now: Date): Promise<{ deleted: number; expired: number }> {
  const nowIso = now.toISOString();
  const expired = await db
    .updateTable('emailOutbox')
    .set({ status: 'failed', lastError: `Not sent within ${EXPIRE_DAYS} days`, lastErrorAt: nowIso, updatedAt: nowIso })
    .where('status', '=', 'pending')
    .where('createdAt', '<', new Date(now.getTime() - EXPIRE_DAYS * 86_400_000).toISOString())
    .executeTakeFirst();
  const deleted = await db
    .deleteFrom('emailOutbox')
    .where('status', 'in', ['sent', 'failed'])
    .where('updatedAt', '<', new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000).toISOString())
    .executeTakeFirst();
  return { deleted: num(deleted.numDeletedRows), expired: num(expired.numUpdatedRows) };
}

export interface OutboxStats {
  counts: Record<EmailMessageStatus, number>;
  lastSentAt: string | null;
  lastError: { message: string; at: string; to: string; status: EmailMessageStatus } | null;
}

export async function outboxStats(db: DB): Promise<OutboxStats> {
  const [grouped, lastSent, lastError] = await Promise.all([
    db
      .selectFrom('emailOutbox')
      .select(['status', (eb) => eb.fn.countAll().as('n')])
      .groupBy('status')
      .execute(),
    db.selectFrom('emailOutbox').select('sentAt').where('status', '=', 'sent').orderBy('sentAt', 'desc').limit(1).executeTakeFirst(),
    db
      .selectFrom('emailOutbox')
      .select(['lastError', 'lastErrorAt', 'toAddress', 'status'])
      .where('lastErrorAt', 'is not', null)
      .orderBy('lastErrorAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  const counts: Record<EmailMessageStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const g of grouped) if (g.status in counts) counts[g.status] = num(g.n);
  return {
    counts,
    lastSentAt: lastSent?.sentAt ?? null,
    lastError:
      lastError?.lastError && lastError.lastErrorAt
        ? { message: lastError.lastError, at: lastError.lastErrorAt, to: lastError.toAddress, status: lastError.status }
        : null,
  };
}
