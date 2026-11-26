/**
 * Reads what Coursekit needs from a package: imsmanifest.xml (SCORM 1.2 and 2004: the default
 * organization's items, resources, launch URLs with xml:base and parameters, and the per-item data
 * the run-time exposes) or tincan.xml (xAPI: the activity id and launch page).
 * For SCORM 2004 it also reads the full Sequencing Definition Model of the organization and its
 * items (see sequencing/parse.ts).
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { PackageItem, PackageKind } from '../../shared/packages.js';
import {
  MAX_DEPTH,
  MAX_PACKAGE_CONDITIONS,
  MAX_PACKAGE_MAPS,
  MAX_PACKAGE_RULES,
  readSequencingTree,
  sequencingSize,
  type SequencingNode,
} from './sequencing/parse.js';
import { MAX_OBJECTIVES } from './sequencing/state.js';
import type { SequencingTree } from './sequencing/types.js';
import { PackageError } from './zip.js';

export interface StructureItem extends PackageItem {
  /** Launch URL relative to the package root, with its query string; null for headings. */
  href: string | null;
  /** The file the launch URL points at. */
  path: string | null;
  masteryScore: number | null;
  dataFromLms: string | null;
  maxTimeAllowed: string | null;
  timeLimitAction: string | null;
  completionThreshold: number | null;
  scaledPassingScore: number | null;
  /** SCORM 2004: false for items with isvisible="false" (kept in the activity tree, left out of the table of contents). */
  visible?: boolean;
}

export interface PackageStructure {
  kind: PackageKind;
  edition: string | null;
  title: string;
  items: StructureItem[];
  /** xAPI: the activity IRI from tincan.xml. */
  activityId: string | null;
  /** SCORM 2004: the activity tree with its sequencing definitions (the root first, then `items` in order). */
  sequencing?: SequencingTree;
  /** Things in the manifest that were ignored or replaced by defaults. */
  warnings?: string[];
}

const MAX_WARNINGS = 50;

const BASE = 'http://package.invalid/';

function parseXml(text: string, file: string) {
  const errors: string[] = [];
  let doc;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(text.replace(/^﻿/, ''), 'text/xml');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const root = doc?.documentElement;
  if (errors.length || !root) {
    const detail = (errors[0] ?? 'it is empty').split('\n')[0]!.slice(0, 160);
    throw new PackageError(`${file} could not be read: ${detail}`);
  }
  return root;
}

function kids(el: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName?.toLowerCase() === name.toLowerCase()) out.push(n as Element);
  }
  return out;
}

const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
const text = (el: Element | null | undefined) => (el?.textContent ?? '').trim();

/** An attribute by local name, ignoring case and namespace prefix (adlcp:scormtype vs adlcp:scormType). */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const direct = el.getAttribute(name);
  if (direct !== null && direct !== '') return direct;
  const want = name.toLowerCase();
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    const local = (a.localName ?? a.name).toLowerCase();
    if (local === want || a.name.toLowerCase() === want) return a.value;
  }
  return null;
}

function num(value: string | null, min: number, max: number): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Appends an item's `parameters` to a launch href, following the SCORM content packaging rules. */
export function applyParameters(href: string, parameters: string | null): string {
  if (!parameters) return href;
  let p = parameters.trim();
  if (!p) return href;
  if (p.startsWith('#')) return href.includes('#') ? href : href + p;
  while (p.startsWith('?') || p.startsWith('&')) p = p.slice(1);
  if (!p) return href;
  const [main, hash] = href.split('#', 2) as [string, string | undefined];
  return `${main}${main.includes('?') ? '&' : '?'}${p}${hash !== undefined ? `#${hash}` : ''}`;
}

/** Resolves a launch href against the xml:base chain. Returns the path inside the package and the URL to launch. */
export function resolveLaunch(href: string, bases: Array<string | null>): { path: string; href: string } {
  let base = new URL(BASE);
  try {
    for (const b of bases) if (b) base = new URL(b, base);
    const url = new URL(href, base);
    if (url.origin !== new URL(BASE).origin) {
      throw new PackageError(`The package launches "${href.slice(0, 120)}" on another website, which Coursekit can't track.`);
    }
    let path = url.pathname.slice(1);
    try {
      path = path
        .split('/')
        .map((s) => decodeURIComponent(s))
        .join('/');
    } catch {
      // keep the encoded form
    }
    if (!path) throw new PackageError('An item of the package has an empty launch address.');
    return { path, href: url.pathname.slice(1) + url.search + url.hash };
  } catch (err) {
    if (err instanceof PackageError) throw err;
    throw new PackageError(`The launch address "${href.slice(0, 120)}" is not valid.`);
  }
}

