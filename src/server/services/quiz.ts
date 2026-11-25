import type { AttemptAnswer, PublicUser, QuestionResult, QuizAttempt, QuizSettings } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { DB } from '../db/types.js';
import type { ActivityRow, CourseRow, QuestionRow, QuizAttemptRow } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { newId, now, num, parseJson, round } from '../lib/util.js';
import { parseSettings } from './activity-types.js';
import { upsertGrade } from './grades.js';
import { notify } from './notify.js';
import { markCompleted } from './progress.js';
import {
  effectiveAnswer,
  gradeQuestion,
  reviewQuestion,
  shuffle,
  snapshotFromRow,
  studentQuestion,
  type QuestionSnapshot,
  type StoredOption,
} from './question-types.js';
import { loadSlots, pickQuestions } from './quiz-slots.js';
import { toCourseRef } from './serialize.js';

export { gradeQuestion, normalizeText } from './question-types.js';
export type { StoredOption };

/** Answers saved within this window after the deadline are still accepted (network latency). */
export const ATTEMPT_GRACE_MS = 30_000;

/** A question result as stored on the attempt (`gradedBy` is a user id). */
export interface StoredResult extends Omit<QuestionResult, 'gradedBy'> {
  gradedBy?: string | null;
}

/** The quiz's directly added questions, in slot order (what the 0.1.x questions endpoint returns). */
export async function loadQuizQuestions(db: DB, activityId: string): Promise<QuestionRow[]> {
  const slots = (await loadSlots(db, activityId)).filter((s) => s.kind === 'question');
  if (slots.length === 0) return [];
  const rows = await db
    .selectFrom('questions')
    .selectAll()
    .where(
      'id',
      'in',
      slots.map((s) => s.questionId!),
    )
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return slots.flatMap((s) => {
    const row = byId.get(s.questionId!);
    return row ? [{ ...row, points: s.points }] : [];
  });
}

/**
 * The questions of an attempt as they were when it started. Attempts always carry a snapshot (the 0.2.0
 * migration backfilled older ones); if one is missing, the current bank versions are used.
 */
export async function attemptQuestions(db: DB, attempt: QuizAttemptRow): Promise<QuestionSnapshot[]> {
  const snapshot = parseJson<QuestionSnapshot[]>(attempt.snapshot, []);
  if (snapshot.length) return snapshot;
  const ids = parseJson<string[]>(attempt.questionOrder, []);
  if (ids.length === 0) return [];
  const rows = await db.selectFrom('questions').selectAll().where('id', 'in', ids).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [snapshotFromRow(row)] : [];
  });
}

export function isExpired(attempt: QuizAttemptRow): boolean {
  return attempt.status === 'in_progress' && !!attempt.deadlineAt && Date.now() > Date.parse(attempt.deadlineAt) + ATTEMPT_GRACE_MS;
}

/** Full review (correct answers and explanations) is allowed for this viewer. */
export function canReview(settings: QuizSettings, activity: ActivityRow, isManager: boolean): boolean {
  if (isManager) return true;
  if (settings.reviewMode === 'immediate') return true;
  if (settings.reviewMode === 'after_due') return !!activity.dueAt && Date.now() > Date.parse(activity.dueAt);
  return false;
}

export async function startAttempt(
  deps: Pick<AppDeps, 'db' | 'events'>,
  activity: ActivityRow,
  userId: string,
  options: { isManager: boolean },
): Promise<QuizAttemptRow> {
  const { db } = deps;
  const settings = parseSettings('quiz', activity.settings);

  const existing = await db
    .selectFrom('quizAttempts')
    .selectAll()
    .where('activityId', '=', activity.id)
    .where('userId', '=', userId)
    .where('status', '=', 'in_progress')
    .executeTakeFirst();
  if (existing) {
    if (!isExpired(existing)) return existing;
    await finishAttempt(deps, existing, activity);
  }

  const countRow = await db
    .selectFrom('quizAttempts')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('activityId', '=', activity.id)
    .where('userId', '=', userId)
    .executeTakeFirst();
  const used = num(countRow?.n);

  if (!options.isManager) {
    if (settings.attemptsAllowed > 0 && used >= settings.attemptsAllowed) {
      throw forbidden('You have used all of your attempts for this quiz.');
    }
    if (activity.dueAt && Date.now() > Date.parse(activity.dueAt)) throw forbidden('This quiz has closed.');
  }

  const picked = await pickQuestions(db, activity);
  const questions = settings.shuffleQuestions ? shuffle(picked) : picked;
  const startedAt = now();

  const attempt: QuizAttemptRow = {
    id: newId(),
    activityId: activity.id,
    courseId: activity.courseId,
    userId,
    attemptNumber: used + 1,
    status: 'in_progress',
    questionOrder: JSON.stringify(questions.map((q) => q.id)),
    answers: '{}',
    results: null,
    score: null,
    maxScore: round(questions.reduce((sum, q) => sum + q.points, 0)),
    startedAt,
    deadlineAt: settings.timeLimitMinutes ? new Date(Date.parse(startedAt) + settings.timeLimitMinutes * 60_000).toISOString() : null,
    finishedAt: null,
    snapshot: JSON.stringify(questions),
  };
  await db.insertInto('quizAttempts').values(attempt).execute();
  return attempt;
}

