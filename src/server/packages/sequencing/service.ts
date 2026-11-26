/**
 * SCORM 2004 sequencing for package attempts: loads and saves each attempt's tracking state, runs
 * navigation requests (from the player and from SCOs), keeps the SCO run-time data in step with
 * deliveries, and records the attempt's result from the root activity's rolled-up status.
 * The server is the authority: the browser never decides what is delivered.
 */
import {
  PACKAGE_NAV_REQUESTS,
  type PackageNavControl,
  type PackageSequencingInfo,
  type PackageTocEntry,
} from '../../../shared/package-sequencing.js';
import type { PackageLaunch, PackageLaunchInput } from '../../../shared/packages.js';
import type { PackageSettings } from '../../../shared/types.js';
import type { AppDeps } from '../../context.js';
import type { PackageAttemptRow, PackageScoStateRow, PackageVersionRow } from '../../db/schema-packages.js';
import type { DB } from '../../db/types.js';
import { ApiError, conflict } from '../../lib/http.js';
import { now, parseJson, round } from '../../lib/util.js';
import { parseScormManifest, type PackageStructure } from '../manifest.js';
import type { ModelInit, RuntimeModel } from '../runtime.js';
import { CONTENT_PREFIX, formatDuration, structureOf, syncResults, toVersionInfo, type RuntimeContext } from '../service.js';
import { packageSecret, signToken } from '../tokens.js';
import { Sequencer, type NavOutcome, type RuntimeReport } from './engine.js';
import { defaultSequencingTree } from './parse.js';
import {
  cloneState,
  emptyState,
  MAX_SHARED_DATA_CHARS,
  ownValue,
  parseState,
  SequencingStateTooLarge,
  serializeState as serializeRaw,
  setOwnValue,
} from './state.js';
import { ROOT, type NavRequest, type SequencingState, type SequencingTree } from './types.js';
import { hiddenFromChoice, navValidity, type NavValidity } from './validity.js';

type Deps = Pick<AppDeps, 'db' | 'events' | 'storage' | 'config'>;

