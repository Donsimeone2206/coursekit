import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoursekit, type Coursekit } from '../src/server/index.js';
import { writeLmsDocument } from '../src/server/packages/cmi5/launch.js';
import { cmi5Secret, signCmi5Token } from '../src/server/packages/cmi5/tokens.js';
import { settle } from './completion-helpers.js';
import { createTestLms, login, PASSWORD, setupSchool, type Client } from './helpers.js';
import {
  AU_ONE,
  AU_TWO,
  AuSim,
  BLOCK,
  CATEGORY,
  EXT,
  MOVE_ON,
  NS,
  VERB,
  cmi5Zip,
  courseXml,
  createCmi5Activity,
  launchAu,
  raw,
  statementsOf,
} from './cmi5-helpers.js';
import type { PackagePlayerInfo } from '../src/shared/packages.js';
import { packageViewKind } from '../src/web/pages/activities/package-view.js';
import {
  commit,
  createPackageActivity,
  manifest12,
  page,
  scorm12Zip,
  scorm2004Zip,
  tokenOf,
  uploadPackage,
  zip,
} from './package-helpers.js';

let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeEach(async () => {
  lms = await createTestLms();
  school = await setupSchool(lms);
  await school.sam.post(`/api/courses/${school.course.id}/enrol`);
  await school.kim.post(`/api/courses/${school.course.id}/enrol`);
});
afterEach(async () => {
  await lms.close();
});

const one = (launch: { items: Array<{ id: string; launchable: boolean }> }) => launch.items.filter((i) => i.launchable)[0]!.id;
const two = (launch: { items: Array<{ id: string; launchable: boolean }> }) => launch.items.filter((i) => i.launchable)[1]!.id;
const verbs = async (registration: string) => (await statementsOf(lms, registration)).map((s) => s.verb.id.split('/').pop());
const attemptRow = () => lms.db.selectFrom('packageAttempts').selectAll().orderBy('attemptNumber', 'desc').executeTakeFirstOrThrow();
const prefsPath = (au: AuSim) => `agents/profile?profileId=cmi5LearnerPreferences&agent=${encodeURIComponent(JSON.stringify(au.actor))}`;
const countOf = async (table: 'xapiStatements' | 'cmi5Sessions') =>
  Number(
    (
      await lms.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

async function activity(xml?: string, settings: Record<string, unknown> = {}, maxGrade = 100) {
  return (
    await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId, xml ? cmi5Zip(xml) : undefined, settings, maxGrade)
  ).activityId;
}

describe('a packaged cmi5 course', () => {
  it('imports, launches, records statements, satisfies the course and grades it', async () => {
    const { activityId, version } = await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId, undefined, {}, 50);
    expect(version).toMatchObject({ kind: 'cmi5', title: 'Test cmi5 course' });
    expect(version.items.map((i: { title: string; launchable: boolean; depth: number }) => [i.title, i.launchable, i.depth])).toEqual([
      ['Block one', false, 0],
      ['One', true, 1],
      ['Two', true, 1],
    ]);
    // The uploaded zip itself is not kept.
    expect(await lms.db.selectFrom('files').selectAll().execute()).toEqual([]);

    const { launch, au } = await launchAu(lms, school.sam, activityId);
    expect(launch).toMatchObject({ mode: 'normal', display: 'embed', cmi5: { launchMode: 'Normal', external: false } });
    expect(launch.itemId).toBe(one(launch));
    expect((await au.initialized()).status).toBe(200);
    expect((await au.completed()).status).toBe(200);
    expect((await au.terminated()).status).toBe(200);

    const second = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    expect(second.au.registration).toBe(au.registration);
    expect(second.au.sessionId).not.toBe(au.sessionId);
    expect((await second.au.initialized()).status).toBe(200);
    expect((await second.au.passed(0.9)).status).toBe(200);
    expect((await second.au.terminated()).status).toBe(200);
    await settle(lms);

    expect(await verbs(au.registration)).toEqual([
      'launched',
      'initialized',
      'completed',
      'terminated',
      'launched',
      'initialized',
      'passed',
      'satisfied',
      'satisfied',
      'terminated',
    ]);
    const attempt = await attemptRow();
    expect(attempt).toMatchObject({ status: 'finished', completionStatus: 'completed', successStatus: 'passed', score: 0.9 });
    expect(attempt.totalSeconds).toBe(120);
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(45);
    expect(await lms.db.selectFrom('completions').selectAll().where('activityId', '=', activityId).execute()).toHaveLength(1);

    const info = await school.sam.get(`/api/packages/${activityId}/cmi5`);
    expect(info.body).toMatchObject({ attemptStatus: 'finished', course: { title: 'Test cmi5 course', satisfied: true } });
    expect(info.body.nodes.map((n: { title: string; status: string; review: boolean }) => [n.title, n.status, n.review])).toEqual([
      ['Block one', 'satisfied', false],
      ['One', 'completed', true],
      ['Two', 'passed', true],
    ]);
    expect(info.body.nodes[2]).toMatchObject({
      score: 90,
      moveOn: 'Passed',
      masteryScore: 0.8,
      launchMethod: 'AnyWindow',
      external: false,
    });
  });

  it('serves AU files sandboxed, without the SCORM run-time', async () => {
    const activityId = await activity();
    // The generic package launch launches cmi5 courses too.
    expect((await school.sam.post(`/api/packages/${activityId}/launch`, {})).body).toMatchObject({ cmi5: { launchMode: 'Normal' } });
    const { launch } = await launchAu(lms, school.sam, activityId, {}, false);
    expect(launch.url).toMatch(/^\/content\/[^/]+\/one\/index\.html\?paramA=1&paramB=2&endpoint=/);
    const res = await raw(lms, launch.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(res.body).not.toContain('__coursekit/runtime.js');
    expect(res.body).toContain('<title>One</title>');
  });
});

describe('importing cmi5 courses', () => {
  const upload = async (data: Uint8Array, name = 'course.zip') => {
    const activityId = (await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId)).activityId;
    return uploadPackage(lms, school.teacher, school.course.id, activityId, data, name);
  };

  it('reads nested blocks, objectives and every AU attribute', async () => {
    const xml = courseXml(
      [
        {
          block: 'https://example.test/outer',
          title: 'Outer',
          children: [
            {
              block: 'https://example.test/inner',
              title: 'Inner',
              children: [{ id: AU_ONE, url: 'one/index.html', objectives: ['https://example.test/obj'] }],
            },
            {
              id: AU_TWO,
              url: 'https://au.example.org/two?x=1',
              moveOn: 'CompletedOrPassed',
              masteryScore: '0.75',
              launchMethod: 'OwnWindow',
              activityType: 'http://adlnet.gov/expapi/activities/lesson',
              launchParameters: 'mode=quiz',
              entitlementKey: 'abc-123',
            },
          ],
        },
      ],
      { objectives: [{ id: 'https://example.test/obj', title: 'Know things' }] },
    );
    const res = await upload(cmi5Zip(xml));
    expect(res.status).toBe(201);
    expect(res.body.items.map((i: { title: string; depth: number }) => [i.title, i.depth])).toEqual([
      ['Outer', 0],
      ['Inner', 1],
      ['one', 2],
      ['two', 1],
    ]);
    const structure = JSON.parse((await lms.db.selectFrom('packageVersions').select('structure').executeTakeFirstOrThrow()).structure);
    expect(structure.cmi5.objectives).toEqual([
      { id: 'https://example.test/obj', title: { 'en-US': 'Know things' }, description: { 'en-US': 'Know things' } },
    ]);
    const au2 = structure.cmi5.children[0].children[1];
    expect(au2).toMatchObject({
      id: AU_TWO,
      url: 'https://au.example.org/two?x=1',
      external: true,
      moveOn: 'CompletedOrPassed',
      masteryScore: 0.75,
      launchMethod: 'OwnWindow',
      activityType: 'http://adlnet.gov/expapi/activities/lesson',
      launchParameters: 'mode=quiz',
      entitlementKey: 'abc-123',
    });
    const au1 = structure.cmi5.children[0].children[0].children[0];
    expect(au1).toMatchObject({
      moveOn: 'NotApplicable',
      launchMethod: 'AnyWindow',
      masteryScore: null,
      objectives: ['https://example.test/obj'],
    });
  });

  it('imports a cmi5.xml on its own, for AUs hosted elsewhere', async () => {
    const xml = courseXml([{ id: AU_ONE, url: 'https://au.example.org/one/index.html', moveOn: 'Completed' }]);
    const res = await upload(new TextEncoder().encode(xml), 'cmi5.xml');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'cmi5', fileCount: 1, fileName: 'cmi5.xml' });
    const relative = await upload(new TextEncoder().encode(courseXml([{ id: AU_ONE, url: 'one/index.html' }])), 'cmi5.xml');
    expect(relative.status).toBe(422);
    expect(relative.body.error.message).toMatch(/needs full addresses/);
  });

  it('keeps a zip with both imsmanifest.xml and cmi5.xml a SCORM package', async () => {
    const res = await upload(
      zip({ 'imsmanifest.xml': manifest12(), 'index.html': page('SCO'), 'cmi5.xml': courseXml([{ id: AU_ONE, url: 'index.html' }]) }),
    );
    expect(res.body).toMatchObject({ kind: 'scorm12' });
  });

  it('refuses invalid course structures with a clear message', async () => {
    const au = (attrs = '', url = 'one/index.html', extra = '') =>
      `<au id="${AU_ONE}" ${attrs}><title><langstring>One</langstring></title><description><langstring>d</langstring></description>${extra}<url>${url}</url></au>`;
    const doc = (
      body: string,
      course = `<course id="https://example.test/c"><title><langstring>C</langstring></title><description><langstring>d</langstring></description></course>`,
    ) => `<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">${course}${body}</courseStructure>`;
    const cases: Array<[string, RegExp]> = [
      ['<courseStructure><course id="x"/></courseStructure>', /cmi5 namespace/],
      ['<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"><course', /could not be read as XML/],
      [
        doc(
          au(),
          `<course id="not an iri"><title><langstring>C</langstring></title><description><langstring>d</langstring></description></course>`,
        ),
        /course id "not an iri" isn't an IRI/,
      ],
      [
        doc(
          `<block id="block"><title><langstring>B</langstring></title><description><langstring>d</langstring></description>${au()}</block>`,
        ),
        /block id "block" isn't an IRI/,
      ],
      [doc(au().replace(AU_ONE, 'au-one')), /AU id "au-one" isn't an IRI/],
      [doc(au() + au()), /is used twice/],
      [
        doc(
          `<block id="${BLOCK}"><title><langstring>B</langstring></title><description><langstring>d</langstring></description>${au()}</block><block id="${BLOCK}"><title><langstring>B</langstring></title><description><langstring>d</langstring></description>${au().replace(AU_ONE, AU_TWO)}</block>`,
        ),
        /is used twice/,
      ],
      [
        doc(
          au(),
          `<course id="https://example.test/c"><title><langstring>C</langstring></title><description><langstring>d</langstring></description></course><objectives><objective id="https://example.test/o"><title><langstring>O</langstring></title><description><langstring>d</langstring></description></objective><objective id="https://example.test/o"><title><langstring>O</langstring></title><description><langstring>d</langstring></description></objective></objectives>`,
        ),
        /objective id "https:\/\/example.test\/o" is used twice/,
      ],
      [doc(au('', 'one/index.html', '<objectives><objective idref="https://example.test/none"/></objectives>')), /doesn't define/],
      [doc(au('', 'missing.html')), /launches "missing.html", which isn't in the zip/],
      [doc(au('', 'one/index.html?endpoint=x')), /query parameter "endpoint"/],
      [doc(au('', 'one/index.html?activityId=x')), /query parameter "activityId"/],
      [doc(au('', 'one/my page.html')), /aren't allowed in a URL/],
      [doc(au('', 'ftp://example.test/au')), /http:\/\/ or https:\/\//],
      [doc(au('', '//example.test/au')), /needs a scheme/],
      [doc(au('moveOn="Finished"')), /moveOn value "Finished"/],
      [doc(au('launchMethod="NewTab"')), /launchMethod value "NewTab"/],
      [doc(au('masteryScore="1.5"')), /between 0 and 1/],
      [doc(au('masteryScore="high"')), /isn't a decimal/],
      [doc(au('masteryScore="0.12345"')), /4 decimal places/],
      [doc(au('colour="red"')), /unknown attribute "colour"/],
      [
        doc(`<au id="${AU_ONE}"><title><langstring>One</langstring></title><description><langstring>d</langstring></description></au>`),
        /needs <url>/,
      ],
      [
        doc(
          `<au id="${AU_ONE}"><url>one/index.html</url><title><langstring>One</langstring></title><description><langstring>d</langstring></description></au>`,
        ),
        /needs <title> before <url>/,
      ],
      [
        doc(`<block id="${BLOCK}"><title><langstring>B</langstring></title><description><langstring>d</langstring></description></block>`),
        /needs <au> or <block>/,
      ],
      [doc(''), /needs <au> or <block>/],
      [doc(`<lesson/>${au()}`), /can't contain <lesson>/],
      ['<!DOCTYPE x [<!ENTITY a "aaaa">]>' + doc(au()), /entity declarations/],
      // Sizes every launch copies into its session and its "launched" statement.
      [doc(au('', `https://au.example.org/${'a'.repeat(2030)}`)), /URL of AU "One" is too long \(at most 2,048 characters\)/],
      [
        doc(
          `<au id="${AU_ONE}"><title>${Array.from({ length: 51 }, (_, i) => `<langstring lang="en-x${i}">One</langstring>`).join('')}</title><description><langstring>d</langstring></description><url>one/index.html</url></au>`,
        ),
        /a <title> can have at most 50 <langstring> elements/,
      ],
    ];
    for (const [xml, message] of cases) {
      const res = await upload(cmi5Zip(xml));
      expect(res.status, String(message)).toBe(422);
      expect(res.body.error.message, xml.slice(0, 200)).toMatch(message);
      expect(res.body.error.message).toMatch(/^cmi5\.xml: /);
    }
    // A plain XML file that isn't a course structure is not a package.
    const other = await upload(new TextEncoder().encode('<manifest/>'), 'imsmanifest.xml');
    expect(other.body.error.message).toMatch(/isn't a zip/);
  });

  it('ignores extensions of other namespaces and accepts more than 1000 AUs', async () => {
    const aus = Array.from(
      { length: 1200 },
      (_, i) =>
        `<au id="https://example.test/au/${i}"><title><langstring>AU ${i}</langstring></title><description><langstring>d</langstring></description><url>https://au.example.org/${i}</url><ext:meta>x</ext:meta></au>`,
    );
    const xml = `<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd" xmlns:ext="https://example.test/ext"><course id="https://example.test/c" ext:flag="1"><title><langstring lang="fr">Cours</langstring><langstring lang="en">Course</langstring></title><description><langstring>d</langstring></description></course>${aus.join('')}</courseStructure>`;
    const res = await upload(new TextEncoder().encode(xml), 'cmi5.xml');
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Course');
    expect(res.body.items).toHaveLength(1200);
  });

  it('refuses AUs that point at Coursekit itself', async () => {
    const site = await createCoursekit({
      databaseUrl: 'sqlite::memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
      webDir: false,
      publicUrl: 'https://lms.example.edu',
    });
    try {
      const s = await setupSchool(site);
      const res = await createCmi5Activity(
        site,
        s.teacher,
        s.course.id,
        s.sectionId,
        cmi5Zip(courseXml([{ id: AU_ONE, url: 'https://lms.example.edu/content/x' }])),
      ).catch((e: Error) => e);
      expect(String(res)).toMatch(/points at this Coursekit site/);
    } finally {
      await site.close();
    }
  });

  it('imports ZIP64 archives', async () => {
    const res = await upload(zip64({ 'cmi5.xml': courseXml([{ id: AU_ONE, url: 'one/index.html' }]), 'one/index.html': page('One') }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'cmi5', fileCount: 2 });
  });

  it('keeps learners who started on their version when the course is replaced', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    const replaced = await uploadPackage(
      lms,
      school.teacher,
      school.course.id,
      activityId,
      cmi5Zip(courseXml([{ id: 'https://example.test/au/new', title: 'New', url: 'one/index.html' }])),
    );
    expect(replaced.body.version).toBe(2);
    const again = await launchAu(lms, school.sam, activityId);
    expect(again.launch.items.map((i: { title: string }) => i.title)).toEqual(['Block one', 'One', 'Two']);
    expect(
      (await school.kim.post(`/api/packages/${activityId}/cmi5/launch`, {})).body.items.map((i: { title: string }) => i.title),
    ).toEqual(['New']);
  });

  it('starts a new attempt on the replaced course, even when asked for an AU of the old one', async () => {
    const activityId = await activity(courseXml([{ id: AU_ONE, url: 'one/index.html', moveOn: 'Completed' }]), { attemptsAllowed: 3 });
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.completed();
    await au.terminated();
    const replaced = courseXml([{ id: 'https://example.test/au/new', title: 'New', url: 'two/index.html', moveOn: 'Completed' }]);
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, cmi5Zip(replaced))).status).toBe(201);
    // The page still shows the finished attempt, on the version it used.
    const info = await school.sam.get(`/api/packages/${activityId}/cmi5`);
    expect(info.body).toMatchObject({ attemptStatus: 'finished', version: 1 });
    expect(info.body.nodes.map((n: { title: string }) => n.title)).toEqual(['one']);

    const started = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { newAttempt: true, itemId: launch.itemId });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ mode: 'normal' });
    expect(started.body.items.map((i: { title: string }) => i.title)).toEqual(['New']);
    const attempts = () =>
      lms.db.selectFrom('packageAttempts').select(['attemptNumber', 'status']).orderBy('attemptNumber', 'asc').execute();
    expect(await attempts()).toEqual([
      { attemptNumber: 1, status: 'finished' },
      { attemptNumber: 2, status: 'in_progress' },
    ]);
    // Once something was launched in the attempt, an AU it doesn't have is refused.
    const unknown = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, {
      attemptId: started.body.attemptId,
      itemId: launch.itemId,
    });
    expect(unknown.status).toBe(400);

    // The player starts a new attempt without an AU.
    const next = (await launchAu(lms, school.sam, activityId, { attemptId: started.body.attemptId })).au;
    await next.initialized();
    await next.completed();
    await next.terminated();
    const third = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { newAttempt: true });
    expect(third.status).toBe(200);
    expect((await attempts()).map((a) => a.status)).toEqual(['finished', 'finished', 'in_progress']);
  });
});

