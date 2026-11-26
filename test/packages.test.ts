import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';
import { packageSecret, signToken, verifyToken } from '../src/server/packages/tokens.js';
import { accessibilityScormFiles, zipFiles } from '../src/server/seed/demo-package-content.js';
import { del, settle } from './completion-helpers.js';
import { createTestLms, login, setupSchool } from './helpers.js';
import {
  commit,
  createPackageActivity,
  fetchRaw,
  manifest12,
  page,
  runRuntime,
  scorm12Zip,
  scorm2004Zip,
  tokenOf,
  uploadPackage,
  zip,
} from './package-helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

async function userId(email: string) {
  return (await lms.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
});

describe('uploading packages', () => {
  it('imports a SCORM 1.2 package and lists its table of contents', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip(), 'course.zip');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 1,
      kind: 'scorm12',
      title: 'Test course',
      fileCount: 3,
      items: [{ id: 'sco1', launchable: true, sco: true }],
    });
    const info = await school.sam.get(`/api/packages/${activityId}`);
    expect(info.body).toMatchObject({
      mode: 'learner',
      canStartNew: true,
      current: { kind: 'scorm12' },
      grade: { score: null, maxGrade: 100 },
    });
    // The uploaded zip itself is not kept.
    expect(await lms.db.selectFrom('files').selectAll().execute()).toEqual([]);
  });

  it('reads SCORM 2004 multi-SCO manifests with xml:base and parameters', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'scorm2004', edition: '4th', title: 'Multi SCO' });
    expect(
      res.body.items.map((i: { id: string; launchable: boolean; sco: boolean; depth: number }) => [i.id, i.launchable, i.sco, i.depth]),
    ).toEqual([
      ['module', false, false, 0],
      ['one', true, true, 1],
      ['two', true, true, 1],
      ['three', true, false, 1],
    ]);
    const version = await lms.db.selectFrom('packageVersions').select('structure').executeTakeFirstOrThrow();
    const items = JSON.parse(version.structure).items;
    expect(items[1]).toMatchObject({ href: 'course/content/one.html?x=1&lang=en', completionThreshold: 0.8 });
    expect(items[2]).toMatchObject({
      href: 'course/content/part%20two/two.html',
      path: 'course/content/part two/two.html',
      scaledPassingScore: 0.7,
    });
  });

  it('refuses broken, unsafe and unsupported zips with a clear message', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const upload = (data: Uint8Array) => uploadPackage(lms, school.teacher, school.course.id, activityId, data);
    const cases: Array<[Uint8Array, RegExp]> = [
      [zip({ 'imsmanifest.xml': '<manifest><organizations>', 'index.html': page('x') }), /imsmanifest\.xml could not be read/],
      [zip({ 'cmi5.xml': '<courseStructure/>', 'index.html': page('x') }), /cmi5/],
      [zip({ 'readme.txt': 'hello' }), /imsmanifest\.xml or tincan\.xml/],
      [zip({ 'imsmanifest.xml': manifest12({ items: [{ id: 'a', href: 'missing.html' }] }) }), /isn't in the zip/],
      [zip({ '../evil.html': 'x', 'imsmanifest.xml': 'x' }), /leaves the package folder/],
      [zip({ '/etc/passwd': 'x' }), /absolute path/],
      [zip({ 'a\\b.html': 'x' }), /backslash/],
      [new TextEncoder().encode('not a zip at all'), /isn't a zip/],
    ];
    for (const [data, message] of cases) {
      const res = await upload(data);
      expect(res.status, String(message)).toBe(422);
      expect(res.body.error.message).toMatch(message);
    }
    expect(await lms.db.selectFrom('packageVersions').selectAll().execute()).toEqual([]);
  });

  it('only lets teachers upload, and only their own uploads', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const res = await uploadPackage(lms, school.sam, school.course.id, activityId, scorm12Zip()).catch((e: Error) => e);
    expect(res).toBeInstanceOf(Error); // students can't upload activity files at all
    const own = await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip());
    expect(own.status).toBe(201);
    expect((await school.sam.post(`/api/packages/${activityId}/import`, { fileId: 'nope' })).status).toBe(403);
  });
});

