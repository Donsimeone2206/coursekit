# Changelog

## 0.3.0

External tools (LTI 1.3 Advantage), SCORM and xAPI packages, group modes, question import, export and sharing, and Open Badges export.

**Before upgrading, back up your database.** Migrations `007` to `011` run on start. They add tables, plus a few columns: `009_group_modes` adds `group_mode` to courses and activities, `group_id` to discussions, and `activity_id` and `discussion_id` to files, which it fills in for existing files.

### External tools (LTI 1.3 Advantage)

- Coursekit is an LTI 1.3 platform. Administrators register tools under **Administration → External tools**: URLs, exact redirect URIs, the tool's keys (JWKS URL, PEM or JWK), custom parameters, what may be shared (names, emails) and which services the tool may use. Coursekit generates the client ID and deployment ID and shows every platform detail to copy into the tool. Tools can be turned off at any time.
- A new **External tool** activity opens a tool in a new window or embedded in the page, with an optional launch URL on the tool's domain, custom parameters and an optional maximum grade.
- Launches follow LTI 1.3 Core and the 1EdTech Security Framework: third-party initiated login, an OIDC authorization endpoint with exact redirect URIs, and RS256 id_tokens signed with a key Coursekit creates on first use and publishes at `/lti/jwks`. The launch hint is signed, lasts two minutes, works once and is tied to the person, tool and activity.
- **Deep Linking 2.0:** teachers choose **Select content** to pick links inside the tool. Coursekit verifies the tool's signed response and creates or updates the activities.
- **Assignment and Grade Services 2.0:** line items, scores and results. Scores go into the gradebook scaled to the activity's maximum (and are rescaled when it changes); a completed score completes the activity. Tools get access tokens through the OAuth 2.0 client credentials grant with a signed client assertion, rate limited per tool and replay-protected.
- **Names and Role Provisioning Services 2.0:** the class list with role filters and paging, with names and emails only when the tool may have them.
- Tools reach a course's grades and class list only while one of its activities uses the tool, and only with the services an administrator allowed.
- Needs `COURSEKIT_PUBLIC_URL`, which is the LTI issuer.

### SCORM and xAPI packages

- A new **SCORM / xAPI package** activity: upload SCORM 1.2, SCORM 2004 (2nd, 3rd and 4th edition) or xAPI (Tin Can) zips. Replacing a package keeps learners who already started on their version. Folders zipped by macOS Finder work too.
- Safe unzipping: path traversal, absolute paths, symlinks, duplicate names, zip bombs, too many files and packages above `COURSEKIT_MAX_PACKAGE_MB` (default 500 MB) are refused.
- Package content is served sandboxed (`Content-Security-Policy: sandbox`, an opaque origin) from signed, expiring links under `/content/`, so a package can never act as the signed-in user.
- SCORM run-times (`window.API` and `window.API_1484_11`) with the 1.2 and 2004 data models and error codes, resume, session and total time, and server-side checks of every commit. Progress keeps saving when a page stays open longer than the six-hour link lifetime.
- Attempts with limits, highest or last attempt grading, an optional pass requirement for completion, review of finished attempts, staff previews that record nothing, and a staff report (limited to their groups for teaching assistants in separate groups).
- A built-in xAPI Learning Record Store at `/xapi/`: statements (with voiding and queries), Activity State with ETags, Activity and Agent Profiles, xAPI 1.0.3 and 2.0.0, and CORS. Launch credentials only reach the learner's own data, with size limits per learner.
- Deleting an activity, a section or a course removes its package files from storage.

### Group modes and restricted activities

- Courses have a default group mode (no groups, separate groups, visible groups), and each activity can override it. A new capability, `course:accessAllGroups`, goes to teachers (and administrators).
- Separate groups: students only see their own groups' discussions, and teaching assistants only see the students of their own groups in submissions, grading, quiz attempts, package reports, the dashboard's to-grade counts and the gradebook.
- Forums with groups: discussions belong to a group or to all participants. Students post in their own groups; teachers post anywhere and can move discussions. Listing, replying, counts and notifications follow the group mode.
- Any activity can be limited to chosen groups. Other students don't see it anywhere, can't download its files, and it doesn't count towards their grades, progress or completion; the gradebook and the CSV export show their cells as N/A. Staff see a "Groups: ..." badge.
- Saving an activity is now all or nothing, so a refused change never leaves a restricted activity open to everyone.
- New event `activity.groups.updated`. Course completion is checked again when people join or leave groups.

### Question import, export and sharing

