/**
 * Question types: validation, storage, grading and what each viewer may see. Pure functions, no database.
 *
 * Attempts never read the question bank after they start: each one keeps a {@link QuestionSnapshot} of its
 * questions (with the order shown to the student), so editing or deleting bank questions never changes a
 * past attempt, its grading or its review.
 */
import { z } from 'zod';
import type { AttemptAnswer, MatchPair, Question, QuestionOption, QuestionResult, QuestionType } from '../../shared/types.js';
import { excerpt, newId, parseJson, round, sha256 } from '../lib/util.js';

export const QUESTION_TYPES = ['single', 'multiple', 'truefalse', 'short', 'numeric', 'essay', 'matching', 'ordering'] as const;

/** A choice ({ id, text, correct }), an ordering item ({ id, text }, stored in the right order) or a matching pair ({ id, text, answer }). */
export interface StoredOption {
  id: string;
  text: string;
  correct?: boolean;
  answer?: string;
}

export interface QuestionSettings {
  /** essay */
  minWords?: number | null;
  maxWords?: number | null;
  graderNotes?: string | null;
  /** matching: extra wrong answers */
  distractors?: string[];
}

/** A question as it was when an attempt started. */
export interface QuestionSnapshot {
  id: string;
  type: QuestionType;
  prompt: string;
  /** The mark for this question in the attempt. */
  points: number;
  options: StoredOption[];
  acceptedAnswers: string[];
  tolerance: number | null;
  explanation: string | null;
  settings: QuestionSettings;
  /** matching: the answers to choose from, in display order. */
  choices?: Array<{ id: string; text: string }>;
  /** matching: the right choice id for each pair id. */
  key?: Record<string, string>;
  /** ordering: item ids in the order first shown. */
  order?: string[];
}

/** The stored columns of a question row (bank questions, or 0.1.x rows in old seed data). */
export interface QuestionRowLike {
  id: string;
  type: QuestionType;
  prompt: string;
  points: number;
  options: string;
  acceptedAnswers: string;
  tolerance: number | null;
  explanation: string | null;
  settings?: string | null;
}

/** An automatic grade: no comment or grader. */
export type GradeResult = Pick<QuestionResult, 'correct' | 'partial' | 'points' | 'maxPoints' | 'pending'>;