/** A ZIP64 archive (stored entries, ZIP64 extra fields, ZIP64 end of central directory) built by hand. */
function zip64(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    parts.push(local, nameBytes, extra, data);
    const cExtra = Buffer.alloc(28);
    cExtra.writeUInt16LE(1, 0);
    cExtra.writeUInt16LE(24, 2);
    cExtra.writeBigUInt64LE(BigInt(data.length), 4);
    cExtra.writeBigUInt64LE(BigInt(data.length), 12);
    cExtra.writeBigUInt64LE(BigInt(offset), 20);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(45, 4);
    c.writeUInt16LE(45, 6);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(0xffffffff, 20);
    c.writeUInt32LE(0xffffffff, 24);
    c.writeUInt16LE(nameBytes.length, 28);
    c.writeUInt16LE(cExtra.length, 30);
    c.writeUInt32LE(0xffffffff, 42);
    central.push(c, nameBytes, cExtra);
    offset += local.length + nameBytes.length + extra.length + data.length;
  }
  const cd = Buffer.concat(central);
  const count = Object.keys(files).length;
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(count), 24);
  end64.writeBigUInt64LE(BigInt(count), 32);
  end64.writeBigUInt64LE(BigInt(cd.length), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end64, locator, end]));
}

describe('launching an AU', () => {
  it('passes the cmi5 launch parameters and writes LMS.LaunchData and the learner preferences first', async () => {
    const activityId = await activity();
    const res = await lms.app.request(`/api/packages/${activityId}/cmi5/launch`, {
      method: 'POST',
      headers: { cookie: school.sam.cookie, 'content-type': 'application/json', 'accept-language': 'fr-CA,fr;q=0.8,en;q=0.5,*;q=0.1' },
      body: '{}',
    });
    const launch = (await res.json()) as any;
    const au = new AuSim(lms, launch.url);
    const attempt = await attemptRow();
    expect(au.endpoint).toBe('http://localhost/xapi/');
    expect(au.fetchUrl).toMatch(/^http:\/\/localhost\/cmi5\/fetch\/c5f\./);
    expect(au.actor).toEqual({ objectType: 'Agent', name: 'Sam Student', account: { homePage: 'http://localhost', name: attempt.userId } });
    expect(JSON.stringify(au.actor)).not.toContain('@');
    expect(au.registration).toBe(attempt.registration);
    expect(au.activityId).toMatch(/^http:\/\/localhost\/xapi\/activities\/cmi5\/.+\/au\//);
    expect(au.activityId).not.toBe(AU_ONE);
    // Values are URL-encoded (spaces as %20, not +).
    expect(launch.url).toContain('Sam%20Student');

    const { launchData, preferences } = await au.start();
    expect(launchData).toEqual({
      contextTemplate: { contextActivities: { grouping: [{ id: AU_ONE }] }, extensions: { [EXT.sessionId]: launch.cmi5.sessionId } },
      launchMode: 'Normal',
      launchMethod: 'AnyWindow',
      moveOn: 'Completed',
      returnURL: `http://localhost/cmi5/return/${school.course.slug}/${activityId}`,
      launchParameters: '{"level":1}',
      entitlementKey: { courseStructure: 'ent-1' },
    });
    expect(preferences.body).toEqual({ languagePreference: 'fr-CA,fr,en', audioPreference: 'on' });

    const [launched] = await statementsOf(lms, au.registration);
    expect(launched).toMatchObject({
      actor: au.actor,
      verb: { id: VERB.launched },
      object: { id: au.activityId, definition: { name: { 'en-US': 'One' } } },
      authority: { name: 'Coursekit' },
      context: {
        registration: au.registration,
        contextActivities: { category: [{ id: CATEGORY }], grouping: [{ id: AU_ONE }] },
        extensions: {
          [EXT.sessionId]: launch.cmi5.sessionId,
          [EXT.launchMode]: 'Normal',
          [EXT.moveOn]: 'Completed',
          [EXT.launchParameters]: '{"level":1}',
        },
      },
    });
    const launchUrl = launched.context.extensions[EXT.launchUrl] as string;
    expect(launchUrl).toMatch(/^http:\/\/localhost\/content\/.+\/one\/index\.html\?paramA=1&paramB=2$/);

    // The same AU keeps its activity id in the registration; the other AU gets its own, with the mastery score.
    const again = await launchAu(lms, school.sam, activityId, { itemId: one(launch) });
    expect(again.au.activityId).toBe(au.activityId);
    const other = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    expect(other.au.activityId).not.toBe(au.activityId);
    expect(other.au.launchData).toMatchObject({ moveOn: 'Passed', masteryScore: 0.8 });
    const all = await statementsOf(lms, au.registration);
    expect(all.at(-1).context.extensions[EXT.masteryScore]).toBe(0.8);
  });

  it('keeps LMS.LaunchData and the learner preferences read-only for the AU', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId);
    const launchData = au.stateUrl('LMS.LaunchData');
    expect((await au.call('PUT', launchData, { launchMode: 'Normal' })).status).toBe(403);
    expect((await au.call('POST', launchData, { launchMode: 'Normal' })).status).toBe(403);
    expect((await au.call('DELETE', launchData)).status).toBe(403);
    expect((await au.call('PUT', au.stateUrl('bookmark'), { page: 2 })).status).toBe(204);
    const all = au.stateUrl('x').replace('stateId=x&', '');
    expect((await au.call('GET', all)).body).toEqual(['bookmark', 'LMS.LaunchData'].sort());
    expect((await au.call('DELETE', all)).status).toBe(204);
    expect((await au.call('GET', all)).body).toEqual(['LMS.LaunchData']);
    const prefs = `agents/profile?profileId=cmi5LearnerPreferences&agent=${encodeURIComponent(JSON.stringify(au.actor))}`;
    expect((await au.call('PUT', prefs, { languagePreference: 'de', audioPreference: 'off' }, { 'if-none-match': '*' })).status).toBe(403);
    expect((await au.call('DELETE', prefs)).status).toBe(403);
    expect((await au.call('GET', prefs)).body).toEqual({ languagePreference: 'en-US', audioPreference: 'on' });
  });

  it('always writes languagePreference, and the generic launch passes the browser languages', async () => {
    const activityId = await activity();
    const prefsOf = async (au: AuSim) => (await au.call('GET', prefsPath(au))).body;
    // The test client sends no Accept-Language: the default language.
    expect(await prefsOf((await launchAu(lms, school.sam, activityId)).au)).toEqual({ languagePreference: 'en-US', audioPreference: 'on' });
    const res = await lms.app.request(`/api/packages/${activityId}/launch`, {
      method: 'POST',
      headers: { cookie: school.sam.cookie, 'content-type': 'application/json', 'accept-language': 'de-CH, de;q=0.9, *;q=0.1' },
      body: '{}',
    });
    const generic = new AuSim(lms, ((await res.json()) as { url: string }).url);
    expect((await generic.start()).preferences.body).toEqual({ languagePreference: 'de-CH,de', audioPreference: 'on' });
    // A launch without usable languages keeps them.
    expect(await prefsOf((await launchAu(lms, school.sam, activityId)).au)).toEqual({
      languagePreference: 'de-CH,de',
      audioPreference: 'on',
    });
    // A document without languagePreference is written again.
    const sam = await attemptRow();
    await writeLmsDocument(
      lms.db,
      { activityId, kind: 'agent_profile', ownerId: sam.userId, activityIri: '', registration: '', docId: 'cmi5LearnerPreferences' },
      { audioPreference: 'on' },
    );
    expect(await prefsOf((await launchAu(lms, school.sam, activityId)).au)).toEqual({ languagePreference: 'en-US', audioPreference: 'on' });
  });

  it('answers AUs that join the endpoint and the path with "/"', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId, {}, false);
    expect(au.endpoint).toBe('http://localhost/xapi/');
    await au.fetchToken();
    // ${endpoint}/activities/state: /xapi//activities/state.
    const launchData = await au.call('GET', `/${au.stateUrl('LMS.LaunchData')}`);
    expect(launchData.status).toBe(200);
    au.launchData = launchData.body;
    expect((await au.call('GET', `/${prefsPath(au)}`)).status).toBe(200);
    expect((await au.call('POST', '/statements', au.statement(VERB.initialized))).status).toBe(200);
    expect((await au.call('PUT', `/${au.stateUrl('bookmark')}`, { page: 3 })).status).toBe(204);
    expect((await au.call('GET', `//${au.stateUrl('bookmark')}`)).body).toEqual({ page: 3 });
    expect((await au.call('GET', '/statements')).body.statements.map((s: any) => s.verb.id)).toEqual([VERB.initialized, VERB.launched]);
    expect((await raw(lms, '/xapi//about')).status).toBe(200);
    expect((await au.call('GET', '/nothing')).status).toBe(404);
  });

  it('refuses statements until the AU has read its learner preferences', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId, {}, false);
    await au.fetchToken();
    au.launchData = (await au.call('GET', au.stateUrl('LMS.LaunchData'))).body;
    const early = await au.initialized();
    expect(early.status).toBe(403);
    expect(early.body.error.message).toMatch(/Read the learner preferences/);
    // Listing the agent profiles isn't reading the preferences.
    expect((await au.call('GET', `agents/profile?agent=${encodeURIComponent(JSON.stringify(au.actor))}`)).body).toEqual([
      'cmi5LearnerPreferences',
    ]);
    expect((await au.initialized()).status).toBe(403);
    // A 404 counts as reading them, like a 200 (AuSim.start reads them in the other tests).
    await lms.db.deleteFrom('xapiDocuments').where('docId', '=', 'cmi5LearnerPreferences').execute();
    expect((await au.call('GET', prefsPath(au))).status).toBe(404);
    expect((await au.initialized()).status).toBe(200);
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized']);
  });

  it("keeps Coursekit's own statements within the statement size limit", async () => {
    const many = (tag: string) =>
      `<${tag}>${Array.from({ length: 50 }, (_, i) => `<langstring lang="en-x${i}">${'w'.repeat(1990)} ${i}</langstring>`).join('')}</${tag}>`;
    const xml = `<courseStructure xmlns="${NS}"><course id="https://example.test/c"><title><langstring>C</langstring></title><description><langstring>d</langstring></description></course><au id="${AU_ONE}">${many('title')}${many('description')}<url>one/index.html</url><launchParameters>${'p'.repeat(60_000)}</launchParameters></au></courseStructure>`;
    const activityId = await activity(xml);
    const { au } = await launchAu(lms, school.sam, activityId);
    // LMS.LaunchData has everything; the "launched" statement keeps one language and leaves the parameters out.
    expect(au.launchData.launchParameters).toHaveLength(60_000);
    const [row] = await lms.db.selectFrom('xapiStatements').select('statement').where('verbId', '=', VERB.launched).execute();
    expect(row!.statement.length).toBeLessThanOrEqual(32 * 1024);
    const launched = JSON.parse(row!.statement);
    expect(Object.keys(launched.object.definition.name)).toEqual(['en-x0']);
    expect(launched.object.definition.description['en-x0']).toHaveLength(500);
    expect(launched.context.extensions[EXT.launchParameters]).toBeUndefined();
    expect(launched.context.extensions[EXT.launchUrl]).toMatch(/one\/index\.html$/);
  });

  it('bounds the launches of an attempt, and keeps its own statements out of the AU allowance', async () => {
    const activityId = await activity();
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    const attempt = await attemptRow();
    // Fill the attempt up to one statement below the allowance of the AU (10,000), then launch a few times.
    const filler = Array.from({ length: 9_998 }, (_, i) => ({
      id: randomUUID(),
      activityId,
      courseId: attempt.courseId,
      userId: attempt.userId,
      attemptId: attempt.id,
      registration: attempt.registration,
      verbId: VERB.experienced,
      objectId: `https://example.test/page/${i}`,
      voided: 0,
      voidsId: null,
      statement: '{}',
      timestamp: new Date(0).toISOString(),
      stored: new Date(0).toISOString(),
    }));
    for (let i = 0; i < filler.length; i += 500)
      await lms.db
        .insertInto('xapiStatements')
        .values(filler.slice(i, i + 500))
        .execute();
    expect((await au.initialized()).status).toBe(200); // the AU's 9,999th
    let last = au;
    for (let i = 0; i < 5; i++) last = (await launchAu(lms, school.sam, activityId, { itemId: launch.itemId })).au;
    // The filler, the first "launched", "initialized", and 5 more "launched" and 5 "abandoned" from Coursekit.
    expect(await countOf('xapiStatements')).toBe(9_998 + 1 + 1 + 5 + 5);
    expect((await last.initialized()).status).toBe(200); // the AU's 10,000th
    const full = await last.send(last.statement(VERB.experienced, { allowed: true }));
    expect(full.status).toBe(403);
    expect(full.body.error.message).toMatch(/too many statements/);

    // An attempt takes at most 2,000 launches.
    const session = await lms.db.selectFrom('cmi5Sessions').selectAll().where('id', '=', last.sessionId).executeTakeFirstOrThrow();
    const clones = Array.from({ length: 1999 - (await countOf('cmi5Sessions')) }, () => ({
      ...session,
      id: randomUUID(),
      terminatedAt: session.launchedAt,
    }));
    for (let i = 0; i < clones.length; i += 400)
      await lms.db
        .insertInto('cmi5Sessions')
        .values(clones.slice(i, i + 400))
        .execute();
    expect((await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { itemId: launch.itemId })).status).toBe(200);
    const refused = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { itemId: launch.itemId });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/2,000 times/);
  });
});

