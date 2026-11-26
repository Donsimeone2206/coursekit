import { readFileSync } from 'node:fs';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import type { Coursekit } from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';
import { parseMoodleXml } from '../src/server/services/question-formats/moodle-xml.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';

const exampleGift = readFileSync(new URL('./fixtures/questions/example.gift', import.meta.url), 'utf8');
const moodleXml = readFileSync(new URL('./fixtures/questions/moodle-export.xml', import.meta.url), 'utf8');

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;
let tina: Client;
/** Tina teaches A and B; Bea teaches B only; Otto teaches C only. Sam studies in B. */
let A: string;
let B: string;
let C: string;
let bea: Client;
let otto: Client;

async function del(who: Client, path: string) {
  const res = await lms.app.request(path, { method: 'DELETE', headers: { cookie: who.cookie, origin: 'http://localhost' } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function course(who: Client, title: string) {
  const res = await who.post('/api/courses', { title, summary: '', visibility: 'published' });
  expect(res.status).toBe(201);
  const detail = await who.get(`/api/courses/${res.body.id}`);
  return { id: res.body.id as string, sectionId: detail.body.sections[0].id as string };
}

async function categories(who: Client, courseId: string) {
  return (await who.get(`/api/courses/${courseId}/question-categories`)).body as Array<Record<string, any>>;
}

async function questions(who: Client, courseId: string, query = '') {
  return (await who.get(`/api/courses/${courseId}/questions?pageSize=100${query}`)).body as {
    items: Array<Record<string, any>>;
    total: number;
  };
}

async function importGift(who: Client, courseId: string, content: string, extra: Record<string, unknown> = {}) {
  return who.post(`/api/courses/${courseId}/question-import`, {
    content,
    filename: 'q.gift',
    categoryId: null,
    createCategories: true,
    ...extra,
  });
}

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  tina = school.teacher;
  A = school.course.id;
  await lms.createUser({ name: 'Bea Teacher', email: 'bea@test.dev', password: PASSWORD, role: 'instructor' });
  await lms.createUser({ name: 'Otto Teacher', email: 'otto@test.dev', password: PASSWORD, role: 'instructor' });
  bea = await login(lms, 'bea@test.dev');
  otto = await login(lms, 'otto@test.dev');
  B = (await course(tina, 'Second course')).id;
  C = (await course(otto, 'Other course')).id;
  expect((await tina.post(`/api/courses/${B}/participants`, { emails: ['bea@test.dev'], role: 'teacher' })).status).toBeLessThan(300);
  await school.sam.post(`/api/courses/${B}/enrol`);
});

afterEach(async () => {
  await lms.close();
});

describe('import', () => {
  it('previews a GIFT file without saving anything, then imports it', async () => {
    const before = await categories(tina, A);
    const preview = await tina.post(`/api/courses/${A}/question-import/preview`, {
      content: exampleGift,
      filename: 'example.gift',
      categoryId: null,
      createCategories: true,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ format: 'gift', found: 8, ready: 8, errors: [] });
    expect(preview.body.counts).toEqual(
      expect.arrayContaining([
        { type: 'single', count: 1 },
        { type: 'truefalse', count: 2 },
      ]),
    );
    expect(preview.body.categories).toEqual([
      { label: 'Example questions', isNew: true, questionCount: 0 },
      { label: 'Example questions › Geography', isNew: true, questionCount: 4 },
      { label: 'Example questions › Language', isNew: true, questionCount: 4 },
    ]);
    expect(preview.body.warnings[0]).toMatchObject({ number: 1, line: 7 });
    expect(await categories(tina, A)).toEqual(before);

    const done = await importGift(tina, A, exampleGift);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toEqual({ imported: 8, categoriesCreated: 3, skipped: 0 });
    const after = await categories(tina, A);
    const geo = after.find((c) => c.name === 'Geography')!;
    expect(geo.questionCount).toBe(4);
    expect(after.find((c) => c.id === geo.parentId)!.name).toBe('Example questions');

    // Importing again reuses the categories.
    const again = await importGift(tina, A, exampleGift);
    expect(again.body.categoriesCreated).toBe(0);
    expect((await categories(tina, A)).find((c) => c.id === geo.id)!.questionCount).toBe(8);
  });

  it('imports everything into one category, skipping questions with errors', async () => {
    const [first] = await categories(tina, A);
    const target = (await tina.post(`/api/courses/${A}/question-categories`, { name: 'Imported' })).body;
    const res = await tina.post(`/api/courses/${A}/question-import`, {
      content: moodleXml,
      filename: 'bio.xml',
      categoryId: target.id,
      createCategories: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ imported: 8, categoriesCreated: 0, skipped: 4 });
    const cats = await categories(tina, A);
    expect(cats.find((c) => c.id === target.id)!.questionCount).toBe(8);
    expect(cats.find((c) => c.id === first!.id)!.questionCount).toBe(0);

    const preview = await tina.post(`/api/courses/${A}/question-import/preview`, {
      content: moodleXml,
      categoryId: target.id,
      createCategories: true,
    });
    expect(preview.body.format).toBe('moodle');
    expect(preview.body.errors).toEqual([expect.objectContaining({ number: 12, message: 'Mark exactly one option as correct' })]);
    expect(preview.body.categories.map((c: any) => c.label)).toEqual([
      'Imported › Default for BIO101',
      'Imported › Default for BIO101 › Cells & tissues',
      'Imported › Default for BIO101 › Genetics',
    ]);
  });

  it('checks files, limits and permissions', async () => {
    const preview = (body: Record<string, unknown>, who = tina, courseId = A) =>
      who.post(`/api/courses/${courseId}/question-import/preview`, { categoryId: null, createCategories: true, ...body });
    expect((await preview({ content: '<quiz><question>' })).body.error.message).toMatch(/valid XML/);
    expect((await preview({ content: '   ' })).body.error.message).toMatch(/empty/);
    expect((await preview({ content: 'x'.repeat(3 * 1024 * 1024 + 1) })).status).toBe(400);
    const many = Array.from({ length: 2001 }, (_, i) => `Q${i} {T}`).join('\n\n');
    expect((await preview({ content: many })).body.error.message).toMatch(/more than 2000 questions/);
    const nothing = await importGift(tina, A, 'Just a description.');
    expect(nothing.status).toBe(400);
    expect((await preview({ content: 'Q {T}', categoryId: 'nope' })).status).toBe(400);
    // Only people who manage the bank can import.
    expect((await preview({ content: 'Q {T}' }, school.sam)).status).toBe(403);
    expect((await preview({ content: 'Q {T}' }, otto)).status).toBe(403);
    // Another course's category can't be the target.
    const theirs = (await categories(otto, C))[0]!;
    expect((await preview({ content: 'Q {T}', categoryId: theirs.id })).status).toBe(400);
  });

  it('refuses deep category paths quickly, reads its own export of a DOCTYPE question, and names what is too long', async () => {
    const preview = (content: string, filename = 'q.gift') =>
      tina.post(`/api/courses/${A}/question-import/preview`, { content, filename, categoryId: null, createCategories: true });
    const deep = await preview(`$CATEGORY: $course$/top/${'a/'.repeat(200_000)}\n\nQ{=a}`);
    expect(deep.status).toBe(400);
    expect(deep.body.error.message).toMatch(/at most 50 levels/);
    const fifty = await preview(`$CATEGORY: $course$/top/${'a/'.repeat(50)}\n\nQ{=a}`);
    expect(fifty.status, JSON.stringify(fifty.body)).toBe(200);
    expect(fifty.body.categories).toHaveLength(50);

    expect((await importGift(tina, A, '[markdown]Every HTML5 page should start with `<!DOCTYPE html>`.{T}\n\nSecond {=a}')).status).toBe(
      201,
    );
    const exported = await tina.post(`/api/courses/${A}/question-export`, { format: 'moodle' });
    expect(exported.body.content).toContain('<!DOCTYPE html>');
    const again = await preview(exported.body.content, 'bank.xml');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ ready: 2, errors: [] });

    const long = `<quiz>
<question type="multichoice"><name><text>Long</text></name><questiontext format="plain_text"><text>Pick one</text></questiontext>
<single>true</single><answer fraction="100" format="plain_text"><text>${'x'.repeat(2100)}</text></answer>
<answer fraction="0" format="plain_text"><text>No</text></answer></question>
<question type="shortanswer"><name><text>Short</text></name><questiontext format="plain_text"><text>Say it</text></questiontext>
<answer fraction="100" format="plain_text"><text>${'y'.repeat(600)}</text></answer></question>
</quiz>`;
    const issues = await preview(long, 'long.xml');
    expect(issues.status, JSON.stringify(issues.body)).toBe(200);
    expect(issues.body.errors.map((e: { message: string }) => e.message)).toEqual([
      'An answer or item is too long (at most 2,000 characters).',
      'An accepted answer is too long (at most 500 characters).',
    ]);
  });
});