/** Grade recorded, completion, event: once an attempt's score is final. */
async function attemptFinal(deps: Pick<AppDeps, 'db' | 'events'>, activity: ActivityRow, attempt: QuizAttemptRow) {
  await updateQuizGrade(deps, activity, attempt.userId);
  const settings = parseSettings('quiz', activity.settings);
  const score = attempt.score ?? 0;
  const percent = attempt.maxScore > 0 ? (score / attempt.maxScore) * 100 : 100;
  if (activity.completion === 'auto' && (settings.passingPercent == null || percent >= settings.passingPercent)) {
    await markCompleted(deps, activity, attempt.userId);
  }
  deps.events.emit('quiz.attempt.finished', {
    attemptId: attempt.id,
    activityId: activity.id,
    courseId: activity.courseId,
    userId: attempt.userId,
    score,
    maxScore: attempt.maxScore,
  });
}

/**
 * Submits an attempt and grades it from its snapshot. Attempts with essay answers become `needs_grading`:
 * their score stays pending and no grade is recorded until every essay has a mark.
 */
export async function finishAttempt(
  deps: Pick<AppDeps, 'db' | 'events'>,
  attempt: QuizAttemptRow,
  activity: ActivityRow,
  answers?: Record<string, AttemptAnswer>,
): Promise<QuizAttemptRow> {
  const { db } = deps;
  const finalAnswers = answers ?? parseJson<Record<string, AttemptAnswer>>(attempt.answers, {});
  const questions = await attemptQuestions(db, attempt);

  const results: Record<string, StoredResult> = {};
  let score = 0;
  let maxScore = 0;
  let pending = 0;
  for (const q of questions) {
    const r = gradeQuestion(q, finalAnswers[q.id]);
    results[q.id] = r;
    score += r.points;
    maxScore += r.maxPoints;
    if (r.pending) pending++;
  }
  const status = pending ? 'needs_grading' : 'finished';
  const finishedAt = now();
  const next: QuizAttemptRow = {
    ...attempt,
    status,
    answers: JSON.stringify(finalAnswers),
    results: JSON.stringify(results),
    score: pending ? null : round(score),
    maxScore: round(maxScore),
    finishedAt,
  };

  const update = await db
    .updateTable('quizAttempts')
    .set({ status, answers: next.answers, results: next.results, score: next.score, maxScore: next.maxScore, finishedAt })
    .where('id', '=', attempt.id)
    .where('status', '=', 'in_progress')
    .executeTakeFirst();

  if (num(update.numUpdatedRows) === 0) {
    // Someone else (another tab) finished it first.
    return (await db.selectFrom('quizAttempts').selectAll().where('id', '=', attempt.id).executeTakeFirstOrThrow()) as QuizAttemptRow;
  }

  deps.events.emit('quiz.attempt.submitted', {
    attemptId: attempt.id,
    activityId: activity.id,
    courseId: activity.courseId,
    userId: attempt.userId,
    needsGrading: pending > 0,
  });

  if (!pending) {
    await attemptFinal(deps, activity, next);
  } else if (activity.completion === 'auto' && parseSettings('quiz', activity.settings).passingPercent == null) {
    // Without a pass mark, handing the quiz in completes it even while essays wait for marking.
    await markCompleted(deps, activity, attempt.userId);
  }
  return next;
}

