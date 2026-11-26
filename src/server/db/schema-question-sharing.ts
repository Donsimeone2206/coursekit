/** Tables for sharing question categories between courses (0.3.0, migration 010_question_sharing). */
import type { Selectable } from 'kysely';

/** A question category shared with another course (`courseId`), or with every course on the site (`courseId` null). */
export interface QuestionCategorySharesTable {
  id: string;
  categoryId: string;
  courseId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type QuestionCategoryShareRow = Selectable<QuestionCategorySharesTable>;

/**
 * The questions a random quiz slot keeps picking from after the share of another course's category it uses
 * ended (`questionIds`: JSON array). Ignored while the category is shared with the quiz's course again.
 */
export interface QuizSlotPoolsTable {
  slotId: string;
  questionIds: string;
}
