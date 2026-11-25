import type { BadgeSummary } from '@shared/completion';

/** Query keys. Course-scoped keys start with ['course', slug] so useInvalidateCourse refreshes them too. */
export const achievementKeys = {
  status: (slug: string) => ['course', slug, 'completion'] as const,
  report: (slug: string) => ['course', slug, 'completion', 'report'] as const,
  settings: (slug: string) => ['course', slug, 'completion', 'settings'] as const,
  certificates: (slug: string) => ['course', slug, 'certificates'] as const,
  courseBadges: (slug: string) => ['course', slug, 'badges'] as const,
  badge: (id: string) => ['badge', id] as const,
  siteBadges: ['badges', 'site'] as const,
  myBadges: ['me', 'badges'] as const,
  myCertificates: ['me', 'certificates'] as const,
};

export function badgeCriteriaLabel(badge: Pick<BadgeSummary, 'criteria' | 'course' | 'criteriaCourses'>): string {
  if (badge.criteria === 'completion') return 'Earned by completing the course';
  if (badge.criteria === 'courses') {
    const titles = badge.criteriaCourses.map((c) => c.title);
    if (titles.length === 0) return 'Earned by completing a set of courses';
    return `Earned by completing ${titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`}`;
  }
  return badge.course ? 'Awarded by teachers' : 'Awarded by administrators';
}

export function percent(value: number | null | undefined): string {
  if (value == null) return '–';
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, '')}%`;
}
