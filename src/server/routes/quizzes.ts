import { Hono } from 'hono';
import { z } from 'zod';
import type { AttemptAnswer, QuizAttemptSummary } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { QuestionRow } from '../db/schema.js';
import { badRequest, forbidden, notFound, readBody } from '../lib/http.js';
import { newId, round } from '../lib/util.js';
import { assertCan, assertWritable, loadActivityAccess } from '../services/access.js';
import { parseSettings } from '../services/activity-types.js';
import {
  canReview,
  finishAttempt,
  isExpired,
  loadQuestions,
  questionWithAnswers,
  startAttempt,
  toAttemptDto,
  updateQuizGrade,
} from '../services/quiz.js';
import { toPublicUser } from '../services/serialize.js';

const optionSchema = z.object({
  id: z.string().max(40).optional(),
  text: z.string().trim().min(1, 'Option text is required').max(2000),
  correct: z.boolean().default(false),
});

const questionSchema = z
  .object({
    id: z.string().max(40).optional(),
    type: z.enum(['single', 'multiple', 'truefalse', 'short', 'numeric']),
    prompt: z.string().trim().min(1, 'Question text is required').max(20_000),
    points: z.number().min(0).max(1000).default(1),
    options: z.array(optionSchema).max(20).default([]),
    acceptedAnswers: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    tolerance: z.number().min(0).nullable().default(null),
    explanation: z.string().max(20_000).nullable().default(null),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.correct).length;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['options'] });
    if (q.type === 'single' || q.type === 'multiple') {
      if (q.options.length < 2) issue('Add at least two options');
      if (q.type === 'single' && correct !== 1) issue('Mark exactly one option as correct');
      if (q.type === 'multiple' && correct < 1) issue('Mark at least one option as correct');
    }
    if (q.type === 'truefalse' && (q.options.length !== 2 || correct !== 1)) issue('Choose whether the statement is true or false');
    if (q.type === 'short' && q.acceptedAnswers.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Add at least one accepted answer', path: ['acceptedAnswers'] });
    }
    if (q.type === 'numeric' && (q.acceptedAnswers.length === 0 || q.acceptedAnswers.some((a) => !Number.isFinite(Number(a))))) {
      ctx.addIssue({ code: 'custom', message: 'Enter the correct number', path: ['acceptedAnswers'] });
    }
  });

const answersSchema = z.record(
  z.string().max(40),
  z.object({ optionIds: z.array(z.string().max(40)).max(20).optional(), text: z.string().max(5000).optional() }),
);