describe('playing a SCORM 1.2 package', () => {
  let activityId: string;
  beforeEach(async () => {
    activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, { attemptsAllowed: 2 }, 50);
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip())).status).toBe(201);
  });

  it('serves sandboxed content with the run-time injected first', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    expect(launch.status).toBe(200);
    expect(launch.body).toMatchObject({ mode: 'normal', itemId: 'sco1', display: 'embed' });
    const res = await fetchRaw(lms, launch.body.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    );
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    const token = tokenOf(launch.body.url);
    expect(html).toMatch(
      new RegExp(`^<!doctype html><html><head><script src="/content/${token}/__coursekit/runtime\\.js"></script><title>`),
    );

    const image = await fetchRaw(lms, `/content/${token}/img/logo.png`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const ranged = await fetchRaw(lms, `/content/${token}/img/logo.png`, { headers: { range: 'bytes=1-2' } });
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([80, 78]));
    expect((await fetchRaw(lms, `/content/${token}/missing.html`)).status).toBe(404);
    // Encoded separators can't smuggle a path past the checks.
    expect((await fetchRaw(lms, `/content/${token}/img%2F..%2Findex.html`)).status).toBe(404);
    expect((await fetchRaw(lms, `/content/${token}/..%5Cindex.html`)).status).toBe(404);
    // The rest of the site keeps its frame protection.
    expect((await fetchRaw(lms, '/api/health')).headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('runs the SCORM 1.2 API on the embedded state and commits changes', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const token = tokenOf(launch.body.url);
    const script = await (await fetchRaw(lms, `/content/${token}/__coursekit/runtime.js`)).text();
    const win = runRuntime(script);
    const api = win.API!;
    expect(api.LMSGetValue('cmi.core.lesson_status')).toBe('');
    expect(api.LMSGetLastError()).toBe('301');
    expect(api.LMSInitialize('')).toBe('true');
    expect(api.LMSInitialize('')).toBe('false');
    expect(api.LMSGetLastError()).toBe('101');
    expect(api.LMSGetValue('cmi.core.student_name')).toBe('Student, Sam');
    expect(api.LMSGetValue('cmi.core.entry')).toBe('ab-initio');
    expect(api.LMSGetValue('cmi.core.lesson_mode')).toBe('normal');
    expect(api.LMSGetValue('cmi.core.credit')).toBe('credit');
    expect(api.LMSGetValue('cmi.core.lesson_status')).toBe('not attempted');
    expect(api.LMSGetValue('cmi.student_data.mastery_score')).toBe('80');
    expect(api.LMSGetValue('cmi.launch_data')).toBe('launch-sco1');
    expect(api.LMSGetValue('cmi.core.total_time')).toBe('0000:00:00');
    expect(api.LMSGetValue('cmi.core._children')).toContain('lesson_status');
    expect(api.LMSGetValue('cmi.core.student_id._children')).toBe('');
    expect(api.LMSGetLastError()).toBe('202');
    expect(api.LMSGetValue('cmi.core._count')).toBe('');
    expect(api.LMSGetLastError()).toBe('203');
    expect(api.LMSSetValue('cmi.core.student_id', 'x')).toBe('false');
    expect(api.LMSGetLastError()).toBe('403');
    expect(api.LMSGetValue('cmi.core.exit')).toBe('');
    expect(api.LMSGetLastError()).toBe('404');
    expect(api.LMSSetValue('cmi.core._children', 'x')).toBe('false');
    expect(api.LMSGetLastError()).toBe('402');
    expect(api.LMSSetValue('cmi.core.lesson_status', 'done')).toBe('false');
    expect(api.LMSGetLastError()).toBe('405');
    expect(api.LMSSetValue('cmi.core.score.raw', '101')).toBe('false');
    expect(api.LMSSetValue('cmi.nothing', '1')).toBe('false');
    expect(api.LMSGetLastError()).toBe('201');
    expect(api.LMSGetErrorString('405')).toBe('Incorrect data type');
    expect(api.LMSSetValue('cmi.suspend_data', 'x'.repeat(4097))).toBe('false');
    expect(api.LMSSetValue('cmi.interactions.1.id', 'q2')).toBe('false');
    expect(api.LMSGetLastError()).toBe('201');
    expect(api.LMSSetValue('cmi.interactions.0.id', 'q1')).toBe('true');
    expect(api.LMSSetValue('cmi.interactions.0.result', 'correct')).toBe('true');
    expect(api.LMSSetValue('cmi.interactions.0.latency', '0000:00:12.5')).toBe('true');
    expect(api.LMSGetValue('cmi.interactions._count')).toBe('1');
    expect(api.LMSGetValue('cmi.interactions.0.id')).toBe('');
    expect(api.LMSGetLastError()).toBe('404');
    expect(api.LMSSetValue('cmi.core.lesson_location', 'page-3')).toBe('true');
    expect(api.LMSSetValue('cmi.suspend_data', 'answers=1,2')).toBe('true');
    expect(api.LMSSetValue('cmi.core.score.raw', '90')).toBe('true');
    expect(api.LMSSetValue('cmi.core.lesson_status', 'completed')).toBe('true');
    expect(api.LMSSetValue('cmi.core.exit', 'suspend')).toBe('true');
    expect(api.LMSSetValue('cmi.core.session_time', '00:10:30')).toBe('true');
    expect(api.LMSCommit('')).toBe('true');
    expect(api.LMSFinish('')).toBe('true');
    expect(api.LMSGetValue('cmi.core.lesson_location')).toBe('');
    expect(api.LMSGetLastError()).toBe('301');

    // The storage the sandbox blocks is replaced in memory.
    win.localStorage.setItem('a', '1');
    expect(win.localStorage.getItem('a')).toBe('1');
    win.document.cookie = 'b=2; path=/';
    expect(win.document.cookie).toBe('b=2');

    expect(win.sent).toHaveLength(2);
    expect(win.sent[1]!.body).toMatchObject({ seq: 2, terminate: true });
    // Replay what the browser sent.
    for (const s of win.sent) {
      const res = await commit(lms, token, s.body);
      expect(res.body).toMatchObject({ ok: true, recorded: true, rejected: 0 });
    }
    await settle(lms);
    const sam = await userId('sam@test.dev');
    const attempt = await lms.db.selectFrom('packageAttempts').selectAll().where('userId', '=', sam).executeTakeFirstOrThrow();
    // Mastery score 80, raw 90: the LMS turns "completed" into "passed".
    expect(attempt).toMatchObject({
      status: 'finished',
      completionStatus: 'completed',
      successStatus: 'passed',
      score: 0.9,
      totalSeconds: 630,
    });
    const grade = await lms.db
      .selectFrom('grades')
      .selectAll()
      .where('activityId', '=', activityId)
      .where('userId', '=', sam)
      .executeTakeFirstOrThrow();
    expect(grade.score).toBe(45);
    const completion = await lms.db
      .selectFrom('completions')
      .selectAll()
      .where('activityId', '=', activityId)
      .where('userId', '=', sam)
      .execute();
    expect(completion).toHaveLength(1);

    // A finished attempt opens for review; a new attempt starts fresh, and then the attempts run out.
    const review = await school.sam.post(`/api/packages/${activityId}/launch`, { attemptId: attempt.id });
    expect(review.body.mode).toBe('review');
    const reviewWin = runRuntime(await (await fetchRaw(lms, `/content/${tokenOf(review.body.url)}/__coursekit/runtime.js`)).text());
    reviewWin.API!.LMSInitialize('');
    expect(reviewWin.API!.LMSGetValue('cmi.core.lesson_mode')).toBe('review');
    expect(reviewWin.API!.LMSGetValue('cmi.core.lesson_status')).toBe('passed');
    expect((await commit(lms, tokenOf(review.body.url), { ops: [['cmi.core.lesson_status', 'failed']], seq: 5 })).body.recorded).toBe(
      false,
    );

    const second = await school.sam.post(`/api/packages/${activityId}/launch`, { newAttempt: true });
    expect(second.body.attemptId).not.toBe(attempt.id);
    const t2 = tokenOf(second.body.url);
    expect(
      (
        await commit(lms, t2, {
          ops: [
            ['cmi.core.score.raw', '40'],
            ['cmi.core.lesson_status', 'completed'],
          ],
          terminate: true,
        })
      ).body.recorded,
    ).toBe(true);
    await settle(lms);
    // Highest attempt counts.
    expect(
      (
        await lms.db
          .selectFrom('grades')
          .select('score')
          .where('activityId', '=', activityId)
          .where('userId', '=', sam)
          .executeTakeFirstOrThrow()
      ).score,
    ).toBe(45);
    expect((await school.sam.post(`/api/packages/${activityId}/launch`, { newAttempt: true })).status).toBe(403);
    const info = await school.sam.get(`/api/packages/${activityId}`);
    expect(info.body).toMatchObject({ canStartNew: false, resumeAttemptId: null, grade: { score: 45 } });
    expect(
      info.body.attempts.map((a: { status: string; successStatus: string; score: number }) => [a.status, a.successStatus, a.score]),
    ).toEqual([
      ['finished', 'passed', 90],
      ['finished', 'failed', 40],
    ]);
  });

  it('resumes a suspended attempt where the learner left off', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const token = tokenOf(launch.body.url);
    const ops = [
      ['cmi.core.lesson_location', 'page-2'],
      ['cmi.suspend_data', '{"page":2}'],
      ['cmi.core.lesson_status', 'incomplete'],
      ['cmi.core.exit', 'suspend'],
      ['cmi.core.session_time', '0000:05:00'],
    ];
    expect((await commit(lms, token, { ops, terminate: true })).body.recorded).toBe(true);
    // A repeated or stale commit of the same session is ignored.
    expect((await commit(lms, token, { ops, terminate: true })).body.recorded).toBe(false);

    const again = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    expect(again.body.attemptId).toBe(launch.body.attemptId);
    const win = runRuntime(await (await fetchRaw(lms, `/content/${tokenOf(again.body.url)}/__coursekit/runtime.js`)).text());
    win.API!.LMSInitialize('');
    expect(win.API!.LMSGetValue('cmi.core.entry')).toBe('resume');
    expect(win.API!.LMSGetValue('cmi.core.lesson_location')).toBe('page-2');
    expect(win.API!.LMSGetValue('cmi.suspend_data')).toBe('{"page":2}');
    expect(win.API!.LMSGetValue('cmi.core.total_time')).toBe('0000:05:00');
    // Leaving without LMSFinish ends the session; Finish from an unload handler afterwards corrects it.
    win.fire('pagehide');
    win.API!.LMSSetValue('cmi.core.exit', '');
    win.API!.LMSSetValue('cmi.core.session_time', '00:01:00');
    win.API!.LMSFinish('');
    expect(win.sent.map((s) => s.body.terminate)).toEqual([true, true]);
    for (const s of win.sent) expect((await commit(lms, tokenOf(again.body.url), s.body)).body.recorded).toBe(true);
    const state = await lms.db.selectFrom('packageScoStates').selectAll().executeTakeFirstOrThrow();
    expect(state).toMatchObject({ lastExit: '', totalSeconds: 360, sessions: 2 });
    const attempt = await lms.db.selectFrom('packageAttempts').selectAll().executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ status: 'in_progress', completionStatus: 'incomplete' });
  });

  it('validates commits again on the server and enforces sizes', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const token = tokenOf(launch.body.url);
    const res = await commit(lms, token, {
      ops: [
        ['cmi.core.student_id', 'someone-else'],
        ['cmi.core.lesson_status', 'cheated'],
        ['cmi.suspend_data', 'x'.repeat(5000)],
        ['cmi.core.score.raw', '75'],
      ],
    });
    expect(res.body).toMatchObject({ recorded: true, rejected: 3 });
    const state = await lms.db.selectFrom('packageScoStates').select('data').executeTakeFirstOrThrow();
    expect(JSON.parse(state.data).values).toEqual({ 'cmi.core.score.raw': '75' });
    expect((await commit(lms, token, { ops: 'nope' })).status).toBe(400);
    const big = await fetchRaw(lms, `/content/${token}/__coursekit/commit`, { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });

  it('checks tokens: tampered, expired, another user, and previews that record nothing', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const token = tokenOf(launch.body.url);
    const [body, sig] = token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, u: await userId('kim@test.dev') })).toString('base64url')}.${sig}`;
    expect((await fetchRaw(lms, `/content/${tampered}/index.html`)).status).toBe(403);
    expect((await commit(lms, tampered, {})).status).toBe(403);

    const secret = await packageSecret(lms.db);
    const expired = signToken(secret, { p: payload.p, a: payload.a, v: payload.v, u: payload.u, t: payload.t, i: payload.i }, -1);
    expect(verifyToken(secret, expired)).toBeNull();
    expect((await fetchRaw(lms, `/content/${expired}/index.html`)).status).toBe(403);
    // A validly signed token naming another user doesn't open Sam's attempt.
    const other = signToken(secret, { ...payload, u: await userId('kim@test.dev') });
    expect((await fetchRaw(lms, `/content/${other}/index.html`)).status).toBe(403);
    // Kim can't open Sam's attempt through the API either.
    expect((await school.kim.post(`/api/packages/${activityId}/launch`, { attemptId: launch.body.attemptId })).status).toBe(404);

    const preview = await school.teacher.post(`/api/packages/${activityId}/launch`, {});
    expect(preview.body).toMatchObject({ mode: 'browse', attemptId: null });
    const win = runRuntime(await (await fetchRaw(lms, `/content/${tokenOf(preview.body.url)}/__coursekit/runtime.js`)).text());
    win.API!.LMSInitialize('');
    expect(win.API!.LMSGetValue('cmi.core.lesson_mode')).toBe('browse');
    expect(win.API!.LMSGetValue('cmi.core.credit')).toBe('no-credit');
    const res = await commit(lms, tokenOf(preview.body.url), { ops: [['cmi.core.lesson_status', 'passed']], terminate: true });
    expect(res.body).toMatchObject({ ok: true, recorded: false });
    expect(
      await lms.db
        .selectFrom('packageAttempts')
        .selectAll()
        .where('userId', '=', await userId('teacher@test.dev'))
        .execute(),
    ).toEqual([]);
    expect(await lms.db.selectFrom('grades').selectAll().execute()).toEqual([]);
  });

  it('keeps started attempts on their version when the package is replaced, and shows reports to staff', async () => {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const replaced = await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip({ 'index.html': page('New SCO') }));
    expect(replaced.body.version).toBe(2);
    const resumed = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    expect(resumed.body.attemptId).toBe(launch.body.attemptId);
    expect(await (await fetchRaw(lms, resumed.body.url)).text()).toContain('<title>SCO</title>');
    const fresh = await school.kim.post(`/api/packages/${activityId}/launch`, {});
    expect(await (await fetchRaw(lms, fresh.body.url)).text()).toContain('<title>New SCO</title>');
    // A third upload drops version 2? No: Kim's attempt uses it. Only unused versions are removed.
    await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip());
    expect((await lms.db.selectFrom('packageVersions').select('version').orderBy('version').execute()).map((v) => v.version)).toEqual([
      1, 2, 3,
    ]);

    await commit(lms, tokenOf(launch.body.url), { ops: [['cmi.core.score.raw', '50']], terminate: true });
    const report = await school.teacher.get(`/api/packages/${activityId}/report`);
    expect(report.status).toBe(200);
    expect(report.body.rows.map((r: { user: { name: string }; attempts: unknown[] }) => [r.user.name, r.attempts.length])).toEqual([
      ['Kim Student', 1],
      ['Sam Student', 1],
    ]);
    // Ending without a lesson_status completes the SCO; the mastery score (80) then makes it failed.
    expect(report.body.rows[1].attempts[0]).toMatchObject({ score: 50, version: 1, status: 'finished', successStatus: 'failed' });
    expect((await school.sam.get(`/api/packages/${activityId}/report`)).status).toBe(403);

    // Deleting the activity removes its package files from storage.
    const versions = await lms.db.selectFrom('packageVersions').select(['storagePrefix']).execute();
    expect(await lms.storage.get(`${versions[0]!.storagePrefix}index.html`)).not.toBeNull();
    expect((await del(lms, school.teacher, `/api/activities/${activityId}`)).status).toBe(200);
    expect(await lms.storage.get(`${versions[0]!.storagePrefix}index.html`)).toBeNull();
  });
});

describe('access after launch', () => {
  it('stops sessions once the learner may no longer open the activity', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip());
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    const token = tokenOf(launch.body.url);
    expect((await fetchRaw(lms, `/content/${token}/__coursekit/runtime.js`)).status).toBe(200);
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { visible: false })).status).toBe(200);
    expect((await fetchRaw(lms, `/content/${token}/__coursekit/runtime.js`)).status).toBe(403);
    expect((await commit(lms, token, { ops: [['cmi.core.lesson_status', 'passed']] })).status).toBe(403);
    expect((await school.sam.post(`/api/packages/${activityId}/launch`, {})).status).toBe(404);
  });
});

describe('the SCORM 2004 run-time', () => {
  it('implements the 2004 data model, error codes and navigation requests', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, { requirePass: true });
    await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip());
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, { itemId: 'two' });
    expect(launch.body.url).toContain('/course/content/part%20two/two.html');
    const token = tokenOf(launch.body.url);
    const win = runRuntime(await (await fetchRaw(lms, `/content/${token}/__coursekit/runtime.js`)).text());
    const api = win.API_1484_11!;
    expect(win.API).toBeUndefined();
    expect(api.GetValue('cmi.mode')).toBe('');
    expect(api.GetLastError()).toBe('122');
    expect(api.Terminate('')).toBe('false');
    expect(api.GetLastError()).toBe('112');
    expect(api.Initialize('x')).toBe('false');
    expect(api.GetLastError()).toBe('201');
    expect(api.Initialize('')).toBe('true');
    expect(api.Initialize('')).toBe('false');
    expect(api.GetLastError()).toBe('103');
    expect(api.GetValue('cmi._version')).toBe('1.0');
    expect(api.GetValue('cmi.learner_name')).toBe('Sam Student');
    expect(api.GetValue('cmi.completion_status')).toBe('unknown');
    expect(api.GetValue('cmi.scaled_passing_score')).toBe('0.7');
    expect(api.GetValue('cmi.completion_threshold')).toBe('');
    expect(api.GetLastError()).toBe('403');
    expect(api.GetValue('cmi.location')).toBe('');
    expect(api.GetLastError()).toBe('403');
    expect(api.GetValue('cmi.nothing')).toBe('');
    expect(api.GetLastError()).toBe('401');
    expect(api.GetValue('cmi.session_time')).toBe('');
    expect(api.GetLastError()).toBe('405');
    expect(api.SetValue('cmi.learner_id', 'x')).toBe('false');
    expect(api.GetLastError()).toBe('404');
    expect(api.SetValue('cmi.score.scaled', '1.5')).toBe('false');
    expect(api.GetLastError()).toBe('407');
    expect(api.SetValue('cmi.score.scaled', 'abc')).toBe('false');
    expect(api.GetLastError()).toBe('406');
    expect(api.SetValue('cmi.interactions.0.type', 'choice')).toBe('false');
    expect(api.GetLastError()).toBe('408');
    expect(api.SetValue('cmi.interactions.2.id', 'urn:x:q3')).toBe('false');
    expect(api.GetLastError()).toBe('351');
    expect(api.SetValue('cmi.interactions.0.id', 'urn:x:q1')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.learner_response', 'a[,]b')).toBe('false');
    expect(api.GetLastError()).toBe('408');
    expect(api.SetValue('cmi.interactions.0.type', 'choice')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.learner_response', 'a[,]b')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.learner_response', 'a[,]a')).toBe('false');
    expect(api.GetLastError()).toBe('406');
    expect(api.SetValue('cmi.interactions.0.correct_responses.0.pattern', 'b')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.result', 'incorrect')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.timestamp', '2026-11-25T10:00:00Z')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.latency', 'PT1M5.5S')).toBe('true');
    expect(api.SetValue('cmi.interactions.0.latency', '00:01:05')).toBe('false');
    expect(api.SetValue('cmi.objectives.0.id', 'obj-1')).toBe('true');
    expect(api.SetValue('cmi.objectives.1.id', 'obj-1')).toBe('false');
    expect(api.GetLastError()).toBe('351');
    expect(api.SetValue('cmi.objectives.0.id', 'obj-2')).toBe('false');
    expect(api.GetValue('cmi.objectives._count')).toBe('1');
    expect(api.GetValue('cmi.objectives.0.success_status')).toBe('unknown');
    expect(api.GetValue('cmi.interactions.0.objectives._count')).toBe('0');
    expect(api.GetValue('cmi.comments_from_lms._count')).toBe('0');
    expect(api.SetValue('cmi.comments_from_learner.0.comment', '{lang=en}Nice')).toBe('true');
    expect(api.SetValue('cmi.suspend_data', 'x'.repeat(64_001))).toBe('false');
    expect(api.GetValue('adl.nav.request_valid.previous')).toBe('true');
    expect(api.GetValue('adl.nav.request_valid.continue')).toBe('true');
    expect(api.GetValue('adl.nav.request_valid.choice.{target=one}')).toBe('true');
    expect(api.GetValue('adl.nav.request_valid.choice.{target=nope}')).toBe('false');
    expect(api.SetValue('adl.nav.request', '{target=one}choice')).toBe('true');
    // The success status follows the scaled passing score (0.7).
    expect(api.SetValue('cmi.score.scaled', '0.65')).toBe('true');
    expect(api.GetValue('cmi.success_status')).toBe('failed');
    expect(api.SetValue('cmi.score.scaled', '0.85')).toBe('true');
    expect(api.GetValue('cmi.success_status')).toBe('passed');
    expect(api.SetValue('cmi.completion_status', 'completed')).toBe('true');
    expect(api.SetValue('cmi.session_time', 'PT2M')).toBe('true');
    expect(api.Terminate('')).toBe('true');
    expect(api.GetValue('cmi.location')).toBe('');
    expect(api.GetLastError()).toBe('123');
    await new Promise((r) => setTimeout(r, 0));
    expect(win.messages).toContainEqual(
      expect.objectContaining({ source: 'coursekit-package', type: 'terminate', nav: '{target=one}choice' }),
    );

    for (const s of win.sent) expect((await commit(lms, token, s.body)).body).toMatchObject({ recorded: true, rejected: 0 });
    await settle(lms);
    let attempt = await lms.db.selectFrom('packageAttempts').selectAll().executeTakeFirstOrThrow();
    // Part one is still missing (and the glossary asset hasn't been opened), so the attempt goes on.
    expect(attempt).toMatchObject({ status: 'in_progress', completionStatus: 'incomplete', score: 0.85 });

    // Part one completes by progress measure (threshold 0.8); the asset completes when launched.
    const one = await school.sam.post(`/api/packages/${activityId}/launch`, { itemId: 'one' });
    expect(one.body.url).toContain('one.html?x=1&lang=en');
    await commit(lms, tokenOf(one.body.url), {
      ops: [
        ['cmi.progress_measure', '0.9'],
        ['cmi.score.raw', '6'],
        ['cmi.score.min', '0'],
        ['cmi.score.max', '10'],
      ],
      terminate: true,
    });
    await school.sam.post(`/api/packages/${activityId}/launch`, { itemId: 'three' });
    await settle(lms);
    attempt = await lms.db.selectFrom('packageAttempts').selectAll().executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ completionStatus: 'completed', successStatus: 'passed' });
    // Average of the two SCO scores: 0.6 and 0.85.
    expect(attempt.score).toBeCloseTo(0.725, 5);
    const grade = await lms.db.selectFrom('grades').select('score').where('activityId', '=', activityId).executeTakeFirstOrThrow();
    expect(grade.score).toBe(72.5);
    expect(await lms.db.selectFrom('completions').selectAll().where('activityId', '=', activityId).execute()).toHaveLength(1);
  });
});

describe('upgrading from 0.2.0', () => {
  it('adds the package tables and keeps existing data', async () => {
    const { db } = await createDatabase('sqlite::memory:');
    try {
      const upTo006 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= '006_grade_categories'));
      const old = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => upTo006 } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      const ts = new Date().toISOString();
      const userIdValue = newId();
      await db
        .insertInto('users')
        .values({
          id: userIdValue,
          email: 'old@test.dev',
          name: 'Old',
          passwordHash: null,
          role: 'student',
          avatarUrl: null,
          bio: null,
          status: 'active',
          lastLoginAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();
      const results = await migrateToLatest(db);
      const later = Object.keys(migrations).filter((name) => name > '006_grade_categories');
      expect(results.map((r) => [r.migrationName, r.status])).toEqual(later.map((name) => [name, 'Success']));
      expect(later).toContain('008_packages');
      expect(await db.selectFrom('users').select('email').execute()).toEqual([{ email: 'old@test.dev' }]);
      expect(await db.selectFrom('packageVersions').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('xapiStatements').selectAll().execute()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

describe('demo packages', () => {
  it('imports the hand-written accessibility module', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, zipFiles(accessibilityScormFiles()));
    expect(res.body).toMatchObject({ kind: 'scorm12', title: 'Accessibility basics', fileCount: 5 });
    const demo = await createTestLms();
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const maya = await login(demo, 'maya.chen@coursekit.test', 'demo-password');
      const activities = await demo.db.selectFrom('activities').select(['id', 'title']).where('type', '=', 'package').execute();
      expect(activities.map((a) => a.title).sort()).toEqual(['Accessibility basics', 'Colour contrast challenge']);
      const scorm = activities.find((a) => a.title === 'Accessibility basics')!;
      const report = await maya.get(`/api/packages/${scorm.id}/report`);
      const sofia = report.body.rows.find((r: { user: { name: string } }) => r.user.name === 'Sofia Martinez');
      expect(sofia).toMatchObject({ grade: 80, completed: true });
      expect(sofia.attempts.map((a: { score: number }) => a.score)).toEqual([60, 80]);
      const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
      const info = await alex.get(`/api/packages/${scorm.id}`);
      expect(info.body).toMatchObject({ canStartNew: true, attempts: [] });
      const launch = await alex.post(`/api/packages/${scorm.id}/launch`, {});
      const html = await (await demo.fetch(new Request(`http://localhost${launch.body.url}`))).text();
      expect(html).toContain('__coursekit/runtime.js');
    } finally {
      await demo.close();
    }
  });
});

