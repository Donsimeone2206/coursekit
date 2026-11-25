import type { ActivitySettingsMap, ActivityType, CompletionMode } from './types.js';

/** Gradient presets for course covers. The UI maps each key to a gradient. */
export const COVER_COLORS = ['indigo', 'ocean', 'emerald', 'sunset', 'rose', 'amber', 'teal', 'fuchsia', 'lime', 'slate'] as const;

export type CoverColor = (typeof COVER_COLORS)[number];

export const ACTIVITY_TYPES: readonly ActivityType[] = ['lesson', 'resource', 'assignment', 'quiz', 'forum'];

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  lesson: 'Lesson',
  resource: 'Resource',
  assignment: 'Assignment',
  quiz: 'Quiz',
  forum: 'Forum',
};

export const ACTIVITY_DESCRIPTIONS: Record<ActivityType, string> = {
  lesson: 'Rich reading content with optional video.',
  resource: 'Share a file or a link to an external page.',
  assignment: 'Collect text or file submissions and grade them.',
  quiz: 'Auto-graded questions with attempts and review.',
  forum: 'Threaded discussions for the class.',
};

export const GRADED_ACTIVITY_TYPES: readonly ActivityType[] = ['assignment', 'quiz'];

export const DEFAULT_COMPLETION: Record<ActivityType, CompletionMode> = {
  lesson: 'manual',
  resource: 'auto',
  assignment: 'auto',
  quiz: 'auto',
  forum: 'none',
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
};

export const DEFAULT_BRAND_COLOR = '#4f46e5';