describe('the fetch URL', () => {
  it('hands out the credentials once, then answers with the cmi5 error JSON', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId, {}, false);
    const preflight = await raw(lms, au.fetchUrl, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect((await raw(lms, au.fetchUrl)).status).toBe(405);
    const first = await au.fetchToken();
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toMatch(/^application\/json/);
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    expect(first.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.from(first.body['auth-token'], 'base64').toString()).toMatch(/^cmi5:c5a\./);
    const second = await raw(lms, au.fetchUrl, { method: 'POST' });
    expect(second).toMatchObject({ status: 200, body: { 'error-code': '1', 'error-text': expect.any(String) } });
    expect(second.body['auth-token']).toBeUndefined();
    const tampered = await raw(
      lms,
      au.fetchUrl.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      { method: 'POST' },
    );
    expect(tampered.body['error-code']).toBe('2');
    expect((await raw(lms, '/cmi5/fetch/nonsense', { method: 'POST' })).body['error-code']).toBe('2');
  });

  it('refuses expired fetch URLs and ended sessions', async () => {
    const activityId = await activity();
    const { au, launch } = await launchAu(lms, school.sam, activityId, {}, false);
    const expired = `http://localhost/cmi5/fetch/${signCmi5Token(await cmi5Secret(lms.db), 'fetch', launch.cmi5.sessionId, -60)}`;
    expect((await raw(lms, expired, { method: 'POST' })).body['error-code']).toBe('1');
    // Opening the activity again abandons the first session: its fetch URL no longer works.
    await launchAu(lms, school.sam, activityId, {}, false);
    expect((await au.fetchToken()).body['error-code']).toBe('1');
    // Someone who can no longer open the activity gets a security error.
    const third = await launchAu(lms, school.sam, activityId, {}, false);
    await school.teacher.patch(`/api/activities/${activityId}`, { visible: false });
    expect((await third.au.fetchToken()).body['error-code']).toBe('2');
  });

  it("limits the credentials to the learner's session and registration", async () => {
    const activityId = await activity();
    const sam = (await launchAu(lms, school.sam, activityId)).au;
    const kim = (await launchAu(lms, school.kim, activityId)).au;
    expect((await kim.initialized()).status).toBe(200);
    // Kim's credentials can't write to Sam's registration or as Sam, nor read Sam's documents.
    const asSam = { ...kim.statement(VERB.experienced, { allowed: true }), actor: sam.actor };
    expect((await kim.send(asSam)).status).toBe(403);
    const samRegistration = kim.statement(VERB.experienced, { allowed: true });
    samRegistration.context.registration = sam.registration;
    expect((await kim.send(samRegistration)).status).toBe(403);
    expect((await kim.call('GET', sam.stateUrl('LMS.LaunchData'))).status).toBe(403);
    // Tampered, missing and expired credentials.
    const tampered = new AuSim(lms, `/x?endpoint=${encodeURIComponent('http://localhost/xapi/')}&actor=%7B%7D`);
    tampered.auth = kim.auth!.replace(/.{4}$/, 'AAAA');
    expect((await tampered.call('GET', 'statements')).status).toBe(401);
    tampered.auth = null;
    expect((await tampered.call('GET', 'statements')).status).toBe(401);
    const expired = `Basic ${Buffer.from(`cmi5:${signCmi5Token(await cmi5Secret(lms.db), 'auth', kim.sessionId, -1)}`).toString('base64')}`;
    tampered.auth = expired;
    expect((await tampered.call('GET', 'statements')).status).toBe(401);
    // A learner who leaves the course loses access straight away.
    await lms.db
      .updateTable('enrolments')
      .set({ status: 'inactive' as never })
      .execute();
    expect((await kim.call('GET', 'statements')).status).toBe(403);
  });

  it("keeps the credentials out of the learner's other registrations: their documents and statements", async () => {
    const activityId = await activity(courseXml([{ id: AU_ONE, url: 'one/index.html', moveOn: 'Completed' }]), { attemptsAllowed: 2 });
    const first = (await launchAu(lms, school.sam, activityId)).au;
    expect((await first.call('PUT', first.stateUrl('bookmark'), { page: 7 })).status).toBe(204);
    await first.initialized();
    await first.completed();
    await first.terminated();
    const second = (await launchAu(lms, school.sam, activityId, { newAttempt: true })).au;
    expect(second.registration).not.toBe(first.registration);
    expect(second.activityId).toBe(first.activityId);
    const elsewhere = (stateId: string) => second.stateUrl(stateId).replace(second.registration, first.registration);
    const requests: Array<{ method: string; body?: unknown }> = [
      { method: 'GET' },
      { method: 'PUT', body: { page: 1, tampered: true } },
      { method: 'POST', body: { tampered: true } },
      { method: 'DELETE' },
    ];
    for (const { method, body } of requests) {
      const res = await second.call(method, elsewhere('bookmark'), body);
      expect(res.status, method).toBe(403);
      expect(res.body.error.message).toMatch(/launched registration/);
    }
    expect((await second.call('GET', elsewhere('LMS.LaunchData'))).status).toBe(403);
    expect((await second.call('GET', elsewhere('x').replace('stateId=x&', ''))).status).toBe(403);
    // A State API request without the registration is refused too.
    expect((await second.call('GET', second.stateUrl('bookmark').replace(`&registration=${second.registration}`, ''))).status).toBe(403);
    const saved = await lms.db
      .selectFrom('xapiDocuments')
      .select('content')
      .where('docId', '=', 'bookmark')
      .where('registration', '=', first.registration)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(Buffer.from(saved.content, 'base64').toString())).toEqual({ page: 7 });

    // Statements: only the session's registration is listed or found.
    expect((await second.call('GET', `statements?registration=${first.registration}`)).body.statements).toEqual([]);
    const own = (await second.call('GET', 'statements')).body.statements as Array<{ context: { registration: string } }>;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((s) => s.context.registration === second.registration)).toBe(true);
    const [earlier] = await statementsOf(lms, first.registration);
    expect((await second.call('GET', `statements?statementId=${earlier.id}`)).status).toBe(404);
    // The session's own registration works as before.
    expect((await second.call('PUT', second.stateUrl('bookmark'), { page: 1 })).status).toBe(204);
    expect((await second.call('GET', second.stateUrl('bookmark'))).body).toEqual({ page: 1 });
  });
});

