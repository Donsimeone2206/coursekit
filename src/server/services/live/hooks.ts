/** What the shared activity routes call for live classes (routes/activities.ts). */
import type { ActivityRow } from '../../db/schema.js';
import { evaluateLiveCompletion } from './attendance.js';
import type { LiveDeps } from './providers.js';
import { liveWorkerFor } from './worker.js';

export { publicLiveSettings } from './activity.js';

/** A teacher saved a live class: completion follows the new settings, and provider meetings follow the changes. */
export async function liveActivityUpdated(deps: LiveDeps, activity: ActivityRow): Promise<void> {
  await evaluateLiveCompletion(deps, activity);
  liveWorkerFor(deps.events)?.kick();
}
