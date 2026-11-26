/**
 * Moodle XML (https://docs.moodle.org/en/Moodle_XML_format), read with @xmldom/xmldom and written as text.
 * Files written here import into Moodle 4.x and 5.x, and back into Coursekit unchanged: texts are written in
 * Moodle's `markdown` format, which is what Coursekit stores.
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { QuestionType } from '../../../shared/types.js';
import { badRequest } from '../../lib/http.js';
import { choiceOptions, FULL, numericAnswers } from './convert.js';
import {
  assembleCategoryPath,
  categoryFromFile,
  defaultQuestionName,
  htmlToPlain,
  stripInvalidXml,
  newNotes,
  toInlineMarkdown,
  toMarkdown,
  type TextFormat,
  type TextNotes,
} from './text.js';
import { formatNumber, sharePercent, type ExportItem, type ImportedQuestionInput, type ParseResult } from './types.js';

const FORMATS = new Set<TextFormat>(['html', 'moodle_auto_format', 'markdown', 'plain_text']);

const UNSUPPORTED: Record<string, string> = {
  description: 'a description (text without a question)',
  multianswer: 'an embedded answers (Cloze) question',
  cloze: 'an embedded answers (Cloze) question',
  calculated: 'a calculated question',
  calculatedsimple: 'a simple calculated question',
  calculatedmulti: 'a calculated multichoice question',
  ddwtos: 'a drag and drop into text question',
  ddimageortext: 'a drag and drop onto image question',
  ddmarker: 'a drag and drop markers question',
  gapselect: 'a select missing words question',
  randomsamatch: 'a random short-answer matching question',
  random: 'a random question placeholder',
};

function elements(parent: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) out.push(n as Element);
  return out;
}

const child = (parent: Element | undefined, name: string): Element | undefined => (parent ? elements(parent, name)[0] : undefined);
const value = (parent: Element | undefined, name: string): string => child(parent, name)?.textContent?.trim() ?? '';
const textOf = (el: Element | undefined): string => child(el, 'text')?.textContent ?? '';

function formatOf(el: Element | undefined, fallback: TextFormat): TextFormat {
  const f = el?.getAttribute('format') as TextFormat | null;
  return f && FORMATS.has(f) ? f : fallback;
}

/** A text element (`<questiontext format="html"><text>…</text><file …/></questiontext>`) as Markdown. */
function markdownOf(el: Element | undefined, fallback: TextFormat, notes: TextNotes, inline = false): string {
  if (!el) return '';
  if (elements(el, 'file').length) notes.droppedFiles = true;
  const convert = inline ? toInlineMarkdown : toMarkdown;
  return convert(textOf(el), formatOf(el, fallback), notes);
}

function parseNumber(text: string, fallback: number): number {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() && Number.isFinite(n) ? n : fallback;
}