describe('export', () => {
  it('exports a category with its subcategories as Moodle XML, and GIFT without ordering questions', async () => {
    await tina.post(`/api/courses/${A}/question-import`, { content: moodleXml, categoryId: null, createCategories: true });
    const top = (await categories(tina, A)).find((c) => c.name === 'Default for BIO101')!;
    const xml = await tina.post(`/api/courses/${A}/question-export`, { format: 'moodle', categoryId: top.id, includeSubcategories: true });
    expect(xml.status, JSON.stringify(xml.body)).toBe(200);
    expect(xml.body).toMatchObject({ mimeType: 'application/xml', exported: 8, skipped: [] });
    expect(xml.body.filename).toMatch(/^default-for-bio101-questions-\d{4}-\d{2}-\d{2}\.xml$/);
    const parsed = parseMoodleXml(xml.body.content);
    expect(parsed.questions).toHaveLength(8);
    expect(parsed.questions[0]!.category).toEqual(['Default for BIO101', 'Cells & tissues']);

    const only = await tina.post(`/api/courses/${A}/question-export`, {
      format: 'moodle',
      categoryId: top.id,
      includeSubcategories: false,
    });
    expect(only.body.error.message).toMatch(/no questions/);

    const gift = await tina.post(`/api/courses/${A}/question-export`, { format: 'gift', categoryId: top.id });
    expect(gift.body.exported).toBe(7);
    expect(gift.body.skipped).toEqual([
      expect.objectContaining({ label: 'Mitosis phases', reason: 'GIFT can’t hold ordering questions.' }),
    ]);
    expect(gift.body.content).toContain('$CATEGORY: $course$/top/Default for BIO101/Genetics');

    const ids = (await questions(tina, A)).items.slice(0, 2).map((q) => q.id);
    const picked = await tina.post(`/api/courses/${A}/question-export`, { format: 'gift', questionIds: ids });
    expect(picked.body.exported + picked.body.skipped.length).toBe(2);
    // Nobody else can export them.
    expect((await otto.post(`/api/courses/${C}/question-export`, { format: 'gift', questionIds: ids })).status).toBe(400);
    expect((await otto.post(`/api/courses/${C}/question-export`, { format: 'gift', categoryId: top.id })).status).toBe(404);
    expect((await otto.post(`/api/courses/${A}/question-export`, { format: 'gift' })).status).toBe(403);
  });
});

