/**
 * LTI Dynamic Registration API shapes (Coursekit as the platform). Shared by the server and the web UI.
 */

/** Body of POST /api/admin/lti/registrations. */
export interface LtiRegistrationInput {
  /** The tool's registration URL (https, or http for localhost). */
  url: string;
}

/** A registration that was just started. */
export interface LtiRegistrationStarted {
  id: string;
  /** The tool's registration URL with `openid_configuration` and `registration_token` added: open it in a frame or window. */
  openUrl: string;
  expiresAt: string;
}

export type LtiRegistrationStatus = 'pending' | 'completed' | 'expired';

/** GET /api/admin/lti/registrations/:id: how a started registration is doing. */
export interface LtiRegistrationState {
  id: string;
  status: LtiRegistrationStatus;
  expiresAt: string;
  /** Set once the tool has registered. */
  toolId: string | null;
  toolName: string | null;
}

/** A tool that registered itself (GET /api/admin/lti/registrations). */
export interface LtiRegisteredTool {
  toolId: string;
  registeredAt: string;
}

/** A message type the tool asked for, and whether Coursekit uses it. */
export interface LtiRegisteredMessage {
  type: string;
  label: string | null;
  targetLinkUri: string | null;
  placements: string[];
  /** False for message types or placements Coursekit doesn't support (they are ignored). */
  used: boolean;
}

/** GET /api/admin/lti/tools/:id/registration: what a tool asked for when it registered itself, for review. */
export interface LtiToolRegistration {
  id: string;
  /** The registration URL the administrator started from. */
  url: string;
  registeredAt: string;
  /** The administrator who started it (null once their account is deleted). */
  startedBy: { id: string; name: string } | null;
  clientName: string;
  description: string | null;
  logoUri: string | null;
  clientUri: string | null;
  policyUri: string | null;
  tosUri: string | null;
  contacts: string[];
  domain: string;
  secondaryDomains: string[];
  /** Service scopes the tool asked for. */
  requestedScopes: string[];
  /** The ones Coursekit granted: requested and supported. The tool can't get any others. */
  grantedScopes: string[];
  /** Claims (personal data) the tool asked for, such as name and email. */
  requestedClaims: string[];
  messages: LtiRegisteredMessage[];
  /** Hosts of the tool's URLs that aren't on its domain or secondary domains. */
  outsideDomains: string[];
}
