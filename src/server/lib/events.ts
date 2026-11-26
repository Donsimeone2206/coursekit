import type { ActivityType, CourseRole, SiteRole } from '../../shared/types.js';

/** Events emitted by Coursekit. Subscribe with `coursekit.events.on(...)` to integrate with other systems. */
export interface CoursekitEvents {
  'user.created': { userId: string; email: string; role: SiteRole };
  'user.login': { userId: string };
  'course.created': { courseId: string; userId: string };
  'course.updated': { courseId: string };
  'course.deleted': { courseId: string };
  'enrolment.created': { courseId: string; userId: string; role: CourseRole };
  'enrolment.deleted': { courseId: string; userId: string };
  'activity.created': { activityId: string; courseId: string; type: ActivityType };
  'activity.completed': { activityId: string; courseId: string; userId: string };
  'submission.submitted': { activityId: string; courseId: string; userId: string; submissionId: string };
  'grade.updated': { activityId: string; courseId: string; userId: string; score: number | null; gradedBy: string | null };
  'quiz.attempt.finished': {
    attemptId: string;
    activityId: string;
    courseId: string;
    userId: string;
    score: number;
    maxScore: number;
  };
  'forum.post.created': { postId: string; discussionId: string; courseId: string; userId: string };
  'announcement.created': { announcementId: string; courseId: string; userId: string };
  'email.sent': { emailId: string; kind: 'notification' | 'digest' | 'test'; userId: string | null; to: string };
  'email.failed': {
    emailId: string;
    kind: 'notification' | 'digest' | 'test';
    userId: string | null;
    to: string;
    error: string;
    /** False when the message was given up on. */
    willRetry: boolean;
  };
  'group.created': { groupId: string; courseId: string };
  'group.updated': { groupId: string; courseId: string };
  'group.deleted': { groupId: string; courseId: string };
  'group.member.added': { groupId: string; courseId: string; userId: string };
  'group.member.removed': { groupId: string; courseId: string; userId: string };
  'cohort.created': { cohortId: string };
  'cohort.updated': { cohortId: string };
  'cohort.deleted': { cohortId: string };
  'cohort.member.added': { cohortId: string; userId: string };
  'cohort.member.removed': { cohortId: string; userId: string };
  'cohort.linked': { cohortId: string; courseId: string; role: CourseRole };
  'cohort.unlinked': { cohortId: string; courseId: string };
  'course.completed': { courseId: string; userId: string; completedAt: string };
  'certificate.issued': { certificateId: string; courseId: string; userId: string; code: string };
  'certificate.revoked': { certificateId: string; courseId: string | null; userId: string; revokedBy: string };
  'badge.awarded': { badgeId: string; courseId: string | null; userId: string; awardedBy: string | null };
  'badge.revoked': { badgeId: string; courseId: string | null; userId: string; revokedBy: string };
  /** A quiz attempt was handed in. `needsGrading`: essays wait for a teacher; `quiz.attempt.finished` follows once they are marked. */
  'quiz.attempt.submitted': { attemptId: string; activityId: string; courseId: string; userId: string; needsGrading: boolean };
  /** Grade categories, weights or the aggregation changed, so course totals may have changed for everyone. */
  'gradebook.setup.updated': { courseId: string; userId: string };
  /** An activity's group mode or group restriction changed, so who it applies to may have changed. */
  'activity.groups.updated': { activityId: string; courseId: string; userId: string };
}

export type EventName = keyof CoursekitEvents;
type Handler<T> = (payload: T) => void | Promise<void>;
type AnyHandler = <K extends EventName>(event: K, payload: CoursekitEvents[K]) => void | Promise<void>;

export class EventBus {
  #handlers = new Map<EventName, Set<Handler<any>>>();
  #any = new Set<AnyHandler>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends EventName>(event: K, handler: Handler<CoursekitEvents[K]>): () => void {
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Subscribe to every event, e.g. to forward them to a webhook. */
  onAny(handler: AnyHandler): () => void {
    this.#any.add(handler);
    return () => this.#any.delete(handler);
  }

  /** Handlers run asynchronously and never break the request that emitted the event. */
  emit<K extends EventName>(event: K, payload: CoursekitEvents[K]): void {
    const run = (fn: () => void | Promise<void>) =>
      queueMicrotask(() => {
        Promise.resolve()
          .then(fn)
          .catch((err) => console.error(`[coursekit] "${event}" handler failed:`, err));
      });
    for (const handler of this.#handlers.get(event) ?? []) run(() => handler(payload));
    for (const handler of this.#any) run(() => handler(event, payload));
  }
}
