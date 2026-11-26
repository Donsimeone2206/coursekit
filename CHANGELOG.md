# Changelog

## 0.4.0

SCORM 2004 sequencing and navigation, cmi5 packages, LTI Dynamic Registration, a trusted-proxy setting, and live classes with BigBlueButton, Zoom, Jitsi Meet and meeting links.

**Before upgrading, back up your database.** Migrations `012` to `015` run on start. `012_scorm_sequencing` adds the `package_sequencing_states` table and changes no existing data. SCORM 2004 attempts started under 0.3.0 get their sequencing state the first time they are opened or save progress: it is built from what each part reported, without End Attempt's defaults, and their package's manifest is read again from storage. `013_cmi5` adds the tables `cmi5_sessions`, `cmi5_au_states` and `cmi5_satisfied`, and deletes the xAPI documents (State and profiles) that users deleted under 0.3.0 left behind. `014_lti_registration` adds the `lti_registrations` table and two columns, `lti_tools.scopes` and `lti_tools.domains`. Both are empty for existing tools, which keep every scope of their allowed services, as before. `015_live_classes` adds the tables `live_sessions`, `live_rooms`, `live_presence`, `live_attendance` and `live_recordings`.

### SCORM 2004 sequencing and navigation

- SCORM 2004 packages (2nd, 3rd and 4th edition) now follow their sequencing and navigation rules, as the Sequencing and Navigation book of SCORM 2004 4th Edition describes. Coursekit reads:
  - control modes, and pre-, exit- and post-condition rules;
  - the attempt limit and the attempt duration limit;
  - rollup rules, with the default rules and rollup considerations;
  - objectives and their global objective maps (satisfied status and measure, and in the 4th edition the raw, minimum and maximum scores, completion status and progress measure);
  - selection and randomization, delivery controls, constrained choice, completion by progress measure, `hideLMSUI` and shared data (`adl.data`);
  - sequencing collections (`IDRef`), merged with each item's own definitions.
- The server runs the rules. Every navigation request goes through the Overall Sequencing Process, whether it comes from the player or from the content (`adl.nav.request`: continue, previous, choice, exit, exit all, abandon, abandon all, suspend all, and jump in 4th edition packages), and only the part it delivers can record. `adl.nav.request_valid` comes from the server too. Jump is for content only: the player and the API can't use it.
- A new player shows the course's parts with their status, leaves out hidden ones and dims those that can't be opened right now. **Previous**, **Continue** and an **Exit** menu (**Suspend**, **Exit this part**, **Exit all**) only appear where the rules and the part's `hideLMSUI` allow. On smaller screens the parts are behind a **Contents** button. When the attempt is open in two windows, a button pressed in the one that fell behind changes nothing, and that window catches up.
- **Suspend** saves the attempt, and the next visit carries on where the learner left off. Leaving without exiting works the same way, unless the course is already complete: then the attempt finishes. The player shows a summary when the attempt is suspended or ends.
- What each part's content reports goes into its tracking information: completion and success status (with `cmi.completion_threshold` and `cmi.scaled_passing_score`), `cmi.score.scaled` as the primary objective's measure, `cmi.progress_measure`, and the part's other objectives in `cmi.objectives`. `cmi.objectives` starts with the part's objectives and what their global objectives know.
- Grades and completion come from the course's rolled-up status: the root activity's completion, and its primary objective's satisfied status and measure.
- Global objectives and shared data stores belong to the learner's attempt, as if each attempt were a new registration. Nothing is shared between attempts or packages, whatever `objectivesGlobalToSystem` and `sharedDataGlobalToSystem` say.
- Imports report what they ignored: a malformed value is ignored or gets the specification's default, and the **Package** card on the activity page lists the notes. Each activity keeps at most 20 rules of each kind, 20 maps per objective and 20 shared data maps, and a rule with more than 10 conditions is ignored.
- The demo has a SCORM 2004 course with sequencing, _Inclusive design_, in UX Design Principles: a pre-test skips the modules you already know, the two modules open in order, and the final quiz unlocks once both are done. Lucas Silva has an attempt in progress.

