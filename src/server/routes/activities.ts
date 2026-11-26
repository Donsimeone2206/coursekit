import { Hono } from 'hono';
import { z } from 'zod';
import type { ActivityDetail, ActivityNavItem, ActivitySettingsMap, FileInfo, Grade, PublicUser, Submission } from '../../shared/types.js';
import { requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { DB } from '../db/types.js';
import type { ActivityRow, GradeRow, SubmissionRow } from '../db/schema.js';
import { badRequest, forbidden, notFound, readBody, readQuery } from '../lib/http.js';
import { isoDateSchema, markdownSchema } from '../lib/schemas.js';
import { newId, now, num, parseJson } from '../lib/util.js';
import { assertCan, assertWritable, loadActivityAccess, type ActivityAccess } from '../services/access.js';
import { activityTypes, parseSettings } from '../services/activity-types.js';
import { upsertGrade } from '../services/grades.js';
import { regradeLtiActivity } from '../services/lti/services.js';
import { countDiscussions } from '../services/group-forums.js';
import {
  activityGroupInfo,
  groupHiddenActivityIds,
  inScope,
  restrictionRefs,
  studentScope,
  whereInScope,
} from '../services/group-modes.js';
import { activityGroupsSchema, saveActivityGroups } from '../services/group-settings.js';
import { notify } from '../services/notify.js';
import { markCompleted, unmarkCompleted } from '../services/progress.js';
import { deleteStoredFiles, packageStorageKeys, syncResults } from '../packages/service.js';
import { liveActivityUpdated, publicLiveSettings } from '../services/live/hooks.js';
import { countNeedsGrading, isExpired, regradeQuiz } from '../services/quiz.js';
import { quizTotals } from '../services/quiz-slots.js';
import { toCourseRef, toFileInfo, toPublicUser } from '../services/serialize.js';
import { activityMeta } from './courses.js';

/**
 * A staff member may only grade students whose work they see (separate groups), and only students the activity
 * applies to (group restrictions).
 */
export async function assertGradable(db: DB, access: ActivityAccess, userId: string) {
  const scope = await studentScope(db, access);
  if (!(await inScope(db, { groupIds: scope.groupIds, restrictedTo: null }, userId))) throw notFound('Student');
  if (!(await inScope(db, { groupIds: null, restrictedTo: scope.restrictedTo }, userId))) {
    throw badRequest("This activity is limited to groups this student isn't in, so it can't be graded for them.");
  }
}

async function filesById(db: DB, ids: string[]): Promise<Map<string, FileInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('files').selectAll().where('id', 'in', ids).execute();
  return new Map(rows.map((f) => [f.id, toFileInfo(f)]));
}

async function usersById(db: DB, ids: string[]): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', 'in', unique).execute();
  return new Map(rows.map((u) => [u.id, toPublicUser(u)]));
}

function toGrade(g: GradeRow | undefined, maxGrade: number, users: Map<string, PublicUser>): Grade | null {
  if (!g) return null;
  return {
    score: g.score,
    maxGrade,
    feedback: g.feedback,
    gradedBy: g.gradedBy ? (users.get(g.gradedBy) ?? null) : null,
    gradedAt: g.gradedAt,
  };
}

function toSubmission(s: SubmissionRow, user: PublicUser, files: Map<string, FileInfo>, dueAt: string | null): Submission {
  return {
    id: s.id,
    activityId: s.activityId,
    user,
    text: s.text,
    files: parseJson<string[]>(s.fileIds, [])
      .map((id) => files.get(id))
      .filter((f): f is FileInfo => !!f),
    submittedAt: s.submittedAt,
    late: !!dueAt && s.submittedAt > dueAt,
  };
}

/** Previous/next activity in course order, skipping anything the viewer can't see. */
async function neighbours(db: DB, access: ActivityAccess) {
  const showHidden = access.can('course:viewHidden');
  const rows = await db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .select([
      'activities.id',
      'activities.title',
      'activities.type',
      'activities.visible',
      'sections.visible as sectionVisible',
      'sections.title as sectionTitle',
    ])
    .where('activities.courseId', '=', access.course.id)
    .orderBy('sections.position', 'asc')
    .orderBy('activities.position', 'asc')
    .execute();
  const groupHidden = await groupHiddenActivityIds(db, access);
  const list = rows.filter(
    (r) => r.id === access.activity.id || (!groupHidden.has(r.id) && (showHidden || (r.visible && r.sectionVisible))),
  );
  const index = list.findIndex((r) => r.id === access.activity.id);
  const nav = (r: (typeof list)[number] | undefined): ActivityNavItem | null => (r ? { id: r.id, title: r.title, type: r.type } : null);
  const own = rows.find((r) => r.id === access.activity.id);
  return { prev: nav(list[index - 1]), next: nav(list[index + 1]), sectionTitle: own?.sectionTitle ?? '' };
}

