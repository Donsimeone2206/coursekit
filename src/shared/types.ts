/**
 * Data shapes returned by the Coursekit REST API. Shared by the server and the web UI.
 */
import type { CourseCapability } from './permissions.js';

export type SiteRole = 'admin' | 'instructor' | 'student';
export type CourseRole = 'teacher' | 'assistant' | 'student';
export type UserStatus = 'active' | 'suspended';
export type CourseVisibility = 'draft' | 'published' | 'archived';
export type EnrolmentMethod = 'open' | 'key' | 'invite';
export type ActivityType = 'lesson' | 'resource' | 'assignment' | 'quiz' | 'forum';
export type CompletionMode = 'none' | 'manual' | 'auto';
export type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short' | 'numeric' | 'essay' | 'matching' | 'ordering';

export interface PublicUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface User extends PublicUser {
  email: string;
  role: SiteRole;
  bio: string | null;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SiteSettings {
  name: string;
  tagline: string;
  brandColor: string;
  allowSignup: boolean;
  welcomeMessage: string;
}

export interface SessionInfo {
  user: User | null;
  impersonator: PublicUser | null;
  site: SiteSettings;
  needsSetup: boolean;
  version: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  courseCount: number;
}

export interface CourseRef {
  id: string;
  slug: string;
  title: string;
  coverColor: string;
}

export interface CourseSummary extends CourseRef {
  summary: string;
  categoryId: string | null;
  categoryName: string | null;
  coverImageUrl: string | null;
  visibility: CourseVisibility;
  enrolment: EnrolmentMethod;
  startDate: string | null;
  endDate: string | null;
  teachers: PublicUser[];
  studentCount: number;
  activityCount: number;
  myRole: CourseRole | null;
  /** 0-100 for enrolled students, null otherwise. */
  progress: number | null;
  lastAccessAt: string | null;
}

export interface CourseDetail extends CourseSummary {
  description: string;
  capabilities: CourseCapability[];
  sections: Section[];
  hasEnrolmentKey: boolean;
  /** Only returned to people who can update the course. */
  enrolmentKey: string | null;
  canEnrol: boolean;
  /** True when the viewer can only see the outline (not enrolled). */
  outlineOnly: boolean;
  /** The viewer's own groups in this course. */
  myGroups?: GroupRef[];
}

export interface Section {
  id: string;
  title: string;
  summary: string;
  position: number;
  visible: boolean;
  activities: ActivitySummary[];
}

export interface ActivitySummary {
  id: string;
  courseId: string;
  sectionId: string;
  type: ActivityType;
  title: string;
  visible: boolean;
  position: number;
  dueAt: string | null;
  maxGrade: number | null;
  completion: CompletionMode;
  completed: boolean;
  /** Short subtitle, e.g. "12 min read" or "8 questions". */
  meta: string | null;
}

export interface LessonSettings {
  body: string;
  videoUrl: string | null;
  estimatedMinutes: number | null;
}

export interface ResourceSettings {
  kind: 'file' | 'link';
  fileId: string | null;
  url: string | null;
}

export interface AssignmentSettings {
  submissionTypes: Array<'text' | 'file'>;
  allowLate: boolean;
  maxFiles: number;
}

export interface QuizSettings {
  timeLimitMinutes: number | null;
  /** 0 means unlimited. */
  attemptsAllowed: number;
  gradingMethod: 'highest' | 'last' | 'average';
  shuffleQuestions: boolean;
  /** When students can see correct answers. */
  reviewMode: 'immediate' | 'after_due' | 'score_only';
  passingPercent: number | null;
}

export interface ForumSettings {
  studentsCanStartDiscussions: boolean;
}

export interface ActivitySettingsMap {
  lesson: LessonSettings;
  resource: ResourceSettings;
  assignment: AssignmentSettings;
  quiz: QuizSettings;
  forum: ForumSettings;
}

export interface ActivityNavItem {
  id: string;
  title: string;
  type: ActivityType;
}

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
  createdAt: string;
}

export interface Grade {
  score: number | null;
  maxGrade: number;
  feedback: string | null;
  gradedBy: PublicUser | null;
  gradedAt: string | null;
}

export interface Submission {
  id: string;
  activityId: string;
  user: PublicUser;
  text: string | null;
  files: FileInfo[];
  submittedAt: string;
  late: boolean;
}

export interface QuizAttemptSummary {
  id: string;
  attemptNumber: number;
  /** `needs_grading`: submitted, waiting for a teacher to mark essays (the score is pending). */
  status: 'in_progress' | 'needs_grading' | 'finished';
  startedAt: string;
  finishedAt: string | null;
  score: number | null;
  maxScore: number;
  user?: PublicUser;
}

