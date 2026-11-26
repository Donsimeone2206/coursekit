# REST API

All endpoints live under `/api` and speak JSON. Authentication uses an `HttpOnly` session cookie set by `POST /api/auth/login`. Response shapes are defined in [`src/shared/types.ts`](../src/shared/types.ts).

Errors look like this:

```json
{ "error": { "message": "That enrolment key is not correct.", "code": "bad_request", "issues": [] } }
```

`issues` lists field-level problems for validation errors (`code: "validation_error"`). Status codes follow HTTP conventions: `400` invalid input, `401` not signed in, `403` not allowed, `404` not found (also used for things you may not see), `409` conflict, `413` too large, `429` rate limited.

Cross-site form submissions are rejected. Send JSON with `Content-Type: application/json`, and send an `Origin` header with uploads.

## Auth and profile

| Method | Path                       | Description                                                                |
| ------ | -------------------------- | -------------------------------------------------------------------------- |
| GET    | `/auth/session`            | Current user, site settings, `needsSetup`, impersonation state             |
| POST   | `/auth/setup`              | First-run only: create the administrator (`demo: true` seeds demo content) |
| POST   | `/auth/login`              | `{ email, password }`                                                      |
| POST   | `/auth/register`           | `{ name, email, password }`, if self-registration is on                    |
| POST   | `/auth/logout`             | End the session                                                            |
| PATCH  | `/auth/me`                 | `{ name?, bio?, avatarUrl? }`                                              |
| POST   | `/auth/me/password`        | `{ currentPassword, newPassword }`; signs out other sessions               |
| POST   | `/auth/stop-impersonating` | Return to the administrator after "Log in as"                              |

### Client addresses behind a proxy

Some limits count requests per client address. Sign-ins and sign-ups also keep their limits per email (10 attempts in 15 minutes).

| Requests                                                                     | Limit per client address |
| ---------------------------------------------------------------------------- | ------------------------ |
| Failed sign-ins (`POST /auth/login`)                                         | 100 in 15 minutes        |
| Sign-ups (`POST /auth/register`)                                             | 50 in an hour            |
| Failed token requests (`POST /lti/token`)                                    | 60 a minute              |
| Registration requests with a missing or bad token (`POST /lti/registration`) | 30 a minute              |

Over a limit the answer is 429 (with `Retry-After: 60` for the two LTI endpoints, which are outside `/api`). IPv6 addresses count per /64 network.

By default the client address is the connection's address, and `X-Forwarded-For` is ignored. Behind a reverse proxy, set the `trustProxy` option (or `COURSEKIT_TRUST_PROXY`) to the proxies Coursekit should believe:

- a list of addresses and CIDR ranges, IPv4 or IPv6, with the shortcuts `loopback`, `linklocal` and `uniquelocal`: when the connection comes from one of them, Coursekit reads `X-Forwarded-For` from the right, skipping trusted addresses, and the first address that isn't trusted is the client;
- a number n: there are n proxies in front of Coursekit, and the n-th entry from the right is the client;
- `true`: the left-most entry is the client. Clients can add entries of their own, so use it only when Coursekit can't be reached except through a proxy that replaces the header.

An entry that isn't an IP address ends the walk at the last trusted hop.

While `trustProxy` is off, sign-ins and sign-ups that come through a proxy (with `X-Forwarded-For`, `Forwarded` or `X-Real-IP`) or over loopback only get the limits per email, so an unconfigured proxy never makes everyone share one count. Failed LTI token and registration requests from behind it do share the proxy's address. Coursekit logs a hint once when it sees those headers while the option is off.

Failed sign-ins take a place before the password is checked, so requests sent at the same time can't get past the limit. When every free place is held by checks still running, further sign-ins wait (up to 15 seconds) instead of being refused.

## Courses

| Method | Path                                         | Capability                                           |
| ------ | -------------------------------------------- | ---------------------------------------------------- |
| GET    | `/courses?q=&category=&page=&pageSize=`      | Catalog of published courses                         |
| GET    | `/courses/mine`                              | Courses you're enrolled in                           |
| POST   | `/courses`                                   | Instructor or admin                                  |
| GET    | `/courses/:idOrSlug`                         | Outline for everyone; full detail with `course:view` |
| PATCH  | `/courses/:id`                               | `course:update`                                      |
| DELETE | `/courses/:id`                               | `course:delete`                                      |
| POST   | `/courses/:id/enrol`                         | `{ key? }` self-enrolment                            |
| POST   | `/courses/:id/leave`                         | Students                                             |
| GET    | `/courses/:id/participants`                  | `course:viewParticipants`                            |
| POST   | `/courses/:id/participants`                  | `{ emails[], role }`, `course:manageParticipants`    |
| PATCH  | `/courses/:id/participants/:enrolmentId`     | `{ role?, status? }`                                 |
| DELETE | `/courses/:id/participants/:enrolmentId`     | `course:manageParticipants`                          |
| GET    | `/courses/:id/announcements`                 | `course:view`                                        |
| POST   | `/courses/:id/announcements`                 | `{ title, body }`, `announcement:post`               |
| DELETE | `/courses/:id/announcements/:announcementId` | `announcement:post`                                  |

## Course structure

| Method | Path                               | Body                                                                                            |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/courses/:id/sections`            | `{ title, summary?, visible? }`                                                                 |
| PUT    | `/courses/:id/sections/order`      | `{ ids[] }`                                                                                     |
| PATCH  | `/courses/:id/sections/:sectionId` | `{ title?, summary?, visible? }`                                                                |
| DELETE | `/courses/:id/sections/:sectionId` |                                                                                                 |
| POST   | `/courses/:id/activities`          | `{ sectionId, type, title, description?, settings?, dueAt?, maxGrade?, completion?, visible? }` |
| PUT    | `/courses/:id/activities/order`    | `{ sectionId, ids[] }` (also moves activities between sections)                                 |

All require `course:manageContent`.

## Activities

| Method | Path                             | Description                                             |
| ------ | -------------------------------- | ------------------------------------------------------- |
| GET    | `/activities/:id`                | Detail, plus your submission / attempts / grade         |
| PATCH  | `/activities/:id`                | Edit (`course:manageContent`)                           |
| DELETE | `/activities/:id`                | Delete (`course:manageContent`)                         |
| POST   | `/activities/:id/complete`       | Mark as done (manual completion)                        |
| DELETE | `/activities/:id/complete`       | Undo                                                    |
| PUT    | `/activities/:id/submission`     | `{ text?, fileIds[] }` (`assignment:submit`)            |
| GET    | `/activities/:id/submissions`    | Every student's submission and grade (`grades:viewAll`) |
| PUT    | `/activities/:id/grades/:userId` | `{ score, feedback? }` (`grades:edit`)                  |

### Quizzes

A quiz is an ordered list of slots. Each slot is a question from the course's [question bank](#question-bank), or a number of random questions from a bank category, picked again for every attempt without repeating a question. Each attempt keeps a copy of its questions, so editing the bank never changes attempts that have started.

| Method | Path                                               | Description                                                                                                    |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/activities/:id/slots`                            | Slots with question summaries, totals and `problems` (e.g. too few questions for a random slot)                |
| PUT    | `/activities/:id/slots`                            | `{ slots[] }` replaces them; the quiz's maximum grade follows the total marks (`course:manageContent`)         |
| GET    | `/activities/:id/questions`                        | The quiz's directly added questions with answers (`course:manageContent`)                                      |
| PUT    | `/activities/:id/questions`                        | `{ questions[] }` replaces the quiz's questions, saving them to the bank (the 0.1.x API; ids in the quiz stay) |
| POST   | `/activities/:id/attempts`                         | Start (or resume) an attempt                                                                                   |
| GET    | `/activities/:id/attempts?all=1`                   | Your attempts, or everyone's with `quiz:viewAllAttempts`                                                       |
| GET    | `/activities/:id/grading`                          | Students' attempts waiting for essays to be marked, oldest first (`quiz:viewAllAttempts`)                      |
| GET    | `/attempts/:attemptId`                             | Questions (answers hidden until review; grader notes for staff only)                                           |
| PUT    | `/attempts/:attemptId`                             | `{ answers }` autosave                                                                                         |
| POST   | `/attempts/:attemptId/submit`                      | `{ answers? }` finish and grade                                                                                |
| PUT    | `/attempts/:attemptId/questions/:questionId/grade` | `{ points, comment? }` marks an essay answer (`grades:edit`)                                                   |

