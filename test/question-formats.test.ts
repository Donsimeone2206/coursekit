import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { exportGift, parseGift } from '../src/server/services/question-formats/gift.js';
import { exportMoodleXml, parseMoodleXml } from '../src/server/services/question-formats/moodle-xml.js';
import { escapeMarkdown, htmlToMarkdown, toMarkdown } from '../src/server/services/question-formats/text.js';
import type { ExportItem, ImportedQuestionInput } from '../src/server/services/question-formats/types.js';
import { questionInputSchema, storedQuestion } from '../src/server/services/question-types.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/questions/${name}`, import.meta.url), 'utf8');

function gift(source: string) {
  const result = parseGift(source);
  return { ...result, q: result.questions.map((q) => q.input) };
}

function one(source: string): ImportedQuestionInput {
  const { q, errors } = gift(source);
  expect(errors).toEqual([]);
  expect(q).toHaveLength(1);
  return q[0]!;
}

describe('GIFT import', () => {
  it('reads every question type', () => {
    const { q, errors, warnings, categories } = gift(fixture('example.gift'));
    expect(errors).toEqual([]);
    expect(q.map((x) => x.type)).toEqual(['single', 'multiple', 'truefalse', 'numeric', 'short', 'matching', 'essay', 'truefalse']);
    expect(categories.map((c) => c.path)).toEqual([
      ['Example questions', 'Geography'],
      ['Example questions', 'Language'],
    ]);
    expect(q[0]).toMatchObject({
      name: 'Capital of France',
      prompt: 'What is the capital of France?',
      explanation: 'Paris has been the capital since the 10th century.',
      options: [
        { text: 'Paris', correct: true },
        { text: 'Lyon', correct: false },
        { text: 'Marseille', correct: false },
      ],
    });
    expect(warnings.find((w) => w.number === 1)?.message).toMatch(/Feedback for individual answers/);
    expect(q[1]!.options!.map((o) => o.correct)).toEqual([true, true, false]);
    expect(q[2]!.options).toEqual([
      { text: 'True', correct: true },
      { text: 'False', correct: false },
    ]);
    expect(q[3]).toMatchObject({ prompt: 'Mount Everest is about _____ metres high.', acceptedAnswers: ['8849'], tolerance: 10 });
    expect(q[4]).toMatchObject({ prompt: 'The plural of "mouse" is _____.', acceptedAnswers: ['mice', 'mouses'] });
    expect(q[5]).toMatchObject({
      pairs: [
        { text: 'Hund', answer: 'dog' },
        { text: 'Katze', answer: 'cat' },
        { text: 'Vogel', answer: 'bird' },
      ],
      distractors: ['fish'],
    });
    expect(q[6]).toMatchObject({
      type: 'essay',
      prompt: 'Write about a **journey** that changed how you see the world.\nAim for about 150 words.',
    });
    expect(q[7]!.prompt).toBe('In GIFT you write a literal { as \\\\{ and a colon as \\\\:. Is that right?');
    // Every question is valid input for the bank.
    for (const input of q) expect(questionInputSchema.safeParse(input).success).toBe(true);
  });

  it('handles comments, titles, formats, escapes and line breaks', () => {
    const q = one(`// a comment
// another one
::Title with \\: colon::[html]<p>Is 2 &lt; 3 <b>and</b> 1 \\= 1?</p>{T}`);
    expect(q.name).toBe('Title with : colon');
    expect(q.prompt).toBe('Is 2 \\< 3 **and** 1 = 1?');
    expect(one('::Esc::A \\~ tilde, a \\# hash, braces \\{ \\} and a\\nnew line {TRUE}').prompt).toBe(
      'A \\~ tilde, a # hash, braces { } and a\nnew line',
    );
    expect(one('[plain]Use *stars* and _underscores_ literally {F}').prompt).toBe('Use \\*stars\\* and \\_underscores\\_ literally');
    expect(one('[markdown]Keep *this* as Markdown {F}').prompt).toBe('Keep *this* as Markdown');
    expect(one('A [moodle] text with\nseveral lines {F}').prompt).toBe('A \\[moodle\\] text with\nseveral lines');
    expect(one('Backslash \\\\ stays {F}').prompt).toBe('Backslash \\ stays');
  });

  it('reads true/false spellings and feedback', () => {
    expect(one('Q {T}').options![0]!.correct).toBe(true);
    expect(one('Q {TRUE}').options![0]!.correct).toBe(true);
    expect(one('Q {F}').options![1]!.correct).toBe(true);
    const { q, warnings } = gift('Q {FALSE#Wrong, it is false.#Right!}');
    expect(q[0]!.options![1]!.correct).toBe(true);
    expect(warnings.map((w) => w.message)).toContain('Feedback for individual answers isn’t supported and was left out.');
    // Moodle reads lowercase "t" as a short answer.
    expect(one('Q {t}').type).toBe('short');
  });

  it('reads multiple choice with partial credit', () => {
    const single = gift('Pick {=A ~%50%B ~C}');
    expect(single.q[0]).toMatchObject({ type: 'single', options: [{ correct: true }, { correct: false }, { correct: false }] });
    expect(single.warnings[0]!.message).toMatch(/Partial credit/);
    const multi = gift('Pick {~%33.33333%A ~%33.33333%B ~%33.33333%C ~%-100%D}');
    expect(multi.q[0]!.options!.map((o) => o.correct)).toEqual([true, true, true, false]);
    expect(multi.warnings).toEqual([]);
    const uneven = gift('Pick {~%70%A ~%30%B ~C}');
    expect(uneven.warnings[0]!.message).toMatch(/equal share/);
    const best = gift('Pick {~%50%A ~B ~C}');
    expect(best.q[0]).toMatchObject({ type: 'multiple' });
    // Several = answers: only the first is right in Coursekit.
    const two = gift('Pick {=A =B ~C}');
    expect(two.q[0]!.options!.map((o) => o.correct)).toEqual([true, false, false]);
    expect(two.warnings[0]!.message).toMatch(/More than one answer/);
  });

  it('reads numerical answers, ranges and several answers', () => {
    expect(one('Pi? {#3.14159:0.0005}')).toMatchObject({ type: 'numeric', acceptedAnswers: ['3.14159'], tolerance: 0.0005 });
    expect(one('Range {#1..5}')).toMatchObject({ acceptedAnswers: ['3'], tolerance: 2 });
    expect(one('Range {#1.1..1.3}')).toMatchObject({ acceptedAnswers: ['1.2'], tolerance: 0.1 });
    expect(one('Exact {#-12}')).toMatchObject({ acceptedAnswers: ['-12'], tolerance: 0 });
    const several = gift('When? {#\n=1822:0\n=%50%1821:2#Close\n~Wrong answer feedback}');
    expect(several.q[0]).toMatchObject({ acceptedAnswers: ['1822'], tolerance: 0 });
    expect(several.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/less than 100%/), expect.stringMatching(/individual answers/)]),
    );
    const margins = gift('Two {# =5:0.1 =10:0.5}');
    expect(margins.q[0]).toMatchObject({ acceptedAnswers: ['5', '10'], tolerance: 0.5 });
    expect(margins.warnings[0]!.message).toMatch(/different margins/);
    const bad = gift('Bad {#abc}');
    expect(bad.q).toEqual([]);
    expect(bad.errors[0]).toMatchObject({ number: 1, line: 1, message: expect.stringMatching(/isn’t a number/) });
  });

  it('reads short answers with weights, and fill-in-the-blank', () => {
    expect(one('Two plus two is {=four =4} isn’t it?')).toMatchObject({
      type: 'short',
      prompt: 'Two plus two is _____ isn’t it?',
      acceptedAnswers: ['four', '4'],
    });
    const partial = gift('Capital? {=Canberra =%50%Sydney}');
    expect(partial.q[0]!.acceptedAnswers).toEqual(['Canberra']);
    expect(partial.warnings[0]!.message).toMatch(/less than 100%/);
    expect(one('Moodle costs {~lots of money =nothing ~a small amount} to download.').prompt).toBe('Moodle costs _____ to download.');
  });

  it('reads matching, essays and general feedback', () => {
    expect(one('Match {=a -> 1 =b -> 2 =c -> 3}').pairs).toHaveLength(3);
    expect(one('Essay {}')).toMatchObject({ type: 'essay', prompt: 'Essay' });
    expect(one('Essay {####Think about it.}')).toMatchObject({ type: 'essay', explanation: 'Think about it.' });
    expect(one('Q {=A ~B ####Because \\{A\\}}').explanation).toBe('Because {A}');
  });

  it('reports errors with question and line numbers, and skips descriptions', () => {
    const source = [
      '// header',
      '',
      'Fine {T}',
      '',
      'No closing brace {=a ~b',
      '',
      'A description, not a question.',
      '',
      'Two answers {T} and {F}',
      '',
      'Bad match {=a -> 1 =b}',
      '',
      'Stray } brace {T}',
    ].join('\n');
    const { q, errors, warnings, skipped } = gift(source);
    expect(q).toHaveLength(1);
    expect(skipped).toBe(5);
    expect(errors.map((e) => [e.number, e.line, e.message.slice(0, 30)])).toEqual([
      [2, 5, 'The answers start with “{” but'],
      [4, 9, 'Only one set of answers in bra'],
      [5, 11, 'Each matching pair needs “->” '],
      [6, 13, 'There’s a “}” without an openi'],
    ]);
    expect(warnings).toEqual([expect.objectContaining({ number: 3, line: 7, message: expect.stringMatching(/description/) })]);
  });

  it('drops embedded images with a warning', () => {
    const { q, warnings } = gift('[html]<p>Look: <img src="@@PLUGINFILE@@/a.png"></p>{T}');
    expect(q[0]!.prompt).toBe('Look:');
    expect(warnings[0]!.message).toMatch(/Images/);
  });
});

