import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GradeAggregation, GradeCategory } from '../src/shared/types.js';
import type { DB } from '../src/server/db/types.js';
import type { Coursekit } from '../src/server/index.js';
import { newId, round } from '../src/server/lib/util.js';
import {
  computeCourseGrade,
  courseGrades,
  courseTotals,
  type GradeItemInfo,
  type GradeSetup,
  type Scores,
} from '../src/server/services/course-total.js';
import { createTestLms, setupSchool } from './helpers.js';

const COURSE = 'course-1';

type ItemSpec = { id: string; max: number; cat?: string; weight?: number | null; visible?: boolean };
type CategorySpec = Partial<GradeCategory> & { id: string };

function makeSetup(aggregation: GradeAggregation, categories: CategorySpec[], items: ItemSpec[]): GradeSetup {
  const cats: GradeCategory[] = categories.map((c, i) => ({
    name: c.id,
    weight: 0,
    dropLowest: 0,
    position: i,
    isDefault: c.id === COURSE,
    ...c,
  }));
  if (!cats.some((c) => c.isDefault))
    cats.push({ id: COURSE, name: 'Uncategorised', weight: 0, dropLowest: 0, position: cats.length, isDefault: true });
  const list: GradeItemInfo[] = items.map((i) => ({
    activityId: i.id,
    title: i.id,
    type: 'assignment',
    maxGrade: i.max,
    dueAt: null,
    visible: i.visible ?? true,
    sectionTitle: 'Week 1',
    categoryId: i.cat ?? COURSE,
    weight: i.weight ?? null,
  }));
  return { courseId: COURSE, aggregation, categories: cats, items: list };
}

const scores = (values: Record<string, number | null>): Scores => new Map(Object.entries(values));

/** The 0.1.x course total, as routes/grades.ts computed it: Σ score / Σ max over graded items, in course order. */
function legacyTotal(items: Array<{ id: string; max: number }>, values: Scores) {
  let total = 0;
  let max = 0;
  for (const item of items) {
    const s = values.get(item.id);
    if (s != null) {
      total += s;
      max += item.max;
    }
  }
  return { total, max, percentage: max > 0 ? (total / max) * 100 : null };
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

describe('natural aggregation', () => {
  it('adds up the points of graded items and leaves ungraded ones out', () => {
    const setup = makeSetup(
      'natural',
      [],
      [
        { id: 'a', max: 10 },
        { id: 'b', max: 20 },
        { id: 'c', max: 30 },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ a: 5, b: 15, c: null }));
    expect(grade.earned).toBe(20);
    expect(grade.possible).toBe(30);
    expect(grade.percentage).toBe((20 / 30) * 100);
    expect(grade.categories.get(COURSE)).toMatchObject({ earned: 20, possible: 30, share: 100 });
  });

  it('is null when nothing is graded yet', () => {
    const setup = makeSetup('natural', [], [{ id: 'a', max: 10 }]);
    const grade = computeCourseGrade(setup, scores({}));
    expect(grade.percentage).toBeNull();
    expect(grade.categories.get(COURSE)?.percentage).toBeNull();
    expect(grade.categories.get(COURSE)?.share).toBeNull();
  });

  it('matches the 0.1.x formula to the last bit', () => {
    const random = rng(42);
    for (let run = 0; run < 300; run++) {
      const items = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, i) => ({
        id: `i${i}`,
        max: random() < 0.1 ? 0 : Math.round(random() * 2000) / 10,
      }));
      const values = new Map<string, number | null>();
      for (const item of items) {
        if (random() < 0.25) continue;
        values.set(item.id, random() < 0.1 ? null : Math.round(random() * item.max * 100) / 100);
      }
      const legacy = legacyTotal(items, values);
      const grade = computeCourseGrade(makeSetup('natural', [], items), values);
      expect(grade.percentage).toBe(legacy.percentage);
      expect(grade.earned).toBe(legacy.total);
      expect(grade.possible).toBe(legacy.max);
    }
  });

  it('counts an item with a max grade of 0 the way 0.1.x did', () => {
    const items = [
      { id: 'zero', max: 0 },
      { id: 'a', max: 10 },
    ];
    expect(computeCourseGrade(makeSetup('natural', [], items), scores({ zero: 0, a: 7 })).percentage).toBe(70);
    // Only a zero-max item graded: there are no points possible, so there is no total yet.
    expect(computeCourseGrade(makeSetup('natural', [], items), scores({ zero: 0 })).percentage).toBeNull();
  });

  it('ignores category weights but keeps the categories as subtotals', () => {
    const setup = makeSetup(
      'natural',
      [
        { id: 'hw', weight: 90 },
        { id: 'exam', weight: 10 },
      ],
      [
        { id: 'a', max: 10, cat: 'hw' },
        { id: 'b', max: 90, cat: 'exam' },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ a: 10, b: 45 }));
    expect(grade.percentage).toBe((55 / 100) * 100); // 55.00000000000001, exactly as 0.1.x computed it
    expect(grade.categories.get('hw')).toMatchObject({ percentage: 100, share: 10 });
    expect(grade.categories.get('exam')).toMatchObject({ percentage: 50, share: 90 });
  });

  it('applies drop-lowest, but counts points rather than item weights', () => {
    const setup = makeSetup(
      'natural',
      [{ id: 'quiz', dropLowest: 1 }],
      [
        { id: 'q1', max: 10, cat: 'quiz' },
        { id: 'q2', max: 10, cat: 'quiz' },
        { id: 'essay', max: 50, weight: 1 },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ q1: 2, q2: 8, essay: 25 }));
    expect([...grade.dropped]).toEqual(['q1']);
    // q2: 8 / 10 and the essay's 25 / 50 points: its weight of 1 is only used by weighted aggregation.
    expect(grade.earned).toBe(33);
    expect(grade.possible).toBe(60);
    expect(grade.percentage).toBe((33 / 60) * 100);
    expect(grade.categories.get(COURSE)?.percentage).toBe(50);
  });
});

