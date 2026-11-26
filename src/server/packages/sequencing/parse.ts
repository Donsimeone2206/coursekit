/**
 * Reads the SCORM 2004 Sequencing Definition Model from imsmanifest.xml: imsss:sequencing on the
 * organization and its items (with imsss:sequencingCollection and IDRef), the ADL extensions
 * (adlseq, adlnav, adlcp:completionThreshold, adlcp:data) and the organization's global-to-system
 * attributes. Every element gets the specification's default when it is missing; malformed values
 * get the default too, with an import warning.
 */
import type { Element } from '@xmldom/xmldom';
import type {
  ActivityDef,
  ChildActivitySet,
  LmsControl,
  ObjectiveDef,
  ObjectiveMap,
  RequiredFor,
  RollupAction,
  RollupRule,
  RuleAction,
  RuleCondition,
  SequencingRule,
  SequencingTree,
  Timing,
} from './types.js';

export interface SequencingNode {
  el: Element;
  id: string;
  title: string;
  /** Index into the node list of the parent item, or -1 when the parent is the organization. */
  parent: number;
  depth: number;
  launchable: boolean;
  sco: boolean;
  visible: boolean;
}

type Warn = (message: string) => void;

// Limits on what one activity may define. Request validity runs the rules for every activity on every
// launch, and rollup goes over every child for every rule, so these keep that work bounded; real
// packages stay far below them. What goes beyond them is ignored, with an import warning.

/** Rules of each kind (pre-, exit- and post-condition, rollup) per activity. */
export const MAX_RULES_PER_KIND = 20;
/** Conditions per rule: a rule with more is ignored. */
export const MAX_RULE_CONDITIONS = 10;
/** Global objective maps per objective, and shared data maps per activity. */
export const MAX_MAPS = 20;
/** Package-wide limits (a sequencing collection can repeat the same rules on every item): more fails the import. */
export const MAX_PACKAGE_RULES = 20_000;
export const MAX_PACKAGE_CONDITIONS = 40_000;
export const MAX_PACKAGE_MAPS = 20_000;
/** Items nested deeper than this fail the import (traversals walk the tree from the root). */
export const MAX_DEPTH = 32;

const RULE_CONDITIONS: readonly RuleCondition[] = [
  'satisfied',
  'objectiveStatusKnown',
  'objectiveMeasureKnown',
  'objectiveMeasureGreaterThan',
  'objectiveMeasureLessThan',
  'completed',
  'activityProgressKnown',
  'attempted',
  'attemptLimitExceeded',
  'timeLimitExceeded',
  'outsideAvailableTimeRange',
  'always',
];
const ROLLUP_CONDITIONS: readonly RuleCondition[] = [
  'satisfied',
  'objectiveStatusKnown',
  'objectiveMeasureKnown',
  'completed',
  'activityProgressKnown',
  'attempted',
  'attemptLimitExceeded',
  'timeLimitExceeded',
  'outsideAvailableTimeRange',
];
const PRE_ACTIONS: readonly RuleAction[] = ['skip', 'disabled', 'hiddenFromChoice', 'stopForwardTraversal'];
const EXIT_ACTIONS: readonly RuleAction[] = ['exit'];
const POST_ACTIONS: readonly RuleAction[] = ['exitParent', 'exitAll', 'retry', 'retryAll', 'continue', 'previous'];
const ROLLUP_ACTIONS: readonly RollupAction[] = ['satisfied', 'notSatisfied', 'completed', 'incomplete'];
const CHILD_SETS: readonly ChildActivitySet[] = ['all', 'any', 'none', 'atLeastCount', 'atLeastPercent'];
const REQUIRED_FOR: readonly RequiredFor[] = ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'];
const TIMINGS: readonly Timing[] = ['never', 'once', 'onEachNewAttempt'];
const LMS_CONTROLS: readonly LmsControl[] = ['previous', 'continue', 'exit', 'exitAll', 'abandon', 'abandonAll', 'suspendAll'];

