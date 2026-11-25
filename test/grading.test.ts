import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuestionRow } from '../src/server/db/schema.js';
import type { Coursekit } from '../src/server/index.js';
import { gradeQuestion } from '../src/server/services/quiz.js';
import { createTestLms, setupSchool } from './helpers.js';

function question(partial: Partial<QuestionRow>): QuestionRow {
  return {
    id: 'q',
    activityId: 'a',
    type: 'single',
    prompt: '?',
    points: 2,
    options: '[]',
    acceptedAnswers: '[]',
    tolerance: null,
    explanation: null,
    position: 0,
    ...partial,
  };
}

const opts = JSON.stringify([
  { id: 'a', text: 'A', correct: true },
  { id: 'b', text: 'B', correct: true },
  { id: 'c', text: 'C', correct: false },
  { id: 'd', text: 'D', correct: false },
]);

describe('gradeQuestion', () => {
  it('grades single choice', () => {
    const q = question({
      type: 'single',
      options: JSON.stringify([
        { id: 'x', text: 'X', correct: true },
        { id: 'y', text: 'Y', correct: false },
      ]),
    });
    expect(gradeQuestion(q, { optionIds: ['x'] })).toMatchObject({ correct: true, points: 2 });
    expect(gradeQuestion(q, { optionIds: ['y'] })).toMatchObject({ correct: false, points: 0 });
    expect(gradeQuestion(q, undefined).points).toBe(0);
  });

  it('gives partial credit on multiple choice and penalises wrong picks', () => {
    const q = question({ type: 'multiple', options: opts });
    expect(gradeQuestion(q, { optionIds: ['a', 'b'] })).toMatchObject({ correct: true, points: 2 });
    expect(gradeQuestion(q, { optionIds: ['a'] })).toMatchObject({ correct: false, partial: true, points: 1 });
    expect(gradeQuestion(q, { optionIds: ['a', 'c'] }).points).toBe(0);
    expect(gradeQuestion(q, { optionIds: ['a', 'b', 'c', 'd'] }).points).toBe(0);
  });

  it('matches short answers case-insensitively with wildcards', () => {
    const q = question({ type: 'short', acceptedAnswers: JSON.stringify(['Fitts*law', 'gracias']) });
    expect(gradeQuestion(q, { text: "  fitts's   LAW " }).correct).toBe(true);
    expect(gradeQuestion(q, { text: 'Gracias' }).correct).toBe(true);
    expect(gradeQuestion(q, { text: 'hick' }).correct).toBe(false);
    expect(gradeQuestion(q, { text: '' }).correct).toBe(false);
  });

  it('grades numbers within the tolerance', () => {
    const q = question({ type: 'numeric', acceptedAnswers: JSON.stringify(['3.14']), tolerance: 0.01 });
    expect(gradeQuestion(q, { text: '3.15' }).correct).toBe(true);
    expect(gradeQuestion(q, { text: '3,14' }).correct).toBe(true);
    expect(gradeQuestion(q, { text: '3.2' }).correct).toBe(false);
    expect(gradeQuestion(q, { text: 'pi' }).correct).toBe(false);
  });
});

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
});