function detectScormVersion(root: Element, source: string): { kind: PackageKind; edition: string | null } {
  const schemaVersion = text(kid(kid(root, 'metadata'), 'schemaversion')).toLowerCase();
  if (schemaVersion === '1.2') return { kind: 'scorm12', edition: null };
  if (schemaVersion.includes('4th')) return { kind: 'scorm2004', edition: '4th' };
  if (schemaVersion.includes('3rd')) return { kind: 'scorm2004', edition: '3rd' };
  if (schemaVersion === 'cam 1.3' || schemaVersion.includes('2nd')) return { kind: 'scorm2004', edition: '2nd' };
  if (/adlcp_v1p3/i.test(source) || /\bscormType\s*=/.test(source)) return { kind: 'scorm2004', edition: '3rd' };
  return { kind: 'scorm12', edition: null };
}

export function parseScormManifest(source: string, hasFile: (path: string) => boolean): PackageStructure {
  const root = parseXml(source, 'imsmanifest.xml');
  if (root.localName?.toLowerCase() !== 'manifest') throw new PackageError('imsmanifest.xml has no <manifest> element.');
  const { kind, edition } = detectScormVersion(root, source);
  const scorm2004 = kind === 'scorm2004';

  const resourcesEl = kid(root, 'resources');
  const resources = new Map<string, Element>();
  for (const r of kids(resourcesEl, 'resource')) {
    const id = attr(r, 'identifier');
    if (id) resources.set(id, r);
  }

  const organizations = kid(root, 'organizations');
  const orgs = kids(organizations, 'organization');
  const defaultId = attr(organizations, 'default');
  const org = orgs.find((o) => attr(o, 'identifier') === defaultId) ?? orgs[0] ?? null;

  const items: StructureItem[] = [];
  const nodes: SequencingNode[] = [];
  const ids = new Set<string>();
  const add = (input: Omit<StructureItem, 'launchable'>): string => {
    let id = input.id || `item-${items.length + 1}`;
    while (ids.has(id)) id = `${id}-${items.length + 1}`;
    ids.add(id);
    items.push({ ...input, id, launchable: input.href !== null });
    return id;
  };

  const resourceLaunch = (resource: Element, parameters: string | null) => {
    const href = attr(resource, 'href');
    if (!href) return null;
    const launch = resolveLaunch(applyParameters(href, parameters), [
      attr(root, 'xml:base'),
      attr(resourcesEl, 'xml:base'),
      attr(resource, 'xml:base'),
    ]);
    if (!hasFile(launch.path)) throw new PackageError(`The manifest launches "${launch.path.slice(0, 160)}", which isn't in the zip.`);
    const type = (attr(resource, 'scormtype') ?? 'sco').toLowerCase();
    return { ...launch, sco: type !== 'asset' };
  };

  const walk = (parent: Element, depth: number, parentNode: number) => {
    for (const item of kids(parent, 'item')) {
      // SCORM 1.2 leaves hidden items out; in SCORM 2004 they stay in the activity tree, just not in the table of contents.
      const visible = (attr(item, 'isvisible') ?? 'true').toLowerCase() !== 'false';
      if (!visible && !scorm2004) continue;
      // Sequencing walks the activity tree from the root at every step: a sane depth keeps that cheap.
      if (scorm2004 && depth >= MAX_DEPTH) throw new PackageError(`The manifest nests its items more than ${MAX_DEPTH} levels deep.`);
      const ref = attr(item, 'identifierref');
      const resource = ref ? resources.get(ref) : undefined;
      if (ref && !resource)
        throw new PackageError(`The manifest item "${attr(item, 'identifier') ?? ref}" points to a resource that doesn't exist.`);
      const launch = resource ? resourceLaunch(resource, attr(item, 'parameters')) : null;
      const seq = kid(item, 'sequencing');
      const threshold = kid(item, 'completionThreshold');
      let completionThreshold: number | null = null;
      if (threshold) {
        const byMeasure = attr(threshold, 'completedByMeasure');
        completionThreshold =
          byMeasure !== null
            ? byMeasure === 'true'
              ? (num(attr(threshold, 'minProgressMeasure'), 0, 1) ?? 1)
              : null
            : num(text(threshold), 0, 1);
      }
      const title = text(kid(item, 'title')).slice(0, 300) || (launch ? 'Untitled' : 'Section');
      const id = add({
        id: attr(item, 'identifier') ?? '',
        title,
        depth,
        href: launch?.href ?? null,
        path: launch?.path ?? null,
        sco: launch?.sco ?? false,
        masteryScore: kind === 'scorm12' ? num(text(kid(item, 'masteryscore')), 0, 100) : null,
        dataFromLms: text(kid(item, 'datafromlms')).slice(0, kind === 'scorm12' ? 4096 : 4000) || null,
        maxTimeAllowed:
          kind === 'scorm12'
            ? text(kid(item, 'maxtimeallowed')) || null
            : attr(kid(seq, 'limitConditions'), 'attemptAbsoluteDurationLimit'),
        timeLimitAction: text(kid(item, 'timelimitaction')) || null,
        completionThreshold: scorm2004 ? completionThreshold : null,
        scaledPassingScore: null,
        ...(scorm2004 && !visible ? { visible: false } : {}),
      });
      const index = nodes.length;
      nodes.push({ el: item, id, title, parent: parentNode, depth, launchable: launch !== null, sco: launch?.sco ?? false, visible });
      walk(item, depth + 1, index);
    }
  };

  if (org) walk(org, 0, -1);
  if (!items.some((i) => i.launchable)) {
    // No organization: every resource with a launch address becomes an item.
    for (const [id, resource] of resources) {
      const launch = resourceLaunch(resource, null);
      if (!launch) continue;
      const finalId = add({
        id,
        title: id,
        depth: 0,
        ...launch,
        masteryScore: null,
        dataFromLms: null,
        maxTimeAllowed: null,
        timeLimitAction: null,
        completionThreshold: null,
        scaledPassingScore: null,
      });
      nodes.push({ el: resource, id: finalId, title: id, parent: -1, depth: 0, launchable: true, sco: launch.sco, visible: true });
    }
  }
  if (!items.some((i) => i.launchable)) throw new PackageError("The manifest doesn't list anything to launch.");
  if (items.length > 2000) throw new PackageError('The manifest lists too many items.');

  const title =
    text(kid(org, 'title')) ||
    text(kid(kid(kid(kid(root, 'metadata'), 'lom'), 'general'), 'title')) ||
    items.find((i) => i.launchable)!.title;
  const structure: PackageStructure = { kind, edition, title: title.slice(0, 200), items, activityId: null };
  if (scorm2004) {
    const warnings: string[] = [];
    const warn = (message: string) => {
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
    };
    let rootId = attr(org, 'identifier') || 'organization';
    if (ids.has(rootId)) rootId = '__root';
    const tree = readSequencingTree(root, org, rootId, structure.title, nodes, warn);
    const size = sequencingSize(tree);
    if (size.objectives > MAX_OBJECTIVES) throw new PackageError('The manifest defines too many objectives.');
    if (size.rules > MAX_PACKAGE_RULES || size.conditions > MAX_PACKAGE_CONDITIONS || size.maps > MAX_PACKAGE_MAPS) {
      throw new PackageError('The manifest defines too many sequencing rules or objective maps.');
    }
    // The run-time values that come from the (possibly shared) sequencing definitions.
    items.forEach((item, i) => {
      const def = tree.activities[i + 1]!;
      const primary = def.objectives[0]!;
      item.scaledPassingScore = primary.satisfiedByMeasure ? primary.minNormalizedMeasure : null;
      if (!item.maxTimeAllowed && def.attemptDurationLimit !== null) item.maxTimeAllowed = `PT${def.attemptDurationLimit}S`;
    });
    structure.sequencing = tree;
    if (warnings.length) structure.warnings = warnings;
  }
  return structure;
}

