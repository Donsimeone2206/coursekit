/** Exporting bank questions as Moodle XML or GIFT: a category (optionally with its subcategories), chosen questions, or the whole bank. */
import {
  MAX_TRANSFER_QUESTIONS,
  QUESTION_FILE_FORMATS,
  type QuestionExportRequest,
  type QuestionExportResult,
} from '../../shared/question-sharing.js';
import type { DB } from '../db/types.js';
import type { QuestionCategoryRow, QuestionRow } from '../db/schema.js';
import { badRequest, notFound } from '../lib/http.js';
import { parseJson, slugify } from '../lib/util.js';
import { exportGift } from './question-formats/gift.js';
import { exportMoodleXml } from './question-formats/moodle-xml.js';
import { MAX_CATEGORY_DEPTH } from './question-formats/text.js';
import type { ExportItem } from './question-formats/types.js';
import { loadCategories, sortCategories, subtreeIds } from './question-bank.js';
import { sharedCategoryRows } from './question-sharing.js';
import { questionLabel, type QuestionSettings, type StoredOption } from './question-types.js';

export async function exportQuestions(db: DB, courseId: string, request: QuestionExportRequest): Promise<QuestionExportResult> {
  const course = await db.selectFrom('courses').select(['id', 'slug']).where('id', '=', courseId).executeTakeFirstOrThrow();
  const shared = await sharedCategoryRows(db, courseId);
  const usable = (r: Pick<QuestionRow, 'courseId' | 'categoryId'>) => r.courseId === courseId || shared.ids.has(r.categoryId);
  let rows: QuestionRow[];
  let base = course.slug;
  if (request.questionIds?.length) {
    const ids = [...new Set(request.questionIds)];
    if (ids.length > MAX_TRANSFER_QUESTIONS) throw badRequest(`Export up to ${MAX_TRANSFER_QUESTIONS} questions at a time.`);
    rows = await db.selectFrom('questions').selectAll().where('id', 'in', ids).execute();
    if (rows.length !== ids.length || !rows.every(usable)) throw badRequest("One of the questions is not in this course's question bank.");
  } else if (request.categoryId) {
    const category = await db.selectFrom('questionCategories').selectAll().where('id', '=', request.categoryId).executeTakeFirst();
    if (!category || !(category.courseId === courseId || shared.ids.has(category.id))) throw notFound('Category');
    const ids = request.includeSubcategories ? subtreeIds(await loadCategories(db, category.courseId), category.id) : [category.id];
    rows = await db.selectFrom('questions').selectAll().where('categoryId', 'in', ids).execute();
    base = slugify(category.name, 'questions');
  } else {
    rows = await db.selectFrom('questions').selectAll().where('courseId', '=', courseId).execute();
  }
  if (rows.length === 0) throw badRequest('There are no questions to export.');
  if (rows.length > MAX_TRANSFER_QUESTIONS) throw badRequest(`Export up to ${MAX_TRANSFER_QUESTIONS} questions at a time.`);

  const courses = [...new Set(rows.map((r) => r.courseId))];
  const categories = sortCategories(await db.selectFrom('questionCategories').selectAll().where('courseId', 'in', courses).execute());
  const byId = new Map(categories.map((c) => [c.id, c]));
  const order = new Map(categories.map((c, i) => [c.id, i]));
  /** The category's names from the top of the bank; for shared categories, from the top of the share. */
  const pathOf = (category: QuestionCategoryRow): string[] => {
    const names: string[] = [];
    for (
      let c: QuestionCategoryRow | undefined = category;
      c && names.length < MAX_CATEGORY_DEPTH;
      c = c.parentId ? byId.get(c.parentId) : undefined
    ) {
      if (c.courseId !== courseId && !shared.ids.has(c.id)) break;
      names.unshift(c.name);
    }
    return names;
  };
  rows.sort(
    (a, b) =>
      (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const items: ExportItem[] = rows.map((r) => {
    const category = byId.get(r.categoryId);
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      prompt: r.prompt,
      points: r.points,
      options: parseJson<StoredOption[]>(r.options, []),
      acceptedAnswers: parseJson<string[]>(r.acceptedAnswers, []),
      tolerance: r.tolerance,
      explanation: r.explanation,
      settings: parseJson<QuestionSettings>(r.settings, {}),
      category: category ? pathOf(category) : [],
      categoryDescription: category?.description ?? '',
    };
  });

  const { extension, mimeType } = QUESTION_FILE_FORMATS[request.format];
  const filename = `${base}-questions-${new Date().toISOString().slice(0, 10)}.${extension}`;
  if (request.format === 'gift') {
    const gift = exportGift(items);
    if (gift.skipped.length === items.length) {
      throw badRequest(`${[...new Set(gift.skipped.map((s) => s.reason))].join(' ')} Export them as Moodle XML instead.`);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      filename,
      mimeType,
      content: gift.content,
      exported: items.length - gift.skipped.length,
      skipped: gift.skipped.map((s) => ({ ...s, label: questionLabel(byId.get(s.id) ?? { prompt: '' }, 120) })),
      notes: gift.notes,
    };
  }
  return { filename, mimeType, content: exportMoodleXml(items), exported: items.length, skipped: [], notes: [] };
}
