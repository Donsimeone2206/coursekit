/** API shapes for SCORM and xAPI package activities. */
import type { PackageNavRequest, PackageSequencingInfo } from './package-sequencing.js';
import type { PackageSettings, PublicUser } from './types.js';

export type PackageKind = 'scorm12' | 'scorm2004' | 'xapi' | 'cmi5';

export const PACKAGE_KIND_LABELS: Record<PackageKind, string> = {
  scorm12: 'SCORM 1.2',
  scorm2004: 'SCORM 2004',
  xapi: 'xAPI (Tin Can)',
  cmi5: 'cmi5',
};

export type PackageCompletionStatus = 'not attempted' | 'incomplete' | 'completed';
export type PackageSuccessStatus = 'unknown' | 'passed' | 'failed';

/** One entry of a package's table of contents. Items without a launch are headings. */
export interface PackageItem {
  id: string;
  title: string;
  depth: number;
  launchable: boolean;
  /** SCOs talk to the SCORM API; assets are just shown. */
  sco: boolean;
}

export interface PackageVersionInfo {
  id: string;
  version: number;
  kind: PackageKind;
  /** SCORM 2004 edition, e.g. '4th'. */
  edition: string | null;
  title: string;
  fileName: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  items: PackageItem[];
  /** Parts of the manifest that were ignored or replaced by defaults when it was imported. */
  warnings?: string[];
}

export interface PackageItemProgress {
  completionStatus: PackageCompletionStatus;
  successStatus: PackageSuccessStatus;
  /** Percent (0-100), or null. */
  score: number | null;
}

export interface PackageAttemptInfo {
  id: string;
  attemptNumber: number;
  status: 'in_progress' | 'finished';
  completionStatus: PackageCompletionStatus;
  successStatus: PackageSuccessStatus;
  /** Percent (0-100), or null. */
  score: number | null;
  totalSeconds: number;
  startedAt: string;
  lastAccessedAt: string;
  finishedAt: string | null;
  /** The package version the attempt uses. */
  version: number;
  /** The kind of that version: it can differ from the current one's, once the package was replaced. */
  kind: PackageKind;
  items: Record<string, PackageItemProgress>;
}

export interface PackagePlayerInfo {
  activityId: string;
  settings: PackageSettings;
  /** The current package, or null before one is uploaded. */
  current: PackageVersionInfo | null;
  /** The viewer's own attempts, newest last (learners only). */
  attempts: PackageAttemptInfo[];
  /** Learners record attempts; everyone else previews. */
  mode: 'learner' | 'preview';
  canStartNew: boolean;
  /** The unfinished attempt to resume, if any. */
  resumeAttemptId: string | null;
  /** The version the next launch opens (an unfinished attempt keeps its version). */
  launchVersion: PackageVersionInfo | null;
  grade: { score: number | null; maxGrade: number } | null;
  canManage: boolean;
  canViewReports: boolean;
  /** Largest zip that can be uploaded, in bytes. */
  maxUploadBytes: number;
}

export interface PackageLaunchInput {
  itemId?: string | undefined;
  /** Open this attempt (resume, or review when it is finished). */
  attemptId?: string | undefined;
  /** Start a new attempt. */
  newAttempt?: boolean | undefined;
  /** Staff: open without recording anything. */
  preview?: boolean | undefined;
  /** SCORM 2004: a navigation request for the attempt (`itemId` is the target of choice). */
  nav?: PackageNavRequest | undefined;
  /** SCORM 2004: the page session the player just closed, so the server waits for its last commit. */
  sid?: string | undefined;
  /**
   * SCORM 2004: the delivery the player shows (`sequencing.deliveryId`, null when nothing is open).
   * A request for a delivery the attempt has moved on from (in another window) changes nothing.
   */
  deliveryId?: string | null | undefined;
}

export interface PackageLaunch {
  url: string;
  attemptId: string | null;
  itemId: string;
  /** normal: recorded; review: a finished attempt, read-only; browse: a preview. */
  mode: 'normal' | 'review' | 'browse';
  display: PackageSettings['display'];
  items: PackageItem[];
  /**
   * SCORM 2004 attempts: what the sequencing rules allow now. `url` and `itemId` are empty strings
   * when nothing is open (after Exit, at the end of the attempt, or when the learner has to choose).
   */
  sequencing?: PackageSequencingInfo;
}

export interface PackageReportRow {
  user: PublicUser & { email: string };
  attempts: PackageAttemptInfo[];
  /** The gradebook score (points), or null. */
  grade: number | null;
  completed: boolean;
}

export interface PackageReport {
  maxGrade: number | null;
  rows: PackageReportRow[];
}