export interface SequencingContext {
  tree: SequencingTree;
  structure: PackageStructure;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function serializeState(state: SequencingState): string {
  try {
    return serializeRaw(state);
  } catch (err) {
    if (err instanceof SequencingStateTooLarge) throw new ApiError(413, err.message, 'too_large');
    throw err;
  }
}
const indexOf = (tree: SequencingTree, id: string) => tree.activities.findIndex((a, i) => i !== ROOT && a.id === id);
const leafCount = (tree: SequencingTree) => tree.activities.filter((a, i) => i !== ROOT && a.children.length === 0).length;

// ----- the activity tree of a version -----

/** Builds a tree with default sequencing from the stored items (their depth gives the nesting). */
function treeFromItems(structure: PackageStructure): SequencingTree {
  const stack: string[] = [];
  const items = structure.items.map((item) => {
    stack.length = Math.min(stack.length, item.depth);
    const parentId = stack[item.depth - 1] ?? null;
    stack[item.depth] = item.id;
    return {
      id: item.id,
      title: item.title,
      depth: item.depth,
      launchable: item.launchable,
      sco: item.sco,
      visible: item.visible !== false,
      parentId,
    };
  });
  return defaultSequencingTree(structure.title, items);
}

/**
 * The version's activity tree. Versions imported before 0.4.0 have no sequencing definitions stored:
 * their manifest is read again (and the result kept), or, failing that, the defaults apply.
 */
export async function sequencingFor(deps: Pick<Deps, 'db' | 'storage'>, version: PackageVersionRow): Promise<SequencingContext> {
  const structure = structureOf(version);
  if (structure.sequencing?.activities.length === structure.items.length + 1) return { tree: structure.sequencing, structure };
  try {
    const files = await deps.db.selectFrom('packageFiles').select('path').where('versionId', '=', version.id).execute();
    const exact = new Set(files.map((f) => f.path));
    const byLower = new Map(files.map((f) => [f.path.toLowerCase(), f.path]));
    const manifestPath = byLower.get('imsmanifest.xml');
    const stream = manifestPath ? await deps.storage.get(version.storagePrefix + manifestPath) : null;
    if (stream) {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(await new Response(stream).arrayBuffer()));
      const parsed = parseScormManifest(text, (p) => byLower.has(p.toLowerCase()));
      const ids = new Set(parsed.items.map((i) => i.id));
      if (parsed.sequencing && structure.items.every((i) => ids.has(i.id))) {
        for (const item of parsed.items) {
          if (item.path && !exact.has(item.path)) {
            const actual = byLower.get(item.path.toLowerCase())!;
            item.href = item.href!.replace(/^[^?#]*/, actual.split('/').map(encodeURIComponent).join('/'));
            item.path = actual;
          }
        }
        await deps.db
          .updateTable('packageVersions')
          .set({ structure: JSON.stringify(parsed) })
          .where('id', '=', version.id)
          .execute();
        return { tree: parsed.sequencing, structure: parsed };
      }
    }
  } catch {
    // fall back to the defaults below
  }
  return { tree: treeFromItems(structure), structure };
}

// ----- state -----

async function scoRows(db: DB, attemptId: string) {
  return db.selectFrom('packageScoStates').selectAll().where('attemptId', '=', attemptId).execute();
}

/** A new state, or one built from the run-time data of an attempt that started before 0.4.0. */
function buildState(tree: SequencingTree, attempt: PackageAttemptRow, rows: PackageScoStateRow[]): SequencingState {
  let seed = 0;
  for (const ch of attempt.id) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
  const state = emptyState(tree, seed);
  const seq = new Sequencer(tree, state, Date.parse(attempt.startedAt) || Date.now());
  seq.prepare();
  const touched = rows.map((r) => ({ row: r, index: indexOf(tree, r.itemId) })).filter((x) => x.index > 0);
  if (!touched.length) return state;
  // The attempt began before sequencing was recorded: count one attempt on everything it opened.
  const attempted = new Set<number>();
  for (const { index } of touched) for (const a of seq.pathToRoot(index)) attempted.add(a);
  for (const a of [...attempted].sort((x, y) => x - y)) {
    const s = seq.st(a);
    s.count = 1;
    s.aps = true;
    s.stamp = ++state.clock;
    s.start = Date.parse(attempt.startedAt) || Date.now();
  }
  // Parts left with cmi.exit "suspend" are suspended, and the learner carries on with the part opened
  // last, as if they had just left it: set before the run-time data goes in, so rollup sees them so.
  for (const { row, index } of touched) seq.st(index).suspended = row.lastExit === 'suspend';
  const last = attempt.lastItemId ? indexOf(tree, attempt.lastItemId) : -1;
  if (last > 0 && touched.some((t) => t.index === last)) {
    for (const a of seq.pathToRoot(last)) seq.st(a).active = true;
    state.current = last;
  }
  for (const { row, index } of touched) {
    const values = parseJson<{ values?: Record<string, string> }>(row.data, {}).values ?? {};
    const num = (v: string | undefined) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    // Only what the SCO reported: these SCO attempts never went through End Attempt, so its defaults
    // (completed and satisfied when the content said nothing) don't apply.
    seq.applyRuntime(
      index,
      {
        completion: row.completionStatus === 'completed' ? 'completed' : row.completionStatus === 'incomplete' ? 'incomplete' : 'unknown',
        success: row.successStatus,
        scaled: num(values['cmi.score.scaled']) ?? (row.score === null ? null : row.score),
        raw: num(values['cmi.score.raw']),
        min: num(values['cmi.score.min']),
        max: num(values['cmi.score.max']),
        progress: num(values['cmi.progress_measure']),
        objectives: [],
      },
      { endDefaults: false },
    );
  }
  return state;
}

async function loadState(
  deps: Pick<Deps, 'db'>,
  attempt: PackageAttemptRow,
  tree: SequencingTree,
): Promise<{ state: SequencingState; revision: number }> {
  const { db } = deps;
  for (let tries = 0; tries < 3; tries++) {
    const row = await db.selectFrom('packageSequencingStates').selectAll().where('attemptId', '=', attempt.id).executeTakeFirst();
    const parsed = row ? parseState(row.state, tree) : null;
    if (row && parsed) return { state: parsed, revision: row.revision };
    const state = buildState(tree, attempt, await scoRows(db, attempt.id));
    const text = serializeState(state);
    if (row) {
      // Stored for another shape of the tree: start again from the run-time data.
      const res = await db
        .updateTable('packageSequencingStates')
        .set({ state: text, revision: row.revision + 1, updatedAt: now() })
        .where('attemptId', '=', attempt.id)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) > 0) return { state, revision: row.revision + 1 };
    } else {
      await db
        .insertInto('packageSequencingStates')
        .values({ attemptId: attempt.id, state: text, revision: 0, updatedAt: now() })
        .onConflict((oc) => oc.column('attemptId').doNothing())
        .execute();
    }
  }
  throw conflict('This attempt is busy. Please try again.');
}

