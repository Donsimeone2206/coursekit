/**
 * The SCORM 2004 sequencing engine: the behaviours of the Sequencing and Navigation book (SCORM 2004
 * 4th Edition, Appendix C), working on one attempt's tracking state. It is pure: it reads the
 * definitions, changes the state passed in and never does I/O. Process names and exception codes
 * (NB.2.1-4, SB.2.9-3...) follow the book.
 *
 * Coursekit choices where the book leaves room:
 * - Global objectives and shared data live in the attempt's state (each Coursekit attempt is like a
 *   new registration), whatever objectivesGlobalToSystem says.
 * - Reads from global objectives apply when the local value is unknown (or recorded in an earlier
 *   attempt of an ancestor); writes only ever transfer known values.
 * - An empty set of contributing children never triggers a rollup rule (so leaves keep the status
 *   their content reported), and children with a measure or progress weight of 0 take no part in
 *   measure and completion measure rollup.
 * - Selection with the onEachNewAttempt timing selects again for each new attempt, like randomization.
 * - An asset (no run-time) counts as completed and satisfied as soon as it is delivered, the way End
 *   Attempt would record it when the learner moves on.
 * - With a referencedObjective other than the primary objective, the completed and
 *   activityProgressKnown rule conditions are about that objective's (4th edition) completion status,
 *   as ADL's reference sequencer evaluates them; a referencedObjective the activity doesn't define
 *   makes the condition unknown.
 * - A choice request for an activity outside the selected tree (not in the Available Children of its
 *   parent, or of an ancestor's) is refused by the Navigation Request Process (NB.2.1-11), before it
 *   ends the current attempt.
 */
import { nextRandom, ownValue, setOwnValue } from './state.js';
import {
  ROOT,
  type ActivityDef,
  type ActivityState,
  type NavRequest,
  type ObjectiveState,
  type RollupAction,
  type RollupRule,
  type RuleAction,
  type RuleCondition,
  type RuleConditionDef,
  type SequencingRule,
  type SequencingState,
  type SequencingTree,
} from './types.js';

type Dir = 'forward' | 'backward';
type Tri = boolean | null;
export type Termination = 'exit' | 'exitAll' | 'suspendAll' | 'abandon' | 'abandonAll';
export type SequencingRequest = 'start' | 'resumeAll' | 'continue' | 'previous' | 'choice' | 'jump' | 'retry' | 'exit';

export interface NavigationResult {
  termination?: Termination;
  sequencing?: SequencingRequest;
  target?: number;
  exception?: string;
}

export interface SequencingResult {
  delivery?: number;
  endSession?: boolean;
  exception?: string;
}

export interface NavOutcome {
  /** The request was carried out. When false, its termination may still have changed the state. */
  valid: boolean;
  exception?: string;
  /** The activity delivered; it is now the current activity. */
  delivered?: number;
  /** The delivery started a new attempt on the delivered activity (its run-time data starts fresh). */
  newAttempt?: boolean;
  /** The sequencing session ended (the attempt is over unless an activity was suspended). */
  ended?: boolean;
}

/** What a SCO reported through the run-time, for the activity's tracking information. */
export interface RuntimeReport {
  completion: 'completed' | 'incomplete' | 'not attempted' | 'unknown';
  success: 'passed' | 'failed' | 'unknown';
  scaled: number | null;
  raw: number | null;
  min: number | null;
  max: number | null;
  progress: number | null;
  objectives: Array<{
    id: string;
    success: 'passed' | 'failed' | 'unknown';
    completion: 'completed' | 'incomplete' | 'not attempted' | 'unknown';
    scaled: number | null;
    raw: number | null;
    min: number | null;
    max: number | null;
    progress: number | null;
  }>;
}

const EMPTY: Readonly<ObjectiveState> = Object.freeze({});
const SKIP: readonly RuleAction[] = ['skip'];
const DISABLED: readonly RuleAction[] = ['disabled'];
const HIDDEN: readonly RuleAction[] = ['hiddenFromChoice'];
const STOP_FORWARD: readonly RuleAction[] = ['stopForwardTraversal'];
const EXIT: readonly RuleAction[] = ['exit'];
const POST: readonly RuleAction[] = ['exitParent', 'exitAll', 'retry', 'retryAll', 'continue', 'previous'];

const rollupDefault = (condition: RuleCondition, action: RollupAction): RollupRule => ({
  childActivitySet: 'all',
  minimumCount: 0,
  minimumPercent: 0,
  combination: 'any',
  conditions: [{ condition, not: false }],
  action,
});
/** The default rollup rules (used when an activity defines none for the kind of status). */
const DEFAULT_OBJECTIVE_RULES = [rollupDefault('objectiveStatusKnown', 'notSatisfied'), rollupDefault('satisfied', 'satisfied')];
const DEFAULT_PROGRESS_RULES = [rollupDefault('activityProgressKnown', 'incomplete'), rollupDefault('completed', 'completed')];

