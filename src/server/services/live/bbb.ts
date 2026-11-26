/**
 * BigBlueButton API client (https://docs.bigbluebutton.org/development/api/).
 *
 * Every call is `<server>/bigbluebutton/api/<call>?<query>&checksum=<hash>`, where the checksum is a hash of
 * `call + query + sharedSecret` (SHA-1 by default; SHA-256, SHA-384 and SHA-512 on 2.5 and later). Responses are XML
 * with `returncode` SUCCESS or FAILED and a `messageKey`. Callbacks: the recording-ready callback posts a JWT
 * (`signed_parameters`, HS256 with the shared secret); the analytics callback posts JSON with an
 * `Authorization: Bearer` JWT (HS512 with the shared secret, an `exp` claim only).
 */
import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { jwtVerify } from 'jose';
import type { BbbChecksumAlgorithm } from '../../../shared/live.js';
import type { BbbConfig } from './config.js';
import { LiveProviderError, providerFetch } from './http.js';

export interface BbbServer {
  /** API base, ending in /api. */
  api: string;
  secret: string;
  algorithm: BbbChecksumAlgorithm;
}

/** The API base for the address an administrator entered: the server, its /bigbluebutton/ path or the API itself. */
export function bbbApiBase(url: string): string {
  const u = new URL(url);
  let path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api')) path = path.endsWith('/bigbluebutton') ? `${path}/api` : path === '' ? '/bigbluebutton/api' : `${path}/api`;
  return `${u.origin}${path}`;
}

export function bbbServer(config: BbbConfig): BbbServer {
  if (!config.url || !config.secret) {
    throw new LiveProviderError(
      'bbb',
      'BigBlueButton isn’t set up yet. An administrator can add it under Administration → Live classes.',
      'config',
    );
  }
  return { api: bbbApiBase(config.url), secret: config.secret, algorithm: config.algorithm };
}

export function bbbChecksum(call: string, query: string, secret: string, algorithm: BbbChecksumAlgorithm): string {
  return createHash(algorithm)
    .update(call + query + secret)
    .digest('hex');
}

type Params = Record<string, string | number | boolean | null | undefined>;

/** The query string, with the checksum computed over exactly what is sent. */
export function bbbUrl(server: BbbServer, call: string, params: Params): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) query.append(key, String(value));
  const qs = query.toString();
  const checksum = bbbChecksum(call, qs, server.secret, server.algorithm);
  return `${server.api}/${call}?${qs ? `${qs}&` : ''}checksum=${checksum}`;
}

function parseXml(text: string): Element {
  let root: Element | null | undefined;
  try {
    root = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml')?.documentElement as Element | null;
  } catch {
    root = null;
  }
  if (!root || root.localName !== 'response') {
    throw new LiveProviderError('bbb', 'BigBlueButton sent a reply Coursekit couldn’t read. Check the server URL.', 'config');
  }
  return root;
}

function child(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === name) return n as Element;
  }
  return null;
}

function children(el: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).localName === name) out.push(n as Element);
  return out;
}

const text = (el: Element | null | undefined, name: string): string => child(el, name)?.textContent?.trim() ?? '';

const MESSAGES: Record<string, string> = {
  checksumError: 'BigBlueButton refused the request: check the shared secret and the checksum algorithm.',
  invalidChecksum: 'BigBlueButton refused the request: check the shared secret and the checksum algorithm.',
  notFound: 'That meeting isn’t running on BigBlueButton.',
  meetingForciblyEnded: 'This class was ended for everyone a moment ago. Wait a minute before starting it again.',
  maxConcurrent: 'BigBlueButton is running as many meetings as it allows. Try again later.',
};

/** Calls the API and returns the <response> element. FAILED answers become a LiveProviderError with a safe message. */
export async function bbbCall(
  server: BbbServer,
  call: string,
  params: Params,
  options: { allowNotFound?: boolean } = {},
): Promise<Element | null> {
  const res = await providerFetch('bbb', bbbUrl(server, call, params));
  if (res.status === 401 || res.status === 403) {
    throw new LiveProviderError(
      'bbb',
      'BigBlueButton refused the request: check the shared secret and the checksum algorithm.',
      'config',
      res.status,
    );
  }
  if (res.status >= 400) {
    throw new LiveProviderError(
      'bbb',
      `BigBlueButton answered with an error (HTTP ${res.status}). Check the server URL.`,
      'unreachable',
      res.status,
    );
  }
  const root = parseXml(res.text);
  if (text(root, 'returncode') === 'SUCCESS') return root;
  const key = text(root, 'messageKey');
  if (options.allowNotFound && key === 'notFound') return null;
  const message = MESSAGES[key] ?? `BigBlueButton couldn’t do that (${key || 'no reason given'}).`;
  throw new LiveProviderError(
    'bbb',
    message,
    key === 'notFound' ? 'not_found' : key.toLowerCase().includes('checksum') ? 'config' : 'rejected',
  );
}

