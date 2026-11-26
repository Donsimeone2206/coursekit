/**
 * Jitsi Meet rooms. Room names are random and unguessable (one per session and group). Self-hosted servers with
 * token authentication (prosody's token auth, an app ID and secret) get an HS256 JWT per person, with moderator rights
 * for staff. The token spec (https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/tokens.md) has no moderator claim:
 * only Prosody's token_affiliation module reads it, and Jicofo must not hand out moderator rights itself (auto-owner,
 * or every authenticated user an owner), or students become moderators too. The admin page says so.
 */
import { SignJWT } from 'jose';
import type { JitsiConfig } from './config.js';

export const PUBLIC_JITSI_HOST = 'meet.jit.si';

export function jitsiBase(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** meet.jit.si only allows embedding for short demo calls, so it always opens in a new tab. */
export function isPublicJitsi(config: Pick<JitsiConfig, 'url'>): boolean {
  try {
    const host = new URL(config.url).hostname.toLowerCase();
    return host === PUBLIC_JITSI_HOST || host.endsWith(`.${PUBLIC_JITSI_HOST}`) || host === '8x8.vc' || host.endsWith('.8x8.vc');
  } catch {
    return true;
  }
}

export interface JitsiTokenInput {
  appId: string;
  appSecret: string;
  serverUrl: string;
  room: string;
  user: { id: string; name: string; email?: string | null; avatar?: string | null };
  moderator: boolean;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * A token for one person and one room. Moderator rights are given the ways Jitsi setups that read them from tokens
 * do (token_affiliation and similar modules): `context.user.moderator`, `context.user.affiliation` (owner or member)
 * and a top-level `moderator` claim.
 */
export async function jitsiToken(input: JitsiTokenInput): Promise<string> {
  const host = new URL(input.serverUrl).hostname.toLowerCase();
  const user: Record<string, unknown> = {
    id: input.user.id,
    name: input.user.name,
    moderator: input.moderator,
    affiliation: input.moderator ? 'owner' : 'member',
  };
  if (input.user.email) user.email = input.user.email;
  if (input.user.avatar && /^https:\/\//.test(input.user.avatar)) user.avatar = input.user.avatar;
  return new SignJWT({ room: input.room, moderator: input.moderator, context: { user } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(input.appId)
    .setAudience('jitsi')
    .setSubject(host)
    .setNotBefore(Math.floor(Date.now() / 1000) - 60)
    .setIssuedAt()
    .setExpirationTime(input.expiresAt)
    .sign(new TextEncoder().encode(input.appSecret));
}

/**
 * The meeting address: the room, the token as `?jwt=` and settings in the fragment, the way the Jitsi IFrame API
 * builds the address of its frame (the fragment never reaches the server).
 */
export function jitsiRoomUrl(
  serverUrl: string,
  room: string,
  options: { jwt?: string | null; displayName?: string; subject?: string } = {},
): string {
  const base = `${jitsiBase(serverUrl)}/${encodeURIComponent(room)}`;
  const query = options.jwt ? `?jwt=${encodeURIComponent(options.jwt)}` : '';
  const hash: string[] = ['config.prejoinConfig.enabled=true'];
  if (options.displayName) hash.push(`userInfo.displayName=${encodeURIComponent(JSON.stringify(options.displayName.slice(0, 100)))}`);
  if (options.subject) hash.push(`config.subject=${encodeURIComponent(JSON.stringify(options.subject.slice(0, 120)))}`);
  return `${base}${query}#${hash.join('&')}`;
}
