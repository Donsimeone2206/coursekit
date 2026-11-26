import { Hono } from 'hono';
import { z } from 'zod';
import type { CourseGroup } from '../../shared/types.js';
import { requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import { readBody } from '../lib/http.js';
import { assertCan, assertWritable, loadCourseAccess } from '../services/access.js';
import {
  addGroupMembers,
  autoCreateGroups,
  createGroup,
  deleteGroup,
  listGroups,
  loadGroup,
  removeGroupMember,
  updateGroup,
} from '../services/groups.js';

const groupName = z.string().trim().min(1, 'Enter a name').max(100);
const description = z.string().trim().max(1000);

/** Course groups: `/api/courses/:courseId/groups`. Changing groups needs `course:manageGroups` (teachers, not assistants). */
export function groupRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function manager(c: AppContext) {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId')!);
    assertCan(access, 'course:manageGroups', 'Only teachers can change groups.');
    assertWritable(access);
    return access;
  }

  /** Every group for staff; students get only the groups they are in. */
  r.get('/:courseId/groups', async (c) => {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId'));
    assertCan(access, 'course:view', 'Enrol in this course to see its groups.');
    return c.json(await listGroups(db, access));
  });

  r.post('/:courseId/groups', async (c) => {
    const access = await manager(c);
    const input = await readBody(c, z.object({ name: groupName, description: description.default('') }));
    const group = await createGroup(deps, access.course, input);
    const result: CourseGroup = { id: group.id, name: group.name, description: group.description, createdAt: group.createdAt, members: [] };
    return c.json(result, 201);
  });

  /** Splits the active students into new groups at random, with balanced sizes. */
  r.post('/:courseId/groups/auto', async (c) => {
    const access = await manager(c);
    const input = await readBody(
      c,
      z.object({
        split: z.enum(['groups', 'members']),
        size: z.number().int().min(1, 'Use at least 1').max(1000),
        naming: z.string().trim().min(1, 'Enter a naming scheme').max(80).default('Group @'),
        onlyUngrouped: z.boolean().default(false),
      }),
    );
    const created = await autoCreateGroups(deps, access.course, input);
    return c.json({ groups: created.map(({ group, userIds }) => ({ id: group.id, name: group.name, memberCount: userIds.length })) }, 201);
  });

  r.patch('/:courseId/groups/:groupId', async (c) => {
    const access = await manager(c);
    const group = await loadGroup(db, access.course.id, c.req.param('groupId'));
    const input = await readBody(c, z.object({ name: groupName.optional(), description: description.optional() }));
    const updated = await updateGroup(deps, group, input);
    return c.json({ id: updated.id, name: updated.name, description: updated.description });
  });

  r.delete('/:courseId/groups/:groupId', async (c) => {
    const access = await manager(c);
    const group = await loadGroup(db, access.course.id, c.req.param('groupId'));
    await deleteGroup(deps, group);
    return c.json({ ok: true });
  });

  /** Adds people to a group. They must be enrolled in the course; a person can be in several groups. */
  r.post('/:courseId/groups/:groupId/members', async (c) => {
    const access = await manager(c);
    const group = await loadGroup(db, access.course.id, c.req.param('groupId'));
    const input = await readBody(
      c,
      z.object({ userIds: z.array(z.string().min(1).max(40)).min(1, 'Choose at least one person').max(500) }),
    );
    return c.json(await addGroupMembers(deps, group, input.userIds));
  });

  r.delete('/:courseId/groups/:groupId/members/:userId', async (c) => {
    const access = await manager(c);
    const group = await loadGroup(db, access.course.id, c.req.param('groupId'));
    await removeGroupMember(deps, group, c.req.param('userId'));
    return c.json({ ok: true });
  });

  return r;
}
