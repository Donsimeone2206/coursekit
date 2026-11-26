/**
 * Shares: a recipient making one of their badges public. The public documents are always computed from the
 * current state of the share, the award, the badge and the account, so revoking an award, deleting a badge or an
 * account, or withdrawing the share takes effect on the very next request.
 *
 * Revocation is permanent: a share belongs to one awarding of the badge (its awardedAt). Restoring a revoked award
 * awards it anew (a new awardedAt), so the shares made before stay revoked and the badge isn't shared until the
 * recipient shares it again. Every query below therefore joins a share to its award on badge, person and awardedAt.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DB } from '../../db/types.js';
import type { BadgeRow } from '../../db/schema-completion.js';
import type { OpenBadgeShareRow } from '../../db/schema-open-badges.js';
import { now, num } from '../../lib/util.js';

/** Size of the revocation status list in entries: the Bitstring Status List minimum (16 KB). */
export const STATUS_LIST_SIZE = 131_072;

export const SHARE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ShareState {
  share: OpenBadgeShareRow;
  badge: BadgeRow | null;
  /** Title of the badge's course while the course is published, else null. */
  courseTitle: string | null;
  user: { id: string; name: string; email: string } | null;
  award: { awardedAt: string; note: string | null; revokedAt: string | null } | null;
}

export type ShareStatus = { valid: true; reason: null } | { valid: false; reason: string };

export function shareStatus(state: Pick<ShareState, 'share' | 'badge' | 'user' | 'award'>): ShareStatus {
  if (state.share.withdrawnAt) return { valid: false, reason: 'The recipient stopped sharing this badge.' };
  if (!state.badge) return { valid: false, reason: 'This badge no longer exists.' };
  if (!state.user) return { valid: false, reason: 'The recipient’s account no longer exists.' };
  if (!state.award || state.award.revokedAt) return { valid: false, reason: 'This badge was revoked by the issuer.' };
  return { valid: true, reason: null };
}

/** The share with everything its public documents need, or null when there is no such share. */
export async function loadShareState(db: DB, shareId: string): Promise<ShareState | null> {
  if (!SHARE_ID_RE.test(shareId)) return null;
  const share = await db.selectFrom('openBadgeShares').selectAll().where('id', '=', shareId).executeTakeFirst();
  if (!share) return null;
  const [badge, user, award] = await Promise.all([
    share.badgeId ? db.selectFrom('badges').selectAll().where('id', '=', share.badgeId).executeTakeFirst() : undefined,
    share.userId ? db.selectFrom('users').select(['id', 'name', 'email']).where('id', '=', share.userId).executeTakeFirst() : undefined,
    share.badgeId && share.userId
      ? db
          .selectFrom('badgeAwards')
          .select(['awardedAt', 'note', 'revokedAt'])
          .where('badgeId', '=', share.badgeId)
          .where('userId', '=', share.userId)
          .where('awardedAt', '=', share.awardedAt) // restored since: a new awarding, which this share isn't for
          .executeTakeFirst()
      : undefined,
  ]);
  // The course title is public only while the course is published (drafts and archived courses stay private).
  const course = badge?.courseId
    ? await db
        .selectFrom('courses')
        .select('title')
        .where('id', '=', badge.courseId)
        .where('visibility', '=', 'published')
        .executeTakeFirst()
    : undefined;
  return { share, badge: badge ?? null, courseTitle: course?.title ?? null, user: user ?? null, award: award ?? null };
}

/** The person's award of the badge, if they hold it (not revoked). */
export async function activeAward(db: DB, badgeId: string, userId: string) {
  return db
    .selectFrom('badgeAwards')
    .select(['awardedAt', 'note'])
    .where('badgeId', '=', badgeId)
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .executeTakeFirst();
}

/** The person's current share of the badge: not withdrawn, of the award as it is now (not revoked). */
export async function currentShare(db: DB, badgeId: string, userId: string): Promise<OpenBadgeShareRow | undefined> {
  return db
    .selectFrom('openBadgeShares')
    .innerJoin('badgeAwards', (join) =>
      join
        .onRef('badgeAwards.badgeId', '=', 'openBadgeShares.badgeId')
        .onRef('badgeAwards.userId', '=', 'openBadgeShares.userId')
        .onRef('badgeAwards.awardedAt', '=', 'openBadgeShares.awardedAt'),
    )
    .selectAll('openBadgeShares')
    .where('openBadgeShares.badgeId', '=', badgeId)
    .where('openBadgeShares.userId', '=', userId)
    .where('openBadgeShares.withdrawnAt', 'is', null)
    .where('badgeAwards.revokedAt', 'is', null)
    .orderBy('openBadgeShares.createdAt', 'desc')
    .executeTakeFirst();
}

