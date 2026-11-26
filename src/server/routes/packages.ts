import { Hono } from 'hono';
import { z } from 'zod';
import { PACKAGE_NAV_REQUESTS } from '../../shared/package-sequencing.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import { ApiError, badRequest, notFound, readBody } from '../lib/http.js';
import { assertCan, assertWritable, loadActivityAccess } from '../services/access.js';
import { studentScope } from '../services/group-modes.js';
import type { Cmi5LaunchInput } from '../packages/cmi5/launch.js';
import { importPackage, launch, packageReport, playerInfo, toVersionInfo } from '../packages/service.js';
import { PackageError } from '../packages/zip.js';

/** SCORM and xAPI package activities: /api/packages/:activityId/... */
export function packageRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function packageAccess(c: Parameters<typeof requireUser>[0]) {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId')!);
    if (access.activity.type !== 'package') throw badRequest('This activity is not a SCORM or xAPI package.');
    return access;
  }

  r.get('/packages/:activityId', async (c) => {
    const access = await packageAccess(c);
    return c.json(await playerInfo(deps, access));
  });

  /** Imports a zip uploaded with POST /api/files (context "activity") as the package's new version. */
  r.post('/packages/:activityId/import', async (c) => {
    const user = requireUser(c);
    const access = await packageAccess(c);
    assertCan(access, 'course:manageContent');
    assertWritable(access);
    const { fileId } = await readBody(c, z.object({ fileId: z.string().min(1).max(64) }));
    const file = await db.selectFrom('files').selectAll().where('id', '=', fileId).executeTakeFirst();
    if (!file || file.ownerId !== user.id || file.courseId !== access.course.id || file.context !== 'activity') throw notFound('File');
    const stream = await deps.storage.get(file.storageKey);
    if (!stream) throw notFound('File');
    const zip = new Uint8Array(await new Response(stream).arrayBuffer());
    try {
      const version = await importPackage(deps, access.activity, user, zip, file.name);
      return c.json(toVersionInfo(version), 201);
    } catch (err) {
      if (err instanceof PackageError) throw new ApiError(422, err.message, 'invalid_package');
      throw err;
    } finally {
      // The zip itself isn't kept: its files now live under the package version.
      await db.deleteFrom('files').where('id', '=', file.id).execute();
      await deps.storage.delete(file.storageKey).catch(() => {});
    }
  });

  r.post('/packages/:activityId/launch', async (c) => {
    const access = await packageAccess(c);
    const input = await readBody(
      c,
      z.object({
        itemId: z.string().max(500).optional(),
        attemptId: z.string().max(64).optional(),
        newAttempt: z.boolean().optional(),
        preview: z.boolean().optional(),
        // SCORM 2004 navigation requests (see src/shared/package-sequencing.ts).
        nav: z.enum(PACKAGE_NAV_REQUESTS).optional(),
        sid: z.string().max(64).optional(),
        deliveryId: z.string().max(32).nullable().optional(),
      }),
    );
    // cmi5 courses: the learner's languages go into the cmi5LearnerPreferences document (cmi5/launch.ts).
    const body: Cmi5LaunchInput = { ...input, languages: c.req.header('accept-language')?.slice(0, 500) ?? null };
    return c.json(await launch(deps, access, body, new URL(c.req.url).origin));
  });

  r.get('/packages/:activityId/report', async (c) => {
    const access = await packageAccess(c);
    assertCan(access, 'grades:viewAll');
    // Separate groups: teaching assistants only see the students of their own groups.
    const scope = await studentScope(db, access, c.req.query('groupId'));
    return c.json(await packageReport(db, access, scope));
  });

  return r;
}