describe('weighted aggregation', () => {
  const twoCategories = (a: number, b: number) =>
    makeSetup(
      'weighted',
      [
        { id: 'hw', weight: a },
        { id: 'exam', weight: b },
      ],
      [
        { id: 'h1', max: 10, cat: 'hw' },
        { id: 'h2', max: 30, cat: 'hw' },
        { id: 'e1', max: 100, cat: 'exam' },
      ],
    );

  it('combines category subtotals by weight', () => {
    // hw: 30 / 40 = 75%; exam: 90%.
    const grade = computeCourseGrade(twoCategories(40, 60), scores({ h1: 6, h2: 24, e1: 90 }));
    expect(grade.categories.get('hw')?.percentage).toBe(75);
    expect(grade.categories.get('exam')?.percentage).toBe(90);
    expect(grade.percentage).toBe(84);
    expect(grade.categories.get('hw')?.share).toBe(40);
    expect(grade.categories.get('exam')?.share).toBe(60);
  });

  it('normalises over the categories that have grades', () => {
    const grade = computeCourseGrade(twoCategories(40, 60), scores({ h1: 6, h2: 24 }));
    expect(grade.percentage).toBe(75);
    expect(grade.categories.get('hw')?.share).toBe(100);
    expect(grade.categories.get('exam')).toMatchObject({ percentage: null, share: null });
  });

  it('treats weights that do not add up to 100 as proportions', () => {
    const values = scores({ h1: 6, h2: 24, e1: 90 });
    expect(computeCourseGrade(twoCategories(20, 20), values).percentage).toBe(computeCourseGrade(twoCategories(50, 50), values).percentage);
    expect(computeCourseGrade(twoCategories(20, 20), values).percentage).toBe(82.5);
    expect(computeCourseGrade(twoCategories(10, 30), values).percentage).toBe(86.25);
  });

  it('never counts a category with weight 0', () => {
    expect(computeCourseGrade(twoCategories(0, 100), scores({ h1: 0, h2: 0, e1: 80 })).percentage).toBe(80);
    // Only the weight-0 category has grades: nothing counts yet.
    expect(computeCourseGrade(twoCategories(0, 100), scores({ h1: 5 })).percentage).toBeNull();
  });

  it('leaves out categories with no items or no graded items', () => {
    const setup = makeSetup(
      'weighted',
      [
        { id: 'hw', weight: 30 },
        { id: 'empty', weight: 50 },
        { id: 'exam', weight: 20 },
      ],
      [
        { id: 'h1', max: 10, cat: 'hw' },
        { id: 'e1', max: 10, cat: 'exam' },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ h1: 10, e1: null }));
    expect(grade.percentage).toBe(100);
    expect(grade.categories.get('empty')).toMatchObject({ percentage: null, earned: 0, possible: 0, share: null });
    expect(computeCourseGrade(setup, scores({})).percentage).toBeNull();
  });

  it('uses item weights as shares of the category, whatever the points', () => {
    const setup = makeSetup(
      'weighted',
      [{ id: 'hw', weight: 100 }],
      [
        { id: 'small', max: 5, cat: 'hw', weight: 1 },
        { id: 'big', max: 200, cat: 'hw', weight: 3 },
      ],
    );
    // 100% on the small one counts 25%, 50% on the big one 75%.
    const grade = computeCourseGrade(setup, scores({ small: 5, big: 100 }));
    expect(grade.percentage).toBe(62.5);
    // Earned and possible stay plain points.
    expect(grade.categories.get('hw')).toMatchObject({ percentage: 62.5, earned: 105, possible: 205 });
    expect([grade.earned, grade.possible]).toEqual([105, 205]);
  });

  it('weighs items without a weight by their points, next to weighted ones', () => {
    const setup = makeSetup(
      'weighted',
      [{ id: 'hw', weight: 100 }],
      [
        { id: 'points', max: 30, cat: 'hw' },
        { id: 'weighted', max: 10, cat: 'hw', weight: 10 },
      ],
    );
    // points: 15 / 30; weighted: weight 10 at 100% = 10 / 10.
    expect(computeCourseGrade(setup, scores({ points: 15, weighted: 10 })).percentage).toBe(62.5);
  });

  it('skips items with weight 0, and weighted items with a max grade of 0', () => {
    const setup = makeSetup(
      'weighted',
      [{ id: 'hw', weight: 100 }],
      [
        { id: 'a', max: 10, cat: 'hw' },
        { id: 'practice', max: 10, cat: 'hw', weight: 0 },
        { id: 'broken', max: 0, cat: 'hw', weight: 5 },
      ],
    );
    expect(computeCourseGrade(setup, scores({ a: 8, practice: 0, broken: 0 })).percentage).toBe(80);
    expect(computeCourseGrade(setup, scores({ practice: 0, broken: 0 })).percentage).toBeNull();
  });

  it('leaves out a category whose only graded item has a max grade of 0', () => {
    const setup = makeSetup(
      'weighted',
      [
        { id: 'bonus', weight: 50 },
        { id: 'hw', weight: 50 },
      ],
      [
        { id: 'zero', max: 0, cat: 'bonus' },
        { id: 'a', max: 10, cat: 'hw' },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ zero: 0, a: 6 }));
    expect(grade.categories.get('bonus')?.percentage).toBeNull();
    expect(grade.percentage).toBe(60);
  });

  it('works out shares that add up to 100', () => {
    const setup = makeSetup(
      'weighted',
      [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
      ],
      [
        { id: 'x', max: 10, cat: 'a' },
        { id: 'y', max: 10, cat: 'b' },
        { id: 'z', max: 10, cat: 'c' },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ x: 10, y: 5, z: 0 }));
    const shares = [...grade.categories.values()].map((c) => c.share ?? 0);
    expect(
      round(
        shares.reduce((a, b) => a + b, 0),
        9,
      ),
    ).toBe(100);
    expect(grade.percentage).toBe(50);
  });
});

