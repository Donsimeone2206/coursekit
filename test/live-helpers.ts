/**
 * Test helpers for live classes: a mock BigBlueButton server and a mock Zoom API, served through a stubbed global
 * fetch (no ports), plus small request helpers.
 */
import { createHash, createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { InsertQueryNode, PrimitiveValueListNode, ValueNode, ValuesNode, type KyselyPlugin } from 'kysely';
import { vi } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { liveWorkerFor, runLiveMaintenance } from '../src/server/services/live/worker.js';
import type { Client } from './helpers.js';

export const BBB_URL = 'https://bbb.test/bigbluebutton/';
export const BBB_API = 'https://bbb.test/bigbluebutton/api';
export const BBB_SECRET = 'bbb-shared-secret-for-tests-0123456789abcdef';

type Handler = (req: Request) => Response | null | Promise<Response | null>;
const handlers: Handler[] = [];

/** Routes the global fetch to the mock servers; anything else fails like an unreachable host. */
export function installFetch(): void {
  handlers.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    for (const h of handlers) {
      const res = await h(req);
      if (res) return res;
    }
    throw new TypeError('fetch failed');
  });
}

export function uninstallFetch(): void {
  handlers.length = 0;
  vi.unstubAllGlobals();
}

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0"?><response>${body}</response>`, { status, headers: { 'content-type': 'text/xml' } });
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface BbbMeeting {
  params: Record<string, string>;
  running: boolean;
  createTime: string;
  internalId: string;
  attendees: Array<{ userID: string; fullName: string; role: 'MODERATOR' | 'VIEWER' }>;
  ended: boolean;
}

export interface BbbRecording {
  recordID: string;
  meetingID: string;
  name: string;
  published: boolean;
  url: string;
  startTime: number;
  length: number;
}

