/** Site-wide email settings and each person's delivery preferences. */
import {
  EMAIL_CATEGORY_IDS,
  EMAIL_FREQUENCIES,
  type EmailCategoryId,
  type EmailFrequency,
  type EmailSiteSettings,
} from '../../../shared/email.js';
import type { DB } from '../../db/types.js';
import { parseJson } from '../../lib/util.js';

const KEYS: Record<keyof EmailSiteSettings, string> = {
  defaultFrequency: 'email.defaultFrequency',
  digestHour: 'email.digestHour',
  digestWeekday: 'email.digestWeekday',
  timezone: 'email.timezone',
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function serverTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultEmailSettings(): EmailSiteSettings {
  return { defaultFrequency: 'immediately', digestHour: 8, digestWeekday: 1, timezone: serverTimeZone() };
}

function isFrequency(value: unknown): value is EmailFrequency {
  return typeof value === 'string' && EMAIL_FREQUENCIES.includes(value as EmailFrequency);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export async function getEmailSettings(db: DB): Promise<EmailSiteSettings> {
  const rows = await db.selectFrom('settings').selectAll().where('key', 'in', Object.values(KEYS)).execute();
  const stored = new Map(rows.map((r) => [r.key, parseJson<unknown>(r.value, null)]));
  const settings = defaultEmailSettings();
  const frequency = stored.get(KEYS.defaultFrequency);
  if (isFrequency(frequency)) settings.defaultFrequency = frequency;
  const hour = stored.get(KEYS.digestHour);
  if (isInt(hour, 0, 23)) settings.digestHour = hour;
  const weekday = stored.get(KEYS.digestWeekday);
  if (isInt(weekday, 0, 6)) settings.digestWeekday = weekday;
  const tz = stored.get(KEYS.timezone);
  if (typeof tz === 'string' && isValidTimeZone(tz)) settings.timezone = tz;
  return settings;
}

export async function updateEmailSettings(db: DB, patch: Partial<EmailSiteSettings>): Promise<EmailSiteSettings> {
  const entries = (Object.keys(KEYS) as Array<keyof EmailSiteSettings>).filter((k) => patch[k] !== undefined);
  if (entries.length) {
    await db.transaction().execute(async (trx) => {
      for (const key of entries) {
        const value = JSON.stringify(patch[key]);
        await trx
          .insertInto('settings')
          .values({ key: KEYS[key], value })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
          .execute();
      }
    });
  }
  return getEmailSettings(db);
}

/** Known category ids from stored JSON, without duplicates. */
export function parseCategories(json: string | null | undefined): EmailCategoryId[] {
  const list = parseJson<unknown>(json, []);
  if (!Array.isArray(list)) return [];
  return EMAIL_CATEGORY_IDS.filter((id) => list.includes(id));
}

export interface StoredPreference {
  /** null: follows the site default. */
  frequency: EmailFrequency | null;
  disabledCategories: EmailCategoryId[];
  lastDigestAt: string | null;
}

export async function loadPreference(db: DB, userId: string): Promise<StoredPreference | null> {
  const row = await db.selectFrom('emailPreferences').selectAll().where('userId', '=', userId).executeTakeFirst();
  if (!row) return null;
  return {
    frequency: isFrequency(row.frequency) ? row.frequency : null,
    disabledCategories: parseCategories(row.disabledCategories),
    lastDigestAt: row.lastDigestAt,
  };
}

/**
 * Saves a person's choices. Changing how often they're emailed restarts the digest window, so the first
 * digest after switching only covers what arrived after the switch.
 */
export async function savePreference(
  db: DB,
  userId: string,
  patch: { frequency?: EmailFrequency | undefined; disabledCategories?: EmailCategoryId[] | undefined },
  settings: EmailSiteSettings,
  now: Date,
): Promise<StoredPreference> {
  const current = await loadPreference(db, userId);
  const frequency = patch.frequency ?? current?.frequency ?? null;
  const before = current?.frequency ?? settings.defaultFrequency;
  const after = frequency ?? settings.defaultFrequency;
  const disabledCategories = patch.disabledCategories
    ? EMAIL_CATEGORY_IDS.filter((id) => patch.disabledCategories!.includes(id))
    : (current?.disabledCategories ?? []);
  const nowIso = now.toISOString();
  const lastDigestAt = after !== before ? nowIso : (current?.lastDigestAt ?? null);
  const values = { frequency, disabledCategories: JSON.stringify(disabledCategories), lastDigestAt, updatedAt: nowIso };
  await db
    .insertInto('emailPreferences')
    .values({ userId, digestClaim: null, ...values })
    .onConflict((oc) => oc.column('userId').doUpdateSet(values))
    .execute();
  return { frequency, disabledCategories, lastDigestAt };
}
