import { DEFAULT_LIVE_SETTINGS } from './live.js';
import type { ActivitySettingsMap, ActivityType, CompletionMode } from './types.js';

/** Gradient presets for course covers. The UI maps each key to a gradient. */
export const COVER_COLORS = ['indigo', 'ocean', 'emerald', 'sunset', 'rose', 'amber', 'teal', 'fuchsia', 'lime', 'slate'] as const;

export type CoverColor = (typeof COVER_COLORS)[number];

export const ACTIVITY_TYPES: readonly ActivityType[] = ['lesson', 'resource', 'assignment', 'quiz', 'forum', 'lti', 'package', 'live'];

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  lesson: 'Lesson',
  resource: 'Resource',
  assignment: 'Assignment',
  quiz: 'Quiz',
  forum: 'Forum',
  lti: 'External tool',
  package: 'SCORM / xAPI package',
  live: 'Live class',
};

export const ACTIVITY_DESCRIPTIONS: Record<ActivityType, string> = {
  lesson: 'Rich reading content with optional video.',
  resource: 'Share a file or a link to an external page.',
  assignment: 'Collect text or file submissions and grade them.',
  quiz: 'Auto-graded questions with attempts and review.',
  forum: 'Threaded discussions for the class.',
  lti: 'Open a learning tool from another site (LTI 1.3), with grades sent back.',
  package: 'Upload a SCORM 1.2, SCORM 2004, xAPI (Tin Can) or cmi5 e-learning module.',
  live: 'Scheduled online classes with BigBlueButton, Zoom, Jitsi Meet or a meeting link.',
};

export const GRADED_ACTIVITY_TYPES: readonly ActivityType[] = ['assignment', 'quiz', 'lti', 'package'];

export const DEFAULT_COMPLETION: Record<ActivityType, CompletionMode> = {
  lesson: 'manual',
  resource: 'auto',
  assignment: 'auto',
  quiz: 'auto',
  forum: 'none',
  lti: 'auto',
  package: 'auto',
  live: 'auto',
};

export const DEFAULT_SETTINGS: ActivitySettingsMap = {
  lesson: { body: '', videoUrl: null, estimatedMinutes: null },
  resource: { kind: 'link', fileId: null, url: null },
  assignment: { submissionTypes: ['text', 'file'], allowLate: true, maxFiles: 5 },
  quiz: {
    timeLimitMinutes: null,
    attemptsAllowed: 0,
    gradingMethod: 'highest',
    shuffleQuestions: false,
    reviewMode: 'immediate',
    passingPercent: null,
  },
  forum: { studentsCanStartDiscussions: true },
  lti: { toolId: null, launchUrl: null, custom: {}, presentation: 'window', lineItemResourceId: null, lineItemTag: null },
  package: { display: 'embed', attemptsAllowed: 0, gradingMethod: 'highest', requirePass: false },
  live: DEFAULT_LIVE_SETTINGS,
};

export const DEFAULT_BRAND_COLOR = '#4f46e5';
