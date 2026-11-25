/**
 * Course completion, certificates and badges: API shapes and presets shared by the server and the web UI.
 */
import type { ActivityType, CourseRef, PublicUser } from './types.js';

/** `all`: every activity that tracks completion. `selected`: a chosen set of required activities. */
export type CompletionCriteriaMode = 'all' | 'selected';

export interface CertificateSettings {
  enabled: boolean;
  title: string;
  /** Text with placeholders such as {name}, {course}, {date} and {code}. */
  body: string;
  signatureName: string;
  signatureTitle: string;
}

export interface CourseCompletionSettings {
  enabled: boolean;
  mode: CompletionCriteriaMode;
  /** Required activities when `mode` is `selected`. */
  activityIds: string[];
  /** Minimum course total (percentage, 0-100), or null for no grade requirement. */
  minGrade: number | null;
  certificate: CertificateSettings;
  updatedAt: string | null;
}

/** An activity as the completion settings list it. Only tracked activities count towards completion. */
export interface CompletionActivityOption {
  id: string;
  title: string;
  type: ActivityType;
  sectionTitle: string;
  /** Visible, in a visible section and with completion tracking on. */
  tracked: boolean;
  visible: boolean;
  completion: 'none' | 'manual' | 'auto';
}

export interface CourseCompletionSettingsResponse {
  settings: CourseCompletionSettings;
  activities: CompletionActivityOption[];
}

export interface SaveCompletionSettingsResult {
  settings: CourseCompletionSettings;
  /** Students who completed the course because of this change. */
  newlyCompleted: number;
  /** Certificates issued to people who had already completed the course. */
  certificatesIssued: number;
}

export type CompletionCriterion =
  | { kind: 'activity'; activityId: string; title: string; type: ActivityType; done: boolean }
  | { kind: 'grade'; minGrade: number; current: number | null; met: boolean };

export interface CertificateRef {
  id: string;
  code: string;
  revoked: boolean;
}

/** The signed-in student's completion status in one course. */
export interface CourseCompletionStatus {
  enabled: boolean;
  completed: boolean;
  completedAt: string | null;
  criteria: CompletionCriterion[];
  /** Share of criteria met, 0-100. */
  progress: number;
  certificate: CertificateRef | null;
  certificateEnabled: boolean;
}

export interface CompletionReportRow {
  user: PublicUser & { email: string };
  activitiesDone: number;
  activitiesTotal: number;
  /** 0-100 over all criteria. */
  progress: number;
  /** Course total (percentage), or null when nothing is graded yet. */
  grade: number | null;
  gradeMet: boolean | null;
  completedAt: string | null;
  certificate: CertificateRef | null;
}

export interface CompletionReport {
  enabled: boolean;
  mode: CompletionCriteriaMode;
  minGrade: number | null;
  certificateEnabled: boolean;
  activities: Array<{ id: string; title: string; type: ActivityType }>;
  summary: { students: number; completed: number; inProgress: number; notStarted: number };
  rows: CompletionReportRow[];
}

/** A certificate as listed for its owner or for teachers. */
export interface CertificateSummary {
  id: string;
  code: string;
  course: CourseRef | null;
  courseTitle: string;
  recipient: PublicUser;
  recipientName: string;
  completedAt: string;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

/** Everything needed to render the printable certificate. */
export interface Certificate extends CertificateSummary {
  title: string;
  body: string;
  signatureName: string;
  signatureTitle: string;
  siteName: string;
  /** The viewer may revoke or restore it. */
  canManage: boolean;
}

/** What the public verification page shows: nothing beyond name, course, date and validity. */
export interface CertificateVerification {
  code: string;
  valid: boolean;
  status: 'valid' | 'revoked';
  recipientName: string;
  courseTitle: string;
  completedAt: string;
}

export const BADGE_ICONS = [
  'award',
  'medal',
  'trophy',
  'star',
  'rocket',
  'flame',
  'zap',
  'crown',
  'gem',
  'heart',
  'lightbulb',
  'target',
  'graduation-cap',
  'book-open',
  'code',
  'puzzle',
  'brain',
  'sparkles',
  'message-circle',
  'globe',
] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];

export const BADGE_COLORS = ['gold', 'silver', 'bronze', 'indigo', 'violet', 'sky', 'teal', 'emerald', 'rose', 'fuchsia'] as const;
export type BadgeColor = (typeof BADGE_COLORS)[number];

/** `manual`: awarded by staff. `completion`: completing the badge's course. `courses`: completing every listed course (site badges). */
export type BadgeCriteria = 'manual' | 'completion' | 'courses';

export interface BadgeSummary {
  id: string;
  /** null for site badges. */
  course: CourseRef | null;
  name: string;
  description: string;
  icon: BadgeIcon;
  color: BadgeColor;
  criteria: BadgeCriteria;
  /** Courses to complete (site badges with `courses` criteria). */
  criteriaCourses: CourseRef[];
  /** Active awards; only counted for staff. */
  recipientCount: number | null;
  /** When the viewer (or the user asked about) earned it. */
  earnedAt: string | null;
  createdAt: string;
}

export interface BadgeRecipient {
  user: PublicUser & { email: string | null };
  awardedAt: string;
  /** null when it was awarded automatically. */
  awardedBy: PublicUser | null;
  note: string | null;
  revokedAt: string | null;
}

export interface BadgeDetail extends BadgeSummary {
  /** The viewer's own award note, when they earned it. */
  earnedNote: string | null;
  canManage: boolean;
  canAward: boolean;
  /** Only for staff (people who may award the badge). */
  recipients: BadgeRecipient[] | null;
}

export interface EarnedBadge {
  badge: BadgeSummary;
  awardedAt: string;
  note: string | null;
}

export const CERTIFICATE_PLACEHOLDERS = [
  { key: '{name}', label: "Student's name" },
  { key: '{course}', label: 'Course title' },
  { key: '{date}', label: 'Completion date' },
  { key: '{code}', label: 'Verification code' },
  { key: '{site}', label: 'Site name' },
] as const;

export const DEFAULT_CERTIFICATE: CertificateSettings = {
  enabled: false,
  title: 'Certificate of Completion',
  body: 'This certifies that\n{name}\nhas successfully completed\n{course}\non {date}',
  signatureName: '',
  signatureTitle: '',
};

export interface CertificateValues {
  name: string;
  course: string;
  date: string;
  code: string;
  site: string;
}

/** Replaces {name}, {course}, {date}, {code} and {site}. Unknown placeholders are left as they are. */
export function fillCertificateText(template: string, values: CertificateValues): string {
  return template.replace(/\{(name|course|date|code|site)\}/g, (_, key: keyof CertificateValues) => values[key]);
}

/** Verification codes are 12 Crockford base32 characters, shown in groups of four: 7QK2-M9XD-4TPA. */
export function formatCertificateCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** Normalises what someone typed (any case, spaces, dashes, O for 0, I or L for 1). Returns null if it can't be a code. */
export function normalizeCertificateCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE_PATTERN.test(code) ? code : null;
}
