import { runInNewContext } from 'node:vm';
import { strToU8, zipSync, type ZipInputFile, type Zippable } from 'fflate';
import type { Coursekit } from '../src/server/index.js';
import type { Client } from './helpers.js';

export const ORIGIN = 'http://localhost';

export function zip(files: Record<string, string | Uint8Array | ZipInputFile>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, typeof data === 'string' ? strToU8(data) : data])) as Zippable,
  );
}

export const page = (title: string, body = '') =>
  `<!doctype html><html><head><title>${title}</title><script>window.loaded = true;</script></head><body>${body}</body></html>`;

export function manifest12(
  options: { items?: Array<{ id: string; href: string; mastery?: number; parameters?: string; type?: string }>; base?: string } = {},
) {
  const items = options.items ?? [{ id: 'sco1', href: 'index.html', mastery: 80 }];
  return `<?xml version="1.0"?>
<manifest identifier="m1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org"><organization identifier="org"><title>Test course</title>
  ${items
    .map(
      (i) =>
        `<item identifier="${i.id}" identifierref="r-${i.id}"${i.parameters ? ` parameters="${i.parameters}"` : ''}><title>Item ${i.id}</title>${i.mastery !== undefined ? `<adlcp:masteryscore>${i.mastery}</adlcp:masteryscore>` : ''}<adlcp:datafromlms>launch-${i.id}</adlcp:datafromlms></item>`,
    )
    .join('\n')}
  </organization></organizations>
  <resources${options.base ? ` xml:base="${options.base}"` : ''}>
  ${items.map((i) => `<resource identifier="r-${i.id}" type="webcontent" adlcp:scormtype="${i.type ?? 'sco'}" href="${i.href}"><file href="${i.href}"/></resource>`).join('\n')}
  </resources>
</manifest>`;
}

export function manifest2004(edition = '4th Edition', extra = '') {
  return `<?xml version="1.0"?>
<manifest identifier="m2" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss" xml:base="course/">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 ${edition}</schemaversion></metadata>
  <organizations default="org2"><organization identifier="org2"><title>Multi SCO</title>
    <item identifier="module"><title>Module</title>
      <item identifier="one" identifierref="r1" parameters="?lang=en"><title>Part one</title>
        <adlcp:completionThreshold completedByMeasure="true" minProgressMeasure="0.8"/>
      </item>
      <item identifier="two" identifierref="r2"><title>Part two</title>
        <imsss:sequencing><imsss:objectives><imsss:primaryObjective objectiveID="p" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.7</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing>
      </item>
      <item identifier="three" identifierref="r3"><title>Glossary</title></item>
    </item>
    ${extra}
  </organization></organizations>
  <resources xml:base="content/">
    <resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="one.html?x=1"><file href="one.html"/></resource>
    <resource identifier="r2" type="webcontent" adlcp:scormType="sco" xml:base="part two/" href="two.html"><file href="two.html"/></resource>
    <resource identifier="r3" type="webcontent" adlcp:scormType="asset" href="glossary.html"><file href="glossary.html"/></resource>
  </resources>
</manifest>`;
}

export function scorm12Zip(extra: Record<string, string> = {}) {
  return zip({ 'imsmanifest.xml': manifest12(), 'index.html': page('SCO'), 'img/logo.png': new Uint8Array([137, 80, 78, 71]), ...extra });
}

export function scorm2004Zip() {
  return zip({
    'imsmanifest.xml': manifest2004(),
    'course/content/one.html': page('One'),
    'course/content/part two/two.html': page('Two'),
    'course/content/glossary.html': page('Glossary'),
  });
}

/** Uploads a zip through /api/files (as the browser does) and imports it into a package activity. */
export async function uploadPackage(
  lms: Coursekit,
  as: Client,
  courseId: string,
  activityId: string,
  data: Uint8Array,
  name = 'package.zip',
) {
  const form = new FormData();
  form.append('file', new File([data as Uint8Array<ArrayBuffer>], name, { type: 'application/zip' }));
  form.append('context', 'activity');
  form.append('courseId', courseId);
  const res = await lms.app.request('/api/files', { method: 'POST', headers: { cookie: as.cookie, origin: ORIGIN }, body: form });
  const file = (await res.json()) as { id: string };
  if (res.status !== 201) throw new Error(`Upload failed: ${res.status} ${JSON.stringify(file)}`);
  return as.post(`/api/packages/${activityId}/import`, { fileId: file.id });
}

export async function createPackageActivity(
  teacher: Client,
  courseId: string,
  sectionId: string,
  settings: Record<string, unknown> = {},
  maxGrade = 100,
) {
  const res = await teacher.post(`/api/courses/${courseId}/activities`, {
    sectionId,
    type: 'package',
    title: 'Package',
    maxGrade,
    settings,
  });
  if (res.status !== 201) throw new Error(`Create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

/** Splits a launch URL into its token and the rest. */
export function tokenOf(url: string): string {
  return url.split('/')[2]!;
}

export async function fetchRaw(lms: Coursekit, path: string, init: RequestInit = {}) {
  return lms.fetch(new Request(`${ORIGIN}${path}`, init));
}

export async function commit(lms: Coursekit, token: string, body: Record<string, unknown>) {
  const res = await fetchRaw(lms, `/content/${token}/__coursekit/commit`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ sid: 's1', seq: 1, ops: [], terminate: false, ...body }),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; recorded?: boolean; rejected?: number; error?: string } };
}

export interface FakeWindow {
  API?: Record<string, (...args: string[]) => string>;
  API_1484_11?: Record<string, (...args: string[]) => string>;
  localStorage: Storage;
  sessionStorage: Storage;
  document: { cookie: string };
  sent: Array<{ url: string; body: Record<string, unknown> }>;
  messages: unknown[];
  fire(event: string): void;
}

/** Runs the served run-time script in node:vm with a fake, sandbox-like window. */
export function runRuntime(script: string): FakeWindow {
  const listeners: Record<string, Array<() => void>> = {};
  const sent: FakeWindow['sent'] = [];
  const messages: unknown[] = [];
  const blocked = () => {
    throw new Error('SecurityError: the document is sandboxed');
  };
  const document = {
    visibilityState: 'visible',
    addEventListener: (e: string, fn: () => void) => (listeners[e] ??= []).push(fn),
  };
  Object.defineProperty(document, 'cookie', { configurable: true, get: blocked, set: blocked });
  const top = { postMessage: (m: unknown) => messages.push(m) };
  const win: Record<string, unknown> = {
    document,
    top,
    navigator: {
      sendBeacon: (url: string, body: string) => {
        sent.push({ url, body: JSON.parse(body) });
        return true;
      },
    },
    fetch: async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
    addEventListener: (e: string, fn: () => void) => (listeners[e] ??= []).push(fn),
    sent,
    messages,
    fire: (e: string) => {
      for (const fn of listeners[e] ?? []) fn();
    },
  };
  Object.defineProperty(win, 'localStorage', { configurable: true, get: blocked });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, get: blocked });
  win.window = win;
  runInNewContext(script, win);
  return win as unknown as FakeWindow;
}
