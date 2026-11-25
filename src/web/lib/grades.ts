import { categoriesWithItems, usesCategories } from '@shared/grades';
import type { GradeCategory, Gradebook } from '@shared/types';

export type CategoryGroup = GradeCategory & { itemCount: number };

/** A course total or subtotal: up to 2 decimals ("84.17%", "84.2%", "85%"), or a dash. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '–';
  return `${Number(value.toFixed(2))}%`;
}

/** A category weight: "40%", "33.33%". */
export function formatWeight(weight: number): string {
  return `${Number(weight.toFixed(2))}%`;
}

/** Text colour for a percentage, matching the gradebook cells. */
export function gradeTone(pct: number | null | undefined): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct >= 85) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 60) return 'text-foreground';
  return 'text-red-600 dark:text-red-400';
}

const groupCache = new WeakMap<Gradebook, CategoryGroup[]>();

/** The category column groups of a gradebook, or none when the course doesn't use categories. */
export function gradebookGroups(book: Gradebook): CategoryGroup[] {
  let groups = groupCache.get(book);
  if (!groups) {
    groups = usesCategories(book) ? categoriesWithItems(book.categories, book.items) : [];
    groupCache.set(book, groups);
  }
  return groups;
}
