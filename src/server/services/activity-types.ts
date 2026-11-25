import { z } from 'zod';
import { DEFAULT_COMPLETION } from '../../shared/constants.js';
import type { ActivitySettingsMap, ActivityType, CompletionMode } from '../../shared/types.js';

const emptyToNull = (v: unknown) => (v === '' ? null : v);
const httpUrl = z.url({ protocol: /^https?$/, message: 'Enter a valid http(s) URL' }).max(2000);

/**
 * Activity types and how their settings are validated. Built-in types are registered here;
 * this is also the extension point for custom activity plugins.
 */
export interface ActivityTypeDefinition<T extends ActivityType = ActivityType> {
  type: T;
  /** Activities of this type appear in the gradebook. */
  graded: boolean;
  defaultCompletion: CompletionMode;
  /** Completion modes that make sense for this type. */
  completionModes: CompletionMode[];
  settings: z.ZodType<ActivitySettingsMap[T]>;
}

export const activityTypes: { [K in ActivityType]: ActivityTypeDefinition<K> } = {
  lesson: {
    type: 'lesson',
    graded: false,
    defaultCompletion: DEFAULT_COMPLETION.lesson,
    completionModes: ['none', 'manual', 'auto'],
    settings: z.object({
      body: z.string().max(500_000).default(''),
      videoUrl: z.preprocess(emptyToNull, httpUrl.nullable()).default(null),
      estimatedMinutes: z.number().int().min(1).max(1000).nullable().default(null),
    }),
  },
  resource: {
    type: 'resource',
    graded: false,
    defaultCompletion: DEFAULT_COMPLETION.resource,
    completionModes: ['none', 'manual', 'auto'],
    settings: z.object({
      kind: z.enum(['file', 'link']).default('link'),
      fileId: z.string().max(64).nullable().default(null),
      url: z.preprocess(emptyToNull, httpUrl.nullable()).default(null),
    }),
  },
  assignment: {
    type: 'assignment',
    graded: true,
    defaultCompletion: DEFAULT_COMPLETION.assignment,
    completionModes: ['none', 'manual', 'auto'],
    settings: z.object({
      submissionTypes: z
        .array(z.enum(['text', 'file']))
        .min(1, 'Pick at least one submission type')
        .default(['text', 'file']),
      allowLate: z.boolean().default(true),
      maxFiles: z.number().int().min(1).max(20).default(5),
    }),
  },
  quiz: {
    type: 'quiz',
    graded: true,
    defaultCompletion: DEFAULT_COMPLETION.quiz,
    completionModes: ['none', 'manual', 'auto'],
    settings: z.object({
      timeLimitMinutes: z.number().int().min(1).max(600).nullable().default(null),
      attemptsAllowed: z.number().int().min(0).max(100).default(0),
      gradingMethod: z.enum(['highest', 'last', 'average']).default('highest'),
      shuffleQuestions: z.boolean().default(false),
      reviewMode: z.enum(['immediate', 'after_due', 'score_only']).default('immediate'),
      passingPercent: z.number().min(0).max(100).nullable().default(null),
    }),
  },
  forum: {
    type: 'forum',
    graded: false,
    defaultCompletion: DEFAULT_COMPLETION.forum,
    completionModes: ['none', 'manual', 'auto'],
    settings: z.object({
      studentsCanStartDiscussions: z.boolean().default(true),
    }),
  },
};

export function isActivityType(value: string): value is ActivityType {
  return value in activityTypes;
}

export function parseSettings<T extends ActivityType>(type: T, raw: string): ActivitySettingsMap[T] {
  let data: unknown = {};
  try {
    data = JSON.parse(raw);
  } catch {
    // fall back to defaults
  }
  const result = activityTypes[type].settings.safeParse(data);
  return result.success ? result.data : (activityTypes[type].settings.parse({}) as ActivitySettingsMap[T]);
}
