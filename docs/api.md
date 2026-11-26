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
- In separate groups, staff without `course:accessAllGroups` only get their own groups' students in `GET /activities/:id/submissions`, `GET /activities/:id/attempts?all=1`, `GET /activities/:id/grading`, `GET /attempts/:id`, `GET /packages/:id/report` and the gradebook; `?groupId=` must be a group they can pick (404 otherwise). Grading a student you can't see is 404, and a student the activity doesn't apply to is 400.
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

| Method     | Path                     | Description                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET, POST  | `/admin/lti/tools`       | Administrators. `{ platform, tools }`; POST `{ name, description?, toolUrl, loginUrl, redirectUris[], keyType: "jwks" \| "key", jwksUrl?, publicKey?, deepLinkingUrl?, customParams?, shareName?, shareEmail?, allowAgs?, allowNrps?, status? }` returns the tool with its generated `clientId` and `deploymentId` |
| GET, PATCH | `/admin/lti/tools/:id`   | Administrators. `{ status: "disabled" }` turns a tool off                                                                                                                                                                                                                                                          |
| GET        | `/courses/:id/lti/tools` | `course:manageContent`. Tools teachers can pick                                                                                                                                                                                                                                                                    |
| GET        | `/lti/activities/:id`    | Launch info for an External tool activity and your grade                                                                                                                                                                                                                                                           |

External tool activities use `type: "lti"` with `settings: { toolId, launchUrl?, custom?, presentation: "window" \| "embed", lineItemResourceId?, lineItemTag? }`; `maxGrade: null` makes them ungraded.

LTI endpoints, outside `/api`:

| Method           | Path                                                                   | Description                                                                                |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET              | `/lti/jwks`                                                            | The platform's public keys                                                                 |
| GET              | `/lti/launch/:activityId`                                              | Signed in. Starts a launch (third-party initiated login)                                   |
| GET              | `/lti/deep-link/start?courseId=&toolId=&sectionId=` (or `activityId=`) | `course:manageContent`. Starts content selection                                           |
| GET, POST        | `/lti/auth`                                                            | OIDC authorization endpoint; answers with a form post of the signed `id_token` and `state` |
| POST             | `/lti/deep-link/return`                                                | `JWT=` the tool's LtiDeepLinkingResponse                                                   |
| POST             | `/lti/token`                                                           | OAuth 2.0 `client_credentials` with a JWT `client_assertion`; a 1-hour bearer token        |
| GET, POST        | `/lti/ags/:courseId/lineitems`                                         | Line item container (`Link: rel="next"` paging)                                            |
| GET, PUT, DELETE | `/lti/ags/:courseId/lineitems/:id`                                     | A line item (an activity's own line item can't be deleted)                                 |
| POST             | `/lti/ags/:courseId/lineitems/:id/scores`                              | `application/vnd.ims.lis.v1.score+json`                                                    |
| GET              | `/lti/ags/:courseId/lineitems/:id/results`                             | Results                                                                                    |
| GET              | `/lti/nrps/:courseId/memberships?role=&limit=`                         | Members with context roles; names and emails only when allowed                             |

Services use the AGS and NRPS media types (406 or 415 otherwise), `Authorization: Bearer`, and answer 404 for a course with no activity using the calling tool.

## SCORM and xAPI packages

| Method | Path                                    | Description                                                                                                                                                                                 |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/packages/:activityId`                 | Player info: `settings`, `current` (the package version and its table of contents), your attempts, `mode` (`learner` or `preview`), `canStartNew`, `resumeAttemptId`, `grade`               |
| POST   | `/packages/:activityId/import`          | `course:manageContent`. `{ fileId }` of a zip uploaded with `POST /files` (context `activity`); becomes the new current version (201). A bad package is 422 `invalid_package`               |
| POST   | `/packages/:activityId/launch`          | `{ itemId?, attemptId?, newAttempt?, preview? }` → `{ url, attemptId, itemId, mode, display, items }`. xAPI launch URLs carry `endpoint`, `auth`, `actor`, `registration` and `activity_id` |
| GET    | `/packages/:activityId/report?groupId=` | `grades:viewAll`. `{ maxGrade, rows: [{ user, attempts, grade, completed }] }`                                                                                                              |

Package activities use `type: "package"` with `settings: { display: "embed" \| "window", attemptsAllowed (0 = unlimited), gradingMethod: "highest" \| "last", requirePass }`.

Outside `/api`:

- `GET /content/:token/*` serves package files with `Content-Security-Policy: sandbox …` (never `allow-same-origin`), `nosniff`, `Cross-Origin-Resource-Policy: cross-origin` and no `X-Frame-Options`. HTML gets the run-time script first in `<head>`. Tokens are HMAC-signed, bound to the activity, version, user, attempt and purpose, and expire after six hours.
- `POST /content/:token/__coursekit/commit` takes run-time commits (text/plain JSON, at most 2 MB). Previews record nothing.
- The xAPI Learning Record Store under `/xapi/`: `about`, `statements` (PUT, POST and GET with `statementId`, `voidedStatementId` or `agent`, `verb`, `activity`, `registration`, `since`, `until`, `limit`, `ascending`), `activities/state`, `activities/profile`, `agents/profile`, `activities` and `agents`. Requests need `X-Experience-API-Version` and the Basic credentials from the launch URL, which only reach the learner's own data. CORS allows any origin; bodies are limited to 1 MB.

## Files

| Method | Path         | Description                                                                                     |
| ------ | ------------ | ----------------------------------------------------------------------------------------------- |
| POST   | `/files`     | Multipart: `file`, `context` (`submission`, `activity`, `course`, `post`, `avatar`), `courseId` |
| GET    | `/files/:id` | Download, if you may see it. Add `?download=1` to force a download                              |

## You

| Method | Path                   | Description                                              |
| ------ | ---------------------- | -------------------------------------------------------- |
| GET    | `/dashboard`           | Courses, deadlines, announcements, grades, grading queue |
| GET    | `/notifications`       | Latest notifications and the unread count                |
| POST   | `/notifications/read`  | `{ ids? }`; all when omitted                             |
| GET    | `/calendar?from=&to=`  | Due dates, course dates and events                       |
| POST   | `/calendar/events`     | `{ title, startsAt, endsAt?, description?, courseId? }`  |
| DELETE | `/calendar/events/:id` |                                                          |
| GET    | `/search?q=`           | Courses, activities (and people, for admins)             |

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
