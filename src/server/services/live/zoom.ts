/**
 * Zoom API client for a Server-to-Server OAuth app (https://developers.zoom.us/docs/internal-apps/s2s-oauth/).
 *
 * Access tokens come from POST https://zoom.us/oauth/token (grant_type=account_credentials, Basic auth with the
 * client ID and secret), last an hour and are kept in memory only. Meetings are created for a host user, updated and
 * deleted as sessions change; start URLs are fetched fresh for each Start and never stored. Webhooks are verified with
 * `x-zm-signature` (v0=HMAC-SHA256 of `v0:<timestamp>:<body>` with the webhook secret token).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ZoomConfig } from './config.js';
import { LiveProviderError, providerFetch } from './http.js';

export const ZOOM_OAUTH_URL = 'https://zoom.us/oauth/token';
export const ZOOM_API = 'https://api.zoom.us/v2';
/** Webhook timestamps further than this from the server's clock are refused (replays). */
export const ZOOM_WEBHOOK_TOLERANCE_S = 300;

export interface ZoomAccount {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export function zoomAccount(config: ZoomConfig): ZoomAccount {
  if (!config.accountId || !config.clientId || !config.clientSecret) {
    throw new LiveProviderError(
      'zoom',
      'Zoom isn’t set up yet. An administrator can add it under Administration → Live classes.',
      'config',
    );
  }
  return { accountId: config.accountId, clientId: config.clientId, clientSecret: config.clientSecret };
}

interface CachedToken {
  token: string;
  api: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();

const cacheKey = (a: ZoomAccount) => createHash('sha256').update(`${a.accountId}\n${a.clientId}\n${a.clientSecret}`).digest('hex');

/** Forgets cached tokens (tests; or after the credentials changed). */
export function clearZoomTokens(): void {
  tokens.clear();
}

function apiBaseFrom(apiUrl: unknown): string {
  if (typeof apiUrl !== 'string') return ZOOM_API;
  try {
    const u = new URL(apiUrl);
    const trusted = u.hostname === 'api.zoom.us' || u.hostname.endsWith('.zoom.us') || u.hostname.endsWith('.zoomgov.com');
    return u.protocol === 'https:' && trusted ? `${u.origin}/v2` : ZOOM_API;
  } catch {
    return ZOOM_API;
  }
}

async function accessToken(account: ZoomAccount, refresh = false): Promise<CachedToken> {
  const key = cacheKey(account);
  const cached = tokens.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const res = await providerFetch('zoom', ZOOM_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'account_credentials', account_id: account.accountId }).toString(),
    maxBytes: 64 * 1024,
  });
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    // handled below
  }
  if (res.status >= 500)
    throw new LiveProviderError(
      'zoom',
      `Zoom had a problem signing in (HTTP ${res.status}). Coursekit will try again later.`,
      'unreachable',
      res.status,
    );
  if (res.status !== 200 || typeof data.access_token !== 'string') {
    throw new LiveProviderError(
      'zoom',
      'Zoom rejected the app’s credentials. Check the account ID, client ID and client secret.',
      'config',
      res.status,
    );
  }
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  const token: CachedToken = { token: data.access_token, api: apiBaseFrom(data.api_url), expiresAt: Date.now() + expiresIn * 1000 };
  if (tokens.size > 50) tokens.clear();
  tokens.set(key, token);
  return token;
}

function zoomError(status: number, body: Record<string, unknown>, what: string): LiveProviderError {
  const code = typeof body.code === 'number' ? body.code : null;
  const detail = typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').slice(0, 200) : '';
  if (status === 401)
    return new LiveProviderError(
      'zoom',
      'Zoom rejected the app’s credentials. Check the account ID, client ID and client secret.',
      'config',
      status,
    );
  if (status === 429)
    return new LiveProviderError('zoom', 'Zoom is limiting requests right now. Coursekit will try again later.', 'rate_limited', status);
  if (status >= 500)
    return new LiveProviderError('zoom', `Zoom had a problem (HTTP ${status}). Coursekit will try again later.`, 'unreachable', status);
  if (status === 404 && code === 1001)
    return new LiveProviderError('zoom', `Zoom has no user ${what}. Check the host’s email address.`, 'config', status);
  if (status === 404 || code === 3001) return new LiveProviderError('zoom', 'That meeting no longer exists in Zoom.', 'not_found', status);
  if (code === 4711 || /scope/i.test(detail)) {
    return new LiveProviderError(
      'zoom',
      `The Zoom app is missing a scope it needs. Zoom said: ${detail || 'missing scope'}`,
      'config',
      status,
    );
  }
  return new LiveProviderError('zoom', `Zoom couldn’t do that${detail ? `: ${detail}` : ` (HTTP ${status})`}.`, 'rejected', status);
}