- Import Moodle XML and GIFT files, with a preview first: counts per type, the categories to create or reuse, and notes and problems with their question and line numbers. Then an all-or-nothing import of the valid questions, converting HTML, Moodle auto-format, Markdown and plain text to Markdown.
- Export as Moodle XML (every type; importable by Moodle 4.x and 5.x and by Coursekit) or GIFT (no ordering questions): the whole bank, a category with or without its subcategories, or chosen questions.
- Copy questions or whole categories to other courses whose question bank you manage.
- Share categories (with their subcategories) with other courses you teach, or, as an administrator, with every course. Shared categories are read-only in the other course's bank and quiz editor and can be used for fixed and random questions; quizzes keep their questions when a share ends.
- An example GIFT file is in `test/fixtures/questions/example.gift`.

### Open Badges export

- People can share a badge they earned from the badge page or their profile. Nothing is public until they do, and they can stop sharing at any time.
- **Open Badges 2.0** hosted verification: issuer profile, BadgeClass and assertion (the recipient as a salted SHA-256 email hash), with **Copy link** for backpacks and **Download badge**, an SVG with the assertion baked in.
- **Open Badges 3.0**: **Download credential** gives an OpenBadgeCredential signed as a VC-JWT, as a file or baked into the badge image, with a W3C Bitstring Status List for revocation and the public key at `/openbadges/v3/jwks.json`.
- Revoking an award, deleting the badge or the account, or stopping sharing revokes the public documents straight away (`410 Gone`). Revocation is permanent: a restored award has to be shared again.
- A public verification page at `/verify-badge/<id>`. Administrators set the issuer name, contact email and description under **Administration → Badges**; the contact email is published in the issuer profile.

### Changes to check if you integrate with Coursekit

- **Teaching assistants can no longer change groups** (`course:manageGroups` is now teachers only). They still see every group.
- File downloads now follow the rules of the file's activity (hidden, group-restricted, or another group's submission).
- Forum reply notifications only reach people who can still open the discussion.
- `ActivityType` gains `'lti'` and `'package'`, and course, activity and discussion rows gain `groupMode` / `groupId`.
- New routes outside `/api`: `/lti/`, `/content/`, `/xapi/` and `/openbadges/`. If a reverse proxy only forwards some paths, add these.
- New runtime dependencies: `jose`, `@xmldom/xmldom` and `fflate`. New option `maxPackageMb` / `COURSEKIT_MAX_PACKAGE_MB`.

### Known limitations

- SCORM 2004 sequencing and navigation rules aren't implemented (multi-part packages get a table of contents with Previous and Next), and cmi5 packages are refused.
- LTI: no Dynamic Registration; line items a tool creates itself aren't shown in the gradebook; the class list and score passback don't apply group restrictions (such scores show as N/A). Behind a reverse proxy, the token endpoint counts failed requests per proxy address, as there is no trusted-proxy setting yet.
- Open Badges are baked into SVG only (no PNG).

## 0.2.0

Email notifications, groups and cohorts, course completion with certificates and badges, question banks with three new question types, and grade categories with weights.

**Before upgrading, back up your database.** Migrations `002` to `006` run on start. They only add tables, except `005_question_bank`, which moves quiz questions into the new question bank and can't be undone.

### Email notifications and digests

- Every in-app notification can also be emailed, either straight away or in a daily or weekly digest. People choose on their profile page and can switch off categories (announcements, discussions, grades, courses, badges and certificates). The site default is an admin setting. Email stays off until a transport is configured.
- SMTP through nodemailer, an optional peer dependency (`npm install nodemailer`), configured with `COURSEKIT_SMTP_URL` and `COURSEKIT_MAIL_FROM`. A `log` transport (`COURSEKIT_MAIL_TRANSPORT=log`) saves emails as files for local testing. `createCoursekit({ email: { transport: { send } } })` takes custom transports for Resend, SES and other providers.
- Emails are queued in a database outbox and sent in the background, with retries and backoff, so a slow mail server never holds up a request. Several servers sharing one database never send the same email twice.
- Digests go out at a configurable hour, weekday and time zone, and are skipped when there is nothing new. For cron setups there are `coursekit send-digests [--force]`, `lms.email.sendDigests()`, `lms.email.processOutbox()` and `COURSEKIT_MAIL_WORKER=false`.
- Unsubscribing works without signing in. Links are signed, and a confirmation page at `/unsubscribe` can stop one category or all email. Messages carry `List-Unsubscribe` and `List-Unsubscribe-Post` headers, so mail apps offer one-click unsubscribe (RFC 8058).
- Emails are branded HTML in the site's colours, with dark mode and a plain-text part.
- A new **Administration → Email** page shows delivery status, outbox counts and the last error. It can retry failed emails and send a test email, and it holds the digest settings.

### Groups and cohorts

