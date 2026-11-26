/**
 * Reads and checks a cmi5 course structure (cmi5.xml, section 13 of the cmi5 specification and its
 * CourseStructure.xsd): the course, nested blocks, AUs and objectives, with their titles and descriptions as
 * language maps. Invalid structures are refused with a message for the teacher who uploaded them.
 *
 * AUs packaged in the zip use relative URLs (the file must be in the zip); AUs hosted elsewhere use absolute
 * http(s) URLs, which may not point at Coursekit itself. A cmi5.xml uploaded on its own may only have absolute
 * URLs (section 14.2). Elements of other namespaces are extensions and are ignored.
 */
import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { zipSync } from 'fflate';
import type { Cmi5LaunchMethod, Cmi5MoveOn } from '../../../shared/cmi5.js';
import type { PackageStructure, StructureItem } from '../manifest.js';
import { PackageError } from '../zip.js';
import { CMI5_NAMESPACE, LAUNCH_PARAMETER_NAMES, MAX_DEPTH, MAX_LANGSTRINGS, MAX_NODES, MAX_URL_LENGTH } from './constants.js';

/** A language map: language tag (or 'und') to text. */
export type LangMap = Record<string, string>;

export interface Cmi5Objective {
  id: string;
  title: LangMap;
  description: LangMap;
}

export interface Cmi5Au {
  type: 'au';
  /** Short stable key derived from the id: the item id in the package structure, URLs and the database. */
  key: string;
  /** The AU's id in the course structure (the publisher id). */
  id: string;
  title: LangMap;
  description: LangMap;
  /** Ids of the course objectives it refers to. */
  objectives: string[];
  /** The launch URL as written (absolute URLs normalised). Packaged AUs launch from items[].href. */
  url: string;
  /** Hosted on another website. */
  external: boolean;
  launchMethod: Cmi5LaunchMethod;
  moveOn: Cmi5MoveOn;
  masteryScore: number | null;
  activityType: string | null;
  launchParameters: string | null;
  entitlementKey: string | null;
}

export interface Cmi5Block {
  type: 'block';
  key: string;
  id: string;
  title: LangMap;
  description: LangMap;
  objectives: string[];
  children: Cmi5Node[];
}

export type Cmi5Node = Cmi5Au | Cmi5Block;

export interface Cmi5Course {
  id: string;
  title: LangMap;
  description: LangMap;
  objectives: Cmi5Objective[];
  children: Cmi5Node[];
}

/** The package structure of a cmi5 version: items[] lists blocks (headings) and AUs for the generic code. */
export interface Cmi5PackageStructure extends PackageStructure {
  kind: 'cmi5';
  cmi5: Cmi5Course;
}

export interface Cmi5ParseOptions {
  /** Whether a path exists in the zip (packaged AUs). */
  hasFile: (path: string) => boolean;
  /** cmi5.xml was uploaded on its own, without a zip: every AU must be hosted elsewhere. */
  standalone: boolean;
  /** Coursekit's own origin, when known: AUs hosted elsewhere may not use it. */
  ownOrigin: string | null;
}

const MOVE_ON: readonly Cmi5MoveOn[] = ['NotApplicable', 'Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed'];
const LAUNCH_METHODS: readonly Cmi5LaunchMethod[] = ['AnyWindow', 'OwnWindow'];
const RE_IRI = /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`\u0000-\u001f\u007f]+$/i;
const RE_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const RE_BAD_URL = /[\s<>"{}|\\^`\u0000-\u001f\u007f]/;
const RE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const BASE = 'http://package.invalid/';

export function isIri(value: string): boolean {
  return value.length <= 2048 && RE_IRI.test(value);
}

/** The key of a block or AU: base64url of the SHA-256 of its id, shortened. */
export function nodeKey(id: string): string {
  return createHash('sha256').update(id).digest('base64url').slice(0, 16);
}