export function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function wordCount(text: string | undefined | null): number {
  const t = (text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function isChoiceType(type: QuestionType): boolean {
  return type === 'single' || type === 'multiple' || type === 'truefalse';
}

/** Matching answers are identified by their text, so identical answers become one choice. */
export function matchChoiceId(text: string): string {
  return `c${sha256(normalizeText(text)).slice(0, 12)}`;
}

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Neighbouring pairs of `given` that are also neighbours, in the same order, in `correct`. */
export function orderedPairs(correct: readonly string[], given: readonly string[]): number {
  const index = new Map(correct.map((id, i) => [id, i]));
  let right = 0;
  for (let i = 0; i + 1 < given.length; i++) {
    const a = index.get(given[i]!);
    const b = index.get(given[i + 1]!);
    if (a !== undefined && b !== undefined && b === a + 1) right++;
  }
  return right;
}

/** The order first shown for an ordering question: shuffled, with no neighbouring pair already right (so it scores 0). */
export function initialOrder(ids: readonly string[], random: () => number = Math.random): string[] {
  if (ids.length < 2) return [...ids];
  for (let i = 0; i < 25; i++) {
    const order = shuffle(ids, random);
    if (orderedPairs(ids, order) === 0) return order;
  }
  return [...ids].reverse();
}

function matchingPresentation(options: StoredOption[], distractors: string[], random: () => number) {
  const choices = new Map<string, { id: string; text: string }>();
  const key: Record<string, string> = {};
  for (const pair of options) {
    const text = (pair.answer ?? '').trim();
    const id = matchChoiceId(text);
    if (!choices.has(id)) choices.set(id, { id, text });
    key[pair.id] = id;
  }
  for (const d of distractors) {
    const id = matchChoiceId(d);
    if (!choices.has(id)) choices.set(id, { id, text: d.trim() });
  }
  return { choices: shuffle([...choices.values()], random), key };
}

/** Freezes a stored question for an attempt (or a preview), choosing the order its parts are shown in. */
export function snapshotFromRow(row: QuestionRowLike, options: { points?: number; random?: () => number } = {}): QuestionSnapshot {
  const random = options.random ?? Math.random;
  const snapshot: QuestionSnapshot = {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    points: options.points ?? row.points,
    options: parseJson<StoredOption[]>(row.options, []),
    acceptedAnswers: parseJson<string[]>(row.acceptedAnswers, []),
    tolerance: row.tolerance,
    explanation: row.explanation,
    settings: parseJson<QuestionSettings>(row.settings ?? '{}', {}),
  };
  if (snapshot.type === 'matching')
    Object.assign(snapshot, matchingPresentation(snapshot.options, snapshot.settings.distractors ?? [], random));
  if (snapshot.type === 'ordering')
    snapshot.order = initialOrder(
      snapshot.options.map((o) => o.id),
      random,
    );
  return snapshot;
}

function asSnapshot(q: QuestionSnapshot | QuestionRowLike): QuestionSnapshot {
  if (typeof q.options !== 'string') return q as QuestionSnapshot;
  const row = q as QuestionRowLike;
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    points: row.points,
    options: parseJson<StoredOption[]>(row.options, []),
    acceptedAnswers: parseJson<string[]>(row.acceptedAnswers, []),
    tolerance: row.tolerance,
    explanation: row.explanation,
    settings: parseJson<QuestionSettings>(row.settings ?? '{}', {}),
  };
}

/** The student's order for an ordering question, or null if it isn't a full arrangement of the items. */
export function validOrder(given: readonly string[] | undefined, ids: readonly string[]): string[] | null {
  if (!given || given.length !== ids.length) return null;
  const valid = new Set(ids);
  const seen = new Set<string>();
  for (const id of given) {
    if (!valid.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return [...given];
}

/** The answer that counts: an untouched ordering question is answered with the order it was shown in. */
export function effectiveAnswer(q: QuestionSnapshot, answer: AttemptAnswer | undefined): AttemptAnswer | undefined {
  if (q.type !== 'ordering') return answer;
  const ids = q.options.map((o) => o.id);
  const order = validOrder(answer?.order, ids) ?? q.order ?? null;
  return order ? { order } : answer;
}

function matchesAccepted(given: string, pattern: string): boolean {
  if (!pattern.includes('*')) return given === pattern;
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(given);
}

function partial(maxPoints: number, fraction: number): GradeResult {
  const points = round(maxPoints * Math.max(0, Math.min(1, fraction)));
  const correct = fraction >= 1;
  return { correct, partial: !correct && points > 0, points, maxPoints };
}

/**
 * Grades one answer. Partial credit rules:
 * - multiple: each right choice earns a share of the marks and each wrong choice takes one share away (never below zero);
 * - matching: each item matched to its right answer earns an equal share;
 * - ordering: each neighbouring pair of items that is in the right order earns an equal share (n items have n - 1 pairs);
 * - essay: marked by a teacher; a non-empty answer is `pending` until then.
 */
export function gradeQuestion(question: QuestionSnapshot | QuestionRowLike, answer: AttemptAnswer | undefined): GradeResult {
  const q = asSnapshot(question);
  const maxPoints = q.points;
  const zero: GradeResult = { correct: false, partial: false, points: 0, maxPoints };
  const full: GradeResult = { correct: true, partial: false, points: maxPoints, maxPoints };
  const given = effectiveAnswer(q, answer);
  if (!given) return zero;

  switch (q.type) {
    case 'single':
    case 'truefalse': {
      const chosen = q.options.find((o) => o.id === given.optionIds?.[0]);
      return chosen?.correct ? full : zero;
    }
    case 'multiple': {
      const chosen = new Set(given.optionIds ?? []);
      const correctIds = q.options.filter((o) => o.correct).map((o) => o.id);
      if (correctIds.length === 0 || chosen.size === 0) return zero;
      const right = correctIds.filter((id) => chosen.has(id)).length;
      const wrong = q.options.filter((o) => !o.correct && chosen.has(o.id)).length;
      return partial(maxPoints, (right - wrong) / correctIds.length);
    }
    case 'short': {
      const text = normalizeText(given.text ?? '');
      if (!text) return zero;
      return q.acceptedAnswers.map(normalizeText).some((a) => matchesAccepted(text, a)) ? full : zero;
    }
    case 'numeric': {
      const raw = (given.text ?? '').trim().replace(',', '.');
      const value = Number(raw);
      if (!raw || !Number.isFinite(value)) return zero;
      const tolerance = q.tolerance ?? 0;
      const accepted = q.acceptedAnswers.map(Number).filter(Number.isFinite);
      return accepted.some((a) => Math.abs(a - value) <= tolerance + 1e-9) ? full : zero;
    }
    case 'essay':
      return given.text?.trim() ? { ...zero, pending: true } : zero;
    case 'matching': {
      if (q.options.length === 0) return zero;
      const key = q.key ?? Object.fromEntries(q.options.map((p) => [p.id, matchChoiceId(p.answer ?? '')]));
      const matches = given.matches ?? {};
      const right = q.options.filter((p) => !!matches[p.id] && matches[p.id] === key[p.id]).length;
      return partial(maxPoints, right / q.options.length);
    }
    case 'ordering': {
      const ids = q.options.map((o) => o.id);
      const order = validOrder(given.order, ids);
      if (!order || ids.length === 0) return zero;
      if (ids.length === 1) return full;
      return partial(maxPoints, orderedPairs(ids, order) / (ids.length - 1));
    }
    default:
      return zero;
  }
}

function base(q: QuestionSnapshot): Question {
  return { id: q.id, type: q.type, prompt: q.prompt, points: q.points, options: [] };
}

function choicesOf(q: QuestionSnapshot): QuestionOption[] {
  if (q.choices) return q.choices.map((c) => ({ id: c.id, text: c.text }));
  // Older snapshots: a stable order that doesn't follow the items.
  return matchingPresentation(q.options, q.settings.distractors ?? [], () => 0.5)
    .choices.sort((a, b) => a.text.localeCompare(b.text))
    .map((c) => ({ id: c.id, text: c.text }));
}

/** What a student sees while answering: no correct answers, no grader notes. */
export function studentQuestion(q: QuestionSnapshot): Question {
  const out = base(q);
  switch (q.type) {
    case 'single':
    case 'multiple':
    case 'truefalse':
      out.options = q.options.map((o) => ({ id: o.id, text: o.text }));
      break;
    case 'ordering': {
      const byId = new Map(q.options.map((o) => [o.id, o]));
      const order = q.order ?? q.options.map((o) => o.id).reverse();
      out.options = order
        .map((id) => byId.get(id))
        .filter((o): o is StoredOption => !!o)
        .map((o) => ({ id: o.id, text: o.text }));
      break;
    }
    case 'matching':
      out.pairs = q.options.map((p) => ({ id: p.id, text: p.text }));
      out.choices = choicesOf(q);
      break;
    case 'essay':
      out.minWords = q.settings.minWords ?? null;
      out.maxWords = q.settings.maxWords ?? null;
      break;
  }
  return out;
}

/** Review of a submitted attempt: correct answers and explanations. Grader notes only for staff. */
export function reviewQuestion(q: QuestionSnapshot, staff: boolean): Question {
  const out = studentQuestion(q);
  out.explanation = q.explanation;
  switch (q.type) {
    case 'single':
    case 'multiple':
    case 'truefalse':
      out.options = q.options.map((o) => ({ id: o.id, text: o.text, correct: !!o.correct }));
      break;
    case 'short':
    case 'numeric':
      out.acceptedAnswers = q.acceptedAnswers;
      out.tolerance = q.tolerance;
      break;
    case 'ordering':
      out.options = q.options.map((o) => ({ id: o.id, text: o.text }));
      break;
    case 'matching': {
      const key = q.key ?? Object.fromEntries(q.options.map((p) => [p.id, matchChoiceId(p.answer ?? '')]));
      out.pairs = q.options.map((p) => ({ id: p.id, text: p.text, answer: p.answer ?? '', answerId: key[p.id] }));
      break;
    }
  }
  if (staff && q.type === 'essay') out.graderNotes = q.settings.graderNotes ?? null;
  return out;
}

/** A bank question as its editors see it. */
export function editorQuestion(row: QuestionRowLike): Question {
  const q = asSnapshot(row);
  const out: Question = {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    points: q.points,
    options: [],
    explanation: q.explanation,
  };
  switch (q.type) {
    case 'single':
    case 'multiple':
    case 'truefalse':
      out.options = q.options.map((o) => ({ id: o.id, text: o.text, correct: !!o.correct }));
      break;
    case 'short':
    case 'numeric':
      out.acceptedAnswers = q.acceptedAnswers;
      out.tolerance = q.tolerance;
      break;
    case 'ordering':
      out.options = q.options.map((o) => ({ id: o.id, text: o.text }));
      break;
    case 'matching':
      out.pairs = q.options.map((p): MatchPair => ({ id: p.id, text: p.text, answer: p.answer ?? '' }));
      out.distractors = q.settings.distractors ?? [];
      break;
    case 'essay':
      out.minWords = q.settings.minWords ?? null;
      out.maxWords = q.settings.maxWords ?? null;
      out.graderNotes = q.settings.graderNotes ?? null;
      break;
  }
  return out;
}

/** Plain-text label for lists: the question's name, or the start of its prompt. */
export function questionLabel(q: { name?: string | null; prompt: string }, length = 140): string {
  return q.name?.trim() || excerpt(q.prompt, length) || 'Untitled question';
}

// ---------------------------------------------------------------------------------------------------- input

const idSchema = z.string().max(40).optional();
const optionSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1, 'Option text is required').max(2000),
  correct: z.boolean().default(false),
});
const pairSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1, 'Enter the item to match').max(2000),
  answer: z.string().trim().min(1, 'Enter the matching answer').max(500),
});
const wordLimit = z.number().int().min(1).max(20_000).nullable().default(null);

