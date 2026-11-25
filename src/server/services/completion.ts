import {
  DEFAULT_CERTIFICATE,
  type CompletionActivityOption,
  type CompletionCriterion,
  type CompletionReport,
  type CompletionReportRow,
  type CourseCompletionSettings,
  type CourseCompletionStatus,
  type SaveCompletionSettingsResult,
} from '../../shared/completion.js';
import type { AppDeps } from '../context.js';
import type { DB } from '../db/types.js';
import type { CertificateRow, CourseCompletionSettingsRow } from '../db/schema-completion.js';
import type { CourseRow } from '../db/schema.js';
import type { EventBus } from '../lib/events.js';
import { badRequest } from '../lib/http.js';
import { now, num, parseJson } from '../lib/util.js';
import { announceAwards, awardBadgesForCompletion, pruneDeletedCourse, type BadgeAwards } from './badges.js';
import { issueCertificates, issueMissingCertificates, toCertificateRef } from './certificates.js';
import { courseTotals } from './course-total.js';
import { notify } from './notify.js';

type Deps = Pick<AppDeps, 'db' | 'events'>;

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function toCompletionSettings(row: CourseCompletionSettingsRow | undefined): CourseCompletionSettings {
  if (!row)
    return { enabled: false, mode: 'all', activityIds: [], minGrade: null, certificate: { ...DEFAULT_CERTIFICATE }, updatedAt: null };
  return {
    enabled: !!row.enabled,
    mode: row.mode === 'selected' ? 'selected' : 'all',
    activityIds: parseJson<string[]>(row.activityIds, []),
    minGrade: row.minGrade,
    certificate: {
      enabled: !!row.certificateEnabled,
      title: row.certificateTitle || DEFAULT_CERTIFICATE.title,
      body: row.certificateBody || DEFAULT_CERTIFICATE.body,
      signatureName: row.certificateSignatureName,
      signatureTitle: row.certificateSignatureTitle,
    },
    updatedAt: row.updatedAt,
  };
}

export async function loadCompletionSettings(db: DB, courseId: string): Promise<CourseCompletionSettingsRow | undefined> {
  return db.selectFrom('courseCompletionSettings').selectAll().where('courseId', '=', courseId).executeTakeFirst();
}

/** Every activity in course order, and whether it counts towards completion (visible, tracking completion). */
export async function completionActivities(db: DB, courseId: string): Promise<CompletionActivityOption[]> {
  const rows = await db
    .selectFrom('activities')
    .innerJoin('sections', 'sections.id', 'activities.sectionId')
    .select([
      'activities.id',
      'activities.title',
      'activities.type',
      'activities.visible',
      'activities.completion',
      'sections.visible as sectionVisible',
      'sections.title as sectionTitle',
    ])
    .where('activities.courseId', '=', courseId)
    .orderBy('sections.position', 'asc')
    .orderBy('activities.position', 'asc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    sectionTitle: r.sectionTitle,
    visible: !!r.visible && !!r.sectionVisible,
    completion: r.completion,
    tracked: !!r.visible && !!r.sectionVisible && r.completion !== 'none',
  }));
}

/** The activities a student must complete: all tracked ones, or the selected ones that are tracked. */
export function requiredActivities(settings: CourseCompletionSettings, activities: CompletionActivityOption[]) {
  const tracked = activities.filter((a) => a.tracked);
  if (settings.mode === 'all') return tracked;
  const selected = new Set(settings.activityIds);
  return tracked.filter((a) => selected.has(a.id));
}

/** Completed-activity counts per user, limited to `activityIds` (and to `userIds` when given). */
async function doneCounts(db: DB, courseId: string, activityIds: string[], userIds?: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (activityIds.length === 0 || userIds?.length === 0) return counts;
  const query = (users?: string[]) =>
    db
      .selectFrom('completions')
      .select(['userId', (eb) => eb.fn.countAll().as('n')])
      .where('courseId', '=', courseId)
      .where('activityId', 'in', activityIds)
      .$if(!!users, (q) => q.where('userId', 'in', users!))
      .groupBy('userId')
      .execute();
  const rows = userIds ? (await Promise.all(chunks(userIds).map((c) => query(c)))).flat() : await query();
  for (const row of rows) counts.set(row.userId, num(row.n));
  return counts;
}

