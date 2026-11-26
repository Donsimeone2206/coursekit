/**
 * ZIP64 records (PKWARE APPNOTE 4.3.14 to 4.3.15 and 4.5.3): the end of central directory and the extended
 * sizes and offsets of entries. cmi5 asks LMSs to import 64-bit zips (section 14), and some zip tools write
 * these records even for small archives. The archive still has to fit the package size limits.
 */
import { PackageError } from './zip.js';

const u16 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number) => (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

function u64(d: Uint8Array, o: number): number {
  const value = u32(d, o) + u32(d, o + 4) * 2 ** 32;
  if (!Number.isSafeInteger(value)) throw new PackageError('The zip archive is damaged.');
  return value;
}

/** Reads the ZIP64 end of central directory record that the locator before the classic record points to. */
export function readZip64End(data: Uint8Array, eocd: number): { total: number; cdSize: number; cdOffset: number } {
  const locator = eocd - 20;
  if (locator < 0 || u32(data, locator) !== 0x07064b50) throw new PackageError('The zip archive is damaged.');
  const at = u64(data, locator + 8);
  if (at + 56 > data.length || u32(data, at) !== 0x06064b50) throw new PackageError('The zip archive is damaged.');
  if (u32(data, at + 16) !== 0 || u32(data, at + 20) !== 0)
    throw new PackageError('Zip archives split over several files are not supported.');
  return { total: u64(data, at + 32), cdSize: u64(data, at + 40), cdOffset: u64(data, at + 48) };
}

/**
 * Replaces the 32-bit sizes and offset of a central directory entry that are 0xffffffff with the values of its
 * ZIP64 extra field (header id 0x0001), which lists them in this order.
 */
export function readZip64Extra(
  data: Uint8Array,
  extraStart: number,
  extraLength: number,
  values: { size: number; compressedSize: number; offset: number },
): { size: number; compressedSize: number; offset: number } {
  const out = { ...values };
  let pos = extraStart;
  const end = Math.min(extraStart + extraLength, data.length);
  while (pos + 4 <= end) {
    const id = u16(data, pos);
    const length = u16(data, pos + 2);
    if (pos + 4 + length > end) break;
    if (id === 0x0001) {
      let p = pos + 4;
      const take = () => {
        if (p + 8 > pos + 4 + length) throw new PackageError('The zip archive is damaged.');
        const v = u64(data, p);
        p += 8;
        return v;
      };
      if (values.size === 0xffffffff) out.size = take();
      if (values.compressedSize === 0xffffffff) out.compressedSize = take();
      if (values.offset === 0xffffffff) out.offset = take();
      return out;
    }
    pos += 4 + length;
  }
  throw new PackageError('The zip archive is damaged (a ZIP64 entry has no ZIP64 sizes).');
}
