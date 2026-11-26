import type { z } from 'zod';
import type { QuestionFileFormat, QuestionImportIssue } from '../../../shared/question-sharing.js';
import type { QuestionType } from '../../../shared/types.js';
import type { questionInputSchema } from '../question-types.js';

/** A question as an import file describes it, before validation. */
export type ImportedQuestionInput = z.input<typeof questionInputSchema> & { type: QuestionType };

export interface ParsedQuestion {
  /** 1-based position among the file's questions (categories aren't counted). */
  number: number;
  line: number | null;
  /** Category path from the file, relative to the bank (empty: none given). */
  category: string[];
  input: ImportedQuestionInput;
}

export interface ParsedCategory {
  path: string[];
  description: string;
}

export interface ParseResult {
  format: QuestionFileFormat;
  questions: ParsedQuestion[];
  /** Categories the file declares, in file order (they may have no questions). */
  categories: ParsedCategory[];
  /** Questions in the file that can't be imported (unsupported types, errors). */
  skipped: number;
  warnings: QuestionImportIssue[];
  errors: QuestionImportIssue[];
}

/** A bank question to export, with the path of its category in its bank. */
export interface ExportItem {
  id: string;
  type: QuestionType;
  name: string;
  prompt: string;
  points: number;
  options: Array<{ id: string; text: string; correct?: boolean; answer?: string }>;
  acceptedAnswers: string[];
  tolerance: number | null;
  explanation: string | null;
  settings: { minWords?: number | null; maxWords?: number | null; graderNotes?: string | null; distractors?: string[] };
  category: string[];
  categoryDescription: string;
}

/** Formats a fraction or tolerance without float noise (0.1 + 0.2 → 0.3). */
export function formatNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/** Equal shares of 100% for `count` right answers, as Moodle writes them (33.33333). */
export function sharePercent(count: number): number {
  return Number((100 / Math.max(1, count)).toFixed(5));
}
