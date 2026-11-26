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
  /** Launchable item ids and the index of this one, for adl.nav.request_valid. */
  nav?: { items: string[]; index: number };
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
