import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GradebookSetup, GradebookSetupInput } from '../src/shared/types.js';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { newId, round } from '../src/server/lib/util.js';
import { courseTotals } from '../src/server/services/course-total.js';
import { getGradebookSetup } from '../src/server/services/grade-categories.js';
import { buildCourseGradebook } from '../src/server/services/gradebook.js';
import { client, createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let courseId: string;
let ids: Record<'essay' | 'project' | 'quiz1' | 'quiz2' | 'reading', string>;
let sam: string;
let kim: string;

async function userId(email: string) {
  return (await lms.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

async function activity(type: string, title: string, maxGrade?: number) {
  const res = await school.teacher.post(`/api/courses/${courseId}/activities`, {
    sectionId: school.sectionId,
    type,
    title,
    ...(maxGrade != null ? { maxGrade } : {}),
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grade(activityId: string, user: string, score: number | null) {
  const res = await school.teacher.put(`/api/courses/${courseId}/grades/${activityId}/${user}`, { score });
  expect(res.status).toBe(200);
}

const setupUrl = () => `/api/courses/${courseId}/grades/setup`;

/** Homework 40% (essay, project), Quizzes 60% dropping the lowest, default category last. */
function weightedPlan(): GradebookSetupInput {
  return {
    aggregation: 'weighted',
    categories: [
      { id: 'new-hw', name: 'Homework', weight: 40, dropLowest: 0 },
      { id: 'new-quiz', name: 'Quizzes', weight: 60, dropLowest: 1 },
      { id: courseId, name: 'Uncategorised', weight: 0, dropLowest: 0 },
    ],
    items: [
      { activityId: ids.essay, categoryId: 'new-hw', weight: null },
      { activityId: ids.project, categoryId: 'new-hw', weight: null },
      { activityId: ids.quiz1, categoryId: 'new-quiz', weight: null },
      { activityId: ids.quiz2, categoryId: 'new-quiz', weight: null },
    ],
  };
}

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  courseId = school.course.id;
  await school.sam.post(`/api/courses/${courseId}/enrol`);
  await school.kim.post(`/api/courses/${courseId}/enrol`);
  sam = await userId('sam@test.dev');
  kim = await userId('kim@test.dev');
  ids = {
    essay: await activity('assignment', 'Essay', 20),
    project: await activity('assignment', 'Project', 100),
    quiz1: await activity('quiz', 'Quiz 1'),
    quiz2: await activity('quiz', 'Quiz 2'),
    reading: await activity('lesson', 'Reading'),
  };
});
afterEach(async () => {
  await lms.close();
});

describe('gradebook setup', () => {
  it('starts with natural aggregation and only the default category', async () => {
    const res = await school.teacher.get<GradebookSetup>(setupUrl());
    expect(res.status).toBe(200);
    expect(res.body.aggregation).toBe('natural');
    expect(res.body.categories).toEqual([{ id: courseId, name: 'Uncategorised', weight: 0, dropLowest: 0, position: 0, isDefault: true }]);
    expect(res.body.items.map((i) => i.title)).toEqual(['Essay', 'Project', 'Quiz 1', 'Quiz 2']);
    expect(res.body.items.every((i) => i.categoryId === courseId && i.weight === null && i.visible)).toBe(true);
  });

  it('saves categories, weights and assignments, giving new categories real ids', async () => {
    const res = await school.teacher.put<GradebookSetup>(setupUrl(), weightedPlan());
    expect(res.status).toBe(200);
    expect(res.body.aggregation).toBe('weighted');
    const [hw, quiz, other] = res.body.categories;
    expect(hw).toMatchObject({ name: 'Homework', weight: 40, dropLowest: 0, position: 0, isDefault: false });
    expect(quiz).toMatchObject({ name: 'Quizzes', weight: 60, dropLowest: 1, position: 1, isDefault: false });
    expect(other).toMatchObject({ id: courseId, isDefault: true, position: 2 });
    expect(hw!.id).not.toBe('new-hw');
    expect(Object.fromEntries(res.body.items.map((i) => [i.title, i.categoryId]))).toEqual({
      Essay: hw!.id,
      Project: hw!.id,
      'Quiz 1': quiz!.id,
      'Quiz 2': quiz!.id,
    });
    expect(await school.teacher.get(setupUrl())).toMatchObject({ status: 200, body: res.body });
  });

  it('groups the gradebook, works out subtotals and drops the lowest quiz', async () => {
    const saved = (await school.teacher.put<GradebookSetup>(setupUrl(), weightedPlan())).body;
    const [hw, quiz] = saved.categories;
    await grade(ids.essay, sam, 10);
    await grade(ids.project, sam, 80);
    await grade(ids.quiz1, sam, 5);
    await grade(ids.quiz2, sam, 9);
    await grade(ids.quiz1, kim, 7);

    const book = (await school.teacher.get(`/api/courses/${courseId}/grades`)).body.gradebook;
    expect(book.aggregation).toBe('weighted');
    expect(book.items.map((i: { title: string }) => i.title)).toEqual(['Essay', 'Project', 'Quiz 1', 'Quiz 2']);
    expect(book.categories.map((c: { name: string }) => c.name)).toEqual(['Homework', 'Quizzes', 'Uncategorised']);
    const row = book.rows.find((r: { user: { id: string } }) => r.user.id === sam);
    // Homework: 90 / 120 = 75%. Quizzes: 5 / 10 is dropped, 9 / 10 = 90%. Total: 40% × 75 + 60% × 90.
    expect(row.categories[hw!.id]).toEqual({ percentage: 75, earned: 90, possible: 120, share: 40 });
    expect(row.categories[quiz!.id]).toEqual({ percentage: 90, earned: 9, possible: 10, share: 60 });
    expect(row.percentage).toBe(84);
    expect(row.cells[ids.quiz1]).toEqual({ score: 5, feedback: null, dropped: true });
    expect(row.cells[ids.quiz2].dropped).toBe(false);
    // Kim only has quizzes graded, and her only quiz is never dropped.
    const kimRow = book.rows.find((r: { user: { id: string } }) => r.user.id === kim);
    expect(kimRow.categories[hw!.id].percentage).toBeNull();
    expect(kimRow.categories[quiz!.id]).toMatchObject({ percentage: 70, share: 100 });
    expect(kimRow.percentage).toBe(70);
    expect(book.categoryAverages[quiz!.id]).toBe(80);
    expect(book.categoryAverages[hw!.id]).toBe(75);
    expect(book.courseAverage).toBe(77);
    expect((await courseTotals(lms.db, courseId, [sam, kim])).get(sam)).toBe(84);

    const csv = await (
      await lms.app.request(`/api/courses/${courseId}/grades/export.csv`, { headers: { cookie: school.teacher.cookie } })
    ).text();
    const [header, ...lines] = csv.split('\n');
    expect(header).toBe(
      'Name,Email,Essay (/20),Project (/100),Quiz 1 (/10),Quiz 2 (/10),Homework total (%),Quizzes total (%),Total,Percentage',
    );
    expect(lines).toContain('Sam Student,sam@test.dev,10,80,5,9,75,90,99,84');
    expect(lines).toContain('Kim Student,kim@test.dev,,,7,,,70,7,70');
  });

  it('shows students their own grades by category', async () => {
    await school.teacher.put(setupUrl(), weightedPlan());
    await grade(ids.quiz1, sam, 5);
    await grade(ids.quiz2, sam, 9);
    await grade(ids.quiz1, kim, 1);
    const res = await school.sam.get(`/api/courses/${courseId}/grades`);
    expect(res.body.kind).toBe('mine');
    const mine = res.body.grades;
    expect(mine.aggregation).toBe('weighted');
    expect(mine.percentage).toBe(90);
    expect(mine.items.map((i: { title: string; dropped: boolean }) => [i.title, i.dropped])).toEqual([
      ['Essay', false],
      ['Project', false],
      ['Quiz 1', true],
      ['Quiz 2', false],
    ]);
    expect(
      mine.categories.map((c: { name: string; weight: number; percentage: number | null; share: number | null }) => [
        c.name,
        c.weight,
        c.percentage,
        c.share,
      ]),
    ).toEqual([
      ['Homework', 40, null, null],
      ['Quizzes', 60, 90, 100],
      ['Uncategorised', 0, null, null],
    ]);
    expect(JSON.stringify(res.body)).not.toContain(kim);
  });

  it('renames, reorders and deletes categories; deleted ones hand their activities to the default category', async () => {
    const saved = (await school.teacher.put<GradebookSetup>(setupUrl(), weightedPlan())).body;
    const [hw, quiz, other] = saved.categories;
    const renamed = await school.teacher.put<GradebookSetup>(setupUrl(), {
      aggregation: 'weighted',
      categories: [
        { id: quiz!.id, name: 'Quizzes', weight: 50, dropLowest: 0 },
        { id: other!.id, name: 'Other work', weight: 10, dropLowest: 0 },
        { id: hw!.id, name: 'Assignments', weight: 40, dropLowest: 0 },
      ],
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.categories.map((c) => [c.id, c.name, c.position])).toEqual([
      [quiz!.id, 'Quizzes', 0],
      [courseId, 'Other work', 1],
      [hw!.id, 'Assignments', 2],
    ]);
    // Activities left out of "items" keep their category.
    expect(renamed.body.items.find((i) => i.activityId === ids.essay)?.categoryId).toBe(hw!.id);

    const deleted = await school.teacher.put<GradebookSetup>(setupUrl(), {
      aggregation: 'weighted',
      categories: [
        { id: hw!.id, name: 'Assignments', weight: 40, dropLowest: 0 },
        { id: courseId, name: 'Other work', weight: 60, dropLowest: 0 },
      ],
      items: [{ activityId: ids.project, categoryId: courseId, weight: 2 }],
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.categories.map((c) => c.name)).toEqual(['Assignments', 'Other work']);
    expect(Object.fromEntries(deleted.body.items.map((i) => [i.title, [i.categoryId, i.weight]]))).toEqual({
      Essay: [hw!.id, null],
      Project: [courseId, 2],
      'Quiz 1': [courseId, null],
      'Quiz 2': [courseId, null],
    });
    const rows = await lms.db.selectFrom('gradeCategories').select('id').where('courseId', '=', courseId).execute();
    expect(rows.map((r) => r.id).sort()).toEqual([hw!.id, courseId].sort());
  });

  it('gives the 0.1.x totals again after switching back to natural', async () => {
    await grade(ids.essay, sam, 15.5);
    await grade(ids.project, sam, 61.25);
    await grade(ids.quiz1, sam, 3);
    const before = (await school.teacher.get(`/api/courses/${courseId}/grades`)).body.gradebook.rows.find(
      (r: { user: { id: string } }) => r.user.id === sam,
    );
    expect(before.percentage).toBe(round(((15.5 + 61.25 + 3) / 130) * 100, 2));
    const saved = (await school.teacher.put<GradebookSetup>(setupUrl(), weightedPlan())).body;
    const weighted = (await courseTotals(lms.db, courseId, [sam])).get(sam);
    expect(weighted).not.toBe(before.percentage);

    const back = await school.teacher.put(setupUrl(), {
      aggregation: 'natural',
      categories: saved.categories.map((c) => ({ id: c.id, name: c.name, weight: c.weight, dropLowest: 0 })),
    });
    expect(back.status).toBe(200);
    const after = (await school.teacher.get(`/api/courses/${courseId}/grades`)).body.gradebook.rows.find(
      (r: { user: { id: string } }) => r.user.id === sam,
    );
    expect(after).toMatchObject({ percentage: before.percentage, total: before.total, max: before.max });
  });

  it('emits gradebook.setup.updated', async () => {
    const seen: unknown[] = [];
    lms.events.on('gradebook.setup.updated', (e) => {
      seen.push(e);
    });
    await school.teacher.put(setupUrl(), weightedPlan());
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([{ courseId, userId: await userId('teacher@test.dev') }]);
  });

  it('forgets the settings of deleted activities and courses', async () => {
    // Bodiless DELETEs need an Origin header to get past CSRF protection (browsers always send one).
    const remove = (path: string) =>
      lms.app.request(path, { method: 'DELETE', headers: { cookie: school.teacher.cookie, origin: 'http://localhost' } });
    await school.teacher.put(setupUrl(), weightedPlan());
    expect((await remove(`/api/activities/${ids.quiz2}`)).status).toBe(200);
    const items = await lms.db.selectFrom('gradeItems').select('activityId').where('courseId', '=', courseId).execute();
    expect(items.map((i) => i.activityId).sort()).toEqual([ids.essay, ids.project, ids.quiz1].sort());
    expect((await school.teacher.get(setupUrl())).body.items).toHaveLength(3);

    expect((await remove(`/api/courses/${courseId}`)).status).toBe(200);
    for (const table of ['gradeSettings', 'gradeCategories', 'gradeItems'] as const) {
      expect(await lms.db.selectFrom(table).selectAll().where('courseId', '=', courseId).execute()).toEqual([]);
    }
  });
});

describe('gradebook setup permissions', () => {
  it('lets teachers and administrators change it, assistants only look, and keeps students out', async () => {
    await lms.createUser({ name: 'Ada Assistant', email: 'ta@test.dev', password: PASSWORD });
    await lms.createUser({ name: 'Other Teacher', email: 'other@test.dev', password: PASSWORD, role: 'instructor' });
    const added = await school.teacher.post(`/api/courses/${courseId}/participants`, { emails: ['ta@test.dev'], role: 'assistant' });
    expect(added.body.added).toBe(1);
    const ta = await login(lms, 'ta@test.dev');
    const other = await login(lms, 'other@test.dev');
    const anonymous: Client = client(lms);

    expect((await ta.get(setupUrl())).status).toBe(200);
    const taPut = await ta.put(setupUrl(), weightedPlan());
    expect(taPut.status).toBe(403);
    expect(taPut.body.error.code).toBe('forbidden');
    expect((await school.sam.get(setupUrl())).status).toBe(403);
    expect((await school.sam.put(setupUrl(), weightedPlan())).status).toBe(403);
    expect((await other.get(setupUrl())).status).toBe(403);
    expect((await other.put(setupUrl(), weightedPlan())).status).toBe(403);
    expect((await anonymous.get(setupUrl())).status).toBe(401);
    expect((await anonymous.put(setupUrl(), weightedPlan())).status).toBe(401);
    expect((await school.teacher.get('/api/courses/no-such-course/grades/setup')).status).toBe(404);

    // Nothing was saved by the refused requests.
    expect(await lms.db.selectFrom('gradeCategories').selectAll().execute()).toEqual([]);
    expect((await school.admin.put(setupUrl(), weightedPlan())).status).toBe(200);
  });

  it('hides draft courses from students', async () => {
    await school.teacher.patch(`/api/courses/${courseId}`, { visibility: 'draft' });
    expect((await school.sam.get(setupUrl())).status).toBe(404);
  });

  it('gives teachers the grades:manage capability, and nobody else', async () => {
    const teacher = await school.teacher.get(`/api/courses/${courseId}`);
    const student = await school.sam.get(`/api/courses/${courseId}`);
    expect(teacher.body.capabilities).toContain('grades:manage');
    expect(student.body.capabilities).not.toContain('grades:manage');
  });
});

describe('gradebook setup validation', () => {
  const bad = async (body: unknown) => {
    const res = await school.teacher.put(setupUrl(), body);
    expect(res.status).toBe(400);
    return res.body.error as { message: string; code: string; issues?: Array<{ path: string }> };
  };

  it('rejects malformed input', async () => {
    const plan = weightedPlan();
    expect((await bad({ ...plan, aggregation: 'median' })).code).toBe('validation_error');
    expect((await bad({ ...plan, categories: [] })).code).toBe('validation_error');
    const tooHeavy = await bad({ ...plan, categories: plan.categories.map((c, i) => (i === 0 ? { ...c, weight: 120 } : c)) });
    expect(tooHeavy.issues?.[0]?.path).toBe('categories.0.weight');
    expect((await bad({ ...plan, categories: plan.categories.map((c) => ({ ...c, weight: -1 })) })).code).toBe('validation_error');
    expect((await bad({ ...plan, categories: plan.categories.map((c) => ({ ...c, dropLowest: 1.5 })) })).code).toBe('validation_error');
    expect((await bad({ ...plan, categories: plan.categories.map((c) => ({ ...c, name: '  ' })) })).message).toContain('name');
    expect((await bad({ ...plan, items: [{ activityId: ids.essay, categoryId: 'new-hw', weight: -2 }] })).code).toBe('validation_error');
    const res = await lms.app.request(setupUrl(), {
      method: 'PUT',
      headers: { cookie: school.teacher.cookie, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects setups that make no sense', async () => {
    const plan = weightedPlan();
    expect((await bad({ ...plan, categories: plan.categories.filter((c) => c.id !== courseId) })).message).toContain('default category');
    expect(
      (await bad({ ...plan, categories: plan.categories.map((c, i) => (i === 1 ? { ...c, name: ' homework ' } : c)) })).message,
    ).toContain('two categories called');
    expect((await bad({ ...plan, categories: [...plan.categories, plan.categories[0]!] })).message).toContain('own id');
    expect((await bad({ ...plan, categories: plan.categories.map((c) => ({ ...c, weight: 0 })) })).message).toContain('weight above 0');
    expect((await bad({ ...plan, items: [{ activityId: ids.reading, categoryId: 'new-hw', weight: null }] })).message).toContain(
      'not graded',
    );
    expect((await bad({ ...plan, items: [{ activityId: 'missing', categoryId: 'new-hw', weight: null }] })).message).toContain(
      'not graded',
    );
    expect((await bad({ ...plan, items: [{ activityId: ids.essay, categoryId: 'new-nope', weight: null }] })).message).toContain(
      'not in the list',
    );
    expect(
      (
        await bad({
          ...plan,
          items: [
            { activityId: ids.essay, categoryId: 'new-hw', weight: null },
            { activityId: ids.essay, categoryId: 'new-quiz', weight: null },
          ],
        })
      ).message,
    ).toContain('twice');
    // An activity from another course is refused too.
    const otherCourse = await school.teacher.post('/api/courses', { title: 'Another course', visibility: 'published' });
    const otherSection = (await school.teacher.get(`/api/courses/${otherCourse.body.id}`)).body.sections[0].id;
    const foreign = await school.teacher.post(`/api/courses/${otherCourse.body.id}/activities`, {
      sectionId: otherSection,
      type: 'assignment',
      title: 'Elsewhere',
    });
    expect((await bad({ ...plan, items: [{ activityId: foreign.body.id, categoryId: 'new-hw', weight: null }] })).message).toContain(
      'not graded',
    );
    // A category id from another course can't be used to edit that course: it becomes a new category here.
    const theirs = await school.teacher.put<GradebookSetup>(`/api/courses/${otherCourse.body.id}/grades/setup`, {
      aggregation: 'natural',
      categories: [
        { id: 'x', name: 'Theirs', weight: 10, dropLowest: 0 },
        { id: otherCourse.body.id, name: 'Uncategorised', weight: 0, dropLowest: 0 },
      ],
    });
    const theirId = theirs.body.categories[0]!.id;
    const mine = await school.teacher.put<GradebookSetup>(setupUrl(), {
      aggregation: 'natural',
      categories: [
        { id: theirId, name: 'Mine', weight: 0, dropLowest: 0 },
        { id: courseId, name: 'Uncategorised', weight: 0, dropLowest: 0 },
      ],
    });
    expect(mine.status).toBe(200);
    expect(mine.body.categories[0]!.id).not.toBe(theirId);
    expect((await getGradebookSetup(lms.db, otherCourse.body.id)).categories[0]).toMatchObject({ id: theirId, name: 'Theirs', weight: 10 });
    // Nothing from the refused requests was saved.
    expect((await getGradebookSetup(lms.db, courseId)).categories.map((c) => c.name)).toEqual(['Mine', 'Uncategorised']);
  });
});

describe('upgrading from 0.1.x', () => {
  it('adds the gradebook tables and keeps every course total', async () => {
    const { db } = await createDatabase('sqlite::memory:');
    try {
      const old = new Migrator({
        db: db.withoutPlugins(),
        provider: { getMigrations: async () => ({ '001_initial': migrations['001_initial']! }) },
      });
      expect((await old.migrateToLatest()).error).toBeUndefined();

      // A 0.1.x course: two students, a hidden activity, a cleared grade.
      const ts = new Date().toISOString();
      const course = newId();
      const section = newId();
      const people = [newId(), newId()];
      for (const [i, id] of people.entries()) {
        await db
          .insertInto('users')
          .values({
            id,
            email: `p${i}@test.dev`,
            name: `P${i}`,
            passwordHash: null,
            role: 'student',
            avatarUrl: null,
            bio: null,
            status: 'active',
            lastLoginAt: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .execute();
      }
      await db
        .insertInto('courses')
        .values({
          id: course,
          slug: 'old',
          title: 'Old course',
          summary: '',
          description: '',
          categoryId: null,
          coverColor: 'indigo',
          coverImageUrl: null,
          visibility: 'published',
          enrolment: 'open',
          enrolmentKey: null,
          startDate: null,
          endDate: null,
          createdBy: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .execute();
      await db
        .insertInto('sections')
        .values({ id: section, courseId: course, title: 'Week 1', summary: '', position: 0, visible: 1, createdAt: ts })
        .execute();
      const acts = [
        { id: newId(), max: 30, visible: 1 },
        { id: newId(), max: 70, visible: 1 },
        { id: newId(), max: 50, visible: 0 },
      ];
      for (const [i, a] of acts.entries()) {
        await db
          .insertInto('activities')
          .values({
            id: a.id,
            courseId: course,
            sectionId: section,
            type: 'assignment',
            title: `A${i}`,
            description: '',
            position: i,
            visible: a.visible,
            settings: '{}',
            dueAt: null,
            maxGrade: a.max,
            completion: 'none',
            createdBy: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .execute();
      }
      for (const id of people) {
        await db
          .insertInto('enrolments')
          .values({ id: newId(), courseId: course, userId: id, role: 'student', status: 'active', lastAccessAt: null, createdAt: ts })
          .execute();
      }
      const scores: Array<[number, number, number | null]> = [
        [0, 0, 21.5],
        [0, 1, 50],
        [0, 2, 10],
        [1, 0, null],
        [1, 1, 69],
      ];
      for (const [p, a, score] of scores) {
        await db
          .insertInto('grades')
          .values({
            activityId: acts[a]!.id,
            userId: people[p]!,
            courseId: course,
            score,
            feedback: null,
            gradedBy: null,
            gradedAt: ts,
            updatedAt: ts,
          })
          .execute();
      }

      const results = await migrateToLatest(db);
      // 0.1.x had only 001, so every later migration runs; all must succeed.
      expect(results.map((r) => [r.migrationName, r.status])).toContainEqual(['006_grade_categories', 'Success']);
      expect(results.every((r) => r.status === 'Success')).toBe(true);

      const totals = await courseTotals(db, course, people);
      expect(totals.get(people[0]!)).toBe(round(((21.5 + 50 + 10) / 150) * 100, 2));
      expect(totals.get(people[1]!)).toBe(round((69 / 70) * 100, 2));
      const book = await buildCourseGradebook(
        db,
        course,
        people.map((id, i) => ({ id, name: `P${i}`, email: `p${i}@test.dev`, avatarUrl: null })),
      );
      expect(book.aggregation).toBe('natural');
      expect(book.categories).toHaveLength(1);
      expect(book.rows.map((r) => [r.total, r.max, r.percentage])).toEqual([
        [81.5, 150, 54.33],
        [69, 70, 98.57],
      ]);
      // A rerun has nothing left to do.
      expect(await migrateToLatest(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

describe('demo data', () => {
  it('sets up weighted categories in Modern Web Development', async () => {
    const demo = await createCoursekit({ databaseUrl: 'sqlite::memory:', webDir: false });
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const course = await demo.db
        .selectFrom('courses')
        .select('id')
        .where('slug', '=', 'modern-web-development')
        .executeTakeFirstOrThrow();
      const setup = await getGradebookSetup(demo.db, course.id);
      expect(setup.aggregation).toBe('weighted');
      expect(setup.categories.map((c) => [c.name, c.weight, c.dropLowest, c.isDefault])).toEqual([
        ['Assignments', 40, 0, false],
        ['Quizzes', 20, 1, false],
        ['Final project', 40, 0, false],
        ['Uncategorised', 0, 0, true],
      ]);
      expect(setup.items.filter((i) => i.categoryId === course.id)).toEqual([]);

      const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
      const mine = (await alex.get(`/api/courses/${course.id}/grades`)).body.grades;
      expect(mine.aggregation).toBe('weighted');
      const byName = Object.fromEntries(mine.categories.map((c: { name: string; percentage: number | null }) => [c.name, c.percentage]));
      expect(byName['Final project']).toBeNull();
      // Final project has no grades yet, so Assignments (40) and Quizzes (20) are scaled up to 100%.
      expect(mine.percentage).toBeCloseTo((40 * byName.Assignments + 20 * byName.Quizzes) / 60, 1);
      // The other demo courses keep natural aggregation.
      const other = await demo.db.selectFrom('courses').select('id').where('slug', '=', 'ux-design-principles').executeTakeFirstOrThrow();
      expect((await getGradebookSetup(demo.db, other.id)).aggregation).toBe('natural');
    } finally {
      await demo.close();
    }
  });
});
