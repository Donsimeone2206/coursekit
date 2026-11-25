import {
  DEFAULT_CERTIFICATE,
  formatCertificateCode,
  type Certificate,
  type CertificateRef,
  type CertificateSummary,
  type CertificateVerification,
} from '../../shared/completion.js';
import type { PublicUser } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import type { CertificateRow, CourseCompletionSettingsRow } from '../db/schema-completion.js';
import type { CourseRow } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { toCourseRef, toPublicUser } from './serialize.js';
import { getSiteSettings } from './settings.js';

/** 12 random Crockford base32 characters (60 bits): short enough to type, too many to guess. */
export function newCertificateCode(): string {
  return newId(12).toUpperCase();
}

export function toCertificateRef(row: Pick<CertificateRow, 'id' | 'code' | 'revokedAt'>): CertificateRef {
  return { id: row.id, code: formatCertificateCode(row.code), revoked: !!row.revokedAt };
}

/**
 * Issues certificates for people who completed `course`, with a snapshot of their name, the course
 * title and the current template. At most one certificate per person and course: existing ones are
 * left alone (including revoked ones). Returns the certificates that were created.
 */
export async function issueCertificates(
  db: DB,
  course: CourseRow,
  settings: CourseCompletionSettingsRow,
  recipients: Array<{ userId: string; completedAt: string }>,
  issuedAt: string,
): Promise<CertificateRow[]> {
  if (recipients.length === 0) return [];
  const site = await getSiteSettings(db);
  const names = new Map<string, string>();
  for (let i = 0; i < recipients.length; i += 500) {
    const users = await db
      .selectFrom('users')
      .select(['id', 'name'])
      .where(
        'id',
        'in',
        recipients.slice(i, i + 500).map((r) => r.userId),
      )
      .execute();
    for (const u of users) names.set(u.id, u.name);
  }
  const rows: CertificateRow[] = recipients
    .filter((r) => names.has(r.userId))
    .map((r) => ({
      id: newId(),
      code: newCertificateCode(),
      courseId: course.id,
      userId: r.userId,
      recipientName: names.get(r.userId)!,
      courseTitle: course.title,
      siteName: site.name,
      title: settings.certificateTitle.trim() || DEFAULT_CERTIFICATE.title,
      body: settings.certificateBody.trim() || DEFAULT_CERTIFICATE.body,
      signatureName: settings.certificateSignatureName,
      signatureTitle: settings.certificateSignatureTitle,
      completedAt: r.completedAt,
      issuedAt,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    }));
  const created = new Set<string>();
  for (let i = 0; i < rows.length; i += 50) {
    const inserted = await db
      .insertInto('certificates')
      .values(rows.slice(i, i + 50))
      .onConflict((oc) => oc.columns(['courseId', 'userId']).doNothing())
      .returning('id')
      .execute();
    for (const row of inserted) created.add(row.id);
  }
  return rows.filter((r) => created.has(r.id));
}

/** Certificates for everyone who completed the course before certificates were turned on. */
export async function issueMissingCertificates(db: DB, course: CourseRow, settings: CourseCompletionSettingsRow, issuedAt: string) {
  const missing = await db
    .selectFrom('courseCompletions')
    .leftJoin('certificates', (join) =>
      join.onRef('certificates.courseId', '=', 'courseCompletions.courseId').onRef('certificates.userId', '=', 'courseCompletions.userId'),
    )
    .select(['courseCompletions.userId', 'courseCompletions.completedAt'])
    .where('courseCompletions.courseId', '=', course.id)
    .where('certificates.id', 'is', null)
    .execute();
  return issueCertificates(db, course, settings, missing, issuedAt);
}

export function toCertificateSummary(row: CertificateRow, course: CourseRow | null | undefined, recipient: PublicUser): CertificateSummary {
  return {
    id: row.id,
    code: formatCertificateCode(row.code),
    course: course ? toCourseRef(course) : null,
    courseTitle: row.courseTitle,
    recipient,
    recipientName: row.recipientName,
    completedAt: row.completedAt,
    issuedAt: row.issuedAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
  };
}

export function toCertificate(
  row: CertificateRow,
  course: CourseRow | null | undefined,
  recipient: PublicUser,
  canManage: boolean,
): Certificate {
  return {
    ...toCertificateSummary(row, course, recipient),
    title: row.title,
    body: row.body,
    signatureName: row.signatureName,
    signatureTitle: row.signatureTitle,
    siteName: row.siteName,
    canManage,
  };
}

/** The public view of a certificate: name, course, date and validity, nothing else. */
export function toVerification(row: CertificateRow): CertificateVerification {
  return {
    code: formatCertificateCode(row.code),
    valid: !row.revokedAt,
    status: row.revokedAt ? 'revoked' : 'valid',
    recipientName: row.recipientName,
    courseTitle: row.courseTitle,
    completedAt: row.completedAt,
  };
}

/** Certificates with their courses and recipients, loaded without a query per certificate. */
export async function summarizeCertificates(db: DB, rows: CertificateRow[]): Promise<CertificateSummary[]> {
  if (rows.length === 0) return [];
  const courseIds = [...new Set(rows.map((r) => r.courseId).filter((id): id is string => !!id))];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [courses, users] = await Promise.all([
    courseIds.length ? db.selectFrom('courses').selectAll().where('id', 'in', courseIds).execute() : Promise.resolve([]),
    db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', 'in', userIds).execute(),
  ]);
  const courseMap = new Map(courses.map((c) => [c.id, c]));
  const userMap = new Map(users.map((u) => [u.id, toPublicUser(u)]));
  return rows.map((row) =>
    toCertificateSummary(
      row,
      row.courseId ? courseMap.get(row.courseId) : null,
      userMap.get(row.userId) ?? { id: row.userId, name: row.recipientName, avatarUrl: null },
    ),
  );
}
