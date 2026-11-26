import { extname } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { FileRow, UserRow } from '../db/schema.js';
import { ApiError, badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { newId, now } from '../lib/util.js';
import { assertCan, loadActivityAccess, loadCourseAccess, type ActivityAccess } from '../services/access.js';
import { canSeeDiscussion, forumGroupView } from '../services/group-forums.js';
import { inScope, studentScope } from '../services/group-modes.js';
import { toFileInfo } from '../services/serialize.js';

/** Types browsers may render inline. Everything else (HTML, SVG, scripts...) is served as a download. */
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|video\/(mp4|webm|ogg)|audio\/[a-z0-9.+-]+|text\/plain)$/;

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

export function fileRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, storage, config } = deps;

  r.post('/', async (c) => {
    const user = requireUser(c);
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > config.maxUploadBytes + 1024 * 1024) {
      throw new ApiError(413, `Files can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`, 'too_large');
    }
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('Choose a file to upload.');
    if (file.size === 0) throw badRequest('That file is empty.');
    if (file.size > config.maxUploadBytes) {
      throw new ApiError(413, `Files can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`, 'too_large');
    }
    const meta = parse(
      z.object({
        context: z.enum(['course', 'activity', 'submission', 'avatar', 'post']).default('submission'),
        courseId: z.string().max(80).optional(),
      }),
      { context: form.context, courseId: form.courseId || undefined },
    );

    let courseId: string | null = null;
    if (meta.context !== 'avatar') {
      if (!meta.courseId) throw badRequest('courseId is required for this upload.');
      const access = await loadCourseAccess(db, user, meta.courseId);
      if (meta.context === 'activity') assertCan(access, 'course:manageContent');
      else if (meta.context === 'course') assertCan(access, 'course:update');
      else if (meta.context === 'post') assertCan(access, 'forum:post');
      else if (!access.enrolment && !access.can('course:manageContent')) throw forbidden('Enrol in the course to upload files.');
      courseId = access.course.id;
    }

    const id = newId();
    const name = safeName(file.name);
    const ext = extname(name)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '')
      .slice(0, 10);
    const day = now().slice(0, 7).replace('-', '/');
    const storageKey = `${day}/${id}${ext}`;
    const mime = (file.type || 'application/octet-stream').toLowerCase().slice(0, 120);
    await storage.put(storageKey, new Uint8Array(await file.arrayBuffer()), mime);

    const row: FileRow = {
      id,
      ownerId: user.id,
      courseId,
      context: meta.context,
      name,
      mime,
      size: file.size,
      storageKey,
      createdAt: now(),
      activityId: null,
      discussionId: null,
    };
    await db.insertInto('files').values(row).execute();
    return c.json(toFileInfo(row), 201);
  });

  /**
   * Someone else's file in a course. A file that belongs to an activity follows the activity's rules (hidden, limited
   * to groups: see services/group-modes.ts), so new activity types get them too; submitted work also needs the
   * student to be one the viewer sees in that activity, and a forum upload the discussion it was posted in.
   */
  async function canDownload(user: UserRow, file: FileRow): Promise<boolean> {
    if (!file.activityId) {
      const access = await loadCourseAccess(db, user, file.courseId!);
      return file.context === 'submission' ? access.can('grades:viewAll') : access.can('course:view') || file.context === 'course';
    }
    let access: ActivityAccess;
    try {
      access = await loadActivityAccess(db, user, file.activityId);
    } catch (err) {
      if (err instanceof ApiError) return false;
      throw err;
    }
    if (file.context === 'submission') {
      if (!access.can('grades:viewAll') || !file.ownerId) return false;
      return inScope(db, await studentScope(db, access), file.ownerId);
    }
    if (file.discussionId) {
      const discussion = await db.selectFrom('discussions').select('groupId').where('id', '=', file.discussionId).executeTakeFirst();
      return !!discussion && canSeeDiscussion(await forumGroupView(db, access), discussion.groupId);
    }
    return true;
  }

  r.get('/:fileId', async (c) => {
    const user = requireUser(c);
    const file = await db.selectFrom('files').selectAll().where('id', '=', c.req.param('fileId')).executeTakeFirst();
    if (!file) throw notFound('File');

    const isOwner = file.ownerId === user.id;
    if (!isOwner && user.role !== 'admin' && file.context !== 'avatar') {
      if (!file.courseId || !(await canDownload(user, file))) throw notFound('File');
    }

    const stream = await storage.get(file.storageKey);
    if (!stream) throw notFound('File');
    const inline = INLINE_TYPES.test(file.mime) && c.req.query('download') !== '1';
    c.header('Content-Type', inline ? file.mime : 'application/octet-stream');
    c.header('Content-Length', String(file.size));
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(stream);
  });

  return r;
}