A slot is `{ "kind": "question", "questionId": "…", "points": 2 }` or `{ "kind": "random", "categoryId": "…", "questionCount": 3, "includeSubcategories": true, "points": 1 }`. `points` is the mark for each question in the slot; it defaults to the question's default mark (question slots) or 1 (random slots).

Answers are keyed by question id: `{ "optionIds": ["…"] }` for choice questions, `{ "text": "…" }` for short answer, numerical and essay questions, `{ "matches": { "<itemId>": "<choiceId>" } }` for matching and `{ "order": ["<itemId>", …] }` for ordering.

An attempt with a non-empty essay answer finishes as `needs_grading`: its `score` is `null` and no grade is recorded until every essay has a mark. Marking the last one makes it `finished`, records the grade (`grade.updated`), emits `quiz.attempt.finished` and notifies the student.

Partial credit: multiple choice gives a share per right choice and takes one away per wrong choice; matching gives an equal share per item matched to its right answer; ordering gives an equal share per neighbouring pair of items in the right order (n items make n − 1 pairs, so `B C D E A` for `A B C D E` earns 3 of 4). An ordering question is first shown in an order that scores nothing, and that order counts as the answer if the student doesn't change it.

### Question bank

Every course has a question bank of questions organised in (optionally nested) categories. All of these need `questionbank:manage` (teachers and administrators).

| Method | Path                                                                          | Description                                                                    |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/courses/:id/question-categories`                                            | Categories in tree order, with question counts                                 |
| POST   | `/courses/:id/question-categories`                                            | `{ name, description?, parentId? }`                                            |
| PATCH  | `/question-categories/:id`                                                    | `{ name?, description?, parentId? }`                                           |
| DELETE | `/question-categories/:id?moveTo=`                                            | Its questions, subcategories and random slots move to `moveTo` first           |
| GET    | `/courses/:id/questions?categoryId=&subcategories=1&q=&type=&page=&pageSize=` | Paginated question summaries, newest first                                     |
| POST   | `/courses/:id/questions`                                                      | A question (below) plus `categoryId?`                                          |
| POST   | `/courses/:id/questions/move`                                                 | `{ ids[], categoryId }`                                                        |
| GET    | `/questions/:id`                                                              | The question with its answers and the quizzes that use it                      |
| PUT    | `/questions/:id`                                                              | Edit (and move with `categoryId`); attempts already started keep their copy    |
| POST   | `/questions/:id/duplicate`                                                    | A copy in the same category                                                    |
| DELETE | `/questions/:id`                                                              | `409` while a quiz uses it directly                                            |
| GET    | `/questions/:id/preview`                                                      | The question as a student sees it, freshly shuffled                            |
| POST   | `/questions/:id/check`                                                        | `{ answer }` grades a preview answer and returns the question with its answers |

A question is `{ type, prompt, points, name?, explanation?, … }` where `type` is `single`, `multiple`, `truefalse`, `short`, `numeric`, `essay`, `matching` or `ordering`, plus: `options: [{ text, correct }]` for choice questions; `acceptedAnswers` (and `tolerance` for numerical); `options: [{ text }]` in the right order for ordering; `pairs: [{ text, answer }]` and `distractors: ["…"]` for matching; `minWords`, `maxWords` and `graderNotes` for essays. `points` is the default mark when the question is added to a quiz.

### Question import, export and sharing

All need `questionbank:manage` in the course. Types are in `src/shared/question-sharing.ts`.

| Method | Path                                      | Description                                                                                                                                                                                                                                                |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/courses/:id/question-import/preview`    | `{ content, filename?, format?: "moodle" \| "gift", categoryId: string \| null, createCategories: boolean }`. Saves nothing; returns `{ format, found, ready, counts, categories, questions, warnings, errors }` (issues have `{ number, line, message }`) |
| POST   | `/courses/:id/question-import`            | Same body. Imports every valid question and new category in one transaction: `201 { imported, categoriesCreated, skipped }`                                                                                                                                |
| POST   | `/courses/:id/question-export`            | `{ format: "moodle" \| "gift", categoryId?, includeSubcategories? (default true), questionIds? }` → `{ filename, mimeType, content, exported, skipped, notes }`                                                                                            |
| GET    | `/question-bank/courses`                  | Courses whose bank you manage (every course for administrators)                                                                                                                                                                                            |
| POST   | `/question-copies`                        | `{ targetCourseId, targetCategoryId?, questionIds? \| categoryId?, includeSubcategories? }` → `201 { questions, categories, categoryId }`. Copies are independent                                                                                          |
| GET    | `/courses/:id/shared-question-categories` | Categories shared with the course, each with `sharedFrom: { courseId, courseTitle }`                                                                                                                                                                       |
| GET    | `/question-categories/:id/shares`         | `{ category, shares, courses, canShareWithSite }` (managers of the owning course)                                                                                                                                                                          |
| POST   | `/question-categories/:id/shares`         | `{ courseId }` or `{ site: true }` (administrators) → `201 QuestionShare`                                                                                                                                                                                  |
| DELETE | `/question-category-shares/:id`           | End a share. Random questions that other courses' quizzes draw from it are frozen to the questions they could pick at that moment                                                                                                                          |

Import limits: 3 MB, 2,000 questions, 200 new categories and category paths of at most 50 levels. Files with a DOCTYPE are refused. A share covers the category and its subcategories; shared questions are read-only, and `GET /courses/:id/questions?categoryId=`, `GET /questions/:id`, `/preview` and `/check` work for courses they are shared with. Deleting a question or category that another course's quiz uses is 409.

### Forums

| Method | Path                          | Description                                    |
| ------ | ----------------------------- | ---------------------------------------------- |
| GET    | `/activities/:id/discussions` | Discussions, pinned first                      |
| POST   | `/activities/:id/discussions` | `{ title, body }`                              |
| GET    | `/discussions/:id`            | Discussion with all posts                      |
| PATCH  | `/discussions/:id`            | `{ title?, pinned?, locked? }`                 |
| DELETE | `/discussions/:id`            | Moderators, or the author before any replies   |
| POST   | `/discussions/:id/posts`      | `{ body, parentId? }`                          |
| PATCH  | `/posts/:id`                  | `{ body }`                                     |
| DELETE | `/posts/:id`                  | Deleting the first post deletes the discussion |

