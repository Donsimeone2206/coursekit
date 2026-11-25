import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrations } from '../src/server/db/index.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { hashPassword } from '../src/server/lib/password.js';
import {
  gradeQuestion,
  initialOrder,
  orderedPairs,
  snapshotFromRow,
  type QuestionSnapshot,
} from '../src/server/services/question-types.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

/** Set to a PostgreSQL URL (e.g. postgres://postgres@127.0.0.1:5432/postgres) to run these tests on PostgreSQL too. */
const PG_URL = process.env.COURSEKIT_TEST_POSTGRES_URL;

type Target = { name: string; make: () => Promise<{ lms: Coursekit; url: string; dataDir: string; cleanup: () => Promise<void> }> };

async function sqliteTarget() {
  const dataDir = mkdtempSync(join(tmpdir(), 'coursekit-qb-'));
  const url = `sqlite://${join(dataDir, 'test.db')}`;
  return { url, dataDir, cleanup: async () => {} };
}

async function postgresTarget() {
  const name = `ck_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-qb-')),
    cleanup: async () => {
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

const targets: Target[] = [
  {
    name: 'SQLite',
    make: async () => {
      const lms = await createTestLms();
      return { lms, url: 'sqlite::memory:', dataDir: '', cleanup: async () => {} };
    },
  },
  ...(PG_URL
    ? [
        {
          name: 'PostgreSQL',
          make: async () => {
            const t = await postgresTarget();
            const lms = await createCoursekit({ databaseUrl: t.url, dataDir: t.dataDir, webDir: false });
            return { lms, ...t };
          },
        },
      ]
    : []),
];

function snap(partial: Partial<QuestionSnapshot>): QuestionSnapshot {
  return {
    id: 'q',
    type: 'single',
    prompt: '?',
    points: 4,
    options: [],
    acceptedAnswers: [],
    tolerance: null,
    explanation: null,
    settings: {},
    ...partial,
  };
}

const row = (partial: Record<string, unknown>) => ({
  id: 'q',
  type: 'single' as const,
  prompt: '?',
  points: 3,
  options: '[]',
  acceptedAnswers: '[]',
  tolerance: null,
  explanation: null,
  settings: '{}',
  ...partial,
});

describe('grading the new question types', () => {
  const capitals = [
    { id: 'p1', text: 'France', answer: 'Paris' },
    { id: 'p2', text: 'Spain', answer: 'Madrid' },
    { id: 'p3', text: 'Italy', answer: 'Rome' },
  ];

  it('matching gives a share per correct pair and shuffles in the distractors', () => {
    const q = snapshotFromRow(
      row({ type: 'matching', options: JSON.stringify(capitals), settings: JSON.stringify({ distractors: ['Lisbon'] }) }),
    );
    const id = (text: string) => q.choices!.find((c) => c.text === text)!.id;
    expect(q.choices!.map((c) => c.text).sort()).toEqual(['Lisbon', 'Madrid', 'Paris', 'Rome']);
    const all = { p1: id('Paris'), p2: id('Madrid'), p3: id('Rome') };
    expect(gradeQuestion(q, { matches: all })).toEqual({ correct: true, partial: false, points: 3, maxPoints: 3 });
    expect(gradeQuestion(q, { matches: { ...all, p3: id('Lisbon') } })).toMatchObject({ correct: false, partial: true, points: 2 });
    expect(gradeQuestion(q, { matches: { p1: id('Madrid'), p2: id('Paris') } })).toMatchObject({ points: 0, partial: false });
    expect(gradeQuestion(q, { matches: { p1: 'nonsense', p2: '', p3: id('Rome') } }).points).toBe(1);
    expect(gradeQuestion(q, {}).points).toBe(0);
    expect(gradeQuestion(q, undefined).points).toBe(0);
  });

  it('matching merges identical answers into one choice that both items can use', () => {
    const pairs = [
      { id: 'a', text: 'Dog', answer: 'Mammal' },
      { id: 'b', text: 'Cat', answer: ' mammal ' },
      { id: 'c', text: 'Trout', answer: 'Fish' },
    ];
    const q = snapshotFromRow(row({ type: 'matching', points: 1, options: JSON.stringify(pairs) }));
    expect(q.choices).toHaveLength(2);
    const mammal = q.choices!.find((c) => c.text === 'Mammal')!.id;
    expect(gradeQuestion(q, { matches: { a: mammal, b: mammal } })).toMatchObject({ partial: true, points: 0.67 });
    // The same rules apply to a stored row without a snapshot (ids come from the answer text).
    expect(
      gradeQuestion(row({ type: 'matching', points: 1, options: JSON.stringify(pairs) }), { matches: { a: mammal, b: mammal } }).points,
    ).toBe(0.67);
  });

  it('ordering scores neighbouring pairs in the right order', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: id.toUpperCase() }));
    const q = snap({ type: 'ordering', points: 4, options: items, order: ['e', 'd', 'c', 'b', 'a'] });
    expect(gradeQuestion(q, { order: ['a', 'b', 'c', 'd', 'e'] })).toEqual({ correct: true, partial: false, points: 4, maxPoints: 4 });
    // B→C, C→D and D→E are right: 3 of 4 pairs.
    expect(gradeQuestion(q, { order: ['b', 'c', 'd', 'e', 'a'] })).toMatchObject({ partial: true, points: 3 });
    expect(gradeQuestion(q, { order: ['a', 'b', 'c', 'e', 'd'] }).points).toBe(2);
    expect(gradeQuestion(q, { order: ['e', 'd', 'c', 'b', 'a'] }).points).toBe(0);
    // Untouched, incomplete or tampered orders count as the order first shown (reversed here: 0 points).
    expect(gradeQuestion(q, undefined).points).toBe(0);
    expect(gradeQuestion(q, { order: ['a', 'b', 'c', 'd'] }).points).toBe(0);
    expect(gradeQuestion(q, { order: ['a', 'a', 'b', 'c', 'd'] }).points).toBe(0);
    expect(gradeQuestion(q, { order: ['a', 'b', 'c', 'd', 'x'] }).points).toBe(0);
  });

  it('never starts an ordering question in a scoring order', () => {
    for (let n = 2; n <= 7; n++) {
      const ids = Array.from({ length: n }, (_, i) => `i${i}`);
      for (let k = 0; k < 40; k++) {
        const order = initialOrder(ids);
        expect(order).toHaveLength(n);
        expect(new Set(order).size).toBe(n);
        expect(orderedPairs(ids, order)).toBe(0);
      }
    }
  });

  it('leaves non-empty essays pending and scores blank ones zero', () => {
    const q = snap({ type: 'essay', points: 5 });
    expect(gradeQuestion(q, { text: 'An answer' })).toEqual({ correct: false, partial: false, points: 0, maxPoints: 5, pending: true });
    expect(gradeQuestion(q, { text: '   ' })).toEqual({ correct: false, partial: false, points: 0, maxPoints: 5 });
    expect(gradeQuestion(q, undefined).pending).toBeUndefined();
  });
});

const single = (prompt: string, points = 1) => ({
  type: 'single',
  prompt,
  points,
  options: [
    { text: 'Right', correct: true },
    { text: 'Wrong', correct: false },
  ],
});

describe.each(targets)('question bank ($name)', ({ make }) => {
  let lms: Coursekit;
  let cleanup: () => Promise<void>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let teacher: Client;
  let sam: Client;
  let courseId: string;

  beforeEach(async () => {
    const t = await make();
    lms = t.lms;
    cleanup = t.cleanup;
    school = await setupSchool(lms);
    teacher = school.teacher;
    sam = school.sam;
    courseId = school.course.id;
    await sam.post(`/api/courses/${courseId}/enrol`);
    await school.kim.post(`/api/courses/${courseId}/enrol`);
  });
  afterEach(async () => {
    await lms.close();
    await cleanup();
  });

  /** DELETE as the browser sends it (the shared test client sends no content type, which the CSRF guard treats as a form). */
  const del = async (who: Client, path: string) => {
    const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: who.cookie, 'content-type': 'application/json' } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const categories = async () => (await teacher.get(`/api/courses/${courseId}/question-categories`)).body as Array<Record<string, any>>;
  const create = async (body: Record<string, unknown>) => {
    const res = await teacher.post(`/api/courses/${courseId}/questions`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Record<string, any>;
  };
  const makeQuiz = async (settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const res = await teacher.post(`/api/courses/${courseId}/activities`, {
      sectionId: school.sectionId,
      type: 'quiz',
      title: 'Check-in',
      settings,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const setSlots = async (quizId: string, slots: unknown[]) => {
    const res = await teacher.put(`/api/activities/${quizId}/slots`, { slots });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Record<string, any>;
  };

  it('organises categories, keeps one at least and moves contents on delete', async () => {
    const [first] = await categories();
    expect(first).toMatchObject({ name: 'Default', parentId: null, questionCount: 0 });
    const unit = (await teacher.post(`/api/courses/${courseId}/question-categories`, { name: 'Unit 1' })).body;
    const sub = (await teacher.post(`/api/courses/${courseId}/question-categories`, { name: 'Unit 1a', parentId: unit.id })).body;
    expect((await teacher.post(`/api/courses/${courseId}/question-categories`, { name: '' })).status).toBe(400);
    expect((await teacher.patch(`/api/question-categories/${unit.id}`, { parentId: sub.id })).status).toBe(400);
    expect((await teacher.patch(`/api/question-categories/${unit.id}`, { name: 'Unit one' })).status).toBe(200);
    const q = await create({ ...single('In unit one'), categoryId: unit.id });
    expect((await categories()).map((c) => [c.name, c.questionCount])).toEqual([
      ['Default', 0],
      ['Unit one', 1],
      ['Unit 1a', 0],
    ]);

    expect((await del(teacher, `/api/question-categories/${unit.id}`)).status).toBe(400);
    expect((await del(teacher, `/api/question-categories/${unit.id}?moveTo=${sub.id}`)).status).toBe(400);
    expect((await del(teacher, `/api/question-categories/${unit.id}?moveTo=${first!.id}`)).status).toBe(200);
    const after = await categories();
    expect(after.find((c) => c.id === sub.id)!.parentId).toBe(first!.id);
    expect((await teacher.get(`/api/questions/${q.id}`)).body.categoryId).toBe(first!.id);

    expect((await del(teacher, `/api/question-categories/${sub.id}`)).status).toBe(200);
    expect((await del(teacher, `/api/question-categories/${first!.id}`)).status).toBe(400);
  });

  it('creates, finds, duplicates, moves and deletes questions', async () => {
    const [def] = await categories();
    const other = (await teacher.post(`/api/courses/${courseId}/question-categories`, { name: 'Other' })).body;
    const essay = await create({
      type: 'essay',
      name: 'Reflection',
      prompt: 'Write about **testing**',
      points: 5,
      maxWords: 100,
      graderNotes: 'Be kind',
    });
    expect(essay).toMatchObject({
      type: 'essay',
      name: 'Reflection',
      maxWords: 100,
      minWords: null,
      graderNotes: 'Be kind',
      categoryId: def!.id,
    });
    await create({ ...single('What is a unit test?'), categoryId: other.id });
    await create({
      type: 'ordering',
      prompt: 'Order the steps',
      options: [{ text: 'Arrange' }, { text: 'Act' }, { text: 'Assert' }],
    });

    const list = async (query: string) => (await teacher.get(`/api/courses/${courseId}/questions?${query}`)).body;
    expect((await list('')).total).toBe(3);
    expect((await list('q=UNIT')).items.map((i: any) => i.excerpt)).toEqual(['What is a unit test?']);
    expect((await list('q=reflect')).items[0]).toMatchObject({ name: 'Reflection', excerpt: 'Write about testing' });
    expect((await list('type=ordering')).total).toBe(1);
    expect((await list(`categoryId=${other.id}`)).total).toBe(1);
    expect((await list('pageSize=2&page=2')).items).toHaveLength(1);
    expect((await teacher.get(`/api/courses/${courseId}/questions?type=bogus`)).status).toBe(400);

    const copy = (await teacher.post(`/api/questions/${essay.id}/duplicate`)).body;
    expect(copy).toMatchObject({ name: 'Reflection (copy)', prompt: essay.prompt, graderNotes: 'Be kind' });
    expect(copy.id).not.toBe(essay.id);
    expect((await teacher.post(`/api/courses/${courseId}/questions/move`, { ids: [copy.id], categoryId: other.id })).body.moved).toBe(1);
    expect((await list(`categoryId=${other.id}`)).total).toBe(2);
    expect((await teacher.post(`/api/courses/${courseId}/questions/move`, { ids: [copy.id], categoryId: 'nope' })).status).toBe(400);

    const updated = await teacher.put(`/api/questions/${essay.id}`, {
      type: 'essay',
      prompt: 'Write about tests',
      points: 4,
      minWords: 10,
      maxWords: 100,
    });
    expect(updated.body).toMatchObject({ prompt: 'Write about tests', points: 4, minWords: 10, name: '' });

    // In use: deleting is blocked until the quiz no longer uses it.
    const quiz = await makeQuiz();
    await setSlots(quiz, [{ kind: 'question', questionId: essay.id }]);
    expect((await teacher.get(`/api/questions/${essay.id}`)).body.usage).toEqual([
      { activityId: quiz, title: 'Check-in', kind: 'question' },
    ]);
    const blocked = await del(teacher, `/api/questions/${essay.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Check-in');
    await setSlots(quiz, []);
    expect((await del(teacher, `/api/questions/${essay.id}`)).status).toBe(200);
    expect((await teacher.get(`/api/questions/${essay.id}`)).status).toBe(404);
  });

  it('validates the new question types', async () => {
    const bad = async (body: Record<string, unknown>) => (await teacher.post(`/api/courses/${courseId}/questions`, body)).status;
    expect(await bad({ type: 'matching', prompt: 'Match', pairs: [{ text: 'a', answer: 'b' }] })).toBe(400);
    expect(
      await bad({
        type: 'matching',
        prompt: 'Match',
        pairs: [
          { text: 'a', answer: 'b' },
          { text: 'c', answer: 'd' },
        ],
        distractors: ['B'],
      }),
    ).toBe(400);
    expect(await bad({ type: 'ordering', prompt: 'Order', options: [{ text: 'one' }] })).toBe(400);
    expect(await bad({ type: 'essay', prompt: 'Write', minWords: 50, maxWords: 10 })).toBe(400);
    const matching = await create({
      type: 'matching',
      prompt: 'Match',
      points: 2,
      pairs: [
        { id: 'x', text: 'a', answer: 'b' },
        { id: 'x', text: 'c', answer: 'd' },
      ],
      distractors: ['e', 'E'],
    });
    // Repeated ids are replaced and repeated distractors dropped.
    expect(new Set(matching.pairs.map((p: { id: string }) => p.id)).size).toBe(2);
    expect(matching.distractors).toEqual(['E']);
  });

  it('keeps the bank to people who manage it', async () => {
    const q = await create(single('Private'));
    const [cat] = await categories();
    expect((await sam.get(`/api/courses/${courseId}/question-categories`)).status).toBe(403);
    expect((await sam.get(`/api/courses/${courseId}/questions`)).status).toBe(403);
    expect((await sam.post(`/api/courses/${courseId}/questions`, single('Mine'))).status).toBe(403);
    expect((await sam.get(`/api/questions/${q.id}`)).status).toBe(404);
    expect((await sam.post(`/api/questions/${q.id}/check`, { answer: {} })).status).toBe(404);
    expect((await del(sam, `/api/question-categories/${cat!.id}`)).status).toBe(404);

    // Teaching assistants can grade but not edit the bank.
    const people = (await teacher.get(`/api/courses/${courseId}/participants`)).body as Array<{
      enrolmentId: string;
      user: { email: string };
    }>;
    const kim = people.find((p) => p.user.email === 'kim@test.dev')!;
    await teacher.patch(`/api/courses/${courseId}/participants/${kim.enrolmentId}`, { role: 'assistant' });
    expect((await school.kim.get(`/api/courses/${courseId}/question-categories`)).status).toBe(403);
    expect((await school.kim.get(`/api/questions/${q.id}`)).status).toBe(404);

    // Another teacher's course is off limits too.
    const otherCourse = (await school.admin.post('/api/courses', { title: 'Elsewhere', visibility: 'published' })).body;
    expect((await teacher.get(`/api/courses/${otherCourse.id}/questions`)).status).toBe(403);
    expect((await school.admin.get(`/api/questions/${q.id}`)).status).toBe(200);
  });

  it('previews and checks questions without an attempt', async () => {
    const q = await create({
      type: 'ordering',
      prompt: 'Order',
      points: 2,
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
        { id: 'c', text: 'C' },
      ],
    });
    const preview = (await teacher.get(`/api/questions/${q.id}/preview`)).body;
    expect(preview.question.options.map((o: { id: string }) => o.id)).not.toEqual(['a', 'b', 'c']);
    expect(preview.answer.order).toHaveLength(3);
    const check = (await teacher.post(`/api/questions/${q.id}/check`, { answer: { order: ['a', 'b', 'c'] } })).body;
    expect(check.result).toMatchObject({ correct: true, points: 2 });
    expect(check.question.options.map((o: { id: string }) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('builds attempts from fixed and random slots without repeating a question', async () => {
    const pool = (await teacher.post(`/api/courses/${courseId}/question-categories`, { name: 'Pool' })).body;
    const sub = (await teacher.post(`/api/courses/${courseId}/question-categories`, { name: 'Pool extras', parentId: pool.id })).body;
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await create({ ...single(`Pool question ${i}`), categoryId: pool.id })).id);
    const extra = (await create({ ...single('Extra question'), categoryId: sub.id })).id;
    const quiz = await makeQuiz();

    const saved = await setSlots(quiz, [
      { kind: 'question', questionId: ids[0], points: 2 },
      { kind: 'random', categoryId: pool.id, questionCount: 3 },
    ]);
    expect(saved).toMatchObject({ questionCount: 4, totalPoints: 5, problems: [] });
    expect(saved.slots[1]).toMatchObject({ kind: 'random', available: 4, needed: 3, points: 1, category: { name: 'Pool' } });
    expect((await teacher.get(`/api/activities/${quiz}`)).body).toMatchObject({ maxGrade: 5, quiz: { questionCount: 4, totalPoints: 5 } });
    const course = (await teacher.get(`/api/courses/${courseId}`)).body;
    expect(course.sections[0].activities.find((a: { id: string }) => a.id === quiz).meta).toBe('4 questions');

    for (let run = 0; run < 6; run++) {
      const started = await sam.post(`/api/activities/${quiz}/attempts`);
      expect(started.status).toBe(201);
      const attempt = (await sam.get(`/api/attempts/${started.body.id}`)).body;
      const qids = attempt.questions.map((q: { id: string }) => q.id);
      expect(qids).toHaveLength(4);
      expect(new Set(qids).size).toBe(4);
      expect(qids[0]).toBe(ids[0]);
      expect(attempt.questions[0].points).toBe(2);
      for (const id of qids.slice(1)) expect(ids.slice(1)).toContain(id);
      expect(attempt.maxScore).toBe(5);
      await sam.post(`/api/attempts/${started.body.id}/submit`, {});
    }

    // Subcategories only count when asked for.
    const wide = await setSlots(quiz, [{ kind: 'random', categoryId: pool.id, questionCount: 6, includeSubcategories: true }]);
    expect(wide.problems).toEqual([]);
    const narrow = await setSlots(quiz, [
      { kind: 'random', categoryId: pool.id, questionCount: 5, includeSubcategories: true },
      { kind: 'random', categoryId: sub.id, questionCount: 1 },
    ]);
    // Narrow pools are filled first, so this always works.
    expect(narrow.problems).toEqual([]);
    for (let run = 0; run < 4; run++) {
      const started = await teacher.post(`/api/activities/${quiz}/attempts`);
      const attempt = (await teacher.get(`/api/attempts/${started.body.id}`)).body;
      expect(attempt.questions.map((q: { id: string }) => q.id).at(-1)).toBe(extra);
      await teacher.post(`/api/attempts/${started.body.id}/submit`, {});
    }

    const tooMany = await setSlots(quiz, [
      { kind: 'question', questionId: ids[0] },
      { kind: 'random', categoryId: pool.id, questionCount: 5 },
    ]);
    expect(tooMany.slots[1]).toMatchObject({ available: 4, needed: 5 });
    expect(tooMany.problems).toHaveLength(1);
    const refused = await teacher.post(`/api/activities/${quiz}/attempts`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Pool');

    expect(
      (
        await teacher.put(`/api/activities/${quiz}/slots`, {
          slots: [
            { kind: 'question', questionId: ids[0] },
            { kind: 'question', questionId: ids[0] },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await teacher.put(`/api/activities/${quiz}/slots`, { slots: [{ kind: 'random', categoryId: 'nope', questionCount: 1 }] })).status,
    ).toBe(400);
    expect((await sam.get(`/api/activities/${quiz}/slots`)).status).toBe(403);
    expect((await sam.put(`/api/activities/${quiz}/slots`, { slots: [] })).status).toBe(403);
  });

  it('keeps started and finished attempts as they were when the bank changes', async () => {
    const q = await create(single('Original prompt', 2));
    const quiz = await makeQuiz();
    await setSlots(quiz, [{ kind: 'question', questionId: q.id }]);
    const right = q.options.find((o: { correct: boolean }) => o.correct).id;

    const first = (await sam.post(`/api/activities/${quiz}/attempts`)).body.id;
    await teacher.put(`/api/questions/${q.id}`, {
      type: 'single',
      prompt: 'Edited prompt',
      points: 2,
      options: [
        { id: q.options[0].id, text: 'Now wrong', correct: false },
        { id: q.options[1].id, text: 'Now right', correct: true },
      ],
    });
    const during = (await sam.get(`/api/attempts/${first}`)).body;
    expect(during.questions[0]).toMatchObject({ prompt: 'Original prompt', options: [{ text: 'Right' }, { text: 'Wrong' }] });
    const submitted = (await sam.post(`/api/attempts/${first}/submit`, { answers: { [q.id]: { optionIds: [right] } } })).body;
    expect(submitted).toMatchObject({ status: 'finished', score: 2, maxScore: 2 });
    expect(submitted.questions[0].options.find((o: { correct: boolean }) => o.correct).text).toBe('Right');

    // Removing the question from the quiz allows deleting it; the review still shows it.
    await setSlots(quiz, [{ kind: 'question', questionId: (await create(single('Replacement'))).id }]);
    expect((await del(teacher, `/api/questions/${q.id}`)).status).toBe(200);
    const review = (await sam.get(`/api/attempts/${first}`)).body;
    expect(review).toMatchObject({ score: 2, review: true });
    expect(review.questions[0].prompt).toBe('Original prompt');
    expect(review.results[q.id]).toMatchObject({ correct: true, points: 2 });

    const second = (await sam.post(`/api/activities/${quiz}/attempts`)).body.id;
    expect((await sam.get(`/api/attempts/${second}`)).body.questions[0].prompt).toBe('Replacement');
  });

  it('marks essays by hand before recording the grade', async () => {
    const essay = await create({ type: 'essay', prompt: 'Why test?', points: 5, graderNotes: 'Mention regressions' });
    const tf = await create({
      type: 'truefalse',
      prompt: 'Tests help',
      options: [
        { text: 'True', correct: true },
        { text: 'False', correct: false },
      ],
    });
    const quiz = await makeQuiz({ attemptsAllowed: 1 }, { completion: 'auto' });
    await setSlots(quiz, [
      { kind: 'question', questionId: essay.id },
      { kind: 'question', questionId: tf.id },
    ]);
    const events: string[] = [];
    lms.events.onAny((name, payload) => {
      if (name.startsWith('quiz.') || name === 'grade.updated')
        events.push(`${name}:${'needsGrading' in payload ? payload.needsGrading : ''}`);
    });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const trueId = tf.options.find((o: { correct: boolean }) => o.correct).id;

    const attemptId = (await sam.post(`/api/activities/${quiz}/attempts`)).body.id;
    await sam.put(`/api/attempts/${attemptId}`, { answers: { [essay.id]: { text: 'Draft' } } });
    expect((await sam.get(`/api/attempts/${attemptId}`)).body.answers[essay.id].text).toBe('Draft');
    const submitted = (
      await sam.post(`/api/attempts/${attemptId}/submit`, {
        answers: { [essay.id]: { text: 'They catch regressions.' }, [tf.id]: { optionIds: [trueId] } },
      })
    ).body;
    expect(submitted).toMatchObject({ status: 'needs_grading', score: null, maxScore: 6, pendingCount: 1, canGrade: false });
    expect(submitted.results[essay.id]).toMatchObject({ pending: true, points: 0 });
    expect(submitted.results[tf.id]).toMatchObject({ correct: true, points: 1 });
    expect(JSON.stringify(submitted)).not.toContain('Mention regressions');
    await tick();
    expect(events).toEqual(['quiz.attempt.submitted:true']);

    // No grade yet, but the student has used their attempt and handing it in completed the quiz.
    const mine = (await sam.get(`/api/courses/${courseId}/grades`)).body.grades.items.find(
      (i: { activityId: string }) => i.activityId === quiz,
    );
    expect(mine.score).toBeNull();
    const detail = (await sam.get(`/api/activities/${quiz}`)).body;
    expect(detail).toMatchObject({ completed: true, quiz: { canAttempt: false } });
    expect(detail.quiz.attempts[0]).toMatchObject({ status: 'needs_grading', score: null });
    expect(detail.quiz.needsGrading).toBeUndefined();

    expect((await teacher.get(`/api/activities/${quiz}`)).body.quiz.needsGrading).toBe(1);
    const queue = (await teacher.get(`/api/activities/${quiz}/grading`)).body;
    expect(queue).toEqual([
      expect.objectContaining({ attemptId, attemptNumber: 1, pending: 1, user: expect.objectContaining({ name: 'Sam Student' }) }),
    ]);
    expect((await sam.get(`/api/activities/${quiz}/grading`)).status).toBe(403);
    const forTeacher = (await teacher.get(`/api/attempts/${attemptId}`)).body;
    expect(forTeacher).toMatchObject({ canGrade: true, user: { name: 'Sam Student' } });
    expect(forTeacher.questions[0].graderNotes).toBe('Mention regressions');

    const grade = (points: number, comment: string | null = null, who = teacher, questionId = essay.id) =>
      who.put(`/api/attempts/${attemptId}/questions/${questionId}/grade`, { points, comment });
    expect((await grade(4, null, sam)).status).toBe(403);
    expect((await grade(6)).status).toBe(400);
    expect((await grade(-1)).status).toBe(400);
    expect((await grade(1, null, teacher, tf.id)).status).toBe(400);
    expect((await grade(1, null, teacher, 'missing')).status).toBe(404);

    const graded = (await grade(4, 'Good point about regressions.')).body;
    expect(graded).toMatchObject({ status: 'finished', score: 5, pendingCount: 0 });
    expect(graded.results[essay.id]).toMatchObject({
      points: 4,
      partial: true,
      comment: 'Good point about regressions.',
      gradedBy: { name: 'Tina Teacher' },
    });
    await tick();
    expect(events).toEqual(['quiz.attempt.submitted:true', 'grade.updated:', 'quiz.attempt.finished:']);
    const book = (await sam.get(`/api/courses/${courseId}/grades`)).body.grades.items.find(
      (i: { activityId: string }) => i.activityId === quiz,
    );
    expect(book.score).toBe(5);
    const notes = (await sam.get('/api/notifications')).body.items;
    expect(notes[0]).toMatchObject({ type: 'grade', link: `/courses/${school.course.slug}/attempts/${attemptId}` });
    expect(notes[0].title).toContain('Check-in');

    const seen = (await sam.get(`/api/attempts/${attemptId}`)).body;
    expect(seen.results[essay.id]).toMatchObject({ points: 4, comment: 'Good point about regressions.' });
    expect(JSON.stringify(seen)).not.toContain('Mention regressions');
    expect((await teacher.get(`/api/activities/${quiz}/grading`)).body).toEqual([]);

    // Changing the mark later updates the grade without a second notification.
    expect((await grade(5)).body).toMatchObject({ status: 'finished', score: 6 });
    expect(
      (await sam.get(`/api/courses/${courseId}/grades`)).body.grades.items.find((i: { activityId: string }) => i.activityId === quiz).score,
    ).toBe(6);
    expect((await sam.get('/api/notifications')).body.items.filter((n: { type: string }) => n.type === 'grade')).toHaveLength(1);

    // A blank essay needs no marking.
    const kimAttempt = (await school.kim.post(`/api/activities/${quiz}/attempts`)).body.id;
    expect(
      (await school.kim.post(`/api/attempts/${kimAttempt}/submit`, { answers: { [tf.id]: { optionIds: [trueId] } } })).body,
    ).toMatchObject({ status: 'finished', score: 1 });
  });

  it('hands in timed-out attempts with their autosaved new-type answers', async () => {
    const essay = await create({ type: 'essay', prompt: 'Explain', points: 2 });
    const ordering = await create({
      type: 'ordering',
      prompt: 'Order',
      points: 2,
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
        { id: 'c', text: 'C' },
      ],
    });
    const quiz = await makeQuiz({ timeLimitMinutes: 5 });
    await setSlots(quiz, [
      { kind: 'question', questionId: essay.id },
      { kind: 'question', questionId: ordering.id },
    ]);
    const attemptId = (await sam.post(`/api/activities/${quiz}/attempts`)).body.id;
    const started = (await sam.get(`/api/attempts/${attemptId}`)).body;
    expect(started.deadlineAt).toBeTruthy();
    await sam.put(`/api/attempts/${attemptId}`, {
      answers: { [essay.id]: { text: 'Saved before time ran out' }, [ordering.id]: { order: ['a', 'b', 'c'] } },
    });

    // Time runs out: the next request hands the attempt in with what was saved, and late answers are ignored.
    await lms.db
      .updateTable('quizAttempts')
      .set({ deadlineAt: new Date(Date.now() - 120_000).toISOString() })
      .where('id', '=', attemptId)
      .execute();
    expect((await sam.put(`/api/attempts/${attemptId}`, { answers: {} })).status).toBe(400);
    const late = (await sam.post(`/api/attempts/${attemptId}/submit`, { answers: { [ordering.id]: { order: ['c', 'b', 'a'] } } })).body;
    expect(late).toMatchObject({ status: 'needs_grading', score: null, pendingCount: 1 });
    expect(late.results[ordering.id]).toMatchObject({ correct: true, points: 2 });
    expect(late.answers[essay.id].text).toBe('Saved before time ran out');
  });

  it('never shows students correct answers or grader notes before review is allowed', async () => {
    const questions = [
      await create(single('Pick right')),
      await create({ type: 'short', prompt: 'Say hello', acceptedAnswers: ['hello'] }),
      await create({ type: 'essay', prompt: 'Explain', graderNotes: 'SECRET-NOTES', points: 2 }),
      await create({
        type: 'matching',
        prompt: 'Match',
        pairs: [
          { text: 'One', answer: 'Uno' },
          { text: 'Two', answer: 'Dos' },
        ],
        distractors: ['Tres'],
        explanation: 'SECRET-EXPLANATION',
      }),
      await create({
        type: 'ordering',
        prompt: 'Order',
        options: [
          { id: 'o1', text: 'First' },
          { id: 'o2', text: 'Second' },
          { id: 'o3', text: 'Third' },
        ],
      }),
    ];
    const quiz = await makeQuiz({ reviewMode: 'after_due' }, { dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    await setSlots(
      quiz,
      questions.map((q) => ({ kind: 'question', questionId: q.id })),
    );
    const leaks = (body: unknown) => {
      const json = JSON.stringify(body);
      return ['"correct"', 'acceptedAnswers', 'SECRET-NOTES', 'graderNotes', 'SECRET-EXPLANATION', '"answer"', 'answerId'].filter((s) =>
        json.includes(s),
      );
    };

    const attemptId = (await sam.post(`/api/activities/${quiz}/attempts`)).body.id;
    const during = (await sam.get(`/api/attempts/${attemptId}`)).body;
    expect(leaks(during)).toEqual([]);
    const ordering = during.questions[4];
    expect(ordering.options.map((o: { id: string }) => o.id)).not.toEqual(['o1', 'o2', 'o3']);
    expect(during.answers[ordering.id].order).toEqual(ordering.options.map((o: { id: string }) => o.id));
    expect(during.questions[3].choices.map((c: { text: string }) => c.text).sort()).toEqual(['Dos', 'Tres', 'Uno']);

    const after = (await sam.post(`/api/attempts/${attemptId}/submit`, { answers: { [questions[2]!.id]: { text: 'Because.' } } })).body;
    expect(after).toMatchObject({ review: false, status: 'needs_grading' });
    expect(leaks({ ...after, results: null })).toEqual([]);
    // Without review only the essay's (pending) mark is shown.
    expect(Object.keys(after.results)).toEqual([questions[2]!.id]);
    expect(after.results[questions[2]!.id]).toMatchObject({ pending: true });
    expect(leaks((await sam.get(`/api/activities/${quiz}`)).body)).toEqual([]);

    // Staff always see the full review.
    const staff = (await teacher.get(`/api/attempts/${attemptId}`)).body;
    expect(staff.review).toBe(true);
    expect(leaks(staff)).toEqual(expect.arrayContaining(['"correct"', 'SECRET-NOTES', 'SECRET-EXPLANATION', 'answerId']));

    // Once review opens students see answers and explanations, but never grader notes.
    await teacher.patch(`/api/activities/${quiz}`, { settings: { reviewMode: 'immediate' } });
    const open = (await sam.get(`/api/attempts/${attemptId}`)).body;
    expect(open.review).toBe(true);
    expect(leaks(open)).not.toContain('SECRET-NOTES');
    expect(leaks(open)).not.toContain('graderNotes');
    expect(leaks(open)).toEqual(expect.arrayContaining(['"correct"', 'SECRET-EXPLANATION', 'answerId']));
    expect(open.questions[4].options.map((o: { id: string }) => o.id)).toEqual(['o1', 'o2', 'o3']);
  });

  it('still supports the 0.1.x questions endpoint and course deletion', async () => {
    const quiz = await makeQuiz();
    const saved = await teacher.put(`/api/activities/${quiz}/questions`, {
      questions: [
        { type: 'numeric', prompt: '2 + 2', points: 3, acceptedAnswers: ['4'] },
        { type: 'essay', prompt: 'Why?', points: 2 },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.map((q: { type: string }) => q.type)).toEqual(['numeric', 'essay']);
    const again = await teacher.put(`/api/activities/${quiz}/questions`, { questions: [{ ...saved.body[0], prompt: '3 + 1' }] });
    expect(again.body).toEqual([expect.objectContaining({ id: saved.body[0].id, prompt: '3 + 1' })]);
    expect((await teacher.get(`/api/activities/${quiz}`)).body.maxGrade).toBe(3);
    // Questions taken out of a quiz stay in the bank.
    expect((await teacher.get(`/api/courses/${courseId}/questions`)).body.total).toBe(2);
    expect((await del(teacher, `/api/courses/${courseId}`)).status).toBe(200);
  });
});

describe.each([{ name: 'SQLite', target: sqliteTarget }, ...(PG_URL ? [{ name: 'PostgreSQL', target: postgresTarget }] : [])])(
  'upgrading from 0.1.x ($name)',
  ({ target }) => {
    it('moves quiz questions into the bank and snapshots existing attempts', async () => {
      const { url, dataDir, cleanup } = await target();
      const { db } = await createDatabase(url);
      const raw = db.withoutPlugins() as unknown as Kysely<any>;
      const migrator = new Migrator({ db: raw, provider: { getMigrations: async () => migrations } });
      const step = await migrator.migrateTo('001_initial');
      expect(step.error).toBeUndefined();

      const ts = '2026-10-01T09:00:00.000Z';
      const hash = await hashPassword(PASSWORD);
      const user = (id: string, email: string, role: string) => ({
        id,
        email,
        name: id,
        password_hash: hash,
        role,
        status: 'active',
        created_at: ts,
        updated_at: ts,
      });
      await raw
        .insertInto('users')
        .values([user('teach', 'teach@old.dev', 'instructor'), user('stud', 'stud@old.dev', 'student')])
        .execute();
      await raw
        .insertInto('courses')
        .values({ id: 'course', slug: 'old-course', title: 'Old course', visibility: 'published', created_at: ts, updated_at: ts })
        .execute();
      await raw
        .insertInto('enrolments')
        .values([
          { id: 'e1', course_id: 'course', user_id: 'teach', role: 'teacher', status: 'active', created_at: ts },
          { id: 'e2', course_id: 'course', user_id: 'stud', role: 'student', status: 'active', created_at: ts },
        ])
        .execute();
      await raw.insertInto('sections').values({ id: 'sec', course_id: 'course', title: 'Week 1', position: 0, created_at: ts }).execute();
      const quiz = (id: string, position: number) => ({
        id,
        course_id: 'course',
        section_id: 'sec',
        type: 'quiz',
        title: 'Week 1 quiz',
        position,
        settings: JSON.stringify({ reviewMode: 'immediate', attemptsAllowed: 0 }),
        max_grade: 3,
        completion: 'none',
        created_by: 'teach',
        created_at: ts,
        updated_at: ts,
      });
      await raw
        .insertInto('activities')
        .values([quiz('quiz1', 0), quiz('quiz2', 1), { ...quiz('empty', 2), title: 'No questions yet' }])
        .execute();
      const options = JSON.stringify([
        { id: 'a', text: 'Alpha', correct: true },
        { id: 'b', text: 'Beta', correct: false },
      ]);
      await raw
        .insertInto('questions')
        .values([
          {
            id: 'q1',
            activity_id: 'quiz1',
            type: 'single',
            prompt: 'Pick alpha',
            points: 1,
            options,
            accepted_answers: '[]',
            tolerance: null,
            position: 0,
          },
          {
            id: 'q2',
            activity_id: 'quiz1',
            type: 'numeric',
            prompt: '2 + 2',
            points: 2,
            options: '[]',
            accepted_answers: '["4"]',
            tolerance: 0,
            position: 1,
          },
          {
            id: 'q3',
            activity_id: 'quiz2',
            type: 'short',
            prompt: 'Say hi',
            points: 1,
            options: '[]',
            accepted_answers: '["hi"]',
            tolerance: null,
            position: 0,
          },
        ])
        .execute();
      const attempt = (id: string, status: string, order: string[], answers: object, extra: object = {}) => ({
        id,
        activity_id: 'quiz1',
        course_id: 'course',
        user_id: 'stud',
        attempt_number: id === 'done' ? 1 : 2,
        status,
        question_order: JSON.stringify(order),
        answers: JSON.stringify(answers),
        max_score: 3,
        started_at: ts,
        results: null,
        score: null,
        finished_at: null,
        ...extra,
      });
      await raw
        .insertInto('quiz_attempts')
        .values([
          attempt(
            'done',
            'finished',
            ['q2', 'q1', 'gone'],
            { q1: { optionIds: ['a'] }, q2: { text: '4' } },
            {
              results: JSON.stringify({
                q1: { correct: true, partial: false, points: 1, maxPoints: 1 },
                q2: { correct: true, partial: false, points: 2, maxPoints: 2 },
              }),
              score: 3,
              finished_at: ts,
            },
          ),
          attempt('open', 'in_progress', ['q1', 'q2'], { q1: { optionIds: ['b'] } }),
        ])
        .execute();
      await raw
        .insertInto('grades')
        .values({ activity_id: 'quiz1', user_id: 'stud', course_id: 'course', score: 3, graded_at: ts, updated_at: ts })
        .execute();
      await db.destroy();

      const lms = await createCoursekit({ databaseUrl: url, dataDir, webDir: false });
      try {
        const cats = await lms.db.selectFrom('questionCategories').selectAll().orderBy('position').execute();
        expect(cats.map((c) => c.name)).toEqual(['Week 1 quiz', 'Week 1 quiz (2)']);
        const questions = await lms.db.selectFrom('questions').selectAll().orderBy('id').execute();
        expect(questions.map((q) => [q.id, q.courseId, q.categoryId, q.points])).toEqual([
          ['q1', 'course', cats[0]!.id, 1],
          ['q2', 'course', cats[0]!.id, 2],
          ['q3', 'course', cats[1]!.id, 1],
        ]);
        const slots = await lms.db.selectFrom('quizSlots').selectAll().where('activityId', '=', 'quiz1').orderBy('position').execute();
        expect(slots.map((s) => [s.kind, s.questionId, s.points, s.questionCount])).toEqual([
          ['question', 'q1', 1, 1],
          ['question', 'q2', 2, 1],
        ]);
        const done = await lms.db.selectFrom('quizAttempts').selectAll().where('id', '=', 'done').executeTakeFirstOrThrow();
        expect(JSON.parse(done.snapshot).map((q: { id: string; prompt: string }) => [q.id, q.prompt])).toEqual([
          ['q2', '2 + 2'],
          ['q1', 'Pick alpha'],
        ]);

        const student = await login(lms, 'stud@old.dev');
        const teacher = await login(lms, 'teach@old.dev');
        const review = (await student.get('/api/attempts/done')).body;
        expect(review).toMatchObject({ status: 'finished', score: 3, maxScore: 3, review: true });
        expect(review.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['2 + 2', 'Pick alpha']);
        expect(review.results.q1).toMatchObject({ correct: true });

        // Editing the bank leaves the old attempts alone.
        const edit = await teacher.put('/api/questions/q1', {
          type: 'single',
          prompt: 'Pick beta',
          options: [
            { id: 'a', text: 'Alpha', correct: false },
            { id: 'b', text: 'Beta', correct: true },
          ],
        });
        expect(edit.status).toBe(200);
        expect((await student.get('/api/attempts/done')).body.questions[1].prompt).toBe('Pick alpha');
        const submitted = (await student.post('/api/attempts/open/submit', {})).body;
        expect(submitted).toMatchObject({ status: 'finished', score: 0, maxScore: 3 });
        expect(submitted.questions[0].prompt).toBe('Pick alpha');

        const detail = (await teacher.get('/api/activities/quiz1')).body;
        expect(detail.quiz).toMatchObject({ questionCount: 2, totalPoints: 3 });
        expect((await teacher.get('/api/activities/empty')).body.quiz.questionCount).toBe(0);
        expect((await teacher.get('/api/activities/quiz1/questions')).body.map((q: { id: string }) => q.id)).toEqual(['q1', 'q2']);
        expect(
          (await student.get('/api/courses/course/grades')).body.grades.items.find((i: { activityId: string }) => i.activityId === 'quiz1')
            .score,
        ).toBe(3);
      } finally {
        await lms.close();
        await cleanup();
      }
    });
  },
);