describe('statement rules', () => {
  let activityId: string;
  let au: AuSim;
  let launch: any;
  beforeEach(async () => {
    activityId = await activity();
    ({ au, launch } = await launchAu(lms, school.sam, activityId, {}));
  });
  const rejected = async (statement: unknown, message: RegExp) => {
    const res = await au.send(statement);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toMatch(message);
  };
  const accepted = async (statement: unknown) => {
    const res = await au.send(statement);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const toTwo = async () => {
    ({ au } = await launchAu(lms, school.sam, activityId, { itemId: two(launch) }));
    await accepted(au.statement(VERB.initialized));
  };
  const passed = (scaled: number, extra: Record<string, unknown> = {}) =>
    au.statement(VERB.passed, {
      moveOn: true,
      result: { score: { scaled }, success: true, duration: 'PT1M', ...extra },
      extensions: { [EXT.masteryScore]: 0.8 },
    });
  const failed = (scaled: number) =>
    au.statement(VERB.failed, {
      moveOn: true,
      result: { score: { scaled }, success: false, duration: 'PT1M' },
      extensions: { [EXT.masteryScore]: 0.8 },
    });

  it('wants initialized first and nothing after terminated', async () => {
    await rejected(au.statement(VERB.experienced, { allowed: true }), /first statement of a session must be/);
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }), /first statement/);
    await rejected(au.statement(VERB.initialized, { allowed: true }), /first statement/);
    await accepted(au.statement(VERB.initialized));
    await rejected(au.statement(VERB.initialized), /already initialized/);
    await accepted(au.statement(VERB.experienced, { allowed: true }));
    await rejected(au.statement(VERB.terminated), /need result.duration/);
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT2M' } }));
    await rejected(au.statement(VERB.experienced, { allowed: true }), /no statements can follow "terminated"/);
    await rejected(au.statement(VERB.terminated, { result: { duration: 'PT2M' } }), /terminated/);
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'experienced', 'terminated']);
  });

  it('checks the actor, the registration, the id, the timestamp and the context template', async () => {
    await accepted(au.statement(VERB.initialized));
    const st = () => au.statement(VERB.experienced, { allowed: true });
    await rejected(
      { ...st(), actor: { objectType: 'Agent', account: { homePage: 'http://localhost', name: 'someone' } } },
      /launched learner/,
    );
    await rejected({ ...st(), context: { ...st().context, registration: randomUUID() } }, /launched registration/);
    const { id: _id, ...noId } = st();
    await rejected(noId, /needs an id/);
    const { timestamp: _t, ...noTime } = st();
    await rejected(noTime, /needs a timestamp/);
    await rejected({ ...st(), timestamp: '2026-01-01T10:00:00+02:00' }, /UTC/);
    await accepted({ ...st(), timestamp: '2026-01-01T10:00:00+00:00' });
    await rejected({ ...st(), context: { registration: au.registration } }, /contextActivities/);
    const noGrouping = st();
    noGrouping.context.contextActivities = { grouping: [{ id: 'https://example.test/other' }] } as never;
    await rejected(noGrouping, /publisher id/);
    const noSession = st();
    noSession.context.extensions = {};
    await rejected(noSession, /sessionid context extension .* missing/);
    const wrongSession = st();
    wrongSession.context.extensions = { [EXT.sessionId]: randomUUID() };
    await rejected(wrongSession, /not the one of this session/);
    await rejected(au.statement(VERB.voided, { allowed: true, object: { objectType: 'StatementRef', id: randomUUID() } }), /cannot void/);
  });

  it('checks cmi5 defined statements: verb, object, actor, categories and result', async () => {
    await accepted(au.statement(VERB.initialized));
    for (const verb of [VERB.launched, VERB.satisfied, VERB.abandoned, VERB.waived]) {
      await rejected(au.statement(verb, { result: { duration: 'PT1M' } }), /Only the LMS/);
    }
    await rejected(au.statement(VERB.experienced, { result: { duration: 'PT1M' } }), /isn't a cmi5 verb/);
    await accepted(
      au.statement(VERB.experienced, { allowed: true, object: { objectType: 'Activity', id: 'https://example.test/page/1' } }),
    );
    await rejected(
      au.statement(VERB.completed, {
        moveOn: true,
        object: { objectType: 'Activity', id: AU_ONE },
        result: { completion: true, duration: 'PT1M' },
      }),
      /must be the AU/,
    );
    const asGroup = au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } });
    asGroup.actor = { ...au.actor, objectType: 'Group' } as never;
    await rejected(asGroup, /launched learner/);
    await rejected(au.statement(VERB.experienced, { allowed: true, moveOn: true }), /moveon category/);
    await rejected(au.statement(VERB.terminated, { moveOn: true, result: { duration: 'PT1M' } }), /moveon category/);
    await rejected(au.statement(VERB.completed, { result: { completion: true, duration: 'PT1M' } }), /need the moveon category/);
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { duration: 'PT1M' } }), /result.completion set to true/);
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { completion: false, duration: 'PT1M' } }), /set to true/);
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { completion: true } }), /need result.duration/);
    await rejected(
      au.statement(VERB.completed, { moveOn: true, result: { completion: true, success: true, duration: 'PT1M' } }),
      /result.success/,
    );
    await rejected(
      au.statement(VERB.completed, { moveOn: true, result: { completion: true, score: { scaled: 1 }, duration: 'PT1M' } }),
      /a score/,
    );
    await rejected(au.statement(VERB.terminated, { moveOn: true, result: { completion: true, duration: 'PT1M' } }), /moveon category/);
    await accepted(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }));
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }), /already completed/);
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT2M' } }));
    // Completed at most once per registration, in later sessions too.
    ({ au } = await launchAu(lms, school.sam, activityId, { itemId: one(launch) }));
    expect(au.launchData.launchMode).toBe('Review');
    expect((await attemptRow()).completionStatus).toBe('incomplete');
  });

  it('checks passed and failed against the mastery score, once per session and registration', async () => {
    await toTwo();
    await rejected(passed(0.7), /at least the mastery score/);
    await rejected({ ...passed(0.9), result: { score: { scaled: 0.9 }, success: false, duration: 'PT1M' } }, /result.success set to true/);
    const noMastery = passed(0.9);
    noMastery.context.extensions = { [EXT.sessionId]: au.sessionId };
    await rejected(noMastery, /masteryscore context extension/);
    const wrongMastery = passed(0.9);
    wrongMastery.context.extensions = { ...wrongMastery.context.extensions, [EXT.masteryScore]: 0.5 };
    await rejected(wrongMastery, /masteryscore context extension/);
    await rejected(passed(-0.5), /between 0 and 1/);
    await rejected(
      au.statement(VERB.passed, {
        moveOn: true,
        result: { score: { raw: 9 }, success: true, duration: 'PT1M' },
        extensions: { [EXT.masteryScore]: 0.8 },
      }),
      /min and max/,
    );
    // 9.5.1: raw is an integer.
    await rejected(passed(0.9, { score: { scaled: 0.9, raw: 7.5, min: 0, max: 10 } }), /raw must be an integer/);
    await rejected(failed(0.85), /below the mastery score/);
    await accepted(failed(0.5));
    await rejected(failed(0.4), /one "passed" or "failed"/);
    await rejected(passed(0.9), /one "passed" or "failed"/);
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT1M' } }));
    expect(
      (
        await lms.db
          .selectFrom('cmi5AuStates')
          .select(['failedAt', 'passedAt', 'score'])
          .where('passedAt', 'is', null)
          .where('failedAt', 'is not', null)
          .executeTakeFirstOrThrow()
      ).score,
    ).toBe(0.5);

    // A failed AU can be tried again; once passed, neither passed nor failed can follow.
    await toTwo();
    expect(au.launchData.launchMode).toBe('Normal');
    await accepted(passed(0.9));
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT1M' } }));
    await toTwo().catch(() => {});
    expect(au.launchData.launchMode).toBe('Review');
    const attempt = await attemptRow();
    expect(attempt.score).toBe(0.9);
  });

  it('accepts an actor without objectType, which xAPI reads as an Agent', async () => {
    const bare = <T extends { actor: unknown }>(statement: T): T => {
      const copy = JSON.parse(JSON.stringify(statement));
      delete copy.actor.objectType;
      return copy;
    };
    await accepted(bare(au.statement(VERB.initialized)));
    await accepted(bare(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } })));
    const asGroup = au.statement(VERB.terminated, { result: { duration: 'PT1M' } });
    asGroup.actor = { ...au.actor, objectType: 'Group' } as never;
    await rejected(asGroup, /launched learner/);
    await accepted(bare(au.statement(VERB.terminated, { result: { duration: 'PT1M' } })));
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'completed', 'terminated']);
  });

  it('grades result.score.scaled only, which the mastery score is checked against', async () => {
    await toTwo();
    // A raw score without a scaled one: the mastery score can't be checked, and it gives no grade.
    await accepted(
      au.statement(VERB.failed, {
        moveOn: true,
        result: { score: { raw: 100, min: 0, max: 100 }, success: false, duration: 'PT1M' },
        extensions: { [EXT.masteryScore]: 0.8 },
      }),
    );
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT1M' } }));
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ successStatus: 'failed', score: null });
    expect(await lms.db.selectFrom('grades').selectAll().execute()).toEqual([]);
    // With both, the scaled score counts.
    await toTwo();
    await accepted(passed(0.9, { score: { scaled: 0.9, raw: 1, min: 0, max: 100 } }));
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ successStatus: 'unknown', score: 0.9 });
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(90);
  });

  it('refuses a second completed in a later session of the registration', async () => {
    // AU two (moveOn Passed, mastery score) isn't finished by "completed", so it opens in Normal mode again.
    await toTwo();
    await accepted(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }));
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT1M' } }));
    await toTwo();
    expect(au.launchData.launchMode).toBe('Normal');
    await rejected(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }), /already completed/);
    await accepted(passed(0.85));
  });

  it('refuses passed and failed after a pass in a later session', async () => {
    // AU one has no mastery score and moveOn Completed: passing it doesn't finish it until it is completed.
    await accepted(au.statement(VERB.initialized));
    await accepted(au.statement(VERB.passed, { moveOn: true, result: { success: true, duration: 'PT1M' } }));
    await accepted(au.statement(VERB.terminated, { result: { duration: 'PT1M' } }));
    ({ au } = await launchAu(lms, school.sam, activityId, { itemId: one(launch) }));
    expect(au.launchData.launchMode).toBe('Normal');
    await accepted(au.statement(VERB.initialized));
    await rejected(au.statement(VERB.passed, { moveOn: true, result: { success: true, duration: 'PT1M' } }), /already passed/);
    await rejected(au.statement(VERB.failed, { moveOn: true, result: { success: false, duration: 'PT1M' } }), /cannot follow "passed"/);
    await accepted(au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }));
  });

  it('stores all statements of a request or none', async () => {
    await accepted(au.statement(VERB.initialized));
    const ok = au.statement(VERB.experienced, { allowed: true });
    const bad = au.statement(VERB.experienced, { moveOn: true });
    expect((await au.send([ok, bad])).status).toBe(403);
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized']);
    // A batch keeps its order.
    const batch = [
      au.statement(VERB.experienced, { allowed: true }),
      au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } }),
      au.statement(VERB.terminated, { result: { duration: 'PT1M' } }),
    ];
    expect((await au.send(batch)).status).toBe(200);
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'experienced', 'completed', 'terminated']);
    // Sending the same statements again changes nothing.
    expect((await au.send(batch)).status).toBe(200);
  });

  it('lets only one of two concurrent completed statements through', async () => {
    await accepted(au.statement(VERB.initialized));
    const make = () => au.statement(VERB.completed, { moveOn: true, result: { completion: true, duration: 'PT1M' } });
    const statuses = (await Promise.all([au.send(make()), au.send(make())])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);
    expect((await verbs(au.registration)).filter((v) => v === 'completed')).toHaveLength(1);
  });
});

