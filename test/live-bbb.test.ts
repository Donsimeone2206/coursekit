import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveClassInfo, LiveSessionAttendance } from '../src/shared/live.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { bbbApiBase, bbbChecksum, bbbUrl } from '../src/server/services/live/bbb.js';
import { loadLiveConfig } from '../src/server/services/live/config.js';
import { pollRoom } from '../src/server/services/live/worker.js';
import { PASSWORD, setupSchool, type Client } from './helpers.js';
import {
  BBB_API,
  BBB_SECRET,
  BBB_URL,
  bbbAnalyticsJwt,
  bbbRecordingJwt,
  browser,
  captureInserts,
  createLiveClass,
  del,
  inMinutes,
  installFetch,
  mockBbb,
  runWorker,
  schedule,
  quietWorker,
  uninstallFetch,
} from './live-helpers.js';

const PUBLIC = 'https://lms.test';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let bbb: ReturnType<typeof mockBbb>;
let ids: Record<'teacher' | 'sam' | 'kim', string>;

const idOf = async (client: Client): Promise<string> => (await client.get('/api/auth/session')).body.user.id;
const info = async (as: Client, activityId: string) => (await as.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;

beforeEach(async () => {
  installFetch();
  bbb = mockBbb();
  lms = await createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
    webDir: false,
    publicUrl: PUBLIC,
  });
  await quietWorker(lms);
  school = await setupSchool(lms);
  await school.teacher.post(`/api/courses/${school.course.id}/participants`, { emails: ['sam@test.dev', 'kim@test.dev'] });
  ids = { teacher: await idOf(school.teacher), sam: await idOf(school.sam), kim: await idOf(school.kim) };
  const saved = await school.admin.put('/api/admin/live', { bbb: { enabled: true, url: BBB_URL, secret: BBB_SECRET } });
  expect(saved.status).toBe(200);
});

afterEach(async () => {
  await lms.close();
  uninstallFetch();
});

async function bbbClass(settings: Record<string, unknown> = {}, startsIn = 2) {
  const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
    settings: { provider: 'bbb', ...settings },
  });
  const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(startsIn) });
  return { activity, sessionId: sessionId! };
}

const params = (location: string | null) => Object.fromEntries(new URL(location!).searchParams);
const created = () => bbb.calls.filter((c) => c.call === 'create');
const callbackPath = (url: string) => new URL(url).pathname;

describe('BigBlueButton API', () => {
  it('computes checksums over the exact query with the configured algorithm', () => {
    expect(bbbApiBase('https://bbb.example.edu')).toBe('https://bbb.example.edu/bigbluebutton/api');
    expect(bbbApiBase('https://bbb.example.edu/bigbluebutton/')).toBe('https://bbb.example.edu/bigbluebutton/api');
    expect(bbbApiBase('https://bbb.example.edu/bigbluebutton/api/')).toBe('https://bbb.example.edu/bigbluebutton/api');
    // The example from the BigBlueButton documentation.
    expect(
      bbbChecksum(
        'create',
        'name=Test+Meeting&meetingID=abc123&attendeePW=111222&moderatorPW=333444',
        '639259d4-9dd8-4b25-bf01-95f9567eaf4b',
        'sha1',
      ),
    ).toBe('1fcbb0c4fc1f039f73aa6d697d2db9ba7f803f17');
    for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
      const url = new URL(bbbUrl({ api: BBB_API, secret: 's3cret', algorithm }, 'isMeetingRunning', { meetingID: 'a b&c' }));
      const raw = url.search.slice(1);
      const query = raw.slice(0, raw.lastIndexOf('&checksum='));
      expect(url.searchParams.get('checksum')).toBe(bbbChecksum('isMeetingRunning', query, 's3cret', algorithm));
      expect(url.searchParams.get('checksum')).toHaveLength({ sha1: 40, sha256: 64, sha384: 96, sha512: 128 }[algorithm]);
    }
  });

  it('tests the connection, and says to check the secret when the checksum is refused', async () => {
    const ok = await school.admin.post('/api/admin/live/bbb/test');
    expect(ok.status).toBe(200);
    expect(ok.body.message).toContain('Connected to BigBlueButton');
    await school.admin.put('/api/admin/live', { bbb: { secret: 'the-wrong-secret' } });
    const bad = await school.admin.post('/api/admin/live/bbb/test');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('check the shared secret and the checksum algorithm');
    expect(JSON.stringify(bad.body)).not.toContain('the-wrong-secret');
    expect((await school.teacher.post('/api/admin/live/bbb/test')).status).toBe(403);
  });

  it('works with SHA-512 checksums when the server is set up for them', async () => {
    uninstallFetch();
    installFetch();
    bbb = mockBbb({ algorithm: 'sha512' });
    expect((await school.admin.post('/api/admin/live/bbb/test')).status).toBe(400);
    await school.admin.put('/api/admin/live', { bbb: { algorithm: 'sha512' } });
    expect((await school.admin.post('/api/admin/live/bbb/test')).status).toBe(200);
    const { sessionId } = await bbbClass();
    const res = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    expect(bbb.verify(res.headers.get('location')!)).toBe(true);
  });
});

