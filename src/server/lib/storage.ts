import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Where uploaded files live. The default writes to the local disk; implement this
 * interface to store files in S3, R2, GCS and so on.
 */
export interface FileStorage {
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

export function createLocalStorage(root: string): FileStorage {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const full = resolve(base, key);
    if (full !== base && !full.startsWith(base + sep)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    async put(key, data) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    async get(key) {
      const path = pathFor(key);
      try {
        await stat(path);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
