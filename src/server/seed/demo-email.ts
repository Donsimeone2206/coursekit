/**
 * Demo email preferences: a couple of people chose digests (everyone else follows the site default, which
 * is an email for each notification), so the profile page and digests have something to show.
 */
import type { EmailCategoryId, EmailFrequency } from '../../shared/email.js';
import type { AppDeps } from '../context.js';

const CHOICES: Array<{ email: string; frequency: EmailFrequency; disabled: EmailCategoryId[] }> = [
  { email: 'sofia.martinez@coursekit.test', frequency: 'daily', disabled: [] },
  { email: 'daniel.okafor@coursekit.test', frequency: 'weekly', disabled: ['discussions'] },
];

export async function seedDemoEmail(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const users = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where(
      'email',
      'in',
      CHOICES.map((c) => c.email),
    )
    .execute();
  const ids = new Map(users.map((u) => [u.email, u.id]));
  const ts = new Date().toISOString();
  const rows = CHOICES.filter((c) => ids.has(c.email)).map((c) => ({
    userId: ids.get(c.email)!,
    frequency: c.frequency,
    disabledCategories: JSON.stringify(c.disabled),
    lastDigestAt: ts,
    digestClaim: null,
    updatedAt: ts,
  }));
  if (!rows.length) return;
  await db
    .insertInto('emailPreferences')
    .values(rows)
    .onConflict((oc) => oc.column('userId').doNothing())
    .execute();
}
