/**
 * Demo content for question sharing: Maya Chen teaches Modern Web Development and UX Design Principles, and
 * shares her web course's "Accessibility" questions with the UX course, where they show up read-only in the
 * question bank and the quiz editor.
 */
import type { AppDeps } from '../context.js';
import { newId } from '../lib/util.js';

export async function seedQuestionSharingDemo(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const courses = await db
    .selectFrom('courses')
    .select(['id', 'slug'])
    .where('slug', 'in', ['modern-web-development', 'ux-design-principles'])
    .execute();
  const web = courses.find((c) => c.slug === 'modern-web-development');
  const ux = courses.find((c) => c.slug === 'ux-design-principles');
  if (!web || !ux) return;
  const [category, maya] = await Promise.all([
    db.selectFrom('questionCategories').select('id').where('courseId', '=', web.id).where('name', '=', 'Accessibility').executeTakeFirst(),
    db.selectFrom('users').select('id').where('email', '=', 'maya.chen@coursekit.test').executeTakeFirst(),
  ]);
  if (!category) return;
  const existing = await db
    .selectFrom('questionCategoryShares')
    .select('id')
    .where('categoryId', '=', category.id)
    .where('courseId', '=', ux.id)
    .executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('questionCategoryShares')
    .values({ id: newId(), categoryId: category.id, courseId: ux.id, createdBy: maya?.id ?? null, createdAt: new Date().toISOString() })
    .execute();
}