describe('copies', () => {
  it('copies questions and whole categories to another course, independently', async () => {
    await importGift(tina, A, exampleGift);
    const cats = await categories(tina, A);
    const top = cats.find((c) => c.name === 'Example questions')!;
    const targets = (await tina.get('/api/question-bank/courses')).body.map((c: any) => c.id);
    expect(targets.sort()).toEqual([A, B].sort());

    const copied = await tina.post('/api/question-copies', { categoryId: top.id, targetCourseId: B, targetCategoryId: null });
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    expect(copied.body).toMatchObject({ questions: 8, categories: 3 });
    const inB = await categories(tina, B);
    expect(inB.map((c) => c.name)).toEqual(['Example questions', 'Geography', 'Language']);
    expect(inB.find((c) => c.name === 'Geography')!.questionCount).toBe(4);

    const one = (await questions(tina, A)).items[0]!;
    const single = await tina.post('/api/question-copies', { questionIds: [one.id], targetCourseId: B });
    expect(single.body.questions).toBe(1);
    expect((await categories(tina, B))[0]!.questionCount).toBe(1);

    // Editing the original leaves the copies alone.
    const original = (await tina.get(`/api/questions/${one.id}`)).body;
    await tina.put(`/api/questions/${one.id}`, { ...original, prompt: 'Changed' });
    expect((await questions(tina, B)).items.every((q) => q.excerpt !== 'Changed')).toBe(true);

    // Only into courses whose bank you manage, and only from banks you can read.
    expect((await tina.post('/api/question-copies', { questionIds: [one.id], targetCourseId: C })).status).toBe(403);
    expect((await otto.post('/api/question-copies', { questionIds: [one.id], targetCourseId: C })).status).toBe(404);
    expect((await otto.post('/api/question-copies', { categoryId: top.id, targetCourseId: C })).status).toBe(404);
    expect((await school.sam.post('/api/question-copies', { questionIds: [one.id], targetCourseId: B })).status).toBe(403);
    expect((await tina.post('/api/question-copies', { questionIds: [one.id], targetCourseId: B, targetCategoryId: top.id })).status).toBe(
      400,
    );
  });
});