async function zoomRequest<T = Record<string, unknown>>(
  account: ZoomAccount,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  what = '',
): Promise<{ status: number; data: T }> {
  let token = await accessToken(account);
  for (let attempt = 0; ; attempt++) {
    const res = await providerFetch('zoom', `${token.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) {
      // The token may have been revoked or expired early: get a new one once.
      token = await accessToken(account, true);
      continue;
    }
    let data: Record<string, unknown> = {};
    if (res.text) {
      try {
        data = JSON.parse(res.text) as Record<string, unknown>;
      } catch {
        if (res.status < 300) throw new LiveProviderError('zoom', 'Zoom sent a reply Coursekit couldn’t read.', 'unreachable', res.status);
      }
    }
    if (res.status >= 300) throw zoomError(res.status, data, what);
    return { status: res.status, data: data as T };
  }
}

/** Meeting UUIDs that start with "/" or contain "//" must be encoded twice in paths. */
export function encodeZoomUuid(uuid: string): string {
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid);
}

export interface ZoomMeetingPayload {
  topic: string;
  type: 2;
  start_time: string;
  duration: number;
  timezone: string;
  agenda: string;
  settings: {
    join_before_host: boolean;
    jbh_time: number;
    waiting_room: boolean;
    auto_recording: 'cloud' | 'none';
    mute_upon_entry: boolean;
    approval_type: 2;
  };
}

export async function createZoomMeeting(account: ZoomAccount, host: string, payload: ZoomMeetingPayload) {
  const { data } = await zoomRequest(account, 'POST', `/users/${encodeURIComponent(host)}/meetings`, payload, host);
  const id = typeof data.id === 'number' || typeof data.id === 'string' ? String(data.id) : null;
  const joinUrl = typeof data.join_url === 'string' && data.join_url.startsWith('https://') ? data.join_url : null;
  if (!id || !joinUrl) throw new LiveProviderError('zoom', 'Zoom created the meeting but sent no join link.', 'unreachable');
  return { id, joinUrl };
}

export async function updateZoomMeeting(account: ZoomAccount, meetingId: string, payload: ZoomMeetingPayload): Promise<void> {
  await zoomRequest(account, 'PATCH', `/meetings/${encodeURIComponent(meetingId)}`, payload);
}

/** Deletes a meeting; one that is already gone is fine. */
export async function deleteZoomMeeting(account: ZoomAccount, meetingId: string): Promise<void> {
  try {
    await zoomRequest(
      account,
      'DELETE',
      `/meetings/${encodeURIComponent(meetingId)}?schedule_for_reminder=false&cancel_meeting_reminder=false`,
    );
  } catch (err) {
    if (err instanceof LiveProviderError && err.kind === 'not_found') return;
    throw err;
  }
}

/** The meeting's join link, as Zoom has it now. Also tells whether the meeting still exists (not_found when it was deleted). */
export async function zoomJoinUrl(account: ZoomAccount, meetingId: string): Promise<string> {
  const { data } = await zoomRequest(account, 'GET', `/meetings/${encodeURIComponent(meetingId)}`);
  if (typeof data.join_url !== 'string' || !data.join_url.startsWith('https://')) {
    throw new LiveProviderError('zoom', 'Zoom sent no join link for this meeting.', 'unreachable');
  }
  return data.join_url;
}

/** A fresh start URL for the host. It expires, so it is only ever sent as the redirect of a staff member's Start. */
export async function zoomStartUrl(account: ZoomAccount, meetingId: string): Promise<string> {
  const { data } = await zoomRequest(account, 'GET', `/meetings/${encodeURIComponent(meetingId)}`);
  if (typeof data.start_url !== 'string' || !data.start_url.startsWith('https://')) {
    throw new LiveProviderError('zoom', 'Zoom sent no start link for this meeting.', 'unreachable');
  }
  return data.start_url;
}

/** Ends the meeting for everyone. A meeting that isn't running is fine. */
export async function endZoomMeeting(account: ZoomAccount, meetingId: string): Promise<void> {
  try {
    await zoomRequest(account, 'PUT', `/meetings/${encodeURIComponent(meetingId)}/status`, { action: 'end' });
  } catch (err) {
    if (err instanceof LiveProviderError && (err.kind === 'not_found' || err.status === 400)) return;
    throw err;
  }
}

export interface ZoomRecording {
  uuid: string;
  title: string;
  url: string;
  passcode: string | null;
  startTime: string | null;
  durationMinutes: number | null;
}

/** Turns a recording object (API or recording.completed webhook) into one recording entry. */
export function toZoomRecording(obj: Record<string, unknown>): ZoomRecording | null {
  const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
  const share = typeof obj.share_url === 'string' && obj.share_url.startsWith('https://') ? obj.share_url : null;
  if (!uuid || !share) return null;
  // recording_play_passcode can be added to the link so viewers don't need the passcode.
  const play = typeof obj.recording_play_passcode === 'string' && obj.recording_play_passcode ? obj.recording_play_passcode : null;
  const url = play ? `${share}${share.includes('?') ? '&' : '?'}pwd=${encodeURIComponent(play)}` : share;
  return {
    uuid,
    title: typeof obj.topic === 'string' ? obj.topic.slice(0, 200) : 'Recording',
    url,
    passcode: play ? null : typeof obj.password === 'string' && obj.password ? obj.password : null,
    startTime:
      typeof obj.start_time === 'string' && !Number.isNaN(Date.parse(obj.start_time)) ? new Date(obj.start_time).toISOString() : null,
    durationMinutes: typeof obj.duration === 'number' && obj.duration > 0 ? Math.round(obj.duration) : null,
  };
}

/** Cloud recordings of a meeting instance (UUID) or of the latest instance (meeting id). None yet: []. */
export async function zoomRecordings(account: ZoomAccount, meetingIdOrUuid: string): Promise<ZoomRecording[]> {
  try {
    const { data } = await zoomRequest(account, 'GET', `/meetings/${encodeZoomUuid(meetingIdOrUuid)}/recordings`);
    const rec = toZoomRecording(data);
    return rec ? [rec] : [];
  } catch (err) {
    if (err instanceof LiveProviderError && (err.kind === 'not_found' || err.status === 404)) return [];
    throw err;
  }
}

/** Moves a recording to the Zoom trash (administrators can restore it there for 30 days). */
export async function trashZoomRecording(account: ZoomAccount, uuid: string): Promise<void> {
  try {
    await zoomRequest(account, 'DELETE', `/meetings/${encodeZoomUuid(uuid)}/recordings?action=trash`);
  } catch (err) {
    if (err instanceof LiveProviderError && err.kind === 'not_found') return;
    throw err;
  }
}

/** Instances (UUIDs) of a meeting that took place. */
export async function zoomPastInstances(account: ZoomAccount, meetingId: string): Promise<string[]> {
  try {
    const { data } = await zoomRequest<{ meetings?: Array<{ uuid?: unknown }> }>(
      account,
      'GET',
      `/past_meetings/${encodeURIComponent(meetingId)}/instances`,
    );
    return (data.meetings ?? [])
      .map((m) => m.uuid)
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .slice(0, 50);
  } catch (err) {
    if (err instanceof LiveProviderError && err.kind === 'not_found') return [];
    throw err;
  }
}

export interface ZoomParticipant {
  /** Stable for one stay in the meeting, so reading the report again changes nothing. */
  key: string;
  name: string;
  email: string | null;
  joinedAt: string;
  leftAt: string | null;
}

/** The past meeting participants report of one instance (needs a paid plan and the report scope). */
export async function zoomParticipants(account: ZoomAccount, uuid: string): Promise<ZoomParticipant[]> {
  const out: ZoomParticipant[] = [];
  let next = '';
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ page_size: '300', ...(next ? { next_page_token: next } : {}) });
    const { data } = await zoomRequest<{ participants?: Array<Record<string, unknown>>; next_page_token?: unknown }>(
      account,
      'GET',
      `/report/meetings/${encodeZoomUuid(uuid)}/participants?${query}`,
    );
    for (const p of data.participants ?? []) {
      const joined = typeof p.join_time === 'string' && !Number.isNaN(Date.parse(p.join_time)) ? new Date(p.join_time).toISOString() : null;
      if (!joined) continue;
      const left =
        typeof p.leave_time === 'string' && !Number.isNaN(Date.parse(p.leave_time)) ? new Date(p.leave_time).toISOString() : null;
      const who = [p.participant_user_id, p.user_id, p.id, p.name].find((v) => typeof v === 'string' && v) as string | undefined;
      out.push({
        key: `${uuid}:${who ?? 'guest'}:${joined}`.slice(0, 300),
        name: typeof p.name === 'string' ? p.name.slice(0, 200) : '',
        email: typeof p.user_email === 'string' && p.user_email ? p.user_email.slice(0, 254) : null,
        joinedAt: joined,
        leftAt: left,
      });
    }
    next = typeof data.next_page_token === 'string' ? data.next_page_token : '';
    if (!next) break;
  }
  return out;
}

/** Checks the credentials and the default host (Administration → Live classes → Test). */
export async function zoomCheck(account: ZoomAccount, host: string): Promise<string> {
  const { data } = await zoomRequest(account, 'GET', `/users/${encodeURIComponent(host)}`, undefined, host);
  const email = typeof data.email === 'string' ? data.email : host;
  return `Connected to Zoom. Meetings will be hosted by ${email}.`;
}

/** Verifies a webhook request: the signature over the raw body and a timestamp within a few minutes. */
export function verifyZoomWebhook(
  secret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  nowMs = Date.now(),
): boolean {
  if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  // Zoom sends seconds; accept milliseconds too.
  const seconds = ts > 1e11 ? ts / 1000 : ts;
  if (Math.abs(nowMs / 1000 - seconds) > ZOOM_WEBHOOK_TOLERANCE_S) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The answer to Zoom's endpoint.url_validation challenge. */
export function zoomUrlValidation(secret: string, plainToken: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') };
}
