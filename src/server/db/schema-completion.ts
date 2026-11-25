/**
 * Tables for course completion, certificates and badges (migration 004_completion_badges).
 * Same conventions as schema.ts: 0/1 booleans, ISO-8601 strings and JSON stored as text.
 */
import type { Selectable } from 'kysely';
import type { BadgeColor, BadgeCriteria, BadgeIcon, CompletionCriteriaMode } from '../../shared/completion.js';

/** One row per course that has (ever) been configured; no row means completion tracking is off. */
export interface CourseCompletionSettingsTable {
  courseId: string;
  enabled: number;
  mode: CompletionCriteriaMode;
  /** JSON array of activity ids (required activities in `selected` mode). */
  activityIds: string;
  /** Minimum course total in percent, or null. */
  minGrade: number | null;
  certificateEnabled: number;
  certificateTitle: string;
  certificateBody: string;
  certificateSignatureName: string;
  certificateSignatureTitle: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface CourseCompletionsTable {
  courseId: string;
  userId: string;
  completedAt: string;
}

/** Issued certificates keep a snapshot of the name, course title and template, so later edits don't change them. */
export interface CertificatesTable {
  id: string;
  /** 12 upper-case Crockford base32 characters, unique. */
  code: string;
  /** null once the course is deleted; the certificate stays verifiable. */
  courseId: string | null;
  userId: string;
  recipientName: string;
  courseTitle: string;
  siteName: string;
  title: string;
  body: string;
  signatureName: string;
  signatureTitle: string;
  completedAt: string;
  issuedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface BadgesTable {
  id: string;
  /** null for site badges. */
  courseId: string | null;
  name: string;
  description: string;
  icon: BadgeIcon;
  color: BadgeColor;
  criteria: BadgeCriteria;
  /** JSON array of course ids (site badges with `courses` criteria). */
  criteriaCourseIds: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row per badge and person. Revoked awards are kept so automatic criteria don't award them again. */
export interface BadgeAwardsTable {
  badgeId: string;
  userId: string;
  awardedAt: string;
  /** null when awarded automatically. */
  awardedBy: string | null;
  note: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export type CourseCompletionSettingsRow = Selectable<CourseCompletionSettingsTable>;
export type CertificateRow = Selectable<CertificatesTable>;
export type BadgeRow = Selectable<BadgesTable>;
export type BadgeAwardRow = Selectable<BadgeAwardsTable>;