export function parseTincan(source: string, hasFile: (path: string) => boolean): PackageStructure {
  const root = parseXml(source, 'tincan.xml');
  const activities = kids(kid(root, 'activities'), 'activity');
  const activity = activities.find((a) => kid(a, 'launch')) ?? null;
  if (!activity) throw new PackageError("tincan.xml doesn't name a launch page.");
  const activityId = (attr(activity, 'id') ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(activityId) || activityId.length > 2000) {
    throw new PackageError('The activity in tincan.xml needs an id that is a full IRI (like https://example.com/course).');
  }
  const launch = resolveLaunch(text(kid(activity, 'launch')), []);
  if (!hasFile(launch.path)) throw new PackageError(`tincan.xml launches "${launch.path.slice(0, 160)}", which isn't in the zip.`);
  const title = (text(kid(activity, 'name')) || 'xAPI activity').slice(0, 200);
  return {
    kind: 'xapi',
    edition: null,
    title,
    activityId,
    items: [
      {
        id: 'xapi',
        title,
        depth: 0,
        launchable: true,
        sco: true,
        href: launch.href,
        path: launch.path,
        masteryScore: null,
        dataFromLms: null,
        maxTimeAllowed: null,
        timeLimitAction: null,
        completionThreshold: null,
        scaledPassingScore: null,
      },
    ],
  };
}