/** The language tag to show from a language map: English first, then text without a language, then anything. */
export function pickTag(map: LangMap | undefined): string | undefined {
  const tags = Object.keys(map ?? {});
  return (
    tags.find((t) => t.toLowerCase() === 'en-us') ??
    tags.find((t) => t.toLowerCase() === 'en') ??
    tags.find((t) => t.toLowerCase().startsWith('en-')) ??
    tags.find((t) => t === 'und') ??
    tags[0]
  );
}

/** The text to show from a language map (see pickTag). */
export function pickLang(map: LangMap | undefined): string {
  const want = pickTag(map);
  return want === undefined || !map ? '' : (map[want] ?? '');
}

const shown = (value: string) => JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}...` : value);

function fail(message: string): never {
  throw new PackageError(`cmi5.xml: ${message}`);
}

function parseXml(source: string): Element {
  const text = source.replace(/^﻿/, '');
  if (/<!ENTITY/i.test(text)) fail("entity declarations (<!ENTITY>) aren't allowed.");
  const errors: string[] = [];
  let doc;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(text, 'text/xml');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const root = doc?.documentElement;
  if (errors.length || !root) {
    const detail = (errors[0] ?? 'it is empty').split('\n')[0]!.slice(0, 160);
    fail(`the file could not be read as XML: ${detail}`);
  }
  return root;
}

/** Elements of the cmi5 namespace (or of no namespace, which the schema doesn't allow either). */
const isOurs = (el: Element) => !el.namespaceURI || el.namespaceURI === CMI5_NAMESPACE;

/** Child elements. Elements with element content can't have text between them (the schema has no mixed content). */
function childElements(el: Element, textAllowed = false): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
    else if (!textAllowed && (n.nodeType === 3 || n.nodeType === 4) && (n.nodeValue ?? '').trim()) {
      fail(`<${el.localName}> contains text where only elements are allowed.`);
    }
  }
  return out;
}

/** Checks the attributes of a cmi5 element: only the listed unqualified ones, plus any of other namespaces. */
function checkAttributes(el: Element, allowed: string[]) {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if (a.namespaceURI === XMLNS || a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
    if (a.namespaceURI && a.namespaceURI !== CMI5_NAMESPACE) continue; // extension attributes (xml:lang, xsi:...)
    const name = a.localName ?? a.name;
    if (a.namespaceURI || !allowed.includes(name)) fail(`<${el.localName}> has an unknown attribute "${a.name}".`);
  }
}

const attr = (el: Element, name: string): string | null => (el.hasAttribute(name) ? el.getAttribute(name)!.trim() : null);

interface Step {
  names: string[];
  min: number;
  max: number;
}

/** Checks the cmi5 child elements against a sequence (the order of the schema) and returns them by name. */
function sequence(el: Element, steps: Step[]): Element[] {
  const children = childElements(el).filter(isOurs);
  const counts = steps.map(() => 0);
  let step = 0;
  for (const child of children) {
    const name = child.localName ?? child.nodeName;
    if (child.namespaceURI !== CMI5_NAMESPACE) fail(`<${name}> must be in the cmi5 namespace (${CMI5_NAMESPACE}).`);
    if (!steps.some((s) => s.names.includes(name))) fail(`<${el.localName}> can't contain <${name}>.`);
    while (step < steps.length && !steps[step]!.names.includes(name)) {
      if (counts[step]! < steps[step]!.min) fail(`<${el.localName}> needs <${steps[step]!.names.join('> or <')}> before <${name}>.`);
      step++;
    }
    if (step >= steps.length) fail(`<${name}> is out of order in <${el.localName}>.`);
    counts[step]!++;
    if (counts[step]! > steps[step]!.max) fail(`<${el.localName}> can only have one <${name}>.`);
  }
  for (; step < steps.length; step++) {
    if (counts[step]! < steps[step]!.min) fail(`<${el.localName}> needs <${steps[step]!.names.join('> or <')}>.`);
  }
  return children;
}

