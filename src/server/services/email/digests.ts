/**
 * Daily and weekly digests. Each digest summarises the notifications a person received since their last
 * digest (and that weren't already emailed one by one); nothing is sent when there are none.
 *
 * Digests go out at the site's digest hour in its time zone. A "slot" is the most recent such moment; a
 * person is due when their last digest is older than the slot. Slots stay open for DIGEST_GRACE_MS so a
 * server that was down at the digest hour catches up, but digests never go out at random times of day
 * (unless forced, e.g. by `coursekit send-digests --force` from a cron job at another hour).
 */
import { emailCategoryOf, type EmailSiteSettings } from '../../../shared/email.js';
import type { DB } from '../../db/types.js';
import { newId } from '../../lib/util.js';
import { enqueueEmails, type NewEmail } from './outbox.js';
import { parseCategories } from './preferences.js';
import { renderDigestEmail, type DigestItem, type EmailBrand, type EmailLinks } from './templates.js';

export type DigestPeriod = 'daily' | 'weekly';

export const DIGEST_GRACE_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const PERIOD_MS: Record<DigestPeriod, number> = { daily: DAY_MS, weekly: 7 * DAY_MS };
/** A digest never reaches further back than this, however long ago the last one was. */
const MAX_LOOKBACK_MS = 31 * DAY_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `timeZone` shows the given local date and hour (day may overflow). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - second);
}

export interface DigestSchedule {
  /** Most recent daily slot (at or before now). */
  daily: Date;
  weekly: Date;
  nextDaily: Date;
  nextWeekly: Date;
}

export function digestSchedule(now: Date, settings: Pick<EmailSiteSettings, 'digestHour' | 'digestWeekday' | 'timezone'>): DigestSchedule {
  const tz = settings.timezone;
  const hour = settings.digestHour;
  const p = zonedParts(now, tz);
  const at = (dayOffset: number) => zonedTimeToUtc(p.year, p.month, p.day + dayOffset, hour, tz);

  let dailyOffset = 0;
  if (at(0) > now) dailyOffset = -1;
  let weeklyOffset = -((p.weekday - settings.digestWeekday + 7) % 7);
  if (at(weeklyOffset) > now) weeklyOffset -= 7;
  return { daily: at(dailyOffset), weekly: at(weeklyOffset), nextDaily: at(dailyOffset + 1), nextWeekly: at(weeklyOffset + 7) };
}

export interface DigestContext {
  brand: EmailBrand;
  base: string | null;
  settings: EmailSiteSettings;
  /** Links for a person, including their signed unsubscribe link. */
  linksFor(userId: string): EmailLinks;
}

export interface DigestRunResult {
  /** Daily digests queued. */
  daily: number;
  /** Weekly digests queued. */
  weekly: number;
  /** People who were due but had nothing new, so got no email. */
  skipped: number;
}

/** Queues every digest that is due at `now`. Safe to run from several processes at once. */
export async function queueDueDigests(
  db: DB,
  ctx: DigestContext,
  options: { now: Date; force?: boolean | undefined; batchSize?: number; maxUsers?: number },
): Promise<DigestRunResult> {
  const { now } = options;
  const schedule = digestSchedule(now, ctx.settings);
  const result: DigestRunResult = { daily: 0, weekly: 0, skipped: 0 };
  for (const period of ['daily', 'weekly'] as const) {
    const slot = period === 'daily' ? schedule.daily : schedule.weekly;
    if (!options.force && now.getTime() - slot.getTime() >= DIGEST_GRACE_MS) continue;
    let considered = 0;
    while (considered < (options.maxUsers ?? 5000)) {
      const batch = await digestBatch(db, ctx, period, slot, now, options.batchSize ?? 200);
      if (!batch.considered) break;
      considered += batch.considered;
      result[period] += batch.queued;
      result.skipped += batch.skipped;
    }
  }
  return result;
}

