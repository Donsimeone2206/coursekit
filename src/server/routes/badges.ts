import { Hono } from 'hono';
import { z } from 'zod';
import { BADGE_COLORS, BADGE_ICONS, type BadgeDetail } from '../../shared/completion.js';
import { requireAdmin, requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import type { BadgeRow } from '../db/schema-completion.js';
import type { UserRow } from '../db/schema.js';
import { badRequest, forbidden, notFound, readBody, readQuery } from '../lib/http.js';
import { newId, now, num } from '../lib/util.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import {
  announceAwards,
  awardQualifyingUsers,
  badgeRecipients,
  criteriaCourseIds,
  earnedBadges,
  insertAwards,
  summarizeBadges,
} from '../services/badges.js';

const fields = {
  name: z.string().trim().min(1, 'Give the badge a name').max(80),
  description: z.string().trim().max(500),
  icon: z.enum(BADGE_ICONS),
  color: z.enum(BADGE_COLORS),
  criteria: z.enum(['manual', 'completion', 'courses']),
  courseIds: z.array(z.string().max(40)).max(50),
};

const createSchema = z.object({
  name: fields.name,
  description: fields.description.default(''),
  icon: fields.icon.default('award'),
  color: fields.color.default('gold'),
  criteria: fields.criteria.default('manual'),
  courseIds: fields.courseIds.default([]),
});

const updateSchema = z.object(fields).partial();

const awardSchema = z.object({
  userIds: z.array(z.string().max(40)).min(1, 'Choose at least one person').max(500),
  note: z.string().trim().max(300).nullable().optional(),
});

