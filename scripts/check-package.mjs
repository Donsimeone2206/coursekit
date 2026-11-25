// Checks the built package the way consumers load it. Run after `npm run build`.
// (TypeScript consumers are checked separately with `tsc -p test/consumer/tsconfig.json`.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package refers to itself by name, so this resolves through package.json "exports".
const require = createRequire(import.meta.url);

const viaRequire = require('coursekit-lms');
assert.equal(typeof viaRequire.createCoursekit, 'function', 'require("coursekit-lms") exposes createCoursekit');

const viaImport = await import('coursekit-lms');
assert.equal(viaImport.createCoursekit, viaRequire.createCoursekit, 'require() and import() load the same module');

const lms = await viaImport.createCoursekit({ databaseUrl: 'sqlite::memory:', webDir: false, dataDir: './data/check-package' });
const res = await lms.fetch(new Request('http://localhost/api/health'));
assert.equal(res.status, 200, 'health endpoint responds');
await lms.close();

console.log('✓ require() and import() both load coursekit-lms and it starts');

// The declarations reachable from the types entry must not import `kysely/migration`: that subpath only
// resolves through kysely's "exports" map, which TypeScript's legacy "node10" resolution ignores.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const seen = new Set();
const pending = [resolve(dirname(fileURLToPath(import.meta.url)), '..', pkg.exports['.'].types)];
while (pending.length) {
  const file = pending.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  assert.ok(!/['"]kysely\/migration['"]/.test(source), `${file} imports kysely/migration`);
  // Relative specifiers in `from '…'`, `import '…'` and inline `import("…")` types.
  for (const [, spec] of source.matchAll(/(?:from |import |import\()['"](\.{1,2}\/[^'"]+)['"]/g)) {
    pending.push(resolve(dirname(file), spec.replace(/\.js$/, '.d.ts')));
  }
}
console.log(`✓ ${seen.size} public declaration files, none import kysely/migration`);
