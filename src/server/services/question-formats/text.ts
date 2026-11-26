/**
 * Text conversions for question import and export. Coursekit prompts are Markdown (rendered with marked,
 * GFM and line breaks, then sanitised with DOMPurify in the browser). Moodle texts come as HTML, Moodle
 * auto-format (HTML allowed, newlines are line breaks), Markdown or plain text, and are converted here.
 */
import { badRequest } from '../../lib/http.js';

export type TextFormat = 'html' | 'moodle_auto_format' | 'markdown' | 'plain_text';

/** What a conversion had to leave out. */
export interface TextNotes {
  /** Images, embedded media or attached files (e.g. `@@PLUGINFILE@@` references). */
  droppedFiles: boolean;
}

export function newNotes(): TextNotes {
  return { droppedFiles: false };
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
  ensp: String.fromCharCode(0x2002),
  emsp: String.fromCharCode(0x2003),
  thinsp: String.fromCharCode(0x2009),
  shy: String.fromCharCode(0xad),
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  micro: 'µ',
  para: '¶',
  sect: '§',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  curren: '¤',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  iexcl: '¡',
  iquest: '¿',
  ordf: 'ª',
  ordm: 'º',
  not: '¬',
  macr: '¯',
  acute: '´',
  cedil: '¸',
  uml: '¨',
  szlig: 'ß',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  lArr: '⇐',
  rArr: '⇒',
  hArr: '⇔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  equiv: '≡',
  infin: '∞',
  minus: '−',
  radic: '√',
  sum: '∑',
  prod: '∏',
  int: '∫',
  part: '∂',
  nabla: '∇',
  isin: '∈',
  notin: '∉',
  sub: '⊂',
  sup: '⊃',
  cap: '∩',
  cup: '∪',
  and: '∧',
  or: '∨',
  forall: '∀',
  exist: '∃',
  empty: '∅',
  there4: '∴',
  prop: '∝',
  ang: '∠',
  perp: '⊥',
  sdot: '⋅',
  prime: '′',
  Prime: '″',
  permil: '‰',
  dagger: '†',
  Dagger: '‡',
  loz: '◊',
  hearts: '♥',
};
const GREEK =
  'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega';
GREEK.split(' ').forEach((name, i) => {
  if (name === '_') return;
  NAMED[name] = String.fromCodePoint(0x391 + i);
  NAMED[name.toLowerCase()] = String.fromCodePoint(0x3b1 + i);
});
NAMED.sigmaf = 'ς';
// Latin-1 letters: &Agrave; … &yuml;
const LATIN: Array<[string, number]> = [
  ['Agrave', 0xc0],
  ['Aacute', 0xc1],
  ['Acirc', 0xc2],
  ['Atilde', 0xc3],
  ['Auml', 0xc4],
  ['Aring', 0xc5],
  ['AElig', 0xc6],
  ['Ccedil', 0xc7],
  ['Egrave', 0xc8],
  ['Eacute', 0xc9],
  ['Ecirc', 0xca],
  ['Euml', 0xcb],
  ['Igrave', 0xcc],
  ['Iacute', 0xcd],
  ['Icirc', 0xce],
  ['Iuml', 0xcf],
  ['ETH', 0xd0],
  ['Ntilde', 0xd1],
  ['Ograve', 0xd2],
  ['Oacute', 0xd3],
  ['Ocirc', 0xd4],
  ['Otilde', 0xd5],
  ['Ouml', 0xd6],
  ['Oslash', 0xd8],
  ['Ugrave', 0xd9],
  ['Uacute', 0xda],
  ['Ucirc', 0xdb],
  ['Uuml', 0xdc],
  ['Yacute', 0xdd],
  ['THORN', 0xde],
];
for (const [name, code] of LATIN) {
  NAMED[name] = String.fromCodePoint(code);
  const lower = name === 'ETH' || name === 'THORN' || name === 'AElig' ? name.toLowerCase() : name[0]!.toLowerCase() + name.slice(1);
  NAMED[lower] = String.fromCodePoint(code + 0x20);
}
NAMED.yuml = 'ÿ';

export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity] ?? match;
  });
}

// ---------------------------------------------------------------------------------------------------- Markdown escaping