## Grades

| Method | Path                                      | Description                                                                                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/courses/:id/grades?groupId=`            | `{ kind: "gradebook" }` for staff, `{ kind: "mine" }` for students. Staff can pass `groupId` for one group's rows and averages                                                                                                                                                                                                           |
| GET    | `/courses/:id/grades/export.csv?groupId=` | CSV export (`grades:viewAll`), optionally for one group                                                                                                                                                                                                                                                                                  |
| PUT    | `/courses/:id/grades/:activityId/:userId` | `{ score, feedback? }` (`grades:edit`)                                                                                                                                                                                                                                                                                                   |
| GET    | `/courses/:id/grades/setup`               | Categories, weights, drop rules, aggregation and each graded activity's category (`grades:viewAll`)                                                                                                                                                                                                                                      |
| PUT    | `/courses/:id/grades/setup`               | `{ aggregation: "natural" \| "weighted", categories: [{ id, name, weight, dropLowest }], items?: [{ activityId, categoryId, weight }] }` (`grades:manage`). Categories are in display order and must include the default category (id = course id); new ones use any temporary id, and missing ones are deleted. Returns the saved setup |

Courses without a setup use natural (points) totals, as in 0.1.x. Gradebook responses include `aggregation`, `categories` and `categoryAverages`; rows include `categories`, cells `dropped`, and items `categoryId` and `weight`.

## Groups

Groups split a course's participants into teams or sections. Staff see every group; students only see the groups they are in (with their active members). Changing groups needs `course:manageGroups` (teachers; teaching assistants could in 0.2.0 but no longer can).

| Method | Path                                           | Description                                                                                 |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/courses/:id/groups`                          | `{ groups, canManage, allGroups }`, each group with its members (`course:view`)             |
| POST   | `/courses/:id/groups`                          | `{ name, description? }`; names are unique in the course, ignoring case                     |
| POST   | `/courses/:id/groups/auto`                     | `{ split: "groups" \| "members", size, naming?, onlyUngrouped? }`: random, balanced groups  |
| PATCH  | `/courses/:id/groups/:groupId`                 | `{ name?, description? }`                                                                   |
| DELETE | `/courses/:id/groups/:groupId`                 | Members stay in the course                                                                  |
| POST   | `/courses/:id/groups/:groupId/members`         | `{ userIds[] }`; returns `{ added, alreadyMembers, notEnrolled }`. Members must be enrolled |
| DELETE | `/courses/:id/groups/:groupId/members/:userId` |                                                                                             |

`naming` defaults to `Group @`: `#` becomes a number and `@` a letter, skipping names already in use. Auto-create places active students only.

Filter by group with `?groupId=` on `GET /courses/:id/participants` and `GET /activities/:id/submissions`; the group must be one you may see. Each participant has `groups` (only the groups you may see), and the course detail has `myGroups`.

## Group modes

`course:accessAllGroups` (teachers and administrators) sees every group's students and work.

