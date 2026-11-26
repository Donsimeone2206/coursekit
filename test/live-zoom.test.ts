import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveClassInfo, LiveSessionAttendance } from '../src/shared/live.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { clearZoomTokens, encodeZoomUuid } from '../src/server/services/live/zoom.js';
import { login, PASSWORD, setupSchool, type Client } from './helpers.js';
import {
  browser,
  createLiveClass,
  del,
  inMinutes,
  installFetch,
  mockZoom,
  runWorker,
  schedule,
  quietWorker,
  uninstallFetch,
  ZOOM,
  zoomSignature,
  zoomWebhook,
} from './live-helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let zoom: ReturnType<typeof mockZoom>;
let ids: Record<'teacher' | 'sam' | 'kim', string>;

const idOf = async (client: Client): Promise<string> => (await client.get('/api/auth/session')).body.user.id;
const info = async (as: Client, activityId: string) => (await as.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;

beforeEach(async () => {
  installFetch();
  clearZoomTokens();
  zoom = mockZoom();
  lms = await createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
    webDir: false,
    publicUrl: 'https://lms.test',
  });
  await quietWorker(lms);
  school = await setupSchool(lms);
  await school.teacher.post(`/api/courses/${school.course.id}/participants`, { emails: ['sam@test.dev', 'kim@test.dev'] });
  ids = { teacher: await idOf(school.teacher), sam: await idOf(school.sam), kim: await idOf(school.kim) };
  const saved = await school.admin.put('/api/admin/live', {
    zoom: {
      enabled: true,
      accountId: ZOOM.accountId,
      clientId: ZOOM.clientId,
      clientSecret: ZOOM.clientSecret,
      webhookSecret: ZOOM.webhookSecret,
      defaultHost: ZOOM.host,
    },
  });
  expect(saved.status).toBe(200);
  expect(saved.body.zoomWebhookUrl).toBe('https://lms.test/live/zoom/webhook');
  expect(saved.body.zoom.note).toBeNull();
});

afterEach(async () => {
  await lms.close();
  uninstallFetch();
});

async function zoomClass(settings: Record<string, unknown> = {}, startsIn = 2) {
  const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
    settings: { provider: 'zoom', ...settings },
  });
  const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(startsIn), title: 'Week 1' });
  return { activity, sessionId: sessionId! };
}

