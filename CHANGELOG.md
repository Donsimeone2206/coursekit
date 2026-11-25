# Changelog

## 0.1.1

Fixes found while verifying the first release from the npm registry.

- **Stale tabs after an upgrade.** Requests for files that don't exist (such as page files from an older build) now get a 404 instead of the app page, and a tab opened before an upgrade reloads to pick up the new build instead of failing to open pages. It reloads at most once per build and three times in five minutes, so a file that is really missing shows the error screen (with a Reload button) rather than reloading over and over.
- **CommonJS.** `require('coursekit-lms')` now works on every supported Node version, 22.13+ (the package `exports` map has a `default` condition). It returns the same module as `import`.
- **TypeScript.** The published declarations now reference Node's types themselves, so they work even when `node` isn't listed in `"types"` (TypeScript 7's default is `[]`). Optional options accept an explicit `undefined`, so code like `databaseUrl: process.env.DATABASE_URL` compiles under `exactOptionalPropertyTypes`. The types the programmatic API uses are exported too: `CreateUserInput`, `SeedDemoOptions`, `SeedDemoResult`, `AppEnv`, `AppDeps`, `DB` and `DatabaseKind`. The declarations no longer import `kysely/migration`, which TypeScript's older `node10` module resolution (the default for `"module": "commonjs"` in TypeScript 5) can't find.
- **`createUser()` no longer returns the password hash.** The programmatic `lms.createUser()` now returns the public user (the same shape the API uses). The HTTP API never exposed it.
- Added `npm run check:package`, which loads the built package with `require()` and `import()` and type-checks consumer code against it, in CI and before publishing.

## 0.1.0

First release: courses, lessons, resources, assignments, auto-graded quizzes, forums, gradebook, announcements, notifications, calendar and administration, with SQLite or PostgreSQL, a CLI and a programmatic API.
