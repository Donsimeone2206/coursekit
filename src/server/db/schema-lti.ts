/**
 * Tables for LTI 1.3 (migration 007_lti, and 014_lti_registration for Dynamic Registration). Same
 * conventions as schema.ts: 0/1 booleans, ISO-8601 strings and JSON stored as text.
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
  /**
   * JSON array of the service scopes the tool may be granted (Dynamic Registration: the ones it asked for that
   * Coursekit supports), within the services allowed by allowAgs and allowNrps. Null: every scope of those services.
   */
  scopes: string | null;
  /**
   * JSON array of the domains a tool that registered itself declared (domain and secondary domains): launch URLs
   * and selected content may be on them too. Null: only the tool URL's host (tools added by hand).
   */
  domains: string | null;
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

/** A Dynamic Registration an administrator started (014_lti_registration). */
export interface LtiRegistrationsTable {
  id: string;
  /** SHA-256 of the registration token; the token itself is never stored. */
  tokenHash: string;
  /** The tool's registration (initiation) URL the administrator pasted. */
  url: string;
  /** The administrator the token is bound to. */
  createdBy: string | null;
  status: 'pending' | 'completed';
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  /** The tool the registration created. */
  toolId: string | null;
  /** JSON: what the tool asked for, as recorded (see services/lti/registration.ts). */
  metadata: string | null;
}

export type LtiToolRow = Selectable<LtiToolsTable>;
export type LtiRegistrationRow = Selectable<LtiRegistrationsTable>;
export type LtiLineItemRow = Selectable<LtiLineItemsTable>;
export type LtiScoreRow = Selectable<LtiScoresTable>;