export interface BbbCreateParams {
  meetingID: string;
  name: string;
  welcome?: string;
  logoutURL?: string;
  record: boolean;
  autoStartRecording: boolean;
  allowStartStopRecording: boolean;
  /** Signed Coursekit addresses; left out without the site's public URL. */
  endedUrl?: string | null;
  recordingReadyUrl?: string | null;
  analyticsUrl?: string | null;
  meta?: Record<string, string>;
}

export interface BbbMeetingRun {
  createTime: string;
  internalMeetingId: string;
}

/** Creates the meeting, or returns the running one (create is idempotent for a meetingID that is running). */
export async function bbbCreate(server: BbbServer, p: BbbCreateParams): Promise<BbbMeetingRun> {
  const meta: Params = {};
  for (const [k, v] of Object.entries(p.meta ?? {})) meta[`meta_${k}`] = v;
  const root = await bbbCall(server, 'create', {
    meetingID: p.meetingID,
    name: p.name,
    welcome: p.welcome || undefined,
    logoutURL: p.logoutURL,
    record: p.record,
    autoStartRecording: p.autoStartRecording,
    allowStartStopRecording: p.allowStartStopRecording,
    // Every supported version (2.4 and later) reads meetingEndedURL. Not the legacy meta_endCallbackUrl: meta_*
    // values can be shown to people in the meeting.
    meetingEndedURL: p.endedUrl ?? undefined,
    'meta_bbb-recording-ready-url': p.recordingReadyUrl ?? undefined,
    'meta_analytics-callback-url': p.analyticsUrl ?? undefined,
    // BigBlueButton only runs the analytics callback for meetings that keep their events (defaultKeepEvents is false).
    meetingKeepEvents: p.analyticsUrl ? true : undefined,
    ...meta,
  });
  return { createTime: text(root, 'createTime'), internalMeetingId: text(root, 'internalMeetingID') };
}

/**
 * A browser join address (no call is made): staff join as moderators, everyone else as viewers. The role comes from
 * `role` (BigBlueButton 2.4 and later), so no meeting password is ever handed to a browser.
 */
export function bbbJoinUrl(
  server: BbbServer,
  p: { meetingID: string; fullName: string; userID: string; moderator: boolean; createTime?: string | null },
): string {
  return bbbUrl(server, 'join', {
    fullName: p.fullName.slice(0, 255) || 'Participant',
    meetingID: p.meetingID,
    role: p.moderator ? 'MODERATOR' : 'VIEWER',
    userID: p.userID,
    createTime: p.createTime || undefined,
    redirect: 'true',
  });
}

export async function bbbIsMeetingRunning(server: BbbServer, meetingID: string): Promise<boolean> {
  const root = await bbbCall(server, 'isMeetingRunning', { meetingID });
  return text(root, 'running') === 'true';
}

export interface BbbAttendee {
  userId: string;
  fullName: string;
  role: 'moderator' | 'viewer';
}

export interface BbbMeetingInfo {
  running: boolean;
  createTime: string;
  internalMeetingId: string;
  startTime: number | null;
  endTime: number | null;
  participantCount: number;
  moderatorCount: number;
  attendees: BbbAttendee[];
}

/** null when no meeting with this ID exists (it ended a while ago, or was never created). */
export async function bbbMeetingInfo(server: BbbServer, meetingID: string): Promise<BbbMeetingInfo | null> {
  const root = await bbbCall(server, 'getMeetingInfo', { meetingID }, { allowNotFound: true });
  if (!root) return null;
  const ms = (name: string) => {
    const n = Number(text(root, name));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    running: text(root, 'running') === 'true',
    createTime: text(root, 'createTime'),
    internalMeetingId: text(root, 'internalMeetingID'),
    startTime: ms('startTime'),
    endTime: ms('endTime'),
    participantCount: Number(text(root, 'participantCount')) || 0,
    moderatorCount: Number(text(root, 'moderatorCount')) || 0,
    attendees: children(child(root, 'attendees'), 'attendee').map((a) => ({
      userId: text(a, 'userID'),
      fullName: text(a, 'fullName'),
      role: text(a, 'role').toUpperCase() === 'MODERATOR' ? 'moderator' : 'viewer',
    })),
  };
}

/** Ends the meeting for everyone. A meeting that isn't running is fine. */
export async function bbbEnd(server: BbbServer, meetingID: string): Promise<void> {
  await bbbCall(server, 'end', { meetingID }, { allowNotFound: true });
}

export interface BbbRecording {
  recordId: string;
  meetingId: string;
  name: string;
  published: boolean;
  state: string;
  startTime: number | null;
  endTime: number | null;
  /** The presentation playback (or the first format), with its length in minutes. */
  url: string | null;
  lengthMinutes: number | null;
}

