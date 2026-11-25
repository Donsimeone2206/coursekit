import { Hono } from 'hono';
import { z } from 'zod';
import type { ActivitySettingsMap, ActivityType } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { ActivityRow } from '../db/schema.js';
import { badRequest, notFound, readBody } from '../lib/http.js';
import { isoDateSchema, markdownSchema } from '../lib/schemas.js';
import { newId, now, num } from '../lib/util.js';
import { assertCan, loadCourseAccess } from '../services/access.js';
import { activityTypes } from '../services/activity-types.js';

const DEFAULT_MAX_GRADE: Partial<Record<ActivityType, number>> = { assignment: 100, quiz: 10 };

/** Course structure: sections and the activities inside them. */
export function contentRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function manager(c: Parameters<typeof requireUser>[0]) {
    const user = requireUser(c);
    const access = await loadCourseAccess(db, user, c.req.param('courseId')!);
    assertCan(access, 'course:manageContent');
    return access;
  }

  r.post('/:courseId/sections', async (c) => {
    const access = await manager(c);
    const input = await readBody(
      c,
      z.object({
        title: z.string().trim().min(1, 'Add a title').max(200),
        summary: z.string().max(5000).default(''),
        visible: z.boolean().default(true),
      }),
    );
    const max = await db
      .selectFrom('sections')
      .select((eb) => eb.fn.max('position').as('m'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    const section = {
      id: newId(),
      courseId: access.course.id,
      title: input.title,
      summary: input.summary,
      position: max?.m == null ? 0 : num(max.m) + 1,
      visible: input.visible ? 1 : 0,
      createdAt: now(),
    };
    await db.insertInto('sections').values(section).execute();
    return c.json({ id: section.id }, 201);
  });

  r.put('/:courseId/sections/order', async (c) => {
    const access = await manager(c);
    const { ids } = await readBody(c, z.object({ ids: z.array(z.string()).min(1).max(500) }));
    await db.transaction().execute(async (trx) => {
      for (const [index, id] of ids.entries()) {
        await trx.updateTable('sections').set({ position: index }).where('id', '=', id).where('courseId', '=', access.course.id).execute();
      }
    });
    return c.json({ ok: true });
  });

  r.patch('/:courseId/sections/:sectionId', async (c) => {
    const access = await manager(c);
    const input = await readBody(
      c,
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        summary: z.string().max(5000).optional(),
        visible: z.boolean().optional(),
      }),
    );
    const { visible, ...rest } = input;
    const result = await db
      .updateTable('sections')
      .set({ ...rest, ...(visible === undefined ? {} : { visible: visible ? 1 : 0 }) })
      .where('id', '=', c.req.param('sectionId'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (num(result.numUpdatedRows) === 0) throw notFound('Section');
    return c.json({ ok: true });
  });

  r.delete('/:courseId/sections/:sectionId', async (c) => {
    const access = await manager(c);
    const count = await db
      .selectFrom('sections')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (num(count?.n) <= 1) throw badRequest('A course needs at least one section.');
    const result = await db
      .deleteFrom('sections')
      .where('id', '=', c.req.param('sectionId'))
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (num(result.numDeletedRows) === 0) throw notFound('Section');
    return c.json({ ok: true });
  });

  r.post('/:courseId/activities', async (c) => {
    const user = requireUser(c);
    const access = await manager(c);
    const input = await readBody(
      c,
      z.object({
        sectionId: z.string(),
        type: z.enum(['lesson', 'resource', 'assignment', 'quiz', 'forum']),
        title: z.string().trim().min(1, 'Add a title').max(200),
        description: markdownSchema().default(''),
        settings: z.record(z.string(), z.unknown()).default({}),
        dueAt: isoDateSchema.nullable().default(null),
        maxGrade: z.number().min(0).max(10_000).nullable().optional(),
        completion: z.enum(['none', 'manual', 'auto']).optional(),
        visible: z.boolean().default(true),
      }),
    );
    const section = await db
      .selectFrom('sections')
      .select('id')
      .where('id', '=', input.sectionId)
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!section) throw badRequest('That section does not exist in this course.');

    const def = activityTypes[input.type];
    const settingsResult = def.settings.safeParse(input.settings);
    if (!settingsResult.success) {
      const issue = settingsResult.error.issues[0];
      throw badRequest(issue ? `${issue.path.map(String).join('.')}: ${issue.message}` : 'Invalid settings');
    }
    const settings = settingsResult.data as ActivitySettingsMap[ActivityType];
    if (input.type === 'resource') {
      const s = settings as ActivitySettingsMap['resource'];
      if (s.kind === 'link' && !s.url) throw badRequest('Add the link URL.');
      if (s.kind === 'file' && !s.fileId) throw badRequest('Upload a file.');
    }

    const max = await db
      .selectFrom('activities')
      .select((eb) => eb.fn.max('position').as('m'))
      .where('sectionId', '=', section.id)
      .executeTakeFirst();
    const ts = now();
    const activity: ActivityRow = {
      id: newId(),
      courseId: access.course.id,
      sectionId: section.id,
      type: input.type,
      title: input.title,
      description: input.description,
      position: max?.m == null ? 0 : num(max.m) + 1,
      visible: input.visible ? 1 : 0,
      settings: JSON.stringify(settings),
      dueAt: input.type === 'assignment' || input.type === 'quiz' ? input.dueAt : null,
      maxGrade: def.graded ? (input.maxGrade ?? DEFAULT_MAX_GRADE[input.type] ?? 100) : null,
      completion: input.completion ?? def.defaultCompletion,
      createdBy: user.id,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.insertInto('activities').values(activity).execute();
    if (input.type === 'resource') {
      const s = settings as ActivitySettingsMap['resource'];
      if (s.fileId)
        await db.updateTable('files').set({ courseId: access.course.id, context: 'activity' }).where('id', '=', s.fileId).execute();
    }
    deps.events.emit('activity.created', { activityId: activity.id, courseId: access.course.id, type: activity.type });
    return c.json({ id: activity.id }, 201);
  });

  /** Reorder activities within a section; also used to move activities between sections. */
  r.put('/:courseId/activities/order', async (c) => {
    const access = await manager(c);
    const input = await readBody(c, z.object({ sectionId: z.string(), ids: z.array(z.string()).max(1000) }));
    const section = await db
      .selectFrom('sections')
      .select('id')
      .where('id', '=', input.sectionId)
      .where('courseId', '=', access.course.id)
      .executeTakeFirst();
    if (!section) throw notFound('Section');
    await db.transaction().execute(async (trx) => {
      for (const [index, id] of input.ids.entries()) {
        await trx
          .updateTable('activities')
          .set({ position: index, sectionId: section.id })
          .where('id', '=', id)
          .where('courseId', '=', access.course.id)
          .execute();
      }
    });
    return c.json({ ok: true });
  });

  return r;
}
