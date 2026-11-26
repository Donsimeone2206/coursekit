/** API shapes for cmi5 courses, played by the package activity (PackageKind 'cmi5'). */
import type { PackageAttemptInfo, PackageLaunch } from './packages.js';
import type { PublicUser } from './types.js';

export type Cmi5MoveOn = 'NotApplicable' | 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed';
export type Cmi5LaunchMethod = 'AnyWindow' | 'OwnWindow';
export type Cmi5LaunchMode = 'Normal' | 'Browse' | 'Review';

/**
 * Where a learner stands with an AU (assignable unit) or a block within one registration (attempt).
 * Blocks and the course are only 'satisfied', 'in progress' or 'not attempted'.
 */
export type Cmi5Status = 'not attempted' | 'in progress' | 'completed' | 'passed' | 'failed' | 'satisfied';

export const CMI5_STATUS_LABELS: Record<Cmi5Status, string> = {
  'not attempted': 'Not started',
  'in progress': 'In progress',
  completed: 'Completed',
  passed: 'Passed',
  failed: 'Failed',
  satisfied: 'Satisfied',
};

/** What a learner has to do for an AU to count (its moveOn criteria). */
export const CMI5_MOVE_ON_LABELS: Record<Cmi5MoveOn, string> = {
  NotApplicable: 'Optional',
  Passed: 'Pass it to finish',
  Completed: 'Complete it to finish',
  CompletedAndPassed: 'Complete and pass it to finish',
  CompletedOrPassed: 'Complete or pass it to finish',
};

/** One row of the course structure: a block (heading) or an AU, depth-first. */
export interface Cmi5TocNode {
  kind: 'block' | 'au';
  /** Stable key of the block or AU within the package (used as itemId when launching). */
  key: string;
  title: string;
  description: string;
  depth: number;
  status: Cmi5Status;
  /** The moveOn criteria are met (always false outside an attempt). */
  satisfied: boolean;
  /** AU only: the score of its latest passed or failed result, in percent. */
  score: number | null;
  /** AU only. */
  moveOn: Cmi5MoveOn | null;
  /** AU only: the scaled score (0..1) needed to pass. */
  masteryScore: number | null;
  /** AU only. */
  launchMethod: Cmi5LaunchMethod | null;
  /** AU only: hosted on another website (not inside the uploaded package). */
  external: boolean;
  /**
   * AU only: opening it now is a review that records nothing that counts (the learner finished the AU, or the
   * course is archived). In a finished attempt, the AUs the learner hasn't finished still record results.
   */
  review: boolean;
}

export interface Cmi5Info {
  activityId: string;
  /** The attempt the statuses belong to: the unfinished one, else the latest one (learners only). */
  attemptId: string | null;
  attemptNumber: number | null;
  attemptStatus: 'in_progress' | 'finished' | null;
  /** The package version the structure comes from. */
  version: number;
  course: { title: string; description: string; satisfied: boolean };
  nodes: Cmi5TocNode[];
}

export interface Cmi5LaunchInfo {
  launchMode: Cmi5LaunchMode;
  launchMethod: Cmi5LaunchMethod;
  /**
   * The AU is hosted on another website. It is framed with its own origin (never Coursekit's), or opened in a
   * new window; packaged AUs are served sandboxed from Coursekit like other package content.
   */
  external: boolean;
  /** The cmi5 session id of this launch. */
  sessionId: string;
}

/** What POST /api/packages/:activityId/cmi5/launch (and the generic launch) returns for a cmi5 package. */
export interface Cmi5Launch extends PackageLaunch {
  cmi5: Cmi5LaunchInfo;
}

export interface Cmi5AuProgress {
  status: Cmi5Status;
  /** Percent, or null. */
  score: number | null;
}

export interface Cmi5ReportAttempt extends PackageAttemptInfo {
  /** The cmi5 course is satisfied in this registration. */
  satisfied: boolean;
  aus: Record<string, Cmi5AuProgress>;
}

export interface Cmi5ReportRow {
  user: PublicUser & { email: string };
  attempts: Cmi5ReportAttempt[];
  /** The gradebook score (points), or null. */
  grade: number | null;
  completed: boolean;
}

export interface Cmi5Report {
  maxGrade: number | null;
  /** The AUs of the current package version, in course order. */
  aus: Array<{ key: string; title: string }>;
  rows: Cmi5ReportRow[];
}
