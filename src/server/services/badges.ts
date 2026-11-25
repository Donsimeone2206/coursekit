import type { BadgeRecipient, BadgeSummary, EarnedBadge } from '../../shared/completion.js';
import type { CourseRef } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { DB } from '../db/types.js';
import type { BadgeRow } from '../db/schema-completion.js';
import { now, num, parseJson } from '../lib/util.js';
import { notify } from './notify.js';
import { toCourseRef, toPublicUser } from './serialize.js';

export interface AwardOptions {
  awardedBy: string | null;
  note?: string | null;
  at?: string;
  /** Manual awards bring back a revoked award; automatic ones never do. */
  restoreRevoked: boolean;
}

export interface BadgeAwards {
  badge: BadgeRow;
  userIds: string[];
}

export function criteriaCourseIds(badge: Pick<BadgeRow, 'criteriaCourseIds'>): string[] {
  return parseJson<string[]>(badge.criteriaCourseIds, []).filter((id) => typeof id === 'string');
}

/** Awards `badge` to each user once. Returns the users who received it now (new, or restored from revoked). */
export async function insertAwards(db: DB, badge: BadgeRow, userIds: string[], options: AwardOptions): Promise<string[]> {
  const ids = [...new Set(userIds)];
  const at = options.at ?? now();
  const note = options.note ?? null;
  const awarded: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const values = ids.slice(i, i + 100).map((userId) => ({
      badgeId: badge.id,
      userId,
      awardedAt: at,
      awardedBy: options.awardedBy,
      note,
      revokedAt: null,
      revokedBy: null,
    }));
    const insert = db.insertInto('badgeAwards').values(values);
    const rows = options.restoreRevoked
      ? await insert
          .onConflict((oc) =>
            oc
              .columns(['badgeId', 'userId'])
              .doUpdateSet({ awardedAt: at, awardedBy: options.awardedBy, note, revokedAt: null, revokedBy: null })
              .where('badgeAwards.revokedAt', 'is not', null),
          )
          .returning('userId')
          .execute()
      : await insert
          .onConflict((oc) => oc.columns(['badgeId', 'userId']).doNothing())
          .returning('userId')
          .execute();
    awarded.push(...rows.map((r) => r.userId));
  }
  return awarded;
}

/** People (optionally limited to `userIds`) who completed every course in `courseIds`. */
export async function usersWhoCompletedAll(db: DB, courseIds: string[], userIds?: string[]): Promise<string[]> {
  const required = [...new Set(courseIds)];
  if (required.length === 0 || userIds?.length === 0) return [];
  const query = (users?: string[]) =>
    db
      .selectFrom('courseCompletions')
      .select('userId')
      .where('courseId', 'in', required)
      .$if(!!users, (q) => q.where('userId', 'in', users!))
      .groupBy('userId')
      .having((eb) => eb(eb.fn.countAll(), '=', required.length))
      .execute();
  if (!userIds) return (await query()).map((r) => r.userId);
  const result: string[] = [];
  for (let i = 0; i < userIds.length; i += 500) result.push(...(await query(userIds.slice(i, i + 500))).map((r) => r.userId));
  return result;
}

/**
 * Automatic awards for people who just completed `courseId`: the course's completion badges and any
 * site badge whose courses they have now all completed.
 */
export async function awardBadgesForCompletion(db: DB, courseId: string, userIds: string[], at: string): Promise<BadgeAwards[]> {
  if (userIds.length === 0) return [];
  const [courseBadges, siteBadges] = await Promise.all([
    db.selectFrom('badges').selectAll().where('courseId', '=', courseId).where('criteria', '=', 'completion').execute(),
    db.selectFrom('badges').selectAll().where('courseId', 'is', null).where('criteria', '=', 'courses').execute(),
  ]);
  const results: BadgeAwards[] = [];
  for (const badge of courseBadges) {
    const awarded = await insertAwards(db, badge, userIds, { awardedBy: null, at, restoreRevoked: false });
    if (awarded.length) results.push({ badge, userIds: awarded });
  }
  for (const badge of siteBadges) {
    const required = criteriaCourseIds(badge);
    if (!required.includes(courseId)) continue;
    const qualified = await usersWhoCompletedAll(db, required, userIds);
    const awarded = await insertAwards(db, badge, qualified, { awardedBy: null, at, restoreRevoked: false });
    if (awarded.length) results.push({ badge, userIds: awarded });
  }
  return results;
}

/** Retroactive automatic awards, e.g. right after a completion badge is created. */
export async function awardQualifyingUsers(db: DB, badge: BadgeRow): Promise<string[]> {
  let qualified: string[] = [];
  if (badge.criteria === 'completion' && badge.courseId) {
    const rows = await db.selectFrom('courseCompletions').select('userId').where('courseId', '=', badge.courseId).execute();
    qualified = rows.map((r) => r.userId);
  } else if (badge.criteria === 'courses' && !badge.courseId) {
    qualified = await usersWhoCompletedAll(db, criteriaCourseIds(badge));
  }
  return insertAwards(db, badge, qualified, { awardedBy: null, restoreRevoked: false });
}

/** Notifies new recipients and emits `badge.awarded`. Call after the awards are committed. */
export async function announceAwards(deps: Pick<AppDeps, 'db' | 'events'>, awards: BadgeAwards[], awardedBy: string | null) {
  for (const { badge, userIds } of awards) {
    if (userIds.length === 0) continue;
    await notify(deps.db, userIds, {
      type: 'badge',
      title: `You earned the “${badge.name}” badge`,
      body: badge.description || (badge.courseId ? 'A new badge for your profile.' : 'A new site badge for your profile.'),
      link: `/badges/${badge.id}`,
    });
    for (const userId of userIds) deps.events.emit('badge.awarded', { badgeId: badge.id, courseId: badge.courseId, userId, awardedBy });
  }
}