describe('drop the lowest', () => {
  const quizzes = (dropLowest: number, items: ItemSpec[] = []) =>
    makeSetup(
      'weighted',
      [{ id: 'quiz', weight: 100, dropLowest }],
      items.length
        ? items
        : [
            { id: 'q1', max: 10, cat: 'quiz' },
            { id: 'q2', max: 10, cat: 'quiz' },
            { id: 'q3', max: 10, cat: 'quiz' },
          ],
    );

  it('drops the items with the lowest percentage', () => {
    const grade = computeCourseGrade(quizzes(1), scores({ q1: 8, q2: 5, q3: 9 }));
    expect([...grade.dropped]).toEqual(['q2']);
    expect(grade.percentage).toBe(85);
    const two = computeCourseGrade(quizzes(2), scores({ q1: 8, q2: 5, q3: 9 }));
    expect(new Set(two.dropped)).toEqual(new Set(['q1', 'q2']));
    expect(two.percentage).toBe(90);
  });

  it('compares percentages, not points', () => {
    const setup = quizzes(1, [
      { id: 'big', max: 100, cat: 'quiz' },
      { id: 'small', max: 10, cat: 'quiz' },
    ]);
    // 60 / 100 is 60%, 7 / 10 is 70%: the big one goes.
    expect([...computeCourseGrade(setup, scores({ big: 60, small: 7 })).dropped]).toEqual(['big']);
  });

  it('always keeps at least one graded item', () => {
    const grade = computeCourseGrade(quizzes(5), scores({ q1: 2, q2: 6 }));
    expect([...grade.dropped]).toEqual(['q1']);
    expect(grade.percentage).toBe(60);
    expect(computeCourseGrade(quizzes(5), scores({ q1: 2 })).dropped.size).toBe(0);
  });

  it('only considers graded items', () => {
    const grade = computeCourseGrade(quizzes(1), scores({ q1: 9, q2: null, q3: 4 }));
    expect([...grade.dropped]).toEqual(['q3']);
    expect(grade.percentage).toBe(90);
  });

  it('drops the item worth more first when percentages tie', () => {
    const setup = quizzes(1, [
      { id: 'small', max: 5, cat: 'quiz' },
      { id: 'big', max: 20, cat: 'quiz' },
      { id: 'ok', max: 10, cat: 'quiz' },
    ]);
    const grade = computeCourseGrade(setup, scores({ small: 0, big: 0, ok: 10 }));
    expect([...grade.dropped]).toEqual(['big']);
    expect(grade.percentage).toBe((10 / 15) * 100);
  });

  it('drops the earlier item when percentage and weight tie', () => {
    expect([...computeCourseGrade(quizzes(1), scores({ q1: 9, q2: 5, q3: 5 })).dropped]).toEqual(['q2']);
  });

  it('never drops items that count for nothing', () => {
    const setup = quizzes(1, [
      { id: 'zeroMax', max: 0, cat: 'quiz' },
      { id: 'zeroWeight', max: 10, cat: 'quiz', weight: 0 },
      { id: 'low', max: 10, cat: 'quiz' },
      { id: 'high', max: 10, cat: 'quiz' },
    ]);
    const grade = computeCourseGrade(setup, scores({ zeroMax: 0, zeroWeight: 0, low: 3, high: 9 }));
    expect([...grade.dropped]).toEqual(['low']);
    expect(grade.percentage).toBe(90);
  });

  it('applies to each category separately', () => {
    const setup = makeSetup(
      'weighted',
      [
        { id: 'a', weight: 50, dropLowest: 1 },
        { id: 'b', weight: 50 },
      ],
      [
        { id: 'a1', max: 10, cat: 'a' },
        { id: 'a2', max: 10, cat: 'a' },
        { id: 'b1', max: 10, cat: 'b' },
        { id: 'b2', max: 10, cat: 'b' },
      ],
    );
    const grade = computeCourseGrade(setup, scores({ a1: 0, a2: 10, b1: 0, b2: 10 }));
    expect([...grade.dropped]).toEqual(['a1']);
    expect(grade.percentage).toBe(75);
  });
});

