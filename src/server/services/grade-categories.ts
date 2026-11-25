/**
 * Gradebook setup: a course's categories (name, weight, drop-lowest, order), the category and
 * weight of each graded activity, and the aggregation used for the course total.
 */
import { z } from 'zod';
import type { GradebookSetup, GradebookSetupInput } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import { badRequest } from '../lib/http.js';
import { newId, now } from '../lib/util.js';
import { loadGradeSetup } from './course-total.js';

const idSchema = z.string().trim().min(1).max(64);

export const gradebookSetupSchema = z.object({
  aggregation: z.enum(['natural', 'weighted']),
  categories: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1, 'Give every category a name').max(80),
        weight: z.number().min(0, 'Weights go from 0 to 100').max(100, 'Weights go from 0 to 100'),
        dropLowest: z.number().int().min(0).max(50),
      }),
    )
    .min(1)
    .max(50),
  items: z
    .array(
      z.object({
        activityId: idSchema,
        categoryId: idSchema,
        weight: z.number().min(0).max(10_000).nullable(),
      }),
    )
    .max(2000)
    .optional(),
}) satisfies z.ZodType<GradebookSetupInput>;

export async function getGradebookSetup(db: DB, courseId: string): Promise<GradebookSetup> {
  const setup = await loadGradeSetup(db, courseId, { includeHidden: true });
  return {
    aggregation: setup.aggregation,
    categories: setup.categories,
    items: setup.items.map((i) => ({
      activityId: i.activityId,
      title: i.title,
      type: i.type,
      maxGrade: i.maxGrade,
      visible: i.visible,
      sectionTitle: i.sectionTitle,
      categoryId: i.categoryId,
      weight: i.weight,
    })),
  };
}

/**
 * Replaces a course's gradebook setup in one transaction. Categories missing from the input are
 * deleted and their activities move to the default category (whose id is the course id). Activities
 * missing from `items` keep their settings. Returns the saved setup.
 */
export async function saveGradebookSetup(db: DB, courseId: string, input: GradebookSetupInput): Promise<GradebookSetup> {
  const ids = input.categories.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw badRequest('Each category needs its own id.');
  if (!ids.includes(courseId)) {
    throw badRequest("The default category can't be removed.", [
      { path: 'categories', message: `Include the category with id ${courseId}` },
    ]);
  }
  const names = new Set<string>();
  for (const [index, c] of input.categories.entries()) {
    const key = c.name.trim().toLocaleLowerCase();
    if (names.has(key)) {
      throw badRequest(`There are two categories called "${c.name.trim()}".`, [
        { path: `categories.${index}.name`, message: 'Use a different name' },
      ]);
    }
    names.add(key);
  }
  if (input.aggregation === 'weighted' && !input.categories.some((c) => c.weight > 0)) {
    throw badRequest('Give at least one category a weight above 0%, or nothing would count towards the course total.');
  }

  const graded = new Set(
    (await db.selectFrom('activities').select('id').where('courseId', '=', courseId).where('maxGrade', 'is not', null).execute()).map(
      (a) => a.id,
    ),
  );
  const seen = new Set<string>();
  for (const [index, item] of (input.items ?? []).entries()) {
    if (seen.has(item.activityId))
      throw badRequest('An activity is listed twice.', [{ path: `items.${index}.activityId`, message: 'Duplicate' }]);
    seen.add(item.activityId);
    if (!graded.has(item.activityId)) {
      throw badRequest('That activity is not graded or not in this course.', [
        { path: `items.${index}.activityId`, message: 'Unknown activity' },
      ]);
    }
    if (!ids.includes(item.categoryId)) {
      throw badRequest('An activity is assigned to a category that is not in the list.', [
        { path: `items.${index}.categoryId`, message: 'Unknown category' },
      ]);
    }
  }

  const existing = new Set(
    (await db.selectFrom('gradeCategories').select('id').where('courseId', '=', courseId).execute()).map((c) => c.id),
  );
  // Ids of this course's categories are kept; anything else is a new category and gets a fresh id.
  const realId = new Map(ids.map((id) => [id, id === courseId || existing.has(id) ? id : newId()]));
  const removed = [...existing].filter((id) => id !== courseId && !realId.has(id));
  const ts = now();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('gradeSettings')
      .values({ courseId, aggregation: input.aggregation, updatedAt: ts })
      .onConflict((oc) => oc.column('courseId').doUpdateSet({ aggregation: input.aggregation, updatedAt: ts }))
      .execute();

    if (removed.length) {
      await trx.updateTable('gradeItems').set({ categoryId: null, updatedAt: ts }).where('categoryId', 'in', removed).execute();
      await trx.deleteFrom('gradeCategories').where('courseId', '=', courseId).where('id', 'in', removed).execute();
    }

    await trx
      .insertInto('gradeCategories')
      .values(
        input.categories.map((c, position) => ({
          id: realId.get(c.id)!,
          courseId,
          name: c.name.trim(),
          weight: c.weight,
          dropLowest: c.dropLowest,
          position,
          createdAt: ts,
          updatedAt: ts,
        })),
      )
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            weight: eb.ref('excluded.weight'),
            dropLowest: eb.ref('excluded.dropLowest'),
            position: eb.ref('excluded.position'),
            updatedAt: eb.ref('excluded.updatedAt'),
          }))
          .where('gradeCategories.courseId', '=', courseId),
      )
      .execute();

    const items = (input.items ?? []).map((item) => ({
      activityId: item.activityId,
      courseId,
      categoryId: item.categoryId === courseId ? null : realId.get(item.categoryId)!,
      weight: item.weight,
      updatedAt: ts,
    }));
    for (let i = 0; i < items.length; i += 400) {
      await trx
        .insertInto('gradeItems')
        .values(items.slice(i, i + 400))
        .onConflict((oc) =>
          oc.column('activityId').doUpdateSet((eb) => ({
            categoryId: eb.ref('excluded.categoryId'),
            weight: eb.ref('excluded.weight'),
            updatedAt: eb.ref('excluded.updatedAt'),
          })),
        )
        .execute();
    }
  });

  return getGradebookSetup(db, courseId);
}
