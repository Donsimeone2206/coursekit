# Coursekit

[![CI](https://github.com/Donsimeone2206/coursekit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Donsimeone2206/coursekit/actions/workflows/ci.yml)

**An open-source learning management system for Node.js.** Courses, lessons, assignments, quizzes with question banks, forums, a weighted gradebook, groups, certificates, badges and email notifications, with a fast, modern interface. Think Moodle, rebuilt for today's web.

```bash
npx coursekit-lms start
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
- **Groups** inside a course, made by hand or auto-created with even sizes; filter participants, submissions and the gradebook by group
- Course catalog with categories, search, open enrolment, enrolment keys or invite-only courses
- Edit mode for teachers: add, reorder, move, hide and delete activities without leaving the course page

**Assessment**

- Assignments with online text and file submissions, due dates, late flags and a side-by-side grading workspace
- Quizzes built from a per-course **question bank** with nested categories, using fixed questions or random ones from a category
- Eight question types: single and multiple choice, true/false, short answer (with wildcards), numerical, **essay** (marked by hand), **matching** and **ordering**
- Time limits, attempt limits, highest/last/average grading, pass marks, shuffling and configurable review
- Gradebook with inline editing, feedback, class averages and CSV export; students see their own grades
- **Grade categories and weights**, with drop-lowest rules and category subtotals

**Community**

- Threaded forums with pinning, locking and moderation
- Course announcements, in-app notifications and a calendar with due dates and events
- **Email notifications**, sent straight away or as daily or weekly digests, with per-person preferences and one-click unsubscribe

**Recognition**

- **Course completion** with criteria (all activities, a chosen set, a minimum course grade), a checklist for students and a report for teachers
- Printable **certificates** with a verification code anyone can check at `/verify`
- Course and site **badges**, awarded by hand or automatically on completion

**Administration**

- People management with site roles, suspension and **"Log in as"** for support
- **Cohorts**: site-wide groups of people (a year group, a department) that you link to courses to enrol everyone in them
- Categories, branding (site name, tagline, brand colour) and self-registration control
- Moodle-style capabilities per course role (teacher, teaching assistant, student)

**Platform**

- Zero-config SQLite via Node's built-in `node:sqlite` (no native modules to compile), or **PostgreSQL** for larger sites
- One npm package: CLI, REST API and a prebuilt web UI. Embed it in your own Node app if you like
- Typed event hooks for integrations (webhooks, analytics, email)
- Light and dark themes, responsive down to phones, keyboard shortcuts (`⌘K` / `Ctrl+K` search)

## Getting started

### Run it

Requires Node.js 22.13 or newer. The npm package is called `coursekit-lms`; once it's installed, the command is `coursekit`.

```bash
npx coursekit-lms start
```

Data (the SQLite database and uploads) is stored in `./data`. The first visit shows a setup wizard that creates the administrator account and can load demo content.

### Create a site folder

```bash
npx coursekit-lms init my-school --demo
cd my-school
npm install
npm start
```

`init` creates a `package.json`, `.env` and data folder, then asks for the administrator's details (or pass `--email`, `--name` and `--password`).

### Try the demo

```bash
npx coursekit-lms seed --demo
```

This adds six courses, two teachers, a teaching assistant and twelve students with submissions, quiz attempts, grades and forum threads. It also adds groups, a cohort, a question bank, weighted grade categories, completion with certificates, and badges. Alex's profile (`alex.johnson@coursekit.test`) shows earned badges and a certificate. Every demo account uses the password `coursekit`. It is meant for local evaluation only, so don't load it on a public site.

| Account                       | Role               |
| ----------------------------- | ------------------ |
| `admin@coursekit.test`        | Administrator      |
| `maya.chen@coursekit.test`    | Instructor         |
| `priya.raman@coursekit.test`  | Teaching assistant |
| `alex.johnson@coursekit.test` | Student            |

## Configuration

Set these as environment variables or in a `.env` file next to where you run Coursekit.

| Variable                   | Default                                      | Description                                                                                                  |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                     | `3000`                                       | Port to listen on                                                                                            |
| `HOST`                     | `0.0.0.0`                                    | Interface to bind                                                                                            |
| `DATABASE_URL`             | `sqlite://./data/coursekit.db`               | `sqlite://path/to/file.db` or `postgres://user:pass@host:5432/db`                                            |
| `COURSEKIT_DATA_DIR`       | `./data`                                     | Uploaded files (and the default SQLite database)                                                             |
| `COURSEKIT_PUBLIC_URL`     | (none)                                       | Public URL; an `https://` URL turns on secure cookies                                                        |
| `COURSEKIT_MAX_UPLOAD_MB`  | `50`                                         | Maximum upload size                                                                                          |
| `COURSEKIT_SMTP_URL`       | (none)                                       | `smtp://` or `smtps://` URL with credentials; turns on email (see [Email](#email-notifications-and-digests)) |
| `COURSEKIT_MAIL_FROM`      | `"<site name>" <no-reply@<public URL host>>` | Sender address                                                                                               |
| `COURSEKIT_MAIL_TRANSPORT` | `smtp` with a URL, else `none`               | `smtp`, `log` (saves emails to `<data dir>/emails`) or `none`                                                |
| `COURSEKIT_MAIL_WORKER`    | `true`                                       | `false` stops this process sending email in the background                                                   |

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
- Back up before upgrading. Migrations run on start, and 0.2.0's question bank migration can't be undone

## Email notifications and digests

Coursekit can email people their notifications, straight away or in a daily or weekly digest. Email is **off until you configure it**. Until then people see notifications only in the app.

```bash
npm install nodemailer
COURSEKIT_SMTP_URL=smtps://user:password@smtp.example.com:465
COURSEKIT_MAIL_FROM="Acme Academy <learn@acme.example>"
COURSEKIT_PUBLIC_URL=https://learn.acme.example   # needed for links and unsubscribe links
```

- **SMTP URL.** Percent-encode special characters in the password (`p@ss` becomes `p%40ss`). Query parameters become nodemailer options, for example `?pool=true`.
- **Local testing.** Set `COURSEKIT_MAIL_TRANSPORT=log` to try email without a mail server. Each email is saved to `<data dir>/emails/` as an `.eml` and an `.html` file.
- **Outbox.** Requests only queue emails in an outbox table, and the server sends them in the background. Failures are retried with growing delays, up to 8 tries over about 11 hours. Several servers can share one database without sending anything twice.
- **Preferences.** People choose on their profile page: immediately, daily digest, weekly digest or off. They can also switch off categories such as discussions or grades. Anyone who hasn't chosen gets the site default.
- **Digests.** The digest hour, weekday and time zone are set under **Administration → Email**. That page also shows delivery status and can send a test email.
- **Unsubscribe.** Every email has an unsubscribe link that works without signing in, plus `List-Unsubscribe` headers for mail apps' one-click unsubscribe.

To use another provider, pass a transport in code. Throw to have the message retried, or throw an error with `permanent: true` to give up.

```ts
const lms = await createCoursekit({
  publicUrl: 'https://learn.acme.example',
  email: {
    from: 'Acme Academy <learn@acme.example>',
    transport: {
      name: 'My provider',
      async send(message) {
        // { id, from, to, subject, html, text, headers }; id stays the same across retries
        await myProvider.send(message);
      },
    },
  },
});
```

To send from cron instead of the web server, set `COURSEKIT_MAIL_WORKER=false` and run `coursekit send-digests` every hour with the same settings. It sends the digests that are due, then everything queued. `lms.email.sendDigests()` and `lms.email.processOutbox()` do the same in code.

## Use it as a library

Coursekit exports a programmatic API, so you can run it inside your own server, react to events or seed data from scripts. It is an ES module, and CommonJS code can `require('coursekit-lms')` too. Type definitions are included; TypeScript projects also need `@types/node`, which most Node projects already have. With `skipLibCheck` off, the type definitions need TypeScript 5.7 or newer (Hono's use 5.7 features). With TypeScript 5, `"module": "commonjs"` and `skipLibCheck` off, also set `esModuleInterop` (for zod's type definitions, which Coursekit's types use) and a `target` of ES2022 or newer (for kysely's).

```ts
import { createCoursekit } from 'coursekit-lms';

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

**Events:** `user.created`, `user.login`, `course.created`, `course.updated`, `course.deleted`, `enrolment.created`, `enrolment.deleted`, `activity.created`, `activity.completed`, `submission.submitted`, `grade.updated`, `gradebook.setup.updated`, `quiz.attempt.submitted`, `quiz.attempt.finished`, `forum.post.created`, `announcement.created`, `course.completed`, `certificate.issued`, `certificate.revoked`, `badge.awarded`, `badge.revoked`, `group.created`, `group.updated`, `group.deleted`, `group.member.added`, `group.member.removed`, `cohort.created`, `cohort.updated`, `cohort.deleted`, `cohort.member.added`, `cohort.member.removed`, `cohort.linked`, `cohort.unlinked`, `email.sent`, `email.failed`.

**File storage:** uploads go to `<dataDir>/uploads` by default. Pass `storage` with your own `put`/`get`/`delete` implementation to use S3, R2 or similar.

See [docs/api.md](docs/api.md) for the REST API.

## Roles and permissions

Site roles decide what someone can do across the site; course roles decide what they can do inside a course.

| Site role     | Can                                        |
| ------------- | ------------------------------------------ |
| Administrator | Everything, in every course                |
| Instructor    | Create courses (and becomes their teacher) |
| Student       | Enrol in courses                           |

| Capability                                              | Teacher | Teaching assistant | Student |
| ------------------------------------------------------- | :-----: | :----------------: | :-----: |
| View course, post in forums                             |    ✓    |         ✓          |    ✓    |
| See hidden activities                                   |    ✓    |         ✓          |         |
| Edit content and settings                               |    ✓    |                    |         |
| Manage participants                                     |    ✓    |                    |         |
| View and edit all grades                                |    ✓    |         ✓          |         |
| Moderate forums, post announcements                     |    ✓    |         ✓          |         |
| Manage groups                                           |    ✓    |         ✓          |         |
| See the completion report, award badges                 |    ✓    |         ✓          |         |
| Set completion criteria and certificates, create badges |    ✓    |                    |         |
| Manage the question bank                                |    ✓    |                    |         |
| Set up grade categories and weights                     |    ✓    |                    |         |
| Submit assignments                                      |         |                    |    ✓    |

Capabilities live in [`src/shared/permissions.ts`](src/shared/permissions.ts). The server enforces them and the UI reads the same table.

## Groups and cohorts

**Groups** belong to one course. Teachers and teaching assistants manage them on the course's **Groups** tab. They can add enrolled people by hand (someone can be in several groups) or **auto-create** groups. Auto-create shuffles the students into N groups, or into groups of at most N, with even sizes. In the group names, `#` becomes a number and `@` a letter, so `Group @` makes Group A, Group B and so on. Participants, assignment submissions and the gradebook can be filtered by group. Students see only their own groups.

**Cohorts** are site-wide and managed under **Administration → Cohorts**. Add people one at a time or paste a list of email addresses. Link a cohort to a course with a course role, from the course's Participants page or the cohort's page, and everyone in it is enrolled, including people who join the cohort later. Unlinking a cohort, removing someone from it or deleting it never removes an enrolment.

## Question banks and question types

Every course has a **question bank**, on the course's **Question bank** tab. Teachers write each question once, file it in a category (categories can be nested) and reuse it in any quiz in the course.

- A quiz is a list of **slots**. Each slot holds either a specific question or **random questions** from a category. Random questions are picked again for every attempt and never repeat within one.
- Each attempt keeps a copy of its questions, so editing the bank never changes an attempt that has already started.
- **Essay** questions have optional word limits and notes for graders. Attempts with essays wait for a teacher or teaching assistant to mark them on the attempt's review page. The grade is recorded once the last essay has a mark.
- **Matching** gives an equal share of the marks for each correct match, with optional distractors.
- **Ordering** gives an equal share for each pair of neighbours in the right order. Students drag the items, or move them with keyboard-friendly buttons.

When you upgrade from 0.1.x, each quiz's questions move into its course's bank, in a category named after the quiz.

## Grade categories and weights

In a course, go to **Grades → Categories & weights** to group graded activities into categories and choose how the course total is calculated:

- **Natural (points)**, the default and how 0.1.x worked: the points earned out of the points possible. Categories add subtotals.
- **Weighted categories**: each category is worth a share of the total, however many points it has. An activity's weight sets its share of its category.

Only graded work counts. **Drop the lowest N** leaves out each student's N lowest grades in a category. Categories without grades yet are left out and the other weights are scaled up, so weights don't have to add up to 100%. Activities without a category count in _Uncategorised_. The gradebook and the CSV export show category subtotals, and students see their grades grouped by category.

## Course completion, certificates and badges

**Completion.** In a course's **Settings**, turn on course completion and choose the criteria: every activity that tracks completion, or a chosen set, plus an optional minimum course grade. Coursekit checks automatically when a student finishes an activity or gets a grade. Students see a checklist on the course page, and staff see a report on the **Completion** tab. Completion is permanent: changing the criteria later never takes it away.

**Certificates.** Turn on certificates to give students a printable A4 certificate in your brand colour when they complete the course. Write its text with `{name}`, `{course}`, `{date}`, `{code}` and `{site}` placeholders.

- Each certificate has a verification code that anyone can check at `/verify` without signing in.
- Issued certificates keep their text, even if you edit it later.
- Teachers can revoke a certificate and restore it.
- To get a PDF, choose **Download PDF**, then _Save as PDF_ in the print dialog.

**Badges.** Teachers create course badges on a course's **Badges** tab, and administrators create site badges under **Administration → Badges**. A badge is awarded by hand, on completing the course, or (for site badges) on completing a set of courses. Earned badges and certificates appear on the profile.

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
    routes/        REST API (auth, admin, courses, content, activities, quizzes, question bank, forums,
                   grades, groups, cohorts, completion, certificates, badges, email, files, me)
    services/      Access control, progress, gradebook, quiz engine, completion, notifications, email outbox
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
- Unsubscribe links are HMAC-signed, and the public certificate check shows only the name, course, date and whether the certificate is valid

Please report vulnerabilities privately to the maintainers rather than opening a public issue.

## Roadmap

Coursekit covers the core of an LMS today. Things on the list:

- LTI 1.3 and SCORM/xAPI packages
- Group modes (activities and forums restricted to a group)
- Question import and export (GIFT, Moodle XML) and sharing questions between courses
- Open Badges export
- Internationalisation
- Pluggable activity types in the web UI (the server-side registry is in `src/server/services/activity-types.ts`)
- S3-compatible storage adapter, Docker image

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
