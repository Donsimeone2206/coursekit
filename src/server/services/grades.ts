import type { AppDeps } from '../context.js';
import { now } from '../lib/util.js';

export interface GradeInput {
  activityId: string;
  courseId: string;
  userId: string;
  score: number | null;
  /** Leave undefined to keep existing feedback. */
  feedback?: string | null;
  gradedBy: string | null;
}

export async function upsertGrade(deps: Pick<AppDeps, 'db' | 'events'>, input: GradeInput): Promise<void> {
  const ts = now();
  const gradedAt = input.score === null ? null : ts;
  const update: Record<string, unknown> = { score: input.score, gradedBy: input.gradedBy, gradedAt, updatedAt: ts };
  if (input.feedback !== undefined) update.feedback = input.feedback;

  await deps.db
    .insertInto('grades')
    .values({
      activityId: input.activityId,
      userId: input.userId,
      courseId: input.courseId,
      score: input.score,
      feedback: input.feedback ?? null,
      gradedBy: input.gradedBy,
      gradedAt,
      updatedAt: ts,
    })
    .onConflict((oc) => oc.columns(['activityId', 'userId']).doUpdateSet(update))
    .execute();

  deps.events.emit('grade.updated', {
    activityId: input.activityId,
    courseId: input.courseId,
    userId: input.userId,
    score: input.score,
    gradedBy: input.gradedBy,
  });
}