/** A BigBlueButton server that checks every checksum (with the given algorithm) and keeps meetings in memory. */
export function mockBbb(options: { secret?: string; algorithm?: 'sha1' | 'sha256' | 'sha384' | 'sha512' } = {}) {
  const secret = options.secret ?? BBB_SECRET;
  const algorithm = options.algorithm ?? 'sha1';
  const meetings = new Map<string, BbbMeeting>();
  const recordings = new Map<string, BbbRecording>();
  const calls: Array<{ call: string; params: Record<string, string> }> = [];
  let checksumFailures = 0;
  let down = false;
  let created = 0;

  handlers.push((req) => {
    const url = new URL(req.url);
    if (url.origin !== 'https://bbb.test' || !url.pathname.startsWith('/bigbluebutton/api/')) return null;
    if (down) throw new TypeError('fetch failed');
    const call = url.pathname.slice('/bigbluebutton/api/'.length);
    const raw = url.search.slice(1);
    const at = raw.lastIndexOf('checksum=');
    const query = at > 0 ? raw.slice(0, at - 1) : '';
    const given = raw.slice(at + 'checksum='.length);
    const expected = createHash(algorithm)
      .update(call + query + secret)
      .digest('hex');
    if (at < 0 || given !== expected) {
      checksumFailures++;
      return xml('<returncode>FAILED</returncode><messageKey>checksumError</messageKey><message>Checksums do not match</message>');
    }
    const params = Object.fromEntries(new URLSearchParams(query));
    calls.push({ call, params });
    const id = params.meetingID ?? '';
    const m = meetings.get(id);
    switch (call) {
      case 'create': {
        if (m && !m.ended) {
          return xml(
            `<returncode>SUCCESS</returncode><meetingID>${esc(id)}</meetingID><internalMeetingID>${m.internalId}</internalMeetingID><createTime>${m.createTime}</createTime><messageKey>duplicateWarning</messageKey>`,
          );
        }
        created++;
        const meeting: BbbMeeting = {
          params,
          running: false,
          createTime: String(1_700_000_000_000 + created),
          internalId: `int-${created}`,
          attendees: [],
          ended: false,
        };
        meetings.set(id, meeting);
        return xml(
          `<returncode>SUCCESS</returncode><meetingID>${esc(id)}</meetingID><internalMeetingID>${meeting.internalId}</internalMeetingID><createTime>${meeting.createTime}</createTime>`,
        );
      }
      case 'isMeetingRunning':
        return xml(`<returncode>SUCCESS</returncode><running>${m?.running ? 'true' : 'false'}</running>`);
      case 'getMeetingInfo': {
        if (!m || m.ended)
          return xml(
            '<returncode>FAILED</returncode><messageKey>notFound</messageKey><message>A meeting with that ID does not exist</message>',
          );
        const attendees = m.attendees
          .map((a) => `<attendee><userID>${esc(a.userID)}</userID><fullName>${esc(a.fullName)}</fullName><role>${a.role}</role></attendee>`)
          .join('');
        return xml(
          `<returncode>SUCCESS</returncode><meetingID>${esc(id)}</meetingID><internalMeetingID>${m.internalId}</internalMeetingID><createTime>${m.createTime}</createTime><running>${m.running}</running><startTime>${m.running ? m.createTime : 0}</startTime><endTime>0</endTime><participantCount>${m.attendees.length}</participantCount><moderatorCount>${m.attendees.filter((a) => a.role === 'MODERATOR').length}</moderatorCount><attendees>${attendees}</attendees>`,
        );
      }
      case 'end': {
        if (!m) return xml('<returncode>FAILED</returncode><messageKey>notFound</messageKey>');
        m.running = false;
        m.ended = true;
        return xml('<returncode>SUCCESS</returncode><messageKey>sentEndMeetingRequest</messageKey>');
      }
      case 'getRecordings': {
        const ids = (params.meetingID ?? '').split(',');
        const list = [...recordings.values()].filter((r) => ids.includes(r.meetingID));
        if (list.length === 0) return xml('<returncode>SUCCESS</returncode><recordings></recordings><messageKey>noRecordings</messageKey>');
        return xml(
          `<returncode>SUCCESS</returncode><recordings>${list
            .map(
              (r) =>
                `<recording><recordID>${r.recordID}</recordID><meetingID>${esc(r.meetingID)}</meetingID><name>${esc(r.name)}</name><published>${r.published}</published><state>${r.published ? 'published' : 'unpublished'}</state><startTime>${r.startTime}</startTime><endTime>${r.startTime + r.length * 60_000}</endTime><playback><format><type>presentation</type><url>${esc(r.url)}</url><length>${r.length}</length></format></playback></recording>`,
            )
            .join('')}</recordings>`,
        );
      }
      case 'publishRecordings': {
        for (const rid of (params.recordID ?? '').split(',')) {
          const r = recordings.get(rid);
          if (r) r.published = params.publish === 'true';
        }
        return xml(`<returncode>SUCCESS</returncode><published>${params.publish}</published>`);
      }
      case 'deleteRecordings': {
        for (const rid of (params.recordID ?? '').split(',')) recordings.delete(rid);
        return xml('<returncode>SUCCESS</returncode><deleted>true</deleted>');
      }
      default:
        return xml('<returncode>FAILED</returncode><messageKey>unsupportedRequest</messageKey>');
    }
  });

  return {
    meetings,
    recordings,
    calls,
    get checksumFailures() {
      return checksumFailures;
    },
    set down(value: boolean) {
      down = value;
    },
    /** Someone joined: the meeting runs and has these attendees. */
    run(meetingID: string, attendees: BbbMeeting['attendees']) {
      const m = meetings.get(meetingID);
      if (!m) throw new Error(`No BigBlueButton meeting ${meetingID}`);
      m.running = true;
      m.attendees = attendees;
    },
    finish(meetingID: string) {
      const m = meetings.get(meetingID);
      if (m) {
        m.running = false;
        m.ended = true;
      }
    },
    addRecording(r: Omit<BbbRecording, 'published' | 'startTime' | 'length'> & Partial<BbbRecording>) {
      recordings.set(r.recordID, { published: true, startTime: Date.now() - 3600_000, length: 55, ...r });
    },
    /** The checksum BigBlueButton would compute for a URL Coursekit made (for checking join URLs). */
    verify(url: string): boolean {
      const u = new URL(url);
      const call = u.pathname.split('/').pop()!;
      const raw = u.search.slice(1);
      const at = raw.lastIndexOf('checksum=');
      return (
        raw.slice(at + 9) ===
        createHash(algorithm)
          .update(call + raw.slice(0, at - 1) + secret)
          .digest('hex')
      );
    },
  };
}