/** Runs `fn` on the attempt's state and saves it; when another request saved first, runs again on the newer state. */
async function mutate<T>(
  deps: Pick<Deps, 'db'>,
  attempt: PackageAttemptRow,
  tree: SequencingTree,
  fn: (seq: Sequencer) => T,
): Promise<{ result: T; state: SequencingState }> {
  for (let tries = 0; tries < 6; tries++) {
    const { state, revision } = await loadState(deps, attempt, tree);
    const result = fn(new Sequencer(tree, state, Date.now()));
    const res = await deps.db
      .updateTable('packageSequencingStates')
      .set({ state: serializeState(state), revision: revision + 1, updatedAt: now() })
      .where('attemptId', '=', attempt.id)
      .where('revision', '=', revision)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) > 0) return { result, state };
  }
  throw conflict('This attempt is busy. Please try again.');
}

// ----- deliveries -----

/** The run-time data a new attempt on a SCO starts with: cmi.objectives holds the activity's objectives. */
function initialData(tree: SequencingTree, index: number) {
  const values: Record<string, string> = {};
  let n = 0;
  for (const o of tree.activities[index]!.objectives) {
    if (!o.id || !/^\S+$/.test(o.id) || o.id.length > 4000 || n >= 100) continue;
    values[`cmi.objectives.${n}.id`] = o.id;
    n++;
  }
  return { values, counts: n ? { 'cmi.objectives': n } : {} };
}

/** Remembers how much SCO time came before the new attempt (cmi.total_time counts the current attempt only). */
function noteDelivery(seq: Sequencer, outcome: NavOutcome | null, seconds: Map<string, number>) {
  if (outcome?.delivered === undefined || !outcome.newAttempt) return;
  seq.st(outcome.delivered).base = seconds.get(seq.def(outcome.delivered).id) ?? 0;
}

/** Brings the SCO run-time data and the attempt row in line with the state after a navigation request. */
async function afterNavigation(
  deps: Deps,
  attempt: PackageAttemptRow,
  ctx: SequencingContext,
  state: SequencingState,
  outcome: NavOutcome | null,
) {
  const { db } = deps;
  const ts = now();
  if (outcome?.delivered !== undefined) {
    const def = ctx.tree.activities[outcome.delivered]!;
    const fresh = {
      data: JSON.stringify(initialData(ctx.tree, outcome.delivered)),
      completionStatus: def.sco ? ('not attempted' as const) : ('completed' as const),
      successStatus: 'unknown' as const,
      score: null,
      lastExit: null,
      sessions: 0,
      sessionId: null,
      seq: 0,
      terminatedSessionId: null,
      sessionSeconds: 0,
      updatedAt: ts,
    };
    const insert = db.insertInto('packageScoStates').values({ attemptId: attempt.id, itemId: def.id, totalSeconds: 0, ...fresh });
    // A new attempt on the SCO starts with fresh run-time data (its time so far is kept for the report).
    if (outcome.newAttempt) await insert.onConflict((oc) => oc.columns(['attemptId', 'itemId']).doUpdateSet(fresh)).execute();
    else await insert.onConflict((oc) => oc.columns(['attemptId', 'itemId']).doNothing()).execute();
    await db.updateTable('packageAttempts').set({ lastItemId: def.id, lastAccessedAt: ts }).where('id', '=', attempt.id).execute();
  }
  await recordResult(deps, attempt, ctx.tree, state);
}

/** The attempt's completion, success and score: the root activity's rolled-up status. Then the grade and completion. */
async function recordResult(deps: Deps, attempt: PackageAttemptRow, tree: SequencingTree, state: SequencingState) {
  const { db } = deps;
  const seq = new Sequencer(tree, state);
  const completed = seq.completed(ROOT, false);
  const satisfied = seq.satisfied(ROOT, 0, false);
  const measure = seq.measure(ROOT, 0, false);
  const attempted = state.activities.some((a, i) => i !== ROOT && (a.count ?? 0) > 0);
  const rows = await db.selectFrom('packageScoStates').select(['totalSeconds', 'score']).where('attemptId', '=', attempt.id).execute();
  // When no part reported a measure at all (content that sets only cmi.score.raw, min and max, never
  // cmi.score.scaled), grade as 0.3.0 did: the average of the parts' own scores. For the grade only; sequencing
  // never sees it. A package whose parts report scaled scores keeps the rolled-up measure, even while it is
  // unknown (for example when the only scored part has objectiveMeasureWeight 0).
  const anyMeasure = state.activities.some((_, i) => i !== ROOT && seq.measure(i, 0, false) !== null);
  const scored = rows.filter((r) => r.score !== null);
  const fallback = !anyMeasure && scored.length ? scored.reduce((sum, r) => sum + r.score!, 0) / scored.length : null;
  const score = measure !== null ? clamp01(measure) : fallback === null ? null : clamp01(fallback);
  const current = await db.selectFrom('packageAttempts').select('status').where('id', '=', attempt.id).executeTakeFirst();
  if (!current) return;
  const ts = now();
  const becameFinished = current.status === 'in_progress' && !!state.ended;
  await db
    .updateTable('packageAttempts')
    .set({
      completionStatus: completed === true ? 'completed' : completed === false || attempted ? 'incomplete' : 'not attempted',
      successStatus: satisfied === null ? 'unknown' : satisfied ? 'passed' : 'failed',
      score,
      totalSeconds: round(
        rows.reduce((sum, r) => sum + r.totalSeconds, 0),
        2,
      ),
      lastAccessedAt: ts,
      ...(becameFinished ? { status: 'finished' as const, finishedAt: ts } : {}),
    })
    .where('id', '=', attempt.id)
    .execute();
  const activity = await db.selectFrom('activities').selectAll().where('id', '=', attempt.activityId).executeTakeFirst();
  if (activity) await syncResults(deps, activity, attempt.userId);
}

