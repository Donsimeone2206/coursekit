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

| Method | Path                             | Description                                                |
| ------ | -------------------------------- | ---------------------------------------------------------- |
| GET    | `/activities/:id/questions`      | Questions with answers (`course:manageContent`)            |
| PUT    | `/activities/:id/questions`      | Replace the question set; keeps ids so attempts stay valid |
| POST   | `/activities/:id/attempts`       | Start (or resume) an attempt                               |
| GET    | `/activities/:id/attempts?all=1` | Your attempts, or everyone's with `quiz:viewAllAttempts`   |
| GET    | `/attempts/:attemptId`           | Questions (answers hidden until review)                    |
| PUT    | `/attempts/:attemptId`           | `{ answers }` autosave                                     |
| POST   | `/attempts/:attemptId/submit`    | `{ answers? }` finish and grade                            |

Answers are keyed by question id: `{ "<questionId>": { "optionIds": ["..."] } }` for choice questions or `{ "text": "..." }` for short and numerical ones.

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

| Method | Path                                      | Description                                                        |
| ------ | ----------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/courses/:id/grades`                     | `{ kind: "gradebook" }` for staff, `{ kind: "mine" }` for students |
| GET    | `/courses/:id/grades/export.csv`          | CSV export (`grades:viewAll`)                                      |
| PUT    | `/courses/:id/grades/:activityId/:userId` | `{ score, feedback? }` (`grades:edit`)                             |

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