describe('sharing', () => {
  async function sharedSetup() {
    await importGift(tina, A, exampleGift);
    const cats = await categories(tina, A);
    const geo = cats.find((c) => c.name === 'Geography')!;
    const language = cats.find((c) => c.name === 'Language')!;
    const share = await tina.post(`/api/question-categories/${geo.id}/shares`, { courseId: B });
    expect(share.status, JSON.stringify(share.body)).toBe(201);
    return { geo, language, share: share.body };
  }

  it('lets the owner share with courses they also manage, and only administrators with the whole site', async () => {
    const { geo, share } = await sharedSetup();
    const settings = (await tina.get(`/api/question-categories/${geo.id}/shares`)).body;
    expect(settings).toMatchObject({ canShareWithSite: false, shares: [{ id: share.id, course: { id: B } }] });
    expect(settings.courses.map((c: any) => c.id)).toEqual([B]);
    // Sharing twice keeps one share.
    expect((await tina.post(`/api/question-categories/${geo.id}/shares`, { courseId: B })).body.id).toBe(share.id);
    expect((await tina.post(`/api/question-categories/${geo.id}/shares`, { courseId: C })).status).toBe(400);
    expect((await tina.post(`/api/question-categories/${geo.id}/shares`, { courseId: A })).status).toBe(400);
    expect((await tina.post(`/api/question-categories/${geo.id}/shares`, { site: true })).status).toBe(403);
    // Bea teaches B, not A: she uses the share but can't manage it.
    expect((await bea.get(`/api/question-categories/${geo.id}/shares`)).status).toBe(404);
    expect((await bea.post(`/api/question-categories/${geo.id}/shares`, { courseId: B })).status).toBe(404);
    expect((await del(bea, `/api/question-category-shares/${share.id}`)).status).toBe(404);
    expect((await otto.get(`/api/question-categories/${geo.id}/shares`)).status).toBe(404);
  });

  it('shows shared categories read-only to the other course, and nothing to anyone else', async () => {
    const { geo, language } = await sharedSetup();
    const shared = (await bea.get(`/api/courses/${B}/shared-question-categories`)).body;
    expect(shared).toEqual([
      expect.objectContaining({ id: geo.id, parentId: null, questionCount: 4, sharedFrom: { courseId: A, courseTitle: 'Testing 101' } }),
    ]);
    expect((await otto.get(`/api/courses/${C}/shared-question-categories`)).body).toEqual([]);
    expect((await school.sam.get(`/api/courses/${B}/shared-question-categories`)).status).toBe(403);

    const list = await questions(bea, B, `&categoryId=${geo.id}`);
    expect(list.total).toBe(4);
    expect(list.items[0]!.sharedFrom).toEqual({ courseId: A, courseTitle: 'Testing 101' });
    // Categories that aren't shared stay invisible.
    expect((await questions(bea, B, `&categoryId=${language.id}`)).total).toBe(0);
    expect((await questions(otto, C, `&categoryId=${geo.id}`)).total).toBe(0);

    const q = list.items[0]!;
    expect((await bea.get(`/api/questions/${q.id}`)).body).toMatchObject({ id: q.id, usage: [] });
    expect((await bea.get(`/api/questions/${q.id}/preview`)).status).toBe(200);
    expect((await bea.post(`/api/questions/${q.id}/check`, { answer: {} })).status).toBe(200);
    // Read-only: only the owning course edits.
    const full = (await bea.get(`/api/questions/${q.id}`)).body;
    expect((await bea.put(`/api/questions/${q.id}`, { ...full, prompt: 'Hacked' })).status).toBe(404);
    expect((await bea.post(`/api/questions/${q.id}/duplicate`)).status).toBe(404);
    expect((await del(bea, `/api/questions/${q.id}`)).status).toBe(404);
    expect((await bea.patch(`/api/question-categories/${geo.id}`, { name: 'Mine' })).status).toBe(404);
    expect(
      (await bea.post(`/api/courses/${B}/questions/move`, { ids: [q.id], categoryId: (await categories(bea, B))[0]!.id })).body.moved,
    ).toBe(0);
    // Otto has no share.
    expect((await otto.get(`/api/questions/${q.id}`)).status).toBe(404);
    expect((await otto.get(`/api/questions/${q.id}/preview`)).status).toBe(404);
    // Shared questions can be copied into the course's own bank.
    expect((await bea.post('/api/question-copies', { categoryId: geo.id, targetCourseId: B })).body).toMatchObject({
      questions: 4,
      categories: 1,
    });
    expect((await otto.post('/api/question-copies', { categoryId: geo.id, targetCourseId: C })).status).toBe(404);
    // And exported.
    expect((await bea.post(`/api/courses/${B}/question-export`, { format: 'moodle', categoryId: geo.id })).body.exported).toBe(4);
  });

  it('lets quizzes use shared questions and categories, and keeps them working when the share ends', async () => {
    const { geo, language, share } = await sharedSetup();
    const { sectionId } = await (async () => ({ sectionId: (await bea.get(`/api/courses/${B}`)).body.sections[0].id as string }))();
    const quiz = (await bea.post(`/api/courses/${B}/activities`, { sectionId, type: 'quiz', title: 'Shared quiz', settings: {} })).body.id;
    const shared = (await questions(bea, B, `&categoryId=${geo.id}`)).items;
    const notShared = (await questions(tina, A, `&categoryId=${language.id}`)).items[0]!;
    const fixed = shared.find((q) => q.type === 'single')!;

    const slots = [
      { kind: 'question', questionId: fixed.id, points: 2 },
      { kind: 'random', categoryId: geo.id, questionCount: 2, includeSubcategories: true, points: 1 },
    ];
    const saved = await bea.put(`/api/activities/${quiz}/slots`, { slots });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.slots[0].question.sharedFrom).toEqual({ courseId: A, courseTitle: 'Testing 101' });
    expect(saved.body.slots[1]).toMatchObject({ available: 3, category: { id: geo.id, name: 'Geography', sharedFrom: { courseId: A } } });
    expect(saved.body.problems).toEqual([]);
    // Not shared: neither the question nor the category can be used.
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots: [{ kind: 'question', questionId: notShared.id }] })).status).toBe(400);
    expect(
      (await bea.put(`/api/activities/${quiz}/slots`, { slots: [{ kind: 'random', categoryId: language.id, questionCount: 1 }] })).status,
    ).toBe(400);
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots })).status).toBe(200);

    const attempt = async () => {
      const started = await school.sam.post(`/api/activities/${quiz}/attempts`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const body = (await school.sam.get(`/api/attempts/${started.body.id}`)).body;
      await school.sam.post(`/api/attempts/${started.body.id}/submit`, {});
      return body;
    };
    const first = await attempt();
    expect(first.questions).toHaveLength(3);
    expect(first.questions[0].id).toBe(fixed.id);

    // The owner can't delete what other courses' quizzes rely on.
    expect((await del(tina, `/api/questions/${fixed.id}`)).status).toBe(409);
    const moveTo = (await categories(tina, A))[0]!.id;
    expect((await del(tina, `/api/question-categories/${geo.id}?moveTo=${moveTo}`)).status).toBe(409);
    // The owner's bank doesn't show B's quiz titles.
    expect((await tina.get(`/api/questions/${fixed.id}`)).body.usage).toEqual([]);

    // End the share.
    expect((await del(tina, `/api/question-category-shares/${share.id}`)).status).toBe(200);
    expect((await bea.get(`/api/courses/${B}/shared-question-categories`)).body).toEqual([]);
    expect((await questions(bea, B, `&categoryId=${geo.id}`)).total).toBe(0);
    // The quiz keeps working, and can still be saved as it is...
    expect((await attempt()).questions).toHaveLength(3);
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots })).status).toBe(200);
    expect((await bea.get(`/api/questions/${fixed.id}/preview`)).status).toBe(200);
    // ...but once removed, the questions can't be added again.
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots: [slots[1]] })).status).toBe(200);
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots })).status).toBe(400);
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots: [] })).status).toBe(200);
    expect((await bea.put(`/api/activities/${quiz}/slots`, { slots: [slots[1]] })).status).toBe(400);
    expect((await bea.get(`/api/questions/${shared[1]!.id}/preview`)).status).toBe(404);
    // Old attempts still have their questions.
    const attempts = (await school.sam.get(`/api/activities/${quiz}/attempts`)).body;
    const review = (await school.sam.get(`/api/attempts/${attempts[attempts.length - 1].id}`)).body;
    expect(review.questions).toHaveLength(3);
  });

  it('keeps random slots to the questions they had when the share ended: no widening, nothing added later', async () => {
    const { geo, share } = await sharedSetup();
    const sectionId = (await bea.get(`/api/courses/${B}`)).body.sections[0].id as string;
    const quiz = (await bea.post(`/api/courses/${B}/activities`, { sectionId, type: 'quiz', title: 'Geo quiz', settings: {} })).body.id;
    const put = (slots: unknown[]) => bea.put(`/api/activities/${quiz}/slots`, { slots });
    const slot = { kind: 'random', categoryId: geo.id, questionCount: 2, includeSubcategories: false, points: 1 };
    const saved = await put([slot]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const id = saved.body.slots[0].id as string;
    expect((await del(tina, `/api/question-category-shares/${share.id}`)).status).toBe(200);

    // The owner adds a question, and a subcategory with a question, after the share ended.
    const priv = (await tina.post(`/api/courses/${A}/question-categories`, { name: 'Private', parentId: geo.id })).body;
    expect((await importGift(tina, A, 'SECRET-AFTER-UNSHARE {T}', { categoryId: geo.id, createCategories: false })).status).toBe(201);
    expect((await importGift(tina, A, 'PRIVATE-SUBCATEGORY {T}', { categoryId: priv.id, createCategories: false })).status).toBe(201);

    // Widening is refused: subcategories, more questions, a second slot.
    expect((await put([{ ...slot, id, includeSubcategories: true }])).status).toBe(400);
    expect((await put([{ ...slot, id, questionCount: 3 }])).status).toBe(400);
    expect(
      (
        await put([
          { ...slot, id },
          { ...slot, questionCount: 1 },
        ])
      ).status,
    ).toBe(400);
    // The slot keeps the four questions it had and may pick fewer.
    const kept = await put([{ ...slot, id, questionCount: 1 }]);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.slots[0].available).toBe(4);
    for (let i = 0; i < 4; i++) {
      const started = await school.sam.post(`/api/activities/${quiz}/attempts`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const attempt = JSON.stringify((await school.sam.get(`/api/attempts/${started.body.id}`)).body);
      expect(attempt).not.toMatch(/SECRET-AFTER-UNSHARE|PRIVATE-SUBCATEGORY/);
      await school.sam.post(`/api/attempts/${started.body.id}/submit`, {});
    }
    // Shared again, the slot draws from the category as it is now.
    expect((await tina.post(`/api/question-categories/${geo.id}/shares`, { courseId: B })).status).toBe(201);
    expect((await bea.get(`/api/activities/${quiz}/slots`)).body.slots[0].available).toBe(5);
  });

  it('lets administrators share with every course on the site', async () => {
    await importGift(tina, A, exampleGift);
    const geo = (await categories(tina, A)).find((c) => c.name === 'Geography')!;
    const res = await school.admin.post(`/api/question-categories/${geo.id}/shares`, { site: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.course).toBeNull();
    expect((await otto.get(`/api/courses/${C}/shared-question-categories`)).body.map((c: any) => c.id)).toEqual([geo.id]);
    expect((await questions(otto, C, `&categoryId=${geo.id}`)).total).toBe(4);
    // A student still sees nothing.
    expect((await school.sam.get(`/api/questions/${(await questions(otto, C, `&categoryId=${geo.id}`)).items[0]!.id}`)).status).toBe(404);
    // The owning course's teacher can end it.
    expect((await del(tina, `/api/question-category-shares/${res.body.id}`)).status).toBe(200);
    expect((await otto.get(`/api/courses/${C}/shared-question-categories`)).body).toEqual([]);
  });
});