/** refreshAttempt for SCORM 2004: records the result from the stored state. */
export async function refreshSequencedAttempt(deps: Deps, attempt: PackageAttemptRow, version: PackageVersionRow): Promise<void> {
  const ctx = await sequencingFor(deps, version);
  const { state } = await loadState(deps, attempt, ctx.tree);
  await recordResult(deps, attempt, ctx.tree, state);
}

// ----- launching and navigating -----

const MESSAGES: Array<[RegExp, string]> = [
  [/^(SB\.2\.1-3|SB\.2\.1-4|NB\.2\.1-6|SB\.2\.4-3)$/, "You're at the start: there's nothing before this part."],
  [/^(SB\.2\.4-1)$/, 'Finish this part before you move on.'],
  [/^(SB\.2\.4-2|NB\.2\.1-5)$/, 'This section only goes forward.'],
  [/^(NB\.2\.1-8|SB\.2\.9-7)$/, 'Finish this section before you leave it.'],
  [/^(SB\.2\.9-8)$/, 'From here you can only go to the next or previous part.'],
  [/^(SB\.2\.9-6)$/, 'Start that section from its beginning first.'],
  [/^(SB\.2\.2-2|DB\.1\.1-3)$/, "That part isn't available right now."],
  [/^(SB\.2\.9-2|SB\.2\.9-3|NB\.2\.1-11)$/, "That part isn't available."],
  [/^(SB\.2\.9-9|SB\.2\.10-3|SB\.2\.1-2|DB\.1\.1-1)$/, "There's nothing to open there right now."],
  [/^(NB\.2\.1-4|NB\.2\.1-10|SB\.2\.7-2|SB\.2\.8-2|SB\.2\.9-4|SB\.2\.2-1)$/, "This package doesn't allow that here."],
];

export function explain(exception: string | undefined): string | null {
  if (!exception) return null;
  for (const [re, text] of MESSAGES) if (re.test(exception)) return text;
  return "That isn't possible right now.";
}

/** Preorder through the available children. */
function preorder(seq: Sequencer): number[] {
  const out: number[] = [];
  const visit = (a: number) => {
    out.push(a);
    for (const c of seq.available(a)) visit(c);
  };
  visit(ROOT);
  return out;
}

/** What opening the activity without a request does: carry on where the learner was, or begin. */
function openAttempt(seq: Sequencer): NavOutcome | null {
  const st = seq.state;
  if (st.ended) return null;
  if (st.current !== null && st.activities[st.current]?.active) {
    // The learner left without exiting: suspend everything for them, then resume it.
    const suspended = seq.navigate('suspendAll');
    return suspended.valid ? seq.navigate('resumeAll') : suspended;
  }
  if (st.current !== null) return null; // between parts: the learner chooses
  if (st.suspended !== null) {
    const resumed = seq.navigate('resumeAll');
    if (resumed.valid || st.current !== null) return resumed;
  }
  const started = seq.navigate('start');
  if (started.valid && (started.delivered !== undefined || started.ended)) return started;
  // Flow is off (the default for packages without sequencing rules): open the first part the
  // learner could choose from the table of contents.
  const valid = navValidity(seq.tree, st, seq.now, { jump: false });
  const first = preorder(seq).find((a) => seq.isLeaf(a) && valid.choice.has(a));
  return first === undefined ? started : seq.navigate('choice', first);
}

/** The delivery the learner has open (the current activity's latest one, while it is active); null when nothing is open. */
function openDelivery(seq: Sequencer): string | null {
  const cur = seq.state.current;
  if (cur === null || cur === ROOT || !seq.state.activities[cur]?.active || !seq.isLeaf(cur)) return null;
  return `${seq.state.activities[cur]!.delivery ?? 0}`;
}

/** Shown in the table of contents: visible, selected, and not hidden from choice (itself or a parent). */
function inContents(seq: Sequencer, a: number): boolean {
  return seq.def(a).visible && seq.isAvailable(a) && !hiddenFromChoice(seq, a);
}

