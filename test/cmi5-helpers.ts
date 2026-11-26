import { randomUUID } from 'node:crypto';
import type { Coursekit } from '../src/server/index.js';
import type { Client } from './helpers.js';
import { createPackageActivity, page, uploadPackage, zip } from './package-helpers.js';

export const NS = 'https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd';
export const CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
export const MOVE_ON = 'https://w3id.org/xapi/cmi5/context/categories/moveon';
export const EXT = {
  sessionId: 'https://w3id.org/xapi/cmi5/context/extensions/sessionid',
  masteryScore: 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore',
  launchMode: 'https://w3id.org/xapi/cmi5/context/extensions/launchmode',
  launchUrl: 'https://w3id.org/xapi/cmi5/context/extensions/launchurl',
  moveOn: 'https://w3id.org/xapi/cmi5/context/extensions/moveon',
  launchParameters: 'https://w3id.org/xapi/cmi5/context/extensions/launchparameters',
};
export const VERB = {
  launched: 'http://adlnet.gov/expapi/verbs/launched',
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
  terminated: 'http://adlnet.gov/expapi/verbs/terminated',
  abandoned: 'https://w3id.org/xapi/adl/verbs/abandoned',
  satisfied: 'https://w3id.org/xapi/adl/verbs/satisfied',
  waived: 'https://w3id.org/xapi/adl/verbs/waived',
  experienced: 'http://adlnet.gov/expapi/verbs/experienced',
  voided: 'http://adlnet.gov/expapi/verbs/voided',
};

export interface AuSpec {
  id: string;
  title?: string;
  url: string;
  moveOn?: string;
  masteryScore?: string;
  launchMethod?: string;
  launchParameters?: string;
  entitlementKey?: string;
  activityType?: string;
  objectives?: string[];
}
export interface BlockSpec {
  block: string;
  title?: string;
  children: Array<AuSpec | BlockSpec>;
}

const text = (tag: string, value: string) => `<${tag}><langstring lang="en-US">${value}</langstring></${tag}>`;

