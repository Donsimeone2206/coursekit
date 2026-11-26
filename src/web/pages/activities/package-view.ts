// No '@shared' alias here: the tests import this module from Node.
import type { PackagePlayerInfo } from '../../../shared/packages.js';

/** The player a package activity shows: Cmi5View for cmi5 courses, PackageView's own for SCORM and xAPI. */
export type PackageViewKind = 'cmi5' | 'package';

/**
 * Picks the player of the attempt the learner is on, in the kind of its own version: a teacher may have replaced
 * the package with another kind since the attempt started.
 *  - Whatever is playing keeps its player, whatever the refreshed info says: the attempt may have finished, and
 *    the next one would start on the current version.
 *  - An unfinished attempt keeps its version.
 *  - A new attempt starts on the current version: a cmi5 course shows Cmi5View, which also offers to review an
 *    earlier SCORM or xAPI attempt.
 *  - Otherwise the learner revisits their latest attempt; a cmi5 attempt's player also starts a new attempt of
 *    a SCORM or xAPI package.
 */
export function packageViewKind(info: PackagePlayerInfo, playing: { package: boolean; cmi5: boolean }): PackageViewKind {
  if (playing.package) return 'package';
  if (playing.cmi5) return 'cmi5';
  const kind = info.resumeAttemptId
    ? (info.launchVersion ?? info.current)?.kind
    : info.canStartNew && info.current?.kind === 'cmi5'
      ? 'cmi5'
      : (info.attempts[info.attempts.length - 1] ?? info.current)?.kind;
  return kind === 'cmi5' ? 'cmi5' : 'package';
}