/** Active students of the course who haven't completed it yet (optionally only some of them). */
async function pendingStudents(db: DB, courseId: string, only?: string[]): Promise<string[]> {
  const query = (users?: string[]) =>
    db
      .selectFrom('enrolments')
      .leftJoin('courseCompletions', (join) =>
        join.onRef('courseCompletions.courseId', '=', 'enrolments.courseId').onRef('courseCompletions.userId', '=', 'enrolments.userId'),
      )
      .select('enrolments.userId')
      .where('enrolments.courseId', '=', courseId)
      .where('enrolments.role', '=', 'student')
      .where('enrolments.status', '=', 'active')
      .where('courseCompletions.userId', 'is', null)
      .$if(!!users, (q) => q.where('enrolments.userId', 'in', users!))
      .execute();
  if (!only) return (await query()).map((r) => r.userId);
  if (only.length === 0) return [];
  return (await Promise.all(chunks([...new Set(only)]).map((c) => query(c)))).flat().map((r) => r.userId);
}

interface CompletionRecord {
  at: string;
  completed: string[];
  certificates: CertificateRow[];
  awards: BadgeAwards[];
}

export interface CompleteOptions {
  /** Completion time, for imports and demo data. Defaults to now. */
  at?: string;
  /** Send notifications and emit events (default true). */
  announce?: boolean;
}

/**
 * Records that `userIds` completed the course, once each, together with their certificates and
 * automatic badges (one transaction). Returns the users who completed it now.
 */
export async function completeCourse(
  deps: Deps,
  course: CourseRow,
  settings: CourseCompletionSettingsRow,
  userIds: string[],
  options: CompleteOptions = {},
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const at = options.at ?? now();
  const record = await deps.db.transaction().execute(async (trx): Promise<CompletionRecord | null> => {
    const completed: string[] = [];
    for (const part of chunks([...new Set(userIds)], 200)) {
      const rows = await trx
        .insertInto('courseCompletions')
        .values(part.map((userId) => ({ courseId: course.id, userId, completedAt: at })))
        .onConflict((oc) => oc.columns(['courseId', 'userId']).doNothing())
        .returning('userId')
        .execute();
      completed.push(...rows.map((r) => r.userId));
    }
    if (completed.length === 0) return null;
    const certificates = settings.certificateEnabled
      ? await issueCertificates(
          trx,
          course,
          settings,
          completed.map((userId) => ({ userId, completedAt: at })),
          at,
        )
      : [];
    const awards = await awardBadgesForCompletion(trx, course.id, completed, at);
    return { at, completed, certificates, awards };
  });
  if (!record) return [];
  if (options.announce !== false) await announceCompletion(deps, course, record);
  return record.completed;
}

async function announceCompletion(deps: Deps, course: CourseRow, record: CompletionRecord) {
  const withCertificate = new Set(record.certificates.map((c) => c.userId));
  const [certified, plain] = [
    record.completed.filter((id) => withCertificate.has(id)),
    record.completed.filter((id) => !withCertificate.has(id)),
  ];
  const link = `/courses/${course.slug}`;
  await notify(deps.db, certified, {
    type: 'completion',
    title: `You completed ${course.title}`,
    body: 'Congratulations! Your certificate is ready to view and download.',
    link,
  });
  await notify(deps.db, plain, {
    type: 'completion',
    title: `You completed ${course.title}`,
    body: 'Congratulations on finishing the course!',
    link,
  });
  for (const userId of record.completed) deps.events.emit('course.completed', { courseId: course.id, userId, completedAt: record.at });
  for (const cert of record.certificates) {
    deps.events.emit('certificate.issued', { certificateId: cert.id, courseId: course.id, userId: cert.userId, code: cert.code });
  }
  await announceAwards(deps, record.awards, null);
}

