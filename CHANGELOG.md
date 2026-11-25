# Changelog

## 0.1.2

- **`seedDemo()` without a password no longer locks you out.** On a site with no administrator, `lms.seedDemo()` creates `admin@coursekit.test` with a random password; it now returns that password instead of `null`. The CLI was not affected: `coursekit seed --demo` uses `coursekit` unless you pass `--password`.
- Docs: with `skipLibCheck` off, the type definitions need TypeScript 5.7 or newer. The 0.1.1 notes now say which tabs reload themselves after an upgrade.

## 0.1.1

Fixes found while verifying the first release from the npm registry.

- **Stale tabs after an upgrade.** Requests for files that don't exist (such as page files from an older build) now get a 404 instead of the app page, and a tab running 0.1.1 or later reloads to pick up a newer build after an upgrade instead of failing to open pages. It reloads at most once per build within five minutes, and three times in five minutes in all, so a file that is really missing shows the error screen (with a Reload button) rather than reloading over and over. Tabs opened on 0.1.0 don't have this code: after upgrading from 0.1.0, an open tab shows the error screen the first time it opens a page it hasn't loaded yet, and its Reload button fixes it.
- **CommonJS.** `require('coursekit-lms')` now works on every supported Node version, 22.13+ (the package `exports` map has a `default` condition). It returns the same module as `import`.
- **TypeScript.** The published declarations now reference Node's types themselves, so they work even when `node` isn't listed in `"types"` (TypeScript 7's default is `[]`). Optional options accept an explicit `undefined`, so code like `databaseUrl: process.env.DATABASE_URL` compiles under `exactOptionalPropertyTypes`. The types the programmatic API uses are exported too: `CreateUserInput`, `SeedDemoOptions`, `SeedDemoResult`, `AppEnv`, `AppDeps`, `DB` and `DatabaseKind`. The declarations no longer import `kysely/migration`, which TypeScript's older `node10` module resolution (the default for `"module": "commonjs"` in TypeScript 5) can't find.
- **`createUser()` no longer returns the password hash.** The programmatic `lms.createUser()` now returns the public user (the same shape the API uses). The HTTP API never exposed it.
- Added `npm run check:package`, which loads the built package with `require()` and `import()` and type-checks consumer code against it, in CI and before publishing.

## 0.1.0

First release: courses, lessons, resources, assignments, auto-graded quizzes, forums, gradebook, announcements, notifications, calendar and administration, with SQLite or PostgreSQL, a CLI and a programmatic API.
