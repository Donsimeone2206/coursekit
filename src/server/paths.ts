import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * This file sits two levels below the package root in source (src/server) and, once bundled,
 * every entry point sits two levels below it too (dist/server, dist/cli).
 */
export const packageRoot = resolve(import.meta.dirname, '../..');

function readPackageJson(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  } catch {
    return {};
  }
}

export function packageVersion(): string {
  return readPackageJson().version ?? '0.0.0';
}

/** The npm package name (the installed command is always `coursekit`). */
export function packageName(): string {
  return readPackageJson().name ?? 'coursekit-lms';
}

/** Location of the prebuilt web UI, or null when it has not been built (e.g. in development). */
export function defaultWebDir(): string | null {
  const dir = resolve(packageRoot, 'dist/web');
  return existsSync(resolve(dir, 'index.html')) ? dir : null;
}
