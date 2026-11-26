/**
 * Importing questions from Moodle XML and GIFT files into a course's bank. A preview parses the file and
 * shows what would happen; the import parses it again and saves everything in one transaction.
 */
import {
  MAX_IMPORT_BYTES,
  MAX_TRANSFER_CATEGORIES,
  MAX_TRANSFER_QUESTIONS,
  type QuestionFileFormat,
  type QuestionImportIssue,
  type QuestionImportPreview,
  type QuestionImportRequest,
  type QuestionImportResult,
} from '../../shared/question-sharing.js';
import type { QuestionType } from '../../shared/types.js';
import type { DB } from '../db/types.js';
import type { QuestionCategoryRow, QuestionRow } from '../db/schema.js';
import { ApiError, badRequest } from '../lib/http.js';
import { newId, now, num } from '../lib/util.js';
import { parseGift } from './question-formats/gift.js';
import { parseMoodleXml } from './question-formats/moodle-xml.js';
import type { ParseResult } from './question-formats/types.js';
import { ensureCategories, transact } from './question-bank.js';
import { defaultQuestionName } from './question-formats/text.js';
import { QUESTION_TYPES, questionInputSchema, storedQuestion, type QuestionInput } from './question-types.js';

export function detectFormat(content: string, filename?: string): QuestionFileFormat {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'xml') return 'moodle';
  if (ext === 'gift' || ext === 'txt') return 'gift';
  return content.trimStart().startsWith('<') ? 'moodle' : 'gift';
}

export function parseQuestionFile(content: string, format: QuestionFileFormat): ParseResult {
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw badRequest(`That file is too large. Import files of up to ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB.`);
  }
  if (!content.trim()) throw badRequest('That file is empty.');
  let result: ParseResult;
  try {
    result = format === 'moodle' ? parseMoodleXml(content) : parseGift(content);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // e.g. absurdly deep nesting in a crafted file
    throw badRequest('That file couldn’t be read. Check that it is a Moodle XML or GIFT file.');
  }
  if (result.questions.length + result.skipped > MAX_TRANSFER_QUESTIONS) {
    throw badRequest(`That file has more than ${MAX_TRANSFER_QUESTIONS} questions. Split it into smaller files.`);
  }
  return result;
}

const SEPARATOR = ' › ';

function zodMessage(issue: { path: PropertyKey[]; message: string; code: string; maximum?: unknown }): string {
  const field = String(issue.path[0] ?? '');
  if (issue.code === 'too_big' && issue.path.length > 1) {
    // One text in a list is too long (not the list itself).
    const what: Record<string, string> = {
      options: 'An answer or item',
      pairs: issue.path[2] === 'answer' ? 'A matching answer' : 'An item to match',
      distractors: 'An extra wrong answer',
      acceptedAnswers: 'An accepted answer',
    };
    const max = Number(issue.maximum);
    return `${what[field] ?? field} is too long${Number.isFinite(max) ? ` (at most ${max.toLocaleString('en-US')} characters)` : ''}.`;
  }
  if (issue.code === 'too_big') {
    const limits: Record<string, string> = {
      options: 'Coursekit allows up to 20 answers or items.',
      pairs: 'Coursekit allows up to 20 pairs to match.',
      distractors: 'Coursekit allows up to 10 extra wrong answers.',
      acceptedAnswers: 'Coursekit allows up to 50 accepted answers.',
      prompt: 'The question text is longer than 20,000 characters.',
      points: 'The mark is above 1000.',
    };
    return limits[field] ?? `${field} is too long.`;
  }
  return issue.message;
}

interface PlannedCategory {
  id: string;
  label: string;
  isNew: boolean;
  parentId: string | null;
  name: string;
  description: string;
  questionCount: number;
}

interface Plan {
  preview: QuestionImportPreview;
  categories: PlannedCategory[];
  questions: Array<{ input: QuestionInput; categoryId: string }>;
}