const named = (children: Element[], name: string) => children.filter((c) => c.localName === name);

/** A title or description: one or more <langstring lang="...">. */
function langText(el: Element): LangMap {
  checkAttributes(el, []);
  const map: LangMap = {};
  const strings = sequence(el, [{ names: ['langstring'], min: 1, max: Infinity }]);
  // Titles and descriptions go into every "launched" statement: their size is bounded.
  if (strings.length > MAX_LANGSTRINGS) fail(`a <${el.localName}> can have at most ${MAX_LANGSTRINGS} <langstring> elements.`);
  for (const ls of strings) {
    checkAttributes(ls, ['lang']);
    for (const child of childElements(ls, true)) {
      if (isOurs(child)) fail('<langstring> can only contain text.');
    }
    const lang = attr(ls, 'lang') || ls.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')?.trim() || 'und';
    if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(lang)) fail(`${shown(lang)} isn't a valid language tag.`);
    const value = (ls.textContent ?? '').trim().slice(0, 2000);
    if (!(lang in map)) map[lang] = value;
  }
  return map;
}

function idOf(el: Element, what: string): string {
  const id = attr(el, 'id');
  if (!id) fail(`every ${what} needs an id.`);
  if (!isIri(id)) fail(`the ${what} id ${shown(id)} isn't an IRI (like https://example.com/course/1).`);
  return id;
}

function decimal(value: string, what: string): number {
  if (!RE_DECIMAL.test(value)) fail(`${what} ${shown(value)} isn't a decimal number.`);
  const n = Number(value);
  if (!(n >= 0 && n <= 1)) fail(`${what} must be between 0 and 1 (found ${shown(value)}).`);
  const decimals = value.includes('.') ? value.split('.')[1]!.length : 0;
  if (decimals > 4) fail(`${what} can have at most 4 decimal places (found ${shown(value)}).`);
  return n;
}

function reservedParameters(params: URLSearchParams, title: string) {
  for (const name of params.keys()) {
    if (LAUNCH_PARAMETER_NAMES.includes(name)) {
      fail(`the URL of AU ${shown(title)} uses the query parameter "${name}", which cmi5 reserves for the launch.`);
    }
  }
}

interface LaunchTarget {
  external: boolean;
  url: string;
  path: string | null;
  href: string | null;
}

