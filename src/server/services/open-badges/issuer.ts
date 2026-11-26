/**
 * The issuer details published in Open Badges (settings key openBadges.issuer), with their defaults:
 * the site name, and the address outgoing email is sent from.
 */
import type { OpenBadgesIssuerSettings } from '../../../shared/open-badges.js';
import type { AppDeps } from '../../context.js';
import type { DB } from '../../db/types.js';
import { addressOf } from '../email/config.js';
import { normalizeBaseUrl } from '../email/templates.js';
import { getSiteSettings } from '../settings.js';

const ISSUER_SETTING = 'openBadges.issuer';

export const EMPTY_ISSUER_SETTINGS: OpenBadgesIssuerSettings = { name: '', email: '', description: '' };

/** The resolved issuer, as published. `email` is null when neither a contact address nor a from address is set. */
export interface Issuer {
  name: string;
  email: string | null;
  description: string;
  url: string;
}

export async function getIssuerSettings(db: DB): Promise<OpenBadgesIssuerSettings> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', ISSUER_SETTING).executeTakeFirst();
  if (!row) return { ...EMPTY_ISSUER_SETTINGS };
  try {
    const value = JSON.parse(row.value) as Partial<OpenBadgesIssuerSettings>;
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    return { name: text(value.name), email: text(value.email), description: text(value.description) };
  } catch {
    return { ...EMPTY_ISSUER_SETTINGS };
  }
}

export async function saveIssuerSettings(db: DB, settings: OpenBadgesIssuerSettings): Promise<void> {
  const value = JSON.stringify(settings);
  await db
    .insertInto('settings')
    .values({ key: ISSUER_SETTING, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

export function defaultIssuerEmail(deps: Pick<AppDeps, 'config'>): string | null {
  return deps.config.email.from ? addressOf(deps.config.email.from) : null;
}

/** The site's public URL without a trailing slash, or null: Open Badges need absolute URLs. */
export function publicBase(deps: Pick<AppDeps, 'config'>): string | null {
  return normalizeBaseUrl(deps.config.publicUrl);
}

export async function resolveIssuer(deps: Pick<AppDeps, 'db' | 'config'>, base: string): Promise<Issuer> {
  const [settings, site] = await Promise.all([getIssuerSettings(deps.db), getSiteSettings(deps.db)]);
  return {
    name: settings.name.trim() || site.name,
    email: settings.email.trim() || defaultIssuerEmail(deps),
    description: settings.description.trim(),
    url: base,
  };
}