### LTI Dynamic Registration

- Tools that support LTI Dynamic Registration 1.0 can register themselves. In **Administration → External tools**, choose **Register with a URL** and paste the tool's registration URL (https, or http for localhost). Coursekit opens the tool's page in a dialog. For tools that can't be shown inside another site, choose **Open in a new window**. When the tool in the dialog says it's done, or once a tool in a new window has registered (Coursekit checks every 2 seconds), the dialog closes and shows the new tool. Like the rest of LTI, it needs `COURSEKIT_PUBLIC_URL`.
- Coursekit publishes its OpenID configuration at `/lti/openid-configuration` and takes registrations at `/lti/registration`, both with CORS for tools that register from the browser. A registration must follow the specification and OpenID Connect Dynamic Client Registration: a web application with `id_token`, the implicit and client credentials grants, `private_key_jwt` and https URLs. On a public site, tool URLs can't point at Coursekit, localhost or link-local addresses. While Coursekit itself runs on localhost, tool URLs on localhost work too, over http or https; other hosts still need https. Bad requests get the standard `invalid_redirect_uri` and `invalid_client_metadata` errors. Coursekit never fetches the tool's URLs while it registers.
- The registration token is random, works once (even when two requests race), expires after an hour, and stops working when the administrator who started it is no longer an administrator. Only a hash of it is stored, and cancelling the dialog turns it off.
- Tools that register themselves start turned off, with a new client ID and deployment ID. They get only the grade and class list scopes they asked for that Coursekit supports, and names and email addresses only when they asked for those claims. The tool's page shows what it asked for (logo, domain, services, personal data, contacts, privacy policy and terms), so an administrator can check it, change its settings and turn it on. The list marks these tools as **Registered automatically**.
- Content selection only offers grade columns to tools that may send scores. Launch URLs and selected content may also be on the domains a tool declared when it registered, and their subdomains.

### Trusted proxies and rate limits

- New option `trustProxy` / `COURSEKIT_TRUST_PROXY`, off by default. Behind a reverse proxy, set it to the proxy's addresses or CIDR ranges (IPv4 or IPv6, with `loopback`, `linklocal` and `uniquelocal` as shortcuts), to a number of proxies, or to `true` (only when Coursekit can't be reached except through the proxy). Coursekit then takes the client's address from `X-Forwarded-For`. It works with `lms.listen()` and with `lms.handler` in Express or Fastify. Coursekit reads the connection's address itself, so the framework's own trust-proxy setting doesn't apply. With `lms.fetch` the connection's address is unknown, so only a number of proxies or `true` can find the client. An invalid value stops Coursekit from starting.
- New limits per client address, on top of the limits per email: 100 failed sign-ins per 15 minutes and 50 sign-ups per hour. Failed sign-ins take a place before the password check, so requests sent at the same time can't get past the limit, and correct ones wait for a place (up to 15 seconds) instead of being refused.
- The LTI token endpoint's limit on failed requests (60 per minute) and the registration endpoint's (30 per minute) use the client address too. Every limit per address counts IPv6 clients per /64 network.
- While `trustProxy` is off, sign-ins and sign-ups that come through a proxy (`X-Forwarded-For`, `Forwarded` or `X-Real-IP`) or from the same machine only get the limits per email, as in 0.3.0. Secure cookies still follow an https `COURSEKIT_PUBLIC_URL`, so the proxy doesn't need to send `X-Forwarded-Proto`.

### cmi5 packages

