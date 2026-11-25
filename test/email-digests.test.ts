import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';
import { digestSchedule, zonedTimeToUtc } from '../src/server/services/email/digests.js';
import { notify } from '../src/server/services/notify.js';
import { createEmailLms, memoryTransport, outbox, type MemoryTransport } from './email-helpers.js';
import { setupSchool } from './helpers.js';

let lms: Coursekit;
let transport: MemoryTransport;
let school: Awaited<ReturnType<typeof setupSchool>>;
let samId: string;

beforeEach(async () => {
  transport = memoryTransport();
  lms = await createEmailLms(transport);
  school = await setupSchool(lms);
  await school.admin.put('/api/admin/email/settings', { digestHour: 8, digestWeekday: 1, timezone: 'UTC' });
  samId = (await lms.db.selectFrom('users').select('id').where('email', '=', 'sam@test.dev').executeTakeFirstOrThrow()).id;
});
afterEach(async () => {
  await lms.close();
});

/** 2030-01-07 is a Monday. */
const at = (iso: string) => new Date(iso);

async function prefer(frequency: 'daily' | 'weekly' | 'immediately' | 'off', lastDigestAt: string | null, disabled: string[] = []) {
  await lms.db
    .insertInto('emailPreferences')
    .values({
      userId: samId,
      frequency,
      disabledCategories: JSON.stringify(disabled),
      lastDigestAt,
      digestClaim: null,
      updatedAt: '2030-01-01T00:00:00.000Z',
    })
    .onConflict((oc) => oc.column('userId').doUpdateSet({ frequency, lastDigestAt, disabledCategories: JSON.stringify(disabled) }))
    .execute();
}

async function notification(createdAt: string, title: string, type = 'announcement', userId = samId) {
  await lms.db
    .insertInto('notifications')
    .values({ id: newId(), userId, type, title, body: `About ${title}`, link: '/courses/testing-101', readAt: null, createdAt })
    .execute();
}

const digests = async () => (await outbox(lms)).filter((r) => r.kind === 'digest');

describe('digest schedule', () => {
  it('finds the most recent and next slots in the site time zone', () => {
    const utc = { digestHour: 8, digestWeekday: 1, timezone: 'UTC' };
    expect(digestSchedule(at('2030-01-08T09:00:00Z'), utc)).toEqual({
      daily: at('2030-01-08T08:00:00Z'),
      weekly: at('2030-01-07T08:00:00Z'),
      nextDaily: at('2030-01-09T08:00:00Z'),
      nextWeekly: at('2030-01-14T08:00:00Z'),
    });
    // Before the digest hour, the latest slot is yesterday's.
    expect(digestSchedule(at('2030-01-07T07:59:00Z'), utc).daily).toEqual(at('2030-01-06T08:00:00Z'));
    expect(digestSchedule(at('2030-01-07T07:59:00Z'), utc).weekly).toEqual(at('2029-12-31T08:00:00Z'));

    const ny = { digestHour: 8, digestWeekday: 1, timezone: 'America/New_York' };
    expect(digestSchedule(at('2030-01-08T13:30:00Z'), ny).daily).toEqual(at('2030-01-08T13:00:00Z')); // EST
    expect(digestSchedule(at('2030-07-09T12:30:00Z'), ny).daily).toEqual(at('2030-07-09T12:00:00Z')); // EDT
    // Daylight saving starts on 10 March 2030: 08:00 is 13:00Z the day before and 12:00Z that day.
    expect(digestSchedule(at('2030-03-10T11:30:00Z'), ny).daily).toEqual(at('2030-03-09T13:00:00Z'));
    expect(digestSchedule(at('2030-03-10T12:30:00Z'), ny)).toMatchObject({
      daily: at('2030-03-10T12:00:00Z'),
      nextDaily: at('2030-03-11T12:00:00Z'),
    });

    expect(zonedTimeToUtc(2030, 1, 7, 8, 'Asia/Kolkata')).toEqual(at('2030-01-07T02:30:00Z'));
    // Day overflow is normalised: 32 January is 1 February.
    expect(zonedTimeToUtc(2030, 1, 32, 8, 'UTC')).toEqual(at('2030-02-01T08:00:00Z'));
  });
});