function combine(bag: Tri[], how: 'all' | 'any'): Tri {
  if (how === 'all') return bag.includes(false) ? false : bag.includes(null) ? null : true;
  return bag.includes(true) ? true : bag.includes(null) ? null : false;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fail = (exception: string) => ({ exception });

/** Facts about the (available) activity tree, worked out once until selection or randomization changes it. */
interface TreeCache {
  /** Position of each activity in a preorder traversal through the available children. */
  order: Map<number, number>;
  /** Position of each activity among its parent's available children (absent: not one of them). */
  position: Map<number, number>;
  /** The last activity in a preorder traversal. */
  last: number;
}

export class Sequencer {
  private cache: TreeCache | null = null;
  /** Rule results by activity, kept while the state doesn't change (see memoize). */
  private ruleMemo: Map<number, Map<SequencingRule, Tri>> | null = null;
  /** Flow Activity Traversal results by activity, direction and previous direction (see memoize). */
  private flowMemo: Map<number, FlowResult> | null = null;
  /** The first sibling that stops forward traversal, by parent and starting position (see memoize). */
  private stopMemo: Map<number, number> | null = null;
  /** Objective indexes by objectiveID, per activity. */
  private objectiveIds = new Map<number, Map<string, number>>();

  /**
   * @param now Milliseconds since the epoch (attempt durations and time limits).
   * @param dryRun Leave the state alone where a sequencing request would change it on the way (for
   *   working out which requests are valid on a copy of the state).
   */
  constructor(
    readonly tree: SequencingTree,
    readonly state: SequencingState,
    readonly now: number = Date.now(),
    private readonly dryRun = false,
  ) {}

  // ----- the activity tree -----

  def(a: number): ActivityDef {
    return this.tree.activities[a]!;
  }
  st(a: number): ActivityState {
    return (this.state.activities[a] ??= {});
  }
  get size(): number {
    return this.tree.activities.length;
  }
  parent(a: number): number {
    return this.def(a).parent;
  }
  isLeaf(a: number): boolean {
    return this.def(a).children.length === 0;
  }
  /** Available Children: the children after selection and randomization. */
  available(a: number): number[] {
    return this.st(a).available ?? this.def(a).children;
  }
  /** The activity and its ancestors, from the activity up to the root. */
  pathToRoot(a: number): number[] {
    const out: number[] = [];
    for (let x = a; x >= 0; x = this.parent(x)) out.push(x);
    return out;
  }
  commonAncestor(a: number, b: number): number {
    const up = new Set(this.pathToRoot(a));
    for (let x = b; x >= 0; x = this.parent(x)) if (up.has(x)) return x;
    return ROOT;
  }
  /**
   * The tree facts every traversal step needs (preorder positions, sibling positions, the last
   * activity), worked out once: request validity runs choice and jump for every activity, and walking
   * the tree again on every step would make that cubic in the depth of the tree.
   */
  private treeFacts(): TreeCache {
    if (this.cache) return this.cache;
    const order = new Map<number, number>();
    const position = new Map<number, number>();
    for (let a = 0; a < this.size; a++) this.available(a).forEach((c, i) => position.set(c, i));
    const stack = [ROOT];
    let last = ROOT;
    while (stack.length) {
      const a = stack.pop()!;
      order.set(a, order.size);
      last = a;
      const kids = this.available(a);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return (this.cache = { order, position, last });
  }
  /** One of its parent's Available Children. */
  private inAvailable(a: number): boolean {
    return this.treeFacts().position.has(a);
  }
  /** Reachable through Available Children from the root. */
  isAvailable(a: number): boolean {
    for (let x = a; x !== ROOT; x = this.parent(x)) if (!this.inAvailable(x)) return false;
    return true;
  }
  private isAvailableDescendant(d: number, a: number): boolean {
    for (let x = d; x !== ROOT; x = this.parent(x)) {
      if (!this.inAvailable(x)) return false;
      if (this.parent(x) === a) return true;
    }
    return false;
  }
  /** `target` comes after `from` in a preorder traversal of the (available) activity tree. */
  private isForward(target: number, from: number): boolean {
    const { order } = this.treeFacts();
    const t = order.get(target);
    const f = order.get(from);
    return t !== undefined && f !== undefined ? t > f : target > from;
  }
  private isLastInPreorder(a: number): boolean {
    return this.treeFacts().last === a;
  }
  private siblings(a: number): number[] {
    return a === ROOT ? [a] : this.available(this.parent(a));
  }
  /** Position among the siblings, or -1 when the activity isn't one of its parent's Available Children. */
  private siblingIndex(a: number): number {
    return a === ROOT ? 0 : (this.treeFacts().position.get(a) ?? -1);
  }
  private isLastSibling(a: number): boolean {
    const i = this.siblingIndex(a);
    return i < 0 || i === this.siblings(a).length - 1;
  }
  private isFirstSibling(a: number): boolean {
    return this.siblingIndex(a) <= 0;
  }
  private nextSibling(a: number): number {
    return this.siblings(a)[this.siblingIndex(a) + 1]!;
  }
  private previousSibling(a: number): number {
    return this.siblings(a)[this.siblingIndex(a) - 1]!;
  }

  // ----- tracking information -----

  private peekObjective(a: number, o: number): Readonly<ObjectiveState> {
    return this.state.activities[a]?.objectives?.[o] ?? EMPTY;
  }
  objective(a: number, o: number): ObjectiveState {
    const s = this.st(a);
    const list = (s.objectives ??= []);
    while (list.length < this.def(a).objectives.length) list.push({});
    return list[o]!;
  }
  /**
   * useCurrentAttemptObjectiveInfo / useCurrentAttemptProgressInfo: information recorded before an
   * ancestor (that sets the flag) began its current attempt doesn't count.
   */
  private isCurrent(a: number, kind: 'objective' | 'progress'): boolean {
    const stamp = this.state.activities[a]?.stamp ?? 0;
    for (let x = this.parent(a); x >= 0; x = this.parent(x)) {
      const def = this.def(x);
      const flag = kind === 'objective' ? def.useCurrentAttemptObjectiveInfo : def.useCurrentAttemptProgressInfo;
      if (flag && (this.state.activities[x]?.stamp ?? 0) > stamp) return false;
    }
    return true;
  }
  /** A shared global objective (an own property of the state's globals, whatever its identifier). */
  private global(target: string): ObjectiveState | undefined {
    return ownValue(this.state.globals, target);
  }
  /** The objective's satisfied status: its own when known, else a global objective it reads. */
  satisfied(a: number, o: number, filter = true): Tri {
    const local = this.peekObjective(a, o);
    if (local.ps && (!filter || this.isCurrent(a, 'objective'))) return !!local.ss;
    for (const m of this.def(a).objectives[o]?.maps ?? []) {
      const g = m.readSatisfied ? this.global(m.target) : undefined;
      if (g?.ps) return !!g.ss;
    }
    return null;
  }
  measure(a: number, o: number, filter = true): number | null {
    const local = this.peekObjective(a, o);
    if (local.ms && (!filter || this.isCurrent(a, 'objective'))) return local.nm ?? 0;
    for (const m of this.def(a).objectives[o]?.maps ?? []) {
      const g = m.readMeasure ? this.global(m.target) : undefined;
      if (g?.ms) return g.nm ?? 0;
    }
    return null;
  }
  /** The attempt's completion status (with the primary objective's 4th edition completion reads). */
  completed(a: number, filter = true): Tri {
    const s = this.state.activities[a] ?? {};
    if (s.ps && (!filter || this.isCurrent(a, 'progress'))) return !!s.cs;
    for (const m of this.def(a).objectives[0]?.maps ?? []) {
      const g = m.readCompletion ? this.global(m.target) : undefined;
      if (g?.cps) return !!g.cs;
    }
    return null;
  }
  completionAmount(a: number, filter = true): number | null {
    const s = this.state.activities[a] ?? {};
    if (s.cas && (!filter || this.isCurrent(a, 'progress'))) return s.ca ?? 0;
    for (const m of this.def(a).objectives[0]?.maps ?? []) {
      const g = m.readProgress ? this.global(m.target) : undefined;
      if (g?.pms) return g.pm ?? 0;
    }
    return null;
  }
  /**
   * A non-primary objective's completion status (4th edition): its own when known, else a global
   * objective it reads with readCompletionStatus. The primary objective's is the attempt's (completed()).
   */
  objectiveCompleted(a: number, o: number, filter = true): Tri {
    if (o === 0) return this.completed(a, filter);
    const local = this.peekObjective(a, o);
    if (local.cps && (!filter || this.isCurrent(a, 'progress'))) return !!local.cs;
    for (const m of this.def(a).objectives[o]?.maps ?? []) {
      const g = m.readCompletion ? this.global(m.target) : undefined;
      if (g?.cps) return !!g.cs;
    }
    return null;
  }

  /** Transfers the objective's known values to the global objectives it writes. */
  private writeObjective(a: number, o: number) {
    const def = this.def(a);
    const maps = def.objectives[o]?.maps ?? [];
    if (!maps.length || !def.tracked) return;
    const local = this.peekObjective(a, o);
    const s = this.st(a);
    const primary = o === 0;
    const globals = this.state.globals;
    for (const m of maps) {
      const set = (fields: ObjectiveState) => Object.assign(ownValue(globals, m.target) ?? setOwnValue(globals, m.target, {}), fields);
      if (m.writeSatisfied && local.ps) set({ ps: true, ss: !!local.ss });
      if (m.writeMeasure && local.ms) set({ ms: true, nm: local.nm ?? 0 });
      if (m.writeRaw && local.raw !== undefined) set({ raw: local.raw });
      if (m.writeMin && local.min !== undefined) set({ min: local.min });
      if (m.writeMax && local.max !== undefined) set({ max: local.max });
      const completionKnown = primary ? s.ps : local.cps;
      const completed = primary ? s.cs : local.cs;
      const progressKnown = primary ? s.cas : local.pms;
      const progress = primary ? s.ca : local.pm;
      if (m.writeCompletion && completionKnown) set({ cps: true, cs: !!completed });
      if (m.writeProgress && progressKnown) set({ pms: true, pm: progress ?? 0 });
    }
  }

  // ----- rule evaluation -----

  /** The index of the activity's objective with this objectiveID (0, the primary objective, for null); -1 when there is none. */
  private objectiveIndex(a: number, id: string | null): number {
    if (id === null) return 0;
    let ids = this.objectiveIds.get(a);
    if (!ids) {
      ids = new Map();
      for (const [i, o] of this.def(a).objectives.entries()) if (o.id !== null && !ids.has(o.id)) ids.set(o.id, i);
      this.objectiveIds.set(a, ids);
    }
    return ids.get(id) ?? -1;
  }
  attemptLimitExceeded(a: number): boolean {
    const d = this.def(a);
    const s = this.state.activities[a] ?? {};
    // An attempt in progress (active or suspended) already counts; resuming it doesn't exceed the limit.
    return d.attemptLimit !== null && !s.active && !s.suspended && !!s.aps && (s.count ?? 0) >= d.attemptLimit;
  }
  private attemptSeconds(s: ActivityState): number {
    if (s.start === undefined) return 0;
    return ((s.active || s.suspended || s.end === undefined ? this.now : s.end) - s.start) / 1000;
  }
  private timeLimitExceeded(a: number): boolean {
    const limit = this.def(a).attemptDurationLimit;
    const s = this.state.activities[a] ?? {};
    return limit !== null && !!s.aps && this.attemptSeconds(s) >= limit;
  }
  private condition(a: number, c: RuleConditionDef | { condition: RuleCondition; not: boolean }): Tri {
    const o = 'objective' in c ? this.objectiveIndex(a, c.objective) : 0;
    const threshold = 'threshold' in c ? c.threshold : 0;
    let v: Tri;
    switch (c.condition) {
      case 'satisfied':
        v = o < 0 ? null : this.satisfied(a, o);
        break;
      case 'objectiveStatusKnown':
        v = o < 0 ? null : this.satisfied(a, o) !== null;
        break;
      case 'objectiveMeasureKnown':
        v = o < 0 ? null : this.measure(a, o) !== null;
        break;
      case 'objectiveMeasureGreaterThan':
      case 'objectiveMeasureLessThan': {
        const m = o < 0 ? null : this.measure(a, o);
        v = m === null ? null : c.condition === 'objectiveMeasureGreaterThan' ? m > threshold : m < threshold;
        break;
      }
      // With a referencedObjective other than the primary objective, these two are about that
      // objective's completion status (4th edition, as ADL's reference sequencer evaluates them).
      case 'completed':
        v = o < 0 ? null : this.objectiveCompleted(a, o);
        break;
      case 'activityProgressKnown':
        v = o < 0 ? null : o > 0 ? this.objectiveCompleted(a, o) !== null : !!this.state.activities[a]?.aps && this.completed(a) !== null;
        break;
      case 'attempted':
        v = (this.state.activities[a]?.count ?? 0) > 0;
        break;
      case 'attemptLimitExceeded':
        v = this.attemptLimitExceeded(a);
        break;
      case 'timeLimitExceeded':
        v = this.timeLimitExceeded(a);
        break;
      case 'outsideAvailableTimeRange':
        v = false;
        break;
      case 'always':
        v = true;
        break;
    }
    return c.not ? (v === null ? null : !v) : v;
  }
  /** Sequencing Rule Check Subprocess [UP.2.1]. */
  private ruleCheck(a: number, rule: SequencingRule): Tri {
    const memo = this.ruleMemo;
    const known = memo?.get(a)?.get(rule);
    if (known !== undefined) return known;
    const v = rule.conditions.length
      ? combine(
          rule.conditions.map((c) => this.condition(a, c)),
          rule.combination,
        )
      : null;
    if (memo) {
      let forActivity = memo.get(a);
      if (!forActivity) memo.set(a, (forActivity = new Map()));
      forActivity.set(rule, v);
    }
    return v;
  }
  /**
   * Keeps sequencing rule results and flow traversal results from now on. Only for working out
   * request validity on a dry-run copy: there the state stays as it is from request to request, so
   * each rule (and the flow from each activity) needs working out only once.
   */
  memoize() {
    if (!this.dryRun) throw new Error('Only a dry run may keep rule and flow results.');
    this.ruleMemo = new Map();
    this.flowMemo = new Map();
    this.stopMemo = new Map();
  }
  /** Sequencing Rules Check Process [UP.2]: the action of the first rule (with one of `actions`) that evaluates to true. */
  rulesCheck(a: number, rules: SequencingRule[], actions: readonly RuleAction[]): RuleAction | null {
    for (const rule of rules) if (actions.includes(rule.action) && this.ruleCheck(a, rule) === true) return rule.action;
    return null;
  }
  isHiddenFromChoice(a: number): boolean {
    return this.rulesCheck(a, this.def(a).preRules, HIDDEN) !== null;
  }
  /** Limit Conditions Check Process [UP.1]. */
  limitViolated(a: number): boolean {
    const d = this.def(a);
    const s = this.state.activities[a] ?? {};
    if (!d.tracked || s.active || s.suspended) return false;
    if (d.attemptLimit !== null && s.aps && (s.count ?? 0) >= d.attemptLimit) return true;
    if (d.attemptDurationLimit !== null && s.aps && this.attemptSeconds(s) >= d.attemptDurationLimit) return true;
    return false;
  }
  /** Check Activity Process [UP.5]: true when the activity is disabled or its limits are used up. */
  checkActivity(a: number): boolean {
    return this.rulesCheck(a, this.def(a).preRules, DISABLED) !== null || this.limitViolated(a);
  }

  // ----- rollup -----

  /** Overall Rollup Process [RB.1.5]. */
  rollup(a: number) {
    for (const x of this.pathToRoot(a)) {
      if (!this.isLeaf(x)) {
        this.measureRollup(x);
        this.completionMeasureRollup(x);
      }
      if (this.def(x).objectives[0]!.satisfiedByMeasure) this.objectiveRollupUsingMeasure(x);
      else this.objectiveRollupUsingRules(x);
      if (this.def(x).completedByMeasure) this.progressRollupUsingMeasure(x);
      else this.progressRollupUsingRules(x);
    }
  }
  /** Measure Rollup Process [RB.1.1 a]. */
  private measureRollup(a: number) {
    let total = 0;
    let counted = 0;
    let valid = false;
    for (const c of this.available(a)) {
      const d = this.def(c);
      // A child that weighs nothing takes no part (as in ADL's reference sequencer): its measure alone
      // doesn't make the parent's measure known.
      if (!d.tracked || d.objectiveMeasureWeight <= 0) continue;
      counted += d.objectiveMeasureWeight;
      const m = this.measure(c, 0);
      if (m !== null) {
        total += m * d.objectiveMeasureWeight;
        valid = true;
      }
    }
    const o = this.objective(a, 0);
    if (valid && counted > 0) {
      o.ms = true;
      o.nm = clamp(total / counted, -1, 1);
    } else o.ms = false;
    this.writeObjective(a, 0);
  }
  /** Completion Measure Rollup Process [RB.1.1 b]. */
  private completionMeasureRollup(a: number) {
    let total = 0;
    let counted = 0;
    let valid = false;
    for (const c of this.available(a)) {
      const d = this.def(c);
      if (!d.tracked || d.progressWeight <= 0) continue;
      counted += d.progressWeight;
      const amount = this.completionAmount(c);
      if (amount !== null) {
        total += amount * d.progressWeight;
        valid = true;
      }
    }
    const s = this.st(a);
    if (valid && counted > 0) {
      s.cas = true;
      s.ca = clamp(total / counted, 0, 1);
    } else s.cas = false;
  }
  /** Objective Rollup Using Measure Process [RB.1.2 a]. */
  private objectiveRollupUsingMeasure(a: number) {
    const d = this.def(a);
    const o = this.objective(a, 0);
    const m = this.measure(a, 0, false);
    if (m === null) o.ps = false;
    else if (!this.st(a).active || d.measureSatisfactionIfActive) {
      o.ps = true;
      o.ss = m >= d.objectives[0]!.minNormalizedMeasure;
    } else o.ps = false;
    this.writeObjective(a, 0);
  }
  /** Objective Rollup Using Rules Process [RB.1.2 b], with the default rules when none are defined. */
  private objectiveRollupUsingRules(a: number) {
    const own = this.def(a).rollupRules.filter((r) => r.action === 'satisfied' || r.action === 'notSatisfied');
    const rules = own.length ? own : DEFAULT_OBJECTIVE_RULES;
    const o = this.objective(a, 0);
    if (this.rollupRuleCheck(a, rules, 'notSatisfied')) {
      o.ps = true;
      o.ss = false;
    }
    if (this.rollupRuleCheck(a, rules, 'satisfied')) {
      o.ps = true;
      o.ss = true;
    }
    this.writeObjective(a, 0);
  }
  /** Activity Progress Rollup Using Measure Process [RB.1.3 a]. */
  private progressRollupUsingMeasure(a: number) {
    const s = this.st(a);
    const amount = this.completionAmount(a, false);
    s.ps = amount !== null;
    s.cs = amount !== null && amount >= this.def(a).minProgressMeasure;
    this.writeObjective(a, 0);
  }
  /** Activity Progress Rollup Using Rules Process [RB.1.3 b], with the default rules when none are defined. */
  private progressRollupUsingRules(a: number) {
    const own = this.def(a).rollupRules.filter((r) => r.action === 'completed' || r.action === 'incomplete');
    const rules = own.length ? own : DEFAULT_PROGRESS_RULES;
    const s = this.st(a);
    if (this.rollupRuleCheck(a, rules, 'incomplete')) {
      s.ps = true;
      s.cs = false;
    }
    if (this.rollupRuleCheck(a, rules, 'completed')) {
      s.ps = true;
      s.cs = true;
    }
    this.writeObjective(a, 0);
  }
  /** Rollup Rule Check Subprocess [RB.1.4]. */
  private rollupRuleCheck(a: number, rules: RollupRule[], action: RollupAction): boolean {
    // The children that contribute depend on the action only, not on the rule: work them out once.
    let contributing: number[] | null = null;
    for (const rule of rules) {
      if (rule.action !== action) continue;
      contributing ??= this.available(a).filter((c) => this.def(c).tracked && this.checkChildForRollup(c, action));
      const bag = contributing.map((c) => this.evaluateRollupConditions(c, rule));
      if (!bag.length) continue;
      const trues = bag.filter((v) => v === true).length;
      let change = false;
      switch (rule.childActivitySet) {
        case 'all':
          change = !bag.includes(false) && !bag.includes(null);
          break;
        case 'any':
          change = trues > 0;
          break;
        case 'none':
          change = !bag.includes(true) && !bag.includes(null);
          break;
        case 'atLeastCount':
          change = trues >= rule.minimumCount;
          break;
        case 'atLeastPercent':
          change = trues / bag.length >= rule.minimumPercent - 1e-9;
          break;
      }
      if (change) return true;
    }
    return false;
  }
  /** Evaluate Rollup Conditions Subprocess [RB.1.4.1]. */
  private evaluateRollupConditions(c: number, rule: RollupRule): Tri {
    if (!rule.conditions.length) return null;
    return combine(
      rule.conditions.map((x) => this.condition(c, x)),
      rule.combination,
    );
  }
  /** Check Child for Rollup Subprocess [RB.1.4.2]. */
  private checkChildForRollup(c: number, action: RollupAction): boolean {
    const d = this.def(c);
    const s = this.state.activities[c] ?? {};
    const objective = action === 'satisfied' || action === 'notSatisfied';
    if (!(objective ? d.rollupObjectiveSatisfied : d.rollupProgressCompletion)) return false;
    const required =
      action === 'satisfied'
        ? d.requiredForSatisfied
        : action === 'notSatisfied'
          ? d.requiredForNotSatisfied
          : action === 'completed'
            ? d.requiredForCompleted
            : d.requiredForIncomplete;
    switch (required) {
      case 'ifNotSuspended':
        return !(!s.aps || ((s.count ?? 0) > 0 && s.suspended));
      case 'ifAttempted':
        return !(!s.aps || (s.count ?? 0) === 0);
      case 'ifNotSkipped':
        return this.rulesCheck(c, d.preRules, SKIP) === null;
      default:
        return true;
    }
  }

  // ----- attempts -----

  /** End Attempt Process [UP.4]. */
  endAttempt(a: number) {
    const d = this.def(a);
    const s = this.st(a);
    const wasActive = !!s.active;
    if (this.isLeaf(a)) {
      if (d.tracked && !s.suspended) this.contentDefaults(a);
    } else {
      s.suspended = d.children.some((c) => !!this.state.activities[c]?.suspended);
    }
    s.active = false;
    if (wasActive) s.end = this.now;
    this.rollup(a);
    if (wasActive && !this.isLeaf(a)) {
      // The next attempt on the cluster gets its own selection and order (onEachNewAttempt).
      this.selectChildren(a, true);
      this.randomizeChildren(a, true);
    }
  }
  /** What End Attempt records for a leaf when its content didn't say (completionSetByContent / objectiveSetByContent false). */
  private contentDefaults(a: number) {
    const d = this.def(a);
    const s = this.st(a);
    if (!d.completionSetByContent && !s.ps) {
      s.ps = true;
      s.cs = true;
    }
    if (!d.objectiveSetByContent) {
      const o = this.objective(a, 0);
      if (!o.ps) {
        o.ps = true;
        o.ss = true;
      }
    }
    this.writeObjective(a, 0);
  }
  /** Terminate Descendent Attempts Process [UP.3]. */
  terminateDescendentAttempts(a: number) {
    const cur = this.state.current;
    if (cur === null) return;
    const common = this.commonAncestor(cur, a);
    if (common === cur) return;
    for (let x = this.parent(cur); x >= 0 && x !== common; x = this.parent(x)) this.endAttempt(x);
  }

  // ----- selection and randomization -----

  /** Select Children Process [SR.1]. */
  selectChildren(a: number, nextAttempt = false) {
    const d = this.def(a);
    const s = this.st(a);
    if (!d.children.length || s.active || s.suspended || d.selectCount === null) return;
    if (d.selectionTiming === 'never' || (d.selectionTiming === 'once' && (s.aps || nextAttempt))) return;
    const pool = [...d.children];
    const picked = new Set<number>();
    while (picked.size < Math.min(d.selectCount, d.children.length)) {
      picked.add(pool.splice(Math.floor(nextRandom(this.state) * pool.length), 1)[0]!);
    }
    s.available = d.children.filter((c) => picked.has(c));
    this.cache = null;
  }
  /** Randomize Children Process [SR.2]. */
  randomizeChildren(a: number, nextAttempt = false) {
    const d = this.def(a);
    const s = this.st(a);
    if (!d.children.length || s.active || s.suspended || !d.reorderChildren) return;
    if (d.randomizationTiming === 'never' || (d.randomizationTiming === 'once' && (s.aps || nextAttempt))) return;
    const list = [...this.available(a)];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom(this.state) * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    s.available = list;
    this.cache = null;
  }
  /** Applies selection and randomization to every cluster before the first delivery. */
  prepare() {
    for (let a = 0; a < this.size; a++) {
      this.selectChildren(a);
      this.randomizeChildren(a);
    }
  }

  // ----- navigation -----

  /** Navigation Request Process [NB.2.1]. */
  navigationRequest(request: NavRequest, target: number | null = null): NavigationResult {
    const cur = this.state.current;
    const active = cur !== null && !!this.st(cur).active;
    const valid = (sequencing: SequencingRequest, t?: number): NavigationResult => ({
      ...(active ? { termination: 'exit' as const } : {}),
      sequencing,
      ...(t !== undefined ? { target: t } : {}),
    });
    switch (request) {
      case 'start':
        return cur === null ? { sequencing: 'start' } : fail('NB.2.1-1');
      case 'resumeAll':
        if (cur !== null) return fail('NB.2.1-1');
        return this.state.suspended !== null ? { sequencing: 'resumeAll' } : fail('NB.2.1-3');
      case 'continue':
        if (cur === null) return fail('NB.2.1-2');
        return cur !== ROOT && this.def(this.parent(cur)).flow ? valid('continue') : fail('NB.2.1-4');
      case 'previous': {
        if (cur === null) return fail('NB.2.1-2');
        if (cur === ROOT) return fail('NB.2.1-6');
        const p = this.def(this.parent(cur));
        return p.flow && !p.forwardOnly ? valid('previous') : fail('NB.2.1-5');
      }
      case 'choice': {
        // The target must be in the activity tree as selected (its parent's Available Children, and
        // so on up), before any termination: a choice that can't succeed doesn't end the current attempt.
        if (target === null || target < 0 || target >= this.size || !this.isAvailable(target)) return fail('NB.2.1-11');
        if (target !== ROOT && !this.def(this.parent(target)).choice) return fail('NB.2.1-10');
        if (cur === null) return { sequencing: 'choice', target };
        // We are always allowed to choose a sibling of the current activity.
        if (target === cur || this.parent(target) !== this.parent(cur)) {
          const common = this.commonAncestor(cur, target);
          for (let x = cur; x >= 0 && x !== common; x = this.parent(x)) {
            if (this.st(x).active && !this.def(x).choiceExit) return fail('NB.2.1-8');
          }
        }
        return valid('choice', target);
      }
      case 'jump':
        if (target === null || target < 0 || target >= this.size || !this.isAvailable(target)) return fail('NB.2.1-11');
        if (cur === null) return fail('NB.2.1-2');
        return valid('jump', target);
      case 'exit':
        if (cur === null) return fail('NB.2.1-2');
        return active ? { termination: 'exit', sequencing: 'exit' } : fail('NB.2.1-12');
      case 'exitAll':
        return cur === null ? fail('NB.2.1-2') : { termination: 'exitAll', sequencing: 'exit' };
      case 'abandon':
        if (cur === null) return fail('NB.2.1-2');
        return active ? { termination: 'abandon', sequencing: 'exit' } : fail('NB.2.1-12');
      case 'abandonAll':
        return cur === null ? fail('NB.2.1-2') : { termination: 'abandonAll', sequencing: 'exit' };
      case 'suspendAll':
        return cur === null ? fail('NB.2.1-2') : { termination: 'suspendAll', sequencing: 'exit' };
      default:
        return fail('NB.2.1-13');
    }
  }

  /** Sequencing Exit Action Rules Subprocess [TB.2.1]. */
  private exitActionRules() {
    const cur = this.state.current!;
    const path = this.pathToRoot(cur).slice(1).reverse();
    const target = path.find((a) => this.rulesCheck(a, this.def(a).exitRules, EXIT) !== null);
    if (target !== undefined) {
      this.terminateDescendentAttempts(target);
      this.endAttempt(target);
      this.state.current = target;
    }
  }
  /** Sequencing Post Condition Rules Subprocess [TB.2.2]. */
  private postConditionRules(): { termination?: 'exitParent' | 'exitAll'; sequencing?: SequencingRequest } {
    const cur = this.state.current!;
    if (this.st(cur).suspended) return {};
    const action = this.rulesCheck(cur, this.def(cur).postRules, POST);
    if (action === 'retry' || action === 'continue' || action === 'previous') return { sequencing: action };
    if (action === 'exitParent' || action === 'exitAll') return { termination: action };
    if (action === 'retryAll') return { termination: 'exitAll', sequencing: 'retry' };
    return {};
  }
  /** Termination Request Process [TB.2.3]. */
  terminationRequest(request: Termination): { sequencing?: SequencingRequest; exception?: string } {
    const cur = this.state.current;
    if (cur === null) return fail('TB.2.3-1');
    if ((request === 'exit' || request === 'abandon') && !this.st(cur).active) return fail('TB.2.3-2');
    switch (request) {
      case 'exit': {
        this.endAttempt(cur);
        this.exitActionRules();
        for (;;) {
          const post = this.postConditionRules();
          if (post.termination === 'exitAll') return this.exitAll(post.sequencing === 'retry');
          if (post.termination === 'exitParent') {
            const current = this.state.current!;
            if (current === ROOT) return fail('TB.2.3-4');
            this.state.current = this.parent(current);
            this.endAttempt(this.state.current);
            continue;
          }
          if (this.state.current === ROOT && post.sequencing !== 'retry') return { sequencing: 'exit' };
          return post.sequencing ? { sequencing: post.sequencing } : {};
        }
      }
      case 'exitAll':
        return this.exitAll(false);
      case 'suspendAll': {
        const s = this.st(cur);
        if (s.active || s.suspended) {
          this.rollup(cur);
          this.state.suspended = cur;
        } else if (cur !== ROOT) this.state.suspended = this.parent(cur);
        else return fail('TB.2.3-3');
        for (const a of this.pathToRoot(this.state.suspended)) {
          this.st(a).active = false;
          this.st(a).suspended = true;
        }
        this.state.current = ROOT;
        return { sequencing: 'exit' };
      }
      case 'abandon':
        this.st(cur).active = false;
        return {};
      case 'abandonAll':
        for (const a of this.pathToRoot(cur)) this.st(a).active = false;
        this.state.current = ROOT;
        return { sequencing: 'exit' };
    }
  }
  private exitAll(retry: boolean): { sequencing: SequencingRequest } {
    const cur = this.state.current!;
    if (this.st(cur).active) this.endAttempt(cur);
    this.terminateDescendentAttempts(ROOT);
    this.endAttempt(ROOT);
    this.state.current = ROOT;
    // Retry All: exit everything, then retry the root.
    return { sequencing: retry ? 'retry' : 'exit' };
  }

  /** Sequencing Request Process [SB.2.12]. */
  sequencingRequest(request: SequencingRequest, target: number | null = null): SequencingResult {
    switch (request) {
      case 'start':
        return this.startRequest();
      case 'resumeAll':
        return this.resumeAllRequest();
      case 'exit':
        return this.exitRequest();
      case 'retry':
        return this.retryRequest();
      case 'continue':
        return this.continueRequest();
      case 'previous':
        return this.previousRequest();
      case 'choice':
        return this.choiceRequest(target);
      case 'jump':
        return this.state.current === null ? fail('SB.2.13-1') : target === null ? fail('SB.2.13-1') : { delivery: target };
      default:
        return fail('SB.2.12-1');
    }
  }
  /** Start Sequencing Request Process [SB.2.5]. */
  private startRequest(): SequencingResult {
    if (this.state.current !== null) return fail('SB.2.5-1');
    if (this.isLeaf(ROOT)) return { delivery: ROOT };
    return this.flowResult(this.flow(ROOT, 'forward', true));
  }
  /** Resume All Sequencing Request Process [SB.2.6]. */
  private resumeAllRequest(): SequencingResult {
    if (this.state.current !== null) return fail('SB.2.6-1');
    if (this.state.suspended === null) return fail('SB.2.6-2');
    return { delivery: this.state.suspended };
  }
  /** Continue Sequencing Request Process [SB.2.7]. */
  private continueRequest(): SequencingResult {
    const cur = this.state.current;
    if (cur === null) return fail('SB.2.7-1');
    if (cur !== ROOT && !this.def(this.parent(cur)).flow) return fail('SB.2.7-2');
    return this.flowResult(this.flow(cur, 'forward', false));
  }
  /** Previous Sequencing Request Process [SB.2.8]. */
  private previousRequest(): SequencingResult {
    const cur = this.state.current;
    if (cur === null) return fail('SB.2.8-1');
    if (cur !== ROOT && !this.def(this.parent(cur)).flow) return fail('SB.2.8-2');
    return this.flowResult(this.flow(cur, 'backward', false));
  }
  /** Retry Sequencing Request Process [SB.2.10]. */
  private retryRequest(): SequencingResult {
    const cur = this.state.current;
    if (cur === null) return fail('SB.2.10-1');
    const s = this.st(cur);
    if (s.active || s.suspended) return fail('SB.2.10-2');
    if (this.isLeaf(cur)) return { delivery: cur };
    // The retry is a new attempt on the cluster: what its descendants recorded before doesn't steer the flow.
    s.stamp = ++this.state.clock;
    const f = this.flow(cur, 'forward', true);
    return f.deliverable ? { delivery: f.activity } : fail('SB.2.10-3');
  }
  /** Exit Sequencing Request Process [SB.2.11]. */
  private exitRequest(): SequencingResult {
    const cur = this.state.current;
    if (cur === null) return fail('SB.2.11-1');
    if (this.st(cur).active) return fail('SB.2.11-2');
    return cur === ROOT ? { endSession: true } : {};
  }
  private flowResult(f: FlowResult): SequencingResult {
    if (f.deliverable) return { delivery: f.activity };
    if (f.endSession) return { endSession: true };
    return fail(f.exception ?? 'SB.2.1-2');
  }

  /** Choice Sequencing Request Process [SB.2.9]. */
  private choiceRequest(target: number | null): SequencingResult {
    if (target === null || target < 0 || target >= this.size) return fail('SB.2.9-1');
    for (const a of this.pathToRoot(target).reverse()) {
      if (a !== ROOT && !this.inAvailable(a)) return fail('SB.2.9-2');
      if (this.isHiddenFromChoice(a)) return fail('SB.2.9-3');
    }
    if (target !== ROOT && !this.def(this.parent(target)).choice) return fail('SB.2.9-4');
    const cur = this.state.current;
    const common = cur === null ? ROOT : this.commonAncestor(cur, target);
    /** Activities from `from` down to `to`'s parent (exclusive of `to`), root-first. */
    const down = (from: number, to: number) => {
      const out: number[] = [];
      for (let x = this.parent(to); x >= 0; x = this.parent(x)) {
        out.push(x);
        if (x === from) return out.reverse();
      }
      return [];
    };
    const blocked = (a: number) => !this.st(a).active && a !== common && this.def(a).preventActivation;
    if (cur === target) {
      // Case 1: the current activity; nothing to check.
    } else if (cur !== null && this.parent(cur) === this.parent(target)) {
      // Case 2: a sibling of the current activity. Choice Activity Traversal over the siblings on the
      // way: forward from the current activity up to the target, or backward (where every sibling
      // gives the same answer, from their common parent's forwardOnly).
      const from = this.siblingIndex(cur);
      const to = this.siblingIndex(target);
      const forward = from >= 0 && to >= 0 ? to > from : this.isForward(target, cur);
      const r =
        from >= 0 && to >= 0 && forward
          ? this.stopForwardBetween(this.parent(target), from, to)
          : this.choiceActivityTraversal(cur, forward ? 'forward' : 'backward');
      if (r) return fail(r);
    } else if (cur === null || common === cur) {
      // Case 3: the target is a descendant of the current activity (or nothing is current yet).
      const path = down(common, target);
      if (!path.length) return fail('SB.2.9-5');
      for (const a of path) {
        const r = this.choiceActivityTraversal(a, 'forward');
        if (r) return fail(r);
        if (blocked(a)) return fail('SB.2.9-6');
      }
    } else if (target === common) {
      // Case 4: the target is an ancestor of the current activity.
      const path = this.pathToRoot(cur);
      const upTo = path.slice(0, path.indexOf(target) + 1);
      if (!upTo.length) return fail('SB.2.9-5');
      for (const a of upTo.slice(0, -1)) if (!this.def(a).choiceExit) return fail('SB.2.9-7');
    } else {
      // Case 5: the target is in another branch below the common ancestor.
      const up = this.pathToRoot(cur);
      const exiting = up.slice(0, up.indexOf(common));
      if (!exiting.length) return fail('SB.2.9-5');
      let constrained = -1;
      for (const a of exiting) {
        if (!this.def(a).choiceExit) return fail('SB.2.9-7');
        if (constrained < 0 && this.def(a).constrainChoice) constrained = a;
      }
      if (constrained >= 0) {
        const consider = this.choiceFlow(constrained, this.isForward(target, constrained) ? 'forward' : 'backward');
        if (!this.isAvailableDescendant(target, consider) && target !== consider && target !== constrained) return fail('SB.2.9-8');
      }
      const path = down(common, target);
      if (!path.length) return fail('SB.2.9-5');
      const forward = this.isForward(target, cur);
      for (const a of path) {
        if (forward) {
          const r = this.choiceActivityTraversal(a, 'forward');
          if (r) return fail(r);
        }
        if (blocked(a)) return fail('SB.2.9-6');
      }
    }
    if (this.isLeaf(target)) return { delivery: target };
    const f = this.flow(target, 'forward', true);
    if (!f.deliverable) {
      // Nothing to deliver, but the target was reached: it becomes the current activity.
      if (!this.dryRun) {
        this.terminateDescendentAttempts(common);
        this.endAttempt(common);
        this.state.current = target;
      }
      return fail('SB.2.9-9');
    }
    return { delivery: f.activity };
  }
  /**
   * Choice Activity Traversal forward over `parent`'s Available Children at positions [from, to):
   * SB.2.4-1 when a stopForwardTraversal rule of one of them applies. In a dry run the first such
   * position after `from` is kept, as validity asks this for every sibling of the current activity.
   */
  private stopForwardBetween(parent: number, from: number, to: number): string | null {
    const siblings = this.available(parent);
    const key = parent * (this.size + 1) + from;
    let first = this.stopMemo?.get(key);
    if (first === undefined) {
      first = Infinity;
      const end = this.stopMemo ? siblings.length : to;
      for (let i = from; i < end; i++) {
        if (this.choiceActivityTraversal(siblings[i]!, 'forward')) {
          first = i;
          break;
        }
      }
      this.stopMemo?.set(key, first);
    }
    return first < to ? 'SB.2.4-1' : null;
  }
  /** Choice Activity Traversal Subprocess [SB.2.4]: returns an exception code, or null when reachable. */
  private choiceActivityTraversal(a: number, dir: Dir): string | null {
    if (dir === 'forward') return this.rulesCheck(a, this.def(a).preRules, STOP_FORWARD) !== null ? 'SB.2.4-1' : null;
    if (a === ROOT) return 'SB.2.4-3';
    return this.def(this.parent(a)).forwardOnly ? 'SB.2.4-2' : null;
  }
  /** Choice Flow Subprocess [SB.2.9.1]. */
  private choiceFlow(a: number, dir: Dir): number {
    return this.choiceFlowTreeTraversal(a, dir) ?? a;
  }
  /** Choice Flow Tree Traversal Subprocess [SB.2.9.2]. */
  private choiceFlowTreeTraversal(a: number, dir: Dir): number | null {
    if (a === ROOT) return null;
    if (dir === 'forward') {
      if (this.isLastInPreorder(a)) return null;
      return this.isLastSibling(a) ? this.choiceFlowTreeTraversal(this.parent(a), 'forward') : this.nextSibling(a);
    }
    return this.isFirstSibling(a) ? this.choiceFlowTreeTraversal(this.parent(a), 'backward') : this.previousSibling(a);
  }

  /** Flow Subprocess [SB.2.3]. */
  private flow(a: number, dir: Dir, considerChildren: boolean): FlowResult {
    const t = this.flowTreeTraversal(a, dir, null, considerChildren);
    if (t.next === null) return { activity: a, deliverable: false, endSession: t.endSession, exception: t.exception };
    return this.flowActivityTraversal(t.next, dir, null);
  }
  /** Flow Tree Traversal Subprocess [SB.2.1]. */
  private flowTreeTraversal(a: number, dir: Dir, previous: Dir | null, considerChildren: boolean): Traversal {
    let activity = a;
    let reversed = false;
    if (previous === 'backward' && activity !== ROOT && this.isLastSibling(activity)) {
      // Leaving a forward-only cluster that was entered backwards: carry on backwards from its start.
      dir = 'backward';
      activity = this.siblings(activity)[0]!;
      reversed = true;
    }
    if (dir === 'forward') {
      if (this.isLastInPreorder(activity) || (activity === ROOT && !considerChildren)) {
        if (!this.dryRun) this.terminateDescendentAttempts(ROOT);
        return { next: null, dir, endSession: true };
      }
      if (this.isLeaf(activity) || !considerChildren) {
        if (this.isLastSibling(activity)) return this.flowTreeTraversal(this.parent(activity), 'forward', null, false);
        return { next: this.nextSibling(activity), dir: 'forward' };
      }
      const kids = this.available(activity);
      return kids.length ? { next: kids[0]!, dir: 'forward' } : { next: null, dir, exception: 'SB.2.1-2' };
    }
    if (activity === ROOT) return { next: null, dir, exception: 'SB.2.1-3' };
    if (this.isLeaf(activity) || !considerChildren) {
      // Only test forward only if we aren't about to leave this forward-only cluster.
      if (!reversed && this.def(this.parent(activity)).forwardOnly) return { next: null, dir, exception: 'SB.2.1-4' };
      if (this.isFirstSibling(activity)) return this.flowTreeTraversal(this.parent(activity), 'backward', null, false);
      return { next: this.previousSibling(activity), dir: 'backward' };
    }
    const kids = this.available(activity);
    if (!kids.length) return { next: null, dir, exception: 'SB.2.1-2' };
    // Enter a forward-only cluster at its start; otherwise at its end.
    return this.def(activity).forwardOnly ? { next: kids[0]!, dir: 'forward' } : { next: kids[kids.length - 1]!, dir: 'backward' };
  }
  /** Flow Activity Traversal Subprocess [SB.2.2]. */
  private flowActivityTraversal(a: number, dir: Dir, previous: Dir | null): FlowResult {
    const memo = this.flowMemo;
    if (!memo) return this.flowActivityTraversalStep(a, dir, previous);
    // In a dry run the traversal from an activity always ends the same way: work it out once.
    const key = a * 6 + (dir === 'forward' ? 0 : 3) + (previous === null ? 0 : previous === 'forward' ? 1 : 2);
    let result = memo.get(key);
    if (!result) memo.set(key, (result = this.flowActivityTraversalStep(a, dir, previous)));
    return result;
  }
  private flowActivityTraversalStep(a: number, dir: Dir, previous: Dir | null): FlowResult {
    if (a !== ROOT && !this.def(this.parent(a)).flow) return { activity: a, deliverable: false, exception: 'SB.2.2-1' };
    if (this.rulesCheck(a, this.def(a).preRules, SKIP) !== null) {
      const t = this.flowTreeTraversal(a, dir, previous, false);
      if (t.next === null) return { activity: a, deliverable: false, endSession: t.endSession, exception: t.exception };
      if (previous === 'backward' && t.dir === 'backward') return this.flowActivityTraversal(t.next, t.dir, null);
      return this.flowActivityTraversal(t.next, dir, previous);
    }
    if (this.checkActivity(a)) return { activity: a, deliverable: false, exception: 'SB.2.2-2' };
    if (!this.isLeaf(a)) {
      const t = this.flowTreeTraversal(a, dir, null, true);
      if (t.next === null) return { activity: a, deliverable: false, endSession: t.endSession, exception: t.exception };
      if (dir === 'backward' && t.dir === 'forward') return this.flowActivityTraversal(t.next, 'forward', 'backward');
      return this.flowActivityTraversal(t.next, dir, null);
    }
    return { activity: a, deliverable: true };
  }

  // ----- delivery -----

  /** Delivery Request Process [DB.1.1]. */
  deliveryRequest(a: number): string | null {
    if (!this.isLeaf(a)) return 'DB.1.1-1';
    if (!this.def(a).launchable) return 'DB.1.1-1';
    for (const x of this.pathToRoot(a).reverse()) if (this.checkActivity(x)) return 'DB.1.1-3';
    return null;
  }
  /** Clear Suspended Activity Subprocess [DB.2.1]. */
  private clearSuspendedActivity(a: number) {
    const suspended = this.state.suspended;
    if (suspended === null) return;
    const common = this.commonAncestor(a, suspended);
    for (const x of this.pathToRoot(suspended)) {
      const s = this.st(x);
      if (this.isLeaf(x)) s.suspended = false;
      else if (!this.def(x).children.some((c) => !!this.state.activities[c]?.suspended)) s.suspended = false;
      if (x === common) break;
    }
    this.state.suspended = null;
  }
  /** Content Delivery Environment Process [DB.2]. Returns an exception code, or whether a new attempt began on the activity. */
  contentDelivery(a: number): { exception?: string; newAttempt: boolean } {
    if (this.st(a).active) return { exception: 'DB.2-1', newAttempt: false };
    if (a !== this.state.suspended) this.clearSuspendedActivity(a);
    this.terminateDescendentAttempts(a);
    let newAttempt = false;
    for (const x of this.pathToRoot(a).reverse()) {
      const s = this.st(x);
      if (s.active) continue;
      if (s.suspended) {
        s.suspended = false;
        if (x === a) s.resumed = true;
      } else {
        s.count = (s.count ?? 0) + 1;
        if (s.count === 1) s.aps = true;
        // A new attempt: fresh objective and attempt progress information.
        s.ps = false;
        s.cs = false;
        s.cas = false;
        delete s.ca;
        delete s.objectives;
        delete s.end;
        s.start = this.now;
        s.stamp = ++this.state.clock;
        if (x === a) {
          newAttempt = true;
          s.resumed = false;
        }
      }
      s.active = true;
    }
    this.state.current = a;
    this.state.suspended = null;
    this.st(a).delivery = ++this.state.deliveries;
    return { newAttempt };
  }

  /** Coursekit: an asset can't report anything, so it counts as completed (and satisfied) once it is delivered. */
  private assetDelivered(a: number) {
    const d = this.def(a);
    if (d.sco || !d.tracked) return;
    this.contentDefaults(a);
    this.rollup(a);
  }

  /** The Overall Sequencing Process [OP.1] for one navigation request. */
  navigate(request: NavRequest, target: number | null = null): NavOutcome {
    const nav = this.navigationRequest(request, target);
    if (nav.exception) return { valid: false, exception: nav.exception };
    let sequencing = nav.sequencing ?? null;
    if (nav.termination) {
      const t = this.terminationRequest(nav.termination);
      if (t.exception) return { valid: false, exception: t.exception };
      if (t.sequencing) sequencing = t.sequencing;
    }
    if (!sequencing) return { valid: true };
    const r = this.sequencingRequest(sequencing, nav.target ?? null);
    if (r.exception) return { valid: false, exception: r.exception };
    if (r.endSession) {
      this.endSession();
      return { valid: true, ended: true };
    }
    if (r.delivery === undefined) return { valid: true };
    const refused = this.deliveryRequest(r.delivery);
    if (refused) return { valid: false, exception: refused };
    const c = this.contentDelivery(r.delivery);
    if (c.exception) return { valid: false, exception: c.exception };
    this.assetDelivered(r.delivery);
    return { valid: true, delivered: r.delivery, newAttempt: c.newAttempt };
  }

  /** The sequencing session is over. Without a suspended activity the attempt is too. */
  private endSession() {
    if (this.state.suspended === null) {
      if (this.st(ROOT).active) {
        this.terminateDescendentAttempts(ROOT);
        this.endAttempt(ROOT);
      }
      this.state.ended = true;
    }
    this.state.current = null;
  }

  // ----- the run-time -----

  /**
   * Records what the SCO of a leaf reported (cmi.completion_status, cmi.success_status, cmi.score,
   * cmi.objectives...) and rolls up. `endDefaults: false` records only what was reported, even for an
   * attempt that has ended (rebuilding the state of an attempt from before 0.4.0, whose SCO attempts
   * never went through End Attempt).
   */
  applyRuntime(a: number, report: RuntimeReport, { endDefaults = true }: { endDefaults?: boolean } = {}) {
    const d = this.def(a);
    if (!d.tracked || !this.isLeaf(a)) return;
    const s = this.st(a);
    const reported = new Map<string, RuntimeReport['objectives'][number]>();
    for (const r of report.objectives) if (!reported.has(r.id)) reported.set(r.id, r);
    const primaryId = d.objectives[0]!.id;
    const listed = primaryId === null ? undefined : reported.get(primaryId);
    const p = this.objective(a, 0);
    const success = report.success !== 'unknown' ? report.success : (listed?.success ?? 'unknown');
    p.ps = success !== 'unknown';
    p.ss = success === 'passed';
    const scaled = report.scaled ?? listed?.scaled ?? null;
    p.ms = scaled !== null;
    if (scaled !== null) p.nm = clamp(scaled, -1, 1);
    else delete p.nm;
    const setScore = (o: ObjectiveState, raw: number | null, min: number | null, max: number | null) => {
      if (raw === null) delete o.raw;
      else o.raw = raw;
      if (min === null) delete o.min;
      else o.min = min;
      if (max === null) delete o.max;
      else o.max = max;
    };
    setScore(p, report.raw ?? listed?.raw ?? null, report.min ?? listed?.min ?? null, report.max ?? listed?.max ?? null);
    const completion = report.completion !== 'unknown' ? report.completion : (listed?.completion ?? 'unknown');
    s.ps = completion !== 'unknown';
    s.cs = completion === 'completed';
    const progress = report.progress ?? listed?.progress ?? null;
    s.cas = progress !== null;
    if (progress !== null) s.ca = clamp(progress, 0, 1);
    else delete s.ca;
    for (let o = 1; o < d.objectives.length; o++) {
      const def = d.objectives[o]!;
      const r = def.id === null ? undefined : reported.get(def.id);
      if (!r) continue;
      const x = this.objective(a, o);
      x.ms = r.scaled !== null;
      if (r.scaled !== null) x.nm = clamp(r.scaled, -1, 1);
      else delete x.nm;
      if (def.satisfiedByMeasure) {
        x.ps = x.ms;
        x.ss = x.ms && (x.nm ?? 0) >= def.minNormalizedMeasure;
      } else {
        x.ps = r.success !== 'unknown';
        x.ss = r.success === 'passed';
      }
      setScore(x, r.raw, r.min, r.max);
      x.cps = r.completion !== 'unknown';
      x.cs = r.completion === 'completed';
      x.pms = r.progress !== null;
      if (r.progress !== null) x.pm = clamp(r.progress, 0, 1);
      else delete x.pm;
      this.writeObjective(a, o);
    }
    // Data that arrives after the attempt ended (a SCO finishing from its unload handler) keeps End Attempt's defaults.
    if (endDefaults && !s.active && !s.suspended && (s.count ?? 0) > 0) this.contentDefaults(a);
    this.writeObjective(a, 0);
    this.rollup(a);
  }

  /** What a SCO's cmi.objectives entry shows: its own values, or read from global objectives when unknown. */
  objectiveView(a: number, o: number) {
    const s = this.state.activities[a] ?? {};
    const local = this.peekObjective(a, o);
    const maps = this.def(a).objectives[o]?.maps ?? [];
    const read = <K extends keyof ObjectiveState>(flag: keyof (typeof maps)[number], known: (g: ObjectiveState) => boolean, key: K) => {
      for (const m of maps) {
        const g = m[flag] ? this.global(m.target) : undefined;
        if (g && known(g)) return g[key];
      }
      return undefined;
    };
    const satisfied = this.satisfied(a, o, false);
    const measure = this.measure(a, o, false);
    const completed = o === 0 ? (s.ps ? !!s.cs : null) : local.cps ? !!local.cs : null;
    const progress = o === 0 ? (s.cas ? (s.ca ?? 0) : null) : local.pms ? (local.pm ?? 0) : null;
    const gCompleted = read('readCompletion', (g) => !!g.cps, 'cs');
    const gProgress = read('readProgress', (g) => !!g.pms, 'pm');
    return {
      success: satisfied === null ? undefined : satisfied ? ('passed' as const) : ('failed' as const),
      scaled: measure ?? undefined,
      raw: local.raw ?? (read('readRaw', (g) => g.raw !== undefined, 'raw') as number | undefined),
      min: local.min ?? (read('readMin', (g) => g.min !== undefined, 'min') as number | undefined),
      max: local.max ?? (read('readMax', (g) => g.max !== undefined, 'max') as number | undefined),
      completion:
        completed !== null
          ? completed
            ? ('completed' as const)
            : ('incomplete' as const)
          : gCompleted === undefined
            ? undefined
            : gCompleted
              ? ('completed' as const)
              : ('incomplete' as const),
      progress: progress ?? (gProgress as number | undefined),
    };
  }
}

interface Traversal {
  next: number | null;
  dir: Dir;
  endSession?: boolean;
  exception?: string;
}

interface FlowResult {
  activity: number;
  deliverable: boolean;
  endSession?: boolean;
  exception?: string;
}
