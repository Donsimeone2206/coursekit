/**
 * Platform URLs, the custom parameter schema, and the checks an External tool activity's settings need
 * beyond their Zod schema.
 * (Kept free of activity-types.ts imports: the activity type registry imports this file.)
 */
import { z } from 'zod';
import type { LtiPlatformDetails } from '../../../shared/lti.js';
import type { LtiSettings } from '../../../shared/types.js';
import type { ResolvedConfig } from '../../config.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';

/** Custom parameter names: letters, digits and underscores. */
export const LTI_CUSTOM_KEY = /^[A-Za-z0-9_]{1,100}$/;

/** Custom parameters of a tool or an External tool activity. */
export const ltiCustomParamsSchema = z
  .record(z.string().regex(LTI_CUSTOM_KEY), z.string().max(1000), {
    // Without this, zod reports a bad name only as "Invalid key in record".
    error: (issue) => (issue.code === 'invalid_key' ? 'Custom parameter names use letters, digits and underscores' : undefined),
  })
  .refine((o) => Object.keys(o).length <= 50, 'Use at most 50 custom parameters');

export const LTI_NOT_CONFIGURED =
  "External tools need the site's public address. Set COURSEKIT_PUBLIC_URL (or the publicUrl option) to the URL people use to reach Coursekit, such as https://lms.example.edu, and restart Coursekit.";

/** The platform issuer (iss): the public URL without a trailing slash, or null when it isn't set. */
export function ltiIssuer(config: Pick<ResolvedConfig, 'publicUrl'>): string | null {
  const url = config.publicUrl?.trim().replace(/\/+$/, '');
  return url ? url : null;
}

export function platformDetails(config: Pick<ResolvedConfig, 'publicUrl'>): LtiPlatformDetails {
  const iss = ltiIssuer(config);
  return {
    configured: !!iss,
    issuer: iss,
    authUrl: iss && `${iss}/lti/auth`,
    tokenUrl: iss && `${iss}/lti/token`,
    jwksUrl: iss && `${iss}/lti/jwks`,
    deepLinkReturnUrl: iss && `${iss}/lti/deep-link/return`,
  };
}

/** True when `url` is on the tool's host or one of its subdomains. */
export function isOnToolDomain(url: string, toolUrl: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const toolHost = new URL(toolUrl).hostname.toLowerCase();
    return host === toolHost || host.endsWith(`.${toolHost}`);
  } catch {
    return false;
  }
}

export async function validateLtiSettings(db: DB, _courseId: string, settings: LtiSettings): Promise<void> {
  if (!settings.toolId) throw badRequest('Pick an external tool.');
  const tool = await db.selectFrom('ltiTools').select(['toolUrl']).where('id', '=', settings.toolId).executeTakeFirst();
  if (!tool) throw badRequest('That external tool does not exist.');
  if (settings.launchUrl && !isOnToolDomain(settings.launchUrl, tool.toolUrl)) {
    throw badRequest(`The launch URL must be on the tool's domain (${new URL(tool.toolUrl).hostname}).`);
  }
}