describe('daily digests', () => {
  it('summarises what arrived since the last digest, once per day', async () => {
    await prefer('daily', '2030-01-07T08:00:00.000Z');
    await notification('2030-01-06T12:00:00.000Z', 'Old news'); // before the last digest
    await notification('2030-01-07T09:00:00.000Z', 'Quiz opens tomorrow');
    await notification('2030-01-07T15:00:00.000Z', 'New grade for Essay', 'grade');

    expect(await lms.email.sendDigests({ now: at('2030-01-08T08:00:30Z') })).toEqual({ daily: 1, weekly: 0, skipped: 0 });
    const [digest] = await digests();
    expect(digest).toMatchObject({
      toAddress: 'sam@test.dev',
      userId: samId,
      subject: 'Your daily digest: New grade for Essay and 1 more',
    });
    expect(digest!.text).toContain('Quiz opens tomorrow');
    expect(digest!.text).toContain('New grade for Essay');
    expect(digest!.text).not.toContain('Old news');
    expect(digest!.text).toMatch(/ANNOUNCEMENTS[\s\S]*GRADES AND FEEDBACK/);
    expect(digest!.html).toContain('https://learn.example.test/notifications');
    expect(JSON.parse(digest!.headers)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Running again (another tick, another process, cron) sends nothing new.
    expect(await lms.email.sendDigests({ now: at('2030-01-08T08:01:30Z') })).toEqual({ daily: 0, weekly: 0, skipped: 0 });

    // Nothing new by the next day: no email, but the day still counts.
    expect(await lms.email.sendDigests({ now: at('2030-01-09T08:00:10Z') })).toEqual({ daily: 0, weekly: 0, skipped: 1 });
    expect(await digests()).toHaveLength(1);

    // Something arrives after the digest hour: it waits for the next day's digest.
    await notification('2030-01-09T10:00:00.000Z', 'Forum reply', 'forum');
    expect(await lms.email.sendDigests({ now: at('2030-01-09T20:00:00Z') })).toEqual({ daily: 0, weekly: 0, skipped: 0 });
    expect(await lms.email.sendDigests({ now: at('2030-01-09T20:00:00Z'), force: true })).toEqual({ daily: 0, weekly: 0, skipped: 0 });
    // A server that was down at 08:00 catches up later that morning.
    expect(await lms.email.sendDigests({ now: at('2030-01-10T11:30:00Z') })).toEqual({ daily: 1, weekly: 0, skipped: 0 });
    const latest = (await digests())[1]!;
    expect(latest.subject).toBe('Your daily digest: Forum reply');

    await lms.email.processOutbox({ now: at('2030-01-10T11:31:00Z') });
    expect(transport.sent.map((m) => m.subject)).toEqual([
      'Your daily digest: New grade for Essay and 1 more',
      'Your daily digest: Forum reply',
    ]);
  });

  it('never goes out long after the digest hour unless forced', async () => {
    await prefer('daily', '2030-01-06T08:00:00.000Z');
    await notification('2030-01-07T09:00:00.000Z', 'Something');
    expect(await lms.email.sendDigests({ now: at('2030-01-07T20:00:00Z') })).toMatchObject({ daily: 0 });
    // e.g. `coursekit send-digests --force` from a cron job at another hour
    expect(await lms.email.sendDigests({ now: at('2030-01-07T20:00:00Z'), force: true })).toMatchObject({ daily: 1 });
  });

  it('leaves out switched-off categories and notifications that were already emailed', async () => {
    // Sam gets this one by email straight away...
    await notify(lms.db, [samId], { type: 'grade', title: 'Emailed straight away' });
    expect((await outbox(lms)).map((r) => r.kind)).toEqual(['notification']);
    // ...then moves to a daily digest without discussions.
    await prefer('daily', null, ['discussions']);
    await notification(new Date(Date.now() - 60_000).toISOString(), 'Muted reply', 'forum');
    await notification(new Date(Date.now() - 30_000).toISOString(), 'Course news');
    const next = digestSchedule(new Date(), { digestHour: 8, digestWeekday: 1, timezone: 'UTC' }).nextDaily;

    expect(await lms.email.sendDigests({ now: new Date(next.getTime() + 60_000) })).toEqual({ daily: 1, weekly: 0, skipped: 0 });
    const [digest] = await digests();
    expect(digest!.text).toContain('Course news');
    expect(digest!.text).not.toContain('Emailed straight away');
    expect(digest!.text).not.toContain('Muted reply');
  });

  it('starts a new account at the first digest after it was created', async () => {
    await school.admin.put('/api/admin/email/settings', { defaultFrequency: 'daily' });
    const now = new Date();
    await notification(now.toISOString(), 'Welcome');
    const schedule = digestSchedule(now, { digestHour: 8, digestWeekday: 1, timezone: 'UTC' });
    // The accounts were created after the latest slot, so even a forced run skips them.
    expect(await lms.email.sendDigests({ now: new Date(now.getTime() + 1000), force: true })).toEqual({ daily: 0, weekly: 0, skipped: 0 });
    const result = await lms.email.sendDigests({ now: new Date(schedule.nextDaily.getTime() + 1000) });
    // Sam has a notification; the other three accounts have nothing new.
    expect(result).toEqual({ daily: 1, weekly: 0, skipped: 3 });
  });

  it('restarts the digest window when someone changes how often they hear from us', async () => {
    await notify(lms.db, [samId], { type: 'announcement', title: 'Before the switch' });
    await lms.email.processOutbox();
    await school.sam.put('/api/email/preferences', { frequency: 'weekly' });
    const pref = await lms.db.selectFrom('emailPreferences').selectAll().where('userId', '=', samId).executeTakeFirstOrThrow();
    expect(pref.frequency).toBe('weekly');
    expect(Date.now() - new Date(pref.lastDigestAt!).getTime()).toBeLessThan(5000);
    // Saving categories alone keeps the window.
    await school.sam.put('/api/email/preferences', { disabledCategories: ['grades'] });
    const again = await lms.db.selectFrom('emailPreferences').select('lastDigestAt').where('userId', '=', samId).executeTakeFirstOrThrow();
    expect(again.lastDigestAt).toBe(pref.lastDigestAt);
  });
});

describe('weekly digests', () => {
  it('go out on the configured weekday only', async () => {
    await prefer('weekly', '2030-01-07T08:00:00.000Z');
    await notification('2030-01-09T10:00:00.000Z', 'Midweek update');
    // Thursday: not the digest day.
    expect(await lms.email.sendDigests({ now: at('2030-01-10T08:00:30Z') })).toEqual({ daily: 0, weekly: 0, skipped: 0 });
    // The next Monday.
    expect(await lms.email.sendDigests({ now: at('2030-01-14T08:05:00Z') })).toEqual({ daily: 0, weekly: 1, skipped: 0 });
    const [digest] = await digests();
    expect(digest!.subject).toBe('Your weekly digest: Midweek update');
    // The digest covers everything since the previous one.
    expect(digest!.text).toContain('You have 1 new notification since Jan 7, 8:00 AM.');
  });

  it('follow the weekday and hour the admin picks', async () => {
    await school.admin.put('/api/admin/email/settings', { digestWeekday: 4, digestHour: 18, timezone: 'Europe/Paris' });
    await prefer('weekly', '2030-01-03T17:00:00.000Z');
    await notification('2030-01-09T10:00:00.000Z', 'Midweek update');
    // Thursday 18:00 in Paris is 17:00 UTC in winter.
    expect(await lms.email.sendDigests({ now: at('2030-01-10T16:59:00Z') })).toMatchObject({ weekly: 0 });
    expect(await lms.email.sendDigests({ now: at('2030-01-10T17:00:30Z') })).toMatchObject({ weekly: 1 });
  });

  it('caps the list and links to the rest', async () => {
    await prefer('weekly', '2030-01-07T08:00:00.000Z');
    for (let i = 0; i < 25; i++) await notification(`2030-01-08T10:${String(i).padStart(2, '0')}:00.000Z`, `Update ${i}`);
    await lms.email.sendDigests({ now: at('2030-01-14T08:00:30Z') });
    const [digest] = await digests();
    expect(digest!.subject).toBe('Your weekly digest: Update 24 and 24 more');
    expect(digest!.text).toContain('You have 25 new notifications since Jan 7, 8:00 AM.');
    expect(digest!.text).toContain('And 5 more.');
    expect(digest!.text).toContain('Update 5');
    expect(digest!.text).not.toContain('Update 4 ');
  });
});