describe('demo', () => {
  it('shares the web course’s accessibility questions with the UX course', async () => {
    const demo = await createTestLms();
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const maya = await login(demo, 'maya.chen@coursekit.test', 'demo-password');
      const ux = (await maya.get('/api/courses/ux-design-principles')).body;
      const shared = (await maya.get(`/api/courses/${ux.id}/shared-question-categories`)).body;
      expect(shared).toEqual([
        expect.objectContaining({ name: 'Accessibility', sharedFrom: expect.objectContaining({ courseTitle: 'Modern Web Development' }) }),
      ]);
      expect((await maya.get(`/api/courses/${ux.id}/questions?categoryId=${shared[0].id}`)).body.total).toBeGreaterThan(0);
    } finally {
      await demo.close();
    }
  });
});

describe('migration 010_question_sharing', () => {
  it('upgrades a 0.2.0 database', async () => {
    const { db } = await createDatabase('sqlite::memory:');
    const upTo006 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= '006_grade_categories'));
    const old = new Migrator({ db: db.withoutPlugins(), provider: { getMigrations: async () => upTo006 } });
    expect((await old.migrateToLatest()).error).toBeUndefined();
    const ts = new Date().toISOString();
    const course = newId();
    const category = newId();
    await db
      .insertInto('courses')
      .values({
        id: course,
        slug: 'old-course',
        title: 'Old course',
        summary: '',
        description: '',
        categoryId: null,
        coverColor: 'blue',
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
      .insertInto('questionCategories')
      .values({ id: category, courseId: course, parentId: null, name: 'Old', description: '', position: 0, createdAt: ts })
      .execute();

    const results = await migrateToLatest(db);
    const later = Object.keys(migrations).filter((name) => name > '006_grade_categories');
    expect(results.map((r) => [r.migrationName, r.status])).toEqual(later.map((name) => [name, 'Success']));
    await db
      .insertInto('questionCategoryShares')
      .values({ id: newId(), categoryId: category, courseId: null, createdBy: null, createdAt: ts })
      .execute();
    expect(await db.selectFrom('questionCategoryShares').select('categoryId').execute()).toEqual([{ categoryId: category }]);
    // Deleting the category removes its shares.
    await db.deleteFrom('questionCategories').where('id', '=', category).execute();
    expect(await db.selectFrom('questionCategoryShares').selectAll().execute()).toEqual([]);
    await db.destroy();
  });
});
