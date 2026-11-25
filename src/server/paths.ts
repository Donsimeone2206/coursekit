import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * This file sits two levels below the package root in source (src/server) and, once bundled,
 * every entry point sits two levels below it too (dist/server, dist/cli).
 */
export const packageRoot = resolve(import.meta.dirname, '../..');

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Location of the prebuilt web UI, or null when it has not been built (e.g. in development). */
export function defaultWebDir(): string | null {
  const dir = resolve(packageRoot, 'dist/web');
  return existsSync(resolve(dir, 'index.html')) ? dir : null;
}