/**
 * Checks the course's completion criteria for its active students (or only `userIds`) and records
 * completion for everyone who now meets them. Completion is permanent: people who completed the course
 * keep their completion when the criteria change later. Returns the users who completed it now.
 */
export async function evaluateCompletion(
  deps: Deps,
  courseId: string,
  userIds?: string[],
  options: CompleteOptions = {},
): Promise<string[]> {
  const { db } = deps;
  const row = await loadCompletionSettings(db, courseId);
  if (!row?.enabled) return [];
  const settings = toCompletionSettings(row);
  const required = requiredActivities(settings, await completionActivities(db, courseId));
  // A course with nothing to complete and no grade requirement can't be completed.
  if (required.length === 0 && settings.minGrade == null) return [];

  const candidates = await pendingStudents(db, courseId, userIds);
  if (candidates.length === 0) return [];
  const done = await doneCounts(
    db,
    courseId,
    required.map((a) => a.id),
    userIds ? candidates : undefined,
  );
  const totals = settings.minGrade != null ? await courseTotals(db, courseId, candidates) : null;
  const qualified = candidates.filter((userId) => {
    if ((done.get(userId) ?? 0) < required.length) return false;
    if (settings.minGrade == null) return true;
    const total = totals?.get(userId) ?? null;
    return total != null && total >= settings.minGrade;
  });
  if (qualified.length === 0) return [];
  const course = await db.selectFrom('courses').selectAll().where('id', '=', courseId).executeTakeFirst();
  if (!course) return [];
  return completeCourse(deps, course, row, qualified, options);
}

export interface CompletionSettingsInput {
  enabled: boolean;
  mode: 'all' | 'selected';
  activityIds: string[];
  minGrade: number | null;
  certificate: { enabled: boolean; title: string; body: string; signatureName: string; signatureTitle: string };
}

/** Saves the settings, then completes everyone who now qualifies and issues missing certificates. */
export async function saveCompletionSettings(
  deps: Deps,
  course: CourseRow,
  input: CompletionSettingsInput,
  userId: string,
): Promise<SaveCompletionSettingsResult> {
  const { db } = deps;
  const activityIds = [...new Set(input.activityIds)];
  if (activityIds.length) {
    const found = await db.selectFrom('activities').select('id').where('courseId', '=', course.id).where('id', 'in', activityIds).execute();
    if (found.length !== activityIds.length) throw badRequest('Some of the selected activities are not in this course.');
  }
  if (input.enabled && input.mode === 'selected' && activityIds.length === 0) throw badRequest('Choose at least one required activity.');

  const ts = now();
  const values = {
    enabled: input.enabled ? 1 : 0,
    mode: input.mode,
    activityIds: JSON.stringify(activityIds),
    minGrade: input.minGrade,
    certificateEnabled: input.certificate.enabled ? 1 : 0,
    certificateTitle: input.certificate.title,
    certificateBody: input.certificate.body,
    certificateSignatureName: input.certificate.signatureName,
    certificateSignatureTitle: input.certificate.signatureTitle,
    updatedAt: ts,
    updatedBy: userId,
  };
  await db
    .insertInto('courseCompletionSettings')
    .values({ courseId: course.id, ...values })
    .onConflict((oc) => oc.column('courseId').doUpdateSet(values))
    .execute();

  const newlyCompleted = input.enabled ? await evaluateCompletion(deps, course.id) : [];
  let certificatesIssued = 0;
  const row = (await loadCompletionSettings(db, course.id))!;
  if (input.certificate.enabled) {
    const issued = await issueMissingCertificates(db, course, row, ts);
    certificatesIssued = issued.length;
    await notify(
      db,
      issued.map((c) => c.userId),
      {
        type: 'completion',
        title: `Your certificate for ${course.title} is ready`,
        body: 'You completed the course, so you can now view and download your certificate.',
        link: `/courses/${course.slug}`,
      },
    );
    for (const cert of issued) {
      deps.events.emit('certificate.issued', { certificateId: cert.id, courseId: course.id, userId: cert.userId, code: cert.code });
    }
  }
  return { settings: toCompletionSettings(row), newlyCompleted: newlyCompleted.length, certificatesIssued };
}