/** The JWT BigBlueButton signs for the recording-ready callback (HS256, shared secret). */
export async function bbbRecordingJwt(meetingId: string, recordId: string, secret = BBB_SECRET): Promise<string> {
  return new SignJWT({ meeting_id: meetingId, record_id: recordId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(secret));
}

/** The bearer token of the analytics callback (HS512, shared secret, expiry only). */
export async function bbbAnalyticsJwt(secret = BBB_SECRET, exp = Math.floor(Date.now() / 1000) + 86_400): Promise<string> {
  return new SignJWT({ exp }).setProtectedHeader({ alg: 'HS512', typ: 'JWT' }).sign(new TextEncoder().encode(secret));
}

export const ZOOM = {
  accountId: 'acct-123',
  clientId: 'client-abc',
  clientSecret: 'client-secret-xyz',
  webhookSecret: 'zoom-webhook-secret-token',
  host: 'host@school.test',
};

export interface ZoomMeeting {
  id: number;
  host: string;
  payload: Record<string, any>;
  joinUrl: string;
  deleted: boolean;
  ended: boolean;
}

/** The Zoom OAuth and REST API for one Server-to-Server OAuth app. Start URLs are fresh on every read. */
export function mockZoom(options: { users?: string[] } = {}) {
  const users = new Set(options.users ?? [ZOOM.host, 'other.host@school.test']);
  const tokens = new Set<string>();
  const meetings = new Map<string, ZoomMeeting>();
  const recordings = new Map<string, Record<string, unknown>>();
  const instances = new Map<string, string[]>();
  const participants = new Map<string, Array<Record<string, unknown>>>();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  /** REST methods that answer HTTP 500 for now (Zoom having a bad moment). */
  const failing = new Set<string>();
  let nextId = 81_000_000_000;
  let tokenCount = 0;
  let startCount = 0;
  let reportAvailable = true;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  handlers.push(async (req) => {
    const url = new URL(req.url);
    if (url.origin === 'https://zoom.us' && url.pathname === '/oauth/token') {
      const auth = req.headers.get('authorization') ?? '';
      const body = new URLSearchParams(await req.text());
      const expected = `Basic ${Buffer.from(`${ZOOM.clientId}:${ZOOM.clientSecret}`).toString('base64')}`;
      if (
        req.method !== 'POST' ||
        auth !== expected ||
        body.get('grant_type') !== 'account_credentials' ||
        body.get('account_id') !== ZOOM.accountId
      ) {
        return json({ reason: 'Invalid client_id or client_secret', error: 'invalid_client' }, 401);
      }
      const token = `zoom-access-token-${++tokenCount}`;
      tokens.add(token);
      return json({
        access_token: token,
        token_type: 'bearer',
        expires_in: 3599,
        scope: 'meeting:write:admin',
        api_url: 'https://api.zoom.us',
      });
    }
    if (url.origin !== 'https://api.zoom.us' || !url.pathname.startsWith('/v2/')) return null;
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (!tokens.has(token)) return json({ code: 124, message: 'Invalid access token.' }, 401);
    if (failing.has(req.method)) return json({ code: 500, message: 'Internal error' }, 500);
    const path = url.pathname.slice(3);
    const text = await req.text();
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, path: path + url.search, body });
    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = path.match(/^\/users\/([^/]+)\/meetings$/))) {
      const host = decodeURIComponent(m[1]!);
      if (!users.has(host)) return json({ code: 1001, message: 'User does not exist: ' + host }, 404);
      const id = nextId++;
      const meeting: ZoomMeeting = {
        id,
        host,
        payload: body,
        joinUrl: `https://zoom.test/j/${id}?pwd=pw${id}`,
        deleted: false,
        ended: false,
      };
      meetings.set(String(id), meeting);
      return json(
        {
          id,
          uuid: `uuid-${id}==`,
          host_email: host,
          join_url: meeting.joinUrl,
          start_url: `https://zoom.test/s/${id}?zak=created`,
          password: 'pw',
        },
        201,
      );
    }
    if ((m = path.match(/^\/users\/([^/]+)$/)) && req.method === 'GET') {
      const host = decodeURIComponent(m[1]!);
      return users.has(host) ? json({ id: 'u1', email: host }) : json({ code: 1001, message: 'User does not exist: ' + host }, 404);
    }
    if ((m = path.match(/^\/meetings\/(\d+)$/))) {
      const meeting = meetings.get(m[1]!);
      if (!meeting || meeting.deleted) return json({ code: 3001, message: 'Meeting does not exist: ' + m[1] }, 404);
      if (req.method === 'PATCH') {
        meeting.payload = { ...meeting.payload, ...body, settings: { ...meeting.payload.settings, ...body.settings } };
        return new Response(null, { status: 204 });
      }
      if (req.method === 'DELETE') {
        meeting.deleted = true;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET') {
        return json({
          id: meeting.id,
          join_url: meeting.joinUrl,
          start_url: `https://zoom.test/s/${meeting.id}?zak=fresh-${++startCount}`,
        });
      }
    }
    if ((m = path.match(/^\/meetings\/(\d+)\/status$/)) && req.method === 'PUT') {
      const meeting = meetings.get(m[1]!);
      if (!meeting) return json({ code: 3001, message: 'Meeting does not exist' }, 404);
      meeting.ended = true;
      return new Response(null, { status: 204 });
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/recordings$/))) {
      const key = decodeURIComponent(decodeURIComponent(m[1]!));
      if (req.method === 'DELETE') {
        recordings.delete(key);
        return new Response(null, { status: 204 });
      }
      const rec = recordings.get(key);
      return rec ? json(rec) : json({ code: 3301, message: 'This recording does not exist.' }, 404);
    }
    if ((m = path.match(/^\/past_meetings\/(\d+)\/instances$/))) {
      return json({ meetings: (instances.get(m[1]!) ?? []).map((uuid) => ({ uuid, start_time: new Date().toISOString() })) });
    }
    if ((m = path.match(/^\/report\/meetings\/([^/]+)\/participants$/))) {
      if (!reportAvailable) return json({ code: 4711, message: 'Invalid access token, does not contain scopes:[report:read:admin].' }, 400);
      const key = decodeURIComponent(decodeURIComponent(m[1]!));
      return json({ participants: participants.get(key) ?? [], next_page_token: '', total_records: (participants.get(key) ?? []).length });
    }
    return json({ code: 300, message: 'Unsupported in the mock' }, 400);
  });

  return {
    /** Users of the Zoom account (hosts meetings can be created for). */
    users,
    failing,
    meetings,
    recordings,
    instances,
    participants,
    calls,
    tokens,
    set reportAvailable(value: boolean) {
      reportAvailable = value;
    },
    live(): ZoomMeeting[] {
      return [...meetings.values()].filter((m) => !m.deleted);
    },
  };
}

