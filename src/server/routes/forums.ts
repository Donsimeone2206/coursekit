import { Hono } from 'hono';
import { z } from 'zod';
import type { CourseRole, Discussion, DiscussionDetail, Post } from '../../shared/types.js';
import { requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import type { DB } from '../db/types.js';
import { badRequest, forbidden, notFound, readBody } from '../lib/http.js';
import { markdownSchema } from '../lib/schemas.js';
import { excerpt, newId, now, num } from '../lib/util.js';
import { assertCan, assertWritable, loadActivityAccess } from '../services/access.js';
import { parseSettings } from '../services/activity-types.js';
import { notify } from '../services/notify.js';
import { markCompleted } from '../services/progress.js';
import { toCourseRef } from '../services/serialize.js';

const bodySchema = markdownSchema(50_000).refine((v) => v.trim().length > 0, 'Write something first');

async function refreshCounts(db: DB, discussionId: string) {
  const row = await db
    .selectFrom('posts')
    .select([(eb) => eb.fn.countAll().as('n'), (eb) => eb.fn.max('createdAt').as('last')])
    .where('discussionId', '=', discussionId)
    .executeTakeFirst();
  await db
    .updateTable('discussions')
    .set({ replyCount: Math.max(0, num(row?.n) - 1), ...(row?.last ? { lastPostAt: String(row.last) } : {}) })
    .where('id', '=', discussionId)
    .execute();
}

export function forumRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, events } = deps;

  async function forumAccess(c: AppContext, activityId: string) {
    const access = await loadActivityAccess(db, requireUser(c), activityId);
    if (access.activity.type !== 'forum') throw badRequest('This activity is not a forum.');
    return access;
  }

  async function discussionAccess(c: AppContext, discussionId: string) {
    const discussion = await db.selectFrom('discussions').selectAll().where('id', '=', discussionId).executeTakeFirst();
    if (!discussion) throw notFound('Discussion');
    const access = await forumAccess(c, discussion.activityId);
    return { discussion, access };
  }

  r.get('/activities/:activityId/discussions', async (c) => {
    const access = await forumAccess(c, c.req.param('activityId'));
    const rows = await db
      .selectFrom('discussions')
      .innerJoin('users', 'users.id', 'discussions.userId')
      .selectAll('discussions')
      .select(['users.name as userName', 'users.avatarUrl as userAvatarUrl'])
      .where('discussions.activityId', '=', access.activity.id)
      .orderBy('discussions.pinned', 'desc')
      .orderBy('discussions.lastPostAt', 'desc')
      .limit(200)
      .execute();
    const ids = rows.map((d) => d.id);
    const firstPosts = ids.length
      ? await db
          .selectFrom('posts')
          .select(['discussionId', 'body'])
          .where('discussionId', 'in', ids)
          .where('parentId', 'is', null)
          .execute()
      : [];
    const bodies = new Map(firstPosts.map((p) => [p.discussionId, p.body]));
    const items: Discussion[] = rows.map((d) => ({
      id: d.id,
      activityId: d.activityId,
      title: d.title,
      author: { id: d.userId, name: d.userName, avatarUrl: d.userAvatarUrl },
      pinned: !!d.pinned,
      locked: !!d.locked,
      createdAt: d.createdAt,
      lastPostAt: d.lastPostAt,
      replyCount: d.replyCount,
      excerpt: excerpt(bodies.get(d.id) ?? '', 180),
    }));
    return c.json(items);
  });

  r.post('/activities/:activityId/discussions', async (c) => {
    const user = requireUser(c);
    const access = await forumAccess(c, c.req.param('activityId'));
    assertCan(access, 'forum:post');
    assertWritable(access);
    const settings = parseSettings('forum', access.activity.settings);
    if (!settings.studentsCanStartDiscussions && !access.can('forum:moderate')) {
      throw forbidden('Only teachers can start discussions in this forum.');
    }
    const input = await readBody(c, z.object({ title: z.string().trim().min(1, 'Add a title').max(200), body: bodySchema }));
    const ts = now();
    const discussionId = newId();
    const postId = newId();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('discussions')
        .values({
          id: discussionId,
          activityId: access.activity.id,
          courseId: access.course.id,
          userId: user.id,
          title: input.title,
          pinned: 0,
          locked: 0,
          replyCount: 0,
          lastPostAt: ts,
          createdAt: ts,
        })
        .execute();
      await trx
        .insertInto('posts')
        .values({
          id: postId,
          discussionId,
          courseId: access.course.id,
          userId: user.id,
          parentId: null,
          body: input.body,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();
    });
    if (access.enrolment && access.activity.completion === 'auto') await markCompleted(deps, access.activity, user.id);
    events.emit('forum.post.created', { postId, discussionId, courseId: access.course.id, userId: user.id });
    return c.json({ id: discussionId }, 201);
  });

  r.get('/discussions/:discussionId', async (c) => {
    const user = requireUser(c);
    const { discussion, access } = await discussionAccess(c, c.req.param('discussionId'));
    const moderate = access.can('forum:moderate');
    const rows = await db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.userId')
      .selectAll('posts')
      .select(['users.name as userName', 'users.avatarUrl as userAvatarUrl'])
      .where('posts.discussionId', '=', discussion.id)
      .orderBy('posts.createdAt', 'asc')
      .execute();
    const roles = await db
      .selectFrom('enrolments')
      .select(['userId', 'role'])
      .where('courseId', '=', access.course.id)
      .where('userId', 'in', rows.length ? [...new Set(rows.map((p) => p.userId))] : ['-'])
      .execute();
    const roleMap = new Map<string, CourseRole>(roles.map((r) => [r.userId, r.role]));
    const author = rows.find((p) => p.parentId === null);

    const posts: Post[] = rows.map((p) => ({
      id: p.id,
      parentId: p.parentId,
      author: { id: p.userId, name: p.userName, avatarUrl: p.userAvatarUrl },
      authorRole: roleMap.get(p.userId) ?? null,
      body: p.body,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      canEdit: !access.readOnly && (p.userId === user.id || moderate),
      canDelete: !access.readOnly && (moderate || (p.userId === user.id && (p.parentId !== null || discussion.replyCount === 0))),
    }));

    const detail: DiscussionDetail = {
      id: discussion.id,
      activityId: discussion.activityId,
      title: discussion.title,
      author: author
        ? { id: author.userId, name: author.userName, avatarUrl: author.userAvatarUrl }
        : { id: discussion.userId, name: 'Unknown', avatarUrl: null },
      pinned: !!discussion.pinned,
      locked: !!discussion.locked,
      createdAt: discussion.createdAt,
      lastPostAt: discussion.lastPostAt,
      replyCount: discussion.replyCount,
      excerpt: excerpt(author?.body ?? ''),
      posts,
      canReply: access.can('forum:post') && !access.readOnly && (!discussion.locked || moderate),
      canModerate: moderate,
      course: toCourseRef(access.course),
      activityTitle: access.activity.title,
    };
    return c.json(detail);
  });

  r.patch('/discussions/:discussionId', async (c) => {
    const user = requireUser(c);
    const { discussion, access } = await discussionAccess(c, c.req.param('discussionId'));
    const input = await readBody(
      c,
      z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(), locked: z.boolean().optional() }),
    );
    const moderate = access.can('forum:moderate');
    if ((input.pinned !== undefined || input.locked !== undefined) && !moderate)
      throw forbidden('Only moderators can pin or lock discussions.');
    if (input.title !== undefined && !moderate && discussion.userId !== user.id) throw forbidden();
    await db
      .updateTable('discussions')
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned ? 1 : 0 } : {}),
        ...(input.locked !== undefined ? { locked: input.locked ? 1 : 0 } : {}),
      })
      .where('id', '=', discussion.id)
      .execute();
    return c.json({ ok: true });
  });

  r.delete('/discussions/:discussionId', async (c) => {
    const user = requireUser(c);
    const { discussion, access } = await discussionAccess(c, c.req.param('discussionId'));
    const allowed = access.can('forum:moderate') || (discussion.userId === user.id && discussion.replyCount === 0);
    if (!allowed) throw forbidden('You can only delete your own discussions before anyone replies.');
    await db.deleteFrom('discussions').where('id', '=', discussion.id).execute();
    return c.json({ ok: true });
  });

  r.post('/discussions/:discussionId/posts', async (c) => {
    const user = requireUser(c);
    const { discussion, access } = await discussionAccess(c, c.req.param('discussionId'));
    assertCan(access, 'forum:post');
    assertWritable(access);
    if (discussion.locked && !access.can('forum:moderate')) throw forbidden('This discussion is locked.');
    const input = await readBody(c, z.object({ body: bodySchema, parentId: z.string().max(40).nullable().optional() }));

    const root = await db
      .selectFrom('posts')
      .select(['id', 'userId'])
      .where('discussionId', '=', discussion.id)
      .where('parentId', 'is', null)
      .executeTakeFirst();
    let parent = root;
    if (input.parentId) {
      parent = await db
        .selectFrom('posts')
        .select(['id', 'userId'])
        .where('id', '=', input.parentId)
        .where('discussionId', '=', discussion.id)
        .executeTakeFirst();
      if (!parent) throw badRequest('The post you are replying to no longer exists.');
    }

    const ts = now();
    const post = {
      id: newId(),
      discussionId: discussion.id,
      courseId: access.course.id,
      userId: user.id,
      parentId: parent?.id ?? null,
      body: input.body,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.insertInto('posts').values(post).execute();
    await refreshCounts(db, discussion.id);

    const recipients = [discussion.userId, parent?.userId].filter((id): id is string => !!id && id !== user.id);
    await notify(db, recipients, {
      type: 'forum',
      title: `${user.name} replied in “${discussion.title}”`,
      body: excerpt(input.body, 160),
      link: `/courses/${access.course.slug}/discussions/${discussion.id}`,
    });
    if (access.enrolment && access.activity.completion === 'auto') await markCompleted(deps, access.activity, user.id);
    events.emit('forum.post.created', { postId: post.id, discussionId: discussion.id, courseId: access.course.id, userId: user.id });
    return c.json({ id: post.id }, 201);
  });

  async function postAccess(c: AppContext) {
    const user = requireUser(c);
    const post = await db.selectFrom('posts').selectAll().where('id', '=', c.req.param('postId')!).executeTakeFirst();
    if (!post) throw notFound('Post');
    const { discussion, access } = await discussionAccess(c, post.discussionId);
    return { user, post, discussion, access };
  }

  r.patch('/posts/:postId', async (c) => {
    const { user, post, access } = await postAccess(c);
    assertWritable(access);
    if (post.userId !== user.id && !access.can('forum:moderate')) throw forbidden('You can only edit your own posts.');
    const input = await readBody(c, z.object({ body: bodySchema }));
    await db.updateTable('posts').set({ body: input.body, updatedAt: now() }).where('id', '=', post.id).execute();
    return c.json({ ok: true });
  });

  r.delete('/posts/:postId', async (c) => {
    const { user, post, discussion, access } = await postAccess(c);
    const moderate = access.can('forum:moderate');
    if (post.parentId === null) {
      if (!moderate && !(post.userId === user.id && discussion.replyCount === 0)) {
        throw forbidden('Only moderators can delete a discussion that has replies.');
      }
      await db.deleteFrom('discussions').where('id', '=', discussion.id).execute();
      return c.json({ ok: true, discussionDeleted: true });
    }
    if (post.userId !== user.id && !moderate) throw forbidden('You can only delete your own posts.');
    await db.deleteFrom('posts').where('id', '=', post.id).execute();
    await refreshCounts(db, discussion.id);
    return c.json({ ok: true, discussionDeleted: false });
  });

  return r;
}
