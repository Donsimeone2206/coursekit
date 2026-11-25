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

Groups split a course's participants into teams or sections. Staff see every group; students only see the groups they are in (with their active members). Changing groups needs `course:manageGroups` (teachers and teaching assistants).

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
