/**
 * Tables for Open Badges export (migration 011_open_badges). Same conventions as schema.ts.
 */
import type { Selectable } from 'kysely';

/** A badge its recipient made public. The award itself stays in badge_awards; this row only holds the public identity. */
export interface OpenBadgeSharesTable {
  /** Random UUID: the public assertion and credential id. */
  id: string;
  /** null once the badge is deleted (the public documents then answer "revoked"). */
  badgeId: string | null;
  /** null once the recipient's account is deleted. */
  userId: string | null;
  /**
   * badge_awards.awarded_at of the awarding this share was made for. Restoring a revoked award sets a new
   * awarded_at, which ends the shares made before for good (the recipient can share the badge again).
   */
  awardedAt: string;
  /** Salt for the hashed recipient email (hex). */
  salt: string;
  /** Random UUID used as the Open Badges 3.0 credential subject id, so credentials can't be linked to each other. */
  subjectId: string;
  /** Position in the revocation status list (0-131071), unique. */
  statusIndex: number;
  createdAt: string;
  /** Set when the recipient stops sharing. */
  withdrawnAt: string | null;
}

export type OpenBadgeShareRow = Selectable<OpenBadgeSharesTable>;