/** A question as editors send it (question bank and quiz editor). */
export const questionInputSchema = z
  .object({
    id: idSchema,
    type: z.enum(QUESTION_TYPES),
    name: z.string().trim().max(200).default(''),
    prompt: z.string().trim().min(1, 'Question text is required').max(20_000),
    points: z.number().min(0).max(1000).default(1),
    options: z.array(optionSchema).max(20).default([]),
    pairs: z.array(pairSchema).max(20).default([]),
    distractors: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    acceptedAnswers: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    tolerance: z.number().min(0).nullable().default(null),
    explanation: z.string().max(20_000).nullable().default(null),
    minWords: wordLimit,
    maxWords: wordLimit,
    graderNotes: z.string().max(20_000).nullable().default(null),
  })
  .superRefine((q, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    const correct = q.options.filter((o) => o.correct).length;
    if (q.type === 'single' || q.type === 'multiple') {
      if (q.options.length < 2) issue('Add at least two options', 'options');
      if (q.type === 'single' && correct !== 1) issue('Mark exactly one option as correct', 'options');
      if (q.type === 'multiple' && correct < 1) issue('Mark at least one option as correct', 'options');
    }
    if (q.type === 'truefalse' && (q.options.length !== 2 || correct !== 1))
      issue('Choose whether the statement is true or false', 'options');
    if (q.type === 'short' && q.acceptedAnswers.length === 0) issue('Add at least one accepted answer', 'acceptedAnswers');
    if (q.type === 'numeric' && (q.acceptedAnswers.length === 0 || q.acceptedAnswers.some((a) => !Number.isFinite(Number(a))))) {
      issue('Enter the correct number', 'acceptedAnswers');
    }
    if (q.type === 'ordering' && q.options.length < 2) issue('Add at least two items to put in order', 'options');
    if (q.type === 'matching') {
      if (q.pairs.length < 2) issue('Add at least two items to match', 'pairs');
      const answers = new Set(q.pairs.map((p) => normalizeText(p.answer)));
      if (q.distractors.some((d) => answers.has(normalizeText(d)))) issue('A distractor must differ from the right answers', 'distractors');
    }
    if (q.type === 'essay' && q.minWords != null && q.maxWords != null && q.minWords > q.maxWords) {
      issue('The minimum word count is above the maximum', 'minWords');
    }
  });

