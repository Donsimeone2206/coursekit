/** Question import and export (GIFT, Moodle XML) and sharing questions between courses. */
import type { CourseRef, QuestionCategory, QuestionType } from './types.js';

export type QuestionFileFormat = 'gift' | 'moodle';

export const QUESTION_FILE_FORMATS: Record<QuestionFileFormat, { label: string; extension: string; mimeType: string }> = {
  moodle: { label: 'Moodle XML', extension: 'xml', mimeType: 'application/xml' },
  gift: { label: 'GIFT', extension: 'gift', mimeType: 'text/plain' },
};

/** Largest file that can be imported. */
export const MAX_IMPORT_BYTES = 3 * 1024 * 1024;
/** Most questions one import, export or copy can handle. */
export const MAX_TRANSFER_QUESTIONS = 2000;
/** Most categories one import or copy can create. */
export const MAX_TRANSFER_CATEGORIES = 200;

/** A problem found in an import file. `number` is the question's position in the file, `line` its first line. */
export interface QuestionImportIssue {
  number: number | null;
  line: number | null;
  message: string;
}

export interface QuestionImportRequest {
  content: string;
  filename?: string;
  /** Detected from the file name and content when left out. */
  format?: QuestionFileFormat;
  /** Where questions go; with `createCategories`, the parent of the file's categories (null: top level). */
  categoryId: string | null;
  /** Recreate the file's categories inside `categoryId`, or put everything into `categoryId`. */
  createCategories: boolean;
}

export interface QuestionImportPreview {
  format: QuestionFileFormat;
  /** Questions in the file. */
  found: number;
  /** Questions that will be imported. */
  ready: number;
  counts: Array<{ type: QuestionType; count: number }>;
  /** Target categories, in tree order. */
  categories: Array<{ label: string; isNew: boolean; questionCount: number }>;
  /** The questions that will be imported (the first 500). */
  questions: Array<{ number: number; line: number | null; type: QuestionType; label: string; category: string }>;
  warnings: QuestionImportIssue[];
  /** Questions with errors are skipped. */
  errors: QuestionImportIssue[];
}

export interface QuestionImportResult {
  imported: number;
  categoriesCreated: number;
  skipped: number;
}

export interface QuestionExportRequest {
  format: QuestionFileFormat;
  /** A category of this course's bank or one shared with it. Left out with no `questionIds`: the whole bank. */
  categoryId?: string;
  includeSubcategories?: boolean;
  questionIds?: string[];
}

export interface QuestionExportResult {
  filename: string;
  mimeType: string;
  content: string;
  exported: number;
  /** Questions the format can't hold (GIFT has no ordering questions). */
  skipped: Array<{ id: string; label: string; reason: string }>;
  /** What the format leaves out of the questions it holds. */
  notes: string[];
}

/** Where a shared question or category comes from. */
export interface SharedFrom {
  courseId: string;
  courseTitle: string;
}

/** A category of another course's bank that this course can use (read-only). */
export interface SharedQuestionCategory extends QuestionCategory {
  sharedFrom: SharedFrom;
}

export interface QuestionShare {
  id: string;
  categoryId: string;
  /** null: shared with every course on the site. */
  course: CourseRef | null;
  createdAt: string;
}

export interface QuestionShareSettings {
  category: { id: string; name: string; courseId: string };
  shares: QuestionShare[];
  /** Courses the viewer may share with (they manage those banks too). */
  courses: CourseRef[];
  /** Administrators can share with every course on the site. */
  canShareWithSite: boolean;
}

export interface QuestionCopyRequest {
  targetCourseId: string;
  /** Questions: the category they go into (default: the first one). A category: the new copy's parent (null: top level). */
  targetCategoryId?: string | null;
  questionIds?: string[];
  categoryId?: string;
  /** Category copies: include its subcategories (default true). */
  includeSubcategories?: boolean;
}

export interface QuestionCopyResult {
  questions: number;
  categories: number;
  /** The new category, for category copies. */
  categoryId: string | null;
}