describe('satisfaction', () => {
  it('satisfies blocks and the course of NotApplicable AUs when the registration starts', async () => {
    const xml = courseXml([{ block: BLOCK, children: [{ id: AU_ONE, url: 'one/index.html' }] }]);
    const activityId = await activity(xml);
    const { au } = await launchAu(lms, school.sam, activityId);
    const all = await statementsOf(lms, au.registration);
    expect(all.map((s) => s.verb.id.split('/').pop())).toEqual(['satisfied', 'satisfied', 'launched']);
    expect(all[0]).toMatchObject({
      object: { definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/block' } },
      context: { contextActivities: { grouping: [{ id: BLOCK }] } },
    });
    expect(all[1]).toMatchObject({
      object: { definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/course' } },
      context: { contextActivities: { grouping: [{ id: 'https://example.test/course' }] } },
    });
    expect(all[1].object.id).not.toBe('https://example.test/course');
    expect(all[0].context.extensions[EXT.sessionId]).not.toBe(au.sessionId);
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ status: 'finished', completionStatus: 'completed' });
    // The first session still records the AU's results.
    await au.initialized();
    expect((await au.passed(1)).status).toBe(200);
    expect((await attemptRow()).score).toBe(1);
    expect(await verbs(au.registration)).toEqual(['satisfied', 'satisfied', 'launched', 'initialized', 'passed']);
  });

  it('satisfies inner blocks first, then outer blocks and the course, once each', async () => {
    const xml = courseXml([
      {
        block: 'https://example.test/outer',
        children: [
          { block: 'https://example.test/inner', children: [{ id: AU_ONE, url: 'one/index.html', moveOn: 'CompletedAndPassed' }] },
          { id: AU_TWO, url: 'two/index.html', moveOn: 'CompletedOrPassed' },
        ],
      },
    ]);
    const activityId = await activity(xml);
    const { launch, au } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.completed();
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'completed']);
    await au.passed(0.5);
    await au.terminated();
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'completed', 'passed', 'satisfied', 'terminated']);
    const second = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    await second.au.initialized();
    await second.au.completed();
    const all = await statementsOf(lms, au.registration);
    const satisfied = all.filter((s) => s.verb.id === VERB.satisfied).map((s) => s.context.contextActivities.grouping[0].id);
    expect(satisfied).toEqual(['https://example.test/inner', 'https://example.test/outer', 'https://example.test/course']);
    expect(all.at(-1).context.extensions[EXT.sessionId]).toBe(second.au.sessionId);
    await second.au.terminated();
    const info = await school.sam.get(`/api/packages/${activityId}/cmi5`);
    expect(info.body.nodes.map((n: { status: string }) => n.status)).toEqual(['satisfied', 'satisfied', 'passed', 'completed']);
    expect(await lms.db.selectFrom('cmi5Satisfied').selectAll().execute()).toHaveLength(3);
  });

  it("still records the AUs a learner hasn't finished once the course is satisfied", async () => {
    // A block with a reading to complete and an optional quiz (NotApplicable, with a mastery score).
    const xml = courseXml([
      {
        block: BLOCK,
        children: [
          { id: AU_ONE, url: 'one/index.html', moveOn: 'Completed' },
          { id: AU_TWO, url: 'two/index.html', masteryScore: '0.8' },
        ],
      },
    ]);
    const activityId = await activity(xml);
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.completed();
    await au.terminated();
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ status: 'finished', completionStatus: 'completed', successStatus: 'unknown', score: null });
    const toc = async () =>
      (await school.sam.get(`/api/packages/${activityId}/cmi5`)).body.nodes.map((n: { title: string; status: string; review: boolean }) => [
        n.title,
        n.status,
        n.review,
      ]);
    expect(await toc()).toEqual([
      ['Block', 'satisfied', false],
      ['one', 'completed', true],
      ['two', 'satisfied', false],
    ]);

    // The quiz the learner never opened launches in Normal mode, and its result counts.
    const quiz = await launchAu(lms, school.sam, activityId, { attemptId: launch.attemptId, itemId: two(launch) });
    expect(quiz.launch).toMatchObject({ mode: 'normal', attemptId: launch.attemptId, cmi5: { launchMode: 'Normal' } });
    expect(quiz.au.registration).toBe(au.registration);
    await quiz.au.initialized();
    expect((await quiz.au.passed(0.9)).status).toBe(200);
    expect((await quiz.au.terminated()).status).toBe(200);
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ status: 'finished', successStatus: 'passed', score: 0.9 });
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(90);
    expect(await toc()).toEqual([
      ['Block', 'satisfied', false],
      ['one', 'completed', true],
      ['two', 'passed', true],
    ]);
    // Once passed, it opens for review.
    const again = await launchAu(lms, school.sam, activityId, { attemptId: launch.attemptId, itemId: two(launch) });
    expect(again.au.launchData.launchMode).toBe('Review');
  });

  it('lets every AU of a course of NotApplicable AUs record, though the course is satisfied at the first launch', async () => {
    const xml = courseXml([
      { id: AU_ONE, url: 'one/index.html' },
      { id: AU_TWO, url: 'two/index.html', masteryScore: '0.5' },
    ]);
    const activityId = await activity(xml);
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ status: 'finished', completionStatus: 'completed' });
    await au.initialized();
    expect((await au.completed()).status).toBe(200);
    await au.terminated();
    const second = await launchAu(lms, school.sam, activityId, { attemptId: launch.attemptId, itemId: two(launch) });
    expect(second.au.launchData.launchMode).toBe('Normal');
    await second.au.initialized();
    expect((await second.au.completed()).status).toBe(200);
    expect((await second.au.passed(0.7)).status).toBe(200);
    await second.au.terminated();
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ successStatus: 'passed', score: 0.7 });
    // Both are finished now: reviews.
    const info = await school.sam.get(`/api/packages/${activityId}/cmi5`);
    expect(info.body.nodes.map((n: { review: boolean }) => n.review)).toEqual([true, true]);
  });
});