// The tests below use a real (in-memory) database; the ones above are pure.
let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let db: DB;

async function userId(email: string) {
  return (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

/** The 0.1.2 gradebook (routes/grades.ts), kept verbatim apart from the shape of the result. */
async function legacyGradebook(courseId: string, includeHidden: boolean) {
  const rows = await db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .select(['activities.id', 'activities.maxGrade', 'activities.visible', 'sections.visible as sectionVisible'])
    .where('activities.courseId', '=', courseId)
    .where('activities.maxGrade', 'is not', null)
    .orderBy('sections.position', 'asc')
    .orderBy('activities.position', 'asc')
    .execute();
  const items = rows
    .filter((r) => includeHidden || (r.visible && r.sectionVisible))
    .map((r) => ({ activityId: r.id, maxGrade: r.maxGrade ?? 0 }));
  const grades = await db.selectFrom('grades').selectAll().where('courseId', '=', courseId).execute();
  const byKey = new Map(grades.map((g) => [`${g.activityId}:${g.userId}`, g]));
  return (uid: string) => {
    let total = 0;
    let max = 0;
    for (const item of items) {
      const g = byKey.get(`${item.activityId}:${uid}`);
      if (g?.score != null) {
        total += g.score;
        max += item.maxGrade;
      }
    }
    return {
      total: round(total),
      max: round(max),
      percentage: max > 0 ? round((total / max) * 100, 1) : null,
      exact: max > 0 ? (total / max) * 100 : null,
    };
  };
}

/** A course with hidden items, a zero max grade and fractional, missing and cleared grades, written straight to the database. */
async function randomCourse(seed: number) {
  const random = rng(seed);
  const courseId = school.course.id;
  const ts = new Date().toISOString();
  const sections = [school.sectionId];
  for (let i = 1; i < 3; i++) {
    const id = newId();
    sections.push(id);
    await db
      .insertInto('sections')
      .values({ id, courseId, title: `Week ${i + 1}`, summary: '', position: i, visible: i === 2 ? 0 : 1, createdAt: ts })
      .execute();
  }
  const activities: Array<{ id: string; max: number }> = [];
  for (let i = 0; i < 9; i++) {
    const id = newId();
    const max = i === 4 ? 0 : [10, 20, 25, 100, 7.5][i % 5]!;
    activities.push({ id, max });
    await db
      .insertInto('activities')
      .values({
        id,
        courseId,
        sectionId: sections[i % 3]!,
        type: i % 2 ? 'quiz' : 'assignment',
        title: `Graded ${i}`,
        description: '',
        position: Math.floor(i / 3),
        visible: i === 5 ? 0 : 1,
        settings: '{}',
        dueAt: null,
        maxGrade: max,
        completion: 'none',
        createdBy: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
  }
  const students: string[] = [];
  for (let s = 0; s < 8; s++) {
    // No password: these students never sign in, and hashing would only slow the test down.
    const created = { id: newId() };
    await db
      .insertInto('users')
      .values({
        id: created.id,
        email: `s${s}-${seed}@test.dev`,
        name: `Student ${s}`,
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
    students.push(created.id);
    await db
      .insertInto('enrolments')
      .values({ id: newId(), courseId, userId: created.id, role: 'student', status: 'active', lastAccessAt: null, createdAt: ts })
      .execute();
    for (const a of activities) {
      if (random() < 0.3) continue;
      const score = random() < 0.1 ? null : Math.round(random() * (a.max || 3) * 100) / 100;
      await db
        .insertInto('grades')
        .values({ activityId: a.id, userId: created.id, courseId, score, feedback: null, gradedBy: null, gradedAt: ts, updatedAt: ts })
        .execute();
    }
  }
  return { courseId, students };
}

describe('courseTotals', () => {
  beforeEach(async () => {
    lms = await createTestLms();
    school = await setupSchool(lms);
    db = lms.db;
  });
  afterEach(async () => {
    await lms.close();
  });

  it('returns a total for every user asked for, and null when nothing is graded', async () => {
    const a = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'Essay',
      maxGrade: 3,
    });
    await school.sam.post(`/api/courses/${school.course.id}/enrol`);
    await school.kim.post(`/api/courses/${school.course.id}/enrol`);
    const sam = await userId('sam@test.dev');
    const kim = await userId('kim@test.dev');
    expect((await school.teacher.put(`/api/courses/${school.course.id}/grades/${a.body.id}/${sam}`, { score: 2 })).status).toBe(200);

    const totals = await courseTotals(db, school.course.id, [sam, kim, 'nobody']);
    expect([...totals.entries()]).toEqual([
      [sam, 66.67],
      [kim, null],
      ['nobody', null],
    ]);
    expect((await courseTotals(db, school.course.id, [])).size).toBe(0);
    expect((await courseTotals(db, 'no-such-course', [sam])).get(sam)).toBeNull();
  });

  it('handles long lists of users', async () => {
    const { courseId, students } = await randomCourse(7);
    const many = [...Array.from({ length: 600 }, (_, i) => `ghost-${i}`), ...students];
    const totals = await courseTotals(db, courseId, many);
    expect(totals.size).toBe(many.length);
    expect(totals.get('ghost-1')).toBeNull();
    const few = await courseTotals(db, courseId, students);
    for (const s of students) expect(totals.get(s)).toBe(few.get(s));
  });

  it('counts hidden activities, which students do not see on their own page', async () => {
    const section = await school.teacher.post(`/api/courses/${school.course.id}/sections`, { title: 'Hidden', visible: false });
    const visible = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: school.sectionId,
      type: 'assignment',
      title: 'Visible',
      maxGrade: 10,
    });
    const hidden = await school.teacher.post(`/api/courses/${school.course.id}/activities`, {
      sectionId: section.body.id,
      type: 'assignment',
      title: 'Hidden',
      maxGrade: 10,
    });
    await school.sam.post(`/api/courses/${school.course.id}/enrol`);
    const sam = await userId('sam@test.dev');
    await school.teacher.put(`/api/courses/${school.course.id}/grades/${visible.body.id}/${sam}`, { score: 10 });
    await school.teacher.put(`/api/courses/${school.course.id}/grades/${hidden.body.id}/${sam}`, { score: 0 });

    expect((await courseTotals(db, school.course.id, [sam])).get(sam)).toBe(50);
    expect((await courseGrades(db, school.course.id, [sam], { includeHidden: false })).get(sam)?.percentage).toBe(100);
    const mine = await school.sam.get(`/api/courses/${school.course.id}/grades`);
    expect(mine.body.grades.percentage).toBe(100);
    const book = await school.teacher.get(`/api/courses/${school.course.id}/grades`);
    expect(book.body.gradebook.rows[0].percentage).toBe(50);
  });

  it('gives courses without categories exactly the same totals as 0.1.x', async () => {
    for (const seed of [1, 2, 3]) {
      const { courseId, students } = await randomCourse(seed);
      const staff = await legacyGradebook(courseId, true);
      const own = await legacyGradebook(courseId, false);
      const totals = await courseTotals(db, courseId, students);
      const exact = await courseGrades(db, courseId, students);
      const book = (await school.teacher.get(`/api/courses/${courseId}/grades`)).body.gradebook;

      for (const s of students) {
        const legacy = staff(s);
        const row = book.rows.find((r: { user: { id: string } }) => r.user.id === s);
        expect(exact.get(s)!.percentage).toBe(legacy.exact);
        expect(totals.get(s)).toBe(legacy.exact == null ? null : round(legacy.exact, 2));
        expect(row.total).toBe(legacy.total);
        expect(row.max).toBe(legacy.max);
        expect(row.percentage).toBe(totals.get(s));
        // What 0.1.x displayed (1 decimal) is the same number, rounded once.
        expect(legacy.exact == null ? null : round(legacy.exact, 1)).toBe(legacy.percentage);

        const ownLegacy = own(s);
        const ownExact = (await courseGrades(db, courseId, [s], { includeHidden: false })).get(s)!;
        expect(ownExact.percentage).toBe(ownLegacy.exact);
        expect(round(ownExact.earned)).toBe(ownLegacy.total);
        expect(round(ownExact.possible)).toBe(ownLegacy.max);
      }
      await db.deleteFrom('activities').where('courseId', '=', courseId).execute();
      await db.deleteFrom('sections').where('courseId', '=', courseId).where('id', '!=', school.sectionId).execute();
      await db.deleteFrom('enrolments').where('courseId', '=', courseId).where('role', '=', 'student').execute();
    }
  });
});
