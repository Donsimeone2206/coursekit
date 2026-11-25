import { Hono } from 'hono';
import { z } from 'zod';
import type { AttemptAnswer, PublicUser, QuizAttemptSummary, QuizGradingItem } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { QuizAttemptRow } from '../db/schema.js';
import { badRequest, forbidden, notFound, readBody } from '../lib/http.js';
import { parseJson } from '../lib/util.js';
import { assertCan, assertWritable, loadActivityAccess, type ActivityAccess } from '../services/access.js';
import { parseSettings } from '../services/activity-types.js';
import { createQuestion, ensureCategories, transact, updateQuestion } from '../services/question-bank.js';
import { editorQuestion, questionInputSchema } from '../services/question-types.js';
import { describeSlots, saveSlots, slotInputSchema, type SlotInput } from '../services/quiz-slots.js';
import {
  attemptQuestions,
  canReview,
  finishAttempt,
  gradeEssay,
  graderIds,
  isExpired,
  loadQuizQuestions,
  regradeQuiz,
  startAttempt,
  toAttemptDto,
  type StoredResult,
} from '../services/quiz.js';
import { toPublicUser, userFrom } from '../services/serialize.js';

const id = z.string().max(40);

const answersSchema = z
  .record(
    id,
    z.object({
      optionIds: z.array(id).max(20).optional(),
      text: z.string().max(50_000).optional(),
      order: z.array(id).max(20).optional(),
      matches: z
        .record(id, id)
        .refine((m) => Object.keys(m).length <= 20, 'Too many matches')
        .optional(),
    }),
  )
  .refine((a) => Object.keys(a).length <= 500, 'Too many answers');