// ----- XML helpers (local names, any namespace prefix) -----

const local = (el: Element) => (el.localName ?? el.nodeName.replace(/^.*:/, '')).toLowerCase();
const isAdl = (el: Element, prefix: 'adlseq' | 'adlnav' | 'adlcp') =>
  (el.namespaceURI ?? '').toLowerCase().includes(prefix) || (el.prefix ?? '').toLowerCase() === prefix;

function children(el: Element | null | undefined, name?: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || local(n as Element) === name.toLowerCase())) out.push(n as Element);
  }
  return out;
}
const child = (el: Element | null | undefined, name: string) => children(el, name)[0] ?? null;
const textOf = (el: Element | null | undefined) => (el?.textContent ?? '').trim();

function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const want = name.toLowerCase();
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    const lname = (a.localName ?? a.name.replace(/^.*:/, '')).toLowerCase();
    if (lname === want) return a.value.trim();
  }
  return null;
}

/** Parses an xs:duration (PnYnMnDTnHnMnS) into seconds; null when it isn't one. */
export function durationSeconds(value: string): number | null {
  const m = /^P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + s;
}

class Reader {
  constructor(
    private readonly who: string,
    private readonly warn: Warn,
  ) {}

  private say(message: string) {
    this.warn(`${this.who}: ${message}`);
  }

  bool(el: Element | null, name: string, fallback: boolean): boolean {
    const v = attr(el, name);
    if (v === null || v === '') return fallback;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    this.say(`${name}="${v.slice(0, 40)}" isn't true or false, so the default (${fallback}) is used.`);
    return fallback;
  }

  decimal(el: Element | null, name: string, fallback: number, min: number, max: number): number {
    const v = attr(el, name);
    return v === null || v === '' ? fallback : this.decimalValue(v, name, fallback, min, max);
  }

  decimalValue(v: string, name: string, fallback: number, min: number, max: number): number {
    const n = /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    this.say(`${name} "${v.slice(0, 40)}" isn't a number from ${min} to ${max}, so the default (${fallback}) is used.`);
    return fallback;
  }

  integer(el: Element | null, name: string): number | null {
    const v = attr(el, name);
    if (v === null || v === '') return null;
    if (/^\+?\d{1,9}$/.test(v)) return Number(v);
    this.say(`${name}="${v.slice(0, 40)}" isn't a whole number, so it is ignored.`);
    return null;
  }

  vocab<T extends string>(el: Element | null, name: string, list: readonly T[], fallback: T): T {
    const v = attr(el, name);
    if (v === null || v === '') return fallback;
    const found = list.find((x) => x.toLowerCase() === v.toLowerCase());
    if (found) return found;
    this.say(`${name}="${v.slice(0, 40)}" isn't one of ${list.join(', ')}, so the default (${fallback}) is used.`);
    return fallback;
  }

  dropped(what: string) {
    this.say(what);
  }
}

// ----- sequencing collections and IDRef -----

/** The top-level parts of <imsss:sequencing>; a local part replaces the referenced collection's part. */
function partKey(el: Element): string {
  const name = local(el);
  if (name === 'objectives') return isAdl(el, 'adlseq') ? 'adlseq:objectives' : 'objectives';
  return name;
}

interface SequencingParts {
  get(name: string): Element | null;
}

function sequencingParts(seq: Element | null, collection: Map<string, Element>, r: Reader): SequencingParts {
  const parts = new Map<string, Element>();
  if (seq) {
    const ref = attr(seq, 'IDRef');
    if (ref) {
      const shared = collection.get(ref);
      if (shared) {
        for (const part of children(shared)) if (!parts.has(partKey(part))) parts.set(partKey(part), part);
      } else {
        r.dropped(
          `its sequencing refers to "${ref.slice(0, 80)}", which isn't in the sequencing collection, so only its own rules are used.`,
        );
      }
    }
    const own = new Map<string, Element>();
    for (const part of children(seq)) if (!own.has(partKey(part))) own.set(partKey(part), part);
    for (const [key, part] of own) parts.set(key, part);
  }
  return { get: (name) => parts.get(name.toLowerCase()) ?? null };
}