/** Escapes characters that Markdown would treat as formatting anywhere in a line. */
export function escapeInline(text: string): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[*`[\]~<]/g, '\\$&')
    .replace(/&(?=#?[a-z0-9]+;)/gi, '\\&')
    .replace(/_+/g, (run, offset: number, all: string) => {
      if (run.length >= 3) return run;
      const before = all[offset - 1] ?? '';
      const after = all[offset + run.length] ?? '';
      return /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after) ? run : run.replace(/_/g, '\\_');
    });
}

/** Escapes what Markdown treats as a block marker at the start of a line (headings, quotes, lists, rules). */
export function escapeLineStarts(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // No `.`-based regex: `.` doesn't match U+2028/U+2029, which pasted text can contain.
      const indent = /^\s*/.exec(line)![0];
      const rest = line.slice(indent.length);
      if (/^(#{1,6}(\s|$)|>|[-+](\s|$)|=+\s*$|-{2,}\s*$)/.test(rest)) return `${indent}\\${rest}`;
      const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest);
      if (ordered) return `${indent}${ordered[1]}\\${rest.slice(ordered[1]!.length)}`;
      return line;
    })
    .join('\n');
}

/** Plain text as Markdown that shows exactly that text. Line breaks are kept (prompts render newlines). */
export function escapeMarkdown(text: string): string {
  return escapeLineStarts(escapeInline(text));
}

// ---------------------------------------------------------------------------------------------------- HTML → Markdown

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = string | El;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const MEDIA = new Set(['video', 'audio', 'iframe', 'object', 'embed', 'canvas', 'svg', 'math', 'picture']);
const SKIP = new Set(['head', 'noscript', 'template', 'select', 'button', 'input', 'map', 'source', 'track', 'meta', 'link', 'base']);
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'details',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** A forgiving HTML parser: enough structure for converting question texts, never throws. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  const closeOpen = (tags: string[], stopAt: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const tag = stack[i]!.tag;
      if (tags.includes(tag)) {
        stack.length = i;
        return;
      }
      if (stopAt.includes(tag)) return;
    }
  };
  // Tags never span another "<", which keeps matching linear on any input.
  const re =
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"<>]*"|'[^'<>]*')*)>|<[!?][^<>]*>/g;
  const lower = html.toLowerCase();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) top().children.push(decodeEntities(html.slice(last, m.index)));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      top().children.push(m[1]);
      continue;
    }
    if (!m[3]) continue;
    const tag = m[3].toLowerCase();
    if (m[2]) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    if (BLOCK.has(tag) && top().tag === 'p') stack.pop();
    if (tag === 'li') closeOpen(['li'], ['ul', 'ol']);
    if (tag === 'tr') closeOpen(['tr'], ['table', 'thead', 'tbody', 'tfoot']);
    if (tag === 'td' || tag === 'th') closeOpen(['td', 'th'], ['tr', 'table']);
    if (tag === 'dt' || tag === 'dd') closeOpen(['dt', 'dd'], ['dl']);
    const el: El = { tag, attrs: parseAttrs(m[4] ?? ''), children: [] };
    top().children.push(el);
    if (VOID.has(tag) || /\/\s*$/.test(m[4] ?? '')) continue;
    if (RAW.has(tag)) {
      const end = lower.indexOf(`</${tag}`, last);
      el.children.push(end < 0 ? html.slice(last) : html.slice(last, end));
      const close = end < 0 ? -1 : html.indexOf('>', end);
      last = close < 0 ? html.length : close + 1;
      re.lastIndex = last;
      continue;
    }
    // Deeper nesting is flattened: question texts never need it, and it bounds the converter's recursion.
    if (stack.length < 100) stack.push(el);
  }
  if (last < html.length) top().children.push(decodeEntities(html.slice(last)));
  return root;
}

function textContent(node: Node): string {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  if (RAW.has(node.tag)) return '';
  return node.children.map(textContent).join('');
}

/** `mark` around the text, keeping surrounding spaces outside it (Markdown needs `**bold** text`, not `** bold **`). */
function wrap(inner: string, mark: string): string {
  const text = inner.trim();
  if (!text) return inner;
  const start = inner.length - inner.trimStart().length;
  return `${inner.slice(0, start)}${mark}${text}${mark}${inner.slice(start + text.length)}`;
}

function codeSpan(text: string): string {
  const t = text.replace(/[\t\n\f\r ]+/g, ' ');
  if (!t.trim()) return t;
  if (!t.includes('`')) return `\`${t}\``;
  return `\`\` ${t} \`\``;
}

function safeUrl(url: string): string {
  return url.trim().replace(/[\s()<>]/g, (c) => encodeURIComponent(c));
}

const isFileRef = (url: string) => /@@PLUGINFILE@@|^data:|^blob:|^file:/i.test(url.trim()) || !/^(https?:|mailto:)/i.test(url.trim());

class Converter {
  constructor(private notes: TextNotes) {}

  inline(nodes: Node[]): string {
    return nodes.map((n) => this.inlineNode(n)).join('');
  }

