/**
 * Forums in group mode (0.3.0). A discussion belongs to a group or to all participants (group id null).
 *
 * - No groups: everyone sees and replies to every discussion, whatever group it was started in.
 * - Separate groups: people who can't access all groups see their own groups' discussions and those for all
 *   participants. Students only reply in their own groups' discussions (a reply to an all-participants discussion
 *   would be seen by every group, as in Moodle); staff may also reply to all-participants discussions.
 * - Visible groups: everyone sees every discussion; students reply in their own groups' discussions and in those for
 *   all participants.
 * Starting a discussion: teachers (`course:accessAllGroups`) post to any group or to all participants; everyone else
 * posts in one of their own groups, choosing one when they are in several.
 */
import { DELETED_GROUP_NAME } from '../../shared/group-modes.js';
import type { GroupMode, GroupRef } from '../../shared/types.js';
import type { ActivityRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { badRequest, forbidden } from '../lib/http.js';
import { num } from '../lib/util.js';
import type { ActivityAccess, CourseAccess } from './access.js';
import { accessesAllGroups, courseGroupRefs, effectiveGroupMode, userGroupIds } from './group-modes.js';

export interface ForumGroupView {
  mode: GroupMode;
  accessAll: boolean;
  /** The viewer's groups (only loaded when it matters). */
  mine: Set<string>;
}

export async function forumGroupView(db: DB, access: ActivityAccess): Promise<ForumGroupView> {
  const mode = effectiveGroupMode(access.course, access.activity);
  const accessAll = accessesAllGroups(access);
  const mine = mode === 'none' || accessAll ? new Set<string>() : await userGroupIds(db, access.course.id, access.user.id);
  return { mode, accessAll, mine };
}

export function canSeeDiscussion(view: ForumGroupView, groupId: string | null): boolean {
  if (view.mode !== 'separate' || view.accessAll || groupId == null) return true;
  return view.mine.has(groupId);
}

/** Whether the group rules let the viewer reply (capabilities, locks and archived courses are checked separately). */
export function groupLetsReply(view: ForumGroupView, groupId: string | null, moderator: boolean): boolean {
  if (view.mode === 'none' || view.accessAll) return true;
  if (groupId == null) return view.mode === 'visible' || moderator;
  return view.mine.has(groupId);
}

export function replyNote(view: ForumGroupView, groupId: string | null, groupName: string | null): string | null {
  if (view.mode === 'none' || view.accessAll) return null;
  if (groupId == null) return 'Only the teaching team can reply to discussions for all participants in this forum.';
  return `Only members of ${groupName ?? 'this group'} can reply.`;
}

/**
 * Ties the uploads a post links to (`/api/files/:id`: the author's own forum uploads that aren't tied to anything
 * yet) to its discussion, so downloading them follows the discussion's rules (see routes/files.ts).
 */
export async function linkPostFiles(
  db: DB,
  post: { body: string; userId: string; courseId: string; activityId: string; discussionId: string },
): Promise<void> {
  const ids = [...new Set([...post.body.matchAll(/\/api\/files\/([A-Za-z0-9_-]{1,40})/g)].map((m) => m[1]!))].slice(0, 200);
  if (ids.length === 0) return;
  await db
    .updateTable('files')
    .set({ activityId: post.activityId, discussionId: post.discussionId })
    .where('id', 'in', ids)
    .where('ownerId', '=', post.userId)
    .where('courseId', '=', post.courseId)
    .where('context', '=', 'post')
    .where('activityId', 'is', null)
    .execute();
}

/** Restricts a discussions query to the ones the viewer can see. */
export function visibleDiscussionsFilter(view: ForumGroupView): ((eb: any) => any) | null {
  if (view.mode !== 'separate' || view.accessAll) return null;
  const mine = [...view.mine];
  return (eb) => eb.or([eb('discussions.groupId', 'is', null), ...(mine.length ? [eb('discussions.groupId', 'in', mine)] : [])]);
}

/** Discussion and post counts per forum, counting only the discussions the viewer can see. */
export async function countDiscussions(
  db: DB,
  access: CourseAccess,
  forums: Array<Pick<ActivityRow, 'id' | 'groupMode'>>,
): Promise<Map<string, { discussions: number; posts: number }>> {
  const result = new Map<string, { discussions: number; posts: number }>();
  if (forums.length === 0) return result;
  const accessAll = accessesAllGroups(access);
  const limited = new Set(accessAll ? [] : forums.filter((f) => effectiveGroupMode(access.course, f) === 'separate').map((f) => f.id));
  const mine = limited.size ? [...(await userGroupIds(db, access.course.id, access.user.id))] : [];
  const count = (ids: string[], onlyMine: boolean) =>
    ids.length
      ? db
          .selectFrom('discussions')
          .select(['activityId', (eb) => eb.fn.countAll().as('n'), (eb) => eb.fn.sum('replyCount').as('replies')])
          .where('activityId', 'in', ids)
          .$if(onlyMine, (q) => q.where((eb) => eb.or([eb('groupId', 'is', null), ...(mine.length ? [eb('groupId', 'in', mine)] : [])])))
          .groupBy('activityId')
          .execute()
      : Promise.resolve([]);
  const rows = (
    await Promise.all([
      count(
        forums.map((f) => f.id).filter((id) => !limited.has(id)),
        false,
      ),
      count([...limited], true),
    ])
  ).flat();
  for (const f of forums) result.set(f.id, { discussions: 0, posts: 0 });
  for (const row of rows) {
    const n = num(row.n);
    result.set(row.activityId, { discussions: n, posts: n + num(row.replies) });
  }
  return result;
}

/** Group names by id for discussions; groups that were deleted are named "Deleted group". */
export async function discussionGroups(db: DB, courseId: string, groupIds: Array<string | null>): Promise<Map<string, GroupRef>> {
  const result = new Map<string, GroupRef>();
  if (!groupIds.some((id) => id)) return result;
  const names = new Map((await courseGroupRefs(db, courseId)).map((g) => [g.id, g.name]));
  for (const id of groupIds) if (id) result.set(id, { id, name: names.get(id) ?? DELETED_GROUP_NAME });
  return result;
}

/**
 * The group a new discussion goes in. Teachers choose any group or all participants (null); others must use one of
 * their own groups, and may leave it out when they are in exactly one.
 */
export async function groupForNewDiscussion(db: DB, access: ActivityAccess, requested: string | null | undefined): Promise<string | null> {
  const view = await forumGroupView(db, access);
  if (view.mode === 'none') return null;
  if (view.accessAll) {
    if (!requested) return null;
    const group = await db
      .selectFrom('courseGroups')
      .select('id')
      .where('id', '=', requested)
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!group) throw badRequest('That group is not in this course.');
    return group.id;
  }
  if (view.mine.size === 0) throw forbidden('Join a group to start a discussion in this forum.');
  if (!requested) {
    if (view.mine.size === 1) return [...view.mine][0]!;
    throw badRequest('Choose which of your groups to post in.');
  }
  if (!view.mine.has(requested)) throw forbidden('You can only start discussions in your own groups.');
  return requested;
}