describe('abandoned sessions', () => {
  it('abandons a session that ends without terminated when the registration launches again', async () => {
    const activityId = await activity();
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    const next = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    const all = await statementsOf(lms, au.registration);
    const abandoned = all.find((s) => s.verb.id === VERB.abandoned);
    expect(abandoned).toMatchObject({
      actor: au.actor,
      object: { id: au.activityId },
      result: { duration: expect.stringMatching(/^PT[\d.]+S$/) },
      context: {
        registration: au.registration,
        contextActivities: { category: [{ id: CATEGORY }], grouping: [{ id: AU_ONE }] },
        extensions: { [EXT.sessionId]: au.sessionId },
      },
      authority: { name: 'Coursekit' },
    });
    expect(all.map((s) => s.verb.id.split('/').pop())).toEqual(['launched', 'initialized', 'abandoned', 'launched']);
    // Nothing more is recorded for the abandoned session.
    expect((await au.send(au.statement(VERB.experienced, { allowed: true }))).status).toBe(401);
    // A terminated session is not abandoned.
    await next.au.initialized();
    await next.au.terminated();
    await launchAu(lms, school.sam, activityId);
    expect((await verbs(au.registration)).filter((v) => v === 'abandoned')).toHaveLength(1);
  });

  it('abandons sessions nobody used for a long time', async () => {
    const activityId = await activity();
    const { au } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    const longAgo = new Date(Date.now() - 13 * 3600_000).toISOString();
    await lms.db.updateTable('cmi5Sessions').set({ lastActivityAt: longAgo }).execute();
    expect((await au.send(au.statement(VERB.experienced, { allowed: true }))).status).toBe(401);
    const session = await lms.db.selectFrom('cmi5Sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.abandonedAt).not.toBeNull();
    expect(await verbs(au.registration)).toEqual(['launched', 'initialized', 'abandoned']);

    // The activity page notices too.
    const again = await launchAu(lms, school.sam, activityId);
    await again.au.initialized();
    await lms.db.updateTable('cmi5Sessions').set({ lastActivityAt: longAgo }).where('abandonedAt', 'is', null).execute();
    await school.sam.get(`/api/packages/${activityId}/cmi5`);
    expect((await verbs(au.registration)).filter((v) => v === 'abandoned')).toHaveLength(2);
  });
});

describe('Browse and Review', () => {
  it('launches staff previews in Browse mode and records nothing', async () => {
    const activityId = await activity();
    const { au, launch } = await launchAu(lms, school.teacher, activityId);
    expect(launch).toMatchObject({ mode: 'browse', attemptId: null, cmi5: { launchMode: 'Browse' } });
    expect(au.launchData.launchMode).toBe('Browse');
    expect((await au.initialized()).status).toBe(200);
    expect((await au.completed()).status).toBe(403);
    expect((await au.send(au.statement(VERB.experienced, { allowed: true }))).status).toBe(200);
    expect((await au.terminated()).status).toBe(200);
    expect((await au.send(au.statement(VERB.experienced, { allowed: true }))).status).toBe(403);
    expect(await lms.db.selectFrom('xapiStatements').selectAll().execute()).toEqual([]);
    expect(await lms.db.selectFrom('packageAttempts').selectAll().execute()).toEqual([]);
    // State writes are accepted but not kept.
    expect((await au.call('PUT', au.stateUrl('bookmark'), { page: 1 })).status).toBe(204);
    expect((await au.call('GET', au.stateUrl('bookmark'))).status).toBe(404);
    const info = await school.teacher.get(`/api/packages/${activityId}/cmi5`);
    expect(info.body).toMatchObject({ attemptId: null, course: { satisfied: false } });
    expect(info.body.nodes.every((n: { status: string }) => n.status === 'not attempted')).toBe(true);
  });

  it('launches finished AUs and finished attempts in Review mode, where nothing counts', async () => {
    const activityId = await activity(undefined, { attemptsAllowed: 2 });
    const { au, launch } = await launchAu(lms, school.sam, activityId, {});
    await au.initialized();
    await au.completed();
    await au.terminated();
    const review = await launchAu(lms, school.sam, activityId, { itemId: one(launch) });
    expect(review.launch).toMatchObject({ mode: 'review', cmi5: { launchMode: 'Review' } });
    expect((await review.au.initialized()).status).toBe(200);
    expect((await review.au.completed()).status).toBe(403);
    expect((await review.au.terminated()).status).toBe(200);
    const launched = (await statementsOf(lms, au.registration)).filter((s) => s.verb.id === VERB.launched);
    expect(launched.at(-1).context.extensions[EXT.launchMode]).toBe('Review');

    const second = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    expect(second.au.launchData.launchMode).toBe('Normal');
    await second.au.initialized();
    await second.au.passed(0.8);
    await second.au.terminated();
    expect((await attemptRow()).status).toBe('finished');
    const again = await launchAu(lms, school.sam, activityId, { itemId: two(launch), attemptId: launch.attemptId });
    expect(again.au.launchData.launchMode).toBe('Review');
    expect((await again.au.initialized()).status).toBe(200);
    expect((await again.au.passed(1)).status).toBe(403);
    expect((await attemptRow()).score).toBe(0.8);
  });

  it("changes nothing that counts in Review mode: a teacher's grade override stays, in an archived course too", async () => {
    const activityId = await activity(courseXml([{ id: AU_ONE, url: 'one/index.html', moveOn: 'Passed', masteryScore: '0.8' }]));
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.passed(0.9);
    await au.terminated();
    await settle(lms);
    const finished = await attemptRow();
    expect(finished).toMatchObject({ status: 'finished', score: 0.9, totalSeconds: 60 });
    const grade = () =>
      lms.db.selectFrom('grades').select(['score', 'gradedBy']).where('activityId', '=', activityId).executeTakeFirstOrThrow();
    expect(await grade()).toMatchObject({ score: 90, gradedBy: null });
    const override = async (score: number) => {
      const res = await school.teacher.put(`/api/courses/${school.course.id}/grades/${activityId}/${finished.userId}`, { score });
      expect(res.status).toBe(200);
    };
    const review = async () => {
      const opened = await launchAu(lms, school.sam, activityId, { attemptId: launch.attemptId, itemId: launch.itemId });
      expect(opened.au.launchData.launchMode).toBe('Review');
      return opened.au;
    };
    const unchanged = async (score: number) => {
      await settle(lms);
      expect(await grade()).toMatchObject({ score });
      expect(await attemptRow()).toMatchObject({
        score: 0.9,
        totalSeconds: 60,
        lastAccessedAt: finished.lastAccessedAt,
        lastItemId: finished.lastItemId,
      });
      expect(await lms.db.selectFrom('cmi5AuStates').select(['sessions', 'totalSeconds']).executeTakeFirstOrThrow()).toEqual({
        sessions: 1,
        totalSeconds: 60,
      });
    };

    await override(40);
    // A Review launch, its statements and their time.
    const first = await review();
    await unchanged(40);
    expect((await first.initialized()).status).toBe(200);
    expect((await first.send(first.statement(VERB.experienced, { allowed: true }))).status).toBe(200);
    expect((await first.terminated(600)).status).toBe(200);
    await unchanged(40);
    // An abandoned Review session (abandoned by the next launch), with ten minutes to its last request.
    const second = await review();
    await second.initialized();
    await lms.db
      .updateTable('cmi5Sessions')
      .set({ launchedAt: new Date(Date.now() - 600_000).toISOString() })
      .where('id', '=', second.sessionId)
      .execute();
    await review();
    expect((await verbs(au.registration)).filter((v) => v === 'abandoned')).toHaveLength(1);
    await unchanged(40);

    // Archived: launches are Review, and the override stays.
    await override(30);
    expect((await school.teacher.patch(`/api/courses/${school.course.id}`, { visibility: 'archived' })).status).toBe(200);
    const archived = await review();
    expect((await archived.initialized()).status).toBe(200);
    expect((await archived.terminated(600)).status).toBe(200);
    await unchanged(30);
  });
});

describe('grades, completion and attempts', () => {
  const xml = courseXml([
    { id: AU_ONE, url: 'one/index.html', moveOn: 'Passed', masteryScore: '0.5' },
    { id: AU_TWO, url: 'two/index.html', moveOn: 'Passed', masteryScore: '0.5' },
  ]);
  async function play(as: Client, activityId: string, scores: number[], body: Record<string, unknown> = {}) {
    let first = true;
    for (const [i, scaled] of scores.entries()) {
      const { au, launch } = await launchAu(lms, as, activityId, first ? body : {});
      first = false;
      void launch;
      void i;
      await au.initialized();
      await (scaled >= 0.5 ? au.passed(scaled) : au.failed(scaled));
      await au.terminated();
    }
    await settle(lms);
  }

  it('grades the average of the scaled scores and completes the activity when the course is satisfied', async () => {
    const activityId = await activity(xml, {}, 10);
    await play(school.sam, activityId, [0.6]);
    expect((await attemptRow()).completionStatus).toBe('incomplete');
    expect(await lms.db.selectFrom('completions').selectAll().execute()).toEqual([]);
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(6);
    await play(school.sam, activityId, [0.9]);
    expect(await attemptRow()).toMatchObject({ status: 'finished', completionStatus: 'completed', score: 0.75 });
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(7.5);
    expect(await lms.db.selectFrom('completions').selectAll().execute()).toHaveLength(1);
  });

  it('needs every AU passed when a pass is required, and follows attempt limits and the grading method', async () => {
    const failing = courseXml([{ id: AU_ONE, url: 'one/index.html', moveOn: 'CompletedOrPassed', masteryScore: '0.5' }]);
    const activityId = await activity(failing, { requirePass: true, attemptsAllowed: 2, gradingMethod: 'last' }, 10);
    const { au } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.completed();
    await au.failed(0.3);
    await au.terminated();
    await settle(lms);
    expect(await attemptRow()).toMatchObject({ status: 'finished', completionStatus: 'completed', successStatus: 'failed', score: 0.3 });
    expect(await lms.db.selectFrom('completions').selectAll().execute()).toEqual([]);

    const info = await school.sam.get(`/api/packages/${activityId}`);
    expect(info.body).toMatchObject({ canStartNew: true });
    const second = await launchAu(lms, school.sam, activityId, { newAttempt: true });
    expect(second.au.registration).not.toBe(au.registration);
    expect(second.launch.mode).toBe('normal');
    await second.au.initialized();
    await second.au.passed(0.6);
    await second.au.terminated();
    await settle(lms);
    // "Last attempt" grading; the course isn't satisfied (CompletedOrPassed: passed is enough).
    expect((await lms.db.selectFrom('grades').select('score').executeTakeFirstOrThrow()).score).toBe(6);
    expect(await lms.db.selectFrom('completions').selectAll().execute()).toHaveLength(1);
    expect((await school.sam.get(`/api/packages/${activityId}`)).body.canStartNew).toBe(false);
    expect((await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { newAttempt: true })).status).toBe(403);
  });
});

