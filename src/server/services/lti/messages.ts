/**
 * LTI 1.3 messages Coursekit sends: the id_token of a resource link launch (LtiResourceLinkRequest)
 * and of a content selection (LtiDeepLinkingRequest), signed RS256 with the platform key.
 */
import { SignJWT } from 'jose';
import type { CourseRole, LtiSettings, SiteRole } from '../../../shared/types.js';
import type { ActivityRow, CourseRow, UserRow } from '../../db/schema.js';
import type { LtiToolRow } from '../../db/schema-lti.js';
import type { DB } from '../../db/types.js';
import { parseJson } from '../../lib/util.js';
import { getSiteSettings } from '../settings.js';
import { platformGuid, platformKey } from './keys.js';
import { toolCustomParams } from './tools.js';

export const LTI_CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
export const DL_CLAIM = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
export const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
export const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';

export const SCOPES = {
  lineItem: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
  lineItemReadOnly: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
  resultReadOnly: 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
  score: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
  memberships: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
} as const;

export const AGS_SCOPES = [SCOPES.lineItem, SCOPES.lineItemReadOnly, SCOPES.resultReadOnly, SCOPES.score];

/** Every service scope Coursekit supports. */
export const SUPPORTED_SCOPES: string[] = [...AGS_SCOPES, SCOPES.memberships];

export const isAgsScope = (scope: string) => (AGS_SCOPES as readonly string[]).includes(scope);

/**
 * Scopes the tool may be granted: the services the administrator allowed, narrowed to the scopes it asked
 * for when it registered itself (Dynamic Registration). Tools added by hand have no such list.
 */
export function allowedScopes(tool: Pick<LtiToolRow, 'allowAgs' | 'allowNrps'> & { scopes?: string | null }): string[] {
  const services = [...(tool.allowAgs ? AGS_SCOPES : []), ...(tool.allowNrps ? [SCOPES.memberships] : [])];
  if (tool.scopes == null) return services;
  const registered = parseJson<unknown>(tool.scopes, []);
  return Array.isArray(registered) ? services.filter((s) => registered.includes(s)) : [];
}

const MEMBERSHIP = 'http://purl.imsglobal.org/vocab/lis/v2/membership#';
export const ROLES = {
  learner: `${MEMBERSHIP}Learner`,
  instructor: `${MEMBERSHIP}Instructor`,
  teachingAssistant: 'http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant',
  systemAdmin: 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
  institutionAdmin: 'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
};

/** LIS v2 roles of a person in a course: membership roles, plus system and institution roles for administrators. */
export function ltiRoles(siteRole: SiteRole, courseRole: CourseRole | null): string[] {
  const roles: string[] = [];
  if (courseRole === 'student') roles.push(ROLES.learner);
  if (courseRole === 'teacher') roles.push(ROLES.instructor);
  if (courseRole === 'assistant') roles.push(ROLES.instructor, ROLES.teachingAssistant);
  if (siteRole === 'admin') {
    if (!courseRole) roles.push(ROLES.instructor); // administrators manage every course
    roles.push(ROLES.systemAdmin, ROLES.institutionAdmin);
  }
  return roles;
}

export interface MessageContext {
  db: DB;
  issuer: string;
  version: string;
  tool: LtiToolRow;
  user: UserRow;
  course: CourseRow;
  courseRole: CourseRole | null;
  nonce: string;
}

async function baseClaims(ctx: MessageContext, messageType: string, targetLinkUri: string): Promise<Record<string, unknown>> {
  const { tool, user, course, issuer } = ctx;
  const site = await getSiteSettings(ctx.db);
  const claims: Record<string, unknown> = {
    iss: issuer,
    aud: tool.clientId,
    azp: tool.clientId,
    sub: user.id,
    nonce: ctx.nonce,
    [`${LTI_CLAIM}message_type`]: messageType,
    [`${LTI_CLAIM}version`]: '1.3.0',
    [`${LTI_CLAIM}deployment_id`]: tool.deploymentId,
    [`${LTI_CLAIM}target_link_uri`]: targetLinkUri,
    [`${LTI_CLAIM}roles`]: ltiRoles(user.role, ctx.courseRole),
    [`${LTI_CLAIM}context`]: {
      id: course.id,
      label: course.slug,
      title: course.title,
      type: ['http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering'],
    },
    [`${LTI_CLAIM}tool_platform`]: {
      guid: await platformGuid(ctx.db),
      name: site.name,
      url: issuer,
      product_family_code: 'coursekit',
      version: ctx.version,
    },
  };
  if (tool.shareName) claims.name = user.name;
  if (tool.shareEmail) claims.email = user.email;
  if (allowedScopes(tool).includes(SCOPES.memberships)) {
    claims[NRPS_CLAIM] = { context_memberships_url: `${issuer}/lti/nrps/${course.id}/memberships`, service_versions: ['2.0'] };
  }
  return claims;
}

/** Signs an id_token with the platform key; it is valid for five minutes. */
export async function signIdToken(db: DB, claims: Record<string, unknown>): Promise<string> {
  const key = await platformKey(db);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
}

export async function resourceLinkClaims(
  ctx: MessageContext,
  activity: ActivityRow,
  settings: LtiSettings,
  target: 'iframe' | 'window',
): Promise<Record<string, unknown>> {
  const { tool, course, issuer } = ctx;
  const claims = await baseClaims(ctx, 'LtiResourceLinkRequest', settings.launchUrl ?? tool.toolUrl);
  claims[`${LTI_CLAIM}resource_link`] = { id: activity.id, title: activity.title, description: activity.description || undefined };
  claims[`${LTI_CLAIM}launch_presentation`] = {
    document_target: target,
    return_url: `${issuer}/courses/${course.slug}/activities/${activity.id}`,
    locale: 'en',
  };
  claims[`${LTI_CLAIM}custom`] = { ...toolCustomParams(tool), ...settings.custom };
  const agsScopes = allowedScopes(tool).filter(isAgsScope);
  if (agsScopes.length) {
    claims[AGS_CLAIM] = {
      scope: agsScopes,
      lineitems: `${issuer}/lti/ags/${course.id}/lineitems`,
      ...(activity.maxGrade != null ? { lineitem: `${issuer}/lti/ags/${course.id}/lineitems/${activity.id}` } : {}),
    };
  }
  return claims;
}

export async function deepLinkingClaims(ctx: MessageContext, data: string, editing: boolean): Promise<Record<string, unknown>> {
  const { tool, course, issuer } = ctx;
  const claims = await baseClaims(ctx, 'LtiDeepLinkingRequest', tool.deepLinkingUrl ?? tool.toolUrl);
  claims[`${LTI_CLAIM}launch_presentation`] = { document_target: 'window', return_url: `${issuer}/courses/${course.slug}`, locale: 'en' };
  claims[`${LTI_CLAIM}custom`] = toolCustomParams(tool);
  claims[`${DL_CLAIM}deep_linking_settings`] = {
    deep_link_return_url: `${issuer}/lti/deep-link/return`,
    accept_types: ['ltiResourceLink'],
    accept_presentation_document_targets: ['iframe', 'window'],
    accept_multiple: !editing,
    // A grade column only for tools that may send scores to it.
    accept_lineitem: allowedScopes(tool).includes(SCOPES.score),
    auto_create: true,
    data,
  };
  return claims;
}