// ----- the parts -----

function readRules(parts: SequencingParts, r: Reader) {
  const pre: SequencingRule[] = [];
  const exit: SequencingRule[] = [];
  const post: SequencingRule[] = [];
  const full = new Set<string>();
  for (const ruleEl of children(parts.get('sequencingRules'))) {
    const kind = local(ruleEl);
    const [list, actions] =
      kind === 'preconditionrule'
        ? [pre, PRE_ACTIONS]
        : kind === 'exitconditionrule'
          ? [exit, EXIT_ACTIONS]
          : kind === 'postconditionrule'
            ? [post, POST_ACTIONS]
            : [null, []];
    if (!list) continue;
    const label = kind.replace('conditionrule', '-condition');
    if (list.length >= MAX_RULES_PER_KIND) {
      if (!full.has(kind)) r.dropped(`it has more than ${MAX_RULES_PER_KIND} ${label} rules, so the rest are ignored.`);
      full.add(kind);
      continue;
    }
    const actionName = attr(child(ruleEl, 'ruleAction'), 'action') ?? '';
    const action = actions.find((a) => a.toLowerCase() === actionName.toLowerCase());
    if (!action) {
      r.dropped(`a ${label} rule has the action "${actionName.slice(0, 40)}", which isn't allowed there, so the rule is ignored.`);
      continue;
    }
    const conditionsEl = child(ruleEl, 'ruleConditions');
    const conditionEls = children(conditionsEl, 'ruleCondition');
    if (conditionEls.length > MAX_RULE_CONDITIONS) {
      r.dropped(`a ${label} rule has more than ${MAX_RULE_CONDITIONS} conditions, so the rule is ignored.`);
      continue;
    }
    const conditions: SequencingRule['conditions'] = [];
    let broken = false;
    for (const c of conditionEls) {
      const name = attr(c, 'condition') ?? '';
      const condition = RULE_CONDITIONS.find((x) => x.toLowerCase() === name.toLowerCase());
      if (!condition) {
        r.dropped(`a rule condition "${name.slice(0, 40)}" isn't a SCORM condition, so the rule is ignored.`);
        broken = true;
        break;
      }
      conditions.push({
        condition,
        not: r.vocab(c, 'operator', ['noOp', 'not'] as const, 'noOp') === 'not',
        objective: attr(c, 'referencedObjective') || null,
        threshold: r.decimal(c, 'measureThreshold', 0, -1, 1),
      });
    }
    if (broken) continue;
    list.push({ combination: r.vocab(conditionsEl, 'conditionCombination', ['all', 'any'] as const, 'all'), conditions, action });
  }
  return { pre, exit, post };
}

