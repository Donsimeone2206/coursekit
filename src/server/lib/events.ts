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
