# Coursekit

[![CI](https://github.com/Donsimeone2206/coursekit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Donsimeone2206/coursekit/actions/workflows/ci.yml)

**An open-source learning management system for Node.js.** Courses, lessons, assignments, auto-graded quizzes, forums and a gradebook, with a fast, modern interface. Think Moodle, rebuilt for today's web.

```bash
npx coursekit start
```

Open http://localhost:3000 and the setup wizard walks you through creating your site, with optional demo content.

![Dashboard](docs/screenshots/dashboard.jpg)

| Course page                                 | Gradebook                                    | Dark mode                                    |
| ------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| ![Course page](docs/screenshots/course.jpg) | ![Gradebook](docs/screenshots/gradebook.jpg) | ![Dark mode](docs/screenshots/dark-mode.jpg) |

## Features

**Teaching and learning**

- Courses organised into sections (weeks, topics or modules), with drafts, publishing and archiving
- Five activity types: **lessons** (Markdown with video embeds), **resources** (files or links), **assignments**, **quizzes** and **forums**
- Completion tracking (manual or automatic) with progress per section and per course
- Course catalog with categories, search, open enrolment, enrolment keys or invite-only courses
- Edit mode for teachers: add, reorder, move, hide and delete activities without leaving the course page

**Assessment**

- Assignments with online text and file submissions, due dates, late flags and a side-by-side grading workspace
- Quizzes with single and multiple choice, true/false, short answer (with wildcards) and numerical questions
- Time limits, attempt limits, highest/last/average grading, pass marks, shuffling and configurable review
- Gradebook with inline editing, feedback, class averages and CSV export; students see their own grades

**Community**

- Threaded forums with pinning, locking and moderation
- Course announcements, in-app notifications and a calendar with due dates and events

**Administration**

- People management with site roles, suspension and **"Log in as"** for support
- Categories, branding (site name, tagline, brand colour) and self-registration control
- Moodle-style capabilities per course role (teacher, teaching assistant, student)

**Platform**

- Zero-config SQLite via Node's built-in `node:sqlite` (no native modules to compile), or **PostgreSQL** for larger sites
- One npm package: CLI, REST API and a prebuilt web UI. Embed it in your own Node app if you like
- Typed event hooks for integrations (webhooks, analytics, email)
- Light and dark themes, responsive down to phones, keyboard shortcuts (`⌘K` / `Ctrl+K` search)

## Getting started

### Run it

Requires Node.js 22.13 or newer.

```bash
npx coursekit start
```

Data (the SQLite database and uploads) is stored in `./data`. The first visit shows a setup wizard that creates the administrator account and can load demo content.

### Create a site folder

```bash
npx coursekit init my-school --demo
cd my-school
npm install
npm start
```

`init` creates a `package.json`, `.env` and data folder, then asks for the administrator's details (or pass `--email`, `--name` and `--password`).

### Try the demo

```bash
npx coursekit seed --demo
```

This adds six courses, two teachers, a teaching assistant and twelve students with submissions, quiz attempts, grades and forum threads. Every demo account uses the password `coursekit`. It is meant for local evaluation only, so don't load it on a public site.

| Account                       | Role               |
| ----------------------------- | ------------------ |
| `admin@coursekit.test`        | Administrator      |
| `maya.chen@coursekit.test`    | Instructor         |
| `priya.raman@coursekit.test`  | Teaching assistant |
| `alex.johnson@coursekit.test` | Student            |

## Configuration

Set these as environment variables or in a `.env` file next to where you run Coursekit.

| Variable                  | Default                        | Description                                                       |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `PORT`                    | `3000`                         | Port to listen on                                                 |
| `HOST`                    | `0.0.0.0`                      | Interface to bind                                                 |
| `DATABASE_URL`            | `sqlite://./data/coursekit.db` | `sqlite://path/to/file.db` or `postgres://user:pass@host:5432/db` |
| `COURSEKIT_DATA_DIR`      | `./data`                       | Uploaded files (and the default SQLite database)                  |
| `COURSEKIT_PUBLIC_URL`    | (none)                         | Public URL; an `https://` URL turns on secure cookies             |
| `COURSEKIT_MAX_UPLOAD_MB` | `50`                           | Maximum upload size                                               |

The same options are available as CLI flags: `coursekit start --port 8080 --database-url postgres://...`.

### PostgreSQL

Install the `pg` driver next to Coursekit, for example in a folder created with `coursekit init`:

```bash
npm install pg
DATABASE_URL=postgres://user:password@localhost:5432/coursekit npm start
```

Migrations run automatically on start (or explicitly with `coursekit migrate`). The schema only uses portable column types, so the same migrations run on SQLite and PostgreSQL.

### Production checklist

- Put Coursekit behind a reverse proxy with HTTPS and set `COURSEKIT_PUBLIC_URL=https://...` so session cookies are marked `Secure`
- Back up the data folder (SQLite database and uploads), or your PostgreSQL database plus the uploads folder
- Keep self-registration off if your site is private (Administration → Site settings)

## Use it as a library

Coursekit exports a programmatic API, so you can run it inside your own server, react to events or seed data from scripts.

```ts
import { createCoursekit } from 'coursekit';

const lms = await createCoursekit({
  databaseUrl: process.env.DATABASE_URL,
  publicUrl: 'https://learn.example.com',
});

// React to what happens in the LMS
lms.events.on('grade.updated', ({ userId, activityId, score }) => {
  console.log(`User ${userId} scored ${score} on ${activityId}`);
});
lms.events.onAny((event, payload) => forwardToWebhook(event, payload));

await lms.listen(3000);
```

Mount it in an existing app instead of calling `listen()`:

```ts
// Express / Fastify / node:http
app.use(lms.handler);

// Hono
app.route('/', lms.app);

// Web-standard runtimes and tests
const response = await lms.fetch(new Request('http://localhost/api/health'));
```

Coursekit expects to own the root path of its (sub)domain, e.g. `learn.example.com`.

**Events:** `user.created`, `user.login`, `course.created`, `course.updated`, `course.deleted`, `enrolment.created`, `enrolment.deleted`, `activity.created`, `activity.completed`, `submission.submitted`, `grade.updated`, `quiz.attempt.finished`, `forum.post.created`, `announcement.created`.

**File storage:** uploads go to `<dataDir>/uploads` by default. Pass `storage` with your own `put`/`get`/`delete` implementation to use S3, R2 or similar.

See [docs/api.md](docs/api.md) for the REST API.

## Roles and permissions

Site roles decide what someone can do across the site; course roles decide what they can do inside a course.

| Site role     | Can                                        |
| ------------- | ------------------------------------------ |
| Administrator | Everything, in every course                |
| Instructor    | Create courses (and becomes their teacher) |
| Student       | Enrol in courses                           |

| Capability                          | Teacher | Teaching assistant | Student |
| ----------------------------------- | :-----: | :----------------: | :-----: |
| View course, post in forums         |    ✓    |         ✓          |    ✓    |
| See hidden activities               |    ✓    |         ✓          |         |
| Edit content and settings           |    ✓    |                    |         |
| Manage participants                 |    ✓    |                    |         |
| View and edit all grades            |    ✓    |         ✓          |         |
| Moderate forums, post announcements |    ✓    |         ✓          |         |
| Submit assignments                  |         |                    |    ✓    |

Capabilities live in [`src/shared/permissions.ts`](src/shared/permissions.ts). The server enforces them and the UI reads the same table.

## Development

```bash
git clone <your fork>
cd coursekit
npm install
npm run dev        # API on :3000 (tsx watch) + web UI on :5173 (Vite)
```

Open http://localhost:5173. Run `npm run seed` first if you want demo data.

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | API and web UI with live reload                                 |
| `npm test`          | API and grading tests (Vitest, in-memory SQLite)                |
| `npm run typecheck` | Type-check server and web UI                                    |
| `npm run build`     | Build the web UI, bundle server and CLI, emit type declarations |
| `npm run format`    | Format with Prettier                                            |
| `npm start`         | Run the built package                                           |

### Stack

- **Server:** [Hono](https://hono.dev) on Node, [Kysely](https://kysely.dev) query builder, [Zod](https://zod.dev) validation, scrypt password hashing, database-backed sessions
- **Web UI:** React 19, React Router, TanStack Query, Tailwind CSS v4, Radix UI primitives, Lucide icons
- **Tooling:** TypeScript, Vite, tsup, Vitest, Prettier

### Project layout

```
src/
  shared/          Types, permissions and constants used by server and UI
  server/
    db/            Kysely setup, node:sqlite adapter, migrations
    routes/        REST API (auth, admin, courses, content, activities, quizzes, forums, grades, files, me)
    services/      Access control, progress, grading, quiz engine, notifications
    seed/          Demo content
    index.ts       createCoursekit() programmatic API
  cli/             The `coursekit` command
  web/
    components/    UI kit (buttons, dialogs, menus…) and app shell
    pages/         Dashboard, catalog, course, activities, admin…
test/              API integration tests
```

## Security

- Passwords are hashed with scrypt; session tokens are random 256-bit values stored only as SHA-256 hashes
- Cookies are `HttpOnly` and `SameSite=Lax`; cross-site form posts are rejected by CSRF protection
- Every API route checks course capabilities on the server; hidden content and drafts are invisible to students
- Uploaded files are only served to people allowed to see them, with `nosniff`, and anything that could execute in a browser (HTML, SVG…) is served as a download
- Markdown is sanitised with DOMPurify before rendering; links in resources must be `http(s)`
- Credential endpoints are rate limited

Please report vulnerabilities privately to the maintainers rather than opening a public issue.

## Roadmap

Coursekit covers the core of an LMS today. Things on the list:

- Email notifications and digests
- Groups/cohorts, course completion certificates and badges
- Question banks, more question types (essay, matching, ordering) and grade categories/weights
- LTI 1.3 and SCORM/xAPI packages
- Internationalisation
- Pluggable activity types in the web UI (the server-side registry is in `src/server/services/activity-types.ts`)
- S3-compatible storage adapter, Docker image

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