  inlineNode(n: Node): string {
    if (typeof n === 'string') return escapeInline(n.replace(/[\t\n\f\r ]+/g, ' '));
    const { tag, attrs } = n;
    if (MEDIA.has(tag)) {
      this.notes.droppedFiles = true;
      return '';
    }
    if (SKIP.has(tag) || RAW.has(tag)) return '';
    switch (tag) {
      case 'br':
        return '\n';
      case 'strong':
      case 'b':
        return wrap(this.inline(n.children), '**');
      case 'em':
      case 'i':
      case 'cite':
      case 'dfn':
      case 'var':
        return wrap(this.inline(n.children), '_');
      case 's':
      case 'strike':
      case 'del':
        return wrap(this.inline(n.children), '~~');
      case 'code':
      case 'tt':
      case 'kbd':
      case 'samp':
        return codeSpan(textContent(n));
      case 'sub':
      case 'sup': {
        const inner = this.inline(n.children).trim();
        return inner ? `<${tag}>${inner}</${tag}>` : '';
      }
      case 'q':
        return `“${this.inline(n.children)}”`;
      case 'a': {
        const text = this.inline(n.children);
        const href = attrs.href ?? '';
        if (!text.trim()) return text;
        if (/@@PLUGINFILE@@/.test(href)) this.notes.droppedFiles = true;
        return href && !isFileRef(href) ? `[${text.trim()}](${safeUrl(href)})` : text;
      }
      case 'img': {
        const src = attrs.src ?? '';
        if (!src || isFileRef(src)) {
          this.notes.droppedFiles = true;
          return '';
        }
        return `![${escapeInline(attrs.alt ?? '')}](${safeUrl(src)})`;
      }
      default:
        if (BLOCK.has(tag)) return ` ${this.inline(n.children)} `;
        return this.inline(n.children);
    }
  }

  blocks(nodes: Node[]): string[] {
    const out: string[] = [];
    let buffer = '';
    const flush = () => {
      const lines = buffer.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').trim());
      while (lines.length && !lines[0]) lines.shift();
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      const text = escapeLineStarts(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
      if (text) out.push(text);
      buffer = '';
    };
    for (const n of nodes) {
      if (typeof n === 'string' || !BLOCK.has(n.tag)) {
        buffer += this.inlineNode(n);
        continue;
      }
      flush();
      out.push(...this.block(n));
    }
    flush();
    return out;
  }

  block(n: El): string[] {
    const { tag } = n;
    if (/^h[1-6]$/.test(tag)) {
      const text = this.inline(n.children)
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : [];
    }
    switch (tag) {
      case 'ul':
      case 'ol':
        return this.list(n);
      case 'li':
        return this.list({ tag: 'ul', attrs: {}, children: [n] });
      case 'blockquote': {
        const inner = this.blocks(n.children).join('\n\n');
        return inner
          ? [
              inner
                .split('\n')
                .map((l) => (l ? `> ${l}` : '>'))
                .join('\n'),
            ]
          : [];
      }
      case 'pre': {
        const code = textContent(n).replace(/^\n/, '').replace(/\s+$/, '');
        if (!code) return [];
        const fence = code.includes('```') ? '~~~' : '```';
        return [`${fence}\n${code}\n${fence}`];
      }
      case 'hr':
        return ['---'];
      case 'table':
        return this.table(n);
      default:
        return this.blocks(n.children);
    }
  }

  list(n: El): string[] {
    const ordered = n.tag === 'ol';
    let index = Number.parseInt(n.attrs.start ?? '1', 10);
    if (!Number.isFinite(index)) index = 1;
    const items: string[] = [];
    for (const child of n.children) {
      if (typeof child === 'string') {
        if (child.trim()) items.push(`${ordered ? `${index++}.` : '-'} ${escapeInline(child.trim())}`);
        continue;
      }
      const content = (child.tag === 'li' ? this.blocks(child.children) : this.block(child)).join('\n');
      if (!content.trim()) continue;
      const marker = ordered ? `${index++}.` : '-';
      const pad = ' '.repeat(marker.length + 1);
      items.push(
        content
          .split('\n')
          .map((line, i) => (i === 0 ? `${marker} ${line}` : line ? `${pad}${line}` : ''))
          .join('\n'),
      );
    }
    return items.length ? [items.join('\n')] : [];
  }

  table(n: El): string[] {
    const rows: El[] = [];
    const collect = (el: El) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (c.tag === 'tr') rows.push(c);
        else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c);
      }
    };
    collect(n);
    const cells = rows
      .map((r) =>
        r.children
          .filter((c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
          .map((c) =>
            this.inline(c.children)
              .replace(/\s*\n\s*/g, ' ')
              .trim()
              .replace(/\|/g, '\\|'),
          ),
      )
      .filter((r) => r.length > 0);
    if (cells.length === 0) return [];
    const width = Math.max(...cells.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
    return [[line(cells[0]!), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n')];
  }
}

export function htmlToMarkdown(html: string, notes: TextNotes = newNotes()): string {
  const root = parseHtml(html);
  return new Converter(notes)
    .blocks(root.children)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops references to files that weren't part of the import (Markdown images and links, raw HTML images). */
function dropFileRefs(markdown: string, notes: TextNotes): string {
  if (!markdown.includes('@@PLUGINFILE@@')) return markdown;
  // Bounded repeats keep these linear on any input.
  return markdown
    .replace(/!\[[^\]\n]{0,500}\]\(\s*@@PLUGINFILE@@[^)\n]{0,2000}\)/g, () => {
      notes.droppedFiles = true;
      return '';
    })
    .replace(/<img\b[^<>]{0,2000}@@PLUGINFILE@@[^<>]{0,2000}>/gi, () => {
      notes.droppedFiles = true;
      return '';
    })
    .replace(/\[([^\]\n]{0,500})\]\(\s*@@PLUGINFILE@@[^)\n]{0,2000}\)/g, (_, text: string) => {
      notes.droppedFiles = true;
      return text;
    });
}

