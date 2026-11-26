/**
 * Tables for cmi5 courses played by package activities (migration 013_cmi5).
 * Same conventions as schema.ts: 0/1 booleans, ISO-8601 strings and JSON stored as text.
 * A cmi5 registration is a package attempt (package_attempts.registration).
 */
import type { Selectable } from 'kysely';
import type { Cmi5LaunchMethod, Cmi5LaunchMode, Cmi5MoveOn } from '../../shared/cmi5.js';

/** One launch of an AU (a cmi5 session): from the LMS "launched" statement to terminated or abandoned. */
export interface Cmi5SessionsTable {
  /** The session id (a lower-case UUID), sent in the sessionid context extension. */
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  versionId: string;
  /** Null for staff previews, which record nothing. */
  attemptId: string | null;
  registration: string;
  /** Key of the AU in the package structure. */
  auKey: string;
  /** The AU's id from the course structure (the publisher id). */
  auId: string;
  /** The activity id Coursekit generated for the AU, which statements about the AU use. */
  auLmsId: string;
  /** The site origin the actor and the generated ids use. */
  homePage: string;
  launchMode: Cmi5LaunchMode;
  launchMethod: Cmi5LaunchMethod;
  moveOn: Cmi5MoveOn;
  masteryScore: number | null;
  /** The launch URL without the cmi5 launch parameters. */
  launchUrl: string;
  /** When the fetch URL handed out the credentials (it works once). */
  fetchedAt: string | null;
  /** When the AU read the cmi5LearnerPreferences agent profile: statements are refused before (section 11.0). */
  preferencesReadAt: string | null;
  launchedAt: string;
  initializedAt: string | null;
  terminatedAt: string | null;
  abandonedAt: string | null;
  /** Last request made with the session's credentials (or the launch). */
  lastActivityAt: string;
  /** 1 once a completed statement was accepted in this session. */
  completed: number;
  /** The passed or failed statement accepted in this session. */
  resultVerb: 'passed' | 'failed' | null;
  /** Seconds the session lasted (terminated duration, or the abandoned duration). */
  durationSeconds: number;
}

/** What one registration recorded for one AU. */
export interface Cmi5AuStatesTable {
  attemptId: string;
  auKey: string;
  completedAt: string | null;
  passedAt: string | null;
  failedAt: string | null;
  /** Scaled score (0..1) of the latest passed or failed statement, or null. */
  score: number | null;
  sessions: number;
  totalSeconds: number;
  firstLaunchedAt: string | null;
  lastLaunchedAt: string | null;
  updatedAt: string;
}

/** Blocks and the course a registration satisfied (one "satisfied" statement each). */
export interface Cmi5SatisfiedTable {
  attemptId: string;
  /** Key of the block, or '' for the course. */
  nodeKey: string;
  kind: 'block' | 'course';
  sessionId: string;
  statementId: string;
  satisfiedAt: string;
}

export type Cmi5SessionRow = Selectable<Cmi5SessionsTable>;
export type Cmi5AuStateRow = Selectable<Cmi5AuStatesTable>;
export type Cmi5SatisfiedRow = Selectable<Cmi5SatisfiedTable>;