describe('quizzes', () => {
  async function makeQuiz(settings: Record<string, unknown> = {}) {
    const quiz = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'quiz',
      title: 'Check-in',
      settings,
    });
    const saved = await school.teacher.put(`/api/activities/${quiz.body.id}/questions`, {
      questions: [
        {
          type: 'truefalse',
          prompt: 'Tests are good',
          points: 1,
          options: [
            { text: 'True', correct: true },
            { text: 'False', correct: false },
          ],
        },
        { type: 'numeric', prompt: '2 + 2', points: 3, acceptedAnswers: ['4'] },
      ],
    });
    expect(saved.status).toBe(200);
    return {
      id: quiz.body.id as string,
      questions: saved.body as Array<{ id: string; options: Array<{ id: string; correct?: boolean }> }>,
    };
  }

  it('hides answers during an attempt, grades on submit and records the grade', async () => {
    const quiz = await makeQuiz();
    const started = await school.sam.post(`/api/activities/${quiz.id}/attempts`);
    expect(started.status).toBe(201);
    const attempt = await school.sam.get(`/api/attempts/${started.body.id}`);
    expect(JSON.stringify(attempt.body.questions)).not.toContain('correct');

    const [tf, num] = quiz.questions;
    const trueOption = tf!.options.find((o) => o.correct)!.id;
    await school.sam.put(`/api/attempts/${started.body.id}`, { answers: { [tf!.id]: { optionIds: [trueOption] } } });
    const result = await school.sam.post(`/api/attempts/${started.body.id}/submit`, {
      answers: { [tf!.id]: { optionIds: [trueOption] }, [num!.id]: { text: '5' } },
    });
    expect(result.body).toMatchObject({ status: 'finished', score: 1, maxScore: 4, review: true });

    const grades = await school.sam.get(`/api/courses/${school.course.id}/grades`);
    expect(grades.body.grades.items[0]).toMatchObject({ score: 1, maxGrade: 4 });
    expect((await school.sam.post(`/api/attempts/${started.body.id}/submit`, {})).status).toBe(400);
  });

  it('enforces the attempt limit and keeps the highest grade', async () => {
    const quiz = await makeQuiz({ attemptsAllowed: 2, gradingMethod: 'highest' });
    const [, num] = quiz.questions;
    const first = await school.sam.post(`/api/activities/${quiz.id}/attempts`);
    await school.sam.post(`/api/attempts/${first.body.id}/submit`, { answers: { [num!.id]: { text: '4' } } });
    const second = await school.sam.post(`/api/activities/${quiz.id}/attempts`);
    await school.sam.post(`/api/attempts/${second.body.id}/submit`, { answers: {} });
    expect((await school.sam.post(`/api/activities/${quiz.id}/attempts`)).status).toBe(403);
    const grades = await school.sam.get(`/api/courses/${school.course.id}/grades`);
    expect(grades.body.grades.items[0].score).toBe(3);
  });

  it("doesn't let students see each other's attempts", async () => {
    const quiz = await makeQuiz();
    const attempt = await school.sam.post(`/api/activities/${quiz.id}/attempts`);
    expect((await school.kim.get(`/api/attempts/${attempt.body.id}`)).status).toBe(404);
    expect((await school.teacher.get(`/api/attempts/${attempt.body.id}`)).status).toBe(200);
  });
});

describe('assignments', () => {
  it('collects submissions, lets teachers grade them and notifies the student', async () => {
    const a = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'Essay',
      maxGrade: 20,
      settings: { submissionTypes: ['text'] },
    });
    expect((await school.sam.put(`/api/activities/${a.body.id}/submission`, { text: '' })).status).toBe(400);
    expect((await school.teacher.put(`/api/activities/${a.body.id}/submission`, { text: 'teacher' })).status).toBe(403);
    expect((await school.sam.put(`/api/activities/${a.body.id}/submission`, { text: 'My essay' })).status).toBe(200);

    const subs = await school.teacher.get(`/api/activities/${a.body.id}/submissions`);
    const sam = subs.body.find((r: { user: { email: string } }) => r.user.email === 'sam@test.dev');
    expect(sam.needsGrading).toBe(true);

    expect((await school.teacher.put(`/api/activities/${a.body.id}/grades/${sam.user.id}`, { score: 25 })).status).toBe(400);
    await school.teacher.put(`/api/activities/${a.body.id}/grades/${sam.user.id}`, { score: 18, feedback: 'Nice' });

    const detail = await school.sam.get(`/api/activities/${a.body.id}`);
    expect(detail.body.grade).toMatchObject({ score: 18, maxGrade: 20, feedback: 'Nice' });
    expect(detail.body.completed).toBe(true);
    const notes = await school.sam.get('/api/notifications');
    expect(notes.body.items[0].type).toBe('grade');

    const book = await school.teacher.get(`/api/courses/${school.course.id}/grades`);
    expect(book.body.kind).toBe('gradebook');
    const row = book.body.gradebook.rows.find((r: { user: { email: string } }) => r.user.email === 'sam@test.dev');
    expect(row.percentage).toBe(90);

    const csv = await lms.app.request(`/api/courses/${school.course.id}/grades/export.csv`, { headers: { cookie: school.teacher.cookie } });
    expect(await csv.text()).toContain('Sam Student,sam@test.dev,18');
  });
});

describe('forums', () => {
  it('threads replies and notifies the discussion author', async () => {
    const forum = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'forum',
      title: 'Q&A',
    });
    const d = await school.sam.post(`/api/activities/${forum.body.id}/discussions`, { title: 'Help', body: 'How do I test?' });
    expect(d.status).toBe(201);
    await school.kim.post(`/api/discussions/${d.body.id}/posts`, { body: 'With Vitest!' });
    const thread = await school.sam.get(`/api/discussions/${d.body.id}`);
    expect(thread.body.posts).toHaveLength(2);
    expect(thread.body.replyCount).toBe(1);
    const notes = await school.sam.get('/api/notifications');
    expect(notes.body.items[0].type).toBe('forum');

    await school.teacher.patch(`/api/discussions/${d.body.id}`, { locked: true });
    expect((await school.kim.post(`/api/discussions/${d.body.id}/posts`, { body: 'Too late' })).status).toBe(403);
    expect((await school.kim.patch(`/api/discussions/${d.body.id}`, { pinned: true })).status).toBe(403);
  });
});