export type QuestionInput = z.output<typeof questionInputSchema>;

/** Keeps sensible client ids and replaces missing or repeated ones. */
function withIds<T extends { id?: string | undefined }>(items: T[]): Array<T & { id: string }> {
  const seen = new Set<string>();
  return items.map((item) => {
    const id = item.id && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) && !seen.has(item.id) ? item.id : newId(8);
    seen.add(id);
    return { ...item, id };
  });
}

/** The stored columns for a question from editor input. */
export function storedQuestion(q: QuestionInput) {
  let options: StoredOption[] = [];
  const settings: QuestionSettings = {};
  if (isChoiceType(q.type)) options = withIds(q.options).map((o) => ({ id: o.id, text: o.text, correct: o.correct }));
  if (q.type === 'ordering') options = withIds(q.options).map((o) => ({ id: o.id, text: o.text }));
  if (q.type === 'matching') {
    options = withIds(q.pairs).map((p) => ({ id: p.id, text: p.text, answer: p.answer }));
    settings.distractors = [...new Map(q.distractors.map((d) => [normalizeText(d), d])).values()];
  }
  if (q.type === 'essay') {
    settings.minWords = q.minWords;
    settings.maxWords = q.maxWords;
    settings.graderNotes = q.graderNotes?.trim() || null;
  }
  const textual = q.type === 'short' || q.type === 'numeric';
  return {
    type: q.type,
    name: q.name,
    prompt: q.prompt,
    points: q.points,
    options: JSON.stringify(options),
    acceptedAnswers: JSON.stringify(textual ? q.acceptedAnswers : []),
    tolerance: q.type === 'numeric' ? q.tolerance : null,
    explanation: q.explanation?.trim() || null,
    settings: JSON.stringify(settings),
  };
}