describe('joining a BigBlueButton class', () => {
  it('creates the meeting with the class details and signed callbacks, and joins staff as moderators', async () => {
    const { activity, sessionId } = await bbbClass({ recording: 'auto', welcomeMessage: 'Hello, class!' });
    const res = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith(`${BBB_API}/join?`)).toBe(true);
    expect(bbb.verify(location)).toBe(true);
    const join = params(location);
    const [create] = created();
    const meeting = bbb.meetings.get(create!.params.meetingID!)!;
    expect(join).toMatchObject({
      fullName: 'Tina Teacher',
      role: 'MODERATOR',
      userID: ids.teacher,
      meetingID: create!.params.meetingID,
      createTime: meeting.createTime,
    });
    // No meeting passwords: BigBlueButton 2.4+ takes the role, and no stored secret reaches the browser.
    expect(join.password).toBeUndefined();
    expect(create!.params.moderatorPW).toBeUndefined();
    expect(create!.params.attendeePW).toBeUndefined();
    expect(create!.params).toMatchObject({
      name: 'Weekly seminar',
      record: 'true',
      autoStartRecording: 'true',
      allowStartStopRecording: 'true',
      welcome: 'Hello, class!',
      logoutURL: `${PUBLIC}/courses/${school.course.slug}/activities/${activity}`,
      'meta_bbb-origin': 'Coursekit',
    });
    expect(create!.params.meetingID).toMatch(/^ck[0-9a-z]{30}$/);
    expect(create!.params.meetingEndedURL).toMatch(new RegExp(`^${PUBLIC}/live/bbb/[^/]+/ended$`));
    // Not the legacy meta_endCallbackUrl: meta_* values can be shown to people in the meeting.
    expect(create!.params.meta_endCallbackUrl).toBeUndefined();
    expect(create!.params['meta_bbb-recording-ready-url']).toMatch(/\/recording$/);
    expect(create!.params['meta_analytics-callback-url']).toMatch(/\/analytics$/);
    // BigBlueButton only sends the analytics callback for meetings that keep their events.
    expect(create!.params.meetingKeepEvents).toBe('true');
    // Each callback has its own signature.
    expect(
      new Set(
        [create!.params.meetingEndedURL, create!.params['meta_bbb-recording-ready-url'], create!.params['meta_analytics-callback-url']].map(
          (u) => u!.split('/')[5],
        ),
      ).size,
    ).toBe(3);
    expect(JSON.stringify(create!.params)).not.toContain(BBB_SECRET);

    // No recording: record=false and no controls.
    const other = await bbbClass({ recording: 'off' });
    await browser(lms, school.teacher, `/live/join/${other.sessionId}`);
    expect(created()[1]!.params).toMatchObject({
      record: 'false',
      autoStartRecording: 'false',
      allowStartStopRecording: 'false',
      meetingKeepEvents: 'true',
    });
  });

  it('leaves out the analytics callback, and the events BigBlueButton keeps for it, when an administrator turns it off', async () => {
    const saved = await school.admin.put('/api/admin/live', { bbb: { analytics: false } });
    expect(saved.body.bbb).toMatchObject({ analytics: false, ready: true });
    const { sessionId } = await bbbClass();
    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const [create] = created();
    expect(create!.params['meta_analytics-callback-url']).toBeUndefined();
    expect(create!.params.meetingKeepEvents).toBeUndefined();
    expect(create!.params.meetingEndedURL).toMatch(/\/ended$/);
    expect(create!.params['meta_bbb-recording-ready-url']).toMatch(/\/recording$/);
  });

  it('makes students wait for a moderator, then joins them as viewers', async () => {
    const { activity, sessionId } = await bbbClass();
    const waiting = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(waiting.status).toBe(200);
    expect(await waiting.text()).toContain('Waiting for your teacher');
    expect(created()).toHaveLength(0);
    expect((await info(school.sam, activity)).sessions[0]!.attendance?.status).toBeNull();

    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const meetingID = created()[0]!.params.meetingID!;
    bbb.run(meetingID, [{ userID: ids.teacher, fullName: 'Tina Teacher', role: 'MODERATOR' }]);
    const res = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    const join = params(res.headers.get('location'));
    expect(join).toMatchObject({
      role: 'VIEWER',
      userID: ids.sam,
      fullName: 'Sam Student',
      meetingID,
    });
    // Students never get moderator rights, whatever they ask for.
    expect(params((await browser(lms, school.sam, `/live/join/${sessionId}?as=participant`)).headers.get('location')).role).toBe('VIEWER');
  });

  it('lets students start the meeting when they may join before a moderator', async () => {
    const { sessionId } = await bbbClass({ waitForModerator: false });
    const res = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    expect(created()).toHaveLength(1);
    expect(params(res.headers.get('location')).role).toBe('VIEWER');
  });

  it('gives staff the reason when BigBlueButton is unreachable, and students a plain message', async () => {
    const { sessionId } = await bbbClass();
    bbb.down = true;
    const staff = await (await browser(lms, school.teacher, `/live/join/${sessionId}`)).text();
    expect(staff).toContain('reach BigBlueButton at bbb.test');
    const student = await (await browser(lms, school.sam, `/live/join/${sessionId}`)).text();
    expect(student).toContain('couldn’t be opened right now');
    for (const page of [staff, student]) {
      expect(page).not.toContain(BBB_SECRET);
      expect(page).not.toContain('checksum');
    }
  });
});

