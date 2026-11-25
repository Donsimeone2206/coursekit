/**
 * Demo gradebook setup: Modern Web Development uses weighted categories, so the demo shows
 * category subtotals, weights and a drop-lowest rule. The other demo courses stay natural.
 */
import type { DB } from '../db/types.js';
import { saveGradebookSetup } from '../services/grade-categories.js';

const PLAN = [
  { id: 'assignments', name: 'Assignments', weight: 40, dropLowest: 0, items: ['Build a personal landing page', 'Interactive to-do list'] },
  {
    id: 'quizzes',
    name: 'Quizzes',
    weight: 20,
    dropLowest: 1,
    items: ['HTML & CSS check-in', 'JavaScript fundamentals', 'Web foundations review'],
  },
  { id: 'project', name: 'Final project', weight: 40, dropLowest: 0, items: ['Final project: ship a React app'] },
];

export async function seedDemoGradeCategories(db: DB): Promise<void> {
  const course = await db.selectFrom('courses').select('id').where('slug', '=', 'modern-web-development').executeTakeFirst();
  if (!course) return;
  const activities = await db
    .selectFrom('activities')
    .select(['id', 'title'])
    .where('courseId', '=', course.id)
    .where('maxGrade', 'is not', null)
    .execute();
  const byTitle = new Map(activities.map((a) => [a.title, a.id]));

  await saveGradebookSetup(db, course.id, {
    aggregation: 'weighted',
    categories: [
      ...PLAN.map(({ id, name, weight, dropLowest }) => ({ id, name, weight, dropLowest })),
      { id: course.id, name: 'Uncategorised', weight: 0, dropLowest: 0 },
    ],
    items: PLAN.flatMap((category) =>
      category.items.flatMap((title) => {
        const activityId = byTitle.get(title);
        return activityId ? [{ activityId, categoryId: category.id, weight: null }] : [];
      }),
    ),
  });
}