/** Badge cards with their courses, recipient counts and the viewer's own awards, in a fixed number of queries. */
export async function summarizeBadges(
  db: DB,
  badges: BadgeRow[],
  options: { earnedBy: string | null; countRecipients: boolean },
): Promise<BadgeSummary[]> {
  if (badges.length === 0) return [];
  const ids = badges.map((b) => b.id);
  const courseIds = [
    ...new Set(badges.flatMap((b) => [...(b.courseId ? [b.courseId] : []), ...(b.criteria === 'courses' ? criteriaCourseIds(b) : [])])),
  ];
  const [courses, counts, earned] = await Promise.all([
    courseIds.length
      ? db.selectFrom('courses').select(['id', 'slug', 'title', 'coverColor']).where('id', 'in', courseIds).execute()
      : Promise.resolve([]),
    options.countRecipients
      ? db
          .selectFrom('badgeAwards')
          .select(['badgeId', (eb) => eb.fn.countAll().as('n')])
          .where('badgeId', 'in', ids)
          .where('revokedAt', 'is', null)
          .groupBy('badgeId')
          .execute()
      : Promise.resolve([]),
    options.earnedBy
      ? db
          .selectFrom('badgeAwards')
          .select(['badgeId', 'awardedAt'])
          .where('badgeId', 'in', ids)
          .where('userId', '=', options.earnedBy)
          .where('revokedAt', 'is', null)
          .execute()
      : Promise.resolve([]),
  ]);
  const courseMap = new Map<string, CourseRef>(courses.map((c) => [c.id, toCourseRef(c)]));
  const countMap = new Map(counts.map((c) => [c.badgeId, num(c.n)]));
  const earnedMap = new Map(earned.map((e) => [e.badgeId, e.awardedAt]));
  return badges.map((b) => ({
    id: b.id,
    course: b.courseId ? (courseMap.get(b.courseId) ?? null) : null,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
    criteria: b.criteria,
    criteriaCourses: b.criteria === 'courses' ? criteriaCourseIds(b).flatMap((id) => courseMap.get(id) ?? []) : [],
    recipientCount: options.countRecipients ? (countMap.get(b.id) ?? 0) : null,
    earnedAt: earnedMap.get(b.id) ?? null,
    createdAt: b.createdAt,
  }));
}

/** Everyone who has (or had) the badge, newest first. Emails only for people who may see them. */
export async function badgeRecipients(db: DB, badgeId: string, showEmails: boolean): Promise<BadgeRecipient[]> {
  const rows = await db
    .selectFrom('badgeAwards')
    .innerJoin('users', 'users.id', 'badgeAwards.userId')
    .leftJoin('users as giver', 'giver.id', 'badgeAwards.awardedBy')
    .select([
      'badgeAwards.awardedAt',
      'badgeAwards.note',
      'badgeAwards.revokedAt',
      'users.id',
      'users.name',
      'users.email',
      'users.avatarUrl',
      'giver.id as giverId',
      'giver.name as giverName',
      'giver.avatarUrl as giverAvatarUrl',
    ])
    .where('badgeAwards.badgeId', '=', badgeId)
    .orderBy('badgeAwards.awardedAt', 'desc')
    .orderBy('users.name', 'asc')
    .execute();
  return rows.map((r) => ({
    user: { id: r.id, name: r.name, avatarUrl: r.avatarUrl, email: showEmails ? r.email : null },
    awardedAt: r.awardedAt,
    awardedBy: r.giverId ? toPublicUser({ id: r.giverId, name: r.giverName ?? '', avatarUrl: r.giverAvatarUrl ?? null }) : null,
    note: r.note,
    revokedAt: r.revokedAt,
  }));
}

export async function earnedBadges(db: DB, userId: string): Promise<EarnedBadge[]> {
  const awards = await db
    .selectFrom('badgeAwards')
    .innerJoin('badges', 'badges.id', 'badgeAwards.badgeId')
    .selectAll('badges')
    .select(['badgeAwards.awardedAt', 'badgeAwards.note'])
    .where('badgeAwards.userId', '=', userId)
    .where('badgeAwards.revokedAt', 'is', null)
    .orderBy('badgeAwards.awardedAt', 'desc')
    .execute();
  const summaries = await summarizeBadges(db, awards, { earnedBy: userId, countRecipients: false });
  return awards.map((a, i) => ({ badge: summaries[i]!, awardedAt: a.awardedAt, note: a.note }));
}

/** Drops a deleted course from site badge criteria; a badge left without courses becomes a manual one. */
export async function pruneDeletedCourse(db: DB, courseId: string) {
  const badges = await db.selectFrom('badges').selectAll().where('courseId', 'is', null).where('criteria', '=', 'courses').execute();
  for (const badge of badges) {
    const ids = criteriaCourseIds(badge);
    if (!ids.includes(courseId)) continue;
    const rest = ids.filter((id) => id !== courseId);
    await db
      .updateTable('badges')
      .set({ criteriaCourseIds: JSON.stringify(rest), ...(rest.length === 0 ? { criteria: 'manual' as const } : {}), updatedAt: now() })
      .where('id', '=', badge.id)
      .execute();
  }
}
