/** Creating, storing and copying the sequencing tracking state of one attempt. */
import type { ActivityState, SequencingState, SequencingTree } from './types.js';

/** Most bytes the stored sequencing state of one attempt may take. */
export const MAX_SEQUENCING_STATE_BYTES = 4 * 1024 * 1024;
/** Most characters all the shared data stores (adl.data) of one attempt may hold together. */
export const MAX_SHARED_DATA_CHARS = 512 * 1024;
/** Most objectives a package may define over all its activities (they make up most of the state). */
export const MAX_OBJECTIVES = 10_000;

export class SequencingStateTooLarge extends Error {
  readonly status = 413;
  constructor() {
    super('This attempt has too much data to save.');
  }
}

/** A fresh state: nothing attempted. Selection and randomization are applied by the engine (Sequencer.prepare). */
export function emptyState(tree: SequencingTree, seed: number): SequencingState {
  return {
    v: 1,
    current: null,
    suspended: null,
    activities: tree.activities.map(() => ({})),
    globals: {},
    data: {},
    clock: 0,
    deliveries: 0,
    rng: seed >>> 0 || 1,
  };
}

/** Drops false flags and empty lists so the stored JSON stays small (absent means false/unknown). */
function compact(key: string, value: unknown) {
  if (value === false) return undefined;
  if (key === 'objectives' && Array.isArray(value) && value.every((o) => !o || Object.keys(o).length === 0)) return undefined;
  return value;
}

export function serializeState(state: SequencingState): string {
  const text = JSON.stringify(state, compact);
  if (text.length > MAX_SEQUENCING_STATE_BYTES) throw new SequencingStateTooLarge();
  return text;
}

export function parseState(text: string, tree: SequencingTree): SequencingState | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const s = data as Partial<SequencingState> | null;
  if (!s || s.v !== 1 || !Array.isArray(s.activities) || s.activities.length !== tree.activities.length) return null;
  const n = tree.activities.length;
  const index = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : null);
  return {
    v: 1,
    current: index(s.current),
    suspended: index(s.suspended),
    activities: s.activities.map((a) => (a && typeof a === 'object' ? (a as ActivityState) : {})),
    globals: s.globals && typeof s.globals === 'object' ? s.globals : {},
    data: s.data && typeof s.data === 'object' ? s.data : {},
    clock: typeof s.clock === 'number' ? s.clock : 0,
    deliveries: typeof s.deliveries === 'number' ? s.deliveries : 0,
    rng: typeof s.rng === 'number' ? s.rng : 1,
    ...(s.ended ? { ended: true } : {}),
  };
}

export function cloneState(state: SequencingState): SequencingState {
  return structuredClone(state);
}

/**
 * Global objectives and shared data stores are keyed by identifiers from the manifest. They are only
 * ever read and written as own properties, so an identifier such as "__proto__" or "constructor" is a
 * store like any other and never reaches Object.prototype (or any other shared object).
 */
export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
export function setOwnValue<T>(record: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

/** mulberry32: a small seeded PRNG, so selection and randomization are reproducible from the stored state. */
export function nextRandom(state: SequencingState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
