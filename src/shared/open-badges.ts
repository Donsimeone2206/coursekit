/**
 * Open Badges export: API shapes shared by the server and the web UI.
 *
 * A recipient can share a badge they earned. Sharing publishes an Open Badges 2.0 hosted assertion and an
 * Open Badges 3.0 credential under /openbadges/ (and a public verification page); nothing about an award is
 * public before that.
 */
import type { BadgeColor, BadgeIcon } from './completion.js';

/** Where a shared badge can be found. All absolute URLs on the site's public address. */
export interface BadgeShareLinks {
  /** Open Badges 2.0 hosted assertion: the link to import into a backpack. */
  assertion: string;
  /** The public verification page. */
  page: string;
  /** Open Badges 2.0 badge image with the assertion baked in (SVG). */
  badgeImage: string;
  /** Open Badges 3.0 credential (VC-JWT). */
  credential: string;
  /** Open Badges 3.0 badge image with the credential baked in (SVG). */
  credentialImage: string;
}

export interface BadgeShare {
  id: string;
  sharedAt: string;
  links: BadgeShareLinks;
}

/** The signed-in person's sharing status for one badge. */
export interface BadgeShareStatus {
  /** They hold the badge (not revoked), so they may share it. */
  earned: boolean;
  /** Why sharing isn't possible on this site (no public URL), or null when it is. */
  unavailableReason: string | null;
  /** The current share, or null when the badge isn't shared. */
  share: BadgeShare | null;
}

/** One of the signed-in person's shared badges (profile). */
export interface MyBadgeShare {
  badgeId: string;
  share: BadgeShare;
}

/** What the public verification page shows. Details are only given while the share is valid. */
export interface SharedBadgeVerification {
  id: string;
  status: 'valid' | 'revoked';
  /** Why it is no longer valid (withdrawn by the recipient, revoked, deleted). */
  revocationReason: string | null;
  issuer: { name: string; url: string };
  badge: {
    name: string;
    description: string;
    icon: BadgeIcon;
    color: BadgeColor;
    /** How the badge is earned, in words. */
    criteria: string;
    /** Course title for course badges. */
    course: string | null;
  } | null;
  recipientName: string | null;
  issuedOn: string | null;
  note: string | null;
  links: Pick<BadgeShareLinks, 'assertion' | 'credential'> | null;
}

/** The issuer details published in Open Badges. Empty strings fall back to the defaults. */
export interface OpenBadgesIssuerSettings {
  name: string;
  email: string;
  description: string;
}

export interface OpenBadgesAdminInfo {
  settings: OpenBadgesIssuerSettings;
  /** Used when a setting is empty: the site name, and the address outgoing email is sent from (if any). */
  defaults: { name: string; email: string | null };
  /** The site's public URL, or null when it isn't configured (sharing is then unavailable). */
  publicUrl: string | null;
  /** The Open Badges 2.0 issuer profile URL. */
  issuerUrl: string | null;
  /** Badges shared right now. */
  activeShares: number;
}

export const OPEN_BADGES_UNAVAILABLE =
  'Sharing badges needs the site’s public address. An administrator can set it with COURSEKIT_PUBLIC_URL (for example https://learn.example.org).';