/**
 * Nothing is open and nothing can be opened from here (no Continue or Previous, nothing to choose in
 * the contents): there is nothing left to deliver, so the attempt ends as with Exit all.
 */
function endIfStuck(seq: Sequencer): NavOutcome | null {
  const st = seq.state;
  if (st.ended || st.current === null || openDelivery(seq) !== null) return null;
  const valid = navValidity(seq.tree, st, seq.now, { jump: false });
  if (valid.continue || valid.previous) return null;
  for (const a of valid.choice) if (a !== ROOT && inContents(seq, a)) return null;
  return seq.navigate('exitAll');
}

/**
 * A request from the learner (the player or the API): tried on a copy first, so a request the rules
 * refuse leaves the open part as it was (the SCO's own requests follow the book to the letter).
 */
function learnerRequest(seq: Sequencer, request: NavRequest, target: number | null): NavOutcome {
  const trial = new Sequencer(seq.tree, cloneState(seq.state), seq.now).navigate(request, target);
  return trial.valid ? seq.navigate(request, target) : trial;
}

/** What the player and the API may ask for. Jump isn't one: it is for content (adl.nav.request) and ignores the control modes. */
const LEARNER_REQUESTS: ReadonlySet<string> = new Set(PACKAGE_NAV_REQUESTS);

function runRequest(seq: Sequencer, input: PackageLaunchInput): NavOutcome | null {
  const target = input.itemId === undefined ? null : indexOf(seq.tree, input.itemId);
  if (input.nav === '_none_') return null;
  if (input.nav) {
    if (!LEARNER_REQUESTS.has(input.nav)) return { valid: false, exception: 'NB.2.1-13' };
    return learnerRequest(seq, input.nav, target);
  }
  if (target !== null) {
    // The part that is already open stays open (choosing it would start it over).
    if (seq.state.current === target && seq.state.activities[target]?.active) return null;
    return learnerRequest(seq, 'choice', target);
  }
  return openAttempt(seq);
}

