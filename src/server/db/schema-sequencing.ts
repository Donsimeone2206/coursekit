/** SCORM 2004 sequencing state per package attempt (migration 012_scorm_sequencing). */
import type { Selectable } from 'kysely';

export interface PackageSequencingStatesTable {
  attemptId: string;
  /** JSON SequencingState: the activity tree's tracking information for the attempt. */
  state: string;
  /** Incremented on every save (optimistic concurrency). */
  revision: number;
  updatedAt: string;
}

export type PackageSequencingStateRow = Selectable<PackageSequencingStatesTable>;
