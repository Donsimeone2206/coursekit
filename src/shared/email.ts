/**
 * Email notifications: delivery preferences, notification categories and the shapes returned by the
 * email API. Shared by the server and the web UI.
 */

/** How often a person is emailed about their notifications. */
export type EmailFrequency = 'off' | 'immediately' | 'daily' | 'weekly';

export const EMAIL_FREQUENCIES: readonly EmailFrequency[] = ['off', 'immediately', 'daily', 'weekly'];

export const EMAIL_FREQUENCY_LABELS: Record<EmailFrequency, string> = {
  off: 'Off',
  immediately: 'Immediately',
  daily: 'Daily digest',
  weekly: 'Weekly digest',
};

/** User-facing groups of notification types that people can opt out of one by one. */
export type EmailCategoryId = 'announcements' | 'discussions' | 'grades' | 'courses' | 'achievements';

export interface EmailCategory {
  id: EmailCategoryId;
  label: string;
  description: string;
}

export const EMAIL_CATEGORIES: readonly EmailCategory[] = [
  { id: 'announcements', label: 'Announcements', description: 'News and updates your teachers post to a course.' },
  { id: 'discussions', label: 'Discussions', description: 'Replies in forum discussions you take part in.' },
  { id: 'grades', label: 'Grades and feedback', description: 'When your work is graded or gets feedback.' },
  { id: 'courses', label: 'Courses and enrolment', description: 'When you are added to a course, and other course updates.' },
  { id: 'achievements', label: 'Badges and certificates', description: 'Badges, certificates and completed courses.' },
];

export const EMAIL_CATEGORY_IDS: readonly EmailCategoryId[] = EMAIL_CATEGORIES.map((c) => c.id);

/**
 * The category of each notification type (the `type` passed to notify()). A type is looked up whole first,
 * then by its first word ("badge.awarded" and "badge_awarded" use "badge"); anything else is a course update.
 * Map new notification types here.
 */
export const NOTIFICATION_TYPE_CATEGORIES: Readonly<Record<string, EmailCategoryId>> = {
  announcement: 'announcements',
  forum: 'discussions',
  discussion: 'discussions',
  post: 'discussions',
  grade: 'grades',
  feedback: 'grades',
  submission: 'grades',
  enrolment: 'courses',
  course: 'courses',
  group: 'courses',
  cohort: 'courses',
  badge: 'achievements',
  certificate: 'achievements',
  completion: 'achievements',
};

export function emailCategoryOf(type: string): EmailCategoryId {
  const key = type.trim().toLowerCase();
  if (Object.hasOwn(NOTIFICATION_TYPE_CATEGORIES, key)) return NOTIFICATION_TYPE_CATEGORIES[key]!;
  const first = key.split(/[._:\-/\s]/)[0] ?? '';
  if (Object.hasOwn(NOTIFICATION_TYPE_CATEGORIES, first)) return NOTIFICATION_TYPE_CATEGORIES[first]!;
  return 'courses';
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Site-wide email settings an administrator can change. */
export interface EmailSiteSettings {
  /** Delivery for everyone who has not chosen their own (new users included). */
  defaultFrequency: EmailFrequency;
  /** Hour of the day (0-23) when digests go out, in `timezone`. */
  digestHour: number;
  /** Day of the week (0 = Sunday) when weekly digests go out. */
  digestWeekday: number;
  /** IANA time zone for the digest schedule, e.g. "Europe/London". */
  timezone: string;
}

/** GET /api/email/preferences */
export interface EmailPreferences {
  /** The frequency in effect: the person's own choice, or the site default. */
  frequency: EmailFrequency;
  /** True until the person picks a frequency themselves. */
  isDefault: boolean;
  siteDefault: EmailFrequency;
  disabledCategories: EmailCategoryId[];
  /** Whether this site sends email at all. Preferences are kept either way. */
  deliveryEnabled: boolean;
  /** Where emails go. */
  address: string;
  /** When the next digests go out (ISO), so the UI can show them in local time. */
  nextDigests: { daily: string; weekly: string };
}

/** GET /api/admin/email */
export interface EmailAdminStatus {
  enabled: boolean;
  transport: 'smtp' | 'log' | 'custom' | 'none';
  /** e.g. "SMTP", "Log", or a custom transport's name. */
  transportName: string;
  /** e.g. "smtp.example.com:587" (never credentials) or the folder the log transport writes to. */
  transportDetail: string | null;
  /** Why the transport can't send right now, e.g. a missing package. */
  transportError: string | null;
  /** Whether this server process delivers queued email in the background. */
  worker: boolean;
  from: string;
  /** True when no from address is configured and a fallback is used. */
  fromIsDefault: boolean;
  publicUrl: string | null;
  settings: EmailSiteSettings;
  outbox: { pending: number; sending: number; sent: number; failed: number };
  lastSentAt: string | null;
  lastError: { message: string; at: string; to: string; status: EmailMessageStatus } | null;
  nextDigests: { daily: string; weekly: string };
}

export type EmailMessageStatus = 'pending' | 'sending' | 'sent' | 'failed';

/** GET /api/admin/email/messages/:id */
export interface EmailMessageInfo {
  id: string;
  kind: 'notification' | 'digest' | 'test';
  to: string;
  subject: string;
  status: EmailMessageStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** GET/POST /api/email/unsubscribe */
export interface UnsubscribeInfo {
  siteName: string;
  /** The address the link was sent to, partly hidden. */
  maskedEmail: string;
  /** Set when the link came from an email about one category. */
  category: { id: EmailCategoryId; label: string } | null;
  /** True when the person gets no email at all. */
  unsubscribed: boolean;
  /** True when the link's category is switched off. */
  categoryDisabled: boolean;
}