describe('Zoom API', () => {
  it('gets an access token with the app’s credentials, reuses it, and explains a refusal without the secret', async () => {
    const res = await school.admin.post('/api/admin/live/zoom/test');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Connected to Zoom. Meetings will be hosted by host@school.test.');
    await school.admin.post('/api/admin/live/zoom/test');
    expect(zoom.tokens.size).toBe(1);

    await school.admin.put('/api/admin/live', { zoom: { clientSecret: 'a-wrong-client-secret' } });
    const bad = await school.admin.post('/api/admin/live/zoom/test');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('Zoom rejected the app’s credentials');
    expect(JSON.stringify(bad.body)).not.toContain('a-wrong-client-secret');

    await school.admin.put('/api/admin/live', { zoom: { clientSecret: ZOOM.clientSecret, defaultHost: 'nobody@school.test' } });
    const host = await school.admin.post('/api/admin/live/zoom/test');
    expect(host.body.error.message).toContain('Zoom has no user nobody@school.test');
    expect(encodeZoomUuid('/abc==')).toBe('%252Fabc%253D%253D');
    expect(encodeZoomUuid('abc==')).toBe('abc%3D%3D');
  });

  it('creates meetings for the next two weeks and keeps them in step with the sessions', async () => {
    const { activity, sessionId } = await zoomClass({}, 48 * 60);
    const [far] = await schedule(school.teacher, activity, { startsAt: inMinutes(30 * 24 * 60) });
    expect((await runWorker(lms)).synced).toBe(1);
    const [meeting] = zoom.live();
    expect(meeting!.host).toBe(ZOOM.host);
    expect(meeting!.payload).toMatchObject({
      topic: 'Weekly seminar: Week 1',
      type: 2,
      duration: 60,
      timezone: 'Europe/London',
      settings: { join_before_host: false, auto_recording: 'none', waiting_room: false },
    });
    expect(meeting!.payload.start_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // Nothing changed: nothing is sent.
    const calls = zoom.calls.length;
    expect((await runWorker(lms)).synced).toBe(0);
    expect(zoom.calls.length).toBe(calls);

    const moved = inMinutes(49 * 60);
    await school.teacher.patch(`/api/live/sessions/${sessionId}`, { startsAt: moved, durationMinutes: 90 });
    await school.teacher.patch(`/api/activities/${activity}`, {
      title: 'Seminar',
      settings: { recording: 'auto', waitForModerator: false },
    });
    expect((await runWorker(lms)).synced).toBe(1);
    expect(zoom.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(meeting!.payload).toMatchObject({
      topic: 'Seminar: Week 1',
      duration: 90,
      start_time: moved.replace(/\.\d{3}Z$/, 'Z'),
      settings: { join_before_host: true, auto_recording: 'cloud' },
    });

    await school.teacher.post(`/api/live/sessions/${sessionId}/cancel`);
    await runWorker(lms);
    expect(meeting!.deleted).toBe(true);
    expect(zoom.live()).toHaveLength(0);
    expect(far).toBeTruthy();
  });

  it('deletes the meetings of a deleted class', async () => {
    const { activity } = await zoomClass();
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(1);
    expect((await del(lms, school.teacher, `/api/activities/${activity}`)).status).toBe(200);
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(0);
    expect(await lms.db.selectFrom('liveRooms').selectAll().execute()).toEqual([]);
  });

  it('deletes the meetings of a deleted section or course', async () => {
    const base = `/api/courses/${school.course.id}`;
    const section = (await school.teacher.post(`${base}/sections`, { title: 'Extra' })).body.id;
    const inSection = await createLiveClass(school.teacher, school.course.id, section, { settings: { provider: 'zoom' } });
    await schedule(school.teacher, inSection, { startsAt: inMinutes(60) });
    await zoomClass();
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(2);
    expect((await del(lms, school.teacher, `${base}/sections/${section}`)).status).toBe(200);
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(1);
    expect((await del(lms, school.teacher, base)).status).toBe(200);
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(0);
    expect(await lms.db.selectFrom('liveRooms').selectAll().execute()).toEqual([]);
  });

  it('moves meetings to the class’s own host, and shows staff when Zoom refuses', async () => {
    // A host an administrator shared, so the teacher may pick it.
    await school.admin.put('/api/admin/live', { zoom: { hosts: ['other.host@school.test'] } });
    const { activity, sessionId } = await zoomClass({ zoomHost: 'other.host@school.test' });
    await runWorker(lms);
    expect(zoom.live().map((m) => m.host)).toEqual(['other.host@school.test']);
    await school.teacher.patch(`/api/activities/${activity}`, { settings: { zoomHost: null } });
    await runWorker(lms);
    expect(zoom.live().map((m) => m.host)).toEqual([ZOOM.host]);
    expect((await school.sam.get(`/api/activities/${activity}`)).body.settings.zoomHost).toBeNull();

    // Only an administrator can name a Zoom user who isn't one of the site's hosts.
    expect((await school.teacher.patch(`/api/activities/${activity}`, { settings: { zoomHost: 'nobody@school.test' } })).status).toBe(400);
    expect((await school.admin.patch(`/api/activities/${activity}`, { settings: { zoomHost: 'nobody@school.test' } })).status).toBe(200);
    await runWorker(lms);
    const staff = (await info(school.teacher, activity)).sessions.find((s) => s.id === sessionId)!;
    expect(staff.syncError).toContain('Zoom has no user nobody@school.test');
    expect((await info(school.sam, activity)).sessions[0]!.syncError).toBeUndefined();
    // The new meeting is created before the old one is deleted, so when Zoom refuses, the old one still works.
    const [kept] = zoom.live();
    expect(kept!.host).toBe(ZOOM.host);
    const calls = zoom.calls.length;
    expect((await browser(lms, school.sam, `/live/join/${sessionId}`)).headers.get('location')).toContain(`/j/${kept!.id}`);
    // ...without asking Zoom to create it again for everyone who joins (the worker retries later).
    expect(zoom.calls.slice(calls).filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('joining a Zoom class', () => {
  it('starts staff with a fresh start URL that is never stored, and gives students the join URL', async () => {
    const { activity, sessionId } = await zoomClass();
    const first = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toMatch(/^https:\/\/zoom\.test\/s\/\d+\?zak=fresh-1$/);
    expect((await browser(lms, school.teacher, `/live/join/${sessionId}`)).headers.get('location')).toMatch(/zak=fresh-2$/);
    const rooms = JSON.stringify(await lms.db.selectFrom('liveRooms').selectAll().execute());
    expect(rooms).not.toContain('zak=');

    const student = await browser(lms, school.sam, `/live/join/${sessionId}`);
    const url = new URL(student.headers.get('location')!);
    expect(url.origin + url.pathname).toMatch(/^https:\/\/zoom\.test\/j\/\d+$/);
    expect(url.searchParams.get('uname')).toBe('Sam Student');
    // A student asking for anything else still gets the join URL.
    expect((await browser(lms, school.sam, `/live/join/${sessionId}?as=host`)).headers.get('location')).not.toContain('zak');
    expect((await browser(lms, school.teacher, `/live/join/${sessionId}?as=participant`)).headers.get('location')).toContain('/j/');

    const studentView = await info(school.sam, activity);
    expect(JSON.stringify(studentView)).not.toContain('zoom.test');
    expect(studentView.sessions[0]!.rooms[0]!.participantUrl).toBeUndefined();
    expect((await info(school.teacher, activity)).sessions[0]!.rooms[0]!.participantUrl).toBe(`/live/join/${sessionId}?as=participant`);
    // One meeting, created on the spot because the worker hadn't run yet.
    expect(zoom.live()).toHaveLength(1);
  });

  it('ends the meeting for everyone', async () => {
    const { sessionId } = await zoomClass();
    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const res = await school.teacher.post(`/api/live/sessions/${sessionId}/end`, {});
    expect(res.body.ended).toBe(1);
    expect(zoom.live()[0]!.ended).toBe(true);
  });

  it('creates a meeting per group room, only for the groups the class is limited to', async () => {
    const base = `/api/courses/${school.course.id}`;
    const teamA = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
    const teamB = (await school.teacher.post(`${base}/groups`, { name: 'Team B' })).body.id;
    await school.teacher.post(`${base}/groups/${teamA}/members`, { userIds: [ids.sam] });
    await school.teacher.post(`${base}/groups/${teamB}/members`, { userIds: [ids.kim] });
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
      settings: { provider: 'zoom' },
      groupMode: 'separate',
    });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(2) });
    await runWorker(lms);
    expect(
      zoom
        .live()
        .map((m) => m.payload.topic)
        .sort(),
    ).toEqual(['Weekly seminar (Team A)', 'Weekly seminar (Team B)']);
    const byTopic = new Map(zoom.live().map((m) => [m.payload.topic, m]));
    const samUrl = (await browser(lms, school.sam, `/live/join/${sessionId}`)).headers.get('location')!;
    expect(samUrl).toContain(`/j/${byTopic.get('Weekly seminar (Team A)')!.id}`);
    const kimUrl = (await browser(lms, school.kim, `/live/join/${sessionId}`)).headers.get('location')!;
    expect(kimUrl).toContain(`/j/${byTopic.get('Weekly seminar (Team B)')!.id}`);
    expect((await browser(lms, school.sam, `/live/join/${sessionId}?group=${teamB}`)).status).toBe(404);

    // Limited to Team A: Team B's meeting for the later session is deleted; the one Kim already joined stays.
    const [later] = await schedule(school.teacher, activity, { startsAt: inMinutes(3 * 24 * 60) });
    await runWorker(lms);
    expect(zoom.live()).toHaveLength(4);
    await school.teacher.patch(`/api/activities/${activity}`, { groupIds: [teamA] });
    await runWorker(lms);
    expect(
      zoom
        .live()
        .map((m) => m.payload.topic)
        .sort(),
    ).toEqual(['Weekly seminar (Team A)', 'Weekly seminar (Team A)', 'Weekly seminar (Team B)']);
    expect((await info(school.teacher, activity)).sessions.find((s) => s.id === later)!.rooms.map((r) => r.groupName)).toEqual(['Team A']);
  });
});

describe('Zoom webhooks', () => {
  async function started() {
    const { activity, sessionId } = await zoomClass({}, -5);
    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const meeting = zoom.live()[0]!;
    return { activity, sessionId, meeting };
  }

  const participant = (event: string, meetingId: number, p: Record<string, unknown>) => ({
    event,
    event_ts: Date.now(),
    payload: {
      account_id: ZOOM.accountId,
      object: { id: String(meetingId), uuid: 'inst-1==', host_id: 'h1', topic: 'Weekly seminar', participant: p },
    },
  });

  it('refuses unsigned, wrongly signed and old deliveries, and answers the URL validation challenge', async () => {
    const challenge = { event: 'endpoint.url_validation', payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' }, event_ts: Date.now() };
    expect((await zoomWebhook(lms, challenge, {})).status).toBe(401);
    const text = JSON.stringify(challenge);
    expect((await zoomWebhook(lms, challenge, zoomSignature(text, undefined, 'not-the-secret'))).status).toBe(401);
    expect((await zoomWebhook(lms, challenge, zoomSignature(text, String(Math.floor(Date.now() / 1000) - 600)))).status).toBe(401);
    expect((await zoomWebhook(lms, challenge, zoomSignature(JSON.stringify({ ...challenge, event: 'x' })))).status).toBe(401);
    const ok = await zoomWebhook(lms, challenge);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      plainToken: 'qgg8vlvZRS6UYooatFL8Aw',
      encryptedToken: createHmac('sha256', ZOOM.webhookSecret).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'),
    });
    // Without a webhook secret there is nothing to verify with.
    await school.admin.put('/api/admin/live', { zoom: { webhookSecret: null } });
    expect((await zoomWebhook(lms, challenge)).status).toBe(404);
  });

  it('records attendance from joined and left events, once per delivery, and ignores other meetings', async () => {
    const { activity, sessionId, meeting } = await started();
    const t0 = Date.now() - 4 * 60_000;
    const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const joined = participant('meeting.participant_joined', meeting.id, {
      user_id: '16778240',
      user_name: 'Sam S.',
      id: '',
      participant_uuid: 'p-sam',
      join_time: at(0),
      email: 'SAM@test.dev',
    });
    expect((await zoomWebhook(lms, joined)).status).toBe(200);
    expect((await zoomWebhook(lms, joined)).status).toBe(200);
    await zoomWebhook(
      lms,
      participant('meeting.participant_left', meeting.id, {
        user_id: '16778240',
        user_name: 'Sam S.',
        participant_uuid: 'p-sam',
        leave_time: at(3),
        email: 'sam@test.dev',
      }),
    );
    await zoomWebhook(
      lms,
      participant('meeting.participant_left', meeting.id, {
        user_id: '16778240',
        user_name: 'Sam S.',
        participant_uuid: 'p-sam',
        leave_time: at(3),
        email: 'sam@test.dev',
      }),
    );
    // Kim has no Zoom account: matched by name.
    await zoomWebhook(
      lms,
      participant('meeting.participant_joined', meeting.id, {
        user_id: '16778241',
        user_name: 'Kim Student',
        participant_uuid: 'p-kim',
        join_time: at(1),
      }),
    );
    await zoomWebhook(
      lms,
      participant('meeting.participant_joined', meeting.id, {
        user_id: '16778242',
        user_name: 'Phone caller',
        participant_uuid: 'p-x',
        join_time: at(1),
      }),
    );
    // A meeting Coursekit didn't create: ignored.
    expect(
      (
        await zoomWebhook(
          lms,
          participant('meeting.participant_joined', 99, {
            user_id: '1',
            user_name: 'Kim Student',
            participant_uuid: 'p-y',
            join_time: at(1),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await zoomWebhook(lms, {
          event: 'meeting.ended',
          payload: { object: { id: String(meeting.id), uuid: 'inst-1==', end_time: at(4) } },
        })
      ).status,
    ).toBe(200);

    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${sessionId}/attendance`)).body;
    expect(list.rows.find((r) => r.user.id === ids.sam)).toMatchObject({ status: 'present', source: 'provider', minutes: 3 });
    expect(list.rows.find((r) => r.user.id === ids.kim)).toMatchObject({ status: 'present', minutes: 3 });
    expect(list.guests).toEqual([{ name: 'Phone caller', joinedAt: new Date(at(1)).toISOString(), minutes: 3 }]);
    const rows = await lms.db.selectFrom('livePresence').selectAll().where('source', '=', 'zoom').execute();
    expect(rows).toHaveLength(3);
    expect((await info(school.sam, activity)).sessions[0]!.attendance?.status).toBe('present');
  });

  it('adds cloud recordings when Zoom says they are ready', async () => {
    const { activity, meeting } = await started();
    const event = {
      event: 'recording.completed',
      payload: {
        account_id: ZOOM.accountId,
        object: {
          id: meeting.id,
          uuid: 'inst-1==',
          topic: 'Weekly seminar: Week 1',
          start_time: new Date().toISOString(),
          duration: 47,
          share_url: 'https://zoom.test/rec/share/abc',
          recording_play_passcode: 'play-pass',
          recording_files: [{ id: 'f1', file_type: 'MP4', play_url: 'https://zoom.test/rec/play/f1' }],
        },
        download_token: 'download-token-not-to-be-kept',
      },
    };
    expect((await zoomWebhook(lms, event)).status).toBe(200);
    expect((await zoomWebhook(lms, event)).status).toBe(200);
    const recordings = (await info(school.sam, activity)).sessions[0]!.recordings;
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({
      source: 'zoom',
      url: 'https://zoom.test/rec/share/abc?pwd=play-pass',
      durationMinutes: 47,
      passcode: null,
    });
    expect(JSON.stringify(await lms.db.selectFrom('liveRecordings').selectAll().execute())).not.toContain('download-token');
  });

  it('reads the participants report after the meeting when there are no webhooks', async () => {
    await school.admin.put('/api/admin/live', { zoom: { webhookSecret: null } });
    expect((await school.admin.get('/api/admin/live')).body.zoom.note).toContain('participant report');
    const { activity, sessionId } = await zoomClass({}, -90);
    await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const meeting = zoom.live()[0]!;
    zoom.instances.set(String(meeting.id), ['/inst//2==']);
    const start = Date.now() - 90 * 60_000;
    zoom.participants.set('/inst//2==', [
      {
        id: 'z1',
        user_id: 'u1',
        name: 'Sam S.',
        user_email: 'sam@test.dev',
        join_time: new Date(start).toISOString(),
        leave_time: new Date(start + 50 * 60_000).toISOString(),
        duration: 3000,
      },
      {
        id: 'z2',
        user_id: 'u2',
        name: 'Tina Teacher',
        user_email: 'teacher@test.dev',
        join_time: new Date(start).toISOString(),
        leave_time: new Date(start + 60 * 60_000).toISOString(),
        duration: 3600,
      },
    ]);
    zoom.recordings.set('/inst//2==', {
      uuid: '/inst//2==',
      topic: 'Weekly seminar',
      share_url: 'https://zoom.test/rec/share/xyz',
      password: 'Rec!9',
      duration: 58,
    });
    expect((await runWorker(lms)).followedUp).toBe(1);
    expect(zoom.calls.some((c) => c.path.startsWith('/report/meetings/%252Finst%252F%252F2%253D%253D/participants'))).toBe(true);
    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${sessionId}/attendance`)).body;
    expect(list.rows.find((r) => r.user.id === ids.sam)).toMatchObject({ status: 'present', minutes: 50 });
    expect(list.rows.find((r) => r.user.id === ids.kim)).toMatchObject({ status: 'absent' });
    expect((await info(school.sam, activity)).sessions[0]!.recordings[0]).toMatchObject({
      url: 'https://zoom.test/rec/share/xyz',
      passcode: 'Rec!9',
    });
    // Reading the report again changes nothing.
    await runWorker(lms, Date.now() + 2 * 3600_000);
    expect(await lms.db.selectFrom('livePresence').selectAll().where('source', '=', 'zoom-report').execute()).toHaveLength(2);

    // A Zoom plan without the report: staff are told why.
    zoom.reportAvailable = false;
    await runWorker(lms, Date.now() + 6 * 3600_000);
    const staff = (await info(school.teacher, activity)).sessions[0]!;
    expect(staff.syncError).toContain('missing a scope');
  });
});

describe('Zoom hosts', () => {
  const createWithHost = (settings: Record<string, unknown>) =>
    school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'live',
      title: 'Host check',
      settings: { provider: 'zoom', ...settings },
    });

  it('lets teachers pick only the site’s hosts or their own Zoom account; administrators can pick anyone', async () => {
    const refused = await createWithHost({ zoomHost: 'principal@school.test' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('principal@school.test isn’t one of this site’s Zoom hosts');
    expect((await createWithHost({ zoomHost: ZOOM.host })).status).toBe(201);
    // Their own Zoom account: the email of their instructor account.
    expect((await createWithHost({ zoomHost: 'Teacher@test.dev' })).status).toBe(201);
    await school.admin.put('/api/admin/live', { zoom: { hosts: ['other.host@school.test'] } });
    const shared = await createWithHost({ zoomHost: 'other.host@school.test' });
    expect(shared.status).toBe(201);
    const activity: string = shared.body.id;

    // An administrator can name anyone; teachers can still save the class as long as they leave the host alone.
    expect((await school.admin.patch(`/api/activities/${activity}`, { settings: { zoomHost: 'principal@school.test' } })).status).toBe(200);
    const edit = await school.teacher.patch(`/api/activities/${activity}`, {
      title: 'Renamed',
      settings: { joinMinutesBefore: 5, zoomHost: 'principal@school.test' },
    });
    expect(edit.status).toBe(200);
    expect((await school.teacher.patch(`/api/activities/${activity}`, { settings: { zoomHost: 'someone@school.test' } })).status).toBe(400);
    // Nor by saving the host while the class meets another way, then switching to Zoom.
    const link = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    expect((await school.teacher.patch(`/api/activities/${link}`, { settings: { zoomHost: 'principal@school.test' } })).status).toBe(400);
    // Only people who edit the class see its hosts.
    expect((await school.sam.get(`/api/activities/${activity}`)).body.settings).toMatchObject({ zoomHost: null, zoomGroupHosts: {} });
  });

  it('gives the start link only for a host the site shares, or to the host; other staff join as participants', async () => {
    await lms.createUser({ name: 'Tara Assistant', email: 'tara@test.dev', password: PASSWORD });
    await school.teacher.post(`/api/courses/${school.course.id}/participants`, { emails: ['tara@test.dev'], role: 'assistant' });
    const tara = await login(lms, 'tara@test.dev');
    zoom.users.add('teacher@test.dev');
    zoom.users.add('principal@school.test');

    // The teacher's own Zoom account hosts the class: only they get its start link.
    const own = await zoomClass({ zoomHost: 'teacher@test.dev' });
    expect((await browser(lms, school.teacher, `/live/join/${own.sessionId}`)).headers.get('location')).toMatch(/\/s\/\d+\?zak=/);
    expect(zoom.live()[0]!.host).toBe('teacher@test.dev');
    const assistant = (await browser(lms, tara, `/live/join/${own.sessionId}`)).headers.get('location')!;
    expect(assistant).toMatch(/^https:\/\/zoom\.test\/j\/\d+/);
    expect(assistant).not.toContain('zak');
    expect((await info(tara, own.activity)).sessions[0]!.rooms[0]).toMatchObject({ canStart: false, participantUrl: null });
    expect((await info(school.teacher, own.activity)).sessions[0]!.rooms[0]).toMatchObject({ canStart: true });

    // Another Zoom user an administrator named: nobody else gets their start link (it starts meetings as them).
    const named = await zoomClass();
    expect(
      (await school.admin.patch(`/api/activities/${named.activity}`, { settings: { zoomHost: 'principal@school.test' } })).status,
    ).toBe(200);
    for (const staff of [school.teacher, tara]) {
      const location = (await browser(lms, staff, `/live/join/${named.sessionId}`)).headers.get('location')!;
      expect(location).toContain('/j/');
      expect(location).not.toContain('zak');
    }
    expect(zoom.live().find((m) => m.payload.topic === 'Weekly seminar: Week 1' && m.host === 'principal@school.test')).toBeTruthy();

    // The site's default host is shared: every staff member of the class can start it.
    const shared = await zoomClass();
    expect((await browser(lms, tara, `/live/join/${shared.sessionId}`)).headers.get('location')).toMatch(/zak=/);
    expect((await info(tara, shared.activity)).sessions[0]!.rooms[0]).toMatchObject({ canStart: true });
  });

  it('creates each group’s meeting for its own host, and warns staff when more rooms share a host than Zoom runs at once', async () => {
    const base = `/api/courses/${school.course.id}`;
    const teamA = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
    const teamB = (await school.teacher.post(`${base}/groups`, { name: 'Team B' })).body.id;
    await school.teacher.post(`${base}/groups/${teamA}/members`, { userIds: [ids.sam] });
    await school.teacher.post(`${base}/groups/${teamB}/members`, { userIds: [ids.kim] });
    await school.admin.put('/api/admin/live', { zoom: { hosts: ['other.host@school.test'] } });
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
      settings: { provider: 'zoom' },
      groupMode: 'separate',
    });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(5) });

    // Both groups' rooms on the default host, which runs one meeting at a time.
    expect((await info(school.teacher, activity)).warning).toContain('the rooms of 2 groups are hosted by host@school.test');
    expect((await info(school.sam, activity)).warning).toBeNull();
    const providers = (await school.teacher.get(`/api/live/providers?courseId=${school.course.id}`)).body;
    expect(providers.find((p: { id: string }) => p.id === 'zoom')).toMatchObject({
      hosts: [ZOOM.host, 'other.host@school.test'],
      concurrentMeetings: 1,
    });
    // A plan with two meetings at once is enough for two groups.
    await school.admin.put('/api/admin/live', { zoom: { concurrentMeetings: 2 } });
    expect((await info(school.teacher, activity)).warning).toBeNull();
    await school.admin.put('/api/admin/live', { zoom: { concurrentMeetings: 1 } });

    const hosts = (zoomGroupHosts: Record<string, string>) =>
      school.teacher.patch(`/api/activities/${activity}`, { settings: { zoomGroupHosts } });
    expect((await hosts({ [teamB]: 'other.host@school.test' })).status).toBe(200);
    expect((await info(school.teacher, activity)).warning).toBeNull();
    await runWorker(lms);
    expect(
      zoom
        .live()
        .map((m) => [m.payload.topic, m.host])
        .sort(),
    ).toEqual([
      ['Weekly seminar (Team A)', ZOOM.host],
      ['Weekly seminar (Team B)', 'other.host@school.test'],
    ]);
    const kim = (await browser(lms, school.kim, `/live/join/${sessionId}`)).headers.get('location')!;
    expect(kim).toContain(`/j/${zoom.live().find((m) => m.host === 'other.host@school.test')!.id}`);
    // Group hosts follow the same rules as the class's host, for groups of this course.
    expect((await hosts({ [teamA]: 'principal@school.test' })).status).toBe(400);
    expect((await hosts({ 'not-a-group': ZOOM.host })).status).toBe(400);
    expect((await school.sam.get(`/api/activities/${activity}`)).body.settings.zoomGroupHosts).toEqual({});
  });
});

