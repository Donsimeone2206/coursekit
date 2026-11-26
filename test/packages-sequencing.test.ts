import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coursekit } from '../src/server/index.js';
import { packageSecret, signToken } from '../src/server/packages/tokens.js';
import { settle } from './completion-helpers.js';
import { createTestLms, login, setupSchool, type Client } from './helpers.js';
import { commit, createPackageActivity, fetchRaw, runRuntime, tokenOf, uploadPackage, type FakeWindow } from './package-helpers.js';
import { FLOW, cluster, control, manifest, sco, sequencedZip } from './sequencing-helpers.js';
import { parseNavRequest } from '../src/server/packages/sequencing/service.js';
import { treeOf } from './sequencing-helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
});

async function setup(xml: string, settings: Record<string, unknown> = {}) {
  const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, settings);
  const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, sequencedZip(xml));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return activityId;
}
const open = (as: Client, activityId: string, body: Record<string, unknown> = {}) => as.post(`/api/packages/${activityId}/launch`, body);

/** Loads the run-time of a launch URL like the browser does. */
async function scoPage(url: string) {
  const token = tokenOf(url);
  const res = await fetchRaw(lms, `/content/${token}/__coursekit/runtime.js`);
  const win = runRuntime(await res.text());
  return { token, status: res.status, win, api: win.API_1484_11! };
}
/** Replays what the run-time sent. */
async function deliver(token: string, win: FakeWindow) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const results = [];
  for (const s of win.sent) results.push(await commit(lms, token, s.body));
  win.sent.length = 0;
  return results;
}
const attemptRow = (id: string) => lms.db.selectFrom('packageAttempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const gradeOf = async (activityId: string) =>
  (await lms.db.selectFrom('grades').select('score').where('activityId', '=', activityId).executeTakeFirst())?.score ?? null;

const forced = manifest(sco('one') + sco('two') + sco('three'), FLOW);
const DISABLED = `<imsss:sequencingRules><imsss:preConditionRule><imsss:ruleConditions><imsss:ruleCondition condition="always"/></imsss:ruleConditions><imsss:ruleAction action="disabled"/></imsss:preConditionRule></imsss:sequencingRules>`;
type Toc = Array<{ id: string; [key: string]: unknown }>;
const entry = (body: { sequencing: { toc: Toc } }, id: string) => body.sequencing.toc.find((e) => e.id === id);

describe('a sequenced SCORM 2004 package', () => {
  it('follows forced order, delivers what the SCO asks for and ends after the last part', async () => {
    const activityId = await setup(forced);
    const first = await open(school.sam, activityId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      itemId: 'one',
      mode: 'normal',
      sequencing: {
        ended: false,
        suspended: false,
        controls: { continue: true, previous: false, exit: true, exitAll: true, suspendAll: true },
      },
    });
    expect(
      first.body.sequencing.toc.map((e: { id: string; canChoose: boolean; current: boolean }) => [e.id, e.canChoose, e.current]),
    ).toEqual([
      ['one', false, true],
      ['two', false, false],
      ['three', false, false],
    ]);
    const attemptId = first.body.attemptId as string;
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    expect(one.api.GetValue('cmi.entry')).toBe('ab-initio');
    expect(one.api.GetValue('adl.nav.request_valid.continue')).toBe('true');
    expect(one.api.GetValue('adl.nav.request_valid.previous')).toBe('false');
    expect(one.api.GetValue('adl.nav.request_valid.choice.{target=three}')).toBe('false');
    expect(one.api.GetValue('adl.nav.request_valid.jump.{target=three}')).toBe('true');

    // Choosing ahead isn't allowed; part one stays open.
    const refused = await open(school.sam, activityId, { attemptId, itemId: 'three' });
    expect(refused.body).toMatchObject({ itemId: 'one', sequencing: { deliveryId: first.body.sequencing.deliveryId } });
    expect(refused.body.sequencing.message).toMatch(/doesn't allow/);

    // The SCO finishes and asks to continue: the server delivers part two.
    one.api.SetValue('cmi.completion_status', 'completed');
    one.api.SetValue('cmi.success_status', 'passed');
    one.api.SetValue('adl.nav.request', 'continue');
    expect(one.api.Terminate('')).toBe('true');
    expect((await deliver(one.token, one.win)).map((r) => r.body.recorded)).toEqual([true]);
    const synced = await open(school.sam, activityId, { attemptId, nav: '_none_' });
    expect(synced.body).toMatchObject({ itemId: 'two', sequencing: { controls: { previous: true, continue: true } } });
    expect(synced.body.sequencing.deliveryId).not.toBe(first.body.sequencing.deliveryId);
    expect(synced.body.sequencing.toc[0]).toMatchObject({ id: 'one', completionStatus: 'completed', successStatus: 'passed' });
    // Part one's page belongs to a finished delivery: it can't record any more, and is told so (403),
    // so its run-time reports a commit failure to the SCO.
    expect((await scoPage(first.body.url)).status).toBe(403);
    expect(await commit(lms, one.token, { sid: 'another', ops: [['cmi.completion_status', 'incomplete']] })).toMatchObject({
      status: 403,
      body: { ok: false },
    });

    // Previous starts part one again, with fresh run-time data.
    const back = await open(school.sam, activityId, { attemptId, nav: 'previous' });
    expect(back.body.itemId).toBe('one');
    const again = await scoPage(back.body.url);
    again.api.Initialize('');
    expect(again.api.GetValue('cmi.entry')).toBe('ab-initio');
    expect(again.api.GetValue('cmi.completion_status')).toBe('unknown');

    expect((await open(school.sam, activityId, { attemptId, nav: 'continue' })).body.itemId).toBe('two');
    expect((await open(school.sam, activityId, { attemptId, nav: 'continue' })).body.itemId).toBe('three');
    const end = await open(school.sam, activityId, { attemptId, nav: 'continue' });
    expect(end.body).toMatchObject({
      url: '',
      itemId: '',
      sequencing: { ended: true, completionStatus: 'completed', successStatus: 'passed' },
    });
    await settle(lms);
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'finished', completionStatus: 'completed', successStatus: 'passed' });
    expect(await lms.db.selectFrom('completions').select('userId').where('activityId', '=', activityId).execute()).toHaveLength(1);
    // A finished attempt opens for review, without sequencing.
    const review = await open(school.sam, activityId, { attemptId });
    expect(review.body).toMatchObject({ mode: 'review' });
    expect(review.body.sequencing).toBeUndefined();
  });

  it("never lets the learner (or the browser) open what the rules don't allow", async () => {
    const xml = manifest(
      sco('one') +
        sco(
          'locked',
          `<imsss:sequencingRules><imsss:preConditionRule><imsss:ruleConditions><imsss:ruleCondition condition="always"/></imsss:ruleConditions><imsss:ruleAction action="disabled"/></imsss:preConditionRule></imsss:sequencingRules>`,
        ) +
        sco('three'),
      FLOW,
    );
    const activityId = await setup(xml);
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    // Jump is for content only (adl.nav.request): the API doesn't take it from the learner.
    expect((await open(school.sam, activityId, { attemptId, nav: 'jump', itemId: 'locked' })).status).toBe(400);
    expect((await open(school.sam, activityId, { attemptId, nav: 'choice', itemId: 'three' })).body).toMatchObject({ itemId: 'one' });
    expect((await open(school.sam, activityId, { attemptId, nav: 'choice', itemId: 'nothing-like-this' })).body).toMatchObject({
      itemId: 'one',
    });
    // Continue stops at the disabled part: nothing new opens.
    expect(first.body.sequencing.controls.continue).toBe(false);
    // A SCO can't choose its way past the rules either.
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    expect(one.api.GetValue('adl.nav.request_valid.continue')).toBe('false');
    one.api.SetValue('adl.nav.request', '{target=three}choice');
    one.api.Terminate('');
    await deliver(one.token, one.win);
    expect((await open(school.sam, activityId, { attemptId, nav: '_none_' })).body).toMatchObject({ itemId: 'one' });
    // Tampering with the token's delivery number breaks its signature.
    const [body, sig] = one.token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, n: 99 })).toString('base64url')}.${sig}`;
    expect((await fetchRaw(lms, `/content/${tampered}/__coursekit/runtime.js`)).status).toBe(403);
    // A signed token for an older delivery doesn't record either.
    const secret = await packageSecret(lms.db);
    const { x: _x, ...rest } = payload;
    const stale = signToken(secret, { ...rest, n: payload.n - 1 });
    expect((await commit(lms, stale, { ops: [['cmi.completion_status', 'completed']] })).status).toBe(403);
    // Other people can't navigate the attempt, and requests are checked.
    expect((await open(school.kim, activityId, { attemptId, nav: 'continue' })).status).toBe(404);
    expect((await open(school.sam, activityId, { attemptId, nav: 'sideways' })).status).toBe(400);
  });

  it('suspends and resumes where the learner left off', async () => {
    const activityId = await setup(forced);
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    one.api.SetValue('cmi.location', 'page-4');
    one.api.SetValue('cmi.suspend_data', '{"page":4}');
    one.api.SetValue('cmi.exit', 'suspend');
    one.api.Terminate('');
    await deliver(one.token, one.win);
    const suspended = await open(school.sam, activityId, { attemptId, nav: 'suspendAll' });
    expect(suspended.body).toMatchObject({ url: '', sequencing: { suspended: true, ended: false } });
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'in_progress' });
    const info = await school.sam.get(`/api/packages/${activityId}`);
    expect(info.body).toMatchObject({ resumeAttemptId: attemptId, canStartNew: false });

    const resumed = await open(school.sam, activityId, { attemptId });
    expect(resumed.body).toMatchObject({ itemId: 'one', sequencing: { suspended: false } });
    const again = await scoPage(resumed.body.url);
    again.api.Initialize('');
    expect(again.api.GetValue('cmi.entry')).toBe('resume');
    expect(again.api.GetValue('cmi.location')).toBe('page-4');
    expect(again.api.GetValue('cmi.suspend_data')).toBe('{"page":4}');
  });

  it("carries on with the open part when the learner left without exiting, and waits for the closed page's last commit", async () => {
    const activityId = await setup(forced);
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    one.api.SetValue('cmi.location', 'p2');
    // The page went away (no Terminate from the SCO): nothing is navigated.
    one.win.fire('pagehide');
    await deliver(one.token, one.win);
    const back = await open(school.sam, activityId);
    expect(back.body.itemId).toBe('one');
    const page = await scoPage(back.body.url);
    page.api.Initialize('');
    expect(page.api.GetValue('cmi.entry')).toBe('resume');
    expect(page.api.GetValue('cmi.location')).toBe('p2');
    page.api.SetValue('cmi.completion_status', 'completed');
    page.api.SetValue('cmi.success_status', 'failed');
    // The player asks the SCO page before closing it for its Continue button...
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sid = (page.win.messages.find((m) => (m as { type: string }).type === 'initialize') as { sid: string }).sid;
    page.win.fire('pagehide');
    // ...and the navigation waits for that page's last commit, which arrives a moment later.
    const later = new Promise((resolve) => setTimeout(resolve, 250)).then(() => deliver(page.token, page.win));
    const next = await open(school.sam, activityId, { attemptId, nav: 'continue', sid });
    await later;
    expect(next.body.itemId).toBe('two');
    expect(next.body.sequencing.toc[0]).toMatchObject({ id: 'one', completionStatus: 'completed', successStatus: 'failed' });
  });
});

describe('global objectives, rollup and grades', () => {
  const pretest = sco(
    'pretest',
    `<imsss:objectives>
       <imsss:primaryObjective objectiveID="pretest"/>
       <imsss:objective objectiveID="knows-module"><imsss:mapInfo targetObjectiveID="g-module" readSatisfiedStatus="false" writeSatisfiedStatus="true"/></imsss:objective>
     </imsss:objectives>
     <imsss:rollupRules rollupObjectiveSatisfied="false" rollupProgressCompletion="false" objectiveMeasureWeight="0"/>`,
  );
  const module = cluster(
    'module',
    sco('lesson'),
    `${FLOW}<imsss:sequencingRules><imsss:preConditionRule><imsss:ruleConditions><imsss:ruleCondition condition="satisfied"/></imsss:ruleConditions><imsss:ruleAction action="skip"/></imsss:preConditionRule></imsss:sequencingRules>
     <imsss:rollupRules objectiveMeasureWeight="0"/>
     <imsss:objectives><imsss:primaryObjective objectiveID="module"><imsss:mapInfo targetObjectiveID="g-module" writeSatisfiedStatus="true"/></imsss:primaryObjective></imsss:objectives>
     <adlseq:rollupConsiderations requiredForSatisfied="ifNotSkipped" requiredForNotSatisfied="ifNotSkipped" requiredForCompleted="ifNotSkipped" requiredForIncomplete="ifNotSkipped"/>`,
  );
  const final = sco(
    'final',
    `<imsss:objectives><imsss:primaryObjective objectiveID="final" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives>`,
  );
  const xml = manifest(pretest + module + final, FLOW);

  it('skips what the pre-test showed, and grades the attempt from the rolled-up course', async () => {
    const activityId = await setup(xml, { requirePass: true });
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    const pre = await scoPage(first.body.url);
    pre.api.Initialize('');
    expect(pre.api.GetValue('cmi.objectives._count')).toBe('2');
    expect(pre.api.GetValue('cmi.objectives.1.id')).toBe('knows-module');
    pre.api.SetValue('cmi.objectives.1.success_status', 'passed');
    pre.api.SetValue('cmi.completion_status', 'completed');
    pre.api.SetValue('cmi.score.scaled', '0.5');
    pre.api.SetValue('adl.nav.request', 'continue');
    pre.api.Terminate('');
    await deliver(pre.token, pre.win);
    const quiz = await open(school.sam, activityId, { attemptId, nav: '_none_' });
    expect(quiz.body.itemId).toBe('final');
    const q = await scoPage(quiz.body.url);
    q.api.Initialize('');
    expect(q.api.GetValue('cmi.scaled_passing_score')).toBe('0.8');
    q.api.SetValue('cmi.score.scaled', '0.9');
    q.api.SetValue('cmi.completion_status', 'completed');
    q.api.Commit('');
    await deliver(q.token, q.win);
    // The grade follows the course's rolled-up measure as soon as it changes.
    expect(await gradeOf(activityId)).toBe(90);
    q.api.SetValue('adl.nav.request', 'continue');
    q.api.Terminate('');
    await deliver(q.token, q.win);
    await settle(lms);
    expect(await attemptRow(attemptId)).toMatchObject({
      status: 'finished',
      completionStatus: 'completed',
      successStatus: 'passed',
      score: 0.9,
    });
    expect(await lms.db.selectFrom('completions').select('userId').where('activityId', '=', activityId).execute()).toHaveLength(1);
    const state = await lms.db
      .selectFrom('packageSequencingStates')
      .select('state')
      .where('attemptId', '=', attemptId)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(state.state).globals).toEqual({ 'g-module': { ps: true, ss: true } });
  });

  it('keeps global objectives and shared data to the attempt, and shares data between SCOs', async () => {
    const shared = manifest(
      sco('writer', '', '<adlcp:data><adlcp:map targetID="notes" writeSharedData="true"/></adlcp:data>') +
        sco('reader', '', '<adlcp:data><adlcp:map targetID="notes"/></adlcp:data>'),
    );
    const activityId = await setup(shared, { attemptsAllowed: 0 });
    const first = await open(school.sam, activityId, { itemId: 'writer' });
    const attemptId = first.body.attemptId as string;
    const w = await scoPage(first.body.url);
    w.api.Initialize('');
    expect(w.api.GetValue('adl.data._count')).toBe('1');
    expect(w.api.GetValue('adl.data.0.id')).toBe('notes');
    expect(w.api.GetValue('adl.data.0.store')).toBe('');
    expect(w.api.GetLastError()).toBe('403');
    expect(w.api.SetValue('adl.data.0.store', 'Remember the contrast ratio')).toBe('true');
    expect(w.api.SetValue('adl.data.0.id', 'x')).toBe('false');
    w.api.Commit('');
    await deliver(w.token, w.win);
    const reading = await open(school.sam, activityId, { attemptId, itemId: 'reader' });
    const r = await scoPage(reading.body.url);
    r.api.Initialize('');
    expect(r.api.GetValue('adl.data.0.store')).toBe('Remember the contrast ratio');
    expect(r.api.SetValue('adl.data.0.store', 'changed')).toBe('false');
    expect(r.api.GetLastError()).toBe('404');
    // Kim's attempt has its own stores.
    const kim = await open(school.kim, activityId, { itemId: 'reader' });
    const k = await scoPage(kim.body.url);
    k.api.Initialize('');
    expect(k.api.GetValue('adl.data.0.store')).toBe('');
    expect(k.api.GetLastError()).toBe('403');
  });
});

describe('packages with one SCO and no sequencing rules', () => {
  const single = manifest(sco('only'));

  it('opens the SCO and ends the attempt when it terminates, unless it suspends or the page just went away', async () => {
    const activityId = await setup(single, { attemptsAllowed: 0 });
    const first = await open(school.sam, activityId);
    expect(first.body).toMatchObject({ itemId: 'only', sequencing: { controls: { exit: false, exitAll: true, suspendAll: true } } });
    const a = await scoPage(first.body.url);
    a.api.Initialize('');
    a.api.SetValue('cmi.exit', 'suspend');
    a.api.Terminate('');
    await deliver(a.token, a.win);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'in_progress' });
    const resumed = await open(school.sam, activityId);
    expect(resumed.body.attemptId).toBe(first.body.attemptId);
    const b = await scoPage(resumed.body.url);
    b.api.Initialize('');
    expect(b.api.GetValue('cmi.entry')).toBe('resume');
    // The page goes away mid-way: the attempt stays open.
    b.win.fire('pagehide');
    await deliver(b.token, b.win);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'in_progress' });
    const third = await open(school.sam, activityId);
    const c = await scoPage(third.body.url);
    c.api.Initialize('');
    c.api.SetValue('cmi.score.scaled', '0.75');
    c.api.SetValue('cmi.completion_status', 'completed');
    c.api.Terminate('');
    await deliver(c.token, c.win);
    await settle(lms);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'finished', completionStatus: 'completed', score: 0.75 });
    expect(await gradeOf(activityId)).toBe(75);
    const next = await open(school.sam, activityId, { newAttempt: true });
    expect(next.body.attemptId).not.toBe(first.body.attemptId);
  });

  it('grades a SCO that reports only a raw score from its own score, as 0.3.0 did', async () => {
    const activityId = await setup(single);
    const first = await open(school.sam, activityId);
    const a = await scoPage(first.body.url);
    a.api.Initialize('');
    a.api.SetValue('cmi.score.raw', '8');
    a.api.SetValue('cmi.score.min', '0');
    a.api.SetValue('cmi.score.max', '10');
    a.api.SetValue('cmi.completion_status', 'completed');
    a.api.Terminate('');
    await deliver(a.token, a.win);
    await settle(lms);
    // No cmi.score.scaled, so the course has no rolled-up measure: the grade comes from the SCO's raw score.
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'finished', completionStatus: 'completed', score: 0.8 });
    expect(await gradeOf(activityId)).toBe(80);
  });

  it('ends the attempt on cmi.exit "logout", and records nothing for staff previews', async () => {
    const activityId = await setup(manifest(sco('a') + sco('b')));
    const first = await open(school.sam, activityId);
    const a = await scoPage(first.body.url);
    a.api.Initialize('');
    a.api.SetValue('cmi.exit', 'logout');
    a.api.Terminate('');
    await deliver(a.token, a.win);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'finished' });

    const preview = await open(school.teacher, activityId, {});
    expect(preview.body).toMatchObject({ mode: 'browse', attemptId: null });
    expect(preview.body.sequencing).toBeUndefined();
    const p = await scoPage(preview.body.url);
    p.api.Initialize('');
    expect(p.api.GetValue('cmi.mode')).toBe('browse');
    p.api.SetValue('cmi.completion_status', 'completed');
    p.api.Terminate('');
    await deliver(p.token, p.win);
    const teacher = await lms.db.selectFrom('users').select('id').where('email', '=', 'teacher@test.dev').executeTakeFirstOrThrow();
    expect(await lms.db.selectFrom('packageAttempts').select('id').where('userId', '=', teacher.id).execute()).toEqual([]);
    expect((await lms.db.selectFrom('packageSequencingStates').select('attemptId').execute()).map((r) => r.attemptId)).toEqual([
      first.body.attemptId,
    ]);
  });
});

describe('manifests', () => {
  it('imports sequencing collections and reports what it ignored', async () => {
    const xml = manifest(
      sco('a', '') +
        `<item identifier="b" identifierref="sco"><title>b</title><imsss:sequencing IDRef="shared"><imsss:deliveryControls tracked="maybe"/></imsss:sequencing></item>`,
      control('flow="true"'),
      `<imsss:sequencingCollection><imsss:sequencing ID="shared"><imsss:limitConditions attemptLimit="2"/><imsss:deliveryControls tracked="false"/></imsss:sequencing></imsss:sequencingCollection>`,
    );
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId);
    const res = await uploadPackage(lms, school.teacher, school.course.id, activityId, sequencedZip(xml));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['"b": tracked="maybe" isn\'t true or false, so the default (true) is used.']);
    const version = await lms.db.selectFrom('packageVersions').select('structure').executeTakeFirstOrThrow();
    const b = JSON.parse(version.structure).sequencing.activities[2];
    // The local deliveryControls replace the collection's; the collection's limit conditions stay.
    expect(b).toMatchObject({ id: 'b', attemptLimit: 2, tracked: true });
  });
});

describe('the demo', () => {
  it('adds the Inclusive design package with an attempt in progress', async () => {
    const demo = await createTestLms();
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const activity = await demo.db
        .selectFrom('activities')
        .innerJoin('sections', 'sections.id', 'activities.sectionId')
        .select(['activities.id', 'activities.position', 'sections.title as section'])
        .where('activities.title', '=', 'Inclusive design')
        .executeTakeFirstOrThrow();
      expect(activity).toMatchObject({ section: 'Accessibility', position: 2 });
      const maya = await login(demo, 'maya.chen@coursekit.test', 'demo-password');
      const report = await maya.get(`/api/packages/${activity.id}/report`);
      const lucasRow = report.body.rows.find((r: { user: { name: string } }) => r.user.name === 'Lucas Silva');
      expect(lucasRow).toMatchObject({ grade: null, attempts: [{ status: 'in_progress', completionStatus: 'incomplete', score: null }] });

      const lucas = await login(demo, 'lucas.silva@coursekit.test', 'demo-password');
      const info = await lucas.get(`/api/packages/${activity.id}`);
      expect(info.body.resumeAttemptId).toBeTruthy();
      const resumed = await lucas.post(`/api/packages/${activity.id}/launch`, { attemptId: info.body.resumeAttemptId });
      expect(resumed.body).toMatchObject({ itemId: 'how-extend', sequencing: { controls: { previous: true } } });
      const toc = Object.fromEntries(
        resumed.body.sequencing.toc.map((e: { id: string; completionStatus: string; canChoose: boolean }) => [
          e.id,
          [e.completionStatus, e.canChoose],
        ]),
      );
      expect(toc).toMatchObject({
        pretest: ['completed', false],
        'who-mismatch': ['not attempted', true],
        'how-exclusion': ['completed', true],
        'final-quiz': ['not attempted', false],
      });

      const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
      const start = await alex.post(`/api/packages/${activity.id}/launch`, {});
      expect(start.body).toMatchObject({ itemId: 'pretest', url: expect.stringContaining('index.html?part=pretest') });
      const html = await (await demo.fetch(new Request(`http://localhost${start.body.url}`))).text();
      expect(html).toContain('__coursekit/runtime.js');
    } finally {
      await demo.close();
    }
  });
});

