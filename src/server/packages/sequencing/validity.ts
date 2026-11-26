/**
 * Navigation request validity: whether continue, previous, choice and jump (for every activity) would
 * succeed now, for adl.nav.request_valid and for the player's buttons and table of contents. Each
 * request is run through the Navigation Request Process, the termination it implies (once, on a copy
 * of the state) and the sequencing and delivery request processes, without changing the stored state.
 */
import { Sequencer, type SequencingRequest } from './engine.js';
import { cloneState } from './state.js';
import { ROOT, type SequencingState, type SequencingTree } from './types.js';

export interface NavValidity {
  continue: boolean;
  previous: boolean;
  exit: boolean;
  exitAll: boolean;
  suspendAll: boolean;
  abandon: boolean;
  abandonAll: boolean;
  /** Activities a choice request may target. */
  choice: Set<number>;
  /** Activities a jump request may target. */
  jump: Set<number>;
}

export interface ValidityOptions {
  /** Work out jump targets too (jump is a 4th edition request: false for 2nd and 3rd edition packages). */
  jump?: boolean;
}

export function navValidity(
  tree: SequencingTree,
  state: SequencingState,
  now = Date.now(),
  { jump = true }: ValidityOptions = {},
): NavValidity {
  const base = new Sequencer(tree, state, now, true);
  const out: NavValidity = {
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
  for (const request of ['exit', 'exitAll', 'suspendAll', 'abandon', 'abandonAll'] as const) {
    out[request] = !base.navigationRequest(request).exception;
  }
  // Every other request first ends the current activity's attempt (when it is active): do that once, on a copy.
  const after = cloneState(state);
  const sim = new Sequencer(tree, after, now, true);
  const cur = state.current;
  let override: SequencingRequest | undefined;
  if (cur !== null && state.activities[cur]?.active) {
    const t = sim.terminationRequest('exit');
    if (t.exception) return out;
    // A post-condition rule (or an exit back to the root) replaces whatever the learner asked for.
    override = t.sequencing;
  }
  // From here on the copy doesn't change from request to request: each rule (and each flow) is worked out once.
  sim.memoize();
  const succeeds = (request: SequencingRequest, target: number | null): boolean => {
    const r = sim.sequencingRequest(override ?? request, override ? null : target);
    if (r.exception) return false;
    // Continuing past the end of the course ends the attempt: a request that succeeds.
    if (r.endSession) return request === 'continue';
    if (r.delivery === undefined) return false;
    return sim.deliveryRequest(r.delivery) === null;
  };
  out.continue = !base.navigationRequest('continue').exception && succeeds('continue', null);
  out.previous = !base.navigationRequest('previous').exception && succeeds('previous', null);
  for (let a = 0; a < tree.activities.length; a++) {
    if (!base.navigationRequest('choice', a).exception && succeeds('choice', a)) out.choice.add(a);
    if (jump && !base.navigationRequest('jump', a).exception && succeeds('jump', a)) out.jump.add(a);
  }
  return out;
}

/** Hidden from choice by a rule on the activity or one of its ancestors. */
export function hiddenFromChoice(seq: Sequencer, a: number): boolean {
  for (let x = a; x >= 0; x = seq.parent(x)) if (x !== ROOT && seq.isHiddenFromChoice(x)) return true;
  return false;
}
