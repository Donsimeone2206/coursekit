import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LiveClassInfo } from '../src/shared/live.js';
import type { CourseDetail } from '../src/shared/types.js';
import type { Coursekit } from '../src/server/index.js';
import { createTestLms, login, type Client } from './helpers.js';
import { browser, installFetch, uninstallFetch } from './live-helpers.js';

let lms: Coursekit;
let alex: Client;
let maya: Client;
let activityId: string;

beforeAll(async () => {
  // Nothing may reach the network: the demo uses the meeting link provider only.
  installFetch();
  lms = await createTestLms();
  await lms.seedDemo({ password: 'demo-password' });
  alex = await login(lms, 'alex.johnson@coursekit.test', 'demo-password');
  maya = await login(lms, 'maya.chen@coursekit.test', 'demo-password');
  const course = (await alex.get<CourseDetail>('/api/courses/modern-web-development')).body;
  activityId = course.sections.flatMap((s) => s.activities).find((a) => a.type === 'live')!.id;
});

afterAll(async () => {
  await lms.close();
  uninstallFetch();
});

it('has a weekly live Q&A with two past sessions, attendance, a recording and upcoming sessions', async () => {
  const info = (await alex.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;
  expect(info).toMatchObject({ provider: 'link', ready: true, canManage: false });
  const past = info.sessions.filter((s) => s.state === 'ended');
  const upcoming = info.sessions.filter((s) => s.state !== 'ended' && s.state !== 'cancelled');
  expect(past).toHaveLength(2);
  expect(upcoming.length).toBeGreaterThanOrEqual(3);
  expect(past.every((s) => s.attendance?.status === 'present')).toBe(true);
  expect(past[0]!.recordings.map((r) => r.title)).toEqual(['Recording: Getting set up']);
  expect(info.completion).toEqual({ required: 2, attended: 2 });
  expect(new Set(info.sessions.map((s) => s.seriesId)).size).toBe(1);

  const staff = (await maya.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;
  expect(staff.canManage).toBe(true);
  const summary = staff.sessions.find((s) => s.id === past[1]!.id)!.attendanceSummary!;
  expect(summary.present).toBeGreaterThan(0);
  expect(summary.present).toBeLessThan(summary.total);
});

it('lets the teacher start the next session from the demo without any provider account', async () => {
  const info = (await maya.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;
  const next = info.sessions.find((s) => s.state !== 'ended')!;
  const res = await browser(lms, maya, `/live/join/${next.id}`);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://meet.example.com/coursekit-weekly-qa');
});