/** Course badges (made by teachers) and site badges (made by administrators), and awarding them. */
export function badgeRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, events } = deps;

  async function existingCourseIds(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await db.selectFrom('courses').select('id').where('id', 'in', unique).execute();
    if (found.length !== unique.length) throw badRequest('One of the chosen courses does not exist.');
    return unique;
  }

  async function detail(badge: BadgeRow, user: UserRow, canManage: boolean, canAward: boolean): Promise<BadgeDetail> {
    const staff = canManage || canAward;
    const [[summary], own, recipients] = await Promise.all([
      summarizeBadges(db, [badge], { earnedBy: user.id, countRecipients: staff }),
      db
        .selectFrom('badgeAwards')
        .select('note')
        .where('badgeId', '=', badge.id)
        .where('userId', '=', user.id)
        .where('revokedAt', 'is', null)
        .executeTakeFirst(),
      staff ? badgeRecipients(db, badge.id, true) : Promise.resolve(null),
    ]);
    return { ...summary!, earnedNote: own?.note ?? null, canManage, canAward, recipients };
  }

  /** Course badges are visible in their course (and to people who earned them); site badges to everyone. */
  async function loadBadge(c: AppContext) {
    const user = requireUser(c);
    const badge = await db.selectFrom('badges').selectAll().where('id', '=', c.req.param('badgeId')!).executeTakeFirst();
    if (!badge) throw notFound('Badge');
    let canView = true;
    let canManage = user.role === 'admin';
    let canAward = canManage;
    if (badge.courseId) {
      const access = await loadCourseAccess(db, user, badge.courseId).catch(() => null);
      canView = !!access?.can('course:view');
      canManage = !!access?.can('badges:manage') && !access.readOnly;
      canAward = !!access?.can('badges:award') && !access.readOnly;
    }
    if (!canView) {
      const own = await db
        .selectFrom('badgeAwards')
        .select('userId')
        .where('badgeId', '=', badge.id)
        .where('userId', '=', user.id)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (!own) throw notFound('Badge');
    }
    return { user, badge, canManage, canAward };
  }

  async function createBadge(user: UserRow, courseId: string | null, input: z.output<typeof createSchema>) {
    const ts = now();
    const badge: BadgeRow = {
      id: newId(),
      courseId,
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      criteria: input.criteria,
      criteriaCourseIds: JSON.stringify(input.criteria === 'courses' ? await existingCourseIds(input.courseIds) : []),
      createdBy: user.id,
      createdAt: ts,
      updatedAt: ts,
    };
    if (badge.criteria === 'courses' && criteriaCourseIds(badge).length === 0) throw badRequest('Choose at least one course to complete.');
    await db.insertInto('badges').values(badge).execute();
    if (badge.criteria !== 'manual') await announceAwards(deps, [{ badge, userIds: await awardQualifyingUsers(db, badge) }], null);
    return detail(badge, user, true, true);
  }

  r.get('/courses/:courseId/badges', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:view');
    const q = readQuery(c, z.object({ for: z.string().max(40).optional() }));
    const staff = access.can('badges:award') || access.can('badges:manage');
    // Staff can ask which badges a participant has (the participants list does).
    if (q.for && q.for !== user.id && !staff) throw forbidden();
    const badges = await db.selectFrom('badges').selectAll().where('courseId', '=', access.course.id).orderBy('createdAt', 'asc').execute();
    return c.json(await summarizeBadges(db, badges, { earnedBy: q.for ?? user.id, countRecipients: staff }));
  });

  r.post('/courses/:courseId/badges', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'badges:manage');
    assertWritable(access);
    const input = await readBody(c, createSchema);
    if (input.criteria === 'courses') throw badRequest('Course badges are awarded by teachers or on completing this course.');
    return c.json(await createBadge(user, access.course.id, input), 201);
  });

  /** Site badges, for administrators. */
  r.get('/badges', async (c) => {
    const user = requireAdmin(c);
    const badges = await db.selectFrom('badges').selectAll().where('courseId', 'is', null).orderBy('createdAt', 'asc').execute();
    return c.json(await summarizeBadges(db, badges, { earnedBy: user.id, countRecipients: true }));
  });

  r.post('/badges', async (c) => {
    const user = requireAdmin(c);
    const input = await readBody(c, createSchema);
    if (input.criteria === 'completion') throw badRequest('Site badges are awarded by administrators or on completing a set of courses.');
    return c.json(await createBadge(user, null, input), 201);
  });

  r.get('/me/badges', async (c) => {
    const user = requireUser(c);
    return c.json(await earnedBadges(db, user.id));
  });

  r.get('/badges/:badgeId', async (c) => {
    const { user, badge, canManage, canAward } = await loadBadge(c);
    return c.json(await detail(badge, user, canManage, canAward));
  });

  r.patch('/badges/:badgeId', async (c) => {
    const { user, badge, canManage, canAward } = await loadBadge(c);
    if (!canManage) throw forbidden(badge.courseId ? 'Only teachers can edit course badges.' : 'Only administrators can edit site badges.');
    const input = await readBody(c, updateSchema);
    const criteria = input.criteria ?? badge.criteria;
    if (badge.courseId && criteria === 'courses') throw badRequest('Course badges are awarded by teachers or on completing this course.');
    if (!badge.courseId && criteria === 'completion') {
      throw badRequest('Site badges are awarded by administrators or on completing a set of courses.');
    }
    let courseIds: string[] = [];
    if (criteria === 'courses') {
      courseIds = input.courseIds !== undefined ? await existingCourseIds(input.courseIds) : criteriaCourseIds(badge);
      if (courseIds.length === 0) throw badRequest('Choose at least one course to complete.');
    }
    const update = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      criteria,
      criteriaCourseIds: JSON.stringify(courseIds),
      updatedAt: now(),
    };
    await db.updateTable('badges').set(update).where('id', '=', badge.id).execute();
    const updated: BadgeRow = { ...badge, ...update };
    // Changing to (or editing) an automatic criterion awards everyone who already qualifies.
    if (criteria !== 'manual') await announceAwards(deps, [{ badge: updated, userIds: await awardQualifyingUsers(db, updated) }], null);
    return c.json(await detail(updated, user, canManage, canAward));
  });

  r.delete('/badges/:badgeId', async (c) => {
    const { badge, canManage } = await loadBadge(c);
    if (!canManage)
      throw forbidden(badge.courseId ? 'Only teachers can delete course badges.' : 'Only administrators can delete site badges.');
    await db.deleteFrom('badges').where('id', '=', badge.id).execute();
    return c.json({ ok: true });
  });

  /** Award manually (also brings back a revoked award). Course badges go to the course's participants. */
  r.post('/badges/:badgeId/awards', async (c) => {
    const { user, badge, canAward } = await loadBadge(c);
    if (!canAward) throw forbidden("You can't award this badge.");
    const input = await readBody(c, awardSchema);
    const ids = [...new Set(input.userIds)];
    const eligible = badge.courseId
      ? await db
          .selectFrom('enrolments')
          .select('userId')
          .where('courseId', '=', badge.courseId)
          .where('status', '=', 'active')
          .where('userId', 'in', ids)
          .execute()
      : await db.selectFrom('users').select('id as userId').where('status', '=', 'active').where('id', 'in', ids).execute();
    if (eligible.length !== ids.length) {
      throw badRequest(badge.courseId ? 'Badges can only go to people enrolled in this course.' : 'Some of these accounts do not exist.');
    }
    const awarded = await insertAwards(db, badge, ids, { awardedBy: user.id, note: input.note, restoreRevoked: true });
    await announceAwards(deps, [{ badge, userIds: awarded }], user.id);
    return c.json({ awarded: awarded.length, alreadyAwarded: ids.length - awarded.length });
  });

  r.delete('/badges/:badgeId/awards/:userId', async (c) => {
    const { user, badge, canAward } = await loadBadge(c);
    if (!canAward) throw forbidden("You can't revoke this badge.");
    const userId = c.req.param('userId');
    const award = await db
      .selectFrom('badgeAwards')
      .select('revokedAt')
      .where('badgeId', '=', badge.id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!award) throw notFound('Award');
    if (!award.revokedAt) {
      const result = await db
        .updateTable('badgeAwards')
        .set({ revokedAt: now(), revokedBy: user.id })
        .where('badgeId', '=', badge.id)
        .where('userId', '=', userId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (num(result.numUpdatedRows) > 0)
        events.emit('badge.revoked', { badgeId: badge.id, courseId: badge.courseId, userId, revokedBy: user.id });
    }
    return c.json({ ok: true });
  });

  return r;
}
