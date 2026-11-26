/** Typed access to the SCORM run-time in runtime-source.ts, for the server and for serving it to browsers. */
import { packageRuntime } from './runtime-source.js';

export type ScormVersion = '1.2' | '2004';

export interface RuntimeModel {
  get(element: string): { value: string; error: string };
  /** Returns an error kind ('' when the value was stored). */
  set(element: string, value: unknown): string;
  values: Record<string, string>;
  counts: Record<string, number>;
  changes(): Array<[string, string]>;
}

export interface ModelInit {
  values?: Record<string, string>;
  counts?: Record<string, number>;
  /** Read-only values Coursekit supplies (learner id and name, entry, credit, mode, total time...). */
  lms?: Record<string, string>;
  /**
   * Launchable item ids and the index of this one, for adl.nav.request_valid. `valid` (SCORM 2004
   * sequencing) holds what the server worked out instead; null means unknown.
   */
  nav?: {
    items: string[];
    index: number;
    valid?: { continue: boolean | null; previous: boolean | null; choice: Record<string, boolean>; jump: Record<string, boolean> };
  };
  /** SCORM 2004 4th edition shared data (adl.data): each store the activity maps, its permissions and value. */
  data?: Array<{ id: string; read: boolean; write: boolean; value?: string }>;
  /** SCORM 2004 edition ('2nd', '3rd' or '4th'). Before the 4th, adl.nav.request has no jump. */
  edition?: string | null;
  /** Most bytes the stored values may take. */
  maxBytes?: number;
}

/** What the browser run-time gets embedded. */
export interface RuntimeBoot extends ModelInit {
  version: ScormVersion | 'xapi';
  /** Where commits go; null for previews (nothing is recorded anyway). */
  commitUrl: string | null;
  /** Identifies this page load, so the server can ignore stale commits. */
  sid: string;
  item: string;
  /** The Coursekit origin, for postMessage. */
  origin: string;
}

interface ServerRuntime {
  createModel(version: ScormVersion, init: ModelInit): RuntimeModel;
  codes: Record<ScormVersion, Record<string, string>>;
}

const server = (packageRuntime as unknown as (win: null, boot: null) => ServerRuntime)(null, null);
const SOURCE = packageRuntime.toString();

export function createModel(version: ScormVersion, init: ModelInit = {}): RuntimeModel {
  return server.createModel(version, init);
}

/** The SCORM error code a model error kind maps to. */
export function errorCode(version: ScormVersion, kind: string): string {
  return kind ? (server.codes[version][kind] ?? kind) : '0';
}

/** The script served as /__coursekit/runtime.js. */
export function runtimeScript(boot: RuntimeBoot): string {
  return `/* Coursekit package run-time */\n(${SOURCE})(window, ${JSON.stringify(boot)});\n`;
}
