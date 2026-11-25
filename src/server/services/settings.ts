import { DEFAULT_BRAND_COLOR } from '../../shared/constants.js';
import type { SiteSettings } from '../../shared/types.js';
import type { DB } from '../db/types.js';

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  name: 'Coursekit',
  tagline: 'Learn anything, together.',
  brandColor: DEFAULT_BRAND_COLOR,
  allowSignup: true,
  welcomeMessage: 'Pick up where you left off.',
};

const PREFIX = 'site.';

export async function getSiteSettings(db: DB): Promise<SiteSettings> {
  const rows = await db.selectFrom('settings').selectAll().where('key', 'like', `${PREFIX}%`).execute();
  const settings: SiteSettings = { ...DEFAULT_SITE_SETTINGS };
  for (const row of rows) {
    const key = row.key.slice(PREFIX.length) as keyof SiteSettings;
    if (!(key in settings)) continue;
    try {
      (settings as unknown as Record<string, unknown>)[key] = JSON.parse(row.value);
    } catch {
      // ignore malformed values
    }
  }
  return settings;
}

export async function updateSiteSettings(db: DB, patch: Partial<SiteSettings>): Promise<SiteSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in DEFAULT_SITE_SETTINGS)) continue;
    const json = JSON.stringify(value);
    await db
      .insertInto('settings')
      .values({ key: PREFIX + key, value: json })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: json }))
      .execute();
  }
  return getSiteSettings(db);
}
