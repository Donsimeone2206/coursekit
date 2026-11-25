import type { Coursekit } from '../src/server/index.js';
import { completionEngineFor } from '../src/server/services/completion.js';
import type { Client } from './helpers.js';

/**
 * DELETE as a browser sends it (same-origin, so CSRF protection lets it through). The shared test client
 * sends no Origin or content type with DELETE, which CSRF protection rejects.
 */
export async function del(lms: Coursekit, as: Client, path: string): Promise<{ status: number; body: any }> {
  const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: as.cookie, origin: 'http://localhost' } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Waits for the background completion checks that events (activity completed, grade changed) queued. */
export async function settle(lms: Coursekit): Promise<void> {
  await completionEngineFor(lms.events)!.idle();
}

export interface CompletionCourse {
  lessonA: string;
  lessonB: string;
  assignment: string;
}

/** Two manually completed lessons and an auto-completed, graded assignment (out of 20). */
export async function addActivities(teacher: Client, courseId: string, sectionId: string): Promise<CompletionCourse> {
  const lesson = async (title: string) =>
    (await teacher.post(`/api/courses/${courseId}/activities`, { sectionId, type: 'lesson', title, settings: { body: '# Hi' } })).body
      .id as string;
  const lessonA = await lesson('Lesson A');
  const lessonB = await lesson('Lesson B');
  const assignment = (
    await teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId,
      type: 'assignment',
      title: 'Essay',
      maxGrade: 20,
      settings: { submissionTypes: ['text'] },
    })
  ).body.id as string;
  return { lessonA, lessonB, assignment };
}

export const certificate = {
  enabled: true,
  title: 'Certificate of Completion',
  body: 'This certifies that\n{name}\nhas completed\n{course}\non {date}',
  signatureName: 'Tina Teacher',
  signatureTitle: 'Course lead',
};

export function settings(overrides: Record<string, unknown> = {}) {
  return { enabled: true, mode: 'all', activityIds: [], minGrade: null, certificate: { ...certificate, enabled: false }, ...overrides };
}

/** Completes every activity of `addActivities` as the student. */
export async function finishEverything(student: Client, activities: CompletionCourse) {
  await student.post(`/api/activities/${activities.lessonA}/complete`);
  await student.post(`/api/activities/${activities.lessonB}/complete`);
  await student.put(`/api/activities/${activities.assignment}/submission`, { text: 'My essay' });
}
