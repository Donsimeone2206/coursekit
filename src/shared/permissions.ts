/**
 * Role-based capabilities, in the spirit of Moodle's capability system.
 * The server enforces these; the UI uses the same table to decide what to show.
 */
import type { CourseRole, SiteRole } from './types.js';

export const COURSE_CAPABILITIES = [
  'course:view',
  'course:viewHidden',
  'course:update',
  'course:delete',
  'course:manageContent',
  'course:viewParticipants',
  'course:manageParticipants',
  'grades:viewAll',
  'grades:edit',
  'assignment:submit',
  'quiz:attempt',
  'quiz:viewAllAttempts',
  'forum:post',
  'forum:moderate',
  'announcement:post',
  'course:manageGroups',
  'completion:viewReport',
  'completion:manage',
  'badges:manage',
  'badges:award',
  'questionbank:manage',
  'grades:manage',
  /** See and take part in every group's work and discussions, whatever the group mode. Teachers and administrators. */
  'course:accessAllGroups',
] as const;

export type CourseCapability = (typeof COURSE_CAPABILITIES)[number];

const TEACHER: readonly CourseCapability[] = COURSE_CAPABILITIES.filter((c) => c !== 'assignment:submit');

export const ROLE_CAPABILITIES: Record<CourseRole, readonly CourseCapability[]> = {
  teacher: TEACHER,
  assistant: [
    'course:view',
    'course:viewHidden',
    'course:viewParticipants',
    'grades:viewAll',
    'grades:edit',
    'quiz:attempt',
    'quiz:viewAllAttempts',
    'forum:post',
    'forum:moderate',
    'announcement:post',
    // Not course:manageGroups: group membership decides what group restrictions and separate groups let people see
    // (teaching assistants included), so only teachers change it, as in Moodle. Assistants still see every group.
    'completion:viewReport',
    'badges:award',
  ],
  student: ['course:view', 'course:viewParticipants', 'assignment:submit', 'quiz:attempt', 'forum:post'],
};

/** Capabilities a user has in a course, given their site role and (optional) course role. */
export function getCourseCapabilities(siteRole: SiteRole | null, courseRole: CourseRole | null): CourseCapability[] {
  const caps = new Set<CourseCapability>(courseRole ? ROLE_CAPABILITIES[courseRole] : []);
  if (siteRole === 'admin') for (const cap of TEACHER) caps.add(cap);
  return COURSE_CAPABILITIES.filter((c) => caps.has(c));
}

export function canCreateCourses(role: SiteRole | null | undefined): boolean {
  return role === 'admin' || role === 'instructor';
}

export const SITE_ROLE_LABELS: Record<SiteRole, string> = {
  admin: 'Administrator',
  instructor: 'Instructor',
  student: 'Student',
};

export const COURSE_ROLE_LABELS: Record<CourseRole, string> = {
  teacher: 'Teacher',
  assistant: 'Teaching assistant',
  student: 'Student',
};