/** Recomputes a student's quiz grade from their finished attempts using the quiz's grading method. */
export async function updateQuizGrade(deps: Pick<AppDeps, 'db' | 'events'>, activity: ActivityRow, userId: string) {
  const { db } = deps;
  const enrolment = await db
    .selectFrom('enrolments')
    .select('role')
    .where('courseId', '=', activity.courseId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (enrolment?.role !== 'student') return; // teacher previews don't count

  const attempts = await db
    .selectFrom('quizAttempts')
    .select(['score', 'maxScore'])
    .where('activityId', '=', activity.id)
    .where('userId', '=', userId)
    .where('status', '=', 'finished')
    .orderBy('finishedAt', 'asc')
    .execute();
  const score = quizScore(activity, attempts);
  if (score == null) return;
  await upsertGrade(deps, { activityId: activity.id, courseId: activity.courseId, userId, score, gradedBy: null });
}

/** The grade for a list of finished attempts (oldest first), or null when there are none. */
function quizScore(activity: ActivityRow, attempts: Array<{ score: number | null; maxScore: number }>): number | null {
  if (attempts.length === 0) return null;
  const fractions = attempts.map((a) => (a.maxScore > 0 ? (a.score ?? 0) / a.maxScore : 0));
  const { gradingMethod } = parseSettings('quiz', activity.settings);
  const fraction =
    gradingMethod === 'last'
      ? fractions[fractions.length - 1]!
      : gradingMethod === 'average'
        ? fractions.reduce((s, f) => s + f, 0) / fractions.length
        : Math.max(...fractions);
  return round(fraction * (activity.maxGrade ?? 10));
}

/** Recomputes every student's grade for a quiz (after its maximum changes), writing only grades that change. */
export async function regradeQuiz(deps: Pick<AppDeps, 'db' | 'events'>, activity: ActivityRow): Promise<void> {
  const { db } = deps;
  const [students, attempts, grades] = await Promise.all([
    db.selectFrom('enrolments').select('userId').where('courseId', '=', activity.courseId).where('role', '=', 'student').execute(),
    db
      .selectFrom('quizAttempts')
      .select(['userId', 'score', 'maxScore'])
      .where('activityId', '=', activity.id)
      .where('status', '=', 'finished')
      .orderBy('finishedAt', 'asc')
      .execute(),
    db.selectFrom('grades').select(['userId', 'score']).where('activityId', '=', activity.id).execute(),
  ]);
  const isStudent = new Set(students.map((s) => s.userId));
  const current = new Map(grades.map((g) => [g.userId, g.score]));
  const byUser = new Map<string, typeof attempts>();
  for (const a of attempts) if (isStudent.has(a.userId)) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  for (const [userId, list] of byUser) {
    const score = quizScore(activity, list);
    if (score == null || current.get(userId) === score) continue;
    await upsertGrade(deps, { activityId: activity.id, courseId: activity.courseId, userId, score, gradedBy: null });
  }
}

/** Students' attempts at a quiz that wait for essays to be marked. */
export async function countNeedsGrading(db: DB, activityId: string): Promise<number> {
  const row = await db
    .selectFrom('quizAttempts')
    .innerJoin('enrolments', (join) =>
      join.onRef('enrolments.userId', '=', 'quizAttempts.userId').onRef('enrolments.courseId', '=', 'quizAttempts.courseId'),
    )
    .select((eb) => eb.fn.countAll().as('n'))
    .where('quizAttempts.activityId', '=', activityId)
    .where('quizAttempts.status', '=', 'needs_grading')
    .where('enrolments.role', '=', 'student')
    .executeTakeFirst();
  return num(row?.n);
}

/**
 * Marks one essay answer. When the last essay of an attempt gets its mark, the score becomes final, the
 * grade is recorded (`grade.updated`) and the student is notified. Marks can be changed later.
 */
export async function gradeEssay(
  deps: Pick<AppDeps, 'db' | 'events'>,
  input: {
    attemptId: string;
    activity: ActivityRow;
    course: CourseRow;
    questionId: string;
    points: number;
    comment: string | null;
    graderId: string;
  },
): Promise<QuizAttemptRow> {
  const { db } = deps;
  for (let tries = 0; tries < 5; tries++) {
    const attempt = await db.selectFrom('quizAttempts').selectAll().where('id', '=', input.attemptId).executeTakeFirst();
    if (!attempt) throw notFound('Attempt');
    if (attempt.status === 'in_progress') throw badRequest('This attempt has not been submitted yet.');
    const questions = await attemptQuestions(db, attempt);
    const question = questions.find((q) => q.id === input.questionId);
    if (!question) throw notFound('Question');
    if (question.type !== 'essay') throw badRequest('Only essay answers are marked by hand.');
    if (input.points > question.points) throw badRequest(`The mark can't be more than ${question.points}.`);

    const results = parseJson<Record<string, StoredResult>>(attempt.results, {});
    const points = round(input.points);
    results[question.id] = {
      correct: question.points > 0 && points >= question.points,
      partial: points > 0 && points < question.points,
      points,
      maxPoints: question.points,
      pending: false,
      comment: input.comment,
      gradedBy: input.graderId,
      gradedAt: now(),
    };
    const pending = questions.some((q) => results[q.id]?.pending);
    const score = round(questions.reduce((sum, q) => sum + (results[q.id]?.points ?? 0), 0));
    const status = pending ? 'needs_grading' : 'finished';
    const update = await db
      .updateTable('quizAttempts')
      .set({ results: JSON.stringify(results), status, score: pending ? null : score })
      .where('id', '=', attempt.id)
      .where((eb) => (attempt.results == null ? eb('results', 'is', null) : eb('results', '=', attempt.results)))
      .executeTakeFirst();
    if (num(update.numUpdatedRows) === 0) continue; // another grader saved in between: start over with their marks

    const next: QuizAttemptRow = { ...attempt, results: JSON.stringify(results), status, score: pending ? null : score };
    if (status === 'finished') {
      if (attempt.status === 'needs_grading') {
        await attemptFinal(deps, input.activity, next);
        await notify(db, [attempt.userId], {
          type: 'grade',
          title: `${input.activity.title} was graded`,
          body: `Your attempt ${attempt.attemptNumber} scored ${score} / ${attempt.maxScore}. Your teacher marked your written answers.`,
          link: `/courses/${input.course.slug}/attempts/${attempt.id}`,
        });
      } else {
        await updateQuizGrade(deps, input.activity, attempt.userId);
      }
    }
    return next;
  }
  throw conflict('Someone else is marking this attempt right now. Please try again.');
}

export function toAttemptDto(
  attempt: QuizAttemptRow,
  activity: ActivityRow,
  course: CourseRow,
  questions: QuestionSnapshot[],
  options: { review: boolean; staff: boolean; canGrade: boolean; users: Map<string, PublicUser>; owner?: PublicUser },
): QuizAttempt {
  const settings = parseSettings('quiz', activity.settings);
  const submitted = attempt.status !== 'in_progress';
  const review = options.review && submitted;
  const saved = parseJson<Record<string, AttemptAnswer>>(attempt.answers, {});
  const answers: Record<string, AttemptAnswer> = { ...saved };
  for (const q of questions) {
    const a = effectiveAnswer(q, saved[q.id]);
    if (a) answers[q.id] = a;
  }

  const stored = submitted ? parseJson<Record<string, StoredResult>>(attempt.results, {}) : {};
  let results: Record<string, QuestionResult> | null = null;
  if (submitted) {
    results = {};
    // Without review, only marks given by hand (essays) are shown: they carry no correct answers.
    for (const q of questions) {
      const r = stored[q.id];
      if (!r || (!review && q.type !== 'essay')) continue;
      results[q.id] = { ...r, gradedBy: r.gradedBy ? (options.users.get(r.gradedBy) ?? null) : null };
    }
  }

  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    score: attempt.score,
    maxScore: attempt.maxScore,
    ...(options.owner ? { user: options.owner } : {}),
    activityId: activity.id,
    quizTitle: activity.title,
    course: toCourseRef(course),
    deadlineAt: attempt.deadlineAt,
    questions: questions.map((q) => (review ? reviewQuestion(q, options.staff) : studentQuestion(q))),
    answers,
    review,
    results,
    passingPercent: settings.passingPercent,
    pendingCount: submitted ? questions.filter((q) => stored[q.id]?.pending).length : 0,
    canGrade: options.canGrade && submitted,
  };
}

/** Users who marked answers in an attempt by hand. */
export function graderIds(attempt: QuizAttemptRow): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(parseJson<Record<string, StoredResult>>(attempt.results, {}))) if (r.gradedBy) ids.add(r.gradedBy);
  return [...ids];
}