export function activityRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  r.get('/:activityId', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    const { activity, course } = access;
    const type = activity.type;
    const settings = parseSettings(type, activity.settings);
    const isStaff = access.can('grades:viewAll');

    // Viewing a lesson or resource completes it when completion is automatic.
    if (access.enrolment && activity.completion === 'auto' && (type === 'lesson' || type === 'resource')) {
      await markCompleted(deps, activity, user.id);
    }

    const [nav, completion] = await Promise.all([
      neighbours(db, access),
      db
        .selectFrom('completions')
        .select('activityId')
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .executeTakeFirst(),
    ]);

    const counts = new Map<string, number>();
    const detail: ActivityDetail = {
      id: activity.id,
      courseId: activity.courseId,
      sectionId: activity.sectionId,
      type,
      title: activity.title,
      visible: !!activity.visible,
      position: activity.position,
      dueAt: activity.dueAt,
      maxGrade: activity.maxGrade,
      completion: activity.completion,
      completed: !!completion,
      meta: null,
      description: activity.description,
      settings,
      course: toCourseRef(course),
      sectionTitle: nav.sectionTitle,
      capabilities: access.capabilities,
      myRole: access.role,
      prev: nav.prev,
      next: nav.next,
      groups: await activityGroupInfo(db, access),
    };
    if (access.can('course:viewHidden')) {
      detail.groupMode = activity.groupMode ?? null;
      detail.groupRestriction = (await restrictionRefs(db, course.id)).get(activity.id) ?? [];
    }

    if (type === 'resource') {
      const s = settings as ActivitySettingsMap['resource'];
      detail.file = s.fileId ? ((await filesById(db, [s.fileId])).get(s.fileId) ?? null) : null;
    }
    // Live classes: only people who edit the class see its meeting link and Zoom host.
    if (type === 'live' && !access.can('course:manageContent'))
      detail.settings = publicLiveSettings(settings as ActivitySettingsMap['live']);

    if (type === 'assignment') {
      const own = await db
        .selectFrom('submissions')
        .selectAll()
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      const grade = await db
        .selectFrom('grades')
        .selectAll()
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      const files = await filesById(db, own ? parseJson<string[]>(own.fileIds, []) : []);
      const users = await usersById(db, grade?.gradedBy ? [grade.gradedBy] : []);
      detail.submission = own ? toSubmission(own, toPublicUser(user), files, activity.dueAt) : null;
      detail.grade = toGrade(grade, activity.maxGrade ?? 0, users);
      if (isStaff) {
        // Only the students whose work the viewer sees (separate groups, group restrictions).
        const scope = await studentScope(db, access);
        const students = await whereInScope(
          db,
          db
            .selectFrom('enrolments')
            .select('userId')
            .where('courseId', '=', course.id)
            .where('role', '=', 'student')
            .where('status', '=', 'active'),
          'enrolments.userId',
          scope,
        ).execute();
        const ids = students.map((s) => s.userId);
        const subs = ids.length
          ? await db
              .selectFrom('submissions')
              .select(['userId', 'submittedAt'])
              .where('activityId', '=', activity.id)
              .where('userId', 'in', ids)
              .execute()
          : [];
        const grades = ids.length
          ? await db
              .selectFrom('grades')
              .select(['userId', 'gradedAt', 'score'])
              .where('activityId', '=', activity.id)
              .where('userId', 'in', ids)
              .execute()
          : [];
        const gradeMap = new Map(grades.map((g) => [g.userId, g]));
        detail.submissionStats = {
          participants: ids.length,
          submitted: subs.length,
          needsGrading: subs.filter((s) => {
            const g = gradeMap.get(s.userId);
            return !g || g.score == null || !g.gradedAt || g.gradedAt < s.submittedAt;
          }).length,
        };
      }
    }

    if (type === 'quiz') {
      const s = settings as ActivitySettingsMap['quiz'];
      const [totals] = await quizTotals(db, [activity.id]);
      const questionCount = totals?.n ?? 0;
      const attempts = await db
        .selectFrom('quizAttempts')
        .selectAll()
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .orderBy('attemptNumber', 'asc')
        .execute();
      const grade = await db
        .selectFrom('grades')
        .selectAll()
        .where('activityId', '=', activity.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      const inProgress = attempts.find((a) => a.status === 'in_progress' && !isExpired(a)) ?? null;
      const finished = attempts.filter((a) => a.status !== 'in_progress' || isExpired(a)).length;
      const isManager = access.can('course:manageContent');
      const closed = !!activity.dueAt && Date.now() > Date.parse(activity.dueAt);
      detail.quiz = {
        questionCount,
        totalPoints: totals?.total ?? 0,
        attempts: attempts.map((a) => ({
          id: a.id,
          attemptNumber: a.attemptNumber,
          status: a.status,
          startedAt: a.startedAt,
          finishedAt: a.finishedAt,
          score: a.score,
          maxScore: a.maxScore,
        })),
        attemptsUsed: attempts.length,
        canAttempt:
          access.can('quiz:attempt') &&
          !access.readOnly &&
          questionCount > 0 &&
          (!!inProgress || isManager || ((s.attemptsAllowed === 0 || finished < s.attemptsAllowed) && !closed)),
        inProgressAttemptId: inProgress?.id ?? null,
        ...(access.can('quiz:viewAllAttempts')
          ? { needsGrading: await countNeedsGrading(db, activity.id, await studentScope(db, access)) }
          : {}),
      };
      detail.grade = toGrade(grade, activity.maxGrade ?? 0, new Map());
      counts.set(activity.id, questionCount);
    }

    if (type === 'forum') {
      // Only the discussions the viewer can see (separate groups).
      const n = (await countDiscussions(db, access, [activity])).get(activity.id) ?? { discussions: 0, posts: 0 };
      detail.forum = { discussionCount: n.discussions, postCount: n.posts };
      counts.set(activity.id, n.discussions);
    }

    detail.meta = activityMeta(activity, counts);
    return c.json(detail);
  });

  r.patch('/:activityId', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    const { activity } = access;
    const input = await readBody(
      c,
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: markdownSchema().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        dueAt: isoDateSchema.nullable().optional(),
        maxGrade: z.number().min(0).max(10_000).nullable().optional(),
        completion: z.enum(['none', 'manual', 'auto']).optional(),
        visible: z.boolean().optional(),
        sectionId: z.string().optional(),
        ...activityGroupsSchema,
      }),
    );
    const def = activityTypes[activity.type];
    const update: Partial<ActivityRow> = { updatedAt: now() };
    let resourceFileId: string | null = null;
    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.completion !== undefined) update.completion = input.completion;
    if (input.visible !== undefined) update.visible = input.visible ? 1 : 0;
    if (input.dueAt !== undefined && (activity.type === 'assignment' || activity.type === 'quiz')) update.dueAt = input.dueAt;
    if (input.maxGrade === null && !def.optionalGrade) throw badRequest('Enter a maximum grade.');
    if (input.maxGrade !== undefined && def.graded) update.maxGrade = input.maxGrade;
    if (input.sectionId) {
      const section = await db
        .selectFrom('sections')
        .select('id')
        .where('id', '=', input.sectionId)
        .where('courseId', '=', activity.courseId)
        .executeTakeFirst();
      if (!section) throw badRequest('That section does not exist in this course.');
      update.sectionId = section.id;
    }
    if (input.settings) {
      const merged = { ...parseSettings(activity.type, activity.settings), ...input.settings };
      const result = def.settings.safeParse(merged);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw badRequest(issue ? `${issue.path.map(String).join('.')}: ${issue.message}` : 'Invalid settings');
      }
      if (def.validate) {
        await def.validate(db, activity.courseId, result.data as never, {
          user,
          previous: parseSettings(activity.type, activity.settings) as never,
        });
      }
      update.settings = JSON.stringify(result.data);
      if (activity.type === 'resource') resourceFileId = (result.data as ActivitySettingsMap['resource']).fileId ?? null;
    }
    // All or nothing: a change that is refused (groups that aren't in the course, say) saves none of the other fields,
    // so an activity is never made visible without the group restriction that came with it.
    const groupsChanged = await db.transaction().execute(async (trx) => {
      await trx.updateTable('activities').set(update).where('id', '=', activity.id).execute();
      if (resourceFileId) {
        await trx
          .updateTable('files')
          .set({ courseId: activity.courseId, context: 'activity', activityId: activity.id })
          .where('id', '=', resourceFileId)
          .execute();
      }
      return saveActivityGroups(deps, trx, activity, input, user.id);
    });
    if (groupsChanged)
      deps.events.emit('activity.groups.updated', { activityId: activity.id, courseId: activity.courseId, userId: user.id });
    if (input.maxGrade !== undefined && activity.type === 'quiz') {
      // Rescale existing quiz grades to the new maximum.
      const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', activity.id).executeTakeFirstOrThrow();
      await regradeQuiz(deps, refreshed);
    }
    if (activity.type === 'lti' && update.maxGrade !== undefined && update.maxGrade !== activity.maxGrade) {
      // Grades from the tool were scaled to the old maximum when they arrived.
      const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', activity.id).executeTakeFirstOrThrow();
      await regradeLtiActivity(deps, refreshed, activity.maxGrade);
    }
    if (activity.type === 'live') {
      // Attendance-based completion follows the settings; provider meetings follow the changes (services/live).
      const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', activity.id).executeTakeFirstOrThrow();
      await liveActivityUpdated(deps, refreshed);
    }
    if (activity.type === 'package' && (input.maxGrade !== undefined || input.settings)) {
      // Package grades are attempt scores times the maximum, picked by the grading method: recompute them.
      const refreshed = await db.selectFrom('activities').selectAll().where('id', '=', activity.id).executeTakeFirstOrThrow();
      const learners = await db.selectFrom('packageAttempts').select('userId').distinct().where('activityId', '=', activity.id).execute();
      for (const { userId } of learners) await syncResults(deps, refreshed, userId);
    }
    return c.json({ ok: true });
  });

  r.delete('/:activityId', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    assertCan(access, 'course:manageContent');
    const { activity } = access;
    const fileIds: string[] = [];
    if (activity.type === 'resource') {
      const s = parseSettings('resource', activity.settings);
      if (s.fileId) fileIds.push(s.fileId);
    }
    if (activity.type === 'assignment') {
      const subs = await db.selectFrom('submissions').select('fileIds').where('activityId', '=', activity.id).execute();
      for (const s of subs) fileIds.push(...parseJson<string[]>(s.fileIds, []));
    }
    // Package files are listed in package_files, which goes with the activity: list them first, delete them after.
    const packageKeys = activity.type === 'package' ? await packageStorageKeys(db, { activityId: activity.id }) : [];
    await db.deleteFrom('activities').where('id', '=', activity.id).execute();
    await deleteStoredFiles(deps, packageKeys);
    if (fileIds.length) {
      const files = await db.selectFrom('files').select(['id', 'storageKey']).where('id', 'in', fileIds).execute();
      await db.deleteFrom('files').where('id', 'in', fileIds).execute();
      await Promise.allSettled(files.map((f) => deps.storage.delete(f.storageKey)));
    }
    return c.json({ ok: true });
  });

  /** Manual completion ("Mark as done"). */
  r.post('/:activityId/complete', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    if (!access.enrolment) throw forbidden('Only enrolled participants track completion.');
    if (access.activity.completion !== 'manual') throw badRequest('This activity completes automatically.');
    await markCompleted(deps, access.activity, user.id);
    return c.json({ completed: true });
  });

  r.delete('/:activityId/complete', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    if (access.activity.completion !== 'manual') throw badRequest('This activity completes automatically.');
    await unmarkCompleted(db, access.activity.id, user.id);
    return c.json({ completed: false });
  });

  /** Submit (or resubmit) an assignment. */
  r.put('/:activityId/submission', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    const { activity } = access;
    if (activity.type !== 'assignment') throw badRequest('This activity is not an assignment.');
    assertCan(access, 'assignment:submit', 'Only students can submit assignments.');
    assertWritable(access);
    const settings = parseSettings('assignment', activity.settings);
    const input = await readBody(
      c,
      z.object({ text: z.string().max(200_000).nullable().optional(), fileIds: z.array(z.string().max(40)).max(20).default([]) }),
    );
    const text = settings.submissionTypes.includes('text') ? input.text?.trim() || null : null;
    const fileIds = settings.submissionTypes.includes('file') ? [...new Set(input.fileIds)] : [];
    if (fileIds.length > settings.maxFiles) throw badRequest(`You can attach up to ${settings.maxFiles} files.`);
    if (!text && fileIds.length === 0) throw badRequest('Add some text or a file before submitting.');
    if (fileIds.length) {
      const owned = await db.selectFrom('files').select('id').where('id', 'in', fileIds).where('ownerId', '=', user.id).execute();
      if (owned.length !== fileIds.length) throw badRequest('One of the attached files could not be found.');
      await db
        .updateTable('files')
        .set({ courseId: activity.courseId, context: 'submission', activityId: activity.id })
        .where('id', 'in', fileIds)
        .execute();
    }
    if (activity.dueAt && Date.now() > Date.parse(activity.dueAt) && !settings.allowLate) {
      throw forbidden('The due date has passed and late submissions are not accepted.');
    }

    const ts = now();
    const existing = await db
      .selectFrom('submissions')
      .selectAll()
      .where('activityId', '=', activity.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    let submission: SubmissionRow;
    if (existing) {
      submission = { ...existing, text, fileIds: JSON.stringify(fileIds), submittedAt: ts, updatedAt: ts };
      await db
        .updateTable('submissions')
        .set({ text, fileIds: submission.fileIds, submittedAt: ts, updatedAt: ts })
        .where('id', '=', existing.id)
        .execute();
    } else {
      submission = {
        id: newId(),
        activityId: activity.id,
        courseId: activity.courseId,
        userId: user.id,
        text,
        fileIds: JSON.stringify(fileIds),
        submittedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.insertInto('submissions').values(submission).execute();
    }
    if (activity.completion === 'auto') await markCompleted(deps, activity, user.id);
    deps.events.emit('submission.submitted', {
      activityId: activity.id,
      courseId: activity.courseId,
      userId: user.id,
      submissionId: submission.id,
    });
    return c.json(toSubmission(submission, toPublicUser(user), await filesById(db, fileIds), activity.dueAt));
  });

  /** All students and their submissions, for grading. */
  r.get('/:activityId/submissions', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    assertCan(access, 'grades:viewAll');
    const { activity } = access;
    if (activity.type !== 'assignment') throw badRequest('This activity is not an assignment.');
    const { groupId } = readQuery(c, z.object({ groupId: z.string().max(40).optional() }));
    // Separate groups and group restrictions decide whose work the viewer sees; groupId narrows it to one group.
    const scope = await studentScope(db, access, groupId);
    const students = await whereInScope(
      db,
      db
        .selectFrom('enrolments')
        .innerJoin('users', 'users.id', 'enrolments.userId')
        .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
        .where('enrolments.courseId', '=', activity.courseId)
        .where('enrolments.role', '=', 'student')
        .where('enrolments.status', '=', 'active'),
      'enrolments.userId',
      scope,
    )
      .orderBy('users.name', 'asc')
      .execute();
    const subs = await db.selectFrom('submissions').selectAll().where('activityId', '=', activity.id).execute();
    const grades = await db.selectFrom('grades').selectAll().where('activityId', '=', activity.id).execute();
    const files = await filesById(
      db,
      subs.flatMap((s) => parseJson<string[]>(s.fileIds, [])),
    );
    const graders = await usersById(
      db,
      grades.map((g) => g.gradedBy).filter((id): id is string => !!id),
    );
    const subMap = new Map(subs.map((s) => [s.userId, s]));
    const gradeMap = new Map(grades.map((g) => [g.userId, g]));

    return c.json(
      students.map((s) => {
        const sub = subMap.get(s.id);
        const grade = gradeMap.get(s.id);
        const publicUser = { id: s.id, name: s.name, avatarUrl: s.avatarUrl };
        return {
          user: { ...publicUser, email: s.email },
          submission: sub ? toSubmission(sub, publicUser, files, activity.dueAt) : null,
          grade: toGrade(grade, activity.maxGrade ?? 0, graders),
          needsGrading: !!sub && (!grade || grade.score == null || !grade.gradedAt || grade.gradedAt < sub.submittedAt),
        };
      }),
    );
  });

  r.put('/:activityId/grades/:userId', async (c) => {
    const user = requireUser(c);
    const access = await loadActivityAccess(db, user, c.req.param('activityId'));
    assertCan(access, 'grades:edit');
    const { activity, course } = access;
    if (activity.maxGrade == null) throw badRequest('This activity is not graded.');
    const input = await readBody(
      c,
      z.object({ score: z.number().min(0).max(activity.maxGrade).nullable(), feedback: z.string().max(20_000).nullable().default(null) }),
    );
    const student = await db
      .selectFrom('enrolments')
      .select('userId')
      .where('courseId', '=', course.id)
      .where('userId', '=', c.req.param('userId'))
      .where('role', '=', 'student')
      .executeTakeFirst();
    if (!student) throw notFound('Student');
    await assertGradable(db, access, student.userId);
    await upsertGrade(deps, {
      activityId: activity.id,
      courseId: course.id,
      userId: student.userId,
      score: input.score,
      feedback: input.feedback,
      gradedBy: user.id,
    });
    if (input.score != null) {
      await notify(db, [student.userId], {
        type: 'grade',
        title: `${activity.title} was graded`,
        body: `You received ${input.score} / ${activity.maxGrade}.${input.feedback ? ' Your teacher left feedback.' : ''}`,
        link: `/courses/${course.slug}/activities/${activity.id}`,
      });
    }
    return c.json({ ok: true });
  });

  return r;
}
