import type { AttemptAnswer, Question, QuestionResult, QuizAttempt, QuizSettings } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { DB } from '../db/index.js';
import type { ActivityRow, CourseRow, QuestionRow, QuizAttemptRow } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http.js';
import { newId, now, num, parseJson, round } from '../lib/util.js';
import { parseSettings } from './activity-types.js';
import { upsertGrade } from './grades.js';
import { markCompleted } from './progress.js';
import { toCourseRef } from './serialize.js';

export interface StoredOption {
  id: string;
  text: string;
  correct: boolean;
}

/** Answers saved within this window after the deadline are still accepted (network latency). */
export const ATTEMPT_GRACE_MS = 30_000;

export function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesAccepted(given: string, pattern: string): boolean {
  if (!pattern.includes('*')) return given === pattern;
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(given);
}

export function gradeQuestion(q: QuestionRow, answer: AttemptAnswer | undefined): QuestionResult {
  const maxPoints = q.points;
  const zero: QuestionResult = { correct: false, partial: false, points: 0, maxPoints };
  const full: QuestionResult = { correct: true, partial: false, points: maxPoints, maxPoints };
  if (!answer) return zero;
  const options = parseJson<StoredOption[]>(q.options, []);

  switch (q.type) {
    case 'single':
    case 'truefalse': {
      const chosen = options.find((o) => o.id === answer.optionIds?.[0]);
      return chosen?.correct ? full : zero;
    }
    case 'multiple': {
      const chosen = new Set(answer.optionIds ?? []);
      const correctIds = options.filter((o) => o.correct).map((o) => o.id);
      if (correctIds.length === 0 || chosen.size === 0) return zero;
      const right = correctIds.filter((id) => chosen.has(id)).length;
      const wrong = options.filter((o) => !o.correct && chosen.has(o.id)).length;
      // Each correct choice earns a share; each wrong choice takes one away (never below zero).
      const fraction = Math.max(0, (right - wrong) / correctIds.length);
      const points = round(maxPoints * fraction);
      const correct = right === correctIds.length && wrong === 0;
      return { correct, partial: !correct && points > 0, points, maxPoints };
    }
    case 'short': {
      const given = normalizeText(answer.text ?? '');
      if (!given) return zero;
      const accepted = parseJson<string[]>(q.acceptedAnswers, []).map(normalizeText);
      return accepted.some((a) => matchesAccepted(given, a)) ? full : zero;
    }
    case 'numeric': {
      const raw = (answer.text ?? '').trim().replace(',', '.');
      const given = Number(raw);
      if (!raw || !Number.isFinite(given)) return zero;
      const tolerance = q.tolerance ?? 0;
      const accepted = parseJson<string[]>(q.acceptedAnswers, []).map(Number).filter(Number.isFinite);
      return accepted.some((a) => Math.abs(a - given) <= tolerance + 1e-9) ? full : zero;
    }
    default:
      return zero;
  }
}

/** Question as an editor sees it, including correct answers. */
export function questionWithAnswers(q: QuestionRow): Question {
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    points: q.points,
    options: parseJson<StoredOption[]>(q.options, []).map((o) => ({ id: o.id, text: o.text, correct: o.correct })),
    acceptedAnswers: parseJson<string[]>(q.acceptedAnswers, []),
    tolerance: q.tolerance,
    explanation: q.explanation,
  };
}

/** Question as a student sees it during an attempt: no answers. */
export function questionForStudent(q: QuestionRow): Question {
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    points: q.points,
    options: parseJson<StoredOption[]>(q.options, []).map((o) => ({ id: o.id, text: o.text })),
  };
}

export async function loadQuestions(db: DB, activityId: string): Promise<QuestionRow[]> {
  return db.selectFrom('questions').selectAll().where('activityId', '=', activityId).orderBy('position', 'asc').execute();
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

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
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

  const questions = await loadQuestions(db, activity.id);
  if (questions.length === 0) throw badRequest('This quiz has no questions yet.');
  const ids = questions.map((q) => q.id);
  const startedAt = now();

  const attempt: QuizAttemptRow = {
    id: newId(),
    activityId: activity.id,
    courseId: activity.courseId,
    userId,
    attemptNumber: used + 1,
    status: 'in_progress',
    questionOrder: JSON.stringify(settings.shuffleQuestions ? shuffle(ids) : ids),
    answers: '{}',
    results: null,
    score: null,
    maxScore: round(questions.reduce((sum, q) => sum + q.points, 0)),
    startedAt,
    deadlineAt: settings.timeLimitMinutes ? new Date(Date.parse(startedAt) + settings.timeLimitMinutes * 60_000).toISOString() : null,
    finishedAt: null,
  };
  await db.insertInto('quizAttempts').values(attempt).execute();
  return attempt;
}

