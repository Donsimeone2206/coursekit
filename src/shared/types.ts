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
export type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short' | 'numeric';

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
  status: 'in_progress' | 'finished';
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
  options: QuestionOption[];
  /** short/numeric: accepted answers (editors and review only). */
  acceptedAnswers?: string[];
  /** numeric: allowed +/- error (editors and review only). */
  tolerance?: number | null;
  explanation?: string | null;
}

export interface AttemptAnswer {
  optionIds?: string[];
  text?: string;
}

export interface QuestionResult {
  correct: boolean;
  partial: boolean;
  points: number;
  maxPoints: number;
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
  results: Record<string, QuestionResult> | null;
  passingPercent: number | null;
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
}

export interface GradebookItem {
  activityId: string;
  title: string;
  type: ActivityType;
  maxGrade: number;
  dueAt: string | null;
}

export interface GradebookCell {
  score: number | null;
  feedback: string | null;
}

export interface GradebookRow {
  user: PublicUser & { email: string };
  cells: Record<string, GradebookCell>;
  total: number;
  max: number;
  percentage: number | null;
}

export interface Gradebook {
  items: GradebookItem[];
  rows: GradebookRow[];
  averages: Record<string, number | null>;
  courseAverage: number | null;
}

export interface MyGrades {
  items: Array<GradebookItem & { score: number | null; feedback: string | null; gradedAt: string | null }>;
  total: number;
  max: number;
  percentage: number | null;
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