/**
 * Shares the badge, once: an existing share is returned, also to concurrent requests (a unique index allows one
 * live share per awarding). The caller checks that the person holds the badge.
 */
export async function createShare(db: DB, badgeId: string, userId: string): Promise<OpenBadgeShareRow> {
  const award = await activeAward(db, badgeId, userId);
  if (!award) throw new Error('Only a badge the person holds can be shared.');
  const slotTaken = async (statusIndex: number) =>
    !!(await db.selectFrom('openBadgeShares').select('id').where('statusIndex', '=', statusIndex).executeTakeFirst());
  // Status list slots are random (as the Bitstring Status List spec recommends) and never reused.
  for (let attempt = 0; attempt < 25; attempt++) {
    const existing = await currentShare(db, badgeId, userId);
    if (existing) return existing;
    const row: OpenBadgeShareRow = {
      id: randomUUID(),
      badgeId,
      userId,
      awardedAt: award.awardedAt,
      salt: randomBytes(16).toString('hex'),
      subjectId: randomUUID(),
      statusIndex: randomInt(STATUS_LIST_SIZE),
      createdAt: now(),
      withdrawnAt: null,
    };
    if (await slotTaken(row.statusIndex)) continue;
    try {
      await db.insertInto('openBadgeShares').values(row).execute();
      return row;
    } catch (err) {
      // A concurrent request shared the badge first (the next round returns its share), or took the slot (the next
      // round picks another one). Anything else is a real error.
      if (!(await currentShare(db, badgeId, userId)) && !(await slotTaken(row.statusIndex))) throw err;
    }
  }
  throw new Error('The Open Badges revocation list is full.');
}

/**
 * Stops sharing: every current share of the badge by the person is withdrawn (and answers "revoked" from now on).
 * Shares of an earlier awarding are already revoked for good and keep saying so.
 */
export async function withdrawShares(db: DB, badgeId: string, userId: string): Promise<number> {
  const result = await db
    .updateTable('openBadgeShares')
    .set({ withdrawnAt: now() })
    .where('badgeId', '=', badgeId)
    .where('userId', '=', userId)
    .where('withdrawnAt', 'is', null)
    .where('awardedAt', 'in', db.selectFrom('badgeAwards').select('awardedAt').where('badgeId', '=', badgeId).where('userId', '=', userId))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Whether anything about the badge may be public: someone currently shares it and still holds it. */
export async function badgeIsShared(db: DB, badgeId: string): Promise<boolean> {
  const row = await db
    .selectFrom('openBadgeShares')
    .innerJoin('badgeAwards', (join) =>
      join
        .onRef('badgeAwards.badgeId', '=', 'openBadgeShares.badgeId')
        .onRef('badgeAwards.userId', '=', 'openBadgeShares.userId')
        .onRef('badgeAwards.awardedAt', '=', 'openBadgeShares.awardedAt'),
    )
    .select('openBadgeShares.id')
    .where('openBadgeShares.badgeId', '=', badgeId)
    .where('openBadgeShares.withdrawnAt', 'is', null)
    .where('badgeAwards.revokedAt', 'is', null)
    .executeTakeFirst();
  return !!row;
}

/** Status list slots of every credential that is no longer valid. */
export async function revokedStatusIndexes(db: DB): Promise<number[]> {
  const rows = await db
    .selectFrom('openBadgeShares')
    .leftJoin('badgeAwards', (join) =>
      join
        .onRef('badgeAwards.badgeId', '=', 'openBadgeShares.badgeId')
        .onRef('badgeAwards.userId', '=', 'openBadgeShares.userId')
        .onRef('badgeAwards.awardedAt', '=', 'openBadgeShares.awardedAt'),
    )
    .select(['openBadgeShares.statusIndex', 'openBadgeShares.withdrawnAt', 'badgeAwards.awardedAt', 'badgeAwards.revokedAt'])
    .execute();
  // No award row: the badge or the account was deleted (the references are then null too), or the award was revoked
  // and restored since the share was made (a new awarding).
  return rows.filter((r) => r.withdrawnAt || !r.awardedAt || r.revokedAt).map((r) => r.statusIndex);
}

/** Active shares on the site (administration overview). */
export async function countActiveShares(db: DB): Promise<number> {
  const row = await db
    .selectFrom('openBadgeShares')
    .innerJoin('badgeAwards', (join) =>
      join
        .onRef('badgeAwards.badgeId', '=', 'openBadgeShares.badgeId')
        .onRef('badgeAwards.userId', '=', 'openBadgeShares.userId')
        .onRef('badgeAwards.awardedAt', '=', 'openBadgeShares.awardedAt'),
    )
    .select((eb) => eb.fn.countAll().as('n'))
    .where('openBadgeShares.withdrawnAt', 'is', null)
    .where('badgeAwards.revokedAt', 'is', null)
    .executeTakeFirst();
  return num(row?.n);
}