describe('AUs hosted elsewhere', () => {
  it('launches the absolute URL with the cmi5 parameters, in a new window for OwnWindow', async () => {
    const xml = courseXml([
      { id: AU_ONE, url: 'https://au.example.org/one/index.html?lang=en#start', moveOn: 'Completed', launchMethod: 'OwnWindow' },
      { id: AU_TWO, url: 'https://au.example.org/two/', moveOn: 'Completed' },
    ]);
    const activityId = (
      await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId, new TextEncoder().encode(xml), {}, 100, 'cmi5.xml')
    ).activityId;
    const { launch, au } = await launchAu(lms, school.sam, activityId);
    expect(launch).toMatchObject({ display: 'window', cmi5: { external: true, launchMethod: 'OwnWindow' } });
    expect(launch.url).toMatch(
      /^https:\/\/au\.example\.org\/one\/index\.html\?lang=en&endpoint=http%3A%2F%2Flocalhost%2Fxapi%2F&fetch=.+#start$/,
    );
    await au.initialized();
    await au.completed();
    await au.terminated();
    const launched = (await statementsOf(lms, au.registration))[0];
    expect(launched.context.extensions[EXT.launchUrl]).toBe('https://au.example.org/one/index.html?lang=en#start');
    const second = await launchAu(lms, school.sam, activityId, { itemId: two(launch) });
    expect(second.launch).toMatchObject({ display: 'embed', cmi5: { external: true, launchMethod: 'AnyWindow' } });
  });

  it("won't launch an AU hosted on Coursekit's own address", async () => {
    const xml = courseXml([{ id: AU_ONE, url: 'http://localhost/content/fake/index.html' }]);
    const activityId = (
      await createCmi5Activity(lms, school.teacher, school.course.id, school.sectionId, new TextEncoder().encode(xml), {}, 100, 'cmi5.xml')
    ).activityId;
    const res = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/on this Coursekit site/);
  });
});

describe('access', () => {
  it("keeps learners out of other learners' attempts and staff reports", async () => {
    const activityId = await activity();
    const { launch } = await launchAu(lms, school.sam, activityId);
    expect((await school.kim.post(`/api/packages/${activityId}/cmi5/launch`, { attemptId: launch.attemptId })).status).toBe(404);
    expect((await school.sam.get(`/api/packages/${activityId}/cmi5/report`)).status).toBe(403);
    const outsider = await lms.createUser({ name: 'Out Sider', email: 'out@test.dev', password: PASSWORD });
    void outsider;
    const out = await login(lms, 'out@test.dev');
    expect((await out.get(`/api/packages/${activityId}/cmi5`)).status).toBe(403);
    expect((await out.post(`/api/packages/${activityId}/cmi5/launch`, {})).status).toBe(403);
  });

  it("limits the report to an assistant's own groups in separate groups", async () => {
    const base = `/api/courses/${school.course.id}`;
    await lms.createUser({ name: 'Tara Assistant', email: 'tara@test.dev', password: PASSWORD });
    await school.teacher.post(`${base}/participants`, { emails: ['tara@test.dev'], role: 'assistant' });
    const tara = await login(lms, 'tara@test.dev');
    const ids = Object.fromEntries(
      (await lms.db.selectFrom('users').select(['id', 'email']).execute()).map((u) => [u.email.split('@')[0], u.id]),
    );
    const group = (await school.teacher.post(`${base}/groups`, { name: 'Team A' })).body.id;
    await school.teacher.post(`${base}/groups/${group}/members`, { userIds: [ids.sam, ids.tara] });
    const activityId = await activity();
    await school.teacher.patch(`/api/activities/${activityId}`, { groupMode: 'separate' });
    const report = await tara.get(`/api/packages/${activityId}/cmi5/report`);
    expect(report.status).toBe(200);
    expect(report.body.rows.map((r: { user: { name: string } }) => r.user.name)).toEqual(['Sam Student']);
    expect((await school.teacher.get(`/api/packages/${activityId}/cmi5/report`)).body.rows).toHaveLength(2);
    expect(report.body.aus.map((a: { title: string }) => a.title)).toEqual(['One', 'Two']);
  });
});

