/**
 * GIFT, Moodle's plain-text question format (https://docs.moodle.org/en/GIFT_format). The reader follows
 * Moodle's own importer (qformat_gift): questions are separated by blank lines, `//` starts a comment line,
 * `\~ \= \# \{ \} \: \\` are escapes and `\n` is a line break.
 */
import { choiceOptions, FULL, numericAnswers } from './convert.js';
import { assembleCategoryPath, categoryFromFile, newNotes, toInlineMarkdown, toMarkdown, type TextFormat, type TextNotes } from './text.js';
import { formatNumber, sharePercent, type ExportItem, type ImportedQuestionInput, type ParseResult } from './types.js';

/** While parsing, escaped characters are swapped for private-use characters (U+E000…U+E007), then restored. */
const ESCAPED = ['\\', ':', '#', '=', '{', '}', '~', 'n'];
const placeholder = (i: number) => String.fromCharCode(0xe000 + i);
const PLACEHOLDERS: Record<string, string> = Object.fromEntries(ESCAPED.map((c, i) => [c, placeholder(i)]));
const RESTORE: Record<string, string> = Object.fromEntries(ESCAPED.map((c, i) => [placeholder(i), c === 'n' ? '\n' : c]));
const ANY_PLACEHOLDER = new RegExp(`[${placeholder(0)}-${placeholder(ESCAPED.length - 1)}]`, 'g');