/** Waits (briefly) for the last commit of the SCO page the player just closed, so a navigation request uses its final data. */
async function waitForSession(db: DB, attemptId: string, itemId: string, sid: string) {
  for (let i = 0; i < 30; i++) {
    const row = await db
      .selectFrom('packageScoStates')
      .select('terminatedSessionId')
      .where('attemptId', '=', attemptId)
      .where('itemId', '=', itemId)
      .executeTakeFirst();
    if (!row || row.terminatedSessionId === sid) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface LaunchContext {
  activityId: string;
  userId: string;
  settings: PackageSettings;
  version: PackageVersionRow;
  attempt: PackageAttemptRow;
}

const MOVED_ON = 'This attempt had moved on (in another window, for example): here is where it is now.';

/** Launches (or navigates) a learner's SCORM 2004 attempt. */
export async function sequencedLaunch(deps: Deps, launch: LaunchContext, input: PackageLaunchInput): Promise<PackageLaunch> {
  const { db } = deps;
  const { attempt } = launch;
  const ctx = await sequencingFor(deps, launch.version);
  const navigating = input.nav !== undefined ? input.nav !== '_none_' : input.itemId !== undefined;
  // The player says which delivery it shows: a request made for one the attempt has since moved on
  // from (another window navigated meanwhile) changes nothing, and the player catches up instead.
  const shown = navigating ? input.deliveryId : undefined;
  if (input.sid && navigating) {
    const { state } = await loadState(deps, attempt, ctx.tree);
    const open = openDelivery(new Sequencer(ctx.tree, state, Date.now(), true));
    if (state.current !== null && (shown === undefined || shown === open)) {
      await waitForSession(db, attempt.id, ctx.tree.activities[state.current]!.id, input.sid);
    }
  }
  const seconds = new Map((await scoRows(db, attempt.id)).map((r) => [r.itemId, r.totalSeconds]));
  const { result, state } = await mutate(deps, attempt, ctx.tree, (seq) => {
    if (shown !== undefined && openDelivery(seq) !== shown) return { outcome: null, moved: true };
    const outcome = runRequest(seq, input);
    noteDelivery(seq, outcome, seconds);
    endIfStuck(seq);
    return { outcome, moved: false };
  });
  await afterNavigation(deps, attempt, ctx, state, result.outcome);
  const message = result.moved ? MOVED_ON : result.outcome && !result.outcome.valid ? explain(result.outcome.exception) : null;
  return buildLaunch(deps, launch, ctx, state, message);
}

/**
 * The player's view of a finished attempt (its content ended it while the player was open, or another
 * window did): the summary, with nothing open and nothing to navigate.
 */
export async function sequencedSummary(deps: Deps, launch: LaunchContext): Promise<PackageLaunch> {
  const ctx = await sequencingFor(deps, launch.version);
  const { state } = await loadState(deps, launch.attempt, ctx.tree);
  return buildLaunch(deps, launch, ctx, { ...state, current: null, ended: true }, null);
}

const NO_VALIDITY: NavValidity = {
  continue: false,
  previous: false,
  exit: false,
  exitAll: false,
  suspendAll: false,
  abandon: false,
  abandonAll: false,
  choice: new Set(),
  jump: new Set(),
};

async function buildLaunch(
  deps: Deps,
  launch: LaunchContext,
  ctx: SequencingContext,
  state: SequencingState,
  message: string | null,
): Promise<PackageLaunch> {
  const { tree, structure } = ctx;
  const attempt =
    (await deps.db.selectFrom('packageAttempts').selectAll().where('id', '=', launch.attempt.id).executeTakeFirst()) ?? launch.attempt;
  const seq = new Sequencer(tree, state, Date.now(), true);
  const cur = state.current;
  const deliveryId = openDelivery(seq);
  const delivered = deliveryId === null ? null : cur!;
  const item = delivered === null ? null : structure.items[delivered - 1];
  let url = '';
  if (item?.href) {
    const token = signToken(await packageSecret(deps.db), {
      p: 'play',
      a: launch.activityId,
      v: launch.version.id,
      u: launch.userId,
      t: attempt.id,
      i: item.id,
      n: state.activities[delivered!]!.delivery ?? 0,
    });
    url = `${CONTENT_PREFIX}${token}/${item.href}`;
  }
  const validity = state.ended ? NO_VALIDITY : navValidity(tree, state, Date.now(), { jump: false });
  const hidden = delivered === null ? [] : tree.activities[delivered]!.hideLmsUi;
  const show = (control: PackageNavControl, valid: boolean) => valid && !hidden.includes(control);
  const controls: Record<PackageNavControl, boolean> = {
    previous: show('previous', validity.previous),
    continue: show('continue', validity.continue),
    // Exiting one part only means something when there are others to go on to.
    exit: show('exit', validity.exit) && leafCount(tree) > 1,
    exitAll: show('exitAll', validity.exitAll),
    suspendAll: show('suspendAll', validity.suspendAll),
    abandon: show('abandon', validity.abandon),
    abandonAll: show('abandonAll', validity.abandonAll),
  };
  const toc: PackageTocEntry[] = tree.activities.slice(1).map((def, k) => {
    const a = k + 1;
    const s = state.activities[a] ?? {};
    const completed = seq.completed(a);
    const satisfied = seq.satisfied(a, 0);
    const measure = seq.measure(a, 0);
    return {
      id: def.id,
      title: def.title,
      depth: def.depth,
      leaf: def.children.length === 0,
      visible: inContents(seq, a),
      canChoose: validity.choice.has(a) && a !== delivered,
      current: cur === a,
      attempted: (s.count ?? 0) > 0,
      suspended: !!s.suspended,
      completionStatus: completed === true ? 'completed' : completed === false || (s.count ?? 0) > 0 ? 'incomplete' : 'not attempted',
      successStatus: satisfied === null ? 'unknown' : satisfied ? 'passed' : 'failed',
      score: measure === null ? null : round(clamp01(measure) * 100, 2),
    };
  });
  const info: PackageSequencingInfo = {
    deliveryId,
    ended: !!state.ended,
    suspended: !state.ended && state.current === null && state.suspended !== null,
    controls,
    toc,
    message: message ?? (delivered === null && !state.ended && state.current !== null ? 'Choose what to open next.' : null),
    completionStatus: attempt.completionStatus,
    successStatus: attempt.successStatus,
    score: attempt.score === null ? null : round(attempt.score * 100, 2),
    totalSeconds: attempt.totalSeconds,
  };
  return {
    url,
    attemptId: attempt.id,
    itemId: item?.id ?? '',
    mode: 'normal',
    display: launch.settings.display,
    items: toVersionInfo(launch.version).items,
    sequencing: info,
  };
}

// ----- the run-time -----

/** The SCO's report from its data model: completion and success (evaluated against the thresholds), scores and objectives. */
export function runtimeReport(model: RuntimeModel): RuntimeReport {
  const get = (element: string) => {
    const r = model.get(element);
    return r.error ? '' : r.value;
  };
  const number = (element: string) => {
    const v = get(element);
    return v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const completion = (v: string) => (v === 'completed' || v === 'incomplete' || v === 'not attempted' ? v : 'unknown');
  const success = (v: string) => (v === 'passed' || v === 'failed' ? v : 'unknown');
  const objectives: RuntimeReport['objectives'] = [];
  const count = Number(get('cmi.objectives._count')) || 0;
  for (let n = 0; n < count; n++) {
    const id = get(`cmi.objectives.${n}.id`);
    if (!id) continue;
    objectives.push({
      id,
      success: success(get(`cmi.objectives.${n}.success_status`)),
      completion: completion(get(`cmi.objectives.${n}.completion_status`)),
      scaled: number(`cmi.objectives.${n}.score.scaled`),
      raw: number(`cmi.objectives.${n}.score.raw`),
      min: number(`cmi.objectives.${n}.score.min`),
      max: number(`cmi.objectives.${n}.score.max`),
      progress: number(`cmi.objectives.${n}.progress_measure`),
    });
  }
  return {
    completion: completion(get('cmi.completion_status')),
    success: success(get('cmi.success_status')),
    scaled: number('cmi.score.scaled'),
    raw: number('cmi.score.raw'),
    min: number('cmi.score.min'),
    max: number('cmi.score.max'),
    progress: number('cmi.progress_measure'),
    objectives,
  };
}

export interface SequencedRuntime {
  ctx: SequencingContext;
  index: number;
  /** The token's delivery is the attempt's current one (new page sessions may start). */
  current: boolean;
  /** Read-only values that depend on the delivery (entry, total time, credit). */
  lms(row: PackageScoStateRow | undefined): Record<string, string>;
  data: NonNullable<ModelInit['data']>;
  state: SequencingState;
}

/**
 * Checks a play token against the attempt's sequencing state. Returns null when the token belongs to
 * an older delivery of its part (the learner has moved on, or started the part again).
 */
export async function sequencedRuntime(deps: Pick<Deps, 'db' | 'storage'>, rt: RuntimeContext): Promise<SequencedRuntime | null> {
  if (!rt.attempt) return null;
  const ctx = await sequencingFor(deps, rt.version);
  const { state } = await loadState(deps, rt.attempt, ctx.tree);
  const index = indexOf(ctx.tree, rt.item.id);
  if (index <= 0) return null;
  const s = state.activities[index] ?? {};
  if ((rt.token.n ?? null) !== (s.delivery ?? null)) return null;
  const def = ctx.tree.activities[index]!;
  return {
    ctx,
    index,
    state,
    current: state.current === index && !!s.active,
    lms: (row) => ({
      'cmi.entry': !row || row.sessions === 0 ? 'ab-initio' : row.lastExit === 'suspend' || s.resumed ? 'resume' : '',
      'cmi.total_time': formatDuration(Math.max(0, (row?.totalSeconds ?? 0) - (s.base ?? 0)), '2004'),
      'cmi.credit': def.tracked ? 'credit' : 'no-credit',
    }),
    // Only stores the activity may read have their value sent to the browser.
    data: def.dataMaps.map((m) => {
      const value = m.read ? ownValue(state.data, m.target) : undefined;
      return { id: m.target, read: m.read, write: m.write, ...(value !== undefined ? { value } : {}) };
    }),
  };
}

/** Jump (adl.nav.request "{target=...}jump") is new in SCORM 2004 4th Edition: earlier editions don't have it. */
export const hasJump = (ctx: SequencingContext) => ctx.structure.edition === '4th';

/** What the browser run-time starts from, beyond the stored data: request validity and global objective reads. */
export function sequencedBoot(
  seqRt: SequencedRuntime,
  values: Record<string, string>,
): { nav: NonNullable<ModelInit['nav']>; values: Record<string, string> } {
  const { tree } = seqRt.ctx;
  const validity = navValidity(tree, seqRt.state, Date.now(), { jump: hasJump(seqRt.ctx) });
  const choice: Record<string, boolean> = {};
  const jump: Record<string, boolean> = {};
  tree.activities.forEach((a, i) => {
    setOwnValue(choice, a.id, validity.choice.has(i));
    setOwnValue(jump, a.id, validity.jump.has(i));
  });
  const leaves = tree.activities.filter((a, i) => i !== ROOT && a.children.length === 0 && a.launchable).map((a) => a.id);
  const out = { ...values };
  // cmi.objectives entries the SCO hasn't set show what the activity's objectives (or the global objectives they read) know.
  const seq = new Sequencer(tree, seqRt.state, Date.now(), true);
  const def = tree.activities[seqRt.index]!;
  const objectiveIndex = new Map<string, number>();
  def.objectives.forEach((x, i) => {
    if (x.id !== null && !objectiveIndex.has(x.id)) objectiveIndex.set(x.id, i);
  });
  for (let n = 0; Object.prototype.hasOwnProperty.call(out, `cmi.objectives.${n}.id`); n++) {
    const o = objectiveIndex.get(out[`cmi.objectives.${n}.id`]!) ?? -1;
    if (o < 0) continue;
    const view = seq.objectiveView(seqRt.index, o);
    const fill = (key: string, value: string | number | undefined) => {
      const element = `cmi.objectives.${n}.${key}`;
      const set = out[element];
      if (value !== undefined && (set === undefined || set === 'unknown')) out[element] = String(value);
    };
    fill('success_status', view.success);
    fill('completion_status', view.completion);
    fill('score.scaled', view.scaled);
    fill('score.raw', view.raw);
    fill('score.min', view.min);
    fill('score.max', view.max);
    fill('progress_measure', view.progress);
  }
  return {
    nav: {
      items: leaves,
      index: leaves.indexOf(def.id),
      valid: { continue: validity.continue, previous: validity.previous, choice, jump },
    },
    values: out,
  };
}

export interface CommitDetails {
  report: RuntimeReport;
  ending: boolean;
  /** The session ended because the page went away (not because the SCO terminated on its own). */
  unload: boolean;
  /** The player is navigating: the SCO's own request doesn't count. */
  lms: boolean;
  /** adl.nav.request at termination. */
  navRequest: string;
  /** cmi.exit at termination. */
  exit: string;
  /** adl.data stores written in this commit, by store id. */
  data: Map<string, string>;
}

/** Turns adl.nav.request into a navigation request (null for _none_). Jump only counts in 4th edition packages. */
export function parseNavRequest(
  tree: SequencingTree,
  value: string,
  { jump = true }: { jump?: boolean } = {},
): { nav: NavRequest; target: number | null } | null {
  const m = /^\{target=([^}]+)\}(choice|jump)$/.exec(value);
  if (m) return m[2] === 'jump' && !jump ? null : { nav: m[2] as NavRequest, target: indexOf(tree, m[1]!) };
  if (['continue', 'previous', 'exit', 'exitAll', 'abandon', 'abandonAll', 'suspendAll'].includes(value)) {
    return { nav: value as NavRequest, target: null };
  }
  return null;
}

/** The navigation a SCO's termination asks for (or implies). */
function scoRequest(seq: Sequencer, ctx: SequencingContext, d: CommitDetails): { nav: NavRequest; target: number | null } | null {
  const { tree } = ctx;
  if (d.lms) return null;
  const requested = parseNavRequest(tree, d.navRequest, { jump: hasJump(ctx) });
  if (requested) return requested;
  // cmi.exit "time-out" and "logout" end the whole attempt.
  if (d.exit === 'time-out' || d.exit === 'logout') return { nav: 'exitAll', target: null };
  // The course is complete and the learner leaves without suspending (closes the player, or the SCO
  // ends on its own): the attempt is over, as in 0.3.0 once every part was completed.
  if (d.exit !== 'suspend' && seq.completed(ROOT, false) === true) return { nav: 'exitAll', target: null };
  if (d.unload) return null;
  // A package with a single SCO is done when that SCO terminates: suspended if it said so.
  if (leafCount(tree) === 1) return { nav: d.exit === 'suspend' ? 'suspendAll' : 'exitAll', target: null };
  return null;
}

/** After a commit is stored: the SCO's data goes into the activity's tracking information, and its navigation request is run. */
export async function sequencedCommit(deps: Deps, rt: RuntimeContext, seqRt: SequencedRuntime, d: CommitDetails): Promise<void> {
  const attempt = rt.attempt!;
  const { tree } = seqRt.ctx;
  const index = seqRt.index;
  const seconds = new Map((await scoRows(deps.db, attempt.id)).map((r) => [r.itemId, r.totalSeconds]));
  const writable = new Set(tree.activities[index]!.dataMaps.filter((m) => m.write).map((m) => m.target));
  const { result: outcome, state } = await mutate(deps, attempt, tree, (seq) => {
    const s = seq.st(index);
    if ((rt.token.n ?? null) !== (s.delivery ?? null)) return null; // a newer delivery took over meanwhile
    for (const [target, value] of d.data) {
      if (!writable.has(target)) continue;
      const others = Object.entries(seq.state.data).reduce((n, [k, v]) => (k === target ? n : n + k.length + v.length), 0);
      // Stores beyond the attempt's allowance keep their old value. Store ids come from the manifest:
      // they are written as own properties, whatever they are called.
      if (others + target.length + value.length <= MAX_SHARED_DATA_CHARS) setOwnValue(seq.state.data, target, value);
    }
    seq.applyRuntime(index, d.report);
    if (!d.ending || seq.state.current !== index || !s.active) return null;
    s.suspended = d.exit === 'suspend';
    const request = scoRequest(seq, seqRt.ctx, d);
    if (!request) return null;
    const outcome = seq.navigate(request.nav, request.target);
    noteDelivery(seq, outcome, seconds);
    endIfStuck(seq);
    return outcome;
  });
  await afterNavigation(deps, attempt, seqRt.ctx, state, outcome);
}