describe('BigBlueButton callbacks and attendance', () => {
  async function running() {
    const { activity, sessionId } = await bbbClass({}, -5);
    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const create = created()[0]!.params;
    bbb.run(create.meetingID!, [{ userID: ids.teacher, fullName: 'Tina Teacher', role: 'MODERATOR' }]);
    return { activity, sessionId, create, meetingID: create.meetingID! };
  }

  it('checks with BigBlueButton before taking "meeting ended" as fact', async () => {
    const { create, meetingID } = await running();
    const path = callbackPath(create.meetingEndedURL!);
    const checks = () => bbb.calls.filter((c) => c.call === 'isMeetingRunning').length;
    const first = await browser(lms, null, `${path}?meetingID=${meetingID}&recordingmarks=false`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: 'running' });
    // Anyone in the meeting can see the address, so BigBlueButton is asked at most every 10 seconds.
    expect((await browser(lms, null, path)).status).toBe(429);
    expect(checks()).toBe(1);
    const tampered = path.replace(/\/ended$/, '').slice(0, -2) + 'xx/ended';
    expect((await browser(lms, null, tampered)).status).toBe(404);
    // A token for another purpose doesn't work here.
    const recordingToken = callbackPath(create['meta_bbb-recording-ready-url']!).split('/')[3];
    expect((await browser(lms, null, `/live/bbb/${recordingToken}/ended`)).status).toBe(404);
    bbb.finish(meetingID);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      expect(await (await browser(lms, null, path)).json()).toMatchObject({ state: 'ended' });
    } finally {
      vi.useRealTimers();
    }
    // Known to have ended: answered without asking BigBlueButton again.
    expect(await (await browser(lms, null, path, { method: 'POST' })).json()).toMatchObject({ state: 'ended' });
    expect(checks()).toBe(2);
    const room = await lms.db.selectFrom('liveRooms').selectAll().where('roomKey', '=', meetingID).executeTakeFirstOrThrow();
    expect(room.endedAt).not.toBeNull();
  });

  it('accepts the recording-ready callback only when BigBlueButton signed it, and reads the recording from the API', async () => {
    const { activity, create, meetingID } = await running();
    bbb.addRecording({ recordID: 'rec-1', meetingID, name: 'Weekly seminar', url: 'https://bbb.test/playback/presentation/2.3/rec-1' });
    const path = callbackPath(create['meta_bbb-recording-ready-url']!);
    const post = (signed: string, to = path) =>
      browser(lms, null, to, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ signed_parameters: signed }).toString(),
      });
    expect((await post(await bbbRecordingJwt(meetingID, 'rec-1', 'not-the-secret-0123456789abcdef'))).status).toBe(401);
    expect((await post(await bbbRecordingJwt('another-meeting', 'rec-1'))).status).toBe(401);
    expect((await post('not-a-jwt')).status).toBe(401);
    expect((await info(school.sam, activity)).sessions[0]!.recordings).toEqual([]);
    expect((await post(await bbbRecordingJwt(meetingID, 'rec-1'))).status).toBe(200);
    expect((await post(await bbbRecordingJwt(meetingID, 'rec-1'))).status).toBe(200);
    const recordings = (await info(school.sam, activity)).sessions[0]!.recordings;
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ source: 'bbb', url: 'https://bbb.test/playback/presentation/2.3/rec-1', durationMinutes: 55 });

    // Staff hide it (unpublished at BigBlueButton) and remove it (deleted there); it doesn't come back.
    const id = recordings[0]!.id;
    expect((await school.teacher.patch(`/api/live/recordings/${id}`, { hidden: true })).status).toBe(200);
    expect(bbb.recordings.get('rec-1')!.published).toBe(false);
    expect((await info(school.sam, activity)).sessions[0]!.recordings).toEqual([]);
    expect((await del(lms, school.teacher, `/api/live/recordings/${id}`)).status).toBe(200);
    expect(bbb.recordings.has('rec-1')).toBe(false);
    bbb.addRecording({ recordID: 'rec-1', meetingID, name: 'Weekly seminar', url: 'https://bbb.test/playback/presentation/2.3/rec-1' });
    expect((await post(await bbbRecordingJwt(meetingID, 'rec-1'))).status).toBe(200);
    expect((await info(school.teacher, activity)).sessions[0]!.recordings).toEqual([]);
  });

  it('takes exact attendance from the signed analytics callback', async () => {
    const { activity, sessionId, create, meetingID } = await running();
    const start = Date.now() - 50 * 60_000;
    const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
    const body = JSON.stringify({
      version: '1.0',
      meeting_id: meetingID,
      internal_meeting_id: 'int-1',
      data: {
        metadata: { meeting_name: 'Weekly seminar' },
        duration: 3000,
        start: at(0),
        finish: at(50),
        attendees: [
          { ext_user_id: ids.sam, name: 'Sam Student', moderator: false, joins: [at(1), at(30)], leaves: [at(20), at(45)], duration: 2100 },
          { ext_user_id: ids.teacher, name: 'Tina Teacher', moderator: true, joins: [at(0)], leaves: [at(50)], duration: 3000 },
          { ext_user_id: 'w_guest123', name: 'A visitor', moderator: false, joins: [at(5)], leaves: [at(10)] },
        ],
        files: [],
        polls: [],
      },
    });
    const path = callbackPath(create['meta_analytics-callback-url']!);
    const post = (authorization?: string) =>
      browser(lms, null, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
        body,
      });
    expect((await post()).status).toBe(401);
    expect((await post(`Bearer ${await bbbAnalyticsJwt('not-the-secret-0123456789abcdef')}`)).status).toBe(401);
    expect((await post(`Bearer ${await bbbAnalyticsJwt(BBB_SECRET, Math.floor(Date.now() / 1000) - 60)}`)).status).toBe(401);
    const token = `Bearer ${await bbbAnalyticsJwt()}`;
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);

    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${sessionId}/attendance`)).body;
    expect(list.rows.find((r) => r.user.id === ids.sam)).toMatchObject({
      status: 'present',
      source: 'provider',
      minutes: 34,
      joinedAt: at(1),
      leftAt: at(45),
    });
    expect(list.rows.find((r) => r.user.id === ids.kim)).toMatchObject({ status: 'absent', minutes: null });
    expect(list.guests).toEqual([{ name: 'A visitor', joinedAt: at(5), minutes: 5 }]);
    expect((await info(school.sam, activity)).sessions[0]!.attendance).toMatchObject({ status: 'present', minutes: 34 });
    // The session is still on, so Kim isn't absent yet.
    expect((await info(school.kim, activity)).sessions[0]!.attendance).toMatchObject({ status: null });
  });

  it('watches running meetings for who is in the room', async () => {
    const { sessionId, meetingID } = await running();
    bbb.run(meetingID, [
      { userID: ids.teacher, fullName: 'Tina Teacher', role: 'MODERATOR' },
      { userID: ids.kim, fullName: 'Kim Student', role: 'VIEWER' },
      { userID: 'w_abc', fullName: 'Dial-in caller', role: 'VIEWER' },
    ]);
    expect((await runWorker(lms)).polled).toBe(1);
    // The next poll waits about a minute.
    expect((await runWorker(lms)).polled).toBe(0);
    expect((await runWorker(lms, Date.now() + 60_000)).polled).toBe(1);
    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${sessionId}/attendance`)).body;
    expect(list.rows.find((r) => r.user.id === ids.kim)).toMatchObject({ status: 'present', source: 'provider' });
    expect(list.guests.map((g) => g.name)).toEqual(['Dial-in caller']);

    bbb.finish(meetingID);
    await runWorker(lms, Date.now() + 2 * 60_000);
    const room = await lms.db.selectFrom('liveRooms').selectAll().where('roomKey', '=', meetingID).executeTakeFirstOrThrow();
    expect(room.endedAt).not.toBeNull();
    expect(room.nextFollowUpAt).not.toBeNull();
  });

  it('ends a class for everyone, and only staff can', async () => {
    const { activity, sessionId, meetingID } = await running();
    expect((await info(school.teacher, activity)).canEndForEveryone).toBe(true);
    expect((await info(school.sam, activity)).canEndForEveryone).toBe(false);
    expect((await school.sam.post(`/api/live/sessions/${sessionId}/end`, {})).status).toBe(403);
    const res = await school.teacher.post(`/api/live/sessions/${sessionId}/end`, {});
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(1);
    expect(bbb.calls.some((c) => c.call === 'end' && c.params.meetingID === meetingID)).toBe(true);
    expect(bbb.meetings.get(meetingID)!.ended).toBe(true);
  });

  it('fetches recordings after a session when no callback came', async () => {
    const { activity, meetingID } = await running();
    bbb.addRecording({
      recordID: 'rec-late',
      meetingID,
      name: 'Weekly seminar',
      url: 'https://bbb.test/playback/presentation/2.3/rec-late',
    });
    expect((await runWorker(lms, Date.now() + 2 * 3600_000)).followedUp).toBe(1);
    expect((await info(school.sam, activity)).sessions[0]!.recordings.map((r) => r.url)).toEqual([
      'https://bbb.test/playback/presentation/2.3/rec-late',
    ]);
  });

  it('keeps fetching recordings when many rooms of a provider that is no longer set up are still due', async () => {
    // Twenty past sessions that met on Zoom, which isn't set up now: their rooms stay due until it is again.
    const old = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const past = await schedule(school.teacher, old, { startsAt: inMinutes(-30 * 24 * 60), repeat: { frequency: 'daily', count: 20 } });
    const ts = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    await lms.db
      .insertInto('liveRooms')
      .values(
        past.map((sessionId, i) => ({
          id: `zoom-room-${i}`,
          sessionId,
          activityId: old,
          courseId: school.course.id,
          provider: 'zoom' as const,
          roomKey: `zoom-room-key-${i}`,
          externalId: String(81_000_000_000 + i),
          startedAt: ts,
          endedAt: ts,
          nextFollowUpAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })),
      )
      .execute();
    const { activity, meetingID } = await running();
    bbb.addRecording({
      recordID: 'rec-behind',
      meetingID,
      name: 'Weekly seminar',
      url: 'https://bbb.test/playback/presentation/2.3/rec-behind',
    });
    expect((await runWorker(lms, Date.now() + 2 * 3600_000)).followedUp).toBe(1);
    expect(bbb.calls.some((c) => c.call === 'getRecordings')).toBe(true);
    expect((await info(school.sam, activity)).sessions[0]!.recordings.map((r) => r.url)).toEqual([
      'https://bbb.test/playback/presentation/2.3/rec-behind',
    ]);
    const zoomRooms = await lms.db.selectFrom('liveRooms').select('followUpCount').where('provider', '=', 'zoom').execute();
    expect(zoomRooms.map((r) => r.followUpCount)).toEqual(Array(20).fill(0));
  });

  it('ends the meeting and forgets its rooms when the class is deleted', async () => {
    const { activity, meetingID } = await running();
    expect((await del(lms, school.teacher, `/api/activities/${activity}`)).status).toBe(200);
    await runWorker(lms);
    expect(bbb.calls.some((c) => c.call === 'end' && c.params.meetingID === meetingID)).toBe(true);
    expect(await lms.db.selectFrom('liveRooms').selectAll().execute()).toEqual([]);
    // Callbacks for the deleted class: gone.
    const create = created()[0]!.params;
    expect((await browser(lms, null, callbackPath(create.meetingEndedURL!))).status).toBe(410);
  });

  it('leaves the callbacks out without a public URL', async () => {
    const local = await createCoursekit({
      databaseUrl: 'sqlite::memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
      webDir: false,
    });
    try {
      const s = await setupSchool(local);
      await s.admin.put('/api/admin/live', { bbb: { enabled: true, url: BBB_URL, secret: BBB_SECRET } });
      const activity = await createLiveClass(s.teacher, s.course.id, s.sectionId, { settings: { provider: 'bbb' } });
      const [sessionId] = await schedule(s.teacher, activity, { startsAt: inMinutes(1) });
      const before = created().length;
      expect((await browser(local, s.teacher, `/live/join/${sessionId}`)).status).toBe(302);
      const create = created()[before]!.params;
      expect(create.meetingEndedURL).toBeUndefined();
      expect(create['meta_analytics-callback-url']).toBeUndefined();
      expect(create.meetingKeepEvents).toBeUndefined();
      // Everyone leaving the meeting is sent to the logout URL, so it only comes from the public URL.
      expect(create.logoutURL).toBeUndefined();

      // Not from the Host header of whoever creates the meeting: a student, when students don't wait for a teacher.
      await s.teacher.post(`/api/courses/${s.course.id}/participants`, { emails: ['sam@test.dev'] });
      const open = await createLiveClass(s.teacher, s.course.id, s.sectionId, { settings: { provider: 'bbb', waitForModerator: false } });
      const [openSession] = await schedule(s.teacher, open, { startsAt: inMinutes(1) });
      const n = created().length;
      const forged = await local.app.request(`http://evil.example/live/join/${openSession}`, { headers: { cookie: s.sam.cookie } });
      expect(forged.status).toBe(302);
      expect(created()[n]!.params.logoutURL).toBeUndefined();
      expect(JSON.stringify(created()[n]!.params)).not.toContain('evil.example');
      expect(PASSWORD).toBeTruthy();
    } finally {
      await local.close();
    }
  });

  it('records each person once when BigBlueButton lists them twice (PostgreSQL refuses repeats in one statement)', async () => {
    const { sessionId, meetingID } = await running();
    // BigBlueButton lists every connection: Kim on a laptop and a phone, and two dial-in callers with the same name.
    bbb.run(meetingID, [
      { userID: ids.teacher, fullName: 'Tina Teacher', role: 'MODERATOR' },
      { userID: ids.kim, fullName: 'Kim Student', role: 'VIEWER' },
      { userID: ids.kim, fullName: 'Kim Student', role: 'VIEWER' },
      { userID: 'w_1', fullName: 'Caller', role: 'VIEWER' },
      { userID: 'w_2', fullName: 'Caller', role: 'VIEWER' },
    ]);
    const { plugin, inserts } = captureInserts('livePresence');
    const room = await lms.db.selectFrom('liveRooms').selectAll().where('roomKey', '=', meetingID).executeTakeFirstOrThrow();
    const deps = { db: lms.db.withPlugin(plugin), events: lms.events, config: lms.config, version: lms.version };
    await pollRoom(deps, await loadLiveConfig(lms.db), room);
    await pollRoom(deps, await loadLiveConfig(lms.db), room);
    expect(inserts).toHaveLength(2);
    for (const rows of inserts) {
      const keys = rows.map((r) => `${r.sessionId} ${r.source} ${r.sourceKey}`);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${sessionId}/attendance`)).body;
    expect(list.rows.find((r) => r.user.id === ids.kim)).toMatchObject({ status: 'present', source: 'provider' });
    expect(list.guests.map((g) => g.name)).toEqual(['Caller']);
  });
});