- SCORM / xAPI package activities play **cmi5** courses (Quartz edition): upload a zip with `cmi5.xml` at its root, or a `cmi5.xml` on its own for AUs hosted on other websites. The course structure (course, nested blocks, AUs and objectives) is checked on upload, and a structure that isn't valid is refused with a message that says what to fix. A zip with both `imsmanifest.xml` and `cmi5.xml` stays a SCORM package. Replacing the package keeps learners who already started on their version.
- Launches follow the specification: one registration per attempt and a new session per launch. Before an AU opens, Coursekit writes `LMS.LaunchData` and `cmi5LearnerPreferences` (with the browser's languages, or `en-US`) and records `launched`, and the AU's URL gets `endpoint`, `fetch`, `actor`, `registration` and `activityId`. The one-time fetch URL (`/cmi5/fetch/...`) works for 30 minutes and hands out credentials tied to the learner, the registration and the session. An attempt can be launched at most 2,000 times.
- The LRS enforces the cmi5 statement rules for these credentials and refuses violations with 403, storing nothing of the request: actor and registration, context template, categories, the learner preferences read first, verb order in a session, `completed` and `passed` once per registration, `passed` and `failed` against the mastery score (with scaled scores), integer raw scores, durations, Browse and Review modes, and no voiding. The credentials only reach their own registration (State API and statement queries), and `LMS.LaunchData` and the learner preferences are read-only for AUs.
- Coursekit records `satisfied` for blocks and the course, and `abandoned` for sessions that end without `terminated` (at the next launch, or after 12 hours without requests). Its own statements don't count toward an attempt's 10,000-statement limit.
- A new player shows the course structure with each AU's status. Packaged AUs play sandboxed like other package content, AUs hosted elsewhere are framed with their own origin, and `OwnWindow` AUs open in a new window. When an AU finishes, the learner is back on the activity. Staff previews run in Browse mode and record nothing. Learners review finished AUs, and every AU of an archived course, in Review mode, where nothing that counts is recorded, so a teacher's grade override stays. Once the course is satisfied, AUs the learner hasn't finished still record their results.
- The grade is the average of the AUs' scaled scores (`result.score.scaled`) from their `passed` or `failed` results; AUs without one don't count. The activity is completed when the course is satisfied. Attempt limits, the grading method and the pass requirement work as for other packages, and the staff report shows each AU's status.
- ZIP64 archives can now be uploaded, for every package kind.
- The demo has a two-AU cmi5 course, _Screen reader basics_, in UX Design Principles.

### Live classes

- A new **Live class** activity for online classes on BigBlueButton, Zoom, Jitsi Meet or a meeting link (Google Meet, Microsoft Teams, Webex or any https link). Teachers schedule one session or a daily or weekly series (up to 100 at a time) in their browser's time zone, and repeats keep the same local time across daylight saving changes. Sessions last 5 minutes to 12 hours, have an optional title and agenda, and can be edited, moved, cancelled or deleted.
- Students can join from a set number of minutes before a session starts (10 by default) until it ends; teachers and teaching assistants can start it at any time. Joining goes through Coursekit (`/live/join/...`), which checks access, the person's group and the join window, records the join and opens the meeting in a new tab. Students never get moderator rights or Zoom start links.
- Sessions appear in the calendar and the dashboard's Upcoming list, with the same visibility rules as due dates. A session (**Add to calendar**) or the whole class (**Add all to calendar**) downloads as an .ics file.
- With separate or visible groups, BigBlueButton, Zoom and Jitsi Meet give each group its own room for each session. Students join their own group's room, and in visible groups mode they see the others too. A class limited to some groups only has rooms for them.
- Attendance for each session (who joined, when and for how long) comes from BigBlueButton and Zoom where they report it, and otherwise from Coursekit's join log. Staff can mark people present or absent, and students see their own attendance. Completion can be "attend at least N sessions" or manual. Live classes have no grade.
- Recordings from BigBlueButton and Zoom, and links staff add by hand, are listed on each session for the learners who could see it. Staff can hide or remove them. For a BigBlueButton recording, that also unpublishes or deletes it on the BigBlueButton server; removing a Zoom recording moves it to the Zoom trash.
- Students are told when sessions are scheduled, moved or cancelled, and get a reminder before each session (15 minutes by default). Their emails use a new **Live classes** category, and reminders are sent once, even with several server processes.
- Administrators turn providers on under **Administration → Live classes**. Secrets stay on the server, and BigBlueButton, Zoom and Jitsi Meet each have a **Test connection** button.
  - **BigBlueButton** (2.4 or later, or Scalelite): server URL, shared secret (Coursekit warns when it's shorter than 32 characters) and checksum algorithm (SHA-1, or SHA-256, SHA-384 or SHA-512 from BigBlueButton 2.5). Staff join as moderators and students as viewers. Classes have recording options, a welcome message, "students wait for a teacher" and **End for everyone**. Signed callbacks for each room report when a meeting ends (`meetingEndedURL`, confirmed with BigBlueButton), when a recording is ready, and the learning analytics. Learning analytics is on by default and sets `meetingKeepEvents`, so BigBlueButton keeps each meeting's events, chat included, on its server and doesn't delete them by itself.
  - **Zoom**: a Server-to-Server OAuth app, a default host, other hosts teachers can pick, how many meetings one host can run at once, and optionally the webhook secret token. As on BigBlueButton, classes have recording options (Zoom cloud recordings), "students wait for a teacher" and **End for everyone**. Meetings are created up to two weeks ahead, follow their session wherever it moves, and are replaced when deleted in Zoom. In a class with a room per group, each group can have its own host. Staff get a fresh start link only when the host is one of the site's hosts or themselves. Attendance comes from signed webhooks or, without them, the participant report.
  - **Jitsi Meet**: server URL (`https://meet.jit.si` by default) and, for a self-hosted server with token authentication, an app ID and a secret of at least 32 characters. Rooms are unguessable, staff get moderator tokens when token authentication is set up, and a self-hosted server can be shown inside the class page.
  - **Meeting links** are on by default: teachers paste a link for the class or for each session.
- BigBlueButton callbacks and Zoom webhooks need `COURSEKIT_PUBLIC_URL`. Classes still work without it, with less attendance detail.
- Deleting a live class, a section or a course removes its meetings at the provider in the background.
- The demo has a **Weekly live Q&A** in Modern Web Development, on the meeting link provider.

### Changes to check if you integrate with Coursekit

- **Behind a reverse proxy, set `COURSEKIT_TRUST_PROXY`** (for example `loopback` for a proxy on the same machine), and make sure the proxy sends `X-Forwarded-For` (nginx doesn't by default), or every client gets the proxy's address. Until the setting is on, Coursekit can't tell the clients behind the proxy apart: sign-ins and sign-ups through it only get the limits per email, as in 0.3.0, and failed LTI token and registration requests share one limit. Coursekit logs a hint once when requests carry `X-Forwarded-For`, `Forwarded` or `X-Real-IP` while the setting is off.
- Deleting a user now also deletes their LRS documents: xAPI State, activity and agent profiles, and cmi5's `LMS.LaunchData` and learner preferences.
- The LRS limits a State or activity profile document's `activityId` to 2048 bytes and its `stateId` or `profileId` to 500 bytes, counted in UTF-8 (0.3.0 counted characters), and answers 400 beyond that. Long non-ASCII ids used to fail with a server error on PostgreSQL.
- Package attempts in `GET /api/packages/:activityId`, `/report` and `/cmi5/report` include `kind`, the package kind of the attempt's own version.
- Sign-ins and sign-ups now also have limits per client address: 100 failed sign-ins per 15 minutes and 50 sign-ups per hour, then `429` with the code `rate_limited`. Everyone behind one address, such as a school's network, shares them.
- **SCORM 2004 packages now follow their sequencing rules:**
  - Packages without sequencing rules get the specification's defaults (choice on, flow off): learners choose parts from the contents, without the Previous and Next of 0.3.0, and the first part opens by itself. The content's own `continue` and `previous` requests are refused too (`adl.nav.request_valid.continue` and `adl.nav.request_valid.previous` are `false`), where 0.3.0 opened the next or previous part.
  - Grades and completion come from the course's rolled-up status. The score is the rolled-up measure: the parts' `cmi.score.scaled`, averaged up the activity tree by `objectiveMeasureWeight` (1 by default). Parts that report no score, assets too, count as 0 unless their weight is 0. In 0.3.0 only the parts with a score were averaged, so packages with several parts and no weights now grade lower when some parts report no score. A part that reports only `cmi.score.raw` has no measure for sequencing, but a package whose parts never report `cmi.score.scaled` is still graded as in 0.3.0: the average of the parts' scores, each scaled between `cmi.score.min` and `cmi.score.max`. Finished attempts keep their grades; attempts in progress get their result the new way the next time they are opened or saved.
  - A part whose content reports no completion status counts as completed once the learner moves on from it, and one that reports no success status counts as passed (End Attempt's defaults), unless the manifest sets `completionSetByContent` or `objectiveSetByContent`.
  - Attempts finish at the end of the course, with **Exit all** (or `exitAll` and `abandonAll` from the content), by the package's rules, on `cmi.exit` "logout" or "time-out", or when nothing is left that can be opened, so they can now finish incomplete. A package with only one part finishes when its SCO terminates, unless `cmi.exit` is "suspend". Once the course is complete, leaving it (closing the player, or a part ending without a navigation request) also finishes the attempt, as in 0.3.0, unless `cmi.exit` is "suspend".
  - Each new attempt on a part starts with fresh run-time data (`cmi.entry` "ab-initio"), as the specification says, where 0.3.0 kept a part's data from one visit to the next. A suspended part, or one the learner left without exiting, resumes with its data.
  - Items with `isvisible="false"` are no longer dropped: they stay in the activity tree, where sequencing can deliver them and they count in rollup, but they aren't in the version's `items`, and `sequencing.toc` lists them with `visible: false`, so the player's contents leave them out. Reviews and previews only open them when asked for by `itemId`. SCORM 1.2 still drops them.
  - `POST /api/packages/:activityId/launch` takes `nav`, `sid` and `deliveryId`. For a learner's attempt in progress (outside archived courses, where it opens for review) it runs the rules and returns `sequencing`: what is open, the contents with each part's status, the controls the rules allow and the attempt's result so far. `url` and `itemId` are empty strings when nothing is open, and `itemId` without `nav` is a choice request. A request the rules refuse, or one made for a `deliveryId` the attempt has moved on from, changes nothing and comes back with a `message`. `nav: "jump"` answers 400, and with `nav`, a request for a finished attempt (by its `attemptId`) returns its summary instead of a review.
  - `PackageVersionInfo` gains `warnings`: what the manifest had that was ignored or replaced by a default (up to 50). Imports are refused with 422 `invalid_package` when items are nested more than 32 levels deep, or when the package has more than 20,000 sequencing and rollup rules, 40,000 rule conditions, 20,000 objective and shared data maps or 10,000 objectives. A sequencing collection counts once for each item that uses it.
  - Content links of learners' attempts now belong to one delivery of a part. Once the learner has moved on, `/content/:token/__coursekit/runtime.js` answers 403 for them, and commits from a page of an earlier delivery are refused with 403, so the content's Commit and Terminate report error 391. Launches and commits answer 409 when the attempt is busy, and 413 when its sequencing state would get too large.
- `LtiToolOption.grades` (the teacher's tool list) and deep linking's `accept_lineitem` now follow the tool's scopes: they are true only for tools that may send scores. A line item in content from any other tool is ignored, so no grade column is made. Tools added by hand with grades allowed work as before.
- New routes outside `/api`: `/lti/openid-configuration` and `/lti/registration` (under `/lti/`, which a proxy set up for 0.3.0 already forwards), `/cmi5/` and `/live/`. If a reverse proxy only forwards some paths, add `/cmi5/` and `/live/`.
- Under `/xapi/`, repeated slashes in a path count as one, so `/xapi//statements` is `/xapi/statements`.
- `ActivityType` gains `'live'` (and `ActivitySettingsMap` gains `live`), and package versions can have the kind `'cmi5'` (`PackageKind`). Package uploads also accept a `cmi5.xml` file on its own.
- `CalendarEvent.kind` gains `'live'`, with an optional `icsUrl`. `TimelineItem` gains an optional `endsAt`: the dashboard timeline lists the next session of each live class as type `live`, with `dueAt` as its start. Sessions don't count in `dueThisWeek`.
- A new capability, `live:moderate` (start sessions as moderator or host, take attendance and manage recordings), goes to teachers and teaching assistants (and administrators). Scheduling sessions needs `course:manageContent`.
- A new email category, `live` (**Live classes**), for the new notification types `live.scheduled`, `live.moved`, `live.cancelled` and `live.reminder`. People can switch it off on their profile.
- `ActivityTypeDefinition.validate` gets a fourth argument, `{ user, previous }`: who is saving the activity, and its settings before the change (`null` for a new one).
- `createCoursekit()` starts a background timer for live classes (reminders, provider meetings, attendance and recordings) that runs every minute, and `lms.close()` stops it.
- New option `trustProxy` (`ResolvedConfig.trustProxy`). New exported types for trusted proxies (`TrustProxyOption`, `TrustProxySetting`), Dynamic Registration (`LtiRegistrationState`, `LtiToolRegistration` and others) and live classes (`LiveSettings`, `LiveClassInfo` and others).
- New REST endpoints are listed in [docs/api.md](docs/api.md).

### Known limitations

- SCORM 2004 sequencing: staff previews and reviews don't apply the rules (every part opens, with linear Previous and Next as in 0.3.0) and record nothing, so trying the rules needs a student account. `adl.nav.request_valid` is worked out when a part's page opens and doesn't change while that page stays open. Of the limit conditions, only `attemptLimit` and `attemptAbsoluteDurationLimit` are used, and that duration counts wall-clock time, including time suspended. `outsideAvailableTimeRange` is never true, and auxiliary resources are ignored. As in 0.3.0, a content link can fetch any file of its package: sequencing decides what opens and what is recorded, not which files a browser can load.
- Dynamic Registration: a tool can't read or update its registration later (no `registration_client_uri`), so it registers again instead. Message-level custom parameters, labels, icons and roles aren't used. In a new window, Coursekit only notices the registration by checking every 2 seconds, and can't tell when the window was blocked or closed. Only localhost and link-local tool URLs are refused: other private addresses (such as 10.0.0.0/8) aren't, and host names aren't resolved to check where they point.
- Rate limits are kept in memory, so each server process counts on its own, and the limits per address can't be changed. While `trustProxy` is off, a client that connects directly can skip the per-address sign-in and sign-up limits by sending `X-Forwarded-For`; setting `trustProxy` stops that.
- cmi5: no waived AUs, objectives aren't shown, and learners can't choose Browse mode. Reloading an AU page inside the player needs a new launch, because the fetch URL works once. Sessions that time out are only marked abandoned when the activity is next used.
- Live classes: changes apply to one session at a time (no "this and following sessions"). Joining through Coursekit counts as attending, even if the provider never saw the person; teachers can correct it by hand. Times in notifications are shown in the time zone the session was scheduled in, not each learner's, and reminders only go to learners.
- BigBlueButton: without `COURSEKIT_PUBLIC_URL` there is no logout address, and deleting a class leaves its recordings on the BigBlueButton server.
- Zoom: teachers can only pick the site's hosts or their own Zoom account, and no alternative hosts are set, so other staff join a teacher-hosted class as participants. Attendance is matched by email, then by a unique display name, and the participant report needs a paid Zoom plan. Turning Zoom off doesn't delete meetings already created there.
- Jitsi Meet and meeting links only have Coursekit's join log for attendance (no durations), and a meeting link is shared by all groups. Jitsi moderator tokens need Prosody's `token_affiliation` module and Jicofo's auto-owner turned off; otherwise the first person in, or everyone with a token, becomes a moderator. Showing Jitsi inside the page needs a self-hosted server that allows framing.

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
