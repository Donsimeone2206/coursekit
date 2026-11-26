import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseScormManifest, parseTincan } from '../src/server/packages/manifest.js';
import { extractEntry, readZipEntries, safeEntryName } from '../src/server/packages/zip.js';
import { manifest12, manifest2004 } from './package-helpers.js';

const limits = { maxFiles: 20_000, maxBytes: 500 * 1024 * 1024 };
const read = (data: Uint8Array, l = limits) => readZipEntries(data, l);

/** Finds the central directory entry of the first file. */
function centralOffset(data: Uint8Array): number {
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x01 && data[i + 3] === 0x02) {
      // keep searching backwards for the first one
      let first = i;
      for (let j = i - 1; j >= 0; j--)
        if (data[j] === 0x50 && data[j + 1] === 0x4b && data[j + 2] === 0x01 && data[j + 3] === 0x02) first = j;
      return first;
    }
  }
  throw new Error('no central directory');
}

describe('safe extraction', () => {
  it('extracts normal entries', () => {
    const data = zipSync({ 'a/b.html': strToU8('<p>hi</p>'), 'c.txt': strToU8('x'.repeat(5000)) });
    const entries = read(data);
    expect(entries.map((e) => e.name)).toEqual(['a/b.html', 'c.txt']);
    expect(new TextDecoder().decode(extractEntry(data, entries[1]!))).toBe('x'.repeat(5000));
  });

  it('refuses unsafe names', () => {
    expect(() => safeEntryName('../x')).toThrow(/leaves the package/);
    expect(() => safeEntryName('a/../../x')).toThrow(/leaves the package/);
    expect(() => safeEntryName('/abs')).toThrow(/absolute/);
    expect(() => safeEntryName('C:/win')).toThrow(/absolute/);
    expect(() => safeEntryName('a\\b')).toThrow(/backslash/);
    expect(() => safeEntryName('a\u0000b')).toThrow(/NUL/);
    expect(() => safeEntryName('a//b')).toThrow(/unusual/);
    expect(safeEntryName('./a/b')).toBe('a/b');
  });

  it('refuses symlinks, duplicates ignoring case and encrypted entries', () => {
    const link = zipSync({ 'link.html': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
    expect(() => read(link)).toThrow(/symbolic link/);
    const dupes = zipSync({ 'Index.html': strToU8('a'), 'index.HTML': strToU8('b') });
    expect(() => read(dupes)).toThrow(/twice/);
    const encrypted = zipSync({ 'a.txt': strToU8('a') });
    encrypted[centralOffset(encrypted) + 8]! |= 1;
    expect(() => read(encrypted)).toThrow(/encrypted/);
  });

  it('enforces the file count and size limits', () => {
    const many = zipSync(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, strToU8('x')])));
    expect(() => read(many, { maxFiles: 5, maxBytes: 1e9 })).toThrow(/too many files/);
    const big = zipSync({ 'a.txt': strToU8('y'.repeat(2000)) }, { level: 0 });
    expect(() => read(big, { maxFiles: 10, maxBytes: 1000 })).toThrow(/too large once unzipped \(the limit is 0 MB\)/);
  });

  it('refuses zip bombs and entries that expand past their declared size', () => {
    const bomb = zipSync({ 'zeros.bin': new Uint8Array(30 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => read(bomb)).toThrow(/zip bomb/);

    const liar = zipSync({ 'a.txt': strToU8('a'.repeat(100_000)) });
    const at = centralOffset(liar);
    // Claim 2,000 bytes instead of 100,000 (and keep the CRC check from catching it first).
    new DataView(liar.buffer).setUint32(at + 24, 2000, true);
    const [entry] = read(liar);
    expect(() => extractEntry(liar, entry!)).toThrow(/more than its declared size/);
  });

  it('refuses archives that are not zips or are damaged', () => {
    expect(() => read(strToU8('hello'))).toThrow(/isn't a zip/);
    const data = zipSync({ 'a.txt': strToU8('abc'.repeat(100)) });
    const [entry] = read(data);
    data[data.length - 30]! ^= 0xff;
    expect(() => extractEntry(data, { ...entry!, crc: entry!.crc ^ 1 })).toThrow(/damaged/);
  });
});

describe('manifests', () => {
  const has = () => true;
  it('reads SCORM 1.2 items with mastery score, data from LMS and parameters', () => {
    const s = parseScormManifest(
      manifest12({
        items: [
          { id: 'a', href: 'a.html', mastery: 70, parameters: '?mode=x' },
          { id: 'b', href: 'b.html', type: 'asset' },
        ],
        base: 'pkg/',
      }),
      has,
    );
    expect(s).toMatchObject({ kind: 'scorm12', title: 'Test course' });
    expect(s.items).toMatchObject([
      { id: 'a', href: 'pkg/a.html?mode=x', masteryScore: 70, dataFromLms: 'launch-a', sco: true },
      { id: 'b', href: 'pkg/b.html', sco: false },
    ]);
  });

  it('detects SCORM 2004 editions', () => {
    expect(parseScormManifest(manifest2004('3rd Edition'), has).edition).toBe('3rd');
    expect(parseScormManifest(manifest2004('4th Edition'), has).edition).toBe('4th');
    expect(
      parseScormManifest(manifest2004('').replace('<schemaversion>2004 </schemaversion>', '<schemaversion>CAM 1.3</schemaversion>'), has)
        .edition,
    ).toBe('2nd');
  });

  it('refuses broken manifests, missing files and external launches', () => {
    expect(() => parseScormManifest('<manifest><organizations>', has)).toThrow(/could not be read/);
    expect(() => parseScormManifest(manifest12(), () => false)).toThrow(/isn't in the zip/);
    expect(() => parseScormManifest(manifest12({ items: [{ id: 'a', href: 'https://evil.example/x.html' }] }), has)).toThrow(
      /another website/,
    );
    expect(() => parseScormManifest('<manifest><organizations/><resources/></manifest>', has)).toThrow(/doesn't list anything/);
  });

  it('reads tincan.xml', () => {
    const xml = `<tincan xmlns="http://projecttincan.com/tincan.xsd"><activities><activity id="https://x.test/a" type="course"><name>A</name><launch lang="en">start.html?x=1</launch></activity></activities></tincan>`;
    expect(parseTincan(xml, has)).toMatchObject({
      kind: 'xapi',
      activityId: 'https://x.test/a',
      title: 'A',
      items: [{ href: 'start.html?x=1', path: 'start.html' }],
    });
    expect(() => parseTincan(xml.replace('https://x.test/a', 'not an iri'), has)).toThrow(/full IRI/);
  });
});
