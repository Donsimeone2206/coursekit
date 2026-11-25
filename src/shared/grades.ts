/**
 * Gradebook helpers shared by the server (CSV export) and the web UI, so both group
 * columns by category the same way.
 */
import type { GradeAggregation, GradeCategory } from './types.js';

/** Weighted courses always show categories; natural ones do once a teacher has added a category. */
export function usesCategories(book: {
  aggregation: GradeAggregation;
  categories: ReadonlyArray<Pick<GradeCategory, 'isDefault'>>;
}): boolean {
  return book.aggregation === 'weighted' || book.categories.some((c) => !c.isDefault);
}

/** The categories that contain at least one of the items, in category order, with their item counts. */
export function categoriesWithItems<C extends { id: string }>(
  categories: readonly C[],
  items: ReadonlyArray<{ categoryId: string }>,
): Array<C & { itemCount: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
  return categories.filter((c) => counts.has(c.id)).map((c) => ({ ...c, itemCount: counts.get(c.id)! }));
}
