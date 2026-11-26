/**
 * Demo data for Open Badges export: Alex Johnson has shared his "Landing page pro" badge, so its public
 * verification page and Open Badges files exist (they need COURSEKIT_PUBLIC_URL to be served). Runs after the
 * completion demo, which awards the badges. Works offline: the signing key is only created on first use.
 */
import type { AppDeps } from '../context.js';
import { activeAward, createShare } from '../services/open-badges/shares.js';

export async function seedOpenBadgesDemo(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const alex = await db.selectFrom('users').select('id').where('email', '=', 'alex.johnson@coursekit.test').executeTakeFirst();
  const badge = await db.selectFrom('badges').select('id').where('name', '=', 'Landing page pro').executeTakeFirst();
  if (!alex || !badge || !(await activeAward(db, badge.id, alex.id))) return;
  await createShare(db, badge.id, alex.id);
}