/** Signs a Zoom webhook body the way Zoom does. */
export function zoomSignature(body: string, timestamp = String(Math.floor(Date.now() / 1000)), secret = ZOOM.webhookSecret) {
  return {
    'x-zm-request-timestamp': timestamp,
    'x-zm-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
  };
}

export async function zoomWebhook(lms: Coursekit, body: unknown, headers?: Record<string, string>) {
  const text = JSON.stringify(body);
  const res = await lms.app.request('/live/zoom/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? zoomSignature(text)) },
    body: text,
  });
  const out = await res.text();
  return { status: res.status, body: out ? JSON.parse(out) : null };
}

/** A request as the browser sends it, returning the raw Response (redirects aren't followed). */
export async function browser(
  lms: Coursekit,
  as: Client | null,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return lms.app.request(path, {
    method: init.method ?? 'GET',
    headers: { ...(as?.cookie ? { cookie: as.cookie } : {}), ...(init.headers ?? {}) },
    body: init.body,
  });
}

/** DELETE with the Origin header CSRF protection wants (the shared client sends none). */
export async function del(lms: Coursekit, as: Client, path: string): Promise<{ status: number; body: any }> {
  const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: as.cookie, origin: 'http://localhost' } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A Kysely plugin that records the rows of each INSERT into a table, one list per statement: what PostgreSQL gets in
 * one statement (it refuses an INSERT ... ON CONFLICT DO UPDATE that would change one row twice; SQLite doesn't).
 */
export function captureInserts(table: string) {
  const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (InsertQueryNode.is(node) && node.into && camel(node.into.table.identifier.name) === camel(table) && node.values) {
        if (ValuesNode.is(node.values)) {
          const columns = (node.columns ?? []).map((c) => camel(c.column.name));
          inserts.push(
            node.values.values.map((row) => {
              const values = PrimitiveValueListNode.is(row) ? row.values : row.values.map((v) => (ValueNode.is(v) ? v.value : undefined));
              return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
            }),
          );
        }
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { plugin, inserts };
}

/** Stops the instance's background worker, so a test decides when the work runs (with runWorker). */
export async function quietWorker(lms: Coursekit): Promise<void> {
  await liveWorkerFor(lms.events)?.stop();
}

/** Runs the background worker once (reminders, provider meetings, polling, follow-ups). */
export function runWorker(lms: Coursekit, nowMs = Date.now()) {
  return runLiveMaintenance({ db: lms.db, events: lms.events, config: lms.config, version: lms.version }, nowMs);
}

export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export async function createLiveClass(
  teacher: Client,
  courseId: string,
  sectionId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const { settings, ...rest } = body as { settings?: Record<string, unknown> };
  const res = await teacher.post(`/api/courses/${courseId}/activities`, {
    sectionId,
    type: 'live',
    title: 'Weekly seminar',
    settings: { provider: 'link', meetingUrl: 'https://meet.example.com/abc-defg-hij', ...settings },
    ...rest,
  });
  if (res.status !== 201) throw new Error(`Couldn't create the live class: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function schedule(teacher: Client, activityId: string, body: Record<string, unknown>): Promise<string[]> {
  const res = await teacher.post(`/api/live/activities/${activityId}/sessions`, {
    durationMinutes: 60,
    timeZone: 'Europe/London',
    ...body,
  });
  if (res.status !== 201) throw new Error(`Couldn't schedule: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.ids;
}
