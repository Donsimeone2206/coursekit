/**
 * Tables for LTI 1.3 (migration 007_lti). Same conventions as schema.ts: 0/1 booleans,
 * ISO-8601 strings and JSON stored as text.
 */
import type { Selectable } from 'kysely';

export interface LtiToolsTable {
  id: string;
  name: string;
  description: string;
  /** The default target_link_uri. */
  toolUrl: string;
  /** OIDC login initiation URL. */
  loginUrl: string;
  /** JSON array of redirect URIs, matched exactly. */
  redirectUris: string;
  jwksUrl: string | null;
  /** PEM or JWK (JSON), used when there is no JWKS URL. */
  publicKey: string | null;
  deepLinkingUrl: string | null;
  /** JSON object of custom parameters. */
  customParams: string;
  shareName: number;
  shareEmail: number;
  allowAgs: number;
  allowNrps: number;
  clientId: string;
  deploymentId: string;
  status: 'active' | 'disabled';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LtiLineItemsTable {
  id: string;
  toolId: string;
  courseId: string;
  resourceLinkId: string | null;
  label: string;
  scoreMaximum: number;
  resourceId: string | null;
  tag: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LtiScoresTable {
  /** An lti_line_items id, or the activity id for an activity's gradebook line item. */
  lineItemId: string;
  userId: string;
  courseId: string;
  toolId: string;
  /** Set for the gradebook line item of an External tool activity. */
  activityId: string | null;
  scoreGiven: number | null;
  scoreMaximum: number | null;
  comment: string | null;
  activityProgress: string;
  gradingProgress: string;
  /** The tool's timestamp of the score. Older scores than this are ignored. */
  scoreTimestamp: string;
  updatedAt: string;
}

export interface LtiAccessTokensTable {
  /** SHA-256 of the token. */
  id: string;
  toolId: string;
  /** JSON array of scopes. */
  scopes: string;
  expiresAt: string;
  createdAt: string;
}

export interface LtiUsedTokensTable {
  key: string;
  expiresAt: string;
}

export type LtiToolRow = Selectable<LtiToolsTable>;
export type LtiLineItemRow = Selectable<LtiLineItemsTable>;
export type LtiScoreRow = Selectable<LtiScoresTable>;