export interface QuizInfo {
  questionCount: number;
  totalPoints: number;
  attempts: QuizAttemptSummary[];
  attemptsUsed: number;
  canAttempt: boolean;
  inProgressAttemptId: string | null;
  /** Staff only: students' attempts waiting for essays to be marked. */
  needsGrading?: number;
}

export interface ActivityDetail<T extends ActivityType = ActivityType> extends ActivitySummary {
  type: T;
  description: string;
  settings: ActivitySettingsMap[T];
  course: CourseRef;
  sectionTitle: string;
  capabilities: CourseCapability[];
  myRole: CourseRole | null;
  prev: ActivityNavItem | null;
  next: ActivityNavItem | null;
  /** resource */
  file?: FileInfo | null;
  /** assignment: the viewer's own submission */
  submission?: Submission | null;
  /** assignment/quiz: the viewer's own grade */
  grade?: Grade | null;
  /** assignment: summary for teachers */
  submissionStats?: { participants: number; submitted: number; needsGrading: number };
  quiz?: QuizInfo;
  forum?: { discussionCount: number; postCount: number };
}

export interface QuestionOption {
  id: string;
  text: string;
  /** Only present for editors or in review. */
  correct?: boolean;
}

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  points: number;
  /** Choices; for ordering, the items (shown order during an attempt, right order for editors and in review). */
  options: QuestionOption[];
  /** short/numeric: accepted answers (editors and review only). */
  acceptedAnswers?: string[];
  /** numeric: allowed +/- error (editors and review only). */
  tolerance?: number | null;
  explanation?: string | null;
  /** matching: the items to match; `answer` and `answerId` only for editors and in review. */
  pairs?: MatchPair[];
  /** matching: the answers to choose from, in display order (distractors included). */
  choices?: QuestionOption[];
  /** matching: extra wrong answers (editors only). */
  distractors?: string[];
  /** essay: suggested length. */
  minWords?: number | null;
  maxWords?: number | null;
  /** essay: information for graders (staff only, never sent to students). */
  graderNotes?: string | null;
}

export interface AttemptAnswer {
  optionIds?: string[];
  text?: string;
  /** ordering: item ids in the student's order. */
  order?: string[];
  /** matching: chosen answer id for each item id. */
  matches?: Record<string, string>;
}

export interface QuestionResult {
  correct: boolean;
  partial: boolean;
  points: number;
  maxPoints: number;
  /** essay: waiting for a teacher's mark. */
  pending?: boolean;
  /** Manual grading: the grader's comment for the student. */
  comment?: string | null;
  gradedBy?: PublicUser | null;
  gradedAt?: string | null;
}

export interface QuizAttempt extends QuizAttemptSummary {
  activityId: string;
  quizTitle: string;
  course: CourseRef;
  deadlineAt: string | null;
  questions: Question[];
  answers: Record<string, AttemptAnswer>;
  /** Whether correct answers are included. */
  review: boolean;
  /** Per-question results; without review only manually graded (essay) results are included. */
  results: Record<string, QuestionResult> | null;
  passingPercent: number | null;
  /** Essays still waiting for a mark. */
  pendingCount: number;
  /** The viewer may mark essays in this attempt. */
  canGrade: boolean;
}

export interface Discussion {
  id: string;
  activityId: string;
  title: string;
  author: PublicUser;
  pinned: boolean;
  locked: boolean;
  createdAt: string;
  lastPostAt: string;
  replyCount: number;
  excerpt: string;
}

export interface Post {
  id: string;
  parentId: string | null;
  author: PublicUser;
  authorRole: CourseRole | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
}

export interface DiscussionDetail extends Discussion {
  posts: Post[];
  canReply: boolean;
  canModerate: boolean;
  course: CourseRef;
  activityTitle: string;
}

export interface Announcement {
  id: string;
  course: CourseRef;
  title: string;
  body: string;
  author: PublicUser;
  createdAt: string;
}

export interface Participant {
  enrolmentId: string;
  user: PublicUser & { email: string | null };
  role: CourseRole;
  status: 'active' | 'suspended';
  enrolledAt: string;
  lastAccessAt: string | null;
  progress: number | null;
  /** The person's groups, limited to the groups the viewer may see (students only see their own). */
  groups?: GroupRef[];
}

export interface GradebookItem {
  activityId: string;
  title: string;
  type: ActivityType;
  maxGrade: number;
  dueAt: string | null;
  /** The grade category the item counts in (the default category's id is the course id). */
  categoryId: string;
  /** Weight within its category in weighted aggregation; null means "by points" (the item's max grade). */
  weight: number | null;
}