export function quizRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function quizAccess(c: Parameters<typeof requireUser>[0], activityId: string) {
    const access = await loadActivityAccess(db, requireUser(c), activityId);
    if (access.activity.type !== 'quiz') throw badRequest('This activity is not a quiz.');
    return access;
  }

  r.get('/activities/:activityId/questions', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    const questions = await loadQuestions(db, access.activity.id);
    return c.json(questions.map(questionWithAnswers));
  });

  /** Replaces the quiz's question set. Existing ids are kept so in-progress attempts stay valid. */
  r.put('/activities/:activityId/questions', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    const { questions } = await readBody(c, z.object({ questions: z.array(questionSchema).max(200) }));
    const activityId = access.activity.id;
    const existing = new Set((await loadQuestions(db, activityId)).map((q) => q.id));

    const rows: QuestionRow[] = questions.map((q, position) => ({
      id: q.id && existing.has(q.id) ? q.id : newId(),
      activityId,
      type: q.type,
      prompt: q.prompt,
      points: q.points,
      options: JSON.stringify(
        q.type === 'short' || q.type === 'numeric'
          ? []
          : q.options.map((o) => ({ id: o.id || newId(8), text: o.text, correct: o.correct })),
      ),
      acceptedAnswers: JSON.stringify(q.type === 'short' || q.type === 'numeric' ? q.acceptedAnswers : []),
      tolerance: q.type === 'numeric' ? q.tolerance : null,
      explanation: q.explanation?.trim() || null,
      position,
    }));
    const keep = new Set(rows.map((q) => q.id));
    const total = round(rows.reduce((sum, q) => sum + q.points, 0));

    await db.transaction().execute(async (trx) => {
      const removed = [...existing].filter((id) => !keep.has(id));
      if (removed.length) await trx.deleteFrom('questions').where('id', 'in', removed).execute();
      for (const row of rows) {
        if (existing.has(row.id)) {
          const { id, ...rest } = row;
          await trx.updateTable('questions').set(rest).where('id', '=', id).execute();
        } else {
          await trx.insertInto('questions').values(row).execute();
        }
      }
      await trx
        .updateTable('activities')
        .set({ maxGrade: total > 0 ? total : 10 })
        .where('id', '=', activityId)
        .execute();
    });

    // Keep existing grades consistent with the new maximum.
    const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', activityId).executeTakeFirstOrThrow();
    const takers = await db.selectFrom('quizAttempts').select('userId').distinct().where('activityId', '=', activityId).execute();
    for (const t of takers) await updateQuizGrade(deps, refreshed, t.userId);

    return c.json((await loadQuestions(db, activityId)).map(questionWithAnswers));
  });

  /** Start a new attempt, or resume the one in progress. */
  r.post('/activities/:activityId/attempts', async (c) => {
    const user = requireUser(c);
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'quiz:attempt');
    assertWritable(access);
    const attempt = await startAttempt(deps, access.activity, user.id, { isManager: access.can('course:manageContent') });
    return c.json({ id: attempt.id }, 201);
  });

  /** The viewer's attempts, or everyone's for staff (?all=1). */
  r.get('/activities/:activityId/attempts', async (c) => {
    const user = requireUser(c);
    const access = await quizAccess(c, c.req.param('activityId'));
    const all = c.req.query('all') === '1' && access.can('quiz:viewAllAttempts');
    const rows = await db
      .selectFrom('quizAttempts')
      .innerJoin('users', 'users.id', 'quizAttempts.userId')
      .selectAll('quizAttempts')
      .select(['users.name as userName', 'users.avatarUrl as userAvatarUrl'])
      .where('quizAttempts.activityId', '=', access.activity.id)
      .$if(!all, (q) => q.where('quizAttempts.userId', '=', user.id))
      .orderBy('quizAttempts.startedAt', 'desc')
      .limit(500)
      .execute();
    const items: QuizAttemptSummary[] = rows.map((a) => ({
      id: a.id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      score: a.score,
      maxScore: a.maxScore,
      user: toPublicUser({ id: a.userId, name: a.userName, avatarUrl: a.userAvatarUrl }),
    }));
    return c.json(items);
  });

  async function attemptAccess(c: Parameters<typeof requireUser>[0]) {
    const user = requireUser(c);
    const attempt = await db.selectFrom('quizAttempts').selectAll().where('id', '=', c.req.param('attemptId')!).executeTakeFirst();
    if (!attempt) throw notFound('Attempt');
    const access = await loadActivityAccess(db, user, attempt.activityId);
    const own = attempt.userId === user.id;
    if (!own && !access.can('quiz:viewAllAttempts')) throw notFound('Attempt');
    return { user, attempt, access, own };
  }

  r.get('/attempts/:attemptId', async (c) => {
    let { attempt, access } = await attemptAccess(c);
    if (isExpired(attempt)) attempt = await finishAttempt(deps, attempt, access.activity);
    const settings = parseSettings('quiz', access.activity.settings);
    const review = canReview(settings, access.activity, access.can('quiz:viewAllAttempts'));
    const questions = await loadQuestions(db, access.activity.id);
    return c.json(toAttemptDto(attempt, access.activity, access.course, questions, review));
  });

  /** Autosave answers while the attempt is open. */
  r.put('/attempts/:attemptId', async (c) => {
    const { attempt, own } = await attemptAccess(c);
    if (!own) throw forbidden();
    if (attempt.status !== 'in_progress') throw badRequest('This attempt has already been submitted.');
    if (isExpired(attempt)) throw badRequest('Time is up for this attempt.');
    const { answers } = await readBody(c, z.object({ answers: answersSchema }));
    await db
      .updateTable('quizAttempts')
      .set({ answers: JSON.stringify(answers) })
      .where('id', '=', attempt.id)
      .execute();
    return c.json({ ok: true, savedAt: new Date().toISOString() });
  });

  r.post('/attempts/:attemptId/submit', async (c) => {
    const { attempt, access, own } = await attemptAccess(c);
    if (!own) throw forbidden();
    if (attempt.status !== 'in_progress') throw badRequest('This attempt has already been submitted.');
    const { answers } = await readBody(c, z.object({ answers: answersSchema.optional() }));
    // After the deadline only previously saved answers count.
    const finalAnswers: Record<string, AttemptAnswer> | undefined = isExpired(attempt) ? undefined : answers;
    const finished = await finishAttempt(deps, attempt, access.activity, finalAnswers);
    const settings = parseSettings('quiz', access.activity.settings);
    const review = canReview(settings, access.activity, access.can('quiz:viewAllAttempts'));
    const questions = await loadQuestions(db, access.activity.id);
    return c.json(toAttemptDto(finished, access.activity, access.course, questions, review));
  });

  return r;
}