/** One student's view: the criteria checklist and whether (and when) they completed the course. */
export async function completionStatus(db: DB, courseId: string, userId: string): Promise<CourseCompletionStatus> {
  const [row, completion, certificate] = await Promise.all([
    loadCompletionSettings(db, courseId),
    db
      .selectFrom('courseCompletions')
      .select('completedAt')
      .where('courseId', '=', courseId)
      .where('userId', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('certificates')
      .select(['id', 'code', 'revokedAt'])
      .where('courseId', '=', courseId)
      .where('userId', '=', userId)
      .executeTakeFirst(),
  ]);
  const settings = toCompletionSettings(row);
  const base = {
    enabled: settings.enabled,
    completed: !!completion,
    completedAt: completion?.completedAt ?? null,
    certificate: certificate ? toCertificateRef(certificate) : null,
    certificateEnabled: settings.certificate.enabled,
  };
  if (!settings.enabled) return { ...base, criteria: [], progress: completion ? 100 : 0 };

  const required = requiredActivities(settings, await completionActivities(db, courseId));
  const doneRows = required.length
    ? await db
        .selectFrom('completions')
        .select('activityId')
        .where('userId', '=', userId)
        .where(
          'activityId',
          'in',
          required.map((a) => a.id),
        )
        .execute()
    : [];
  const done = new Set(doneRows.map((r) => r.activityId));
  const criteria: CompletionCriterion[] = required.map((a) => ({
    kind: 'activity',
    activityId: a.id,
    title: a.title,
    type: a.type,
    done: done.has(a.id),
  }));
  if (settings.minGrade != null) {
    const current = (await courseTotals(db, courseId, [userId])).get(userId) ?? null;
    criteria.push({ kind: 'grade', minGrade: settings.minGrade, current, met: current != null && current >= settings.minGrade });
  }
  const met = criteria.filter((c) => (c.kind === 'grade' ? c.met : c.done)).length;
  const progress = completion ? 100 : criteria.length ? Math.round((met / criteria.length) * 100) : 0;
  return { ...base, criteria, progress };
}

/** The teacher's view: every active student's progress towards completion. */
export async function completionReport(db: DB, courseId: string): Promise<CompletionReport> {
  const row = await loadCompletionSettings(db, courseId);
  const settings = toCompletionSettings(row);
  const required = requiredActivities(settings, await completionActivities(db, courseId));
  const students = await db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
    .where('enrolments.courseId', '=', courseId)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .orderBy('users.name', 'asc')
    .execute();
  const studentIds = students.map((s) => s.id);
  const [completions, certificates, done, totals] = await Promise.all([
    db.selectFrom('courseCompletions').select(['userId', 'completedAt']).where('courseId', '=', courseId).execute(),
    db.selectFrom('certificates').select(['id', 'code', 'userId', 'revokedAt']).where('courseId', '=', courseId).execute(),
    doneCounts(
      db,
      courseId,
      required.map((a) => a.id),
    ),
    settings.minGrade != null ? courseTotals(db, courseId, studentIds) : Promise.resolve(null),
  ]);
  const completedAt = new Map(completions.map((c) => [c.userId, c.completedAt]));
  const certificateOf = new Map(certificates.map((c) => [c.userId, c]));
  const criteriaCount = required.length + (settings.minGrade != null ? 1 : 0);

  const rows: CompletionReportRow[] = students.map((s) => {
    const activitiesDone = Math.min(done.get(s.id) ?? 0, required.length);
    const grade = totals?.get(s.id) ?? null;
    const gradeMet = settings.minGrade != null ? grade != null && grade >= settings.minGrade : null;
    const finished = completedAt.get(s.id) ?? null;
    const met = activitiesDone + (gradeMet ? 1 : 0);
    const cert = certificateOf.get(s.id);
    return {
      user: { id: s.id, name: s.name, email: s.email, avatarUrl: s.avatarUrl },
      activitiesDone,
      activitiesTotal: required.length,
      progress: finished ? 100 : criteriaCount ? Math.round((met / criteriaCount) * 100) : 0,
      grade,
      gradeMet,
      completedAt: finished,
      certificate: cert ? toCertificateRef(cert) : null,
    };
  });
  const completed = rows.filter((r) => r.completedAt).length;
  const started = rows.filter((r) => !r.completedAt && (r.activitiesDone > 0 || r.gradeMet)).length;
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    minGrade: settings.minGrade,
    certificateEnabled: settings.certificate.enabled,
    activities: required.map((a) => ({ id: a.id, title: a.title, type: a.type })),
    summary: { students: rows.length, completed, inProgress: started, notStarted: rows.length - completed - started },
    rows,
  };
}