export function quizRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  async function quizAccess(c: Parameters<typeof requireUser>[0], activityId: string) {
    const access = await loadActivityAccess(db, requireUser(c), activityId);
    if (access.activity.type !== 'quiz') throw badRequest('This activity is not a quiz.');
    return access;
  }

  /** Refreshes students' grades when the quiz's maximum changed. */
  async function afterMarksChanged(access: ActivityAccess) {
    const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', access.activity.id).executeTakeFirstOrThrow();
    if (refreshed.maxGrade !== access.activity.maxGrade) await regradeQuiz(deps, refreshed);
  }

  /** The quiz's directly added questions with answers (the 0.1.x API; random slots are left out). */
  r.get('/activities/:activityId/questions', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    return c.json((await loadQuizQuestions(db, access.activity.id)).map(editorQuestion));
  });

  /**
   * Replaces the quiz's questions (the 0.1.x API). Questions are saved to the course's question bank: ids
   * already in the quiz update those bank questions, others become new ones.
   */
  r.put('/activities/:activityId/questions', async (c) => {
    const user = requireUser(c);
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    assertWritable(access);
    const { questions } = await readBody(c, z.object({ questions: z.array(questionInputSchema).max(200) }));
    const { activity } = access;
    const current = new Map((await loadQuizQuestions(db, activity.id)).map((q) => [q.id, q]));

    await transact(db, async (trx) => {
      const categoryId = [...current.values()][0]?.categoryId ?? (await ensureCategories(trx, activity.courseId))[0]!.id;
      const slots: SlotInput[] = [];
      for (const input of questions) {
        const existing = input.id ? current.get(input.id) : undefined;
        const row = existing
          ? await updateQuestion(trx, existing, input)
          : await createQuestion(trx, activity.courseId, categoryId, input, user.id);
        slots.push({ kind: 'question', questionId: row.id, points: input.points });
      }
      await saveSlots(trx, activity, slots);
    });
    await afterMarksChanged(access);
    return c.json((await loadQuizQuestions(db, activity.id)).map(editorQuestion));
  });

  r.get('/activities/:activityId/slots', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    return c.json(await describeSlots(db, access.activity));
  });

  /** Replaces the quiz's slots: bank questions and random picks, in order, each with its mark. */
  r.put('/activities/:activityId/slots', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    assertWritable(access);
    const { slots } = await readBody(c, z.object({ slots: z.array(slotInputSchema).max(200) }));
    await saveSlots(db, access.activity, slots);
    await afterMarksChanged(access);
    const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', access.activity.id).executeTakeFirstOrThrow();
    return c.json(await describeSlots(db, refreshed));
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

  /** Students' attempts waiting for essays to be marked, oldest first. */
  r.get('/activities/:activityId/grading', async (c) => {
    const access = await quizAccess(c, c.req.param('activityId'));
    assertCan(access, 'quiz:viewAllAttempts');
    const rows = await db
      .selectFrom('quizAttempts')
      .innerJoin('users', 'users.id', 'quizAttempts.userId')
      .innerJoin('enrolments', (join) =>
        join.onRef('enrolments.userId', '=', 'quizAttempts.userId').onRef('enrolments.courseId', '=', 'quizAttempts.courseId'),
      )
      .select([
        'quizAttempts.id',
        'quizAttempts.attemptNumber',
        'quizAttempts.finishedAt',
        'quizAttempts.results',
        'users.id as userId',
        'users.name as userName',
        'users.avatarUrl as userAvatarUrl',
      ])
      .where('quizAttempts.activityId', '=', access.activity.id)
      .where('quizAttempts.status', '=', 'needs_grading')
      .where('enrolments.role', '=', 'student')
      .orderBy('quizAttempts.finishedAt', 'asc')
      .limit(500)
      .execute();
    const items: QuizGradingItem[] = rows.map((a) => ({
      attemptId: a.id,
      attemptNumber: a.attemptNumber,
      user: userFrom(a),
      finishedAt: a.finishedAt,
      pending: Object.values(parseJson<Record<string, StoredResult>>(a.results, {})).filter((x) => x.pending).length,
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

  async function attemptResponse(attempt: QuizAttemptRow, access: ActivityAccess) {
    const staff = access.can('quiz:viewAllAttempts');
    const settings = parseSettings('quiz', access.activity.settings);
    const questions = await attemptQuestions(db, attempt);
    const ids = [...new Set([attempt.userId, ...graderIds(attempt)])];
    const rows = await db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', 'in', ids).execute();
    const users = new Map<string, PublicUser>(rows.map((u) => [u.id, toPublicUser(u)]));
    return toAttemptDto(attempt, access.activity, access.course, questions, {
      review: canReview(settings, access.activity, staff),
      staff,
      canGrade: access.can('grades:edit') && !access.readOnly,
      users,
      ...(users.has(attempt.userId) ? { owner: users.get(attempt.userId)! } : {}),
    });
  }

  r.get('/attempts/:attemptId', async (c) => {
    let { attempt, access } = await attemptAccess(c);
    if (isExpired(attempt)) attempt = await finishAttempt(deps, attempt, access.activity);
    return c.json(await attemptResponse(attempt, access));
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
      .where('status', '=', 'in_progress')
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
    return c.json(await attemptResponse(finished, access));
  });

  /** Marks an essay answer: `{ points, comment }`. The attempt's score becomes final once every essay has a mark. */
  r.put('/attempts/:attemptId/questions/:questionId/grade', async (c) => {
    const { user, attempt, access } = await attemptAccess(c);
    assertCan(access, 'grades:edit');
    assertWritable(access);
    const input = await readBody(
      c,
      z.object({ points: z.number().min(0).max(1000), comment: z.string().trim().max(20_000).nullable().default(null) }),
    );
    const next = await gradeEssay(deps, {
      attemptId: attempt.id,
      activity: access.activity,
      course: access.course,
      questionId: c.req.param('questionId'),
      points: input.points,
      comment: input.comment || null,
      graderId: user.id,
    });
    return c.json(await attemptResponse(next, access));
  });

  return r;
}