function launchTarget(raw: string, title: string, options: Cmi5ParseOptions): LaunchTarget {
  if (!raw) fail(`AU ${shown(title)} has an empty <url>.`);
  // Every launch copies the URL into its session and its "launched" statement.
  if (raw.length > MAX_URL_LENGTH) {
    fail(`the URL of AU ${shown(title)} is too long (at most ${MAX_URL_LENGTH.toLocaleString('en')} characters).`);
  }
  if (RE_BAD_URL.test(raw)) {
    fail(`the URL of AU ${shown(title)} contains spaces or characters that aren't allowed in a URL (encode them, like %20).`);
  }
  if (RE_SCHEME.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      fail(`the URL of AU ${shown(title)} (${shown(raw)}) isn't valid.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail(`AU ${shown(title)} launches ${shown(raw)}: Coursekit can only launch AUs at http:// or https:// addresses.`);
    }
    if (!url.hostname) fail(`the URL of AU ${shown(title)} (${shown(raw)}) has no host name.`);
    if (options.ownOrigin && url.origin === options.ownOrigin) {
      fail(`AU ${shown(title)} points at this Coursekit site. Put the AU in the zip and give it a relative URL instead.`);
    }
    reservedParameters(url.searchParams, title);
    return { external: true, url: url.href, path: null, href: null };
  }
  if (raw.startsWith('//')) fail(`the URL of AU ${shown(title)} needs a scheme (like https://).`);
  if (options.standalone) {
    fail(
      `AU ${shown(title)} has the relative URL ${shown(raw)}. A cmi5.xml uploaded on its own needs full addresses (https://...) for every AU; upload a zip to include the AU files.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    fail(`the URL of AU ${shown(title)} (${shown(raw)}) isn't valid.`);
  }
  if (url.origin !== new URL(BASE).origin) fail(`the URL of AU ${shown(title)} (${shown(raw)}) isn't valid.`);
  let path = url.pathname.slice(1);
  try {
    path = path
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    fail(`the URL of AU ${shown(title)} (${shown(raw)}) isn't valid.`);
  }
  if (!path || path.endsWith('/')) fail(`the URL of AU ${shown(title)} (${shown(raw)}) doesn't name a file in the zip.`);
  if (!options.hasFile(path)) fail(`AU ${shown(title)} launches ${shown(path)}, which isn't in the zip.`);
  reservedParameters(url.searchParams, title);
  return { external: false, url: raw, path, href: url.pathname.slice(1) + url.search + url.hash };
}

/** Parses cmi5.xml into the package structure of a cmi5 version. Throws PackageError when it isn't valid. */
export function parseCmi5(source: string, options: Cmi5ParseOptions): Cmi5PackageStructure {
  const root = parseXml(source);
  if (root.localName !== 'courseStructure' || root.namespaceURI !== CMI5_NAMESPACE) {
    fail(`the root element must be <courseStructure> in the cmi5 namespace (xmlns="${CMI5_NAMESPACE}").`);
  }
  checkAttributes(root, []);
  const top = sequence(root, [
    { names: ['course'], min: 1, max: 1 },
    { names: ['objectives'], min: 0, max: 1 },
    { names: ['au', 'block'], min: 1, max: Infinity },
  ]);

  const ids = new Set<string>();
  const unique = (id: string, what: string) => {
    if (ids.has(id)) fail(`the id ${shown(id)} is used twice (the ${what} ids must be unique within the course structure).`);
    ids.add(id);
  };

  const courseEl = named(top, 'course')[0]!;
  checkAttributes(courseEl, ['id']);
  const courseId = idOf(courseEl, 'course');
  unique(courseId, 'course, block and AU');
  const courseParts = sequence(courseEl, [
    { names: ['title'], min: 1, max: 1 },
    { names: ['description'], min: 1, max: 1 },
  ]);

  const objectives: Cmi5Objective[] = [];
  const objectiveIds = new Set<string>();
  const objectivesEl = named(top, 'objectives')[0];
  if (objectivesEl) {
    checkAttributes(objectivesEl, []);
    for (const o of sequence(objectivesEl, [{ names: ['objective'], min: 1, max: Infinity }])) {
      checkAttributes(o, ['id']);
      const id = idOf(o, 'objective');
      if (objectiveIds.has(id)) fail(`the objective id ${shown(id)} is used twice.`);
      objectiveIds.add(id);
      // The objective's title and description may come in either order (xs:all).
      const parts = childElements(o).filter(isOurs);
      for (const p of parts) {
        if (p.namespaceURI !== CMI5_NAMESPACE || !['title', 'description'].includes(p.localName ?? '')) {
          fail(`<objective> can't contain <${p.localName}>.`);
        }
      }
      const titles = named(parts, 'title');
      const descriptions = named(parts, 'description');
      if (titles.length !== 1 || descriptions.length !== 1) fail(`objective ${shown(id)} needs one <title> and one <description>.`);
      objectives.push({ id, title: langText(titles[0]!), description: langText(descriptions[0]!) });
    }
  }

  const references = (el: Element | undefined, owner: string): string[] => {
    if (!el) return [];
    checkAttributes(el, []);
    const out: string[] = [];
    for (const ref of sequence(el, [{ names: ['objective'], min: 1, max: Infinity }])) {
      checkAttributes(ref, ['idref']);
      if (childElements(ref).some(isOurs)) fail(`an objective reference in ${owner} can't contain elements.`);
      const idref = attr(ref, 'idref');
      if (!idref) fail(`an objective reference in ${owner} needs an idref.`);
      if (!objectiveIds.has(idref)) fail(`${owner} refers to the objective ${shown(idref)}, which the course doesn't define.`);
      if (!out.includes(idref)) out.push(idref);
    }
    return out;
  };

  let count = 0;
  const items: StructureItem[] = [];
  const item = (input: Pick<StructureItem, 'id' | 'title' | 'depth' | 'launchable' | 'href' | 'path'>): StructureItem => ({
    ...input,
    sco: input.launchable,
    masteryScore: null,
    dataFromLms: null,
    maxTimeAllowed: null,
    timeLimitAction: null,
    completionThreshold: null,
    scaledPassingScore: null,
  });

  const nodes = (parent: Element[], depth: number): Cmi5Node[] => {
    if (depth > MAX_DEPTH) fail(`blocks are nested more than ${MAX_DEPTH} levels deep.`);
    const out: Cmi5Node[] = [];
    for (const el of parent) {
      if (el.localName !== 'au' && el.localName !== 'block') continue;
      if (++count > MAX_NODES) fail(`the course has more than ${MAX_NODES.toLocaleString('en')} AUs and blocks.`);
      if (el.localName === 'block') {
        checkAttributes(el, ['id']);
        const id = idOf(el, 'block');
        unique(id, 'course, block and AU');
        const parts = sequence(el, [
          { names: ['title'], min: 1, max: 1 },
          { names: ['description'], min: 1, max: 1 },
          { names: ['objectives'], min: 0, max: 1 },
          { names: ['au', 'block'], min: 1, max: Infinity },
        ]);
        const title = langText(named(parts, 'title')[0]!);
        const block: Cmi5Block = {
          type: 'block',
          key: nodeKey(id),
          id,
          title,
          description: langText(named(parts, 'description')[0]!),
          objectives: references(named(parts, 'objectives')[0], `block ${shown(pickLang(title) || id)}`),
          children: [],
        };
        items.push(
          item({
            id: block.key,
            title: (pickLang(title) || 'Untitled block').slice(0, 300),
            depth,
            launchable: false,
            href: null,
            path: null,
          }),
        );
        block.children = nodes(parts, depth + 1);
        out.push(block);
        continue;
      }
      checkAttributes(el, ['id', 'moveOn', 'masteryScore', 'launchMethod', 'activityType']);
      const id = idOf(el, 'AU');
      unique(id, 'course, block and AU');
      const parts = sequence(el, [
        { names: ['title'], min: 1, max: 1 },
        { names: ['description'], min: 1, max: 1 },
        { names: ['objectives'], min: 0, max: 1 },
        { names: ['url'], min: 1, max: 1 },
        { names: ['launchParameters'], min: 0, max: 1 },
        { names: ['entitlementKey'], min: 0, max: 1 },
      ]);
      const title = langText(named(parts, 'title')[0]!);
      const label = pickLang(title) || id;
      const moveOn = attr(el, 'moveOn') ?? 'NotApplicable';
      if (!MOVE_ON.includes(moveOn as Cmi5MoveOn)) {
        fail(`AU ${shown(label)} has the moveOn value ${shown(moveOn)}; use one of ${MOVE_ON.join(', ')}.`);
      }
      const launchMethod = attr(el, 'launchMethod') ?? 'AnyWindow';
      if (!LAUNCH_METHODS.includes(launchMethod as Cmi5LaunchMethod)) {
        fail(`AU ${shown(label)} has the launchMethod value ${shown(launchMethod)}; use AnyWindow or OwnWindow.`);
      }
      const mastery = attr(el, 'masteryScore');
      const activityType = attr(el, 'activityType');
      if (activityType !== null && (!activityType || activityType.length > 2048)) fail(`AU ${shown(label)} has an empty activityType.`);
      const simple = (name: string) => {
        const node = named(parts, name)[0];
        if (!node) return null;
        checkAttributes(node, []);
        if (childElements(node, true).some(isOurs)) fail(`<${name}> in AU ${shown(label)} can only contain text.`);
        return (node.textContent ?? '').trim();
      };
      const target = launchTarget(simple('url') ?? '', label, options);
      const launchParameters = simple('launchParameters');
      const entitlementKey = simple('entitlementKey');
      if ((launchParameters?.length ?? 0) > 65_536) fail(`the launchParameters of AU ${shown(label)} are too long.`);
      if ((entitlementKey?.length ?? 0) > 4096) fail(`the entitlementKey of AU ${shown(label)} is too long.`);
      const au: Cmi5Au = {
        type: 'au',
        key: nodeKey(id),
        id,
        title,
        description: langText(named(parts, 'description')[0]!),
        objectives: references(named(parts, 'objectives')[0], `AU ${shown(label)}`),
        url: target.url,
        external: target.external,
        launchMethod: launchMethod as Cmi5LaunchMethod,
        moveOn: moveOn as Cmi5MoveOn,
        masteryScore: mastery === null ? null : decimal(mastery, `the masteryScore of AU ${shown(label)}`),
        activityType,
        launchParameters,
        entitlementKey,
      };
      items.push(
        item({
          id: au.key,
          title: (pickLang(title) || 'Untitled').slice(0, 300),
          depth,
          launchable: true,
          href: target.href,
          path: target.path,
        }),
      );
      out.push(au);
    }
    return out;
  };

  const course: Cmi5Course = {
    id: courseId,
    title: langText(named(courseParts, 'title')[0]!),
    description: langText(named(courseParts, 'description')[0]!),
    objectives,
    children: nodes(top, 0),
  };
  return {
    kind: 'cmi5',
    edition: null,
    title: (pickLang(course.title) || 'cmi5 course').slice(0, 200),
    items,
    activityId: null,
    cmi5: course,
  };
}

/** The cmi5 course of a version's structure, or null when it isn't a cmi5 version. */
export function cmi5Of(structure: PackageStructure): Cmi5Course | null {
  const course = (structure as Partial<Cmi5PackageStructure>).cmi5;
  return structure.kind === 'cmi5' && course ? course : null;
}

const courses = new Map<string, Cmi5Course | null>();

/**
 * The cmi5 course of a package version, parsed once: versions never change after import, and the LRS needs
 * the course on every request made with session credentials.
 */
export function courseOfVersion(version: { id: string; kind: string; structure: string }): Cmi5Course | null {
  if (version.kind !== 'cmi5') return null;
  if (courses.has(version.id)) return courses.get(version.id)!;
  let course: Cmi5Course | null = null;
  try {
    course = cmi5Of(JSON.parse(version.structure) as PackageStructure);
  } catch {
    course = null;
  }
  if (courses.size >= 200) courses.delete(courses.keys().next().value!);
  courses.set(version.id, course);
  return course;
}

/** Every AU of the course, in course order. */
export function allAus(nodes: Cmi5Node[]): Cmi5Au[] {
  const out: Cmi5Au[] = [];
  const walk = (list: Cmi5Node[]) => {
    for (const n of list) {
      if (n.type === 'au') out.push(n);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * An upload that is a cmi5.xml on its own (not a zip) becomes a zip holding just that file, so it imports like
 * a package. Returns null for anything else.
 */
export function standaloneCmi5(data: Uint8Array): Uint8Array | null {
  if (data.length < 5 || (data[0] === 0x50 && data[1] === 0x4b)) return null;
  const head = new TextDecoder('utf-8').decode(data.subarray(0, 64 * 1024)).replace(/^﻿/, '');
  if (!head.trimStart().startsWith('<')) return null;
  if (!/<(?:[A-Za-z_][\w.-]*:)?courseStructure[\s>/]/.test(head)) return null;
  return zipSync({ 'cmi5.xml': data });
}