export interface CompletionEngine {
  /** Resolves once every queued completion check has finished. */
  idle(): Promise<void>;
  /** Finishes queued work and stops listening for events. */
  stop(): Promise<void>;
}

const engines = new WeakMap<EventBus, CompletionEngine>();

/** The running engine for a Coursekit instance's event bus (tests use it to wait for background checks). */
export function completionEngineFor(events: EventBus): CompletionEngine | undefined {
  return engines.get(events);
}

/**
 * Evaluates completion in the background when activities are completed or grades change. Checks are
 * queued and run one at a time, and events for the same course are batched into one check.
 */
export function startCompletionEngine(deps: Deps): CompletionEngine {
  const pending = new Map<string, Set<string>>();
  const tasks: Array<() => Promise<void>> = [];
  let running: Promise<void> | null = null;
  let stopped = false;

  const drain = async () => {
    try {
      while (!stopped && (tasks.length || pending.size)) {
        const task = tasks.shift();
        try {
          if (task) {
            await task();
            continue;
          }
          const [courseId, users] = pending.entries().next().value!;
          pending.delete(courseId);
          await evaluateCompletion(deps, courseId, [...users]);
        } catch (err) {
          console.error('[coursekit] Course completion check failed:', err);
        }
      }
    } finally {
      running = null;
    }
  };
  const kick = () => {
    if (!running && !stopped) running = drain();
  };
  const check = (courseId: string, userId: string) => {
    if (stopped) return;
    let users = pending.get(courseId);
    if (!users) pending.set(courseId, (users = new Set()));
    users.add(userId);
    kick();
  };

  const unsubscribe = [
    deps.events.on('activity.completed', (e) => check(e.courseId, e.userId)),
    deps.events.on('grade.updated', (e) => check(e.courseId, e.userId)),
    // A new gradebook setup (categories, weights) can change every student's course total.
    deps.events.on('gradebook.setup.updated', (e) => {
      if (stopped) return;
      tasks.push(async () => void (await evaluateCompletion(deps, e.courseId)));
      kick();
    }),
    deps.events.on('course.deleted', (e) => {
      if (stopped) return;
      tasks.push(() => pruneDeletedCourse(deps.db, e.courseId));
      kick();
    }),
  ];

  const engine: CompletionEngine = {
    async idle() {
      for (;;) {
        // Let event handlers that are already queued (as microtasks) add their work first.
        await new Promise((resolve) => setImmediate(resolve));
        if (running) await running;
        else if (stopped || (!pending.size && !tasks.length)) return;
        else kick();
      }
    },
    async stop() {
      await engine.idle();
      stopped = true;
      for (const off of unsubscribe) off();
    },
  };
  engines.set(deps.events, engine);
  return engine;
}