function readRollup(parts: SequencingParts, r: Reader) {
  const el = parts.get('rollupRules');
  const rules: RollupRule[] = [];
  for (const ruleEl of children(el, 'rollupRule')) {
    if (rules.length >= MAX_RULES_PER_KIND) {
      r.dropped(`it has more than ${MAX_RULES_PER_KIND} rollup rules, so the rest are ignored.`);
      break;
    }
    const actionName = attr(child(ruleEl, 'rollupAction'), 'action') ?? '';
    const action = ROLLUP_ACTIONS.find((a) => a.toLowerCase() === actionName.toLowerCase());
    if (!action) {
      r.dropped(`a rollup rule has the action "${actionName.slice(0, 40)}", which isn't a rollup action, so the rule is ignored.`);
      continue;
    }
    const conditionsEl = child(ruleEl, 'rollupConditions');
    const conditionEls = children(conditionsEl, 'rollupCondition');
    if (conditionEls.length > MAX_RULE_CONDITIONS) {
      r.dropped(`a rollup rule has more than ${MAX_RULE_CONDITIONS} conditions, so the rule is ignored.`);
      continue;
    }
    const conditions: RollupRule['conditions'] = [];
    let broken = false;
    for (const c of conditionEls) {
      const name = attr(c, 'condition') ?? '';
      const condition = ROLLUP_CONDITIONS.find((x) => x.toLowerCase() === name.toLowerCase());
      if (!condition) {
        r.dropped(`a rollup condition "${name.slice(0, 40)}" isn't a SCORM rollup condition, so the rule is ignored.`);
        broken = true;
        break;
      }
      conditions.push({ condition, not: r.vocab(c, 'operator', ['noOp', 'not'] as const, 'noOp') === 'not' });
    }
    if (broken) continue;
    rules.push({
      childActivitySet: r.vocab(ruleEl, 'childActivitySet', CHILD_SETS, 'all'),
      minimumCount: r.integer(ruleEl, 'minimumCount') ?? 0,
      minimumPercent: r.decimal(ruleEl, 'minimumPercent', 0, 0, 1),
      combination: r.vocab(conditionsEl, 'conditionCombination', ['all', 'any'] as const, 'any'),
      conditions,
      action,
    });
  }
  return {
    rules,
    rollupObjectiveSatisfied: r.bool(el, 'rollupObjectiveSatisfied', true),
    rollupProgressCompletion: r.bool(el, 'rollupProgressCompletion', true),
    objectiveMeasureWeight: r.decimal(el, 'objectiveMeasureWeight', 1, 0, 1),
  };
}

const emptyMap = (target: string): ObjectiveMap => ({
  target,
  readSatisfied: false,
  readMeasure: false,
  writeSatisfied: false,
  writeMeasure: false,
  readRaw: false,
  readMin: false,
  readMax: false,
  readCompletion: false,
  readProgress: false,
  writeRaw: false,
  writeMin: false,
  writeMax: false,
  writeCompletion: false,
  writeProgress: false,
});

