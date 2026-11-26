/** Turning Moodle-style answers (with fractions) into Coursekit questions. Shared by the GIFT and Moodle XML readers. */
import { formatNumber } from './types.js';

export const FULL = 99.999;

/** Moodle grades answers in percent; Coursekit's single choice has one right answer, multiple choice equal shares. */
export function choiceOptions(
  single: boolean,
  answers: Array<{ text: string; fraction: number }>,
  warn: (message: string) => void,
): { type: 'single' | 'multiple'; options: Array<{ text: string; correct: boolean }> } {
  if (!single) {
    const positive = answers.filter((a) => a.fraction > 0).map((a) => a.fraction);
    if (positive.length > 1 && Math.max(...positive) - Math.min(...positive) > 0.01) {
      warn('The right answers had different weights. Coursekit gives each right answer an equal share of the marks.');
    }
    return { type: 'multiple', options: answers.map((a) => ({ text: a.text, correct: a.fraction > 0 })) };
  }
  let right = answers.findIndex((a) => a.fraction >= FULL);
  if (answers.filter((a) => a.fraction >= FULL).length > 1) {
    warn('More than one answer was fully right. Coursekit keeps the first one as the right answer.');
  }
  if (right < 0) {
    const best = Math.max(0, ...answers.map((a) => a.fraction));
    if (best > 0) {
      right = answers.findIndex((a) => a.fraction === best);
      warn(`No answer was worth 100%, so the best one (${formatNumber(best)}%) is marked as the right answer.`);
    }
  } else if (answers.some((a) => a.fraction > 0 && a.fraction < FULL)) {
    warn('Partial credit for single-answer questions isn’t supported. Answers worth less than 100% now count as wrong.');
  }
  return { type: 'single', options: answers.map((a, i) => ({ text: a.text, correct: i === right })) };
}

/** Coursekit has one margin of error for all of a numerical question's answers. */
export function numericAnswers(
  answers: Array<{ value: number; tolerance: number; fraction: number }>,
  warn: (message: string) => void,
): { acceptedAnswers: string[]; tolerance: number | null } {
  const accepted = answers.filter((a) => a.fraction >= FULL);
  if (answers.some((a) => a.fraction > 0 && a.fraction < FULL)) {
    warn('Answers worth less than 100% aren’t supported and were left out.');
  }
  const tolerances = [...new Set(accepted.map((a) => Math.abs(a.tolerance)))];
  const tolerance = tolerances.length ? Number(formatNumber(Math.max(...tolerances))) : 0;
  if (tolerances.length > 1) {
    warn(`The answers had different margins of error. Coursekit uses one for all of them: ±${formatNumber(tolerance)}.`);
  }
  return { acceptedAnswers: [...new Set(accepted.map((a) => formatNumber(a.value)))], tolerance: accepted.length ? tolerance : null };
}