function nodeXml(node: AuSpec | BlockSpec): string {
  if ('block' in node) {
    return `<block id="${node.block}">${text('title', node.title ?? 'Block')}${text('description', 'A block')}${node.children.map(nodeXml).join('')}</block>`;
  }
  const attrs = [
    `id="${node.id}"`,
    node.moveOn ? `moveOn="${node.moveOn}"` : '',
    node.masteryScore ? `masteryScore="${node.masteryScore}"` : '',
    node.launchMethod ? `launchMethod="${node.launchMethod}"` : '',
    node.activityType ? `activityType="${node.activityType}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<au ${attrs}>${text('title', node.title ?? node.id.split('/').pop()!)}${text('description', 'An AU')}${
    node.objectives ? `<objectives>${node.objectives.map((o) => `<objective idref="${o}"/>`).join('')}</objectives>` : ''
  }<url>${node.url.replace(/&/g, '&amp;')}</url>${node.launchParameters ? `<launchParameters>${node.launchParameters}</launchParameters>` : ''}${
    node.entitlementKey ? `<entitlementKey>${node.entitlementKey}</entitlementKey>` : ''
  }</au>`;
}

/** A cmi5.xml course structure. */
export function courseXml(
  nodes: Array<AuSpec | BlockSpec>,
  options: { id?: string; title?: string; objectives?: Array<{ id: string; title: string }> } = {},
): string {
  const objectives = options.objectives?.length
    ? `<objectives>${options.objectives.map((o) => `<objective id="${o.id}">${text('title', o.title)}${text('description', o.title)}</objective>`).join('')}</objectives>`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<courseStructure xmlns="${NS}">
  <course id="${options.id ?? 'https://example.test/course'}">${text('title', options.title ?? 'Test cmi5 course')}${text('description', 'A course for tests')}</course>
  ${objectives}
  ${nodes.map(nodeXml).join('\n  ')}
</courseStructure>`;
}

export const AU_ONE = 'https://example.test/au/one';
export const AU_TWO = 'https://example.test/au/two';
export const BLOCK = 'https://example.test/block/one';

/** One block with "One" (moveOn Completed, launch parameters) and "Two" (moveOn Passed, mastery 0.8). */
export function defaultCourse(): string {
  return courseXml([
    {
      block: BLOCK,
      title: 'Block one',
      children: [
        {
          id: AU_ONE,
          title: 'One',
          url: 'one/index.html?paramA=1&paramB=2',
          moveOn: 'Completed',
          launchParameters: '{"level":1}',
          entitlementKey: 'ent-1',
        },
        { id: AU_TWO, title: 'Two', url: 'two/index.html', moveOn: 'Passed', masteryScore: '0.8' },
      ],
    },
  ]);
}

export function cmi5Zip(xml = defaultCourse(), files: Record<string, string> = {}) {
  return zip({ 'cmi5.xml': xml, 'one/index.html': page('One'), 'two/index.html': page('Two'), ...files });
}

export async function createCmi5Activity(
  lms: Coursekit,
  teacher: Client,
  courseId: string,
  sectionId: string,
  data: Uint8Array = cmi5Zip(),
  settings: Record<string, unknown> = {},
  maxGrade = 100,
  name = 'course.zip',
) {
  const activityId = await createPackageActivity(teacher, courseId, sectionId, settings, maxGrade);
  const res = await uploadPackage(lms, teacher, courseId, activityId, data, name);
  if (res.status !== 201) throw new Error(`Import failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { activityId, version: res.body };
}

export async function raw(lms: Coursekit, url: string, init: RequestInit = {}) {
  const res = await lms.fetch(new Request(url.startsWith('http') ? url : `http://localhost${url}`, init));
  const body = await res.text();
  let parsed: any = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** The AU side of a launch: reads the launch URL, fetches its credentials and talks to the LRS like an AU. */
export class AuSim {
  readonly url: URL;
  readonly endpoint: string;
  readonly fetchUrl: string;
  readonly actor: Record<string, unknown>;
  readonly registration: string;
  readonly activityId: string;
  auth: string | null = null;
  launchData: any = null;
  private started = Date.now();

  constructor(
    readonly lms: Coursekit,
    launchUrl: string,
  ) {
    this.url = new URL(launchUrl, 'http://localhost');
    const p = this.url.searchParams;
    this.endpoint = p.get('endpoint')!;
    this.fetchUrl = p.get('fetch')!;
    this.actor = JSON.parse(p.get('actor')!);
    this.registration = p.get('registration')!;
    this.activityId = p.get('activityId')!;
  }

  get sessionId(): string {
    return this.launchData.contextTemplate.extensions[EXT.sessionId];
  }

  async fetchToken() {
    const res = await raw(this.lms, this.fetchUrl, { method: 'POST' });
    if (res.body?.['auth-token']) this.auth = `Basic ${res.body['auth-token']}`;
    return res;
  }

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return raw(this.lms, `${this.endpoint}${path}`, {
      method,
      headers: {
        ...(this.auth ? { authorization: this.auth } : {}),
        'x-experience-api-version': '1.0.3',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  stateUrl(stateId: string) {
    return `activities/state?stateId=${encodeURIComponent(stateId)}&activityId=${encodeURIComponent(this.activityId)}&agent=${encodeURIComponent(JSON.stringify(this.actor))}&registration=${this.registration}`;
  }

  /** Fetches the credentials and reads LMS.LaunchData and the learner preferences, as an AU starts. */
  async start() {
    const token = await this.fetchToken();
    if (!this.auth) throw new Error(`fetch failed: ${JSON.stringify(token.body)}`);
    const data = await this.call('GET', this.stateUrl('LMS.LaunchData'));
    if (data.status !== 200) throw new Error(`LMS.LaunchData: ${data.status} ${JSON.stringify(data.body)}`);
    this.launchData = data.body;
    const prefs = await this.call(
      'GET',
      `agents/profile?profileId=cmi5LearnerPreferences&agent=${encodeURIComponent(JSON.stringify(this.actor))}`,
    );
    return { token: token.body, launchData: data.body, preferences: prefs };
  }

  /** A statement with the context template, the registration and (for cmi5 defined statements) the categories. */
  statement(
    verb: string,
    extra: { result?: unknown; allowed?: boolean; moveOn?: boolean; object?: unknown; extensions?: Record<string, unknown> } = {},
  ) {
    const template = this.launchData.contextTemplate;
    const categories = [...(extra.allowed ? [] : [{ id: CATEGORY }]), ...(extra.moveOn ? [{ id: MOVE_ON }] : [])];
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: this.actor,
      verb: { id: verb, display: { 'en-US': verb.split('/').pop() } },
      object: extra.object ?? { objectType: 'Activity', id: this.activityId },
      ...(extra.result !== undefined ? { result: extra.result } : {}),
      context: {
        registration: this.registration,
        contextActivities: { ...template.contextActivities, ...(categories.length ? { category: categories } : {}) },
        extensions: { ...template.extensions, ...extra.extensions },
      },
    };
  }

  duration() {
    return `PT${Math.max(1, Math.round((Date.now() - this.started) / 1000))}S`;
  }

  async send(statements: unknown) {
    return this.call('POST', 'statements', statements);
  }

  initialized() {
    return this.send(this.statement(VERB.initialized));
  }
  completed() {
    return this.send(this.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: this.duration() } }));
  }
  passed(scaled: number) {
    return this.send(
      this.statement(VERB.passed, {
        moveOn: true,
        result: { score: { scaled }, success: true, duration: this.duration() },
        extensions: this.launchData.masteryScore === undefined ? {} : { [EXT.masteryScore]: this.launchData.masteryScore },
      }),
    );
  }
  failed(scaled: number) {
    return this.send(
      this.statement(VERB.failed, {
        moveOn: true,
        result: { score: { scaled }, success: false, duration: this.duration() },
        extensions: this.launchData.masteryScore === undefined ? {} : { [EXT.masteryScore]: this.launchData.masteryScore },
      }),
    );
  }
  terminated(seconds = 60) {
    return this.send(this.statement(VERB.terminated, { result: { duration: `PT${seconds}S` } }));
  }
}

/** Launches an AU as `as` and returns the launch response and the AU simulator (started). */
export async function launchAu(lms: Coursekit, as: Client, activityId: string, body: Record<string, unknown> = {}, start = true) {
  const res = await as.post(`/api/packages/${activityId}/cmi5/launch`, body);
  if (res.status !== 200) throw new Error(`Launch failed: ${res.status} ${JSON.stringify(res.body)}`);
  const au = new AuSim(lms, res.body.url);
  if (start) await au.start();
  return { launch: res.body, au };
}

/** Statements of a registration in stored order. */
export async function statementsOf(lms: Coursekit, registration: string) {
  const rows = await lms.db
    .selectFrom('xapiStatements')
    .select(['statement', 'stored', 'id'])
    .where('registration', '=', registration)
    .orderBy('stored', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((r) => JSON.parse(r.statement));
}