describe('Zoom meetings changed outside Coursekit', () => {
  it('replaces a meeting deleted in Zoom when staff start it, and sends students to the new one', async () => {
    const { sessionId } = await zoomClass();
    await runWorker(lms);
    const [first] = zoom.live();
    // A host tidying their meetings in Zoom.
    first!.deleted = true;
    const start = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    expect(start.status).toBe(302);
    const [second] = zoom.live();
    expect(second!.id).not.toBe(first!.id);
    expect(start.headers.get('location')).toMatch(new RegExp(`/s/${second!.id}\\?zak=`));
    expect((await browser(lms, school.sam, `/live/join/${sessionId}`)).headers.get('location')).toContain(`/j/${second!.id}`);
  });

  it('checks the meeting still exists before sending students to it', async () => {
    const { sessionId } = await zoomClass();
    await runWorker(lms);
    const [first] = zoom.live();
    first!.deleted = true;
    const res = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    const [second] = zoom.live();
    expect(second!.id).not.toBe(first!.id);
    expect(res.headers.get('location')).toContain(`/j/${second!.id}`);
  });

  it('still lets students in with the link it has when Zoom can’t be asked', async () => {
    const { sessionId } = await zoomClass();
    await runWorker(lms);
    const [meeting] = zoom.live();
    zoom.failing.add('GET');
    const res = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/j/${meeting!.id}`);
    // Staff starting it are told why instead: a start link only comes from Zoom.
    expect(await (await browser(lms, school.teacher, `/live/join/${sessionId}`)).text()).toContain('Zoom had a problem');
  });

  it('creates the new host’s meeting before deleting the old one, and retries the deletion when Zoom fails', async () => {
    await school.admin.put('/api/admin/live', { zoom: { hosts: ['other.host@school.test'] } });
    const { activity, sessionId } = await zoomClass({}, 24 * 60);
    await runWorker(lms);
    const [old] = zoom.live();
    zoom.failing.add('DELETE');
    await school.teacher.patch(`/api/activities/${activity}`, { settings: { zoomHost: 'other.host@school.test' } });
    expect((await runWorker(lms)).synced).toBe(1);
    // People are sent to the new meeting at once; the old one waits to be deleted.
    const room = await lms.db.selectFrom('liveRooms').selectAll().where('sessionId', '=', sessionId).executeTakeFirstOrThrow();
    const fresh = zoom.live().find((m) => m.host === 'other.host@school.test')!;
    expect(room).toMatchObject({ externalId: String(fresh.id), host: 'other.host@school.test', syncError: null });
    expect(zoom.live().map((m) => m.id)).toContain(old!.id);
    const retired = await lms.db.selectFrom('liveRooms').selectAll().where('sessionId', 'is', null).execute();
    expect(retired).toMatchObject([{ externalId: String(old!.id), state: 'delete', provider: 'zoom' }]);
    zoom.failing.delete('DELETE');
    await runWorker(lms, Date.now() + 10 * 60_000);
    expect(zoom.live().map((m) => m.id)).toEqual([fresh.id]);
    expect(await lms.db.selectFrom('liveRooms').selectAll().where('sessionId', 'is', null).execute()).toEqual([]);
  });

  it('creates a new meeting when a change finds the old one deleted in Zoom', async () => {
    const { sessionId } = await zoomClass({}, 24 * 60);
    await runWorker(lms);
    const [first] = zoom.live();
    first!.deleted = true;
    const moved = inMinutes(25 * 60);
    await school.teacher.patch(`/api/live/sessions/${sessionId}`, { startsAt: moved });
    expect((await runWorker(lms)).synced).toBe(1);
    const [second] = zoom.live();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.payload.start_time).toBe(moved.replace(/\.\d{3}Z$/, 'Z'));
    const room = await lms.db.selectFrom('liveRooms').selectAll().where('sessionId', '=', sessionId).executeTakeFirstOrThrow();
    expect(room).toMatchObject({ externalId: String(second!.id), syncError: null });
  });

  it('moves the meeting when its session moves more than two weeks ahead', async () => {
    const { activity, sessionId } = await zoomClass({}, 24 * 60);
    await runWorker(lms);
    const [meeting] = zoom.live();
    const later = inMinutes(20 * 24 * 60);
    expect((await school.teacher.patch(`/api/live/sessions/${sessionId}`, { startsAt: later })).status).toBe(200);
    expect((await runWorker(lms)).synced).toBe(1);
    expect(meeting!.payload.start_time).toBe(later.replace(/\.\d{3}Z$/, 'Z'));
    // A change to the class reaches it too; sessions that far ahead without a meeting still wait.
    await schedule(school.teacher, activity, { startsAt: inMinutes(21 * 24 * 60) });
    await school.teacher.patch(`/api/activities/${activity}`, { title: 'Seminar' });
    expect((await runWorker(lms)).synced).toBe(1);
    expect(meeting!.payload.topic).toBe('Seminar: Week 1');
    expect(zoom.live()).toHaveLength(1);
  });
});
