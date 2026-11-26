/**
 * Safe zip reading for uploaded content packages. The central directory is read here (so symlinks,
 * encryption and sizes can be checked before anything is inflated) and each entry is inflated with
 * fflate's streaming inflater, which stops as soon as an entry produces more than it declared.
 */
import { Inflate } from 'fflate';
import { readZip64End, readZip64Extra } from './zip64.js';

/** A problem with an uploaded package, explained for the teacher who uploaded it. */
export class PackageError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
}

export interface ZipLimits {
  /** Most files a package may contain. */
  maxFiles: number;
  /** Most bytes a package may expand to. */
  maxBytes: number;
}

export const DEFAULT_MAX_FILES = 20_000;
/** An entry bigger than this that compressed better than MAX_RATIO:1 is treated as a zip bomb. */
const RATIO_MIN_SIZE = 1024 * 1024;
const MAX_RATIO = 200;
const MAX_TOTAL_RATIO = 100;
const TOTAL_RATIO_MIN_SIZE = 50 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = crc ^ -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const u16 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number) => (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

/** Checks one entry name and returns it normalised (no leading "./"). Throws PackageError when it is unsafe. */
export function safeEntryName(raw: string): string {
  const shown = JSON.stringify(raw.slice(0, 120));
  if (raw.includes('\u0000')) throw new PackageError(`The zip contains a file name with a NUL byte (${shown}).`);
  if (raw.includes('\\'))
    throw new PackageError(`The zip contains a file name with a backslash (${shown}). Re-create the zip with a standard zip tool.`);
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new PackageError(`The zip contains an absolute path (${shown}).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new PackageError(`The zip contains a file name with control characters (${shown}).`);
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  if (name.length > 1024) throw new PackageError('The zip contains a file path that is too long.');
  const parts = name.split('/');
  const isDir = name.endsWith('/');
  for (const [i, part] of parts.entries()) {
    if (part === '..') throw new PackageError(`The zip contains a path that leaves the package folder (${shown}).`);
    if ((part === '' || part === '.') && !(isDir && i === parts.length - 1)) {
      throw new PackageError(`The zip contains an unusual path (${shown}). Re-create the zip with a standard zip tool.`);
    }
    if (part.length > 255) throw new PackageError('The zip contains a file name that is too long.');
  }
  return name;
}

/** Reads and checks the central directory. Directory entries are left out. */
export function readZipEntries(data: Uint8Array, limits: ZipLimits): ZipEntry[] {
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PackageError("That file isn't a zip archive (or it's damaged).");
  let total = u16(data, eocd + 10);
  let cdSize = u32(data, eocd + 12);
  let cdOffset = u32(data, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) ({ total, cdSize, cdOffset } = readZip64End(data, eocd));
  if (cdOffset + cdSize > data.length) throw new PackageError('The zip archive is damaged.');
  if (total > limits.maxFiles + 1000)
    throw new PackageError(`The package has too many files (the limit is ${limits.maxFiles.toLocaleString('en')}).`);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  let totalCompressed = 0;
  let pos = cdOffset;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (pos + 46 > data.length || u32(data, pos) !== 0x02014b50) throw new PackageError('The zip archive is damaged.');
    const madeBy = u16(data, pos + 4);
    const flags = u16(data, pos + 8);
    const method = u16(data, pos + 10);
    const crc = u32(data, pos + 16);
    let compressedSize = u32(data, pos + 20);
    let size = u32(data, pos + 24);
    const nameLength = u16(data, pos + 28);
    const extraLength = u16(data, pos + 30);
    const commentLength = u16(data, pos + 32);
    const external = u32(data, pos + 38);
    let offset = u32(data, pos + 42);
    if (pos + 46 + nameLength > data.length) throw new PackageError('The zip archive is damaged.');
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      ({ size, compressedSize, offset } = readZip64Extra(data, pos + 46 + nameLength, extraLength, { size, compressedSize, offset }));
    }
    const raw = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;

    const name = safeEntryName(raw);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000)
      throw new PackageError(`The zip contains a symbolic link (${JSON.stringify(name)}), which isn't allowed.`);
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new PackageError('The zip is encrypted. Upload a zip without a password.');
    if (method !== 0 && method !== 8)
      throw new PackageError(
        `"${name}" uses a compression method Coursekit can't read. Re-create the zip with standard (deflate) compression.`,
      );
    const key = name.toLowerCase();
    if (seen.has(key)) throw new PackageError(`The zip contains "${name}" twice (file names must be unique, ignoring case).`);
    seen.add(key);
    if (entries.length >= limits.maxFiles)
      throw new PackageError(`The package has too many files (the limit is ${limits.maxFiles.toLocaleString('en')}).`);
    if (method === 0 && size !== compressedSize) throw new PackageError('The zip archive is damaged.');
    // Stored data can't be smaller than its output, and deflate can't do better than about 1032:1.
    if (method === 8 && compressedSize > size + Math.ceil(size / 1000) + 1024) throw new PackageError(`"${name}" in the zip is damaged.`);
    if (size > RATIO_MIN_SIZE && size / Math.max(1, compressedSize) > MAX_RATIO) {
      throw new PackageError(`"${name}" compresses suspiciously well, so the package was refused as a possible zip bomb.`);
    }
    totalSize += size;
    totalCompressed += compressedSize;
    if (totalSize > limits.maxBytes) {
      throw new PackageError(`The package is too large once unzipped (the limit is ${Math.round(limits.maxBytes / 1024 / 1024)} MB).`);
    }
    entries.push({ name, method, compressedSize, size, crc, offset });
  }
  if (totalSize > TOTAL_RATIO_MIN_SIZE && totalSize / Math.max(1, totalCompressed) > MAX_TOTAL_RATIO) {
    throw new PackageError('The package compresses suspiciously well, so it was refused as a possible zip bomb.');
  }
  return entries;
}

function inflateCapped(input: Uint8Array, expected: number, name: string): Uint8Array {
  const out = new Uint8Array(expected);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > expected)
      throw new PackageError(`"${name}" expands to more than its declared size, so the package was refused.`);
    out.set(chunk, written);
    written += chunk.length;
  });
  const STEP = 16 * 1024;
  try {
    if (input.length === 0) inflater.push(new Uint8Array(0), true);
    for (let i = 0; i < input.length; i += STEP) inflater.push(input.subarray(i, i + STEP), i + STEP >= input.length);
  } catch (err) {
    if (err instanceof PackageError) throw err;
    throw new PackageError(`"${name}" in the zip is damaged.`);
  }
  if (written !== expected) throw new PackageError(`"${name}" in the zip is damaged.`);
  return out;
}

/** Inflates one entry, checking its size and CRC. */
export function extractEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const o = entry.offset;
  if (o + 30 > data.length || u32(data, o) !== 0x04034b50) throw new PackageError(`"${entry.name}" in the zip is damaged.`);
  const start = o + 30 + u16(data, o + 26) + u16(data, o + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) throw new PackageError(`"${entry.name}" in the zip is damaged.`);
  const raw = data.subarray(start, end);
  const out = entry.method === 0 ? raw : inflateCapped(raw, entry.size, entry.name);
  if (crc32(out) !== entry.crc) throw new PackageError(`"${entry.name}" in the zip is damaged (checksum mismatch).`);
  return out;
}
