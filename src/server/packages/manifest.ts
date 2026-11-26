/**
 * Reads what Coursekit needs from a package: imsmanifest.xml (SCORM 1.2 and 2004: the default
 * organization's items, resources, launch URLs with xml:base and parameters, and the per-item data
 * the run-time exposes) or tincan.xml (xAPI: the activity id and launch page).
 * Sequencing and navigation rules of SCORM 2004 are not read, apart from the primary objective's
 * minimum normalized measure (cmi.scaled_passing_score) and the attempt duration limit.
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { PackageItem, PackageKind } from '../../shared/packages.js';
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
}

export interface PackageStructure {
  kind: PackageKind;
  edition: string | null;
  title: string;
  items: StructureItem[];
  /** xAPI: the activity IRI from tincan.xml. */
  activityId: string | null;
}

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
  const ids = new Set<string>();
  const add = (input: Omit<StructureItem, 'launchable'>) => {
    let id = input.id || `item-${items.length + 1}`;
    while (ids.has(id)) id = `${id}-${items.length + 1}`;
    ids.add(id);
    items.push({ ...input, id, launchable: input.href !== null });
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

  const walk = (parent: Element, depth: number) => {
    for (const item of kids(parent, 'item')) {
      if ((attr(item, 'isvisible') ?? 'true').toLowerCase() === 'false') continue;
      const ref = attr(item, 'identifierref');
      const resource = ref ? resources.get(ref) : undefined;
      if (ref && !resource)
        throw new PackageError(`The manifest item "${attr(item, 'identifier') ?? ref}" points to a resource that doesn't exist.`);
      const launch = resource ? resourceLaunch(resource, attr(item, 'parameters')) : null;
      const seq = kid(item, 'sequencing');
      const primary = kid(kid(seq, 'objectives'), 'primaryObjective');
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
      add({
        id: attr(item, 'identifier') ?? '',
        title: text(kid(item, 'title')).slice(0, 300) || (launch ? 'Untitled' : 'Section'),
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
        completionThreshold: kind === 'scorm2004' ? completionThreshold : null,
        scaledPassingScore:
          kind === 'scorm2004' && primary && attr(primary, 'satisfiedByMeasure') === 'true'
            ? (num(text(kid(primary, 'minNormalizedMeasure')), -1, 1) ?? 1)
            : null,
      });
      walk(item, depth + 1);
    }
  };

  if (org) walk(org, 0);
  if (!items.some((i) => i.launchable)) {
    // No organization: every resource with a launch address becomes an item.
    for (const [id, resource] of resources) {
      const launch = resourceLaunch(resource, null);
      if (!launch) continue;
      add({
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
    }
  }
  if (!items.some((i) => i.launchable)) throw new PackageError("The manifest doesn't list anything to launch.");
  if (items.length > 2000) throw new PackageError('The manifest lists too many items.');

  const title =
    text(kid(org, 'title')) ||
    text(kid(kid(kid(kid(root, 'metadata'), 'lom'), 'general'), 'title')) ||
    items.find((i) => i.launchable)!.title;
  return { kind, edition, title: title.slice(0, 200), items, activityId: null };
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
