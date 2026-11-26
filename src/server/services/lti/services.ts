/**
 * LTI Advantage services for one course and tool: Assignment and Grade Services 2.0 (line items,
 * scores, results) and Names and Role Provisioning Services 2.0 (memberships).
 *
 * A graded External tool activity has one platform-managed line item whose id is the activity id;
 * its label and maximum follow the activity, and scores for it go into the Coursekit gradebook.
 * Line items the tool creates itself are stored in lti_line_items and kept apart from the gradebook.
 */
import type { AppDeps } from '../../context.js';
import type { ActivityRow, CourseRow } from '../../db/schema.js';
import type { LtiLineItemRow, LtiToolRow } from '../../db/schema-lti.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';
import { now, round } from '../../lib/util.js';
import { parseSettings } from '../activity-types.js';
import { upsertGrade } from '../grades.js';
import { markCompleted } from '../progress.js';
import { ltiRoles, ROLES } from './messages.js';
import { toolActivitiesInCourse } from './tools.js';

export const MEDIA = {
  lineItem: 'application/vnd.ims.lis.v2.lineitem+json',
  lineItemContainer: 'application/vnd.ims.lis.v2.lineitemcontainer+json',
  score: 'application/vnd.ims.lis.v1.score+json',
  resultContainer: 'application/vnd.ims.lis.v2.resultcontainer+json',
  membershipContainer: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
} as const;

export interface LineItem {
  id: string;
  /** The gradebook line item of a graded External tool activity. */
  managed: boolean;
  activity: ActivityRow | null;
  row: LtiLineItemRow | null;
  label: string;
  scoreMaximum: number;
  resourceLinkId: string | null;
  resourceId: string | null;
  tag: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
}

function managedItem(activity: ActivityRow): LineItem {
  const s = parseSettings('lti', activity.settings);
  return {
    id: activity.id,
    managed: true,
    activity,
    row: null,
    label: activity.title,
    scoreMaximum: activity.maxGrade ?? 0,
    resourceLinkId: activity.id,
    resourceId: s.lineItemResourceId,
    tag: s.lineItemTag,
    startDateTime: null,
    endDateTime: activity.dueAt,
  };
}

function toolItem(row: LtiLineItemRow): LineItem {
  return {
    id: row.id,
    managed: false,
    activity: null,
    row,
    label: row.label,
    scoreMaximum: row.scoreMaximum,
    resourceLinkId: row.resourceLinkId,
    resourceId: row.resourceId,
    tag: row.tag,
    startDateTime: row.startDateTime,
    endDateTime: row.endDateTime,
  };
}