describe('Moodle XML import', () => {
  it('reads a realistic Moodle export', () => {
    const result = parseMoodleXml(fixture('moodle-export.xml'));
    const byName = new Map(result.questions.map((q) => [q.input.name, q]));
    expect(result.questions.map((q) => q.input.type)).toEqual([
      'single',
      'multiple',
      'truefalse',
      'short',
      'numeric',
      'essay',
      'matching',
      'ordering',
      'single',
    ]);
    expect(result.categories.map((c) => c.path)).toEqual([
      ['Default for BIO101'],
      ['Default for BIO101', 'Cells & tissues'],
      ['Default for BIO101', 'Genetics'],
    ]);
    expect(result.categories[1]!.description).toBe('Questions about cells.');
    expect(result.skipped).toBe(3);

    const powerhouse = byName.get('Powerhouse of the cell')!;
    expect(powerhouse.category).toEqual(['Default for BIO101', 'Cells & tissues']);
    expect(powerhouse.input).toMatchObject({
      prompt: 'Which organelle is known as the **powerhouse** of the cell?',
      explanation: 'Mitochondria make most of the cell’s ATP.'.replace('’', "'"),
      points: 2,
      options: [
        { text: 'Mitochondrion', correct: true },
        { text: 'Nucleus', correct: false },
        { text: 'Ribosome', correct: false },
      ],
    });
    const warningsFor = (name: string) => result.warnings.filter((w) => w.number === byName.get(name)!.number).map((w) => w.message);
    expect(warningsFor('Powerhouse of the cell')).toEqual([
      'Feedback for individual answers isn’t supported and was left out.',
      'Images and other embedded files were left out.',
    ]);
    expect(byName.get('Cell parts')!.input.prompt).toBe(
      'Select _all_ the parts found in plant cells:\n\n- think about walls\n- and about light',
    );
    expect(byName.get('Cell parts')!.input.options!.map((o) => o.correct)).toEqual([true, true, false]);
    expect(byName.get('DNA strands')!.input).toMatchObject({
      prompt: 'DNA is made of two strands.\nThey wind around each other.',
      options: [{ correct: true }, { correct: false }],
    });
    expect(byName.get('Base pairs')!.input).toMatchObject({
      prompt: 'Which base pairs with adenine in DNA? (one word, e.g. \\*cytosine\\*)',
      acceptedAnswers: ['Thymine', 'T'],
    });
    expect(warningsFor('Base pairs')).toEqual(
      expect.arrayContaining([expect.stringMatching(/case sensitive/), expect.stringMatching(/less than 100%/)]),
    );
    expect(byName.get('Chromosomes')!.input).toMatchObject({
      prompt: 'How many chromosomes does a typical **human** cell have?',
      acceptedAnswers: ['46'],
      tolerance: 0,
      explanation: '23 pairs.',
    });
    expect(warningsFor('Chromosomes')).toContain('Units were ignored: students enter just the number.');
    expect(byName.get('Evolution essay')!.input).toMatchObject({
      prompt: '### Natural selection\n\nExplain natural selection in your own words.',
      points: 10,
      minWords: 100,
      maxWords: 400,
      graderNotes: 'Look for **variation**, inheritance and selection.',
    });
    expect(byName.get('Match the scientists')!.input).toMatchObject({
      pairs: [
        { text: 'Mendel', answer: 'Inheritance' },
        { text: 'Darwin', answer: 'Natural selection' },
        { text: 'Franklin', answer: 'DNA structure' },
      ],
      distractors: ['Germ theory'],
    });
    expect(byName.get('Mitosis phases')!.input.options!.map((o) => o.text)).toEqual(['Prophase', 'Metaphase', 'Anaphase', 'Telophase']);
    expect(warningsFor('Mitosis phases')[0]).toMatch(/neighbouring items/);
    expect(result.warnings.filter((w) => /support/.test(w.message) && /skipped/.test(w.message)).map((w) => w.message)).toEqual([
      '“Reading” is a description (text without a question), which Coursekit doesn’t support. It was skipped.',
      '“Cloze” is an embedded answers (Cloze) question, which Coursekit doesn’t support. It was skipped.',
      '“Growth rate” is a calculated question, which Coursekit doesn’t support. It was skipped.',
    ]);
    // A question with no right answer is read, and fails validation when imported.
    expect(questionInputSchema.safeParse(byName.get('Broken choice')!.input).success).toBe(false);
  });

  it('rejects files that are not Moodle XML', () => {
    expect(() => parseMoodleXml('<quiz><question type="truefalse">')).toThrow(/valid XML/);
    expect(() => parseMoodleXml('<html><body/></html>')).toThrow(/start with <quiz>/);
    expect(() => parseMoodleXml('<!DOCTYPE quiz [<!ENTITY a "aaaa">]><quiz>&a;</quiz>')).toThrow(/DOCTYPE/);
  });
});

