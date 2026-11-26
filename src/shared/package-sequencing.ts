/** API shapes for SCORM 2004 sequencing and navigation: the player of SCORM 2004 packages. */
import type { PackageCompletionStatus, PackageSuccessStatus } from './packages.js';

/**
 * Navigation requests the learner may make for a SCORM 2004 attempt (POST /api/packages/:id/launch
 * with `nav`). `choice` takes the item in `itemId`. `_none_` makes no request: it returns what is open
 * now. Jump isn't one of them: it is for content only (adl.nav.request), and ignores the control modes.
 */
export type PackageNavRequest =
  'start' | 'resumeAll' | 'continue' | 'previous' | 'choice' | 'exit' | 'exitAll' | 'abandon' | 'abandonAll' | 'suspendAll' | '_none_';

export const PACKAGE_NAV_REQUESTS: readonly PackageNavRequest[] = [
  'start',
  'resumeAll',
  'continue',
  'previous',
  'choice',
  'exit',
  'exitAll',
  'abandon',
  'abandonAll',
  'suspendAll',
  '_none_',
];

/** The player's own navigation controls (the SCORM hideLMSUI vocabulary). */
export type PackageNavControl = 'previous' | 'continue' | 'exit' | 'exitAll' | 'abandon' | 'abandonAll' | 'suspendAll';

export interface PackageTocEntry {
  id: string;
  title: string;
  depth: number;
  /** Has content of its own; the other entries are sections. */
  leaf: boolean;
  /** Shown in the table of contents (false for isvisible="false" items and hiddenFromChoice rules). */
  visible: boolean;
  /** Can be opened from the table of contents right now. */
  canChoose: boolean;
  current: boolean;
  attempted: boolean;
  suspended: boolean;
  completionStatus: PackageCompletionStatus;
  successStatus: PackageSuccessStatus;
  /** Percent (0-100), or null. */
  score: number | null;
}

export interface PackageSequencingInfo {
  /** Changes with every new delivery (a new attempt on a part, or a resumed one); null while nothing is open. */
  deliveryId: string | null;
  /** The attempt is over (the end of the course, Exit all, nothing left to open...). */
  ended: boolean;
  /** The learner suspended the attempt; it resumes where they left off. */
  suspended: boolean;
  /** Which of the player's controls to show (valid now, and not hidden by the part's hideLMSUI). */
  controls: Record<PackageNavControl, boolean>;
  toc: PackageTocEntry[];
  /** What happened, in plain words, when a request was refused or nothing is open. */
  message: string | null;
  /** The attempt's result so far: the course's rolled-up status. */
  completionStatus: PackageCompletionStatus;
  successStatus: PackageSuccessStatus;
  /** Percent (0-100), or null. */
  score: number | null;
  totalSeconds: number;
}