/** Converts a text in one of Moodle's formats to Coursekit Markdown. */
export function toMarkdown(text: string, format: TextFormat, notes: TextNotes = newNotes()): string {
  const source = text.replace(/\r\n?/g, '\n');
  switch (format) {
    case 'markdown':
      return dropFileRefs(source, notes).trim();
    case 'plain_text':
      return escapeMarkdown(source.trim());
    case 'moodle_auto_format':
      // HTML is allowed and newlines are line breaks.
      return /<\/?[a-z][^<>]*>/i.test(source)
        ? htmlToMarkdown(source.trim().replace(/\n/g, '<br>\n'), notes)
        : escapeMarkdown(decodeEntities(source).trim());
    default:
      return htmlToMarkdown(source, notes);
  }
}

/** Markdown for a single-line field (choices, items to order or match): no blank lines. */
export function toInlineMarkdown(text: string, format: TextFormat, notes: TextNotes = newNotes()): string {
  return toMarkdown(text, format, notes)
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Plain text from HTML (category descriptions). */
export function htmlToPlain(html: string): string {
  return textContent(parseHtml(html.replace(/<\/(p|div|li|h[1-6])>/gi, '$&\n')))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * The name Moodle needs when a question has none: the start of its text. Imported questions named exactly
 * this get no name, so names round-trip. Plain character replacements only: it runs on untrusted input.
 */
export function defaultQuestionName(prompt: string): string {
  const text = prompt
    .slice(0, 1000)
    .replace(/[\\*_`~#>[\]()!|<]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text) || 'Question';
}

// ---------------------------------------------------------------------------------------------------- category paths

/** Splits a Moodle category path; "//" inside a name is a literal slash. */
export function splitCategoryPath(path: string): string[] {
  return path
    .split(/(?<!\/)\/(?!\/)/)
    .map((name) => name.replace(/\/\//g, '/').trim())
    .filter(Boolean);
}

export function assembleCategoryPath(names: string[]): string {
  return names
    .map((name) => {
      let escaped = name.replace(/\//g, '//');
      if (escaped.startsWith('/')) escaped = ` ${escaped}`;
      if (escaped.endsWith('/')) escaped = `${escaped} `;
      return escaped;
    })
    .join('/');
}

/** Deepest category path an import file may have (exports write at most this many names too). */
export const MAX_CATEGORY_DEPTH = 50;

/** A category path from a file, relative to the bank: without the `$course$`-style context and Moodle's `top`. */
export function categoryFromFile(raw: string): string[] {
  let names = splitCategoryPath(raw.trim());
  if (names[0] && /^\$[a-z0-9_]+\$$/i.test(names[0])) names = names.slice(1);
  if (names[0]?.toLowerCase() === 'top') names = names.slice(1);
  names = names.map((n) => n.slice(0, 100).trim()).filter(Boolean);
  if (names.length > MAX_CATEGORY_DEPTH) throw badRequest(`Category paths in the file can be at most ${MAX_CATEGORY_DEPTH} levels deep.`);
  return names;
}

/** Drops characters XML 1.0 doesn't allow: control characters other than tab and newlines, lone surrogates, U+FFFE and U+FFFF. */
export function stripInvalidXml(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let bad = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bad = true;
    } else if (c >= 0xdc00 && c <= 0xdfff) bad = true;
    if (bad) {
      out += text.slice(from, i);
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}