/** Recordings of some meetings (published and unpublished; processing ones aren't listed by BigBlueButton). */
export async function bbbRecordings(server: BbbServer, meetingIds: string[]): Promise<BbbRecording[]> {
  if (meetingIds.length === 0) return [];
  const root = await bbbCall(server, 'getRecordings', { meetingID: meetingIds.join(','), state: 'published,unpublished' });
  return children(child(root, 'recordings'), 'recording').map((r) => {
    const formats = children(child(r, 'playback'), 'format');
    const format = formats.find((f) => text(f, 'type') === 'presentation') ?? formats[0] ?? null;
    const num = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const url = format ? text(format, 'url') : '';
    return {
      recordId: text(r, 'recordID'),
      meetingId: text(r, 'meetingID'),
      name: text(r, 'name'),
      published: text(r, 'published') === 'true',
      state: text(r, 'state'),
      startTime: num(text(r, 'startTime')),
      endTime: num(text(r, 'endTime')),
      url: /^https?:\/\//i.test(url) ? url : null,
      lengthMinutes: format ? num(text(format, 'length')) : null,
    };
  });
}

export async function bbbPublishRecordings(server: BbbServer, recordIds: string[], publish: boolean): Promise<void> {
  await bbbCall(server, 'publishRecordings', { recordID: recordIds.join(','), publish });
}

export async function bbbDeleteRecordings(server: BbbServer, recordIds: string[]): Promise<void> {
  await bbbCall(server, 'deleteRecordings', { recordID: recordIds.join(',') }, { allowNotFound: true });
}

const key = (secret: string) => new TextEncoder().encode(secret);

/** The recording-ready callback: `signed_parameters` is a JWT signed (HS256) with the shared secret. */
export async function verifyRecordingReady(secret: string, signed: string): Promise<{ meetingId: string; recordId: string } | null> {
  if (!signed || signed.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(signed, key(secret), { algorithms: ['HS256'] });
    const meetingId = typeof payload.meeting_id === 'string' ? payload.meeting_id : null;
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : null;
    return meetingId && recordId ? { meetingId, recordId } : null;
  } catch {
    return null;
  }
}

/** The analytics callback: `Authorization: Bearer <JWT>`, signed (HS512) with the shared secret, with an expiry. */
export async function verifyAnalyticsAuth(secret: string, authorization: string | undefined): Promise<boolean> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match || match[1]!.length > 4096) return false;
  try {
    await jwtVerify(match[1]!, key(secret), { algorithms: ['HS512'], requiredClaims: ['exp'] });
    return true;
  } catch {
    return false;
  }
}

export interface BbbAnalyticsAttendee {
  extUserId: string | null;
  name: string;
  moderator: boolean;
  /** Join and leave times in ms, paired into intervals. */
  intervals: Array<{ joinedAt: number; leftAt: number }>;
}

export interface BbbAnalytics {
  meetingId: string;
  internalMeetingId: string;
  start: number | null;
  finish: number | null;
  attendees: BbbAnalyticsAttendee[];
}

const time = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** Reads the analytics callback's JSON (`version`, `meeting_id`, `internal_meeting_id`, `data.attendees[]`). */
export function parseAnalytics(body: unknown): BbbAnalytics | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const data = (b.data ?? {}) as Record<string, unknown>;
  if (typeof b.meeting_id !== 'string' || !Array.isArray(data.attendees)) return null;
  const start = time(data.start);
  const finish = time(data.finish);
  const attendees: BbbAnalyticsAttendee[] = [];
  for (const raw of data.attendees.slice(0, 5000)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const joins = (Array.isArray(a.joins) ? a.joins : [])
      .map(time)
      .filter((t): t is number => t !== null)
      .sort((x, y) => x - y);
    const leaves = (Array.isArray(a.leaves) ? a.leaves : [])
      .map(time)
      .filter((t): t is number => t !== null)
      .sort((x, y) => x - y);
    // Each join pairs with the first leave after it; a join without one lasted until the meeting finished.
    const intervals: BbbAnalyticsAttendee['intervals'] = [];
    for (const joinedAt of joins.slice(0, 500)) {
      const at = leaves.findIndex((l) => l >= joinedAt);
      const leftAt = at >= 0 ? leaves.splice(at, 1)[0]! : (finish ?? joinedAt);
      intervals.push({ joinedAt, leftAt: Math.max(leftAt, joinedAt) });
    }
    attendees.push({
      extUserId: typeof a.ext_user_id === 'string' && a.ext_user_id ? a.ext_user_id : null,
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : '',
      moderator: a.moderator === true,
      intervals,
    });
  }
  return {
    meetingId: b.meeting_id,
    internalMeetingId: typeof b.internal_meeting_id === 'string' ? b.internal_meeting_id : '',
    start,
    finish,
    attendees,
  };
}