- **Course groups.** Teachers and teaching assistants manage groups on the new **Groups** tab. They can create groups and add or remove members by hand, or auto-create groups by splitting the students at random into N groups or into groups of N, with balanced sizes and a naming scheme. Students see only their own groups.
- Participants, assignment submissions and the gradebook (including its averages and CSV export) can be filtered by group.
- **Cohorts.** Site-wide groups of people, managed under **Administration → Cohorts**. Add people one at a time or paste a list of email addresses.
- Linking a cohort to a course enrols every member, and people who join the cohort later are enrolled automatically. Unlinking a cohort, or removing someone from it, keeps existing enrolments.

### Course completion, certificates and badges

- **Course completion.** A teacher turns it on in the course settings and picks the criteria: every activity that tracks completion, or a chosen set, plus an optional minimum course grade. Completion is checked automatically when an activity is finished, a grade changes or the gradebook setup changes.
  - Students see a checklist on the course page, and staff see a report on the new **Completion** tab.
  - Completion is permanent and notifies the student.
- **Certificates.** Printable A4 certificates with your own text, using placeholders such as `{name}`, `{course}` and `{date}`, and a signature line.
  - Each certificate has a verification code that anyone can check at `/verify` without signing in.
  - Issued certificates keep a snapshot of their text, and teachers can revoke and restore them.
- **Badges.** Course badges (made by teachers) and site badges (made by administrators), each with one of 20 icons and 10 colours.
  - Awarded by hand, on completing the course, or on completing a set of courses.
  - Earned badges and certificates appear on the profile.

### Question banks and new question types

- Each course has a **question bank**: nested categories, search, type filters, preview, duplicate, move and delete. A question can't be deleted while a quiz uses it. The bank is on a new **Question bank** tab for teachers.
- A quiz is an ordered list of **slots**. Each slot is either a specific question or N random questions from a category, picked again for every attempt with no repeats. Each slot has its own mark.
- **New question types:**
  - **essay**: optional word limits and notes for graders, marked by hand;
  - **matching**: partial credit for each correct match, with optional distractors;
  - **ordering**: drag and drop or keyboard buttons, partial credit for each pair of neighbours in the right order.
- Attempts keep a copy of their questions, so later edits to the bank never change an attempt that has started or its review.
- **Essay marking.** Attempts with essays finish as `needs_grading`, with a pending score. Teachers and teaching assistants mark each essay on the attempt's review page. The grade is recorded once the last essay has a mark.

### Grade categories and weights

- Group graded activities into categories under **Grades → Categories & weights**. Each category has a weight and a "drop the lowest N" rule.
- Each course uses either natural (points) totals, the default and unchanged from 0.1.x, or weighted categories. With weighted categories, an activity's weight sets its share of its category. Categories with no grades yet are left out and the other weights are scaled up.
- The gradebook groups its columns by category and shows category subtotals and averages. Dropped grades are struck through. The CSV export adds a subtotal column per category.
- Students see their grades grouped by category, with subtotals and weights.

### Changes to check if you integrate with Coursekit

- Quiz questions now live in the bank. `GET` and `PUT /api/activities/:id/questions` still work; a `PUT` keeps questions removed from the quiz in the bank instead of deleting them.
- A quiz attempt can now have the status `needs_grading`, with a `null` score. The new `quiz.attempt.submitted` event fires on hand-in, and `quiz.attempt.finished` fires once the score is final.
- Course totals and averages now have two decimals (84.17% rather than 84.2%). The totals themselves are unchanged for courses without categories.
- New capabilities:
  - `course:manageGroups`, `completion:viewReport` and `badges:award`, for teachers and teaching assistants;
  - `completion:manage`, `badges:manage`, `questionbank:manage` and `grades:manage`, for teachers.
- New events:
  - email: `email.sent` and `email.failed`;
  - groups: `group.created`, `group.updated`, `group.deleted`, `group.member.added` and `group.member.removed`;
  - cohorts: `cohort.created`, `cohort.updated`, `cohort.deleted`, `cohort.member.added`, `cohort.member.removed`, `cohort.linked` and `cohort.unlinked`;
  - completion and badges: `course.completed`, `certificate.issued`, `certificate.revoked`, `badge.awarded` and `badge.revoked`;
  - quizzes and grades: `quiz.attempt.submitted` and `gradebook.setup.updated`.
- New REST endpoints are listed in [docs/api.md](docs/api.md).

### Other changes

- The demo content now includes groups, a cohort, a question bank, essay attempts waiting to be marked, weighted grade categories, completion with certificates, badges, and two people on email digests.
- "Enrol people" skips someone who was enrolled at the same moment by another request, instead of failing.
- Fixed: on phones, the student course page and the course settings page no longer scroll sideways.
- Fixed: the quiz editor's save bar no longer covers the last buttons on wide screens.

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