describe('the return page', () => {
  it('tells the player the AU is done, or goes back to the activity', async () => {
    const activityId = await activity();
    const res = await raw(lms, `/cmi5/return/${school.course.slug}/${activityId}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`/courses/${school.course.slug}/activities/${activityId}`);
    expect(res.body).toContain("source: 'coursekit-cmi5'");
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
    const odd = await raw(lms, `/cmi5/return/${encodeURIComponent('"><script>')}/x`);
    expect(odd.body).not.toContain('<script>alert');
    expect(odd.body).toContain('location.replace("/")');
    expect((await raw(lms, '/cmi5/anything')).status).toBe(404);
  });
});

describe('demo data', () => {
  it('plays the hand-written screen reader course', async () => {
    const demo = await createTestLms();
    try {
      await demo.seedDemo({ password: 'demo-password' });
      const course = await demo.db.selectFrom('courses').select('id').where('slug', '=', 'ux-design-principles').executeTakeFirstOrThrow();
      const section = await demo.db
        .selectFrom('sections')
        .select('id')
        .where('courseId', '=', course.id)
        .where('title', '=', 'Accessibility')
        .executeTakeFirstOrThrow();
      const activities = await demo.db
        .selectFrom('activities')
        .select(['id', 'title', 'position'])
        .where('sectionId', '=', section.id)
        .orderBy('position', 'asc')
        .execute();
      expect(activities.map((a) => a.title)).toEqual([
        'Accessibility basics',
        'Colour contrast challenge',
        'Inclusive design',
        'Screen reader basics',
      ]);
      const cmi5 = activities.at(-1)!;
      const version = await demo.db.selectFrom('packageVersions').selectAll().where('activityId', '=', cmi5.id).executeTakeFirstOrThrow();
      expect(version.kind).toBe('cmi5');
      const maya = await login(demo, 'maya.chen@coursekit.test', 'demo-password');
      const report = await maya.get(`/api/packages/${cmi5.id}/cmi5/report`);
      const finished = report.body.rows.filter((r: { attempts: unknown[] }) => r.attempts.length);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ completed: true, attempts: [{ status: 'finished', satisfied: true }] });
      expect(Object.values(finished[0].attempts[0].aus).map((a: any) => a.status)).toEqual(['completed', 'passed']);
      expect(finished[0].grade).toBeGreaterThan(0);

      const alex = await login(demo, 'alex.johnson@coursekit.test', 'demo-password');
      const { au, launch } = await (async () => {
        const res = await alex.post(`/api/packages/${cmi5.id}/cmi5/launch`, {});
        const sim = new AuSim(demo, res.body.url);
        await sim.start();
        return { au: sim, launch: res.body };
      })();
      expect(launch.mode).toBe('normal');
      const html = await raw(demo, launch.url);
      expect(html.body).toContain('cmi5.js');
      expect((await au.initialized()).status).toBe(200);
    } finally {
      await demo.close();
    }
  });
});

describe('a package replaced by another kind', () => {
  const idle = { package: false, cmi5: false };
  const playerInfo = async (as: Client, activityId: string) => (await as.get(`/api/packages/${activityId}`)).body as PackagePlayerInfo;
  const attemptCount = async (activityId: string) =>
    (await lms.db.selectFrom('packageAttempts').select('id').where('activityId', '=', activityId).execute()).length;
  /** A SCORM 1.2 package activity whose SCO Sam opened (the attempt is in progress); finish() passes it with 90. */
  async function scorm12Started(settings: Record<string, unknown>) {
    const activityId = await createPackageActivity(school.teacher, school.course.id, school.sectionId, settings);
    await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip());
    const launched = await school.sam.post(`/api/packages/${activityId}/launch`, {});
    expect(launched.status).toBe(200);
    const finish = async () => {
      const ops = [
        ['cmi.core.score.raw', '90'],
        ['cmi.core.lesson_status', 'passed'],
      ];
      expect((await commit(lms, tokenOf(launched.body.url), { ops, terminate: true })).body.recorded).toBe(true);
      await settle(lms);
    };
    return { activityId, finish };
  }

  it('answers 409 to a cmi5 launch of a version that is not a cmi5 course, before starting an attempt', async () => {
    const activityId = await activity(courseXml([{ id: AU_ONE, url: 'one/index.html', moveOn: 'Completed' }]), { attemptsAllowed: 3 });
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    await au.completed();
    await au.terminated();
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip())).status).toBe(201);
    const cmi5Launch = (as: Client, body: Record<string, unknown>) => as.post(`/api/packages/${activityId}/cmi5/launch`, body);

    // The page still shows the cmi5 course: its Start and Start a new attempt, and a staff preview.
    for (const [as, body] of [
      [school.sam, { newAttempt: true }],
      [school.kim, { itemId: launch.itemId }],
      [school.kim, {}],
      [school.teacher, { preview: true, itemId: launch.itemId }],
    ] as const) {
      const res = await cmi5Launch(as, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('Reload the page') });
    }
    expect(await attemptCount(activityId)).toBe(1);
    // Sam's finished cmi5 attempt keeps its version, and still opens there.
    const review = await cmi5Launch(school.sam, { attemptId: launch.attemptId, itemId: launch.itemId });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ mode: 'review', cmi5: { launchMode: 'Review' } });

    // A SCORM 2004 attempt opens through the generic launch only.
    const scorm = await school.sam.post(`/api/packages/${activityId}/launch`, { newAttempt: true });
    expect(scorm.body.sequencing).toBeDefined();
    expect((await cmi5Launch(school.sam, {})).status).toBe(409);
    expect((await cmi5Launch(school.sam, { attemptId: scorm.body.attemptId, itemId: launch.itemId })).status).toBe(409);

    // Replaced by SCORM 1.2, where the AU isn't an item either: still 409, and Kim has no attempt.
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm12Zip())).status).toBe(201);
    expect((await cmi5Launch(school.kim, { itemId: launch.itemId })).status).toBe(409);
    expect((await cmi5Launch(school.kim, { newAttempt: true })).status).toBe(409);
    expect(await attemptCount(activityId)).toBe(2);
  });

  it('opens a cmi5 attempt in the cmi5 player once SCORM replaced the course, AU by AU', async () => {
    const activityId = await activity(
      courseXml([
        { id: AU_ONE, url: 'one/index.html', moveOn: 'Completed' },
        { id: AU_TWO, url: 'two/index.html', moveOn: 'NotApplicable' },
      ]),
    );
    const { au, launch } = await launchAu(lms, school.sam, activityId);
    await au.initialized();
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, scorm2004Zip())).status).toBe(201);
    // The unfinished cmi5 attempt keeps its version.
    expect(packageViewKind(await playerInfo(school.sam, activityId), idle)).toBe('cmi5');
    await au.completed();
    await au.terminated();
    await settle(lms);

    const info = await playerInfo(school.sam, activityId);
    expect(info).toMatchObject({ resumeAttemptId: null, canStartNew: true, launchVersion: { kind: 'scorm2004' } });
    expect(info.attempts.map((a) => [a.kind, a.status])).toEqual([['cmi5', 'finished']]);
    // The AU playing keeps the cmi5 player; afterwards, the finished attempt shows there too (not in the SCORM
    // player, where its Review would launch Two in Normal mode).
    expect(packageViewKind(info, { package: false, cmi5: true })).toBe('cmi5');
    expect(packageViewKind(info, idle)).toBe('cmi5');
    expect(packageViewKind(await playerInfo(school.teacher, activityId), idle)).toBe('package');
    const toc = (await school.sam.get(`/api/packages/${activityId}/cmi5`)).body;
    expect(toc).toMatchObject({ attemptId: launch.attemptId, attemptStatus: 'finished', course: { satisfied: true } });
    const nodeTwo = toc.nodes.find((n: { key: string }) => n.key === two(launch));
    expect(nodeTwo).toMatchObject({ status: 'satisfied', review: false });
    const openTwo = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { attemptId: launch.attemptId, itemId: two(launch) });
    expect(openTwo.body).toMatchObject({ mode: 'normal', cmi5: { launchMode: 'Normal' } });

    // Its Start a new attempt starts the SCORM 2004 package with the generic launch, which PackageView plays.
    const started = await school.sam.post(`/api/packages/${activityId}/launch`, { newAttempt: true });
    expect(started.body.sequencing).toBeDefined();
    expect(packageViewKind(await playerInfo(school.sam, activityId), idle)).toBe('package');
  });

  it('keeps the SCORM player open while its attempt finishes after a cmi5 upload, then reviews it from the cmi5 view', async () => {
    const { activityId, finish } = await scorm12Started({ attemptsAllowed: 2 });
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, cmi5Zip())).status).toBe(201);
    expect(packageViewKind(await playerInfo(school.sam, activityId), idle)).toBe('package');
    await finish();

    const info = await playerInfo(school.sam, activityId);
    expect(info).toMatchObject({ resumeAttemptId: null, canStartNew: true, launchVersion: { kind: 'cmi5' } });
    expect(info.attempts.map((a) => [a.kind, a.status, a.successStatus])).toEqual([['scorm12', 'finished', 'passed']]);
    // The SCORM player stays while it is open, even though the next attempt would be the cmi5 course.
    expect(packageViewKind(info, { package: true, cmi5: false })).toBe('package');
    expect(packageViewKind(info, idle)).toBe('cmi5');
    // Cmi5View's contents have no attempt for it: the summary shows the SCORM attempt and reviews it in PackageView.
    expect((await school.sam.get(`/api/packages/${activityId}/cmi5`)).body).toMatchObject({ attemptId: null, attemptStatus: null });
    const review = await school.sam.post(`/api/packages/${activityId}/launch`, { attemptId: info.attempts[0]!.id });
    expect(review.body).toMatchObject({ mode: 'review' });
    expect(review.body.cmi5).toBeUndefined();
    const report = await school.teacher.get(`/api/packages/${activityId}/cmi5/report`);
    const row = report.body.rows.find((r: { attempts: unknown[] }) => r.attempts.length);
    expect(row.attempts).toMatchObject([{ kind: 'scorm12', status: 'finished', successStatus: 'passed', score: 90, aus: {} }]);

    // An AU of the contents starts the new cmi5 attempt.
    const first = (await school.sam.get(`/api/packages/${activityId}/cmi5`)).body.nodes.find((n: { kind: string }) => n.kind === 'au');
    const started = await school.sam.post(`/api/packages/${activityId}/cmi5/launch`, { itemId: first.key });
    expect(started.body).toMatchObject({ mode: 'normal', itemId: first.key });
    expect((await playerInfo(school.sam, activityId)).attempts.map((a) => [a.kind, a.status])).toEqual([
      ['scorm12', 'finished'],
      ['cmi5', 'in_progress'],
    ]);
  });

  it('shows a finished SCORM attempt in the SCORM player when no new attempt is left', async () => {
    const { activityId, finish } = await scorm12Started({ attemptsAllowed: 1 });
    await finish();
    expect((await uploadPackage(lms, school.teacher, school.course.id, activityId, cmi5Zip())).status).toBe(201);
    const info = await playerInfo(school.sam, activityId);
    expect(info).toMatchObject({ resumeAttemptId: null, canStartNew: false });
    expect(info.attempts.map((a) => [a.kind, a.successStatus, a.score])).toEqual([['scorm12', 'passed', 90]]);
    expect(packageViewKind(info, idle)).toBe('package');
    expect(packageViewKind(await playerInfo(school.teacher, activityId), idle)).toBe('cmi5');
  });
});

it('keeps the category and moveon IRIs of the specification', () => {
  expect(CATEGORY).toBe('https://w3id.org/xapi/cmi5/context/categories/cmi5');
  expect(MOVE_ON).toBe('https://w3id.org/xapi/cmi5/context/categories/moveon');
});