function readObjectives(parts: SequencingParts, r: Reader): ObjectiveDef[] {
  const el = parts.get('objectives');
  const tooMany = (id: string | null) =>
    r.dropped(`the objective "${(id ?? 'primary').slice(0, 80)}" has more than ${MAX_MAPS} objective maps, so the rest are ignored.`);
  const objective = (o: Element | null, primary: boolean): ObjectiveDef => {
    const satisfiedByMeasure = r.bool(o, 'satisfiedByMeasure', false);
    const minText = textOf(child(o, 'minNormalizedMeasure'));
    const maps: ObjectiveMap[] = [];
    for (const m of children(o, 'mapInfo')) {
      const target = attr(m, 'targetObjectiveID');
      if (!target) {
        r.dropped('an objective map has no targetObjectiveID, so it is ignored.');
        continue;
      }
      if (maps.length >= MAX_MAPS) {
        tooMany(attr(o, 'objectiveID'));
        break;
      }
      maps.push({
        ...emptyMap(target),
        readSatisfied: r.bool(m, 'readSatisfiedStatus', true),
        readMeasure: r.bool(m, 'readNormalizedMeasure', true),
        writeSatisfied: r.bool(m, 'writeSatisfiedStatus', false),
        writeMeasure: r.bool(m, 'writeNormalizedMeasure', false),
      });
    }
    return {
      id: attr(o, 'objectiveID') || null,
      primary,
      satisfiedByMeasure,
      minNormalizedMeasure: minText ? r.decimalValue(minText, 'minNormalizedMeasure', 1, -1, 1) : 1,
      maps,
    };
  };
  const primaryEl = child(el, 'primaryObjective');
  if (el && !primaryEl) r.dropped('its objectives have no primaryObjective, so a default one is used.');
  const list: ObjectiveDef[] = [objective(primaryEl, true)];
  const byId = new Map<string, ObjectiveDef>(list[0]!.id ? [[list[0]!.id, list[0]!]] : []);
  for (const o of children(el, 'objective')) {
    const def = objective(o, false);
    if (!def.id) {
      r.dropped('an objective has no objectiveID, so it is ignored.');
      continue;
    }
    if (byId.has(def.id)) {
      r.dropped(`the objective "${def.id.slice(0, 80)}" is listed twice, so the second one is ignored.`);
      continue;
    }
    byId.set(def.id, def);
    list.push(def);
  }
  // adlseq:objectives (4th edition): score, completion and progress measure maps for the same objectives.
  const mapsOf = new Map<ObjectiveDef, Map<string, ObjectiveMap>>();
  for (const o of children(parts.get('adlseq:objectives'), 'objective')) {
    const id = attr(o, 'objectiveID');
    const target = id === null ? undefined : byId.get(id);
    if (!target) {
      r.dropped(`the ADL objective "${(id ?? '').slice(0, 80)}" doesn't match any of its objectives, so it is ignored.`);
      continue;
    }
    let byTarget = mapsOf.get(target);
    if (!byTarget) {
      byTarget = new Map();
      // The first map to each global objective (as a lookup by target would find).
      for (const m of target.maps) if (!byTarget.has(m.target)) byTarget.set(m.target, m);
      mapsOf.set(target, byTarget);
    }
    for (const m of children(o, 'mapInfo')) {
      const targetId = attr(m, 'targetObjectiveID');
      if (!targetId) {
        r.dropped('an ADL objective map has no targetObjectiveID, so it is ignored.');
        continue;
      }
      let map = byTarget.get(targetId);
      if (!map) {
        if (target.maps.length >= MAX_MAPS) {
          tooMany(target.id);
          break;
        }
        target.maps.push((map = emptyMap(targetId)));
        byTarget.set(targetId, map);
      }
      map.readRaw = r.bool(m, 'readRawScore', true);
      map.readMin = r.bool(m, 'readMinScore', true);
      map.readMax = r.bool(m, 'readMaxScore', true);
      map.readCompletion = r.bool(m, 'readCompletionStatus', true);
      map.readProgress = r.bool(m, 'readProgressMeasure', true);
      map.writeRaw = r.bool(m, 'writeRawScore', false);
      map.writeMin = r.bool(m, 'writeMinScore', false);
      map.writeMax = r.bool(m, 'writeMaxScore', false);
      map.writeCompletion = r.bool(m, 'writeCompletionStatus', false);
      map.writeProgress = r.bool(m, 'writeProgressMeasure', false);
    }
  }
  return list;
}

interface Base {
  id: string;
  title: string;
  parent: number;
  depth: number;
  launchable: boolean;
  sco: boolean;
  visible: boolean;
}

