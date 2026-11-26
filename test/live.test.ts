import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveClassInfo, LiveSessionAttendance } from '../src/shared/live.js';
import type { ActivityDetail, AppNotification, CalendarEvent, DashboardData } from '../src/shared/types.js';
import type { Coursekit } from '../src/server/index.js';
import { localTimeAt, offsetAt, repeatStarts, zonedTimeToUtc } from '../src/server/services/live/time.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';
import {
  browser,
  createLiveClass,
  del,
  inMinutes,
  installFetch,
  quietWorker,
  runWorker,
  schedule,
  uninstallFetch,
} from './live-helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let base: string;
let tara: Client;
let ids: Record<'sam' | 'kim' | 'tara', string>;

const idOf = async (client: Client): Promise<string> => (await client.get('/api/auth/session')).body.user.id;
const info = async (as: Client, activityId: string) => (await as.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;
const notifications = async (as: Client) => (await as.get<{ items: AppNotification[] }>('/api/notifications')).body.items;

beforeEach(async () => {
  installFetch();
  lms = await createTestLms();
  await quietWorker(lms);
  school = await setupSchool(lms);
  base = `/api/courses/${school.course.id}`;
  await lms.createUser({ name: 'Tara Assistant', email: 'tara@test.dev', password: PASSWORD });
  await school.teacher.post(`${base}/participants`, { emails: ['sam@test.dev', 'kim@test.dev'] });
  await school.teacher.post(`${base}/participants`, { emails: ['tara@test.dev'], role: 'assistant' });
  tara = await login(lms, 'tara@test.dev');
  ids = { sam: await idOf(school.sam), kim: await idOf(school.kim), tara: await idOf(tara) };
});

afterEach(async () => {
  await lms.close();
  uninstallFetch();
});

describe('time zones', () => {
  it('keeps the same local time across a daylight saving change, in the given time zone', () => {
    for (const zone of ['Europe/London', 'America/New_York', 'Australia/Sydney']) {
      // The next change of the zone's offset, from today.
      const start = Date.now();
      const before = offsetAt(start, zone);
      let change = start;
      for (let day = 1; day < 400; day++) {
        change = start + day * 86_400_000;
        if (offsetAt(change, zone) !== before) break;
      }
      const day = localTimeAt(change - 10 * 86_400_000, zone);
      const first = zonedTimeToUtc({ ...day, hour: 10, minute: 30 }, zone);
      const starts = repeatStarts(first, 'weekly', 4, zone);
      for (const s of starts) expect(localTimeAt(s, zone)).toMatchObject({ hour: 10, minute: 30 });
      // Same wall time, different UTC time once the clocks have changed.
      expect(new Date(starts[0]!).getUTCHours() * 60 + new Date(starts[0]!).getUTCMinutes()).not.toBe(
        new Date(starts[3]!).getUTCHours() * 60 + new Date(starts[3]!).getUTCMinutes(),
      );
      expect(starts[3]! - starts[0]!).not.toBe(21 * 86_400_000);
    }
  });

  it('moves a time that clocks skip forward and picks the first of a time that happens twice', () => {
    // 01:30 on 29 March 2026 doesn't exist in London; 01:30 on 25 October 2026 happens twice.
    expect(new Date(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/London')).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, 'Europe/London')).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('schedules a weekly series through the API with the browser time zone', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const zone = 'America/New_York';
    const start = Date.now();
    const before = offsetAt(start, zone);
    let change = start;
    for (let day = 1; day < 400; day++) {
      change = start + day * 86_400_000;
      if (offsetAt(change, zone) !== before) break;
    }
    const day = localTimeAt(change - 3 * 86_400_000, zone);
    const first = new Date(zonedTimeToUtc({ ...day, hour: 9, minute: 0 }, zone)).toISOString();
    await schedule(school.teacher, activity, {
      startsAt: first,
      timeZone: zone,
      repeat: { frequency: 'weekly', count: 3 },
      title: 'Office hours',
    });
    const sessions = (await info(school.teacher, activity)).sessions;
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map((s) => s.seriesId)).size).toBe(1);
    for (const s of sessions) {
      expect(localTimeAt(Date.parse(s.startsAt), zone)).toMatchObject({ hour: 9, minute: 0 });
      expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(60 * 60_000);
      expect(s.timeZone).toBe(zone);
    }
    expect(
      (
        await school.teacher.post(`/api/live/activities/${activity}/sessions`, {
          startsAt: first,
          durationMinutes: 60,
          timeZone: 'Mars/Olympus',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await school.teacher.post(`/api/live/activities/${activity}/sessions`, {
          startsAt: first,
          durationMinutes: 60,
          timeZone: zone,
          repeat: { frequency: 'weekly', count: 101 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await school.teacher.post(`/api/live/activities/${activity}/sessions`, { startsAt: first, durationMinutes: 2, timeZone: zone }))
        .status,
    ).toBe(400);
  });
});

describe('providers', () => {
  it('only offers teachers the providers an administrator set up', async () => {
    const list = async () =>
      (await school.teacher.get(`/api/live/providers?courseId=${school.course.id}`)).body.map((p: { id: string }) => p.id);
    expect(await list()).toEqual(['link']);
    expect((await school.sam.get(`/api/live/providers?courseId=${school.course.id}`)).status).toBe(403);
    const refused = await school.teacher.post(`${base}/activities`, {
      sectionId: school.sectionId,
      type: 'live',
      title: 'Zoom class',
      settings: { provider: 'zoom' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Zoom isn’t set up');

    expect((await school.teacher.put('/api/admin/live', { jitsi: { enabled: true } })).status).toBe(403);
    const saved = await school.admin.put('/api/admin/live', { jitsi: { enabled: true }, link: { enabled: false } });
    expect(saved.status).toBe(200);
    expect(saved.body.jitsi).toMatchObject({ enabled: true, url: 'https://meet.jit.si', ready: true, appSecretSet: false });
    expect(await list()).toEqual(['jitsi']);
  });

  it('keeps secrets on the server: the admin page only says whether one is set', async () => {
    const res = await school.admin.put('/api/admin/live', {
      bbb: { enabled: true, url: 'https://bbb.example.edu/bigbluebutton/', secret: 'top-secret-bbb', algorithm: 'sha256' },
      zoom: {
        enabled: true,
        accountId: 'acc',
        clientId: 'cid',
        clientSecret: 'zoom-client-secret',
        webhookSecret: 'zoom-hook',
        defaultHost: 'host@school.test',
      },
      jitsi: { enabled: true, url: 'https://jitsi.school.test', appId: 'coursekit', appSecret: 'jitsi-app-secret-0123456789abcdef' },
    });
    expect(res.status).toBe(200);
    const text = JSON.stringify((await school.admin.get('/api/admin/live')).body);
    for (const secret of ['top-secret-bbb', 'zoom-client-secret', 'zoom-hook', 'jitsi-app-secret']) expect(text).not.toContain(secret);
    const body = (await school.admin.get('/api/admin/live')).body;
    expect(body.bbb).toMatchObject({ secretSet: true, algorithm: 'sha256', ready: true });
    expect(body.zoom).toMatchObject({ clientSecretSet: true, webhookSecretSet: true, ready: true });
    // Without the public URL, the admin page says what doesn't work.
    expect(body.publicUrl).toBeNull();
    expect(body.zoomWebhookUrl).toBeNull();
    expect(body.zoom.note).toContain('COURSEKIT_PUBLIC_URL');
    expect(body.bbb.note).toContain('COURSEKIT_PUBLIC_URL');

    // Leaving a secret out keeps it; null clears it.
    await school.admin.put('/api/admin/live', { bbb: { url: 'https://bbb2.example.edu/' } });
    expect((await school.admin.get('/api/admin/live')).body.bbb).toMatchObject({ secretSet: true, url: 'https://bbb2.example.edu/' });
    await school.admin.put('/api/admin/live', { bbb: { secret: null } });
    expect((await school.admin.get('/api/admin/live')).body.bbb).toMatchObject({ secretSet: false, ready: false });
    // Not https: refused.
    expect((await school.admin.put('/api/admin/live', { bbb: { url: 'http://bbb.example.edu/' } })).status).toBe(400);
    expect((await school.admin.put('/api/admin/live', { zoom: { defaultHost: 'not an email' } })).status).toBe(400);
  });

  it('needs a long Jitsi app secret, and says what the Jitsi server needs for moderator tokens', async () => {
    const jitsi = { enabled: true, url: 'https://jitsi.school.test', appId: 'coursekit' };
    // Every learner gets a token signed with it: a short secret could be guessed offline and used to sign moderator tokens.
    const short = await school.admin.put('/api/admin/live', { jitsi: { ...jitsi, appSecret: 'ab' } });
    expect(short.status).toBe(400);
    expect(short.body.error.message).toContain('at least 32 characters');
    const saved = await school.admin.put('/api/admin/live', { jitsi: { ...jitsi, appSecret: 'x'.repeat(32) } });
    expect(saved.body.jitsi).toMatchObject({ ready: true, appSecretSet: true });
    expect(saved.body.jitsi.note).toContain('token_affiliation');
    // A short secret stored some other way: not ready until it is replaced.
    await lms.db
      .updateTable('settings')
      .set({ value: JSON.stringify({ ...jitsi, appSecret: 'ab' }) })
      .where('key', '=', 'live.jitsi')
      .execute();
    const stored = (await school.admin.get('/api/admin/live')).body.jitsi;
    expect(stored).toMatchObject({ ready: false });
    expect(stored.problem).toContain('at least 32');
    // BigBlueButton's join links carry a checksum made with its shared secret: a short one gets a note.
    await school.admin.put('/api/admin/live', { bbb: { enabled: true, url: 'https://bbb.example.edu/', secret: 'short-secret' } });
    expect((await school.admin.get('/api/admin/live')).body.bbb).toMatchObject({ ready: true });
    expect((await school.admin.get('/api/admin/live')).body.bbb.note).toContain('The shared secret is short');
  });
});

describe('scheduling and joining', () => {
  it('schedules sessions, tells students who can see the class, and lets them join in the window', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(5), title: 'Kick-off', agenda: 'Introductions' });
    const note = (await notifications(school.sam)).find((n) => n.type === 'live.scheduled');
    expect(note?.title).toBe('New live session: Weekly seminar: Kick-off');
    expect(note?.link).toBe(`/courses/${school.course.slug}/activities/${activity}`);
    expect((await notifications(tara)).some((n) => n.type === 'live.scheduled')).toBe(false);

    const view = await info(school.sam, activity);
    expect(view.provider).toBe('link');
    expect(view.sessions[0]).toMatchObject({ id: sessionId, title: 'Kick-off', state: 'open', canJoin: true });
    expect(view.sessions[0]!.rooms[0]!.joinUrl).toBe(`/live/join/${sessionId}`);
    // Students don't see the meeting link itself, nor in the activity's settings.
    expect(JSON.stringify(view)).not.toContain('meet.example.com');
    const detail = (await school.sam.get<ActivityDetail<'live'>>(`/api/activities/${activity}`)).body;
    expect(detail.settings.meetingUrl).toBeNull();
    expect((await school.teacher.get<ActivityDetail<'live'>>(`/api/activities/${activity}`)).body.settings.meetingUrl).toBe(
      'https://meet.example.com/abc-defg-hij',
    );

    const res = await browser(lms, school.sam, `/live/join/${sessionId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://meet.example.com/abc-defg-hij');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const after = await info(school.sam, activity);
    expect(after.sessions[0]!.attendance).toMatchObject({ status: 'present', marked: false });
  });

  it('opens the join window a set number of minutes before the start; staff can start at any time', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { joinMinutesBefore: 15 } });
    const [later] = await schedule(school.teacher, activity, { startsAt: inMinutes(60) });
    const [soon] = await schedule(school.teacher, activity, { startsAt: inMinutes(10) });
    const [past] = await schedule(school.teacher, activity, { startsAt: inMinutes(-120) });

    const early = await browser(lms, school.sam, `/live/join/${later}`);
    expect(early.status).toBe(400);
    expect(await early.text()).toContain('opens 15 minutes before it starts');
    expect((await browser(lms, school.sam, `/live/join/${soon}`)).status).toBe(302);
    expect(await (await browser(lms, school.sam, `/live/join/${past}`)).text()).toContain('This session has ended');
    // Staff: any time.
    expect((await browser(lms, school.teacher, `/live/join/${later}`)).status).toBe(302);
    expect((await browser(lms, tara, `/live/join/${past}`)).status).toBe(302);

    const view = await info(school.sam, activity);
    const byId = new Map(view.sessions.map((s) => [s.id, s]));
    expect(byId.get(later!)).toMatchObject({ state: 'upcoming', canJoin: false });
    expect(byId.get(later!)!.joinNote).toContain('15 minutes before');
    expect(byId.get(soon!)).toMatchObject({ state: 'open', canJoin: true });
    expect(byId.get(past!)).toMatchObject({ state: 'ended', canJoin: false });
    expect(byId.get(past!)!.attendance?.status).toBe('absent');
  });

  it('asks for a click first when the join link comes from another site, and needs a signed-in user', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(1) });
    const gate = await browser(lms, school.sam, `/live/join/${sessionId}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(gate.status).toBe(200);
    expect(await gate.text()).toContain('A link from another site');
    expect((await info(school.sam, activity)).sessions[0]!.attendance?.status).toBeNull();
    expect((await browser(lms, null, `/live/join/${sessionId}`)).status).toBe(401);
  });

  it('edits, moves and cancels sessions, and tells students', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(24 * 60) });
    expect((await school.teacher.patch(`/api/live/sessions/${sessionId}`, { title: 'Renamed' })).status).toBe(200);
    expect((await notifications(school.sam)).some((n) => n.type === 'live.moved')).toBe(false);
    expect((await school.teacher.patch(`/api/live/sessions/${sessionId}`, { startsAt: inMinutes(48 * 60) })).status).toBe(200);
    const moved = (await notifications(school.sam)).find((n) => n.type === 'live.moved');
    expect(moved?.title).toBe('Live session moved: Weekly seminar: Renamed');
    expect(moved?.body).toMatch(/^Now .* \(it was .*\)\.$/);

    expect((await school.sam.patch(`/api/live/sessions/${sessionId}`, { title: 'Mine' })).status).toBe(403);
    expect((await tara.post(`/api/live/sessions/${sessionId}/cancel`)).status).toBe(403);
    expect((await school.teacher.post(`/api/live/sessions/${sessionId}/cancel`)).status).toBe(200);
    expect((await notifications(school.sam)).some((n) => n.type === 'live.cancelled')).toBe(true);
    const view = await info(school.sam, activity);
    expect(view.sessions[0]).toMatchObject({ status: 'cancelled', state: 'cancelled', canJoin: false });
    expect((await browser(lms, school.teacher, `/live/join/${sessionId}`)).status).toBe(400);
    expect((await school.teacher.patch(`/api/live/sessions/${sessionId}`, { title: 'Back' })).status).toBe(400);
    expect((await del(lms, school.teacher, `/api/live/sessions/${sessionId}`)).status).toBe(200);
    expect((await info(school.teacher, activity)).sessions).toHaveLength(0);
  });

  it('tells students once when a session is cancelled or deleted by two requests at the same moment', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [a, b] = await schedule(school.teacher, activity, {
      startsAt: inMinutes(24 * 60),
      repeat: { frequency: 'daily', count: 2 },
      timeZone: 'UTC',
    });
    const cancelled = async () => (await notifications(school.sam)).filter((n) => n.type === 'live.cancelled').length;
    const twice = await Promise.all([
      school.teacher.post(`/api/live/sessions/${a}/cancel`),
      school.teacher.post(`/api/live/sessions/${a}/cancel`),
    ]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    expect(await cancelled()).toBe(1);
    // Cancelled and deleted at once, and deleted twice.
    await Promise.all([
      school.teacher.post(`/api/live/sessions/${b}/cancel`),
      del(lms, school.teacher, `/api/live/sessions/${b}`),
      del(lms, school.teacher, `/api/live/sessions/${b}`),
    ]);
    expect(await cancelled()).toBe(2);
    expect((await info(school.teacher, activity)).sessions.map((s) => s.id)).toEqual([a]);
  });

  it('uses each session’s own link, or the class link, and tells staff when there is none', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { meetingUrl: null } });
    const [own] = await schedule(school.teacher, activity, {
      startsAt: inMinutes(1),
      meetingUrl: 'https://teams.example.com/l/meetup-join/1',
    });
    const [none] = await schedule(school.teacher, activity, { startsAt: inMinutes(2) });
    expect((await browser(lms, school.sam, `/live/join/${own}`)).headers.get('location')).toBe('https://teams.example.com/l/meetup-join/1');
    expect(await (await browser(lms, school.sam, `/live/join/${none}`)).text()).toContain('no meeting link yet');
    expect(await (await browser(lms, school.teacher, `/live/join/${none}`)).text()).toContain('Add the meeting link');
    expect(
      (
        await school.teacher.post(`/api/live/activities/${activity}/sessions`, {
          startsAt: inMinutes(5),
          durationMinutes: 30,
          timeZone: 'UTC',
          meetingUrl: 'javascript:alert(1)',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await school.teacher.post(`/api/live/activities/${activity}/sessions`, {
          startsAt: inMinutes(5),
          durationMinutes: 30,
          timeZone: 'UTC',
          meetingUrl: 'http://meet.example.com/x',
        })
      ).status,
    ).toBe(400);
    const staffView = await info(school.teacher, activity);
    expect(staffView.sessions.find((s) => s.id === own)?.meetingUrl).toBe('https://teams.example.com/l/meetup-join/1');
    expect((await info(tara, activity)).sessions.find((s) => s.id === own)?.meetingUrl).toBeUndefined();
  });
});

describe('visibility and permissions', () => {
  it('hides everything about sessions of activities students can’t see', async () => {
    const hidden = await createLiveClass(school.teacher, school.course.id, school.sectionId, { title: 'Staff briefing', visible: false });
    const [sessionId] = await schedule(school.teacher, hidden, { startsAt: inMinutes(5) });
    expect((await notifications(school.sam)).some((n) => n.type === 'live.scheduled')).toBe(false);
    expect((await school.sam.get(`/api/live/activities/${hidden}`)).status).toBe(404);
    expect((await school.sam.get(`/api/live/sessions/${sessionId}/ics`)).status).toBe(404);
    expect((await browser(lms, school.sam, `/live/join/${sessionId}`)).status).toBe(404);
    expect((await school.sam.get(`/api/live/activities/${hidden}/ics`)).status).toBe(404);
    const range = `from=${encodeURIComponent(inMinutes(-60))}&to=${encodeURIComponent(inMinutes(60))}`;
    expect((await school.sam.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.some((e) => e.kind === 'live')).toBe(false);
    expect((await school.teacher.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.some((e) => e.kind === 'live')).toBe(true);
    expect((await tara.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.some((e) => e.kind === 'live')).toBe(true);

    // People from other courses get nothing either.
    await lms.createUser({ name: 'Outsider', email: 'out@test.dev', password: PASSWORD });
    const out = await login(lms, 'out@test.dev');
    const visible = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [open] = await schedule(school.teacher, visible, { startsAt: inMinutes(5) });
    expect((await out.get(`/api/live/activities/${visible}`)).status).toBe(403);
    expect((await out.get(`/api/live/sessions/${open}/ics`)).status).toBe(403);
    expect((await browser(lms, out, `/live/join/${open}`)).status).toBe(403);
    expect((await out.get<CalendarEvent[]>(`/api/calendar?${range}`)).body).toEqual([]);
  });

  it('keeps group-restricted classes to their groups', async () => {
    const groupA = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
    await school.teacher.post(`${base}/groups/${groupA}/members`, { userIds: [ids.sam] });
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { groupIds: [groupA] });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(5) });
    expect((await notifications(school.sam)).some((n) => n.type === 'live.scheduled')).toBe(true);
    expect((await notifications(school.kim)).some((n) => n.type === 'live.scheduled')).toBe(false);
    expect((await school.kim.get(`/api/live/activities/${activity}`)).status).toBe(404);
    expect((await browser(lms, school.kim, `/live/join/${sessionId}`)).status).toBe(404);
    const range = `from=${encodeURIComponent(inMinutes(-60))}&to=${encodeURIComponent(inMinutes(60))}`;
    expect((await school.kim.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.some((e) => e.kind === 'live')).toBe(false);
    expect((await school.sam.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.some((e) => e.kind === 'live')).toBe(true);
  });

  it('lets teaching assistants start sessions and take attendance, but not schedule them; students do neither', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(-5) });
    expect(
      (await tara.post(`/api/live/activities/${activity}/sessions`, { startsAt: inMinutes(60), durationMinutes: 30, timeZone: 'UTC' }))
        .status,
    ).toBe(403);
    expect(
      (
        await school.sam.post(`/api/live/activities/${activity}/sessions`, {
          startsAt: inMinutes(60),
          durationMinutes: 30,
          timeZone: 'UTC',
        })
      ).status,
    ).toBe(403);
    expect((await tara.get(`/api/live/sessions/${sessionId}/attendance`)).status).toBe(200);
    expect((await school.sam.get(`/api/live/sessions/${sessionId}/attendance`)).status).toBe(403);
    expect((await school.sam.put(`/api/live/sessions/${sessionId}/attendance/${ids.kim}`, { status: 'present' })).status).toBe(403);
    expect((await tara.put(`/api/live/sessions/${sessionId}/attendance/${ids.kim}`, { status: 'present' })).status).toBe(200);
    // Only students of the course can be marked.
    expect((await tara.put(`/api/live/sessions/${sessionId}/attendance/${ids.tara}`, { status: 'present' })).status).toBe(404);
    expect(
      (await school.sam.post(`/api/live/sessions/${sessionId}/recordings`, { title: 'Mine', url: 'https://video.example.com/1' })).status,
    ).toBe(403);
    const view = await info(school.sam, activity);
    expect(view.canModerate).toBe(false);
    expect(view.sessions[0]!.attendanceSummary).toBeUndefined();
    expect((await info(tara, activity)).sessions[0]!.attendanceSummary).toEqual({ present: 1, total: 2 });
  });
});

describe('calendar, dashboard and calendar files', () => {
  it('shows sessions in the calendar and the next one on the dashboard', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [first] = await schedule(school.teacher, activity, { startsAt: inMinutes(120), title: 'One' });
    await schedule(school.teacher, activity, { startsAt: inMinutes(60 * 24 * 3), title: 'Two' });
    const range = `from=${encodeURIComponent(inMinutes(-60))}&to=${encodeURIComponent(inMinutes(60 * 24 * 7))}`;
    const events = (await school.sam.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.filter((e) => e.kind === 'live');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: `live-${first}`,
      title: 'Weekly seminar: One',
      link: `/courses/${school.course.slug}/activities/${activity}`,
      icsUrl: `/api/live/sessions/${first}/ics`,
      canDelete: false,
    });
    expect(Date.parse(events[0]!.endsAt!) - Date.parse(events[0]!.startsAt)).toBe(3600_000);
    await school.teacher.post(`/api/live/sessions/${first}/cancel`);
    expect((await school.sam.get<CalendarEvent[]>(`/api/calendar?${range}`)).body.filter((e) => e.kind === 'live')).toHaveLength(1);

    const dashboard = (await school.sam.get<DashboardData>('/api/dashboard')).body;
    const live = dashboard.timeline.filter((t) => t.type === 'live');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ activityId: activity, title: 'Weekly seminar: Two', status: 'todo' });
    expect(dashboard.stats.dueThisWeek).toBe(0);
  });

  it('downloads a session or the whole class as an .ics file', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { reminderMinutes: 30 } });
    const day = new Date(Date.now() + 10 * 86_400_000);
    day.setUTCHours(10, 0, 0, 0);
    const date = day.toISOString().slice(0, 10);
    const compact = date.replace(/-/g, '');
    const [a, b] = await schedule(school.teacher, activity, {
      startsAt: day.toISOString(),
      title: 'Planning; part 1, with notes',
      agenda: 'Bring your questions\nand a pen',
      repeat: { frequency: 'weekly', count: 2 },
      timeZone: 'UTC',
    });
    const res = await browser(lms, school.sam, `/api/live/sessions/${a}/ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain(
      `attachment; filename="Weekly seminar Planning part 1 with notes ${date}.ics"`,
    );
    const ics = await res.text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain(`UID:live-${a}@localhost`);
    expect(ics).toContain(`DTSTART:${compact}T100000Z`);
    expect(ics).toContain(`DTEND:${compact}T110000Z`);
    expect(ics).toContain('SUMMARY:Weekly seminar: Planning\\; part 1\\, with notes');
    expect(ics).toContain('DESCRIPTION:Bring your questions\\nand a pen');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('TRIGGER:-PT30M');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);

    await school.teacher.post(`/api/live/sessions/${b}/cancel`);
    const all = await (await browser(lms, school.sam, `/api/live/activities/${activity}/ics`)).text();
    expect(all.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(all).toContain(`UID:live-${b}@localhost`);
    expect(all).toMatch(/SEQUENCE:1\r\nSTATUS:CANCELLED/);
  });
});

describe('reminders', () => {
  it('sends each reminder once, even when two workers run at the same moment', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { reminderMinutes: 15 } });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(60) });
    const start = Date.parse((await info(school.teacher, activity)).sessions[0]!.startsAt);
    expect((await runWorker(lms, start - 20 * 60_000)).reminders).toBe(0);
    const runs = await Promise.all([
      runWorker(lms, start - 10 * 60_000),
      runWorker(lms, start - 10 * 60_000),
      runWorker(lms, start - 9 * 60_000),
    ]);
    expect(runs.reduce((n, r) => n + r.reminders, 0)).toBe(1);
    expect((await runWorker(lms, start - 5 * 60_000)).reminders).toBe(0);
    const reminders = (await notifications(school.sam)).filter((n) => n.type === 'live.reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toBe('Starting soon: Weekly seminar');
    expect((await notifications(school.kim)).filter((n) => n.type === 'live.reminder')).toHaveLength(1);
    expect((await notifications(school.teacher)).filter((n) => n.type === 'live.reminder')).toHaveLength(0);

    // A moved session gets a reminder for its new time.
    await school.teacher.patch(`/api/live/sessions/${sessionId}`, { startsAt: new Date(start + 120 * 60_000).toISOString() });
    expect((await runWorker(lms, start + 110 * 60_000)).reminders).toBe(1);
  });

  it('sends no reminder for a session scheduled after its reminder time, or when reminders are off', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { reminderMinutes: 30 } });
    await schedule(school.teacher, activity, { startsAt: inMinutes(10) });
    const quiet = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { reminderMinutes: null } });
    await schedule(school.teacher, quiet, { startsAt: inMinutes(5) });
    expect((await runWorker(lms)).reminders).toBe(0);
    expect((await notifications(school.sam)).filter((n) => n.type === 'live.reminder')).toHaveLength(0);
  });

  it('tells students nothing while the course is archived, and reminds them again once it is published', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { reminderMinutes: 30 } });
    await schedule(school.teacher, activity, { startsAt: inMinutes(60) });
    const start = Date.parse((await info(school.teacher, activity)).sessions[0]!.startsAt);
    expect((await school.teacher.patch(base, { visibility: 'archived' })).status).toBe(200);
    expect((await runWorker(lms, start - 25 * 60_000)).reminders).toBe(0);
    // Scheduling, moving and cancelling sessions of the archived course: students can't join them, so no news either.
    const [later] = await schedule(school.teacher, activity, { startsAt: inMinutes(24 * 60) });
    expect((await school.teacher.patch(`/api/live/sessions/${later}`, { startsAt: inMinutes(25 * 60) })).status).toBe(200);
    expect((await school.teacher.post(`/api/live/sessions/${later}/cancel`)).status).toBe(200);
    const types = async (as: Client) => (await notifications(as)).map((n) => n.type).filter((t) => t.startsWith('live.'));
    expect(await types(school.sam)).toEqual(['live.scheduled']);
    expect(await types(school.kim)).toEqual(['live.scheduled']);

    expect((await school.teacher.patch(base, { visibility: 'published' })).status).toBe(200);
    expect((await runWorker(lms, start - 24 * 60_000)).reminders).toBe(1);
    expect((await notifications(school.sam)).filter((n) => n.type === 'live.reminder').map((n) => n.link)).toEqual([
      `/courses/${school.course.slug}/activities/${activity}`,
    ]);
  });
});

describe('attendance and completion', () => {
  it('completes the class once a student attended enough sessions; teachers can correct attendance', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { settings: { attendanceRequired: 2 } });
    const [one, two] = await schedule(school.teacher, activity, {
      startsAt: inMinutes(-90),
      repeat: { frequency: 'daily', count: 2 },
      timeZone: 'UTC',
    });
    // The first session is over; the second is tomorrow.
    expect((await school.teacher.put(`/api/live/sessions/${two}/attendance/${ids.sam}`, { status: 'present' })).status).toBe(400);
    await school.teacher.put(`/api/live/sessions/${one}/attendance/${ids.sam}`, { status: 'present' });
    const completed = async () => (await school.sam.get<ActivityDetail>(`/api/activities/${activity}`)).body.completed;
    expect(await completed()).toBe(false);
    expect((await info(school.sam, activity)).completion).toEqual({ required: 2, attended: 1 });

    await school.teacher.patch(`/api/activities/${activity}`, { settings: { attendanceRequired: 1 } });
    expect(await completed()).toBe(true);
    await school.teacher.put(`/api/live/sessions/${one}/attendance/${ids.sam}`, { status: 'absent' });
    expect(await completed()).toBe(false);
    await school.teacher.put(`/api/live/sessions/${one}/attendance/${ids.sam}`, { status: null });
    expect(await completed()).toBe(false);

    // Joining through Coursekit counts.
    const [now] = await schedule(school.teacher, activity, { startsAt: inMinutes(-1) });
    expect((await browser(lms, school.sam, `/live/join/${now}`)).status).toBe(302);
    expect(await completed()).toBe(true);

    const list = (await school.teacher.get<LiveSessionAttendance>(`/api/live/sessions/${now}/attendance`)).body;
    expect(list.canMark).toBe(true);
    expect(list.rows.map((r) => [r.user.name, r.status, r.source])).toEqual([
      ['Kim Student', 'absent', null],
      ['Sam Student', 'present', 'join'],
    ]);
    expect(list.rows[1]!.joinedAt).not.toBeNull();
    expect(list.rows[1]!.minutes).toBeNull();
    expect(list.sourceNote).toContain('meeting link');
  });

  it('counts a join in the window before the start towards completion', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(5) });
    expect((await info(school.sam, activity)).sessions[0]!.state).toBe('open');
    expect((await browser(lms, school.sam, `/live/join/${sessionId}`)).status).toBe(302);
    const completed = async () => (await school.sam.get<ActivityDetail>(`/api/activities/${activity}`)).body.completed;
    expect(await completed()).toBe(true);
    expect((await info(school.sam, activity)).completion).toEqual({ required: 1, attended: 1 });
    // Checked again (a teacher changes the class before the session starts): still complete.
    await school.teacher.patch(`/api/activities/${activity}`, { settings: { joinMinutesBefore: 0 } });
    expect(await completed()).toBe(true);
    expect((await info(school.sam, activity)).completion).toEqual({ required: 1, attended: 1 });
  });

  it('supports manual completion instead', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, { completion: 'manual' });
    expect((await school.sam.post(`/api/activities/${activity}/complete`)).status).toBe(200);
    expect((await info(school.sam, activity)).completion).toBeNull();
  });
});

describe('group rooms (Jitsi Meet)', () => {
  let groupA: string;
  let groupB: string;

  beforeEach(async () => {
    await school.admin.put('/api/admin/live', {
      jitsi: { enabled: true, url: 'https://jitsi.school.test', appId: 'coursekit', appSecret: 'jitsi-app-secret-0123456789abcdef' },
    });
    groupA = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
    groupB = (await school.teacher.post(`${base}/groups`, { name: 'Team B' })).body.id;
    await school.teacher.post(`${base}/groups/${groupA}/members`, { userIds: [ids.sam, ids.tara] });
    await school.teacher.post(`${base}/groups/${groupB}/members`, { userIds: [ids.kim] });
  });

  async function jitsiClass(groupMode: 'none' | 'separate' | 'visible') {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
      settings: { provider: 'jitsi' },
      groupMode,
    });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(2) });
    return { activity, sessionId: sessionId! };
  }

  const roomOf = (location: string | null) => new URL(location!).pathname.slice(1);

  it('gives each group its own room in separate groups mode', async () => {
    const { activity, sessionId } = await jitsiClass('separate');
    const sam = await info(school.sam, activity);
    expect(sam.sessions[0]!.rooms.map((r) => r.groupName)).toEqual(['Team A']);
    expect((await info(school.kim, activity)).sessions[0]!.rooms.map((r) => r.groupName)).toEqual(['Team B']);
    expect((await info(tara, activity)).sessions[0]!.rooms.map((r) => r.groupName)).toEqual(['Team A']);
    expect((await info(school.teacher, activity)).sessions[0]!.rooms.map((r) => r.groupName)).toEqual(['Team A', 'Team B']);

    const samRoom = roomOf((await browser(lms, school.sam, `/live/join/${sessionId}`)).headers.get('location'));
    const kimRoom = roomOf((await browser(lms, school.kim, `/live/join/${sessionId}`)).headers.get('location'));
    expect(samRoom).not.toBe(kimRoom);
    expect(samRoom).toMatch(/^ck[0-9a-z]{30}$/);
    // Another group's room: refused.
    expect((await browser(lms, school.sam, `/live/join/${sessionId}?group=${groupB}`)).status).toBe(404);
    expect((await browser(lms, tara, `/live/join/${sessionId}?group=${groupB}`)).status).toBe(404);
    // The teacher picks a group (or gets asked which).
    const pick = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    expect(pick.status).toBe(200);
    expect(await pick.text()).toContain('Which group’s room?');
    expect(roomOf((await browser(lms, school.teacher, `/live/join/${sessionId}?group=${groupB}`)).headers.get('location'))).toBe(kimRoom);
    // A second session gets new rooms.
    const [next] = await schedule(school.teacher, activity, { startsAt: inMinutes(3) });
    expect(roomOf((await browser(lms, school.sam, `/live/join/${next}`)).headers.get('location'))).not.toBe(samRoom);
  });

  it('shows every group’s room in visible groups mode, but students only join their own', async () => {
    const { activity, sessionId } = await jitsiClass('visible');
    const rooms = (await info(school.sam, activity)).sessions[0]!.rooms;
    expect(rooms.map((r) => [r.groupName, r.mine, r.canJoin])).toEqual([
      ['Team A', true, true],
      ['Team B', false, false],
    ]);
    expect(rooms[1]!.joinUrl).toBeNull();
    expect((await browser(lms, school.sam, `/live/join/${sessionId}?group=${groupB}`)).status).toBe(403);
    expect((await browser(lms, school.sam, `/live/join/${sessionId}?group=${groupA}`)).status).toBe(302);
  });

  it('tells a student in no group that there is no room for them', async () => {
    await lms.createUser({ name: 'Nia Student', email: 'nia@test.dev', password: PASSWORD });
    await school.teacher.post(`${base}/participants`, { emails: ['nia@test.dev'] });
    const nia = await login(lms, 'nia@test.dev');
    const { activity, sessionId } = await jitsiClass('separate');
    const view = await info(nia, activity);
    expect(view.sessions[0]!.rooms).toEqual([]);
    expect(view.sessions[0]!.joinNote).toContain('not in a group yet');
    expect((await browser(lms, nia, `/live/join/${sessionId}`)).status).toBe(403);
  });

  it('signs a Jitsi token per person: staff are moderators, students are not', async () => {
    const { sessionId } = await jitsiClass('none');
    const key = new TextEncoder().encode('jitsi-app-secret-0123456789abcdef');
    const tokenOf = (location: string | null) => new URL(location!).searchParams.get('jwt')!;
    const student = await browser(lms, school.sam, `/live/join/${sessionId}`);
    const studentUrl = new URL(student.headers.get('location')!);
    expect(studentUrl.origin).toBe('https://jitsi.school.test');
    expect(studentUrl.hash).toContain('userInfo.displayName=%22Sam%20Student%22');
    const { payload } = await jwtVerify(tokenOf(student.headers.get('location')), key, { issuer: 'coursekit', audience: 'jitsi' });
    expect(payload).toMatchObject({ room: roomOf(student.headers.get('location')), moderator: false, sub: 'jitsi.school.test' });
    expect(payload.context).toMatchObject({ user: { id: ids.sam, name: 'Sam Student', moderator: false, affiliation: 'member' } });
    const teacher = await browser(lms, school.teacher, `/live/join/${sessionId}`);
    const staff = (await jwtVerify(tokenOf(teacher.headers.get('location')), key)).payload;
    expect(staff).toMatchObject({ moderator: true, context: { user: { moderator: true, affiliation: 'owner' } } });
    expect(staff.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(86_400);
    // A forged token signed with another secret wouldn't verify.
    await expect(
      jwtVerify(tokenOf(student.headers.get('location')), new TextEncoder().encode('other-secret-0123456789abcdef')),
    ).rejects.toThrow();
  });

  it('keeps each group’s recordings to that group after the class stops having group rooms', async () => {
    const { activity, sessionId } = await jitsiClass('separate');
    const add = (title: string, groupId: string) =>
      school.teacher.post(`/api/live/sessions/${sessionId}/recordings`, { title, url: 'https://video.example.com/watch/1', groupId });
    expect((await add('Team A breakout', groupA)).status).toBe(201);
    const teamB = (await add('Team B breakout', groupB)).body.id;
    const titles = async (as: Client) => (await info(as, activity)).sessions[0]!.recordings.map((r) => r.title);
    expect(await titles(school.kim)).toEqual(['Team B breakout']);

    // Now a meeting link, which has one room for everyone; the class still uses separate groups.
    const moved = await school.teacher.patch(`/api/activities/${activity}`, {
      settings: { provider: 'link', meetingUrl: 'https://meet.example.com/abc' },
    });
    expect(moved.status).toBe(200);
    expect((await school.kim.get<ActivityDetail>(`/api/activities/${activity}`)).body.groups?.mode).toBe('separate');
    expect(await titles(school.kim)).toEqual(['Team B breakout']);
    expect(await titles(school.sam)).toEqual(['Team A breakout']);
    expect(await titles(tara)).toEqual(['Team A breakout']);
    expect(await titles(school.teacher)).toEqual(['Team A breakout', 'Team B breakout']);
    // Tara (Team A) can't hide or remove Team B's recording either.
    expect((await tara.patch(`/api/live/recordings/${teamB}`, { hidden: true })).status).toBe(404);
    expect((await del(lms, tara, `/api/live/recordings/${teamB}`)).status).toBe(404);
    expect((await school.teacher.patch(`/api/live/recordings/${teamB}`, { hidden: true })).status).toBe(200);
  });

  it('embeds self-hosted Jitsi Meet when the class asks for it, but never meet.jit.si', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
      settings: { provider: 'jitsi', embed: true },
    });
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(1) });
    expect((await info(school.sam, activity)).embed).toBe(true);
    const embed = await school.sam.post(`/api/live/sessions/${sessionId}/embed`, {});
    expect(embed.status).toBe(200);
    expect(embed.body.url).toMatch(/^https:\/\/jitsi\.school\.test\/ck[0-9a-z]{30}\?jwt=/);
    await school.admin.put('/api/admin/live', { jitsi: { url: 'https://meet.jit.si', appId: '', appSecret: null } });
    expect((await info(school.sam, activity)).embed).toBe(false);
    expect((await school.sam.post(`/api/live/sessions/${sessionId}/embed`, {})).status).toBe(400);
    const location = (await browser(lms, school.sam, `/live/join/${sessionId}`)).headers.get('location')!;
    expect(location.startsWith('https://meet.jit.si/ck')).toBe(true);
    expect(location).not.toContain('jwt=');
  });
});

describe('recordings added by hand', () => {
  it('lets staff add, hide and remove recording links that learners of the session see', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const [sessionId] = await schedule(school.teacher, activity, { startsAt: inMinutes(-120) });
    const added = await tara.post(`/api/live/sessions/${sessionId}/recordings`, {
      title: 'Recording',
      url: 'https://video.example.com/watch/1',
    });
    expect(added.status).toBe(201);
    expect(
      (await school.teacher.post(`/api/live/sessions/${sessionId}/recordings`, { title: 'Bad', url: 'ftp://video.example.com/1' })).status,
    ).toBe(400);
    expect((await info(school.sam, activity)).sessions[0]!.recordings.map((r) => r.url)).toEqual(['https://video.example.com/watch/1']);
    expect((await info(school.sam, activity)).sessions[0]!.recordings[0]!.hidden).toBeUndefined();
    expect((await school.teacher.patch(`/api/live/recordings/${added.body.id}`, { hidden: true })).status).toBe(200);
    expect((await info(school.sam, activity)).sessions[0]!.recordings).toEqual([]);
    expect((await info(school.teacher, activity)).sessions[0]!.recordings[0]!.hidden).toBe(true);
    expect((await school.sam.patch(`/api/live/recordings/${added.body.id}`, { hidden: false })).status).toBe(403);
    expect((await del(lms, school.teacher, `/api/live/recordings/${added.body.id}`)).status).toBe(200);
    expect((await info(school.teacher, activity)).sessions[0]!.recordings).toEqual([]);
  });
});
