/**
 * What a cmi5 registration (a package attempt) adds up to: which AUs, blocks and the course are satisfied
 * (section 13.1.4: an AU by its moveOn criteria, a block when all its children are, the course when all of
 * its children are), the statuses shown in the table of contents and the attempt's status, score and time.
 */
import type { Cmi5Status } from '../../../shared/cmi5.js';
import type { PackageCompletionStatus, PackageSuccessStatus } from '../../../shared/packages.js';
import type { Cmi5AuStateRow } from '../../db/schema-cmi5.js';
import type { DB } from '../../db/types.js';
import { allAus, type Cmi5Au, type Cmi5Block, type Cmi5Course, type Cmi5Node } from './structure.js';

export type AuStates = Map<string, Cmi5AuStateRow>;

export async function loadAuStates(db: DB, attemptId: string): Promise<AuStates> {
  const rows = await db.selectFrom('cmi5AuStates').selectAll().where('attemptId', '=', attemptId).execute();
  return new Map(rows.map((r) => [r.auKey, r]));
}

/** The AU's moveOn criteria are met (NotApplicable AUs always are). */
export function auSatisfied(au: Cmi5Au, state: Cmi5AuStateRow | undefined): boolean {
  const completed = !!state?.completedAt;
  const passed = !!state?.passedAt;
  switch (au.moveOn) {
    case 'Passed':
      return passed;
    case 'Completed':
      return completed;
    case 'CompletedAndPassed':
      return completed && passed;
    case 'CompletedOrPassed':
      return completed || passed;
    default:
      return true;
  }
}

/**
 * The AU has nothing left to record in the registration, so opening it again is a review: it met its moveOn
 * criteria and, when it has a mastery score, it was passed (a failed AU can be tried again).
 */
export function auFinished(au: Cmi5Au, state: Cmi5AuStateRow | undefined): boolean {
  const completed = !!state?.completedAt;
  const needsCompletion = au.moveOn === 'Completed' || au.moveOn === 'CompletedAndPassed';
  if (state?.passedAt) return !needsCompletion || completed;
  if (au.masteryScore !== null) return false;
  if (au.moveOn === 'NotApplicable') return completed;
  return auSatisfied(au, state);
}

export function nodeSatisfied(node: Cmi5Node, states: AuStates): boolean {
  if (node.type === 'au') return auSatisfied(node, states.get(node.key));
  return node.children.every((child) => nodeSatisfied(child, states));
}

export const courseSatisfied = (course: Cmi5Course, states: AuStates) => course.children.every((n) => nodeSatisfied(n, states));

/** Satisfied blocks (inner blocks first) and then the course, if satisfied: the order of the "satisfied" statements. */
export function satisfiedParts(course: Cmi5Course, states: AuStates): Array<{ kind: 'block'; block: Cmi5Block } | { kind: 'course' }> {
  const out: Array<{ kind: 'block'; block: Cmi5Block } | { kind: 'course' }> = [];
  const walk = (nodes: Cmi5Node[]) => {
    for (const n of nodes) {
      if (n.type !== 'block') continue;
      walk(n.children);
      if (nodeSatisfied(n, states)) out.push({ kind: 'block', block: n });
    }
  };
  walk(course.children);
  if (courseSatisfied(course, states)) out.push({ kind: 'course' });
  return out;
}

const launched = (state: Cmi5AuStateRow | undefined) => !!state && (state.sessions > 0 || !!state.firstLaunchedAt);

export function auStatus(au: Cmi5Au, state: Cmi5AuStateRow | undefined): Cmi5Status {
  if (state?.passedAt) return 'passed';
  if (state?.failedAt) return 'failed';
  if (state?.completedAt) return 'completed';
  if (au.moveOn === 'NotApplicable') return 'satisfied';
  return launched(state) ? 'in progress' : 'not attempted';
}

export function blockStatus(block: Cmi5Block, states: AuStates): Cmi5Status {
  if (nodeSatisfied(block, states)) return 'satisfied';
  const touched = (nodes: Cmi5Node[]): boolean => nodes.some((n) => (n.type === 'au' ? launched(states.get(n.key)) : touched(n.children)));
  return touched(block.children) ? 'in progress' : 'not attempted';
}

/** Scaled 0..1 score of an AU's latest passed or failed result. */
export const auScore = (state: Cmi5AuStateRow | undefined) =>
  state?.score === null || state?.score === undefined ? null : Math.min(1, Math.max(0, state.score));

export interface Cmi5AttemptResult {
  completion: PackageCompletionStatus;
  success: PackageSuccessStatus;
  /** Average of the AUs' scaled scores (0..1), or null when no AU reported one. */
  score: number | null;
  seconds: number;
  /** The course is satisfied: the attempt is finished. */
  finished: boolean;
}

/** The attempt's status, score and time, from what its registration recorded (used by refreshAttempt). */
export async function cmi5AttemptResult(db: DB, attemptId: string, course: Cmi5Course): Promise<Cmi5AttemptResult> {
  const states = await loadAuStates(db, attemptId);
  const aus = allAus(course.children);
  const satisfied = courseSatisfied(course, states);
  const anyLaunched = aus.some((au) => launched(states.get(au.key)));
  const failed = aus.some((au) => {
    const s = states.get(au.key);
    return !!s?.failedAt && !s.passedAt;
  });
  // A pass needs the course satisfied and every AU with a mastery score passed.
  const passed = satisfied && aus.every((au) => au.masteryScore === null || !!states.get(au.key)?.passedAt);
  const scores = aus.map((au) => auScore(states.get(au.key))).filter((s): s is number => s !== null);
  const seconds = [...states.values()].reduce((sum, s) => sum + s.totalSeconds, 0);
  return {
    completion: satisfied ? 'completed' : anyLaunched ? 'incomplete' : 'not attempted',
    success: failed ? 'failed' : passed ? 'passed' : 'unknown',
    score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    seconds,
    finished: satisfied,
  };
}
