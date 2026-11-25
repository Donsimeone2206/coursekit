# Contributing to Coursekit

Thanks for helping build an open LMS! This guide covers how the project is put together and what a good pull request looks like.

## Setup

```bash
npm install
npm run seed   # optional: demo courses and people (password: coursekit)
npm run dev    # API on :3000, web UI on http://localhost:5173
```

Requires Node.js 22.13+. SQLite needs nothing else. The `pg` driver is already a dev dependency, so to work against PostgreSQL just set `DATABASE_URL=postgres://...` before `npm run dev`.

Delete the `data/` folder to start over with a fresh database (you'll see the first-run setup wizard).

## Before you open a pull request

```bash
npm run format
npm run typecheck
npm test
npm run build
```

CI runs the same checks. Add or update tests in `test/` for any API behaviour you change.

## How the code is organised

- **`src/shared`** holds the API's data shapes (`types.ts`), the capability table (`permissions.ts`) and constants. Both the server and the UI import from here, so a change to an API response starts with its type.
- **`src/server/routes`** are small Hono routers. Each handler validates input with Zod (`readBody`, `readQuery`), loads access with `loadCourseAccess` / `loadActivityAccess`, checks a capability with `assertCan`, and returns a shared type.
- **`src/server/services`** contains logic shared between routes: progress, grading, the quiz engine, notifications.
- **`src/web/pages`** are route components; **`src/web/components/ui`** is the design system (Radix + Tailwind). Prefer the existing components over new one-off styles.

### Permissions

Never trust the client. Every route that touches a course must check a capability from `src/shared/permissions.ts`. If you need a new kind of permission, add a capability there and grant it to the right roles; the UI reads the same table.

### Database changes

Migrations live in `src/server/db/migrations` and are registered in `src/server/db/index.ts`.

1. Add a new file (e.g. `002_groups.ts`) exporting `up` (and ideally `down`). Never edit a migration that has been released.
2. Use snake_case names and only portable types (`text`, `integer`, `double precision`) so it runs on SQLite and PostgreSQL. Store booleans as `0/1`, timestamps as ISO strings and structured data as JSON text.
3. Update the table types in `src/server/db/schema.ts` (camelCase; Kysely's `CamelCasePlugin` maps the names).

### Adding an activity type

1. Add the type to `ActivityType` and its settings shape to `ActivitySettingsMap` in `src/shared/types.ts`, plus labels and defaults in `src/shared/constants.ts`.
2. Register it in `src/server/services/activity-types.ts` with a Zod schema for its settings.
3. Add a view in `src/web/pages/activities` and wire it into `ActivityPage.tsx`, the editor fields in `ActivityEditor.tsx`, and an icon in `src/web/lib/activity.ts`.

### Style

- TypeScript everywhere, `strict` mode. Server code uses `.js` extensions in relative imports (Node ESM).
- User-facing text: sentence case, plain words, no jargon. Error messages say what to do next.
- Keep dependencies few. The published package only depends on Hono, Kysely and Zod; the web UI is prebuilt.

## Reporting security issues

Please don't open public issues for vulnerabilities. Contact the maintainers privately so a fix can ship first.
