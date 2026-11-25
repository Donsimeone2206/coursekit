import {
  ArrowDownUp,
  CircleCheckBig,
  Hash,
  ListChecks,
  type LucideIcon,
  PenLine,
  Shuffle,
  SquareCheckBig,
  TextCursorInput,
  ToggleLeft,
} from 'lucide-react';
import type { AttemptAnswer, Question, QuestionCategory, QuestionType } from '@shared/types';

export const QUESTION_TYPES: QuestionType[] = ['single', 'multiple', 'truefalse', 'short', 'numeric', 'essay', 'matching', 'ordering'];

export const TYPE_META: Record<QuestionType, { label: string; short: string; hint: string; icon: LucideIcon; tint: string }> = {
  single: {
    label: 'Multiple choice (one answer)',
    short: 'Single choice',
    hint: 'Choose one answer',
    icon: CircleCheckBig,
    tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
  multiple: {
    label: 'Multiple choice (several answers)',
    short: 'Multiple choice',
    hint: 'Select all that apply',
    icon: SquareCheckBig,
    tint: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  },
  truefalse: {
    label: 'True / false',
    short: 'True / false',
    hint: 'True or false',
    icon: ToggleLeft,
    tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  short: {
    label: 'Short answer',
    short: 'Short answer',
    hint: 'Type your answer',
    icon: TextCursorInput,
    tint: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  },
  numeric: {
    label: 'Numerical',
    short: 'Numerical',
    hint: 'Enter a number',
    icon: Hash,
    tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  essay: {
    label: 'Essay (marked by a teacher)',
    short: 'Essay',
    hint: 'Write your answer',
    icon: PenLine,
    tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  matching: {
    label: 'Matching',
    short: 'Matching',
    hint: 'Match each item to an answer',
    icon: Shuffle,
    tint: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
  ordering: {
    label: 'Ordering',
    short: 'Ordering',
    hint: 'Put the items in order',
    icon: ArrowDownUp,
    tint: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  },
};

export const RandomIcon = ListChecks;

/** A mark with up to two decimals, as the server rounds them (0.75, 2.5, 3). */
export function formatMark(value: number | null | undefined): string {
  return value == null || Number.isNaN(value) ? '–' : String(Math.round(value * 100) / 100);
}

export function wordCount(text: string | undefined | null): number {
  const t = (text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Outside the essay's suggested length (null when inside it or there's no limit). */
export function wordLimitIssue(q: Pick<Question, 'minWords' | 'maxWords'>, text: string | undefined): 'short' | 'long' | null {
  const n = wordCount(text);
  if (n === 0) return null;
  if (q.maxWords && n > q.maxWords) return 'long';
  if (q.minWords && n < q.minWords) return 'short';
  return null;
}

export function isAnswered(q: Question, a: AttemptAnswer | undefined): boolean {
  switch (q.type) {
    case 'short':
    case 'numeric':
    case 'essay':
      return !!a?.text?.trim();
    case 'matching':
      return (q.pairs ?? []).length > 0 && (q.pairs ?? []).every((p) => !!a?.matches?.[p.id]);
    case 'ordering':
      // The order shown is an answer too.
      return true;
    default:
      return !!a?.optionIds?.length;
  }
}

export interface CategoryOption extends QuestionCategory {
  depth: number;
}

/** Categories (already in tree order from the server) with their nesting depth. */
export function withDepth(categories: QuestionCategory[]): CategoryOption[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const depth = (c: QuestionCategory, seen = new Set<string>()): number => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (!parent || seen.has(parent.id)) return 0;
    seen.add(parent.id);
    return depth(parent, seen) + 1;
  };
  return categories.map((c) => ({ ...c, depth: depth(c) }));
}

/** The category and everything below it. */
export function subtree(categories: QuestionCategory[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of categories) if (c.parentId === out[i] && !out.includes(c.id)) out.push(c.id);
  return out;
}

export function indentLabel(c: CategoryOption): string {
  return `${'   '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.name}`;
}
