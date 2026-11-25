/**
 * Demo content for question banks: the demo quizzes' questions live in each course's bank, and Modern Web
 * Development gets a categorised bank with essay, matching and ordering questions, a quiz that uses fixed
 * and random slots, and attempts waiting for their essays to be marked.
 */
import type { z } from 'zod';
import type { AttemptAnswer, QuestionType } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { DB } from '../db/types.js';
import type { QuestionRow, QuizAttemptRow, QuizSlotRow } from '../db/schema.js';
import { newId, round } from '../lib/util.js';
import {
  gradeQuestion,
  matchChoiceId,
  questionInputSchema,
  snapshotFromRow,
  storedQuestion,
  type QuestionSnapshot,
} from '../services/question-types.js';
import type { StoredResult } from '../services/quiz.js';

/** A demo quiz question as the demo course specs describe it (one quiz each). */
export interface DemoQuestionRow {
  id: string;
  activityId: string;
  type: QuestionType;
  prompt: string;
  points: number;
  options: string;
  acceptedAnswers: string;
  tolerance: number | null;
  explanation: string | null;
  position: number;
}

const DAY = 86_400_000;
const at = (days: number, hour = 9, minute = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Puts each demo quiz's questions into its course's bank (a category per quiz) and makes them the quiz's slots. */
export async function insertDemoQuizQuestions(db: DB, rows: DemoQuestionRow[]): Promise<void> {
  const byQuiz = new Map<string, DemoQuestionRow[]>();
  for (const row of rows) byQuiz.set(row.activityId, [...(byQuiz.get(row.activityId) ?? []), row]);
  if (byQuiz.size === 0) return;
  const quizzes = await db
    .selectFrom('activities')
    .select(['id', 'courseId', 'title', 'createdBy', 'createdAt'])
    .where('id', 'in', [...byQuiz.keys()])
    .execute();
  const positions = new Map<string, number>();
  for (const quiz of quizzes) {
    const position = positions.get(quiz.courseId) ?? 0;
    positions.set(quiz.courseId, position + 1);
    const categoryId = newId();
    await db
      .insertInto('questionCategories')
      .values({
        id: categoryId,
        courseId: quiz.courseId,
        parentId: null,
        name: quiz.title,
        description: `Questions from the quiz “${quiz.title}”.`,
        position,
        createdAt: quiz.createdAt,
      })
      .execute();
    const questions = [...byQuiz.get(quiz.id)!].sort((a, b) => a.position - b.position);
    await db
      .insertInto('questions')
      .values(
        questions.map((q) => ({
          id: q.id,
          courseId: quiz.courseId,
          categoryId,
          type: q.type,
          name: '',
          prompt: q.prompt,
          points: q.points,
          options: q.options,
          acceptedAnswers: q.acceptedAnswers,
          tolerance: q.tolerance,
          explanation: q.explanation,
          settings: '{}',
          createdBy: quiz.createdBy,
          createdAt: quiz.createdAt,
          updatedAt: quiz.createdAt,
        })),
      )
      .execute();
    await db
      .insertInto('quizSlots')
      .values(
        questions.map((q, i) => ({
          id: newId(),
          activityId: quiz.id,
          position: i,
          kind: 'question' as const,
          questionId: q.id,
          categoryId: null,
          questionCount: 1,
          includeSubcategories: 0,
          points: q.points,
        })),
      )
      .execute();
  }
}

/** Snapshots for demo attempts that were inserted without one. */
async function backfillSnapshots(db: DB, courseIds: string[]) {
  if (courseIds.length === 0) return;
  const attempts = await db
    .selectFrom('quizAttempts')
    .select(['id', 'questionOrder'])
    .where('courseId', 'in', courseIds)
    .where('snapshot', '=', '[]')
    .execute();
  const ids = [...new Set(attempts.flatMap((a) => JSON.parse(a.questionOrder) as string[]))];
  const rows: QuestionRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    rows.push(
      ...(await db
        .selectFrom('questions')
        .selectAll()
        .where('id', 'in', ids.slice(i, i + 400))
        .execute()),
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const attempt of attempts) {
    const snapshot = (JSON.parse(attempt.questionOrder) as string[]).flatMap((id) => {
      const row = byId.get(id);
      return row ? [snapshotFromRow(row)] : [];
    });
    await db
      .updateTable('quizAttempts')
      .set({ snapshot: JSON.stringify(snapshot) })
      .where('id', '=', attempt.id)
      .execute();
  }
}

type DemoQuestion = z.input<typeof questionInputSchema> & { key: string; category: string };

const BANK: Array<{ key: string; name: string; description: string; parent?: string }> = [
  { key: 'web', name: 'Web fundamentals', description: 'How the web works, HTML, CSS and accessibility.' },
  { key: 'html', name: 'HTML semantics', description: 'Choosing the right element.', parent: 'web' },
  { key: 'css', name: 'CSS layout', description: 'Flexbox, Grid and the box model.', parent: 'web' },
  { key: 'a11y', name: 'Accessibility', description: 'Building for everyone.', parent: 'web' },
];

const QUESTIONS: DemoQuestion[] = [
  {
    key: 'elements',
    category: 'html',
    type: 'matching',
    name: 'Match HTML elements',
    prompt: 'Match each element to what it represents.',
    points: 4,
    pairs: [
      { id: 'nav', text: '`<nav>`', answer: 'A block of navigation links' },
      { id: 'aside', text: '`<aside>`', answer: 'Content related to the page, but not essential to it' },
      { id: 'footer', text: '`<footer>`', answer: 'Information about its section, like the author or copyright' },
      { id: 'figure', text: '`<figure>`', answer: 'Self-contained media with an optional caption' },
    ],
    distractors: ['A control that submits a form'],
    explanation: 'Landmark elements such as `<nav>` and `<aside>` also help screen reader users jump around the page.',
  },
  {
    key: 'main',
    category: 'html',
    type: 'single',
    prompt: "Which element should wrap a page's main content?",
    points: 1,
    options: [
      { text: '`<main>`', correct: true },
      { text: '`<section>`', correct: false },
      { text: '`<div id="main">`', correct: false },
      { text: '`<article>`', correct: false },
    ],
  },
  {
    key: 'pageload',
    category: 'web',
    type: 'ordering',
    name: 'Loading a web page',
    prompt: 'Put the steps of loading a web page in order, from typing the address to seeing the page.',
    points: 3,
    options: [
      { id: 'dns', text: 'The browser looks up the domain name (DNS)' },
      { id: 'tcp', text: 'It opens a connection to the server (TCP and TLS)' },
      { id: 'req', text: 'It sends an HTTP request for the page' },
      { id: 'parse', text: 'It parses the HTML and fetches CSS, scripts and images' },
      { id: 'paint', text: 'It lays out and paints the page' },
    ],
    explanation: 'Caching can skip steps on later visits, but the order stays the same.',
  },
  {
    key: 'specificity',
    category: 'css',
    type: 'ordering',
    name: 'Selector specificity',
    prompt: 'Order these from **lowest** to **highest** specificity.',
    points: 2,
    options: [
      { id: 'el', text: '`p`' },
      { id: 'cls', text: '`.intro`' },
      { id: 'elcls', text: '`p.intro`' },
      { id: 'id', text: '`#hero`' },
      { id: 'inline', text: 'A `style="…"` attribute' },
    ],
  },
  {
    key: 'flex',
    category: 'css',
    type: 'single',
    prompt: 'Which declaration turns an element into a flex container?',
    points: 1,
    options: [
      { text: '`display: flex`', correct: true },
      { text: '`flex: 1`', correct: false },
      { text: '`position: flex`', correct: false },
    ],
  },
  {
    key: 'grid',
    category: 'css',
    type: 'multiple',
    prompt: 'Which declarations create a grid container? Select all that apply.',
    points: 1,
    options: [
      { text: '`display: grid`', correct: true },
      { text: '`display: inline-grid`', correct: true },
      { text: '`display: block`', correct: false },
      { text: '`grid-area: main`', correct: false },
    ],
  },
  {
    key: 'boxmodel',
    category: 'css',
    type: 'numeric',
    prompt:
      'A box has `width: 200px`, `padding: 10px` and a `5px` border, with `box-sizing: content-box`. How wide is it on screen, in pixels?',
    points: 1,
    acceptedAnswers: ['230'],
    explanation: '200 + 2 × 10 (padding) + 2 × 5 (border) = 230.',
  },
  {
    key: 'colour',
    category: 'a11y',
    type: 'essay',
    name: 'Colour and meaning',
    prompt: "Explain why colour alone shouldn't be used to convey information, and suggest two alternatives.",
    points: 5,
    minWords: 40,
    maxWords: 200,
    graderNotes:
      'Look for: people with colour vision deficiencies, screen readers and monochrome displays miss colour-only cues. Full marks need two concrete alternatives, e.g. text labels, icons, patterns or underlines.',
    explanation: 'WCAG 1.4.1 (Use of Color) asks for a second visual cue wherever colour carries meaning.',
  },
  {
    key: 'contrast',
    category: 'a11y',
    type: 'single',
    prompt: 'What contrast ratio does WCAG AA ask for normal-size body text?',
    points: 1,
    options: [
      { text: '4.5:1', correct: true },
      { text: '3:1', correct: false },
      { text: '7:1', correct: false },
    ],
  },
  {
    key: 'layout-essay',
    category: 'css',
    type: 'essay',
    name: 'Flexbox or Grid?',
    prompt: 'Describe a layout you would build with Grid rather than Flexbox, and why.',
    points: 3,
    maxWords: 150,
    graderNotes: 'Any two-dimensional layout (rows and columns) is a good answer; reward a clear reason.',
  },
];

const ESSAYS = {
  alex: 'Some people cannot tell certain colours apart, for example red and green, so a form that only turns a field red when it has an error leaves them guessing. Screen readers do not announce colour either. A better design adds an error message in text next to the field and an icon, and links can be underlined instead of only being a different colour.',
  sofia:
    'Colour blind users might not see the difference between colours, so information can get lost. You can add text labels to charts and use patterns as well as colours so the meaning is still there when colours look the same.',
  liam: 'Not everyone sees colour the same way, and some people use high contrast modes or grey screens. If a status is only shown as a green or red dot they miss it. Using a label such as "Paid" or "Overdue" next to the dot, or a different icon shape for each state, keeps the meaning.',
};

/** The bank, quiz and attempts for Modern Web Development, plus snapshots for the other demo attempts. */
export async function seedQuestionBankDemo(deps: Pick<AppDeps, 'db' | 'events'>): Promise<void> {
  const { db } = deps;
  const courses = await db.selectFrom('courses').select(['id', 'slug']).execute();
  await backfillSnapshots(
    db,
    courses.map((c) => c.id),
  );

  const course = courses.find((c) => c.slug === 'modern-web-development');
  if (!course) return;
  const people = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', 'in', [
      'maya.chen@coursekit.test',
      'alex.johnson@coursekit.test',
      'sofia.martinez@coursekit.test',
      'liam.obrien@coursekit.test',
    ])
    .execute();
  const person = (email: string) => people.find((p) => p.email === email)?.id;
  const maya = person('maya.chen@coursekit.test');
  const alex = person('alex.johnson@coursekit.test');
  const sofia = person('sofia.martinez@coursekit.test');
  const liam = person('liam.obrien@coursekit.test');
  if (!maya || !alex || !sofia || !liam) return;
  const random = mulberry32(20261125);
  const created = at(-12);

  // Categories go after the per-quiz ones.
  const existing = await db.selectFrom('questionCategories').select('id').where('courseId', '=', course.id).execute();
  const categoryIds = new Map<string, string>();
  for (const [i, c] of BANK.entries()) {
    const id = newId();
    categoryIds.set(c.key, id);
    await db
      .insertInto('questionCategories')
      .values({
        id,
        courseId: course.id,
        parentId: c.parent ? categoryIds.get(c.parent)! : null,
        name: c.name,
        description: c.description,
        position: c.parent ? i : existing.length + i,
        createdAt: created,
      })
      .execute();
  }

  const rows = new Map<string, QuestionRow>();
  for (const [i, { key, category, ...input }] of QUESTIONS.entries()) {
    const row: QuestionRow = {
      id: newId(),
      courseId: course.id,
      categoryId: categoryIds.get(category)!,
      ...storedQuestion(questionInputSchema.parse(input)),
      createdBy: maya,
      createdAt: at(-12 + i * 0.1),
      updatedAt: at(-12 + i * 0.1),
    };
    rows.set(key, row);
  }
  await db
    .insertInto('questions')
    .values([...rows.values()])
    .execute();

  // The quiz goes at the end of "HTML & CSS Foundations".
  const section = await db
    .selectFrom('sections')
    .select('id')
    .where('courseId', '=', course.id)
    .where('title', '=', 'HTML & CSS Foundations')
    .executeTakeFirst();
  if (!section) return;
  const last = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  const quizId = newId();
  const slots: Array<Omit<QuizSlotRow, 'id' | 'activityId' | 'position'>> = [
    { kind: 'question', questionId: rows.get('elements')!.id, categoryId: null, questionCount: 1, includeSubcategories: 0, points: 4 },
    { kind: 'question', questionId: rows.get('pageload')!.id, categoryId: null, questionCount: 1, includeSubcategories: 0, points: 3 },
    { kind: 'question', questionId: rows.get('specificity')!.id, categoryId: null, questionCount: 1, includeSubcategories: 0, points: 2 },
    { kind: 'random', questionId: null, categoryId: categoryIds.get('css')!, questionCount: 2, includeSubcategories: 0, points: 1 },
    { kind: 'question', questionId: rows.get('colour')!.id, categoryId: null, questionCount: 1, includeSubcategories: 0, points: 5 },
  ];
  const maxGrade = slots.reduce((sum, s) => sum + s.points * s.questionCount, 0);
  await db
    .insertInto('activities')
    .values({
      id: quizId,
      courseId: course.id,
      sectionId: section.id,
      type: 'quiz',
      title: 'Web foundations review',
      description:
        'A mixed review of the section: match HTML elements, put steps in order, two random layout questions and a short written answer. Your teacher marks the written answer, so your score appears once it has been graded.',
      position: Number(last?.max ?? 0) + 1,
      visible: 1,
      settings: JSON.stringify({
        timeLimitMinutes: 20,
        attemptsAllowed: 2,
        gradingMethod: 'highest',
        shuffleQuestions: false,
        reviewMode: 'immediate',
        passingPercent: null,
      }),
      dueAt: at(6, 17),
      maxGrade,
      completion: 'auto',
      createdBy: maya,
      createdAt: created,
      updatedAt: created,
    })
    .execute();
  await db
    .insertInto('quizSlots')
    .values(slots.map((s, position) => ({ ...s, id: newId(), activityId: quizId, position })))
    .execute();

  // Attempts: the random slot picks two layout questions (the specificity question is already in the quiz).
  const snapshotOf = (picks: string[]): QuestionSnapshot[] => {
    const item = (key: string, points: number) => snapshotFromRow(rows.get(key)!, { points, random });
    return [item('elements', 4), item('pageload', 3), item('specificity', 2), ...picks.map((k) => item(k, 1)), item('colour', 5)];
  };
  const choice = (text: string) => matchChoiceId(text);
  const optionId = (key: string, index: number) => (JSON.parse(rows.get(key)!.options) as Array<{ id: string }>)[index]!.id;
  const specs = [
    {
      userId: alex,
      picks: ['flex', 'boxmodel'],
      started: at(-1, 15, 5),
      essay: ESSAYS.alex,
      answers: {
        elements: {
          matches: {
            nav: choice('A block of navigation links'),
            aside: choice('Content related to the page, but not essential to it'),
            footer: choice('A control that submits a form'),
            figure: choice('Self-contained media with an optional caption'),
          },
        },
        pageload: { order: ['dns', 'tcp', 'req', 'parse', 'paint'] },
        specificity: { order: ['el', 'cls', 'id', 'elcls', 'inline'] },
        flex: { optionIds: [optionId('flex', 0)] },
        boxmodel: { text: '230' },
      } as Record<string, AttemptAnswer>,
    },
    {
      userId: sofia,
      picks: ['grid', 'flex'],
      started: at(-2, 10, 40),
      essay: ESSAYS.sofia,
      answers: {
        elements: {
          matches: {
            nav: choice('A block of navigation links'),
            aside: choice('Self-contained media with an optional caption'),
            footer: choice('Information about its section, like the author or copyright'),
            figure: choice('Content related to the page, but not essential to it'),
          },
        },
        pageload: { order: ['dns', 'req', 'tcp', 'parse', 'paint'] },
        specificity: { order: ['el', 'cls', 'elcls', 'id', 'inline'] },
        grid: { optionIds: [optionId('grid', 0)] },
        flex: { optionIds: [optionId('flex', 0)] },
      } as Record<string, AttemptAnswer>,
    },
    {
      userId: liam,
      picks: ['boxmodel', 'grid'],
      started: at(-3, 18, 20),
      essay: ESSAYS.liam,
      graded: { points: 4, comment: 'Good examples and a clear explanation. Mention screen readers too for full marks.' },
      answers: {
        elements: {
          matches: {
            nav: choice('A block of navigation links'),
            aside: choice('Content related to the page, but not essential to it'),
            footer: choice('Information about its section, like the author or copyright'),
            figure: choice('Self-contained media with an optional caption'),
          },
        },
        pageload: { order: ['dns', 'tcp', 'req', 'paint', 'parse'] },
        specificity: { order: ['el', 'cls', 'elcls', 'id', 'inline'] },
        boxmodel: { text: '220' },
        grid: { optionIds: [optionId('grid', 0), optionId('grid', 1)] },
      } as Record<string, AttemptAnswer>,
    },
  ];

  for (const spec of specs) {
    const snapshot = snapshotOf(spec.picks);
    const keyOf = new Map([...rows.entries()].map(([key, row]) => [row.id, key]));
    const answers: Record<string, AttemptAnswer> = {};
    for (const q of snapshot) {
      const key = keyOf.get(q.id)!;
      answers[q.id] = key === 'colour' ? { text: spec.essay } : (spec.answers[key] ?? {});
    }
    const finishedAt = new Date(Date.parse(spec.started) + 14 * 60_000).toISOString();
    const results: Record<string, StoredResult> = {};
    for (const q of snapshot) results[q.id] = gradeQuestion(q, answers[q.id]);
    const essayId = rows.get('colour')!.id;
    if (spec.graded) {
      results[essayId] = {
        correct: false,
        partial: true,
        points: spec.graded.points,
        maxPoints: 5,
        pending: false,
        comment: spec.graded.comment,
        gradedBy: maya,
        gradedAt: new Date(Date.parse(finishedAt) + DAY).toISOString(),
      };
    }
    const total = round(Object.values(results).reduce((sum, r) => sum + r.points, 0));
    const attempt: QuizAttemptRow = {
      id: newId(),
      activityId: quizId,
      courseId: course.id,
      userId: spec.userId,
      attemptNumber: 1,
      status: spec.graded ? 'finished' : 'needs_grading',
      questionOrder: JSON.stringify(snapshot.map((q) => q.id)),
      answers: JSON.stringify(answers),
      results: JSON.stringify(results),
      score: spec.graded ? total : null,
      maxScore: maxGrade,
      startedAt: spec.started,
      deadlineAt: new Date(Date.parse(spec.started) + 20 * 60_000).toISOString(),
      finishedAt,
      snapshot: JSON.stringify(snapshot),
    };
    await db.insertInto('quizAttempts').values(attempt).execute();
    // Without a pass mark, handing the quiz in completes it.
    await db
      .insertInto('completions')
      .values({ activityId: quizId, userId: spec.userId, courseId: course.id, completedAt: finishedAt })
      .execute();
    if (spec.graded) {
      const gradedAt = results[essayId]!.gradedAt!;
      await db
        .insertInto('grades')
        .values({
          activityId: quizId,
          userId: spec.userId,
          courseId: course.id,
          score: total,
          feedback: null,
          gradedBy: null,
          gradedAt,
          updatedAt: gradedAt,
        })
        .execute();
    }
  }
}