const protect = (s: string) => s.replace(/\\([\\:#={}~n])/g, (_, c: string) => PLACEHOLDERS[c]!);
const restore = (s: string) => s.replace(ANY_PLACEHOLDER, (c) => RESTORE[c]!);

type GiftFormat = 'moodle' | 'html' | 'markdown' | 'plain';
const TEXT_FORMATS: Record<GiftFormat, TextFormat> = {
  moodle: 'moodle_auto_format',
  html: 'html',
  markdown: 'markdown',
  plain: 'plain_text',
};

/** A `[format]` prefix, or the default; the text comes back unescaped. */
function withFormat(raw: string, fallback: GiftFormat): { format: GiftFormat; text: string } {
  const trimmed = raw.trimStart();
  const m = /^\[(moodle|html|markdown|plain)\]/i.exec(trimmed);
  if (!m) return { format: fallback, text: restore(raw).trim() };
  return { format: m[1]!.toLowerCase() as GiftFormat, text: restore(trimmed.slice(m[0].length)).trim() };
}

/** `%50%` at the start of an answer. */
const WEIGHT = /^%(-?\d+(?:\.\d*)?)%/;

function splitFeedback(answer: string): [string, string | null] {
  const i = answer.indexOf('#');
  return i < 0 ? [answer, null] : [answer.slice(0, i), answer.slice(i + 1)];
}

function splitAnswers(answer: string, separator: string): string[] {
  return answer
    .split(separator)
    .map((s) => s.trim())
    .filter((s, i) => i > 0 || s !== '');
}

interface Ctx {
  warn: (message: string) => void;
  error: (message: string) => void;
  notes: TextNotes;
  feedback: boolean;
}

function readQuestion(source: string, ctx: Ctx): ImportedQuestionInput | null {
  let text = source;
  let name = '';
  if (text.startsWith('::')) {
    const end = text.indexOf('::', 2);
    if (end < 0) {
      ctx.warn('The title isn’t closed with “::”, so it was read as part of the question.');
      text = text.slice(2).trim();
    } else {
      name = restore(text.slice(2, end)).replace(/\s+/g, ' ').trim().slice(0, 200);
      text = text.slice(end + 2).trim();
    }
  }

  const open = text.indexOf('{');
  const firstClose = text.indexOf('}');
  if (open < 0 && firstClose < 0) {
    ctx.warn('This is a description (it has no answers in braces). Coursekit has no description items, so it was skipped.');
    return null;
  }
  if (open < 0 || (firstClose >= 0 && firstClose < open)) {
    ctx.error('There’s a “}” without an opening “{”. Write a brace that is part of the text as \\} .');
    return null;
  }
  if (firstClose < 0) {
    ctx.error('The answers start with “{” but there’s no closing “}”.');
    return null;
  }
  const close = firstClose;
  const nested = text.indexOf('{', open + 1);
  if (nested >= 0 || text.indexOf('}', close + 1) >= 0) {
    ctx.error(
      nested >= 0 && nested < close
        ? 'There’s a “{” inside the answers. Write a brace that is part of the text as \\{ .'
        : 'Only one set of answers in braces is allowed. Write braces that are part of the text as \\{ and \\}.',
    );
    return null;
  }

  let answer = text.slice(open + 1, close).trim();
  const after = text.slice(close + 1);
  // Answers in the middle of the text leave a blank to fill in.
  const promptSource = after.trim() ? `${text.slice(0, open)}_____${after}` : text.slice(0, open);
  let feedbackSource = '';
  const general = answer.lastIndexOf('####');
  if (general >= 0) {
    feedbackSource = answer.slice(general + 4);
    answer = answer.slice(0, general).trim();
  }

  const { format, text: promptText } = withFormat(promptSource, 'moodle');
  const prompt = toMarkdown(promptText, TEXT_FORMATS[format], ctx.notes);
  const feedback = feedbackSource.trim() ? withFormat(feedbackSource, format) : null;
  const base = {
    name,
    prompt,
    points: 1,
    explanation: feedback?.text ? toMarkdown(feedback.text, TEXT_FORMATS[feedback.format], ctx.notes) : null,
  };
  const inline = (raw: string) => {
    const t = withFormat(raw, format);
    return toInlineMarkdown(t.text, TEXT_FORMATS[t.format], ctx.notes);
  };
  const plain = (raw: string) => withFormat(raw, format).text;
  const answerText = (raw: string) => {
    const [value, fb] = splitFeedback(raw);
    if (fb?.trim()) ctx.feedback = true;
    return value;
  };

  if (answer === '') return { ...base, type: 'essay' };

  if (answer.startsWith('#')) {
    let body = answer.slice(1);
    const wrong = body.indexOf('~');
    if (wrong >= 0) {
      if (body.slice(wrong).includes('#')) ctx.feedback = true;
      body = body.slice(0, wrong);
    }
    const parts = splitAnswers(body, '=');
    if (parts.length === 0) {
      ctx.error('A numerical question needs a number after “#”.');
      return null;
    }
    const answers: Array<{ value: number; tolerance: number; fraction: number }> = [];
    for (let part of parts) {
      let fraction = 100;
      const w = WEIGHT.exec(part);
      if (w) {
        fraction = Number(w[1]);
        part = part.slice(w[0].length).trim();
      }
      const value = answerText(part).trim();
      let n: number;
      let tolerance = 0;
      const range = value.indexOf('..');
      const colon = value.indexOf(':');
      if (range > 0) {
        const min = Number(restore(value.slice(0, range)).trim());
        const max = Number(restore(value.slice(range + 2)).trim());
        n = (min + max) / 2;
        tolerance = Math.abs(max - n);
      } else if (colon > 0) {
        n = Number(restore(value.slice(0, colon)).trim());
        tolerance = Number(restore(value.slice(colon + 1)).trim());
      } else {
        n = restore(value).trim() === '' ? Number.NaN : Number(restore(value).trim());
      }
      if (!Number.isFinite(n) || !Number.isFinite(tolerance)) {
        ctx.error(`“${restore(value)}” isn’t a number (use 3.14, 3.14:0.01 or 1..5).`);
        return null;
      }
      answers.push({ value: n, tolerance, fraction });
    }
    const numeric = numericAnswers(answers, ctx.warn);
    if (numeric.acceptedAnswers.length === 0) {
      ctx.error('A numerical question needs at least one answer worth 100%.');
      return null;
    }
    return { ...base, type: 'numeric', ...numeric };
  }

  if (answer.includes('~')) {
    const single = answer.includes('=');
    const answers: Array<{ text: string; fraction: number }> = [];
    for (let part of splitAnswers(answer.replace(/=/g, '~='), '~')) {
      if (!part) continue;
      let fraction = 0;
      if (part.startsWith('=')) {
        fraction = 100;
        part = part.slice(1).trim();
      }
      const w = WEIGHT.exec(part);
      if (w) {
        fraction = Number(w[1]);
        part = part.slice(w[0].length).trim();
      }
      answers.push({ text: inline(answerText(part)), fraction });
    }
    return { ...base, ...choiceOptions(single, answers, ctx.warn) };
  }

  if (answer.includes('=') && answer.includes('->')) {
    const pairs: Array<{ text: string; answer: string }> = [];
    const distractors: string[] = [];
    for (const part of splitAnswers(answer, '=')) {
      const arrow = part.indexOf('->');
      if (arrow < 0) {
        ctx.error('Each matching pair needs “->” between the item and its answer, like =cat -> animal.');
        return null;
      }
      const item = inline(part.slice(0, arrow));
      const match = restore(part.slice(arrow + 2)).trim();
      if (!match) continue;
      if (item) pairs.push({ text: item, answer: match });
      else distractors.push(match);
    }
    return { ...base, type: 'matching', pairs, distractors };
  }

  const check = answer.indexOf('#') > 0 ? answer.slice(0, answer.indexOf('#')).trim() : answer;
  if (['T', 'TRUE', 'F', 'FALSE'].includes(check)) {
    const [, wrongFeedback, rightFeedback] = answer.split('#');
    if (wrongFeedback?.trim() || rightFeedback?.trim()) ctx.feedback = true;
    const correct = check.startsWith('T');
    return {
      ...base,
      type: 'truefalse',
      options: [
        { text: 'True', correct },
        { text: 'False', correct: !correct },
      ],
    };
  }

  const accepted: string[] = [];
  let partial = false;
  for (let part of splitAnswers(answer, '=')) {
    let fraction = 100;
    const w = WEIGHT.exec(part);
    if (w) {
      fraction = Number(w[1]);
      part = part.slice(w[0].length).trim();
    }
    const value = plain(answerText(part));
    if (!value) continue;
    if (fraction >= FULL) accepted.push(value);
    else if (fraction > 0) partial = true;
  }
  if (partial) ctx.warn('Answers worth less than 100% aren’t supported and were left out.');
  if (accepted.length === 0) {
    ctx.error('A short-answer question needs at least one answer worth 100%.');
    return null;
  }
  return { ...base, type: 'short', acceptedAnswers: [...new Set(accepted)] };
}

export function parseGift(source: string): ParseResult {
  const result: ParseResult = { format: 'gift', questions: [], categories: [], skipped: 0, warnings: [], errors: [] };
  const lines = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source)
    .replace(ANY_PLACEHOLDER, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks: Array<{ line: number; text: string }> = [];
  let current: string[] = [];
  let start = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      if (current.length) blocks.push({ line: start, text: current.join('\n') });
      current = [];
      return;
    }
    if (line.startsWith('//')) return;
    if (!current.length) start = i + 1;
    current.push(line);
  });
  if (current.length) blocks.push({ line: start, text: current.join('\n') });

  let category: string[] = [];
  let number = 0;
  for (const block of blocks) {
    let text = protect(block.text);
    let line = block.line;
    const cat = /^\$CATEGORY:([^\n]*)(?:\n([\s\S]*))?$/i.exec(text);
    if (cat) {
      category = categoryFromFile(restore(cat[1]!));
      if (category.length) result.categories.push({ path: category, description: '' });
      if (!cat[2]?.trim()) continue;
      text = cat[2].trim();
      line += 1;
    }
    number += 1;
    const n = number;
    const ctx: Ctx = {
      warn: (message) => result.warnings.push({ number: n, line, message }),
      error: (message) => result.errors.push({ number: n, line, message }),
      notes: newNotes(),
      feedback: false,
    };
    const input = readQuestion(text, ctx);
    if (ctx.feedback) ctx.warn('Feedback for individual answers isn’t supported and was left out.');
    if (ctx.notes.droppedFiles) ctx.warn('Images and other embedded files were left out.');
    if (input) result.questions.push({ number: n, line, category, input });
    else result.skipped += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------- export

/** Escapes GIFT's special characters; line breaks become `\n` (a blank line would end the question). */
function esc(text: string): string {
  return text.replace(/[\\~=#{}:]/g, '\\$&').replace(/\r\n?|\n/g, '\\n');
}

/** The answer block, or why the question can't be written as GIFT. */
function answers(item: ExportItem): string | { reason: string } {
  const lines: string[] = [];
  switch (item.type) {
    case 'single':
      for (const o of item.options) lines.push(`${o.correct ? '=' : '~'}${esc(o.text)}`);
      break;
    case 'multiple': {
      const share = sharePercent(item.options.filter((o) => o.correct).length);
      for (const o of item.options) lines.push(`~%${formatNumber(o.correct ? share : -share)}%${esc(o.text)}`);
      break;
    }
    case 'truefalse': {
      const t = item.options.find((o) => /^true$/i.test(o.text.trim()));
      return (t ? !!t.correct : !!item.options[0]?.correct) ? 'TRUE' : 'FALSE';
    }
    case 'short':
      // GIFT has no escape for "->": an answer with one would read back as a matching question.
      if (item.acceptedAnswers.some((a) => a.includes('->'))) return { reason: 'GIFT can’t hold “->” in a short answer.' };
      for (const a of item.acceptedAnswers) lines.push(`=${esc(a)}`);
      break;
    case 'numeric': {
      const tol = item.tolerance ?? 0;
      const one = (a: string) => `${esc(a)}${tol > 0 ? `:${formatNumber(tol)}` : ''}`;
      if (item.acceptedAnswers.length === 1) return `#${one(item.acceptedAnswers[0]!)}`;
      lines.push('#');
      for (const a of item.acceptedAnswers) lines.push(`=${one(a)}`);
      break;
    }
    case 'matching':
      // Items are split from their answers at the first "->".
      if (item.options.some((p) => p.text.includes('->'))) return { reason: 'GIFT can’t hold “->” in an item to match.' };
      for (const p of item.options) lines.push(`=${esc(p.text)} -> ${esc(p.answer ?? '')}`);
      for (const d of item.settings.distractors ?? []) lines.push(`= -> ${esc(d)}`);
      break;
    case 'essay':
      break;
    default:
      return { reason: 'GIFT can’t hold ordering questions.' };
  }
  return lines.join('\n\t');
}

export function exportGift(items: ExportItem[]): {
  content: string;
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
} {
  const out: string[] = [`// ${items.length} question${items.length === 1 ? '' : 's'} exported from Coursekit`, ''];
  const skipped: Array<{ id: string; reason: string }> = [];
  const notes = new Set<string>();
  let category: string | null = null;
  for (const item of items) {
    const body = answers(item);
    if (typeof body !== 'string') {
      skipped.push({ id: item.id, reason: body.reason });
      continue;
    }
    const path = assembleCategoryPath(item.category);
    if (item.category.length && path !== category) {
      out.push(`$CATEGORY: $course$/top/${path}`, '');
      category = path;
    }
    if (item.points !== 1) notes.add('GIFT has no marks, so every question gets 1 mark when it is imported.');
    if (item.type === 'essay' && (item.settings.minWords || item.settings.maxWords || item.settings.graderNotes)) {
      notes.add('Word limits and grader information for essay questions aren’t part of GIFT and were left out.');
    }
    const title = item.name.trim() ? `::${esc(item.name.trim())}::` : '';
    const feedback = item.explanation?.trim() ? `####${esc(item.explanation.trim())}` : '';
    const inner = [body, feedback].filter(Boolean);
    const block =
      inner.length === 0 ? '{}' : inner.length === 1 && !body.includes('\n') ? `{${inner[0]}}` : `{\n\t${inner.join('\n\t')}\n}`;
    out.push(`${title}[markdown]${esc(item.prompt.trim())}${block}`, '');
  }
  return { content: `${out.join('\n').trimEnd()}\n`, skipped, notes: [...notes] };
}
