import { Hono } from 'hono';
import { z } from 'zod';
import { normalizeCertificateCode } from '../../shared/completion.js';
import { requireUser, type AppContext, type AppDeps, type AppEnv } from '../context.js';
import { forbidden, notFound, readBody } from '../lib/http.js';
import { now } from '../lib/util.js';
import { loadCourseAccess } from '../services/access.js';
import { summarizeCertificates, toCertificate, toVerification } from '../services/certificates.js';
import { toPublicUser } from '../services/serialize.js';

export function certificateRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, events } = deps;

  /** Public, no sign-in: shows only the name, course, date and whether the certificate is valid. */
  r.get('/certificates/verify/:code', async (c) => {
    const code = normalizeCertificateCode(c.req.param('code'));
    const row = code ? await db.selectFrom('certificates').selectAll().where('code', '=', code).executeTakeFirst() : undefined;
    if (!row) throw notFound('Certificate');
    return c.json(toVerification(row));
  });

  r.get('/me/certificates', async (c) => {
    const user = requireUser(c);
    const rows = await db
      .selectFrom('certificates')
      .selectAll()
      .where('userId', '=', user.id)
      .orderBy('completedAt', 'desc')
      .orderBy('courseTitle', 'asc')
      .execute();
    return c.json(await summarizeCertificates(db, rows));
  });

  /** The owner, the course's staff and administrators may see a certificate; teachers may revoke it. */
  async function loadCertificate(c: AppContext) {
    const user = requireUser(c);
    const row = await db.selectFrom('certificates').selectAll().where('id', '=', c.req.param('id')!).executeTakeFirst();
    if (!row) throw notFound('Certificate');
    const course = row.courseId ? await db.selectFrom('courses').selectAll().where('id', '=', row.courseId).executeTakeFirst() : undefined;
    let canView = row.userId === user.id || user.role === 'admin';
    let canManage = user.role === 'admin';
    if (course && !canManage) {
      const access = await loadCourseAccess(db, user, course.id).catch(() => null);
      if (access) {
        canView ||= access.can('completion:viewReport');
        canManage = access.can('completion:manage') && !access.readOnly;
      }
    }
    if (!canView) throw notFound('Certificate');
    const owner = await db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', '=', row.userId).executeTakeFirst();
    const recipient = owner ? toPublicUser(owner) : { id: row.userId, name: row.recipientName, avatarUrl: null };
    return { user, row, course, recipient, canManage };
  }

  r.get('/certificates/:id', async (c) => {
    const { row, course, recipient, canManage } = await loadCertificate(c);
    return c.json(toCertificate(row, course, recipient, canManage));
  });

  r.post('/certificates/:id/revoke', async (c) => {
    const { user, row, course, recipient, canManage } = await loadCertificate(c);
    if (!canManage) throw forbidden('Only teachers can revoke certificates.');
    const input = await readBody(c, z.object({ reason: z.string().trim().max(300).nullable().optional() }));
    if (row.revokedAt) return c.json(toCertificate(row, course, recipient, canManage));
    const update = { revokedAt: now(), revokedBy: user.id, revokeReason: input.reason || null };
    await db.updateTable('certificates').set(update).where('id', '=', row.id).where('revokedAt', 'is', null).execute();
    events.emit('certificate.revoked', { certificateId: row.id, courseId: row.courseId, userId: row.userId, revokedBy: user.id });
    return c.json(toCertificate({ ...row, ...update }, course, recipient, canManage));
  });

  r.post('/certificates/:id/restore', async (c) => {
    const { row, course, recipient, canManage } = await loadCertificate(c);
    if (!canManage) throw forbidden('Only teachers can restore certificates.');
    const update = { revokedAt: null, revokedBy: null, revokeReason: null };
    await db.updateTable('certificates').set(update).where('id', '=', row.id).execute();
    return c.json(toCertificate({ ...row, ...update }, course, recipient, canManage));
  });

  return r;
}