describe('fixes from review', () => {
  const noMastery = () =>
    zip({ 'imsmanifest.xml': manifest12({ items: [{ id: 'sco1', href: 'index.html' }] }), 'index.html': page('SCO') });
  async function playToken(activityId: string, body: Record<string, unknown> = {}) {
    const launch = await school.sam.post(`/api/packages/${activityId}/launch`, body);
    expect(launch.status).toBe(200);
    return { token: tokenOf(launch.body.url), attemptId: launch.body.attemptId as string };
  }
  const attemptRow = (id: string) => lms.db.selectFrom('packageAttempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('removes stored package files when a section or the whole course is deleted', async () => {
    const section = await school.teacher.post(`/api/courses/${school.course.id}/sections`, { title: 'Extra' });
    const inSection = await createPackageActivity(school.teacher, school.course.id, section.body.id);
    const inCourse = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    for (const id of [inSection, inCourse]) {
      expect((await uploadPackage(lms, school.teacher, school.course.id, id, scorm12Zip())).status).toBe(201);
    }
    const keyOf = async (activityId: string) =>
      `${(await lms.db.selectFrom('packageVersions').select('storagePrefix').where('activityId', '=', activityId).executeTakeFirstOrThrow()).storagePrefix}index.html`;
    const sectionKey = await keyOf(inSection);
    const courseKey = await keyOf(inCourse);

    expect((await del(lms, school.teacher, `/api/courses/${school.course.id}/sections/${section.body.id}`)).status).toBe(200);
    expect(await lms.storage.get(sectionKey)).toBeNull();
    expect(await lms.storage.get(courseKey)).not.toBeNull();

    expect((await del(lms, school.admin, `/api/courses/${school.course.id}`)).status).toBe(200);
    expect(await lms.db.selectFrom('packageVersions').selectAll().execute()).toEqual([]);
    expect(await lms.storage.get(courseKey)).toBeNull();
  });

  it("applies the SCO's own Finish after the run-time's pagehide ending finished the attempt", async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, noMastery())).status).toBe(201);
    const { token, attemptId } = await playToken(activityId);
    const ops = [['cmi.core.lesson_status', 'completed']];
    expect((await commit(lms, token, { sid: 'page1', seq: 3, ops, terminate: true, elapsed: 30 })).body.recorded).toBe(true);
    expect((await attemptRow(attemptId)).status).toBe('finished');
    const last = [...ops, ['cmi.core.score.raw', '90'], ['cmi.core.session_time', '00:10:00'], ['cmi.core.exit', '']];
    expect((await commit(lms, token, { sid: 'page1', seq: 4, ops: last, terminate: true })).body.recorded).toBe(true);
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'finished', score: 0.9, totalSeconds: 600 });
    expect(await lms.db.selectFrom('grades').select('score').where('activityId', '=', activityId).executeTakeFirst()).toEqual({
      score: 90,
    });
    // Other sessions still can't change a finished attempt.
    const other = await commit(lms, token, { sid: 'page2', seq: 1, ops: [['cmi.core.score.raw', '10']], terminate: true });
    expect(other.body.recorded).toBe(false);
    expect((await attemptRow(attemptId)).score).toBe(0.9);
  });

  it('completes a SCORM 1.2 SCO that ends without setting lesson_status, so a new attempt can start', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, noMastery())).status).toBe(201);
    const { token, attemptId } = await playToken(activityId);
    expect((await commit(lms, token, { ops: [['cmi.core.session_time', '00:05:00']], terminate: true })).body.recorded).toBe(true);
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'finished', completionStatus: 'completed' });
    expect(await lms.db.selectFrom('completions').select('userId').where('activityId', '=', activityId).execute()).toHaveLength(1);
    expect((await school.sam.post(`/api/packages/${activityId}/launch`, { newAttempt: true })).status).toBe(200);

    // With a mastery score, the raw score then decides passed or failed.
    const mastery = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    expect((await uploadPackage(lms, school.teacher, school.course.id, mastery, scorm12Zip())).status).toBe(201);
    const second = await playToken(mastery);
    await commit(lms, second.token, { ops: [['cmi.core.score.raw', '85']], terminate: true });
    expect(await attemptRow(second.attemptId)).toMatchObject({ status: 'finished', successStatus: 'passed' });
  });

  it('rescales package grades when the maximum points or the grading method change', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, { attemptsAllowed: 0 });
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, noMastery())).status).toBe(201);
    const grade = async () =>
      (await lms.db.selectFrom('grades').select('score').where('activityId', '=', activityId).executeTakeFirstOrThrow()).score;
    const first = await playToken(activityId);
    await commit(lms, first.token, {
      ops: [
        ['cmi.core.lesson_status', 'completed'],
        ['cmi.core.score.raw', '80'],
      ],
      terminate: true,
    });
    const second = await playToken(activityId, { newAttempt: true });
    await commit(lms, second.token, {
      ops: [
        ['cmi.core.lesson_status', 'completed'],
        ['cmi.core.score.raw', '40'],
      ],
      terminate: true,
    });
    expect(await grade()).toBe(80);
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { maxGrade: 10 })).status).toBe(200);
    expect(await grade()).toBe(8);
    expect((await school.teacher.patch(`/api/activities/${activityId}`, { settings: { gradingMethod: 'last' } })).status).toBe(200);
    expect(await grade()).toBe(4);
  });

  it('keeps recording commits after the launch token expires, and the run-time reports refused commits', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, noMastery())).status).toBe(201);
    const { token, attemptId } = await playToken(activityId);
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    const secret = await packageSecret(lms.db);
    const { x: _x, ...rest } = payload;
    const lateToken = signToken(secret, rest, -1);
    // Content needs a live token, commits from a page that is already open still count.
    expect((await fetchRaw(lms, `/content/${lateToken}/index.html`)).status).toBe(403);
    const late = await commit(lms, lateToken, { ops: [['cmi.core.lesson_status', 'completed']], terminate: true });
    expect(late).toMatchObject({ status: 200, body: { recorded: true } });
    expect((await attemptRow(attemptId)).status).toBe('finished');
    const tooLate = signToken(secret, rest, -24 * 8);
    expect((await commit(lms, tooLate, {})).status).toBe(403);

    // The run-time tells the SCO when the server refuses its commits.
    const fresh = await playToken(activityId, { newAttempt: true });
    const win = runRuntime(await (await fetchRaw(lms, `/content/${fresh.token}/__coursekit/runtime.js`)).text());
    (win as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, status: 403 });
    const api = win.API!;
    api.LMSInitialize('');
    api.LMSSetValue('cmi.core.lesson_status', 'incomplete');
    expect(api.LMSCommit('')).toBe('true');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.LMSCommit('')).toBe('false');
    expect(api.LMSGetLastError()).toBe('101');
    expect(api.LMSFinish('')).toBe('false');
  });

  it('imports folders zipped by macOS Finder, leaving out its metadata files', async () => {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const data = zip({
      'course/imsmanifest.xml': manifest12(),
      'course/index.html': page('SCO'),
      'course/.DS_Store': 'x',
      '__MACOSX/course/._index.html': 'x',
    });
    const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, data);
    expect(res.status).toBe(201);
    expect(res.body.fileCount).toBe(2);
    const files = await lms.db.selectFrom('packageFiles').select('path').orderBy('path').execute();
    expect(files.map((f) => f.path)).toEqual(['imsmanifest.xml', 'index.html']);
  });

  it('answers every /content path itself, never with the web app', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'coursekit-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const web = await createCoursekit({ databaseUrl: 'sqlite::memory:', dataDir: mkdtempSync(join(tmpdir(), 'coursekit-data-')), webDir });
    try {
      for (const path of ['/content/', '/content', '/content//index.html']) {
        const res = await web.fetch(new Request(`http://localhost${path}`));
        expect(res.status, path).toBe(404);
        expect(res.headers.get('content-security-policy'), path).toContain('sandbox');
        expect(await res.text(), path).not.toContain('id="root"');
      }
      const home = await web.fetch(new Request('http://localhost/'));
      expect(home.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    } finally {
      await web.close();
    }
  });
});