/** Every line item the tool can see in the course: its graded activities' line items first, then its own. */
export async function listLineItems(db: DB, toolId: string, courseId: string): Promise<LineItem[]> {
  const activities = (await toolActivitiesInCourse(db, courseId, toolId))
    .filter((a) => a.maxGrade != null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const rows = await db
    .selectFrom('ltiLineItems')
    .selectAll()
    .where('courseId', '=', courseId)
    .where('toolId', '=', toolId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return [...activities.map(managedItem), ...rows.map(toolItem)];
}

export async function findLineItem(db: DB, toolId: string, courseId: string, id: string): Promise<LineItem | null> {
  return (await listLineItems(db, toolId, courseId)).find((item) => item.id === id) ?? null;
}

export function lineItemUrl(issuer: string, courseId: string, id: string): string {
  return `${issuer}/lti/ags/${courseId}/lineitems/${id}`;
}

export function lineItemJson(issuer: string, courseId: string, item: LineItem): Record<string, unknown> {
  const json: Record<string, unknown> = { id: lineItemUrl(issuer, courseId, item.id), label: item.label, scoreMaximum: item.scoreMaximum };
  if (item.resourceLinkId) json.resourceLinkId = item.resourceLinkId;
  if (item.resourceId) json.resourceId = item.resourceId;
  if (item.tag) json.tag = item.tag;
  if (item.startDateTime) json.startDateTime = item.startDateTime;
  if (item.endDateTime) json.endDateTime = item.endDateTime;
  return json;
}

/** A resource link the tool may attach a line item to: one of its External tool activities in the course. */
export async function checkResourceLink(db: DB, toolId: string, courseId: string, resourceLinkId: string | null | undefined) {
  if (!resourceLinkId) return null;
  const ok = (await toolActivitiesInCourse(db, courseId, toolId)).some((a) => a.id === resourceLinkId);
  if (!ok) throw badRequest('resourceLinkId is not a resource link of this tool in this course.');
  return resourceLinkId;
}

export interface ScoreInput {
  userId: string;
  scoreGiven?: number | null | undefined;
  scoreMaximum?: number | null | undefined;
  comment?: string | null | undefined;
  activityProgress: string;
  gradingProgress: string;
  timestamp: string;
}

/**
 * Stores a score. Scores older than the last one recorded for the line item and user are ignored.
 * For an activity's gradebook line item, a FullyGraded score is scaled to the activity's maximum and
 * recorded with upsertGrade (students only), and activityProgress Completed completes the activity.
 */
export async function recordScore(
  deps: Pick<AppDeps, 'db' | 'events'>,
  tool: LtiToolRow,
  course: CourseRow,
  item: LineItem,
  input: ScoreInput,
): Promise<{ recorded: boolean }> {
  const { db } = deps;
  const enrolment = await db
    .selectFrom('enrolments')
    .select(['role'])
    .where('courseId', '=', course.id)
    .where('userId', '=', input.userId)
    .executeTakeFirst();
  if (!enrolment) throw badRequest('That user is not a member of this course.');

  const timestamp = new Date(input.timestamp).toISOString();
  const values = {
    scoreGiven: input.scoreGiven ?? null,
    scoreMaximum: input.scoreMaximum ?? null,
    comment: input.comment ?? null,
    activityProgress: input.activityProgress,
    gradingProgress: input.gradingProgress,
    scoreTimestamp: timestamp,
    updatedAt: now(),
  };
  const result = await db
    .insertInto('ltiScores')
    .values({
      lineItemId: item.id,
      userId: input.userId,
      courseId: course.id,
      toolId: tool.id,
      activityId: item.managed ? item.id : null,
      ...values,
    })
    .onConflict((oc) => oc.columns(['lineItemId', 'userId']).doUpdateSet(values).where('ltiScores.scoreTimestamp', '<=', timestamp))
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) return { recorded: false };

  const activity = item.activity;
  if (item.managed && activity && activity.maxGrade != null && enrolment.role === 'student') {
    if (input.gradingProgress === 'FullyGraded') {
      await upsertGrade(deps, {
        activityId: activity.id,
        courseId: course.id,
        userId: input.userId,
        score: toolGrade(input.scoreGiven, input.scoreMaximum, activity.maxGrade),
        ...(input.comment != null ? { feedback: input.comment } : {}),
        gradedBy: null,
      });
    }
    if (input.activityProgress === 'Completed' && activity.completion === 'auto') await markCompleted(deps, activity, input.userId);
  }
  return { recorded: true };
}

/** A tool's score scaled to the activity's maximum grade (null when the tool gave no score). */
function toolGrade(given: number | null | undefined, max: number | null | undefined, maxGrade: number): number | null {
  return given == null || !max ? null : round(Math.min(Math.max(given / max, 0), 1) * maxGrade, 2);
}

/**
 * Rescales an External tool activity's grades after its maximum grade changed. A grade from the tool
 * is recomputed from the tool's last FullyGraded score; any other grade (a teacher's, or one whose
 * latest score is still pending) keeps its share of the previous maximum, capped at the new one.
 */
export async function regradeLtiActivity(
  deps: Pick<AppDeps, 'db' | 'events'>,
  activity: ActivityRow,
  previousMax: number | null,
): Promise<void> {
  const maxGrade = activity.maxGrade;
  if (maxGrade == null) return;
  const { db } = deps;
  const [students, scores, grades] = await Promise.all([
    db.selectFrom('enrolments').select('userId').where('courseId', '=', activity.courseId).where('role', '=', 'student').execute(),
    db
      .selectFrom('ltiScores')
      .select(['userId', 'scoreGiven', 'scoreMaximum'])
      .where('activityId', '=', activity.id)
      .where('gradingProgress', '=', 'FullyGraded')
      .execute(),
    db.selectFrom('grades').select(['userId', 'score', 'gradedBy']).where('activityId', '=', activity.id).execute(),
  ]);
  const isStudent = new Set(students.map((s) => s.userId));
  const fromTool = new Map(scores.map((s) => [s.userId, toolGrade(s.scoreGiven, s.scoreMaximum, maxGrade)]));
  for (const grade of grades) {
    if (grade.score == null || !isStudent.has(grade.userId)) continue;
    const score =
      grade.gradedBy == null && fromTool.has(grade.userId)
        ? fromTool.get(grade.userId)!
        : round(previousMax ? Math.min(grade.score / previousMax, 1) * maxGrade : Math.min(grade.score, maxGrade), 2);
    if (score === grade.score) continue;
    await upsertGrade(deps, {
      activityId: activity.id,
      courseId: activity.courseId,
      userId: grade.userId,
      score,
      gradedBy: grade.gradedBy,
    });
  }
}

export interface ResultJson {
  id: string;
  scoreOf: string;
  userId: string;
  resultScore?: number;
  resultMaximum: number;
  comment?: string;
}

/** Current results of a line item: the gradebook's grades for an activity's line item, the tool's scores otherwise. */
export async function listResults(db: DB, issuer: string, courseId: string, item: LineItem, userId?: string): Promise<ResultJson[]> {
  const url = lineItemUrl(issuer, courseId, item.id);
  const result = (uid: string, score: number | null, max: number, comment: string | null): ResultJson => ({
    id: `${url}/results/${uid}`,
    scoreOf: url,
    userId: uid,
    ...(score != null ? { resultScore: score } : {}),
    resultMaximum: max,
    ...(comment ? { comment } : {}),
  });
  if (item.managed) {
    const grades = await db
      .selectFrom('grades')
      .select(['userId', 'score', 'feedback'])
      .where('activityId', '=', item.id)
      .where('score', 'is not', null)
      .$if(!!userId, (q) => q.where('userId', '=', userId!))
      .orderBy('userId', 'asc')
      .execute();
    return grades.map((g) => result(g.userId, g.score, item.scoreMaximum, g.feedback));
  }
  const scores = await db
    .selectFrom('ltiScores')
    .select(['userId', 'scoreGiven', 'scoreMaximum', 'comment'])
    .where('lineItemId', '=', item.id)
    .$if(!!userId, (q) => q.where('userId', '=', userId!))
    .orderBy('userId', 'asc')
    .execute();
  return scores.map((s) =>
    result(
      s.userId,
      s.scoreGiven != null && s.scoreMaximum ? round((s.scoreGiven / s.scoreMaximum) * item.scoreMaximum, 4) : null,
      item.scoreMaximum,
      s.comment,
    ),
  );
}

/** Course roles matching an NRPS `role` filter (a full LIS role URI or its short name). null = no filter. */
export function courseRolesFor(role: string | undefined): Array<'teacher' | 'assistant' | 'student'> | null {
  if (!role) return null;
  const r = role.trim();
  if (r === ROLES.learner || r === 'Learner') return ['student'];
  if (r === ROLES.instructor || r === 'Instructor') return ['teacher', 'assistant'];
  if (r === ROLES.teachingAssistant || r === 'TeachingAssistant' || r === 'Instructor#TeachingAssistant') return ['assistant'];
  return [];
}

export interface MembersPage {
  members: Array<Record<string, unknown>>;
  hasMore: boolean;
}

/** Course members for NRPS. Names and emails only when the tool may have them. */
export async function listMembers(
  db: DB,
  tool: LtiToolRow,
  course: CourseRow,
  options: { role?: string; limit: number; page: number },
): Promise<MembersPage> {
  const roles = courseRolesFor(options.role);
  if (roles && roles.length === 0) return { members: [], hasMore: false };
  const rows = await db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.status as userStatus', 'enrolments.role', 'enrolments.status'])
    .where('enrolments.courseId', '=', course.id)
    .$if(!!roles, (q) => q.where('enrolments.role', 'in', roles!))
    .orderBy('users.name', 'asc')
    .orderBy('users.id', 'asc')
    .limit(options.limit + 1)
    .offset((options.page - 1) * options.limit)
    .execute();
  const members = rows.slice(0, options.limit).map((m) => ({
    status: m.status === 'active' && m.userStatus === 'active' ? 'Active' : 'Inactive',
    user_id: m.id,
    // Context roles only: the class list doesn't reveal who is a site administrator.
    roles: ltiRoles('student', m.role),
    ...(tool.shareName ? { name: m.name } : {}),
    ...(tool.shareEmail ? { email: m.email } : {}),
  }));
  return { members, hasMore: rows.length > options.limit };
}