export interface GradebookCell {
  score: number | null;
  feedback: string | null;
  /** Left out of the totals by its category's "drop the lowest" rule. */
  dropped: boolean;
}

export interface GradebookRow {
  user: PublicUser & { email: string };
  cells: Record<string, GradebookCell>;
  /** Points earned and possible on the work that counts (after drop-lowest). The natural total is total / max. */
  total: number;
  max: number;
  /** The course total, 0-100 with 2 decimals, or null when nothing is graded yet. */
  percentage: number | null;
  /** Category subtotals, keyed by category id. */
  categories: Record<string, GradeCategoryResult>;
}

export interface Gradebook {
  items: GradebookItem[];
  rows: GradebookRow[];
  averages: Record<string, number | null>;
  courseAverage: number | null;
  aggregation: GradeAggregation;
  /** Every category in order, including the default one (even when empty). */
  categories: GradeCategory[];
  /** Average category subtotal per category id. */
  categoryAverages: Record<string, number | null>;
}

export interface MyGrades {
  items: Array<GradebookItem & { score: number | null; feedback: string | null; gradedAt: string | null; dropped: boolean }>;
  total: number;
  max: number;
  percentage: number | null;
  aggregation: GradeAggregation;
  categories: Array<GradeCategory & GradeCategoryResult>;
}

/**
 * How the course total is calculated. "natural" adds up points (what 0.1.x did, and the default);
 * "weighted" makes each category worth a share of the total.
 */
export type GradeAggregation = 'natural' | 'weighted';

export interface GradeCategory {
  id: string;
  name: string;
  /** Share of the course total in weighted aggregation, 0-100. Normalised over the categories that have grades. */
  weight: number;
  /** Leave out this many of the lowest graded items (at least one graded item always counts). */
  dropLowest: number;
  position: number;
  /** Activities that aren't assigned to a category count here. Its id is the course id and it can't be deleted. */
  isDefault: boolean;
}

export interface GradeCategoryResult {
  /** Category subtotal, 0-100 with 2 decimals, or null when nothing in it counts yet. */
  percentage: number | null;
  /** Points earned and possible on the items that count (after drop-lowest). Weighted courses may also use item weights. */
  earned: number;
  possible: number;
  /** Share of the course total this category carries right now (0-100), or null when it doesn't count. */
  share: number | null;
}

/** A graded activity as the gradebook setup sees it. */
export interface GradeItemSetting {
  activityId: string;
  title: string;
  type: ActivityType;
  maxGrade: number;
  visible: boolean;
  sectionTitle: string;
  categoryId: string;
  weight: number | null;
}

export interface GradebookSetup {
  aggregation: GradeAggregation;
  categories: GradeCategory[];
  /** Every graded activity (hidden ones too) in course order. */
  items: GradeItemSetting[];
}

/** Body of `PUT /courses/:id/grades/setup`. Categories are listed in display order; new ones use any temporary id. */
export interface GradebookSetupInput {
  aggregation: GradeAggregation;
  categories: Array<{ id: string; name: string; weight: number; dropLowest: number }>;
  items?: Array<{ activityId: string; categoryId: string; weight: number | null }>;
}

export interface TimelineItem {
  activityId: string;
  title: string;
  type: ActivityType;
  course: CourseRef;
  dueAt: string;
  status: 'todo' | 'overdue' | 'submitted' | 'graded' | 'done';
}

export interface DashboardData {
  courses: CourseSummary[];
  timeline: TimelineItem[];
  announcements: Announcement[];
  recentGrades: Array<{
    activityId: string;
    title: string;
    type: ActivityType;
    course: CourseRef;
    score: number;
    maxGrade: number;
    gradedAt: string;
  }>;
  toGrade: Array<{ activityId: string; title: string; course: CourseRef; count: number }>;
  stats: {
    enrolled: number;
    teaching: number;
    completedActivities: number;
    averageGrade: number | null;
    dueThisWeek: number;
  };
}