function readActivity(base: Base, item: Element | null, seq: Element | null, collection: Map<string, Element>, warn: Warn): ActivityDef {
  const r = new Reader(`"${base.title.slice(0, 60)}"`, warn);
  const parts = sequencingParts(seq, collection, r);
  const control = parts.get('controlMode');
  const limits = parts.get('limitConditions');
  const random = parts.get('randomizationControls');
  const delivery = parts.get('deliveryControls');
  const constrained = parts.get('constrainedChoiceConsiderations');
  const considerations = parts.get('rollupConsiderations');
  const rules = readRules(parts, r);
  const rollup = readRollup(parts, r);
  const threshold = child(item, 'completionThreshold');
  const completedByMeasure = r.bool(threshold, 'completedByMeasure', false);
  const hide: LmsControl[] = [];
  for (const h of children(child(child(item, 'presentation'), 'navigationInterface'), 'hideLMSUI')) {
    const value = textOf(h);
    const control2 = LMS_CONTROLS.find((x) => x.toLowerCase() === value.toLowerCase());
    if (control2) {
      if (!hide.includes(control2)) hide.push(control2);
    } else r.dropped(`hideLMSUI "${value.slice(0, 40)}" isn't a navigation control, so it is ignored.`);
  }
  const dataMaps: ActivityDef['dataMaps'] = [];
  const dataTargets = new Set<string>();
  for (const m of children(child(item, 'data'), 'map')) {
    const target = attr(m, 'targetID');
    if (!target) {
      r.dropped('a shared data map has no targetID, so it is ignored.');
      continue;
    }
    if (dataTargets.has(target)) continue;
    if (dataMaps.length >= MAX_MAPS) {
      r.dropped(`it has more than ${MAX_MAPS} shared data maps, so the rest are ignored.`);
      break;
    }
    dataTargets.add(target);
    dataMaps.push({ target, read: r.bool(m, 'readSharedData', true), write: r.bool(m, 'writeSharedData', false) });
  }
  const attemptLimit = r.integer(limits, 'attemptLimit');
  const durationText = attr(limits, 'attemptAbsoluteDurationLimit');
  let attemptDurationLimit: number | null = null;
  if (durationText) {
    attemptDurationLimit = durationSeconds(durationText);
    if (attemptDurationLimit === null)
      r.dropped(`attemptAbsoluteDurationLimit "${durationText.slice(0, 40)}" isn't a duration, so it is ignored.`);
  }
  const selectCount = r.integer(random, 'selectCount');
  return {
    ...base,
    children: [],
    choice: r.bool(control, 'choice', true),
    choiceExit: r.bool(control, 'choiceExit', true),
    flow: r.bool(control, 'flow', false),
    forwardOnly: r.bool(control, 'forwardOnly', false),
    useCurrentAttemptObjectiveInfo: r.bool(control, 'useCurrentAttemptObjectiveInfo', true),
    useCurrentAttemptProgressInfo: r.bool(control, 'useCurrentAttemptProgressInfo', true),
    preRules: rules.pre,
    exitRules: rules.exit,
    postRules: rules.post,
    // An attempt limit of 0 means no limit.
    attemptLimit: attemptLimit ? attemptLimit : null,
    attemptDurationLimit: attemptDurationLimit || null,
    rollupRules: rollup.rules,
    rollupObjectiveSatisfied: rollup.rollupObjectiveSatisfied,
    rollupProgressCompletion: rollup.rollupProgressCompletion,
    objectiveMeasureWeight: rollup.objectiveMeasureWeight,
    objectives: readObjectives(parts, r),
    selectionTiming: r.vocab(random, 'selectionTiming', TIMINGS, 'never'),
    selectCount,
    randomizationTiming: r.vocab(random, 'randomizationTiming', TIMINGS, 'never'),
    reorderChildren: r.bool(random, 'reorderChildren', false),
    tracked: r.bool(delivery, 'tracked', true),
    completionSetByContent: r.bool(delivery, 'completionSetByContent', false),
    objectiveSetByContent: r.bool(delivery, 'objectiveSetByContent', false),
    preventActivation: r.bool(constrained, 'preventActivation', false),
    constrainChoice: r.bool(constrained, 'constrainChoice', false),
    requiredForSatisfied: r.vocab(considerations, 'requiredForSatisfied', REQUIRED_FOR, 'always'),
    requiredForNotSatisfied: r.vocab(considerations, 'requiredForNotSatisfied', REQUIRED_FOR, 'always'),
    requiredForCompleted: r.vocab(considerations, 'requiredForCompleted', REQUIRED_FOR, 'always'),
    requiredForIncomplete: r.vocab(considerations, 'requiredForIncomplete', REQUIRED_FOR, 'always'),
    measureSatisfactionIfActive: r.bool(considerations, 'measureSatisfactionIfActive', true),
    completedByMeasure,
    minProgressMeasure: r.decimal(threshold, 'minProgressMeasure', 1, 0, 1),
    progressWeight: r.decimal(threshold, 'progressWeight', 1, 0, 1),
    hideLmsUi: hide,
    dataMaps,
  };
}

/**
 * Builds the activity tree of the default organization: the root (the organization itself) and one
 * activity per item, in manifest order. `nodes` are the organization's items in preorder.
 */