export function parseMoodleXml(source: string): ParseResult {
  const result: ParseResult = { format: 'moodle', questions: [], categories: [], skipped: 0, warnings: [], errors: [] };
  const xml = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  // A DOCTYPE (with any entity declarations) can only come in the prolog, after the XML declaration and
  // comments; question texts may mention one, like `<!DOCTYPE html>` in a web development question.
  const prolog = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/.exec(xml)![0];
  if (/^<!(DOCTYPE|ENTITY)/i.test(xml.slice(prolog.length)))
    throw badRequest('This XML file has a DOCTYPE, which Moodle XML files never have. Export the questions again.');
  let root: Element | null;
  try {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
    root = doc.documentElement;
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : '';
    throw badRequest(`This isn’t a valid XML file${detail ? ` (${detail})` : ''}.`);
  }
  if (!root || root.nodeName !== 'quiz') throw badRequest('This isn’t a Moodle XML question file: it should start with <quiz>.');

  let category: string[] = [];
  let number = 0;
  for (const q of elements(root, 'question')) {
    const type = (q.getAttribute('type') ?? '').trim().toLowerCase();
    if (type === 'category') {
      category = categoryFromFile(textOf(child(q, 'category')));
      const info = child(q, 'info');
      const description = info ? (formatOf(info, 'moodle_auto_format') === 'html' ? htmlToPlain(textOf(info)) : textOf(info).trim()) : '';
      if (category.length) result.categories.push({ path: category, description: description.slice(0, 1000) });
      continue;
    }
    number += 1;
    const line = (q as unknown as { lineNumber?: number }).lineNumber ?? null;
    const n = number;
    const warn = (message: string) => result.warnings.push({ number: n, line, message });
    const error = (message: string) => result.errors.push({ number: n, line, message });
    const notes = newNotes();
    let feedback = false;
    const label = value(child(q, 'name'), 'text');

    if (UNSUPPORTED[type] || !type) {
      warn(
        `${label ? `“${label}” is` : 'This is'} ${UNSUPPORTED[type] ?? 'a question without a type'}, which Coursekit doesn’t support. It was skipped.`,
      );
      result.skipped += 1;
      continue;
    }
    const prompt = markdownOf(child(q, 'questiontext'), 'moodle_auto_format', notes);
    const explanation = markdownOf(child(q, 'generalfeedback'), 'moodle_auto_format', notes) || null;
    const base = {
      name: label === defaultQuestionName(prompt) ? '' : label.slice(0, 200),
      prompt,
      explanation,
      points: parseNumber(value(q, 'defaultgrade'), 1),
    };
    const answerEls = elements(q, 'answer');
    const noteFeedback = (a: Element) => {
      if (textOf(child(a, 'feedback')).trim()) feedback = true;
    };
    const fraction = (a: Element) => parseNumber(a.getAttribute('fraction') ?? '0', 0);
    let input: ImportedQuestionInput | null = null;

    switch (type) {
      case 'multichoice': {
        const single = !/^(false|0)$/i.test(value(q, 'single') || 'true');
        const answers = answerEls.map((a) => {
          noteFeedback(a);
          return { text: markdownOf(a, 'html', notes, true), fraction: fraction(a) };
        });
        input = { ...base, ...choiceOptions(single, answers, warn) };
        break;
      }
      case 'truefalse': {
        let correct: boolean | null = null;
        answerEls.forEach((a, i) => {
          noteFeedback(a);
          const t = textOf(a).trim().toLowerCase();
          const isTrue = t === 'true' || (t !== 'false' && i === 0);
          if (fraction(a) >= FULL) correct = isTrue;
        });
        if (correct === null) {
          error('A true/false question needs one answer worth 100%.');
          break;
        }
        input = {
          ...base,
          type: 'truefalse',
          options: [
            { text: 'True', correct },
            { text: 'False', correct: !correct },
          ],
        };
        break;
      }
      case 'shortanswer': {
        if (value(q, 'usecase') === '1') warn('Answers were case sensitive. Coursekit checks short answers without regard to case.');
        const accepted: string[] = [];
        let partial = false;
        for (const a of answerEls) {
          noteFeedback(a);
          const text = textOf(a).trim();
          const f = fraction(a);
          if (!text) continue;
          if (f >= FULL) accepted.push(text);
          else if (f > 0) partial = true;
        }
        if (partial) warn('Answers worth less than 100% aren’t supported and were left out.');
        if (accepted.length === 0) {
          error('A short-answer question needs at least one answer worth 100%.');
          break;
        }
        input = { ...base, type: 'short', acceptedAnswers: [...new Set(accepted)] };
        break;
      }
      case 'numerical': {
        if (elements(child(q, 'units') ?? q, 'unit').length) warn('Units were ignored: students enter just the number.');
        const answers: Array<{ value: number; tolerance: number; fraction: number }> = [];
        let invalid = '';
        for (const a of answerEls) {
          noteFeedback(a);
          const text = textOf(a).trim();
          if (text === '*' || text === '') continue;
          const n = parseNumber(text, Number.NaN);
          if (!Number.isFinite(n)) {
            invalid = text;
            continue;
          }
          answers.push({ value: n, tolerance: parseNumber(value(a, 'tolerance'), 0), fraction: fraction(a) });
        }
        if (invalid && answers.length === 0) {
          error(`“${invalid}” isn’t a number.`);
          break;
        }
        const numeric = numericAnswers(answers, warn);
        if (numeric.acceptedAnswers.length === 0) {
          error('A numerical question needs at least one answer worth 100%.');
          break;
        }
        input = { ...base, type: 'numeric', ...numeric };
        break;
      }
      case 'essay': {
        const words = (name: string) => {
          const n = parseNumber(value(q, name), 0);
          return n >= 1 ? Math.round(n) : null;
        };
        if (value(q, 'responseformat') === 'noinline' || parseNumber(value(q, 'attachments'), 0) !== 0) {
          warn('File attachments aren’t supported: students answer in text.');
        }
        if (textOf(child(q, 'responsetemplate')).trim()) warn('The response template was left out.');
        input = {
          ...base,
          type: 'essay',
          minWords: words('minwordlimit'),
          maxWords: words('maxwordlimit'),
          graderNotes: markdownOf(child(q, 'graderinfo'), 'html', notes) || null,
        };
        break;
      }
      case 'matching':
      case 'match': {
        const pairs: Array<{ text: string; answer: string }> = [];
        const distractors: string[] = [];
        for (const sub of elements(q, 'subquestion')) {
          const text = markdownOf(sub, 'html', notes, true);
          const answer = textOf(child(sub, 'answer')).trim();
          if (!answer) continue;
          if (text) pairs.push({ text, answer });
          else distractors.push(answer);
        }
        input = { ...base, type: 'matching', pairs, distractors };
        break;
      }
      case 'ordering': {
        const grading = value(q, 'gradingtype').toUpperCase();
        if (grading && grading !== 'RELATIVE_NEXT_EXCLUDE_LAST' && grading !== '1') {
          warn('Coursekit gives partial credit for each pair of neighbouring items in the right order.');
        }
        const select = value(q, 'selecttype').toUpperCase();
        if (select && select !== 'ALL' && select !== '0') warn('All the items are used: Coursekit doesn’t pick a subset.');
        const items = answerEls
          .map((a, i) => ({
            text: markdownOf(a, 'moodle_auto_format', notes, true),
            position: parseNumber(a.getAttribute('fraction') ?? '', i),
            i,
          }))
          .sort((a, b) => a.position - b.position || a.i - b.i);
        input = { ...base, type: 'ordering', options: items.map((item) => ({ text: item.text })) };
        break;
      }
      default:
        warn(`${label ? `“${label}” is` : 'This is'} a “${type}” question, which Coursekit doesn’t support. It was skipped.`);
    }
    if (feedback) warn('Feedback for individual answers isn’t supported and was left out.');
    if (notes.droppedFiles) warn('Images and other embedded files were left out.');
    if (input) result.questions.push({ number: n, line, category, input });
    else result.skipped += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------- export

/** Character data: CDATA when the text has markup characters ("]]>" is split across two sections). */
function cdata(text: string): string {
  const clean = stripInvalidXml(text);
  if (!/[<>&]/.test(clean)) return clean;
  return `<![CDATA[${clean.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

const attr = (text: string) =>
  stripInvalidXml(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function textElement(tag: string, text: string, format: TextFormat | null, indent: string, extra = ''): string {
  return `${indent}<${tag}${format ? ` format="${format}"` : ''}>\n${indent}  <text>${cdata(text)}</text>${extra}\n${indent}</${tag}>`;
}

const EMPTY_FEEDBACK = (indent: string) => textElement('feedback', '', 'html', indent);

function combinedFeedback(indent: string): string[] {
  return ['correctfeedback', 'partiallycorrectfeedback', 'incorrectfeedback'].map((tag) => textElement(tag, '', 'html', indent));
}

function answer(fractionPercent: number, text: string, format: TextFormat, extra: string[] = []): string {
  const i = '    ';
  return [
    `${i}<answer fraction="${formatNumber(fractionPercent)}" format="${format}">`,
    `${i}  <text>${cdata(text)}</text>`,
    EMPTY_FEEDBACK(`${i}  `),
    ...extra.map((e) => `${i}  ${e}`),
    `${i}</answer>`,
  ].join('\n');
}

const XML_TYPES: Record<QuestionType, string> = {
  single: 'multichoice',
  multiple: 'multichoice',
  truefalse: 'truefalse',
  short: 'shortanswer',
  numeric: 'numerical',
  essay: 'essay',
  matching: 'matching',
  ordering: 'ordering',
};

function questionXml(item: ExportItem): string {
  const i = '    ';
  const lines = [
    `  <question type="${XML_TYPES[item.type]}">`,
    textElement('name', item.name.trim() || defaultQuestionName(item.prompt), null, i),
    textElement('questiontext', item.prompt, 'markdown', i),
    textElement('generalfeedback', item.explanation ?? '', 'markdown', i),
    `${i}<defaultgrade>${formatNumber(item.points)}</defaultgrade>`,
    `${i}<penalty>${item.type === 'essay' ? '0' : '0.3333333'}</penalty>`,
    `${i}<hidden>0</hidden>`,
    `${i}<idnumber></idnumber>`,
  ];
  switch (item.type) {
    case 'single':
    case 'multiple': {
      const single = item.type === 'single';
      const share = sharePercent(item.options.filter((o) => o.correct).length);
      lines.push(
        `${i}<single>${single ? 'true' : 'false'}</single>`,
        `${i}<shuffleanswers>true</shuffleanswers>`,
        `${i}<answernumbering>abc</answernumbering>`,
        `${i}<showstandardinstruction>0</showstandardinstruction>`,
        ...combinedFeedback(i),
        `${i}<shownumcorrect/>`,
        ...item.options.map((o) => answer(single ? (o.correct ? 100 : 0) : o.correct ? share : -share, o.text, 'markdown')),
      );
      break;
    }
    case 'truefalse': {
      const t = item.options.find((o) => /^true$/i.test(o.text.trim()));
      const isTrue = t ? !!t.correct : !!item.options[0]?.correct;
      lines.push(answer(isTrue ? 100 : 0, 'true', 'moodle_auto_format'), answer(isTrue ? 0 : 100, 'false', 'moodle_auto_format'));
      break;
    }
    case 'short':
      lines.push(`${i}<usecase>0</usecase>`, ...item.acceptedAnswers.map((a) => answer(100, a, 'moodle_auto_format')));
      break;
    case 'numeric':
      lines.push(
        ...item.acceptedAnswers.map((a) =>
          answer(100, a, 'moodle_auto_format', [`<tolerance>${formatNumber(item.tolerance ?? 0)}</tolerance>`]),
        ),
        `${i}<unitgradingtype>0</unitgradingtype>`,
        `${i}<unitpenalty>0.1000000</unitpenalty>`,
        `${i}<showunits>3</showunits>`,
        `${i}<unitsleft>0</unitsleft>`,
      );
      break;
    case 'essay':
      lines.push(
        `${i}<responseformat>editor</responseformat>`,
        `${i}<responserequired>1</responserequired>`,
        `${i}<responsefieldlines>10</responsefieldlines>`,
        `${i}<minwordlimit>${item.settings.minWords ?? ''}</minwordlimit>`,
        `${i}<maxwordlimit>${item.settings.maxWords ?? ''}</maxwordlimit>`,
        `${i}<attachments>0</attachments>`,
        `${i}<attachmentsrequired>0</attachmentsrequired>`,
        `${i}<maxbytes>0</maxbytes>`,
        `${i}<filetypeslist></filetypeslist>`,
        textElement('graderinfo', item.settings.graderNotes ?? '', 'markdown', i),
        textElement('responsetemplate', '', 'html', i),
      );
      break;
    case 'matching':
      lines.push(
        `${i}<shuffleanswers>true</shuffleanswers>`,
        ...combinedFeedback(i),
        `${i}<shownumcorrect/>`,
        ...item.options.map((p) =>
          textElement(
            'subquestion',
            p.text,
            'markdown',
            i,
            `\n${i}  <answer>\n${i}    <text>${cdata(p.answer ?? '')}</text>\n${i}  </answer>`,
          ),
        ),
        ...(item.settings.distractors ?? []).map((d) =>
          textElement('subquestion', '', 'markdown', i, `\n${i}  <answer>\n${i}    <text>${cdata(d)}</text>\n${i}  </answer>`),
        ),
      );
      break;
    case 'ordering':
      lines.push(
        `${i}<layouttype>VERTICAL</layouttype>`,
        `${i}<selecttype>ALL</selecttype>`,
        `${i}<selectcount>0</selectcount>`,
        `${i}<gradingtype>RELATIVE_NEXT_EXCLUDE_LAST</gradingtype>`,
        `${i}<showgrading>SHOW</showgrading>`,
        `${i}<numberingstyle>none</numberingstyle>`,
        ...combinedFeedback(i),
        `${i}<shownumcorrect/>`,
        ...item.options.map(
          (o, n) => `${i}<answer fraction="${n + 1}" format="markdown">\n${i}  <text>${cdata(o.text)}</text>\n${i}</answer>`,
        ),
      );
      break;
  }
  lines.push('  </question>');
  return lines.join('\n');
}

function categoryXml(path: string[], description: string): string {
  const i = '    ';
  return [
    '  <question type="category">',
    `${i}<category>\n${i}  <text>${cdata(`$course$/top/${assembleCategoryPath(path)}`)}</text>\n${i}</category>`,
    textElement('info', description, 'moodle_auto_format', i),
    `${i}<idnumber></idnumber>`,
    '  </question>',
  ].join('\n');
}

export function exportMoodleXml(items: ExportItem[]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<quiz>'];
  let category: string | null = null;
  for (const item of items) {
    const key = JSON.stringify(item.category);
    if (item.category.length && key !== category) {
      out.push(categoryXml(item.category, item.categoryDescription), '');
      category = key;
    }
    out.push(questionXml(item), '');
  }
  out.push('</quiz>', '');
  return out.join('\n');
}