async function digestBatch(
  db: DB,
  ctx: DigestContext,
  period: DigestPeriod,
  slot: Date,
  now: Date,
  size: number,
): Promise<{ considered: number; queued: number; skipped: number }> {
  const slotIso = slot.toISOString();
  const nowIso = now.toISOString();
  const due = await db
    .selectFrom('users')
    .leftJoin('emailPreferences', 'emailPreferences.userId', 'users.id')
    .select([
      'users.id',
      'users.email',
      'emailPreferences.userId as prefUserId',
      'emailPreferences.lastDigestAt',
      'emailPreferences.disabledCategories',
    ])
    .where('users.status', '=', 'active')
    .where((eb) => eb(eb.fn.coalesce('emailPreferences.frequency', eb.val(ctx.settings.defaultFrequency)), '=', period))
    // New accounts wait for the first slot after they were created.
    .where((eb) => eb(eb.fn.coalesce('emailPreferences.lastDigestAt', 'users.createdAt'), '<', slotIso))
    .orderBy('users.id')
    .limit(size)
    .execute();
  if (!due.length) return { considered: 0, queued: 0, skipped: 0 };

  return db.transaction().execute(async (trx) => {
    const missing = due.filter((u) => !u.prefUserId);
    if (missing.length) {
      await trx
        .insertInto('emailPreferences')
        .values(
          missing.map((u) => ({
            userId: u.id,
            frequency: null,
            disabledCategories: '[]',
            lastDigestAt: null,
            digestClaim: null,
            updatedAt: nowIso,
          })),
        )
        .onConflict((oc) => oc.column('userId').doNothing())
        .execute();
    }
    // Claim: whoever moves lastDigestAt past the slot first sends the digest; everyone else skips.
    const claim = newId();
    await trx
      .updateTable('emailPreferences')
      .set({ lastDigestAt: nowIso, digestClaim: claim })
      .where(
        'userId',
        'in',
        due.map((u) => u.id),
      )
      .where((eb) => eb.or([eb('lastDigestAt', 'is', null), eb('lastDigestAt', '<', slotIso)]))
      .execute();
    const claimed = new Set(
      (await trx.selectFrom('emailPreferences').select('userId').where('digestClaim', '=', claim).execute()).map((r) => r.userId),
    );
    const people = due.filter((u) => claimed.has(u.id));
    if (!people.length) return { considered: due.length, queued: 0, skipped: 0 };

    const sinceFor = new Map(
      people.map((u) => {
        const last = u.lastDigestAt ? new Date(u.lastDigestAt).getTime() : now.getTime() - PERIOD_MS[period];
        return [u.id, new Date(Math.max(last, now.getTime() - MAX_LOOKBACK_MS)).toISOString()];
      }),
    );
    const earliest = [...sinceFor.values()].sort()[0]!;
    const notes = await trx
      .selectFrom('notifications')
      .select(['id', 'userId', 'type', 'title', 'body', 'link', 'createdAt'])
      .where(
        'userId',
        'in',
        people.map((u) => u.id),
      )
      .where('createdAt', '>=', earliest)
      .where('createdAt', '<=', nowIso)
      // Skip notifications that already had their own email.
      .where((eb) =>
        eb.not(
          eb.exists(eb.selectFrom('emailOutbox').select('emailOutbox.id').whereRef('emailOutbox.notificationId', '=', 'notifications.id')),
        ),
      )
      .orderBy('createdAt', 'desc')
      .execute();

    const byUser = new Map<string, DigestItem[]>();
    const disabled = new Map(people.map((u) => [u.id, new Set(parseCategories(u.disabledCategories))]));
    for (const n of notes) {
      if (n.createdAt < sinceFor.get(n.userId)!) continue;
      const category = emailCategoryOf(n.type);
      if (disabled.get(n.userId)!.has(category)) continue;
      const list = byUser.get(n.userId) ?? [];
      list.push({ title: n.title, body: n.body, link: n.link, category, createdAt: n.createdAt });
      byUser.set(n.userId, list);
    }

    const emails: NewEmail[] = [];
    for (const person of people) {
      const items = byUser.get(person.id);
      if (!items?.length) continue;
      const rendered = renderDigestEmail({
        brand: ctx.brand,
        links: ctx.linksFor(person.id),
        base: ctx.base,
        period,
        since: sinceFor.get(person.id)!,
        items,
        timezone: ctx.settings.timezone,
      });
      emails.push({ kind: 'digest', userId: person.id, notificationId: null, to: person.email, ...rendered });
    }
    await enqueueEmails(trx, emails, now);
    return { considered: due.length, queued: emails.length, skipped: people.length - emails.length };
  });
}
