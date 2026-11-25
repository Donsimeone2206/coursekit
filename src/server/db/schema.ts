/**
 * Kysely table types. Columns are snake_case in the database and camelCase here
 * (Kysely's CamelCasePlugin maps between them). Booleans are stored as 0/1 integers,
 * timestamps as ISO-8601 strings and structured values as JSON text, which keeps the
 * schema portable between SQLite and PostgreSQL.
 */
import type { Insertable, Selectable } from 'kysely';
import type {
  ActivityType,
  CompletionMode,
  CourseRole,
  CourseVisibility,
  EnrolmentMethod,
  QuestionType,
  SiteRole,
  UserStatus,
} from '../../shared/types.js';

export interface SettingsTable {
  key: string;
  value: string;
}

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: SiteRole;
  avatarUrl: string | null;
  bio: string | null;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionsTable {
  id: string;
  userId: string;
  impersonatorId: string | null;
  expiresAt: string;
  createdAt: string;
  userAgent: string | null;
}

export interface CategoriesTable {
  id: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  createdAt: string;
}

export interface CoursesTable {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  categoryId: string | null;
  coverColor: string;
  coverImageUrl: string | null;
  visibility: CourseVisibility;
  enrolment: EnrolmentMethod;
  enrolmentKey: string | null;
  startDate: string | null;
  endDate: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrolmentsTable {
  id: string;
  courseId: string;
  userId: string;
  role: CourseRole;
  status: 'active' | 'suspended';
  lastAccessAt: string | null;
  createdAt: string;
}

export interface SectionsTable {
  id: string;
  courseId: string;
  title: string;
  summary: string;
  position: number;
  visible: number;
  createdAt: string;
}

export interface ActivitiesTable {
  id: string;
  courseId: string;
  sectionId: string;
  type: ActivityType;
  title: string;
  description: string;
  position: number;
  visible: number;
  /** JSON, shape depends on `type`. */
  settings: string;
  dueAt: string | null;
  maxGrade: number | null;
  completion: CompletionMode;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompletionsTable {
  activityId: string;
  userId: string;
  courseId: string;
  completedAt: string;
}

export interface FilesTable {
  id: string;
  ownerId: string | null;
  courseId: string | null;
  context: 'course' | 'activity' | 'submission' | 'avatar' | 'post';
  name: string;
  mime: string;
  size: number;
  storageKey: string;
  createdAt: string;
}

export interface SubmissionsTable {
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  text: string | null;
  /** JSON array of file ids. */
  fileIds: string;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GradesTable {
  activityId: string;
  userId: string;
  courseId: string;
  score: number | null;
  feedback: string | null;
  gradedBy: string | null;
  gradedAt: string | null;
  updatedAt: string;
}

export interface QuestionsTable {
  id: string;
  activityId: string;
  type: QuestionType;
  prompt: string;
  points: number;
  /** JSON array of { id, text, correct }. */
  options: string;
  /** JSON array of strings. */
  acceptedAnswers: string;
  tolerance: number | null;
  explanation: string | null;
  position: number;
}

export interface QuizAttemptsTable {
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  attemptNumber: number;
  status: 'in_progress' | 'finished';
  /** JSON array of question ids. */
  questionOrder: string;
  /** JSON object keyed by question id. */
  answers: string;
  /** JSON object keyed by question id, set when finished. */
  results: string | null;
  score: number | null;
  maxScore: number;
  startedAt: string;
  deadlineAt: string | null;
  finishedAt: string | null;
}

export interface DiscussionsTable {
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  title: string;
  pinned: number;
  locked: number;
  replyCount: number;
  lastPostAt: string;
  createdAt: string;
}

export interface PostsTable {
  id: string;
  discussionId: string;
  courseId: string;
  userId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementsTable {
  id: string;
  courseId: string;
  userId: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface NotificationsTable {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CalendarEventsTable {
  id: string;
  courseId: string | null;
  userId: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Database {
  settings: SettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  categories: CategoriesTable;
  courses: CoursesTable;
  enrolments: EnrolmentsTable;
  sections: SectionsTable;
  activities: ActivitiesTable;
  completions: CompletionsTable;
  files: FilesTable;
  submissions: SubmissionsTable;
  grades: GradesTable;
  questions: QuestionsTable;
  quizAttempts: QuizAttemptsTable;
  discussions: DiscussionsTable;
  posts: PostsTable;
  announcements: AnnouncementsTable;
  notifications: NotificationsTable;
  calendarEvents: CalendarEventsTable;
}

export type UserRow = Selectable<UsersTable>;
export type SessionRow = Selectable<SessionsTable>;
export type CourseRow = Selectable<CoursesTable>;
export type EnrolmentRow = Selectable<EnrolmentsTable>;
export type SectionRow = Selectable<SectionsTable>;
export type ActivityRow = Selectable<ActivitiesTable>;
export type FileRow = Selectable<FilesTable>;
export type SubmissionRow = Selectable<SubmissionsTable>;
export type GradeRow = Selectable<GradesTable>;
export type QuestionRow = Selectable<QuestionsTable>;
export type QuizAttemptRow = Selectable<QuizAttemptsTable>;
export type DiscussionRow = Selectable<DiscussionsTable>;
export type PostRow = Selectable<PostsTable>;
export type NewActivity = Insertable<ActivitiesTable>;