export interface CalendarEvent {
  id: string;
  title: string;
  kind: 'due' | 'course' | 'personal' | 'course-start' | 'course-end';
  startsAt: string;
  endsAt: string | null;
  description: string | null;
  course: CourseRef | null;
  link: string | null;
  canDelete: boolean;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SearchResults {
  courses: CourseRef[];
  activities: Array<{ id: string; title: string; type: ActivityType; course: CourseRef }>;
  users: Array<PublicUser & { email: string }>;
}

export interface AdminOverview {
  counts: {
    users: number;
    courses: number;
    enrolments: number;
    activities: number;
    submissions: number;
    posts: number;
  };
  signups: Array<{ date: string; count: number }>;
  topCourses: Array<CourseRef & { students: number }>;
  recentUsers: User[];
  database: string;
  version: string;
}

export interface AdminUserRow extends User {
  courseCount: number;
}

export interface AdminCourseRow extends CourseRef {
  visibility: CourseVisibility;
  categoryName: string | null;
  teachers: PublicUser[];
  studentCount: number;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error: {
    message: string;
    code: string;
    issues?: Array<{ path: string; message: string }>;
  };
}

export interface GroupRef {
  id: string;
  name: string;
}

export interface GroupMember extends PublicUser {
  role: CourseRole;
  status: 'active' | 'suspended';
}

export interface CourseGroup extends GroupRef {
  description: string;
  /** Enrolled members. Students only see the active members of their own groups. */
  members: GroupMember[];
  createdAt: string;
}

export interface CourseGroups {
  groups: CourseGroup[];
  /** Whether the viewer can create, rename and delete groups and change who is in them. */
  canManage: boolean;
  /** False when the viewer only sees the groups they belong to (students). */
  allGroups: boolean;
}

export interface GroupMembersAdded {
  /** User ids added to the group. */
  added: string[];
  alreadyMembers: string[];
  /** Ids of people who aren't enrolled in the course, so can't join its groups. */
  notEnrolled: string[];
}

export interface CohortSummary {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  /** Courses the cohort is linked to. */
  courseCount: number;
  createdAt: string;
}

export interface CohortLink {
  id: string;
  cohort: { id: string; name: string; memberCount: number };
  course: CourseRef;
  /** The course role linked members are enrolled with. */
  role: CourseRole;
  createdAt: string;
}

export interface CohortDetail extends CohortSummary {
  links: CohortLink[];
}

export interface CohortMember extends PublicUser {
  email: string;
  status: UserStatus;
  addedAt: string;
}

/** A person found when searching for people to add to a cohort. */
export interface CohortCandidate extends PublicUser {
  email: string;
  member: boolean;
}

export interface CohortMembersAdded {
  added: number;
  /** Emails (or ids) of people who were already in the cohort. */
  alreadyMembers: string[];
  /** Emails (or ids) with no account on the site. */
  notFound: string[];
  /** Entries that aren't email addresses. */
  invalid: string[];
  /** New course enrolments made through the cohort's linked courses. */
  enrolled: number;
}

export interface CohortOption {
  id: string;
  name: string;
  memberCount: number;
}

export interface MatchPair {
  id: string;
  text: string;
  /** The matching answer (editors and review only). */
  answer?: string;
  /** Id of the right choice (review only). */
  answerId?: string;
}

export interface QuestionCategory {
  id: string;
  courseId: string;
  parentId: string | null;
  name: string;
  description: string;
  position: number;
  /** Questions directly in this category. */
  questionCount: number;
  createdAt: string;
}

export interface QuestionUsage {
  activityId: string;
  title: string;
  /** `question`: added to the quiz; `random`: in the pool of one of its random slots. */
  kind: 'question' | 'random';
}

/** A question bank entry with its answers (staff only). */
export interface BankQuestion extends Question {
  name: string;
  categoryId: string;
  createdAt: string;
  updatedAt: string;
  usage: QuestionUsage[];
}

export interface BankQuestionSummary {
  id: string;
  type: QuestionType;
  name: string;
  /** Plain-text preview of the prompt. */
  excerpt: string;
  points: number;
  categoryId: string;
  categoryName: string;
  /** Quizzes that use the question directly. */
  quizCount: number;
  updatedAt: string;
}

export interface QuizSlotInfo {
  id: string;
  kind: 'question' | 'random';
  /** Mark for each question in the slot. */
  points: number;
  /** 1 for a question slot. */
  questionCount: number;
  question: BankQuestionSummary | null;
  category: { id: string; name: string } | null;
  includeSubcategories: boolean;
  /** Random slots: questions available to pick from (not already in the quiz). */
  available: number | null;
  /** Random slots: questions needed from these categories by this and narrower random slots. */
  needed: number | null;
}

export interface QuizSlots {
  slots: QuizSlotInfo[];
  questionCount: number;
  totalPoints: number;
  /** Reasons an attempt couldn't start, e.g. too few questions for a random slot. */
  problems: string[];
}

export interface QuizGradingItem {
  attemptId: string;
  attemptNumber: number;
  user: PublicUser;
  finishedAt: string | null;
  /** Essays waiting for a mark. */
  pending: number;
}
