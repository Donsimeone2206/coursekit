/**
 * Kysely table types. Columns are snake_case in the database and camelCase here
 * (Kysely's CamelCasePlugin maps between them). Booleans are stored as 0/1 integers,
 * timestamps as ISO-8601 strings and structured values as JSON text, which keeps the
 * schema portable between SQLite and PostgreSQL.
 */
import type { Generated, Insertable, Selectable } from 'kysely';
import type {
  ActivityType,
  CompletionMode,
  CourseRole,
  CourseVisibility,
  EnrolmentMethod,
  GroupMode,
  QuestionType,
  SiteRole,
  UserStatus,
} from '../../shared/types.js';
import type { EmailFrequency } from '../../shared/email.js';
import type {
  BadgeAwardsTable,
  BadgesTable,
  CertificatesTable,
  CourseCompletionSettingsTable,
  CourseCompletionsTable,
} from './schema-completion.js';
import type { OpenBadgeSharesTable } from './schema-open-badges.js';
import type { Cmi5AuStatesTable, Cmi5SatisfiedTable, Cmi5SessionsTable } from './schema-cmi5.js';
import type { LtiAccessTokensTable, LtiLineItemsTable, LtiScoresTable, LtiToolsTable, LtiUsedTokensTable } from './schema-lti.js';
import type { LtiRegistrationsTable } from './schema-lti.js';
import type {
  PackageAttemptsTable,
  PackageFilesTable,
  PackageScoStatesTable,
  PackageVersionsTable,
  XapiDocumentsTable,
  XapiStatementsTable,
} from './schema-packages.js';
import type { QuestionCategorySharesTable, QuizSlotPoolsTable } from './schema-question-sharing.js';
import type { LiveAttendanceTable, LivePresenceTable, LiveRecordingsTable, LiveRoomsTable, LiveSessionsTable } from './schema-live.js';
import type { PackageSequencingStatesTable } from './schema-sequencing.js';

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
  /** The course's default group mode (0.3.0). */
  groupMode: Generated<GroupMode>;
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
  /** The activity's own group mode; null follows the course (0.3.0). */
  groupMode: Generated<GroupMode | null>;
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
  /** The activity the file belongs to (a resource's file, submitted work, a forum post's upload); downloads follow its rules. */
  activityId: string | null;
  /** For a forum post's upload: the discussion it was posted in. */
  discussionId: string | null;
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

/** Per-course gradebook settings. A course without a row uses natural (points) aggregation. */
export interface GradeSettingsTable {
  courseId: string;
  aggregation: 'natural' | 'weighted';
  updatedAt: string;
}

/**
 * Grade categories. Each course has one default category whose id is the course id; it is
 * created the first time the setup is saved and stands in for activities without a category.
 */