async function plan(db: DB, courseId: string, request: QuestionImportRequest): Promise<Plan> {
  const format = request.format ?? detectFormat(request.content, request.filename);
  const parsed = parseQuestionFile(request.content, format);
  const errors: QuestionImportIssue[] = [...parsed.errors];
  const valid: Array<{ number: number; line: number | null; category: string[]; input: QuestionInput }> = [];
  for (const q of parsed.questions) {
    const result = questionInputSchema.safeParse(q.input);
    if (result.success) valid.push({ ...q, input: result.data });
    else for (const message of new Set(result.error.issues.map(zodMessage))) errors.push({ number: q.number, line: q.line, message });
  }
  errors.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const existing = await ensureCategories(db, courseId);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const target = request.categoryId ? byId.get(request.categoryId) : null;
  if (request.categoryId && !target) throw badRequest("That category is not in this course's question bank.");
  const fallback = target ?? existing[0]!;
  const labelOf = (id: string): string => {
    const names: string[] = [];
    for (let c = byId.get(id); c && names.length < 50; c = c.parentId ? byId.get(c.parentId) : undefined) names.unshift(c.name);
    return names.join(SEPARATOR);
  };

  const nodes = new Map<string, PlannedCategory>();
  const fresh: PlannedCategory[] = [];
  const byPath = new Map<string, PlannedCategory>();
  const existingNode = (row: QuestionCategoryRow): PlannedCategory => {
    let node = nodes.get(row.id);
    if (!node) {
      node = {
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        label: labelOf(row.id),
        isNew: false,
        description: '',
        questionCount: 0,
      };
      nodes.set(row.id, node);
    }
    return node;
  };
  /**
   * The category for a path from the file: found, or planned, under the chosen parent (names match
   * case-insensitively). A loop from the top down, so a deep path costs no recursion.
   */
  const resolve = (path: string[], description = ''): PlannedCategory => {
    if (path.length === 0) return existingNode(fallback);
    let parent: PlannedCategory | null = target ? existingNode(target) : null;
    let key = '';
    for (const name of path) {
      key += JSON.stringify(name.toLowerCase());
      let node = byPath.get(key);
      if (!node) {
        const parentId: string | null = parent?.id ?? null;
        const match = existing.find((c) => c.parentId === parentId && c.name.trim().toLowerCase() === name.toLowerCase());
        if (match) node = existingNode(match);
        else {
          if (fresh.length >= MAX_TRANSFER_CATEGORIES) throw badRequest(`That file has more than ${MAX_TRANSFER_CATEGORIES} categories.`);
          node = {
            id: newId(),
            parentId,
            name,
            label: parent ? `${parent.label}${SEPARATOR}${name}` : name,
            isNew: true,
            description: '',
            questionCount: 0,
          };
          fresh.push(node);
          nodes.set(node.id, node);
        }
        byPath.set(key, node);
      }
      parent = node;
    }
    if (description && parent!.isNew && !parent!.description) parent!.description = description.slice(0, 1000);
    return parent!;
  };

  if (request.createCategories) for (const c of parsed.categories) resolve(c.path, c.description);
  const questions = valid.map((q) => {
    const category = resolve(request.createCategories ? q.category : []);
    category.questionCount += 1;
    return { ...q, categoryId: category.id, categoryLabel: category.label };
  });

  const counts = QUESTION_TYPES.map((type) => ({
    type: type as QuestionType,
    count: questions.filter((q) => q.input.type === type).length,
  })).filter((c) => c.count > 0);
  const targets = [...nodes.values()].filter((c) => c.isNew || c.questionCount > 0).sort((a, b) => a.label.localeCompare(b.label));

  return {
    preview: {
      format,
      found: parsed.questions.length + parsed.skipped,
      ready: questions.length,
      counts,
      categories: targets.map((c) => ({ label: c.label, isNew: c.isNew, questionCount: c.questionCount })),
      questions: questions.slice(0, 500).map((q) => ({
        number: q.number,
        line: q.line,
        type: q.input.type,
        label: q.input.name || defaultQuestionName(q.input.prompt),
        category: q.categoryLabel,
      })),
      warnings: parsed.warnings,
      errors,
    },
    categories: fresh,
    questions: questions.map((q) => ({ input: q.input, categoryId: q.categoryId })),
  };
}

export async function previewImport(db: DB, courseId: string, request: QuestionImportRequest): Promise<QuestionImportPreview> {
  return (await plan(db, courseId, request)).preview;
}

/** Imports every valid question of the file in one transaction (questions with errors are skipped). */
export async function runImport(db: DB, courseId: string, userId: string, request: QuestionImportRequest): Promise<QuestionImportResult> {
  const { preview, categories, questions } = await plan(db, courseId, request);
  if (questions.length === 0) throw badRequest('There are no questions to import in that file.');
  const ts = now();
  await transact(db, async (trx) => {
    const positions = new Map<string | null, number>();
    const nextPosition = async (parentId: string | null) => {
      if (!positions.has(parentId)) {
        const row = await trx
          .selectFrom('questionCategories')
          .select((eb) => eb.fn.max('position').as('max'))
          .where('courseId', '=', courseId)
          .where((eb) => (parentId ? eb('parentId', '=', parentId) : eb('parentId', 'is', null)))
          .executeTakeFirst();
        positions.set(parentId, row?.max == null ? -1 : num(row.max));
      }
      const next = positions.get(parentId)! + 1;
      positions.set(parentId, next);
      return next;
    };
    for (const c of categories) {
      const row: QuestionCategoryRow = {
        id: c.id,
        courseId,
        parentId: c.parentId,
        name: c.name,
        description: c.description,
        position: await nextPosition(c.parentId),
        createdAt: ts,
      };
      await trx.insertInto('questionCategories').values(row).execute();
    }
    const rows: QuestionRow[] = questions.map((q) => ({
      id: newId(),
      courseId,
      categoryId: q.categoryId,
      ...storedQuestion(q.input),
      createdBy: userId,
      createdAt: ts,
      updatedAt: ts,
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await trx
        .insertInto('questions')
        .values(rows.slice(i, i + 50))
        .execute();
    }
  });
  return { imported: questions.length, categoriesCreated: categories.length, skipped: preview.found - questions.length };
}