- `POST /courses` and `PATCH /courses/:id` take an optional `groupMode`: `none`, `separate` or `visible` (default `none`). `GET /courses/:id` returns it, and leaves out activities limited to groups the viewer isn't in (for everyone without `course:viewHidden`). For staff, each activity adds `groupMode` (its own setting, or null to follow the course) and `groupRestriction` (`[{ id, name }]`).
- `POST /courses/:id/activities` and `PATCH /activities/:id` take optional `groupMode` (or null for the course default) and `groupIds` (up to 200 group ids to limit the activity to; `[]` opens it to everyone). Groups must belong to the course. A PATCH is all or nothing.
- `GET /activities/:id` returns 404 to students outside the activity's groups, and adds `groups` (`{ mode, groups, allParticipants, postGroups, postToAll }`).
- In separate groups, staff without `course:accessAllGroups` only get their own groups' students in `GET /activities/:id/submissions`, `GET /activities/:id/attempts?all=1`, `GET /activities/:id/grading`, `GET /attempts/:id`, `GET /packages/:id/report`, `GET /packages/:id/cmi5/report`, `GET /live/sessions/:id/attendance` and the gradebook; `?groupId=` must be a group they can pick (404 otherwise). Grading a student you can't see is 404, and a student the activity doesn't apply to is 400.
- Forums: `GET /activities/:id/discussions?groupId=` lists only the discussions you can see, each with `group` (`{ id, name }` or null for all participants). `POST /activities/:id/discussions` takes an optional `groupId` (teachers: any group or null; others: one of their own groups, required when they're in several). `POST /discussions/:id/posts` is 403 when the group rules don't allow replying, and `PATCH /discussions/:id` with `groupId` moves a discussion (teachers).
- The gradebook marks cells `notApplicable` (N/A in the CSV) or `hidden`, and rows `totalsHidden`; the student's own grades leave out activities they can't open.
- `GET /files/:id` follows the rules of the file's activity: hidden or group-restricted activities, other groups' submissions and other groups' forum posts are 404.
- Event: `activity.groups.updated` `{ activityId, courseId, userId }`.

## Cohorts

Cohorts are site-wide groups of people, managed by administrators. Link a cohort to a course to enrol all its members with a course role; people added to the cohort later are enrolled automatically, with the same notifications and `enrolment.created` events as "Enrol people". People already enrolled keep their role and status. Unlinking a cohort, removing someone from it or deleting it never removes enrolments.

| Method | Path                                       | Description                                                                                   |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| GET    | `/admin/cohorts?q=&page=&pageSize=`        | Paginated cohorts with member and linked-course counts                                        |
| POST   | `/admin/cohorts`                           | `{ name, description? }`; names are unique, ignoring case                                     |
| GET    | `/admin/cohorts/:cohortId`                 | The cohort and its course links                                                               |
| PATCH  | `/admin/cohorts/:cohortId`                 | `{ name?, description? }`                                                                     |
| DELETE | `/admin/cohorts/:cohortId`                 | Also removes its course links                                                                 |
| GET    | `/admin/cohorts/:cohortId/members?q=`      | Paginated members                                                                             |
| GET    | `/admin/cohorts/:cohortId/candidates?q=`   | People matching a name or email, marked when already members                                  |
| POST   | `/admin/cohorts/:cohortId/members`         | `{ userIds?[], emails?[] }`; returns `{ added, alreadyMembers, notFound, invalid, enrolled }` |
| DELETE | `/admin/cohorts/:cohortId/members/:userId` |                                                                                               |
| GET    | `/courses/:id/cohorts`                     | Cohorts linked to the course (`course:manageParticipants`)                                    |
| GET    | `/courses/:id/cohorts/available`           | Cohorts that can still be linked: names and member counts                                     |
| POST   | `/courses/:id/cohorts`                     | `{ cohortId, role }`; enrols every member, returns `{ link, enrolled }`                       |
| POST   | `/courses/:id/cohorts/:linkId/sync`        | Enrols members who aren't in the course (for example after a teacher removed them)            |
| DELETE | `/courses/:id/cohorts/:linkId`             | Unlinks; everyone stays enrolled                                                              |

## Completion and certificates

| Method | Path                               | Description                                                                                                                                                                                                                                   |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/courses/:id/completion`          | Your status and checklist (`course:view`). Students are checked on the spot                                                                                                                                                                   |
| GET    | `/courses/:id/completion/report`   | Every active student's progress and completion (`completion:viewReport`)                                                                                                                                                                      |
| GET    | `/courses/:id/completion/settings` | Criteria, certificate settings and the activities to choose from (`completion:manage`)                                                                                                                                                        |
| PUT    | `/courses/:id/completion/settings` | `{ enabled, mode: "all" or "selected", activityIds[], minGrade, certificate: { enabled, title, body, signatureName, signatureTitle } }` (`completion:manage`). Re-checks everyone; returns `{ settings, newlyCompleted, certificatesIssued }` |
| GET    | `/courses/:id/certificates`        | Certificates issued in the course (`completion:viewReport`)                                                                                                                                                                                   |
| GET    | `/certificates/verify/:code`       | Public, no sign-in. `{ code, valid, status, recipientName, courseTitle, completedAt }`; 404 for unknown codes                                                                                                                                 |
| GET    | `/certificates/:id`                | The certificate (its owner, the course staff, administrators)                                                                                                                                                                                 |
| POST   | `/certificates/:id/revoke`         | `{ reason? }` (`completion:manage`, or administrators)                                                                                                                                                                                        |
| POST   | `/certificates/:id/restore`        | (`completion:manage`, or administrators)                                                                                                                                                                                                      |
| GET    | `/me/certificates`                 | Your certificates                                                                                                                                                                                                                             |

## Badges

| Method | Path                         | Description                                                                                                |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/courses/:id/badges?for=`   | Course badges with `earnedAt` for you, or for user `for` (staff only)                                      |
| POST   | `/courses/:id/badges`        | `{ name, description?, icon, color, criteria: "manual" or "completion" }` (`badges:manage`)                |
| GET    | `/badges`                    | Site badges (administrators)                                                                               |
| POST   | `/badges`                    | `{ name, description?, icon, color, criteria: "manual" or "courses", courseIds[] }` (administrators)       |
| GET    | `/badges/:id`                | Badge detail; `recipients` only for people who can award it                                                |
| PATCH  | `/badges/:id`                | Same fields as creating (`badges:manage`; administrators for site badges)                                  |
| DELETE | `/badges/:id`                | Deletes the badge and its awards                                                                           |
| POST   | `/badges/:id/awards`         | `{ userIds[], note? }`: award, or restore a revoked award (`badges:award`; administrators for site badges) |
| DELETE | `/badges/:id/awards/:userId` | Revoke                                                                                                     |
| GET    | `/me/badges`                 | Your earned badges                                                                                         |

Icons: award, medal, trophy, star, rocket, flame, zap, crown, gem, heart, lightbulb, target, graduation-cap, book-open, code, puzzle, brain, sparkles, message-circle, globe. Colours: gold, silver, bronze, indigo, violet, sky, teal, emerald, rose, fuchsia.

## Email

| Method | Path                        | Description                                                                                                                             |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/email/preferences`        | Your delivery choice, the site default and your switched-off categories                                                                 |
| PUT    | `/email/preferences`        | `{ frequency?: "immediately" \| "daily" \| "weekly" \| "off" \| null, disabledCategories?: string[] }`; `null` follows the site default |
| GET    | `/email/unsubscribe?token=` | What an unsubscribe link is for (no sign-in needed)                                                                                     |
| POST   | `/email/unsubscribe`        | `{ token, scope?: "all" \| "category" }` (no sign-in needed)                                                                            |
| GET    | `/admin/email`              | Delivery status, transport, outbox counts and digest settings (administrators)                                                          |
| PUT    | `/admin/email/settings`     | `{ defaultFrequency?, digestHour?, digestWeekday?, timezone? }` (administrators)                                                        |
| POST   | `/admin/email/test`         | `{ to? }` queues a test email (administrators)                                                                                          |
| GET    | `/admin/email/messages/:id` | A queued message's status, for polling the test email (administrators)                                                                  |
| POST   | `/admin/email/retry-failed` | Queue failed emails again (administrators)                                                                                              |

Mail apps' one-click unsubscribe (RFC 8058) posts to `/unsubscribe?token=` at the site root, outside `/api`.

## Open Badges

Signed in, for your own badges:

| Method   | Path                      | Description                                                                                                                                         |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/badges/:id/share`       | `{ earned, unavailableReason, share }`; `share` is `{ id, sharedAt, links: { assertion, page, badgeImage, credential, credentialImage } }` or null  |
| POST     | `/badges/:id/share`       | Share a badge you hold (403 otherwise or while impersonating; 409 without `COURSEKIT_PUBLIC_URL`)                                                   |
| DELETE   | `/badges/:id/share`       | Stop sharing; the old link answers "revoked"                                                                                                        |
| GET      | `/me/badge-shares`        | `[{ badgeId, share }]`                                                                                                                              |
| GET      | `/open-badges/shares/:id` | Public. What the verification page shows: `{ status: "valid" \| "revoked", revocationReason, issuer, badge, recipientName, issuedOn, note, links }` |
| GET, PUT | `/admin/open-badges`      | Issuer settings `{ name, email, description }` (administrators; the email is published)                                                             |

Public documents, outside `/api` (GET, CORS `*`, 404 without `COURSEKIT_PUBLIC_URL`; add `?download` to images and credentials):

| Path                                                            | Description                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/openbadges/v2/issuer`                                         | Open Badges 2.0 issuer profile                                                                                                                |
| `/openbadges/v2/badges/:badgeId` and `/image.svg`               | BadgeClass and image, only while someone shares the badge                                                                                     |
| `/openbadges/v2/assertions/:id` and `/badge.svg`                | Hosted assertion (410 with `revoked: true` once revoked or withdrawn; browsers asking for HTML go to `/verify-badge/:id`) and the baked image |
| `/openbadges/v3/issuer`, `/openbadges/v3/achievements/:badgeId` | Open Badges 3.0 Profile and Achievement                                                                                                       |
| `/openbadges/v3/credentials/:id` and `/badge.svg`               | OpenBadgeCredential as a VC-JWT (RS256) and the baked image; 410 once revoked                                                                 |
| `/openbadges/v3/status/1`                                       | Revocation list (BitstringStatusListCredential as a VC-JWT)                                                                                   |
| `/openbadges/v3/jwks.json`, `/openbadges/v3/keys/:kid`          | The public signing key                                                                                                                        |

Revocation is permanent: a restored award must be shared again, which gives new links.

## External tools (LTI 1.3)

| Method      | Path                                | Description                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, POST   | `/admin/lti/tools`                  | Administrators. `{ platform, tools }`; POST `{ name, description?, toolUrl, loginUrl, redirectUris[], keyType: "jwks" \| "key", jwksUrl?, publicKey?, deepLinkingUrl?, customParams?, shareName?, shareEmail?, allowAgs?, allowNrps?, status? }` returns the tool with its generated `clientId` and `deploymentId`                                                     |
| GET, PATCH  | `/admin/lti/tools/:id`              | Administrators. `{ status: "disabled" }` turns a tool off                                                                                                                                                                                                                                                                                                              |
| GET         | `/admin/lti/tools/:id/registration` | Administrators. What a tool that registered itself asked for: `{ id, url, registeredAt, startedBy, clientName, description, logoUri, clientUri, policyUri, tosUri, contacts, domain, secondaryDomains, requestedScopes, grantedScopes, requestedClaims, messages: [{ type, label, targetLinkUri, placements, used }], outsideDomains }`. 404 for tools added by hand   |
| POST        | `/admin/lti/registrations`          | Administrators. `{ url }`: the tool's registration URL (https, or http on localhost; not an address on this site) → `201 { id, openUrl, expiresAt }`. Open `openUrl` (the URL with `openid_configuration` and `registration_token` added) in a frame or a window. The token works once, for an hour, while you're an administrator. 400 without `COURSEKIT_PUBLIC_URL` |
| GET         | `/admin/lti/registrations`          | Administrators. Tools that registered themselves: `[{ toolId, registeredAt }]`                                                                                                                                                                                                                                                                                         |
| GET, DELETE | `/admin/lti/registrations/:id`      | Administrators. `{ id, status: "pending" \| "completed" \| "expired", expiresAt, toolId, toolName }`, for polling. DELETE cancels a registration the tool hasn't used, so its token stops working (409 once the tool has registered)                                                                                                                                   |
| GET         | `/courses/:id/lti/tools`            | `course:manageContent`. Tools teachers can pick; `grades` is true when the tool may send scores                                                                                                                                                                                                                                                                        |
| GET         | `/lti/activities/:id`               | Launch info for an External tool activity and your grade                                                                                                                                                                                                                                                                                                               |

External tool activities use `type: "lti"` with `settings: { toolId, launchUrl?, custom?, presentation: "window" \| "embed", lineItemResourceId?, lineItemTag? }`; `maxGrade: null` makes them ungraded.

Tools that register themselves (Dynamic Registration) start with `status: "disabled"` and a new `clientId` and `deploymentId`, and only get the scopes in `grantedScopes`. Launch URLs and content items must be on the tool URL's host, or on the domain and secondary domains a registered tool declared, or on their subdomains. Content selection only offers grade columns (`accept_lineitem`) to tools that may send scores, and ignores line items from other tools.

LTI endpoints, outside `/api`:

| Method           | Path                                                                   | Description                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET              | `/lti/jwks`                                                            | The platform's public keys                                                                                                                                                                                                                                                                                       |
| GET, OPTIONS     | `/lti/openid-configuration`                                            | Public, CORS. The platform's OpenID configuration for Dynamic Registration (cached for 5 minutes; 404 without `COURSEKIT_PUBLIC_URL`). OPTIONS answers the preflight for an `Authorization` header, which is ignored                                                                                             |
| POST, OPTIONS    | `/lti/registration`                                                    | Dynamic Registration: `Authorization: Bearer <registration_token>` and a JSON client registration (64 KB at most) → `201` with `client_id`, what Coursekit recorded, `scope` (the granted scopes) and the `https://purl.imsglobal.org/spec/lti-tool-configuration` object with `deployment_id`. CORS, no cookies |
| GET              | `/lti/launch/:activityId`                                              | Signed in. Starts a launch (third-party initiated login)                                                                                                                                                                                                                                                         |
| GET              | `/lti/deep-link/start?courseId=&toolId=&sectionId=` (or `activityId=`) | `course:manageContent`. Starts content selection                                                                                                                                                                                                                                                                 |
| GET, POST        | `/lti/auth`                                                            | OIDC authorization endpoint; answers with a form post of the signed `id_token` and `state`                                                                                                                                                                                                                       |
| POST             | `/lti/deep-link/return`                                                | `JWT=` the tool's LtiDeepLinkingResponse                                                                                                                                                                                                                                                                         |
| POST             | `/lti/token`                                                           | OAuth 2.0 `client_credentials` with a JWT `client_assertion`; a 1-hour bearer token                                                                                                                                                                                                                              |
| GET, POST        | `/lti/ags/:courseId/lineitems`                                         | Line item container (`Link: rel="next"` paging)                                                                                                                                                                                                                                                                  |
| GET, PUT, DELETE | `/lti/ags/:courseId/lineitems/:id`                                     | A line item (an activity's own line item can't be deleted)                                                                                                                                                                                                                                                       |
| POST             | `/lti/ags/:courseId/lineitems/:id/scores`                              | `application/vnd.ims.lis.v1.score+json`                                                                                                                                                                                                                                                                          |
| GET              | `/lti/ags/:courseId/lineitems/:id/results`                             | Results                                                                                                                                                                                                                                                                                                          |
| GET              | `/lti/nrps/:courseId/memberships?role=&limit=`                         | Members with context roles; names and emails only when allowed                                                                                                                                                                                                                                                   |

Services use the AGS and NRPS media types (406 or 415 otherwise), `Authorization: Bearer`, and answer 404 for a course with no activity using the calling tool.

A registration follows LTI Dynamic Registration 1.0 and OpenID Connect Dynamic Client Registration. It needs `client_name`, `initiate_login_uri`, `redirect_uris`, `jwks_uri`, `token_endpoint_auth_method: "private_key_jwt"`, `response_types` with `id_token`, `grant_types` with `implicit` and `client_credentials`, and the tool configuration with `domain` and `target_link_uri`. On a public site every tool URL must be https, not on Coursekit's own origin and not on this machine or its local link (loopback, unspecified and link-local addresses); http and local addresses only work while Coursekit itself runs on localhost. The tool gets the scopes it asked for that Coursekit supports, names when it asks for the `name`, `given_name` or `family_name` claim, and email addresses when it asks for `email`. Errors are `{ error, error_description }`:

- 400 `invalid_redirect_uri` or `invalid_client_metadata`, also for JSON that can't be read;
- 401 `invalid_token` when the token is missing, wrong, used or expired, or the administrator who started the registration no longer is one;
- 404 `not_found` without `COURSEKIT_PUBLIC_URL`;
- 413 over 64 KB and 415 when the body isn't `application/json` (`invalid_client_metadata`);
- 429 `invalid_request` after too many requests with a missing or bad token (see [Client addresses behind a proxy](#client-addresses-behind-a-proxy)).

## SCORM and xAPI packages

| Method | Path                                    | Description                                                                                                                                                                                                                                                                                                                            |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/packages/:activityId`                 | Player info: `settings`, `current` (the package version and its table of contents), your attempts, `mode` (`learner` or `preview`), `canStartNew`, `resumeAttemptId`, `grade`                                                                                                                                                          |
| POST   | `/packages/:activityId/import`          | `course:manageContent`. `{ fileId }` of a zip (or a [cmi5](#cmi5-courses) `cmi5.xml`) uploaded with `POST /files` (context `activity`); becomes the new current version (201). A bad package is 422 `invalid_package`                                                                                                                  |
| POST   | `/packages/:activityId/launch`          | `{ itemId?, attemptId?, newAttempt?, preview?, nav?, sid?, deliveryId? }` → `{ url, attemptId, itemId, mode, display, items, sequencing? }`. xAPI launch URLs carry `endpoint`, `auth`, `actor`, `registration` and `activity_id`. `nav`, `sid`, `deliveryId` and `sequencing` are for [SCORM 2004 sequencing](#scorm-2004-sequencing) |
| GET    | `/packages/:activityId/report?groupId=` | `grades:viewAll`. `{ maxGrade, rows: [{ user, attempts, grade, completed }] }`                                                                                                                                                                                                                                                         |

Package activities use `type: "package"` with `settings: { display: "embed" \| "window", attemptsAllowed (0 = unlimited), gradingMethod: "highest" \| "last", requirePass }`.

Outside `/api`:

- `GET /content/:token/*` serves package files with `Content-Security-Policy: sandbox …` (never `allow-same-origin`), `nosniff`, `Cross-Origin-Resource-Policy: cross-origin` and no `X-Frame-Options`. HTML gets the run-time script first in `<head>`. Tokens are HMAC-signed, bound to the activity, version, user, attempt and purpose, and expire after six hours.
- `POST /content/:token/__coursekit/commit` takes run-time commits (text/plain JSON, at most 2 MB). Previews record nothing.
- The xAPI Learning Record Store under `/xapi/`: `about`, `statements` (PUT, POST and GET with `statementId`, `voidedStatementId` or `agent`, `verb`, `activity`, `registration`, `since`, `until`, `limit`, `ascending`), `activities/state`, `activities/profile`, `agents/profile`, `activities` and `agents`. Requests need `X-Experience-API-Version` and the Basic credentials from the launch URL, which only reach the learner's own data. CORS allows any origin; bodies are limited to 1 MB. Repeated slashes in the path count as one, so `/xapi//statements` works.

### SCORM 2004 sequencing

Outside archived courses, a learner's SCORM 2004 attempt in progress follows the package's sequencing and navigation rules, and the server runs them. `POST /packages/:activityId/launch` opens what the rules deliver and takes the learner's navigation requests. Types are in `src/shared/package-sequencing.ts`.

- With no `nav` and no `itemId`, the attempt opens where the learner left it: a part that was still open is suspended and resumed (a new delivery), and a suspended attempt resumes. A new attempt begins with Start or, when the rules don't allow it (no flow, as in packages without sequencing rules), with the first part that can be chosen.
- `itemId` without `nav` is a choice request. An `itemId` of the part that is already open changes nothing (`nav: "choice"` would start it over).
- `nav` is a navigation request: `start`, `resumeAll`, `continue`, `previous`, `choice` (of the item in `itemId`), `exit`, `exitAll`, `abandon`, `abandonAll` or `suspendAll`. `_none_` makes no request and returns where the attempt is now. Other values are 400, `jump` too: jump is for content only (`adl.nav.request` in 4th edition packages).
- `deliveryId` is the `sequencing.deliveryId` the player is showing, or `null` when nothing is open. When the attempt has moved on from it (in another window, for example), a navigation request changes nothing, doesn't wait for `sid`, and returns where the attempt is now, with a `message`.
- `sid` is the run-time session of the page the player has just closed (`sid` in the messages the run-time posts to the player). Before it navigates, the server waits up to 3 seconds for the commit that ends that session.

A request the rules refuse changes nothing, and `sequencing.message` says why. When a request leaves nothing open and nothing that can be opened, the attempt ends (`sequencing.ended`).

The response has `sequencing`: `{ deliveryId, ended, suspended, controls, toc, message, completionStatus, successStatus, score, totalSeconds }`.

- `deliveryId` changes with every delivery (a new attempt on a part, or a resumed one). It is `null` when nothing is open: while the attempt is suspended, once it is over, or when the learner has to choose what to open (after `exit`, for example). `url` and `itemId` are then `''`.
- `ended` is true once the attempt is over, and `suspended` while it is suspended.
- `controls` (`previous`, `continue`, `exit`, `exitAll`, `suspendAll`, `abandon`, `abandonAll`) are the player's buttons to show: requests that are valid now and that the open part's `hideLMSUI` doesn't hide. `exit` also needs more than one part.
- `toc` lists every item of the manifest, in order: `{ id, title, depth, leaf, visible, canChoose, current, attempted, suspended, completionStatus, successStatus, score }`. `visible` is false for what the contents don't show (`isvisible="false"`, hidden from choice by a rule, or not selected for this attempt). `canChoose` is true when a choice of the item would succeed now, except for the part that is open.
- `message` explains a refused request, says that the attempt had moved on from the `deliveryId` sent, or asks the learner to choose what to open next; otherwise it is `null`.
- `completionStatus`, `successStatus` and `score` (percent) are the attempt's result so far, rolled up to the root of the package, and `totalSeconds` its time.

A request with `nav` for a finished attempt (its `attemptId`) gets the attempt's summary: `sequencing.ended` is true, `url` and `itemId` are empty, and all `controls` are false. Without `nav`, a finished attempt opens for review. In an archived course, an attempt in progress opens for review too, with or without `nav`. Reviews and staff previews don't follow the rules: they have no `sequencing`, any part opens, and nothing is recorded.

SCORM 2004 package versions (`PackageVersionInfo`, in `GET /packages/:activityId` and the import response) can have `warnings`: up to 50 notes on what the manifest had that was ignored or replaced by a default. Each item keeps at most 20 rules of each kind (pre-, exit- and post-condition, and rollup), 20 maps per objective and 20 shared data maps, and no rule with more than 10 conditions: the rest is ignored, with a warning. A SCORM 2004 import is 422 `invalid_package` when items are nested more than 32 levels deep, or when what is kept adds up to more than 10,000 objectives (every item counts at least its primary one), 20,000 rules (sequencing and rollup), 40,000 rule conditions or 20,000 maps (objective maps and shared data maps). A sequencing collection counts once for each item that uses it.

Outside `/api`:

- Content links of a SCORM 2004 attempt belong to one delivery of a part. Once the learner has moved on from that delivery, `GET /content/:token/__coursekit/runtime.js` answers 403. Commits answer 403 (`{ "ok": false, "error": "forbidden" }`) for an older delivery of the part, and for a page session that hadn't saved before the learner moved on. After a refused commit, the run-time answers the content's `Commit` and `Terminate` with error 391.
- Commits answer 409 (`busy`) when too many requests change the attempt at once, and 413 (`too_large`) when its sequencing state would grow beyond 4 MB. `POST /packages/:activityId/launch` can answer 409 and 413 for the same reasons.

### cmi5 courses

A package activity also plays cmi5 courses (Quartz edition): a zip with `cmi5.xml` at its root, or a `cmi5.xml` on its own when every AU is on another website. A zip with both `imsmanifest.xml` and `cmi5.xml` stays a SCORM package. Each attempt is one cmi5 registration, and every launch is a new session. Types are in `src/shared/cmi5.ts`.

| Method | Path                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/packages/:activityId/cmi5`                 | Anyone who can open the activity. `{ activityId, attemptId, attemptNumber, attemptStatus, version, course: { title, description, satisfied }, nodes }`: the blocks and AUs depth-first, each with `kind`, `key`, `title`, `description`, `depth`, `status`, `satisfied`, `score` (percent), `moveOn`, `masteryScore`, `launchMethod`, `external` and `review`. Learners get the statuses of their unfinished attempt, or else their latest; staff get the structure without statuses. 400 when the activity has no cmi5 course |
| POST   | `/packages/:activityId/cmi5/launch`          | `{ itemId?, attemptId?, newAttempt?, preview? }`, where `itemId` is an AU's `key` (by default the first AU the learner hasn't finished) → the launch response plus `cmi5: { launchMode: "Normal" \| "Browse" \| "Review", launchMethod, external, sessionId }`. cmi5 launch URLs carry `endpoint`, `fetch`, `actor`, `registration` and `activityId`. 403 once the attempt was launched 2,000 times; 409 when the activity's current package isn't a cmi5 course (the teacher replaced it: reload the page)                    |
| GET    | `/packages/:activityId/cmi5/report?groupId=` | `grades:viewAll`. `{ maxGrade, aus: [{ key, title }], rows: [{ user, attempts, grade, completed }] }`, with `aus` from the current version; each attempt adds `satisfied` and `aus: { [key]: { status, score } }`                                                                                                                                                                                                                                                                                                              |

`POST /packages/:activityId/launch` launches cmi5 courses too, with the same response. Both routes put the browser's `Accept-Language` into the `languagePreference` of `cmi5LearnerPreferences`; when none is usable, the languages from an earlier launch stay, or else `en-US` is used. Staff previews run in Browse mode and record nothing. Learners get Review mode, which records nothing that counts, for an AU they finished and for every AU of an archived course (`review` in `nodes`); in a finished attempt, the AUs they haven't finished still launch in Normal mode. `display` is `window` for `OwnWindow` AUs. With `newAttempt`, or in an attempt nothing was launched in yet, an `itemId` the current version doesn't have starts the first AU instead of being refused. An invalid course structure is 422 `invalid_package`, with a message starting with `cmi5.xml:`. Statuses are `not attempted`, `in progress`, `completed`, `passed`, `failed` and `satisfied`.

Outside `/api`:

- `POST /cmi5/fetch/:token` is the one-time fetch URL from the launch URL's `fetch` parameter: no cookies, CORS `*`, valid for 30 minutes. It always answers 200: the first time with `{ "auth-token": "…" }` (Base64 Basic credentials for the LRS), after that with `{ "error-code": "1", "error-text": "…" }`. Code 1 means used, expired or the session has ended; 2 not valid, or the learner can no longer open the activity; 3 any other problem. Other methods get 405.
- `GET /cmi5/return/:courseSlug/:activityId` is the `returnURL` in `LMS.LaunchData`. In the player's frame it tells the player the AU is done; in a window of its own it closes, or goes back to the activity page.
- The LRS under `/xapi/` also takes the credentials from the fetch URL. They are tied to the learner, the registration and the session, and stop working (401) when the session is abandoned, 60 seconds after `terminated`, after 12 hours without requests, or after 7 days. Statements are refused (403) until the AU has read `cmi5LearnerPreferences`, and must follow the cmi5 rules: the session's registration and context template; `initialized` first and nothing after `terminated`; cmi5 defined statements (those with the cmi5 category) about the AU, with the moveon category on `completed`, `passed` and `failed`, and `result.duration` on all but `initialized`; `completed` and `passed` once per registration; `passed` and `failed` checked against the mastery score (`result.score.scaled`), with integer raw scores that have `min` and `max`; no `completed`, `passed` or `failed` in Browse or Review mode; and no voiding. A violation is 403, and nothing in the request is stored. State API requests must name the session's registration (403 otherwise), statement queries only return its statements, and `LMS.LaunchData` and `cmi5LearnerPreferences` are read-only (403).
- Coursekit records `launched`, `satisfied` (for blocks and the course) and `abandoned` (for a session that ended without `terminated`) itself, with Coursekit as the authority. A cmi5 registration's statements get `stored` times one millisecond apart, in the order they arrived.

## Live classes

A live class holds sessions that people join through Coursekit. `live:moderate` (teachers, teaching assistants and administrators) starts sessions as a moderator or host, takes attendance and manages recordings. Scheduling and changing sessions needs `course:manageContent` (teachers and administrators). Routes without a capability are for anyone who can open the class. Types are in `src/shared/live.ts`.

| Method        | Path                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, PUT      | `/admin/live`                            | Administrators. Provider settings `{ publicUrl, bbb, zoom, jitsi, link, zoomWebhookUrl, usage }`, each provider with `enabled`, `ready`, `problem` and `note`, and secrets only as `secretSet`, `clientSecretSet`, `webhookSecretSet` or `appSecretSet`. PUT `{ bbb?: { enabled?, url?, algorithm?: "sha1" \| "sha256" \| "sha384" \| "sha512", secret?, analytics? }, zoom?: { enabled?, accountId?, clientId?, clientSecret?, webhookSecret?, defaultHost?, hosts?: string[], concurrentMeetings?: 1 \| 2 }, jitsi?: { enabled?, url?, appId?, appSecret? }, link?: { enabled? } }` returns the same. Leave a secret out to keep it; a string replaces it and `null` clears it. A Jitsi app secret has at least 32 characters |
| POST          | `/admin/live/:provider/test`             | Administrators. Checks a provider's settings with a harmless call: `{ ok, message }`, or 400 with the reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET           | `/live/providers?courseId=`              | `course:manageContent`. The providers that are set up: `[{ id, label, description, recordings, waitForModerator, embeddable, groupRooms }]`, plus `defaultHost`, `hosts` and `concurrentMeetings` for Zoom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET           | `/live/activities/:id`                   | The class for the viewer (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST          | `/live/activities/:id/sessions`          | `course:manageContent`. `{ startsAt, durationMinutes, title?, agenda?, meetingUrl?, timeZone, repeat?: { frequency: "daily" \| "weekly", count } }` → `201 { ids }`. Sessions last 5 to 720 minutes, and `count` is the number of sessions (up to 100). `timeZone` is the browser's IANA zone; repeats keep their local time across daylight saving changes. A class has at most 300 sessions                                                                                                                                                                                                                                                                                                                                   |
| GET           | `/live/activities/:id/ics`               | Every session of the class as an iCalendar file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PATCH, DELETE | `/live/sessions/:id`                     | `course:manageContent`. PATCH `{ startsAt?, durationMinutes?, title?, agenda?, meetingUrl?, timeZone? }`, not for a cancelled session. DELETE removes the session with its attendance and recordings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST          | `/live/sessions/:id/cancel`              | `course:manageContent`. Cancels the session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET           | `/live/sessions/:id/ics`                 | The session as an iCalendar file (`STATUS:CANCELLED` once cancelled)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET           | `/live/sessions/:id/attendance?groupId=` | `live:moderate`. `{ sessionId, rows: [{ user, groups, status, source: "manual" \| "provider" \| "join" \| null, marked, joinedAt, leftAt, minutes }], guests, groupChoice, sourceNote, canMark }` for the students you see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PUT           | `/live/sessions/:id/attendance/:userId`  | `live:moderate`. `{ status: "present" \| "absent" \| null }` once the session has started; `null` goes back to the automatic status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST          | `/live/sessions/:id/recordings`          | `live:moderate`. `{ title, url (https), groupId? }` adds a recording link → `201 { id }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH, DELETE | `/live/recordings/:id`                   | `live:moderate`. PATCH `{ hidden }`, which also unpublishes or publishes a BigBlueButton recording. DELETE removes it (BigBlueButton deletes it, Zoom moves it to the trash)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST          | `/live/sessions/:id/refresh`             | `live:moderate`. Fetches attendance and recordings from the provider now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST          | `/live/sessions/:id/end`                 | `live:moderate`. `{ groupId? }` ends the running BigBlueButton or Zoom meetings for everyone → `{ ended }` (how many)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST          | `/live/sessions/:id/embed`               | `{ groupId? }` → `{ url }`, for a self-hosted Jitsi Meet class shown in the page. Checks and records the join like `/live/join` (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Students who can see the class are told when sessions are scheduled, and when a session that hasn't ended is moved, cancelled or deleted. They get a reminder `reminderMinutes` before each session. These notifications (`live.scheduled`, `live.moved`, `live.cancelled` and `live.reminder`) are in the `live` email category.

`GET /live/activities/:id` returns `{ activityId, provider, providerLabel, ready, problem, warning, canManage, canModerate, groupMode, myGroups, embed, canEndForEveryone, joinMinutesBefore, sessions, completion, icsUrl, serverTime }`. Each session has `state` (`upcoming`, `open`, `live`, `ended` or `cancelled`), `joinOpensAt`, `rooms` (`[{ groupId, groupName, mine, joinable, canJoin, joinUrl }]`), `canJoin`, `joinNote`, `recordings` and `icsUrl`. Learners also get their own `attendance`; staff with `live:moderate` get `attendanceSummary` and `syncError`, and those with `course:manageContent` the session's `meetingUrl`. With a group mode, BigBlueButton, Zoom and Jitsi Meet give each group its own room, and `joinable` marks the rooms you can enter: your own groups', or every group's with `course:accessAllGroups`. In a Zoom class, staff rooms add `canStart` (whether `joinUrl` starts the meeting as its host) and `participantUrl`, and `warning` tells staff when group rooms share a host that can't run them all at once. `completion` is `{ required, attended }` for learners when the class completes automatically.

Live class activities use `type: "live"` with `settings: { provider: "bbb" | "zoom" | "jitsi" | "link" | null, joinMinutesBefore, reminderMinutes, waitForModerator, recording: "off" | "manual" | "auto", attendanceRequired, welcomeMessage, meetingUrl, zoomHost, zoomGroupHosts, embed }`. The provider must be one an administrator set up. Students can join from `joinMinutesBefore` minutes (0 to 120, default 10) before a session starts until it ends; staff with `live:moderate` can start it at any time. `reminderMinutes` is 1 to 1,440, or `null` for no reminders (default 15). `waitForModerator` and `recording` apply to BigBlueButton and Zoom, `welcomeMessage` to BigBlueButton and `embed` to a self-hosted Jitsi Meet server. `zoomGroupHosts` is `{ [groupId]: email }`, a host for each group's room. `meetingUrl`, `zoomHost` and `zoomGroupHosts` are only returned to people with `course:manageContent`. Teachers can only set a Zoom host to the default host, a host an administrator added or their own email (instructor accounts); administrators can set any, and unchanged values always pass. `completion: "auto"`, the default, completes the class once a student has attended `attendanceRequired` sessions. Live classes have no grade.

`GET /calendar` includes scheduled sessions as `kind: "live"` events with `endsAt` and an `icsUrl`, with the same visibility rules as due dates. In `GET /dashboard`, `timeline` has the next (or running) session of each live class in the courses you study, in the next 45 days: `type: "live"`, with `dueAt` when it starts and `endsAt` when it ends.

Live class endpoints, outside `/api`:

| Method    | Path                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET       | `/live/join/:sessionId?group=&as=participant` | Signed in. Checks access, the person's group and the join window, records the join and redirects to the meeting: a BigBlueButton join link (as a moderator for staff), a Zoom start link for staff when the host is shared or is themselves (otherwise, and with `as=participant`, the join link), a Jitsi Meet room or the meeting link. Opened from another site, it asks for a click first. It shows a waiting page while BigBlueButton students wait for a teacher, and a room picker when several rooms fit |
| GET, POST | `/live/bbb/:token/ended`                      | BigBlueButton's meeting-ended callback (`meetingEndedURL`), confirmed with `isMeetingRunning` at most every 10 seconds per room (429 in between)                                                                                                                                                                                                                                                                                                                                                                 |
| POST      | `/live/bbb/:token/recording`                  | BigBlueButton's recording-ready callback: `signed_parameters`, a JWT signed (HS256) with the shared secret                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST      | `/live/bbb/:token/analytics`                  | BigBlueButton's learning analytics callback: JSON with an `Authorization: Bearer` JWT signed (HS512) with the shared secret                                                                                                                                                                                                                                                                                                                                                                                      |
| POST      | `/live/zoom/webhook`                          | Zoom webhooks, verified with `x-zm-signature` and `x-zm-request-timestamp` (within 5 minutes); answers `endpoint.url_validation`. 404 until Zoom and its webhook secret token are set                                                                                                                                                                                                                                                                                                                            |

Coursekit gives BigBlueButton these addresses only when `COURSEKIT_PUBLIC_URL` is set, and the analytics one only while learning analytics is on. They are signed for one room and purpose: 404 for a bad token, 401 for a bad signature, 410 when the class is gone and 503 when BigBlueButton isn't set up or can't be reached. Bodies under `/live/` are limited to 64 KB (1 MB for the Zoom webhook, 4 MB for analytics).

## Files

| Method | Path         | Description                                                                                     |
| ------ | ------------ | ----------------------------------------------------------------------------------------------- |
| POST   | `/files`     | Multipart: `file`, `context` (`submission`, `activity`, `course`, `post`, `avatar`), `courseId` |
| GET    | `/files/:id` | Download, if you may see it. Add `?download=1` to force a download                              |

## You

| Method | Path                   | Description                                                                         |
| ------ | ---------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/dashboard`           | Courses, deadlines and upcoming live sessions, announcements, grades, grading queue |
| GET    | `/notifications`       | Latest notifications and the unread count                                           |
| POST   | `/notifications/read`  | `{ ids? }`; all when omitted                                                        |
| GET    | `/calendar?from=&to=`  | Due dates, course dates, [live class](#live-classes) sessions and events            |
| POST   | `/calendar/events`     | `{ title, startsAt, endsAt?, description?, courseId? }`                             |
| DELETE | `/calendar/events/:id` |                                                                                     |
| GET    | `/search?q=`           | Courses, activities (and people, for admins)                                        |

## Administration

Administrators only.

| Method | Path                            | Description                                                                         |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/admin/overview`               | Counts, sign-ups, popular courses                                                   |
| GET    | `/admin/users?q=&role=&status=` | Paginated people                                                                    |
| POST   | `/admin/users`                  | `{ name, email, role, password? }`; returns a temporary password when none is given |
| PATCH  | `/admin/users/:id`              | `{ name?, email?, role?, status?, password? }`                                      |
| DELETE | `/admin/users/:id`              |                                                                                     |
| POST   | `/admin/users/:id/impersonate`  | "Log in as" another (non-admin) user                                                |
| GET    | `/admin/settings`               | Site settings                                                                       |
| PUT    | `/admin/settings`               | `{ name?, tagline?, brandColor?, allowSignup?, welcomeMessage? }`                   |
| GET    | `/admin/courses?q=`             | Every course, including drafts                                                      |
| GET    | `/categories`                   | Any signed-in user                                                                  |
| POST   | `/categories`                   | `{ name, description? }`                                                            |
| PATCH  | `/categories/:id`               |                                                                                     |
| DELETE | `/categories/:id`               | Courses become uncategorised                                                        |