export interface GradeCategoriesTable {
  id: string;
  courseId: string;
  name: string;
  /** Percentage of the course total in weighted aggregation. */
  weight: number;
  dropLowest: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Gradebook settings of one graded activity. Activities without a row are uncategorised and weighted by points. */
export interface GradeItemsTable {
  activityId: string;
  courseId: string;
  /** null = the course's default category. */
  categoryId: string | null;
  /** Weight within the category (used by weighted aggregation); null = the activity's max grade. */
  weight: number | null;
  updatedAt: string;
}

/** A question in a course's question bank. Quizzes use questions through quiz slots. */
export interface QuestionsTable {
  id: string;
  courseId: string;
  categoryId: string;
  type: QuestionType;
  /** Optional short name for the question bank; the prompt is shown when empty. */
  name: string;
  prompt: string;
  /** Default mark when the question is added to a quiz. */
  points: number;
  /** JSON array: choices { id, text, correct }, ordering items { id, text } in the right order, or matching pairs { id, text, answer }. */
  options: string;
  /** JSON array of strings. */
  acceptedAnswers: string;
  tolerance: number | null;
  explanation: string | null;
  /** JSON object: essay word limits and grader notes, matching distractors. */
  settings: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuizAttemptsTable {
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  attemptNumber: number;
  /** `needs_grading`: submitted, waiting for a teacher to mark essay answers. */
  status: 'in_progress' | 'needs_grading' | 'finished';
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
  /** JSON array of the questions as they were when the attempt started (see services/question-types.ts). */
  snapshot: Generated<string>;
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
  /** The group the discussion belongs to; null is for all participants (0.3.0). */
  groupId: Generated<string | null>;
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

export interface QuestionCategoriesTable {
  id: string;
  courseId: string;
  parentId: string | null;
  name: string;
  description: string;
  position: number;
  createdAt: string;
}

/** One entry in a quiz: a specific bank question, or `questionCount` random questions from a category. */
export interface QuizSlotsTable {
  id: string;
  activityId: string;
  position: number;
  kind: 'question' | 'random';
  questionId: string | null;
  categoryId: string | null;
  /** 1 for a question slot; how many questions to pick for a random slot. */
  questionCount: number;
  includeSubcategories: number;
  /** Mark for each question in the slot. */
  points: number;
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
  emailPreferences: EmailPreferencesTable;
  emailOutbox: EmailOutboxTable;
  courseGroups: CourseGroupsTable;
  courseGroupMembers: CourseGroupMembersTable;
  cohorts: CohortsTable;
  cohortMembers: CohortMembersTable;
  cohortCourses: CohortCoursesTable;
  courseCompletionSettings: CourseCompletionSettingsTable;
  courseCompletions: CourseCompletionsTable;
  certificates: CertificatesTable;
  badges: BadgesTable;
  badgeAwards: BadgeAwardsTable;
  questionCategories: QuestionCategoriesTable;
  quizSlots: QuizSlotsTable;
  questionCategoryShares: QuestionCategorySharesTable;
  quizSlotPools: QuizSlotPoolsTable;
  gradeSettings: GradeSettingsTable;
  gradeCategories: GradeCategoriesTable;
  gradeItems: GradeItemsTable;
  openBadgeShares: OpenBadgeSharesTable;
  ltiTools: LtiToolsTable;
  ltiLineItems: LtiLineItemsTable;
  ltiScores: LtiScoresTable;
  ltiAccessTokens: LtiAccessTokensTable;
  ltiUsedTokens: LtiUsedTokensTable;
  ltiRegistrations: LtiRegistrationsTable;
  activityGroups: ActivityGroupsTable;
  packageVersions: PackageVersionsTable;
  packageFiles: PackageFilesTable;
  packageAttempts: PackageAttemptsTable;
  packageScoStates: PackageScoStatesTable;
  xapiStatements: XapiStatementsTable;
  xapiDocuments: XapiDocumentsTable;
  cmi5Sessions: Cmi5SessionsTable;
  cmi5AuStates: Cmi5AuStatesTable;
  cmi5Satisfied: Cmi5SatisfiedTable;
  liveSessions: LiveSessionsTable;
  liveRooms: LiveRoomsTable;
  livePresence: LivePresenceTable;
  liveAttendance: LiveAttendanceTable;
  liveRecordings: LiveRecordingsTable;
  packageSequencingStates: PackageSequencingStatesTable;
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

export interface EmailPreferencesTable {
  userId: string;
  /** null follows the site default. */
  frequency: EmailFrequency | null;
  /** JSON array of email category ids. */
  disabledCategories: string;
  lastDigestAt: string | null;
  digestClaim: string | null;
  updatedAt: string;
}

export interface EmailOutboxTable {
  id: string;
  kind: 'notification' | 'digest' | 'test';
  userId: string | null;
  notificationId: string | null;
  toAddress: string;
  subject: string;
  html: string;
  text: string;
  /** JSON object of extra headers. */
  headers: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lockId: string | null;
  lockedUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EmailOutboxRow = Selectable<EmailOutboxTable>;

export interface CourseGroupsTable {
  id: string;
  courseId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** Group membership. Rows of people no longer enrolled are kept but hidden, and come back if they re-enrol. */
export interface CourseGroupMembersTable {
  groupId: string;
  userId: string;
  courseId: string;
  createdAt: string;
}

export interface CohortsTable {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CohortMembersTable {
  cohortId: string;
  userId: string;
  createdAt: string;
}

/** A cohort linked to a course: its members are enrolled with `role`, now and whenever they join the cohort later. */
export interface CohortCoursesTable {
  id: string;
  cohortId: string;
  courseId: string;
  role: CourseRole;
  createdBy: string | null;
  createdAt: string;
}

/** An activity limited to the members of some groups (no rows: everyone). `groupId` may name a deleted group. */
export interface ActivityGroupsTable {
  activityId: string;
  groupId: string;
  courseId: string;
  createdAt: string;
}

export type CourseGroupRow = Selectable<CourseGroupsTable>;
export type CohortRow = Selectable<CohortsTable>;
export type CohortCourseRow = Selectable<CohortCoursesTable>;
export type QuestionCategoryRow = Selectable<QuestionCategoriesTable>;
export type QuizSlotRow = Selectable<QuizSlotsTable>;