describe('HTML and text conversion', () => {
  it('turns HTML into Markdown', () => {
    expect(htmlToMarkdown('<p>One<br>Two</p><p>Three &amp; <a href="https://example.com/a b">link</a></p>')).toBe(
      'One\nTwo\n\nThree & [link](https://example.com/a%20b)',
    );
    expect(htmlToMarkdown('<ol start="3"><li>a</li><li>b<ul><li>c</li></ul></li></ol>')).toBe('3. a\n4. b\n   - c');
    expect(htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x|y</td></tr></table>')).toBe(
      '| A | B |\n| --- | --- |\n| 1 | x\\|y |',
    );
    expect(htmlToMarkdown('<pre><code>if (a &lt; b) {\n  go();\n}</code></pre>')).toBe('```\nif (a < b) {\n  go();\n}\n```');
    expect(htmlToMarkdown('H<sub>2</sub>O and E = mc<sup>2</sup> <script>alert(1)</script><style>p{}</style>')).toBe(
      'H<sub>2</sub>O and E = mc<sup>2</sup>',
    );
    expect(htmlToMarkdown('<p>Use <code>a`b</code> and <i> spaced </i> text</p>')).toBe('Use `` a`b `` and _spaced_ text');
    expect(htmlToMarkdown('<p># not a heading</p><p>1. not a list</p>')).toBe('\\# not a heading\n\n1\\. not a list');
    expect(htmlToMarkdown('<blockquote><p>Quote</p></blockquote><hr><h2>Title</h2>')).toBe('> Quote\n\n---\n\n## Title');
  });

  it('stays fast on hostile input', () => {
    const start = Date.now();
    const result = parseGift(
      [
        `[html]${'<a "'.repeat(50_000)}{T}`,
        `[moodle]${'<b'.repeat(50_000)}{T}`,
        `[markdown]${'![x](@@PLUGINFILE@@'.repeat(20_000)}{T}`,
        `[html]${'<!x'.repeat(50_000)}{T}`,
      ].join('\n\n'),
    );
    expect(result.questions).toHaveLength(4);
    htmlToMarkdown(`<b>a${'<br>'.repeat(50_000)}b</b>`);
    htmlToMarkdown('<div><span>'.repeat(50_000));
    parseMoodleXml(
      `<quiz><question type="essay"><name><text></text></name><questiontext format="markdown"><text>${'[['.repeat(100_000)}</text></questiontext></question></quiz>`,
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('escapes plain text so it shows as written', () => {
    expect(escapeMarkdown('2 * 3 = 6, snake_case, _emph_, [x](y), <b>, ~~s~~, &amp;')).toBe(
      '2 \\* 3 = 6, snake_case, \\_emph\\_, \\[x\\](y), \\<b>, \\~\\~s\\~\\~, \\&amp;',
    );
    expect(escapeMarkdown('- item\n> quote\n# head\n10. ten\n___ blank')).toBe('\\- item\n\\> quote\n\\# head\n10\\. ten\n___ blank');
    expect(toMarkdown('Fish &amp; chips', 'moodle_auto_format')).toBe('Fish & chips');
    expect(toMarkdown('Fish &amp; chips', 'plain_text')).toBe('Fish \\&amp; chips');
  });
});

// ---------------------------------------------------------------------------------------------------- round trips

const SAMPLES: ImportedQuestionInput[] = [
  {
    type: 'single',
    name: 'Capital',
    prompt: 'What is the capital of **France**?\n\nPick one: a {brace}, a ~tilde~, a #hash, a = sign and a colon: here',
    points: 2,
    explanation: 'Paris, since 987.\n\n- See also: [Paris](https://en.wikipedia.org/wiki/Paris)',
    options: [
      { text: 'Paris', correct: true },
      { text: 'Lyon ]]> <b>', correct: false },
      { text: 'C:\\path\\new', correct: false },
    ],
  },
  {
    type: 'multiple',
    name: '',
    prompt: 'Which are prime?',
    points: 3,
    explanation: null,
    options: [
      { text: '2', correct: true },
      { text: '3', correct: true },
      { text: '4', correct: false },
      { text: '5', correct: true },
    ],
  },
  {
    type: 'truefalse',
    name: 'Sky',
    prompt: 'The sky is green.',
    points: 1,
    explanation: null,
    options: [
      { text: 'True', correct: false },
      { text: 'False', correct: true },
    ],
  },
  { type: 'short', name: 'Plural', prompt: 'Plural of mouse?', points: 1, explanation: null, acceptedAnswers: ['mice', 'mi*e', 'a=b'] },
  {
    type: 'numeric',
    name: 'Pi',
    prompt: 'Pi to two decimals?',
    points: 1.5,
    explanation: 'About 3.14',
    acceptedAnswers: ['3.14', '-3.14'],
    tolerance: 0.005,
  },
  {
    type: 'essay',
    name: 'Essay',
    prompt: '## Your summer\n\nWrite about it.',
    points: 10,
    explanation: null,
    minWords: 50,
    maxWords: 300,
    graderNotes: 'Look for **structure**.',
  },
  {
    type: 'matching',
    name: 'Animals',
    prompt: 'Match the animals.',
    points: 3,
    explanation: null,
    pairs: [
      { text: 'Cat', answer: 'Meow' },
      { text: 'Dog', answer: 'Woof' },
    ],
    distractors: ['Moo', 'Quack'],
  },
  {
    type: 'ordering',
    name: 'Order',
    prompt: 'Order the numbers.',
    points: 2,
    explanation: null,
    options: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }],
  },
];

/** A question as the bank stores it, without ids (they're new on every import). */
function stored(input: ImportedQuestionInput) {
  const row = storedQuestion(questionInputSchema.parse(input));
  return {
    ...row,
    options: JSON.parse(row.options).map(({ id: _id, ...o }: { id: string }) => o),
    acceptedAnswers: JSON.parse(row.acceptedAnswers),
    settings: JSON.parse(row.settings),
  };
}

function exportItems(inputs: ImportedQuestionInput[]): ExportItem[] {
  return inputs.map((input, i) => {
    const row = storedQuestion(questionInputSchema.parse(input));
    return {
      id: `q${i}`,
      type: row.type,
      name: row.name,
      prompt: row.prompt,
      points: row.points,
      options: JSON.parse(row.options),
      acceptedAnswers: JSON.parse(row.acceptedAnswers),
      tolerance: row.tolerance,
      explanation: row.explanation,
      settings: JSON.parse(row.settings),
      category: i < 4 ? ['Top', 'Sub/with slash'] : ['Other'],
      categoryDescription: i < 4 ? 'First half' : '',
    };
  });
}

describe('round trips', () => {
  it('keeps every question type through Moodle XML', () => {
    const xml = exportMoodleXml(exportItems(SAMPLES));
    // Well-formed, and "]]>" inside a text is split across CDATA sections.
    expect(new DOMParser().parseFromString(xml, 'text/xml').documentElement!.nodeName).toBe('quiz');
    expect(xml).toContain(']]]]><![CDATA[>');
    // Characters XML can't hold are dropped; tabs, newlines and astral characters stay.
    const odd = exportMoodleXml(
      exportItems([{ ...SAMPLES[3]!, prompt: `Bell${String.fromCharCode(7)} tab\t😀 lone${String.fromCharCode(0xd800)}.` }]),
    );
    expect(parseMoodleXml(odd).questions[0]!.input.prompt).toBe('Bell tab\t😀 lone.');
    const back = parseMoodleXml(xml);
    expect(back.errors).toEqual([]);
    expect(back.warnings).toEqual([]);
    expect(back.questions.map((q) => stored(q.input))).toEqual(SAMPLES.map(stored));
    expect(back.questions.map((q) => q.category)).toEqual([...Array(4).fill(['Top', 'Sub/with slash']), ...Array(4).fill(['Other'])]);
    expect(back.categories[0]).toEqual({ path: ['Top', 'Sub/with slash'], description: 'First half' });
  });

  it('keeps every GIFT question type through GIFT (marks and essay settings aside), and skips ordering', () => {
    const items = exportItems(SAMPLES);
    const { content, skipped, notes } = exportGift(items);
    expect(skipped).toEqual([{ id: 'q7', reason: 'GIFT can’t hold ordering questions.' }]);
    expect(notes).toHaveLength(2);
    const back = parseGift(content);
    expect(back.errors).toEqual([]);
    expect(back.warnings).toEqual([]);
    const giftable = SAMPLES.filter((s) => s.type !== 'ordering').map((s) =>
      stored({ ...s, points: 1, ...(s.type === 'essay' ? { minWords: null, maxWords: null, graderNotes: null } : {}) }),
    );
    expect(back.questions.map((q) => stored(q.input))).toEqual(giftable);
    expect(back.questions[0]!.category).toEqual(['Top', 'Sub/with slash']);
  });

  it('round-trips the example GIFT file through both formats', () => {
    const first = parseGift(fixture('example.gift')).questions.map((q) => q.input);
    const items = exportItems(first);
    expect(parseGift(exportGift(items).content).questions.map((q) => stored(q.input))).toEqual(first.map(stored));
    expect(parseMoodleXml(exportMoodleXml(items)).questions.map((q) => stored(q.input))).toEqual(first.map(stored));
  });
});

describe('unusual files', () => {
  it('refuses category paths deeper than 50 levels, quickly', () => {
    const deep = (n: number) => `$CATEGORY: $course$/top/${'a/'.repeat(n)}\n\nQ{=a}`;
    expect(parseGift(deep(50)).questions[0]!.category).toHaveLength(50);
    const start = Date.now();
    expect(() => parseGift(deep(51))).toThrow(/at most 50 levels/);
    expect(() => parseGift(deep(1_000_000))).toThrow(/at most 50 levels/);
    const xml = `<quiz><question type="category"><category><text>$course$/top/${'a/'.repeat(100_000)}</text></category></question></quiz>`;
    expect(() => parseMoodleXml(xml)).toThrow(/at most 50 levels/);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('reads texts with U+2028 and U+2029 line separators', () => {
    expect(toMarkdown('a b c', 'plain_text')).toBe('a b c');
    expect(toMarkdown('<p>a b</p>', 'html')).toContain('a');
    expect(one('Q a b {=a}').acceptedAnswers).toEqual(['a']);
  });

  it('reads Moodle XML whose question texts mention a DOCTYPE, and still refuses real ones', () => {
    const prompt = 'Every HTML5 page should start with `<!DOCTYPE html>`.';
    const xml = exportMoodleXml(exportItems([{ ...SAMPLES[3]!, prompt }, SAMPLES[0]!]));
    expect(xml).toContain('<!DOCTYPE html>');
    const back = parseMoodleXml(xml);
    expect(back.questions.map((q) => q.input.prompt)).toEqual([prompt, SAMPLES[0]!.prompt]);
    expect(() => parseMoodleXml('<?xml version="1.0"?>\n<!-- <quiz> -->\n<!doctype quiz [<!ENTITY a "aa">]><quiz>&a;</quiz>')).toThrow(
      /DOCTYPE/,
    );
  });

  it('leaves out of GIFT the questions GIFT would read back wrongly ("->" in short answers and items to match)', () => {
    const base = { name: '', points: 1, explanation: null };
    const arrows: ImportedQuestionInput = {
      ...base,
      type: 'matching',
      prompt: 'Match the arrows.',
      pairs: [
        { text: 'Right', answer: '->' },
        { text: 'Left', answer: '<-' },
      ],
      distractors: ['<->'],
    };
    const items = exportItems([
      { ...base, type: 'short', prompt: 'Which operator reaches a member through a pointer?', acceptedAnswers: ['->'] },
      {
        ...base,
        type: 'matching',
        prompt: 'Match the connectives.',
        pairs: [
          { text: 'a -> b', answer: 'implication' },
          { text: 'a <-> b', answer: 'equivalence' },
        ],
        distractors: [],
      },
      arrows,
    ]);
    const { content, skipped } = exportGift(items);
    expect(skipped).toEqual([
      { id: 'q0', reason: 'GIFT can’t hold “->” in a short answer.' },
      { id: 'q1', reason: 'GIFT can’t hold “->” in an item to match.' },
    ]);
    const back = parseGift(content);
    expect(back.errors).toEqual([]);
    expect(back.questions.map((q) => stored(q.input))).toEqual([stored(arrows)]);
  });
});