export async function finishAttempt(
  deps: Pick<AppDeps, 'db' | 'events'>,
  attempt: QuizAttemptRow,
  activity: ActivityRow,
  answers?: Record<string, AttemptAnswer>,
): Promise<QuizAttemptRow> {
  const { db } = deps;
  const finalAnswers = answers ?? parseJson<Record<string, AttemptAnswer>>(attempt.answers, {});
  const questions = new Map((await loadQuestions(db, activity.id)).map((q) => [q.id, q]));
  const order = parseJson<string[]>(attempt.questionOrder, []);

  const results: Record<string, QuestionResult> = {};
  let score = 0;
  let maxScore = 0;
  for (const id of order) {
    const q = questions.get(id);
    if (!q) continue;
    const r = gradeQuestion(q, finalAnswers[id]);
    results[id] = r;
    score += r.points;
    maxScore += r.maxPoints;
  }
  score = round(score);
  maxScore = round(maxScore);
  const finishedAt = now();

  const update = await db
    .updateTable('quizAttempts')
    .set({
      status: 'finished',
      answers: JSON.stringify(finalAnswers),
      results: JSON.stringify(results),
      score,
      maxScore,
      finishedAt,
    })
    .where('id', '=', attempt.id)
    .where('status', '=', 'in_progress')
    .executeTakeFirst();

  if (num(update.numUpdatedRows) === 0) {
    // Someone else (another tab) finished it first.
    return (await db.selectFrom('quizAttempts').selectAll().where('id', '=', attempt.id).executeTakeFirstOrThrow()) as QuizAttemptRow;
  }

  await updateQuizGrade(deps, activity, attempt.userId);

  const settings = parseSettings('quiz', activity.settings);
  const percent = maxScore > 0 ? (score / maxScore) * 100 : 100;
  if (activity.completion === 'auto' && (settings.passingPercent == null || percent >= settings.passingPercent)) {
    await markCompleted(deps, activity, attempt.userId);
  }

  deps.events.emit('quiz.attempt.finished', {
    attemptId: attempt.id,
    activityId: activity.id,
    courseId: activity.courseId,
    userId: attempt.userId,
    score,
    maxScore,
  });

  return {
    ...attempt,
    status: 'finished',
    answers: JSON.stringify(finalAnswers),
    results: JSON.stringify(results),
    score,
    maxScore,
    finishedAt,
  };
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
  if (attempts.length === 0) return;

  const fractions = attempts.map((a) => (a.maxScore > 0 ? (a.score ?? 0) / a.maxScore : 0));
  const { gradingMethod } = parseSettings('quiz', activity.settings);
  const fraction =
    gradingMethod === 'last'
      ? fractions[fractions.length - 1]!
      : gradingMethod === 'average'
        ? fractions.reduce((s, f) => s + f, 0) / fractions.length
        : Math.max(...fractions);

  await upsertGrade(deps, {
    activityId: activity.id,
    courseId: activity.courseId,
    userId,
    score: round(fraction * (activity.maxGrade ?? 10)),
    gradedBy: null,
  });
}

export function toAttemptDto(
  attempt: QuizAttemptRow,
  activity: ActivityRow,
  course: CourseRow,
  questionRows: QuestionRow[],
  review: boolean,
): QuizAttempt {
  const settings = parseSettings('quiz', activity.settings);
  const byId = new Map(questionRows.map((q) => [q.id, q]));
  const order = parseJson<string[]>(attempt.questionOrder, []);
  const questions = order
    .map((id) => byId.get(id))
    .filter((q): q is QuestionRow => !!q)
    .map((q) => (review && attempt.status === 'finished' ? questionWithAnswers(q) : questionForStudent(q)));

  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    score: attempt.score,
    maxScore: attempt.maxScore,
    activityId: activity.id,
    quizTitle: activity.title,
    course: toCourseRef(course),
    deadlineAt: attempt.deadlineAt,
    questions,
    answers: parseJson<Record<string, AttemptAnswer>>(attempt.answers, {}),
    review: review && attempt.status === 'finished',
    results: review && attempt.status === 'finished' ? parseJson<Record<string, QuestionResult>>(attempt.results, {}) : null,
    passingPercent: settings.passingPercent,
  };
}