describe('what the learner and the content may ask for', () => {
  it('takes jump only from 4th edition content, never from the learner', async () => {
    const activityId = await setup(forced);
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    // The forced order can't be skipped through the API.
    expect((await open(school.sam, activityId, { attemptId, nav: 'jump', itemId: 'three' })).status).toBe(400);
    const still = await open(school.sam, activityId, { attemptId, nav: '_none_' });
    expect(still.body).toMatchObject({ itemId: 'one', sequencing: { deliveryId: first.body.sequencing.deliveryId } });
    expect(entry(still.body, 'three')).toMatchObject({ attempted: false });
    // A 4th edition SCO may jump (that is what the request is for).
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    expect(one.api.GetValue('adl.nav.request_valid.jump.{target=three}')).toBe('true');
    expect(one.api.SetValue('adl.nav.request', '{target=three}jump')).toBe('true');
    one.api.Terminate('');
    await deliver(one.token, one.win);
    expect((await open(school.sam, activityId, { attemptId, nav: '_none_' })).body.itemId).toBe('three');

    // The same package as 3rd edition content: jump isn't part of its run-time.
    const third = await setup(forced.replace('2004 4th Edition', '2004 3rd Edition'));
    const t = await open(school.sam, third);
    const page = await scoPage(t.body.url);
    page.api.Initialize('');
    expect(page.api.GetValue('adl.nav.request_valid.jump.{target=three}')).toBe('false');
    expect(page.api.SetValue('adl.nav.request', '{target=three}jump')).toBe('false');
    expect(page.api.GetLastError()).toBe('406');
    // A commit crafted to carry it anyway: the server's own run-time refuses the value.
    const crafted = await commit(lms, page.token, {
      sid: 'crafted',
      ops: [
        ['cmi.completion_status', 'completed'],
        ['adl.nav.request', '{target=three}jump'],
      ],
      terminate: true,
    });
    expect(crafted.body).toMatchObject({ recorded: true, rejected: 1 });
    const after = await open(school.sam, third, { attemptId: t.body.attemptId, nav: '_none_' });
    expect(after.body.itemId).toBe('one');
    expect(entry(after.body, 'three')).toMatchObject({ attempted: false });
    const tree = treeOf(forced);
    expect(parseNavRequest(tree, '{target=three}jump', { jump: false })).toBeNull();
    expect(parseNavRequest(tree, '{target=three}choice', { jump: false })).toEqual({ nav: 'choice', target: 3 });
  });

  it("doesn't let a window that fell behind navigate the attempt", async () => {
    const activityId = await setup(forced);
    const tabA = await open(school.sam, activityId);
    const attemptId = tabA.body.attemptId as string;
    // A second window opens the same attempt (part one again, a new delivery) and moves on to part two.
    const tabB = await open(school.sam, activityId, { attemptId });
    expect(tabB.body.itemId).toBe('one');
    expect(tabB.body.sequencing.deliveryId).not.toBe(tabA.body.sequencing.deliveryId);
    const two = await open(school.sam, activityId, { attemptId, nav: 'continue', deliveryId: tabB.body.sequencing.deliveryId });
    expect(two.body.itemId).toBe('two');
    // The first window still shows part one. Its Continue (sent with the page it just closed) changes
    // nothing, doesn't wait for that page, and says where the attempt is now.
    const started = Date.now();
    const stale = await open(school.sam, activityId, {
      attemptId,
      nav: 'continue',
      deliveryId: tabA.body.sequencing.deliveryId,
      sid: 'tab-a-page',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stale.body).toMatchObject({
      itemId: 'two',
      sequencing: { deliveryId: two.body.sequencing.deliveryId, message: expect.stringMatching(/moved on/) },
    });
    expect(entry(stale.body, 'two')).toMatchObject({ current: true, completionStatus: 'incomplete', successStatus: 'unknown' });
    expect(entry(stale.body, 'three')).toMatchObject({ attempted: false });
    // Its page can't record either, and is told so.
    const old = await commit(lms, tokenOf(tabA.body.url), { sid: 'tab-a-page', ops: [['cmi.completion_status', 'completed']] });
    expect(old.status).toBe(403);
    // The window that is up to date carries on; with nothing open, the player sends null.
    const three = await open(school.sam, activityId, { attemptId, nav: 'continue', deliveryId: two.body.sequencing.deliveryId });
    expect(three.body.itemId).toBe('three');
    const exited = await open(school.sam, activityId, { attemptId, nav: 'exit', deliveryId: three.body.sequencing.deliveryId });
    expect(exited.body).toMatchObject({ itemId: '', sequencing: { deliveryId: null, ended: false, controls: { continue: true } } });
    const end = await open(school.sam, activityId, { attemptId, nav: 'continue', deliveryId: null });
    expect(end.body.sequencing).toMatchObject({ ended: true });
  });
});

describe('when the attempt ends', () => {
  it('finishes a completed attempt when the learner leaves, unless the SCO suspended', async () => {
    // One SCO: completed and passed, then the page goes away (the learner closes the player).
    const single = await setup(manifest(sco('only')), { attemptsAllowed: 3 });
    const a = await open(school.sam, single);
    const page = await scoPage(a.body.url);
    page.api.Initialize('');
    page.api.SetValue('cmi.completion_status', 'completed');
    page.api.SetValue('cmi.success_status', 'passed');
    page.api.SetValue('cmi.score.scaled', '0.9');
    page.api.Commit('');
    page.win.fire('pagehide');
    await deliver(page.token, page.win);
    await settle(lms);
    expect(await attemptRow(a.body.attemptId)).toMatchObject({
      status: 'finished',
      completionStatus: 'completed',
      successStatus: 'passed',
      score: 0.9,
    });
    expect((await school.sam.get(`/api/packages/${single}`)).body).toMatchObject({ resumeAttemptId: null, canStartNew: true });
    // The player, still open, asks what to show: the attempt's summary (not a review of it).
    const summary = await open(school.sam, single, { attemptId: a.body.attemptId, nav: '_none_' });
    expect(summary.body).toMatchObject({
      url: '',
      itemId: '',
      mode: 'normal',
      sequencing: { ended: true, deliveryId: null, completionStatus: 'completed', successStatus: 'passed', score: 90 },
    });
    expect(summary.body.sequencing.controls).toMatchObject({ continue: false, previous: false, exitAll: false });
    // Without a navigation request (the activity page), a finished attempt still opens for review.
    expect((await open(school.sam, single, { attemptId: a.body.attemptId })).body).toMatchObject({ mode: 'review' });

    // Completed, but the SCO said cmi.exit "suspend": the attempt waits to be resumed.
    const b = await open(school.sam, single, { newAttempt: true });
    const suspending = await scoPage(b.body.url);
    suspending.api.Initialize('');
    suspending.api.SetValue('cmi.completion_status', 'completed');
    suspending.api.SetValue('cmi.exit', 'suspend');
    suspending.win.fire('pagehide');
    await deliver(suspending.token, suspending.win);
    expect(await attemptRow(b.body.attemptId)).toMatchObject({ status: 'in_progress', completionStatus: 'completed' });

    // Several SCOs and no rules (choice, no flow): leaving before the last part is done keeps the
    // attempt open; leaving once every part is completed finishes it.
    const multi = await setup(manifest(sco('a') + sco('b')));
    const first = await open(school.kim, multi);
    expect(first.body.itemId).toBe('a');
    const pa = await scoPage(first.body.url);
    pa.api.Initialize('');
    pa.api.SetValue('cmi.completion_status', 'completed');
    pa.api.Commit('');
    pa.win.fire('pagehide');
    await deliver(pa.token, pa.win);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'in_progress' });
    const next = await open(school.kim, multi, { attemptId: first.body.attemptId, nav: 'choice', itemId: 'b' });
    expect(next.body.itemId).toBe('b');
    const pb = await scoPage(next.body.url);
    pb.api.Initialize('');
    pb.api.SetValue('cmi.completion_status', 'completed');
    pb.win.fire('pagehide');
    await deliver(pb.token, pb.win);
    await settle(lms);
    expect(await attemptRow(first.body.attemptId)).toMatchObject({ status: 'finished', completionStatus: 'completed' });
    expect(await lms.db.selectFrom('completions').select('userId').where('activityId', '=', multi).execute()).toHaveLength(1);
  });

  it('ends the attempt when nothing is left to open', async () => {
    const xml = manifest(sco('one') + sco('locked', DISABLED) + sco('three'), FLOW);
    const activityId = await setup(xml);
    // The SCO asks to continue, but the next part is disabled and nothing else can be opened.
    const first = await open(school.sam, activityId);
    const attemptId = first.body.attemptId as string;
    const one = await scoPage(first.body.url);
    one.api.Initialize('');
    one.api.SetValue('cmi.completion_status', 'completed');
    one.api.SetValue('adl.nav.request', 'continue');
    one.api.Terminate('');
    await deliver(one.token, one.win);
    await settle(lms);
    const after = await open(school.sam, activityId, { attemptId, nav: '_none_' });
    expect(after.body).toMatchObject({ url: '', itemId: '', sequencing: { ended: true } });
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'finished', completionStatus: 'incomplete' });
    // The same through the player: Kim exits the part, with nothing to go on to.
    const k = await open(school.kim, activityId);
    const exited = await open(school.kim, activityId, {
      attemptId: k.body.attemptId,
      nav: 'exit',
      deliveryId: k.body.sequencing.deliveryId,
    });
    expect(exited.body).toMatchObject({ url: '', sequencing: { ended: true } });
    expect(await attemptRow(k.body.attemptId)).toMatchObject({ status: 'finished' });
  });
});