export function readSequencingTree(
  manifest: Element | null,
  organization: Element | null,
  rootId: string,
  rootTitle: string,
  nodes: SequencingNode[],
  warn: Warn,
): SequencingTree {
  const collection = new Map<string, Element>();
  for (const c of children(manifest, 'sequencingCollection')) {
    for (const s of children(c, 'sequencing')) {
      const id = attr(s, 'ID');
      if (id && !collection.has(id)) collection.set(id, s);
    }
  }
  const sequencingOf = (el: Element | null) => {
    const list = children(el, 'sequencing');
    if (list.length > 1) warn(`"${rootTitle.slice(0, 60)}": an item has more than one sequencing element; the first is used.`);
    return list[0] ?? null;
  };
  const root = readActivity(
    { id: rootId, title: rootTitle, parent: -1, depth: -1, launchable: false, sco: false, visible: true },
    null,
    sequencingOf(organization),
    collection,
    warn,
  );
  const activities: ActivityDef[] = [root];
  for (const node of nodes) {
    const def = readActivity(
      {
        id: node.id,
        title: node.title,
        parent: node.parent + 1,
        depth: node.depth,
        launchable: node.launchable,
        sco: node.sco,
        visible: node.visible,
      },
      node.el,
      sequencingOf(node.el),
      collection,
      warn,
    );
    activities.push(def);
    activities[def.parent]!.children.push(activities.length - 1);
  }
  for (const [i, a] of activities.entries()) {
    const who = `"${a.title.slice(0, 60)}"`;
    if (a.children.length === 0 && !a.launchable && i !== 0) warn(`${who} has no content and no parts, so it can't be opened.`);
    if (a.children.length > 0) {
      // Rules about the children only make sense for clusters; leaves keep their own completion rules.
      if (a.selectCount !== null && a.selectCount > a.children.length) {
        warn(`${who} selects ${a.selectCount} parts but has ${a.children.length}, so all of them are used.`);
        a.selectCount = a.children.length;
      }
    }
    const objectiveIds = new Set(a.objectives.map((o) => o.id));
    for (const rule of [...a.preRules, ...a.exitRules, ...a.postRules]) {
      for (const c of rule.conditions) {
        if (c.objective !== null && !objectiveIds.has(c.objective)) {
          warn(
            `${who} has a rule about the objective "${c.objective.slice(0, 80)}", which it doesn't define, so that condition is unknown.`,
          );
        }
      }
    }
  }
  return {
    activities,
    objectivesGlobalToSystem: new Reader(`"${rootTitle.slice(0, 60)}"`, warn).bool(organization, 'objectivesGlobalToSystem', true),
    sharedDataGlobalToSystem: new Reader(`"${rootTitle.slice(0, 60)}"`, warn).bool(organization, 'sharedDataGlobalToSystem', true),
  };
}

/** How much a tree defines, for the package-wide limits. */
export function sequencingSize(tree: SequencingTree) {
  let rules = 0;
  let conditions = 0;
  let maps = 0;
  let objectives = 0;
  for (const a of tree.activities) {
    for (const rule of [...a.preRules, ...a.exitRules, ...a.postRules, ...a.rollupRules]) {
      rules++;
      conditions += rule.conditions.length;
    }
    objectives += a.objectives.length;
    for (const o of a.objectives) maps += o.maps.length;
    maps += a.dataMaps.length;
  }
  return { rules, conditions, maps, objectives };
}

/** The tree for SCORM 2004 content with no sequencing information (or when the manifest can't be read again). */
export function defaultSequencingTree(rootTitle: string, items: Array<Omit<Base, 'parent'> & { parentId: string | null }>): SequencingTree {
  const nodes: SequencingNode[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const parent = item.parentId === null ? -1 : (index.get(item.parentId) ?? -1);
    index.set(item.id, nodes.length);
    nodes.push({ el: null as unknown as Element, ...item, parent });
  }
  return readSequencingTree(null, null, '__root', rootTitle, nodes, () => {});
}
