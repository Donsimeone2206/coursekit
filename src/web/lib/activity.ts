import { BookOpen, ClipboardList, Link2, ListChecks, MessagesSquare, Package, Puzzle, type LucideIcon } from 'lucide-react';
import type { ActivityType } from '@shared/types';

export const ACTIVITY_META: Record<ActivityType, { icon: LucideIcon; label: string; tint: string; solid: string }> = {
  lesson: { icon: BookOpen, label: 'Lesson', tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400', solid: 'bg-sky-500' },
  resource: { icon: Link2, label: 'Resource', tint: 'bg-slate-500/10 text-slate-600 dark:text-slate-300', solid: 'bg-slate-500' },
  assignment: {
    icon: ClipboardList,
    label: 'Assignment',
    tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    solid: 'bg-amber-500',
  },
  quiz: { icon: ListChecks, label: 'Quiz', tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', solid: 'bg-violet-500' },
  forum: {
    icon: MessagesSquare,
    label: 'Forum',
    tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    solid: 'bg-emerald-500',
  },
  lti: { icon: Puzzle, label: 'External tool', tint: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400', solid: 'bg-cyan-500' },
  package: { icon: Package, label: 'Package', tint: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', solid: 'bg-rose-500' },
};

export function activityPath(courseSlug: string, activityId: string) {
  return `/courses/${courseSlug}/activities/${activityId}`;
}