describe('identifiers from the manifest', () => {
  const FIELDS = ['ps', 'ss', 'ms', 'nm', 'raw', 'min', 'max', 'cps', 'cs', 'pms', 'pm'];

  it('keeps a global objective and a shared data store called "__proto__" in the attempt, and the server keeps answering', async () => {
    const xml = manifest(
      sco(
        'writer',
        `<imsss:objectives><imsss:primaryObjective objectiveID="w"><imsss:mapInfo targetObjectiveID="__proto__" writeSatisfiedStatus="true" writeNormalizedMeasure="true"/></imsss:primaryObjective></imsss:objectives>
         <adlseq:objectives><adlseq:objective objectiveID="w"><adlseq:mapInfo targetObjectiveID="__proto__" writeCompletionStatus="true"/></adlseq:objective></adlseq:objectives>`,
        '<adlcp:data><adlcp:map targetID="__proto__" writeSharedData="true"/></adlcp:data>',
      ) +
        sco(
          'reader',
          `<imsss:objectives><imsss:primaryObjective objectiveID="r"><imsss:mapInfo targetObjectiveID="__proto__"/></imsss:primaryObjective></imsss:objectives>`,
          '<adlcp:data><adlcp:map targetID="__proto__"/></adlcp:data>',
        ),
    );
    const activityId = await setup(xml);
    try {
      // The first launch works out request validity, which ends the open attempt on a copy (End
      // Attempt writes the objective maps).
      const first = await open(school.sam, activityId, { itemId: 'writer' });
      expect(first.status).toBe(200);
      for (const field of FIELDS) expect(Object.hasOwn(Object.prototype, field), field).toBe(false);
      expect((await school.admin.get('/api/courses')).status).toBe(200);
      const attemptId = first.body.attemptId as string;
      const w = await scoPage(first.body.url);
      w.api.Initialize('');
      expect(w.api.SetValue('adl.data.0.store', 'kept')).toBe('true');
      w.api.SetValue('cmi.completion_status', 'completed');
      w.api.SetValue('cmi.success_status', 'failed');
      w.api.SetValue('cmi.score.scaled', '0.25');
      w.api.Terminate('');
      await deliver(w.token, w.win);
      const reading = await open(school.sam, activityId, { attemptId, nav: 'choice', itemId: 'reader' });
      expect(reading.status).toBe(200);
      expect(entry(reading.body, 'reader')).toMatchObject({ successStatus: 'failed', score: 25 });
      const r = await scoPage(reading.body.url);
      r.api.Initialize('');
      expect(r.api.GetValue('adl.data.0.store')).toBe('kept');
      const stored = await lms.db
        .selectFrom('packageSequencingStates')
        .select('state')
        .where('attemptId', '=', attemptId)
        .executeTakeFirstOrThrow();
      const state = JSON.parse(stored.state) as { globals: object; data: object };
      expect(Object.hasOwn(state.globals, '__proto__')).toBe(true);
      expect(Object.hasOwn(state.data, '__proto__')).toBe(true);
      for (const field of FIELDS) expect(Object.hasOwn(Object.prototype, field), field).toBe(false);
      // Someone else's launch of the same package, and other requests, are answered as usual.
      expect((await open(school.kim, activityId)).status).toBe(200);
      expect((await school.admin.get('/api/courses')).status).toBe(200);
    } finally {
      for (const field of FIELDS) delete (Object.prototype as Record<string, unknown>)[field];
    }
  });
});
