import { sql } from 'kysely';
import type {
  CohortCandidate,
  CohortDetail,
  CohortLink,
  CohortMember,
  CohortMembersAdded,
  CohortOption,
  CohortSummary,
  CourseRole,
  Paginated,
} from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { CohortCourseRow, CohortRow, CourseRow, UserRow } from '../db/schema.js';
import type { DB } from '../db/types.js';
import { conflict, notFound } from '../lib/http.js';
import { emailSchema } from '../lib/schemas.js';
import { likePattern, newId, now, num } from '../lib/util.js';
import { announceEnrolments, insertEnrolments } from './enrolments.js';
import { byName, isUniqueViolation } from './groups.js';
import { toCourseRef } from './serialize.js';
import { normalizeEmail } from './users.js';

type Deps = Pick<AppDeps, 'db' | 'events'>;
type Actor = Pick<UserRow, 'id' | 'name'>;

// Ids per `in (...)` list and rows per insert, to stay well under SQLite's bound-parameter limit.
const CHUNK = 400;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const via = (cohort: Pick<CohortRow, 'name'>) => `through the cohort ${cohort.name}`;
const nameTaken = () => conflict('Another cohort already has that name.');

export async function loadCohort(db: DB, cohortId: string): Promise<CohortRow> {
  const cohort = await db.selectFrom('cohorts').selectAll().where('id', '=', cohortId).executeTakeFirst();
  if (!cohort) throw notFound('Cohort');
  return cohort;
}

async function memberCounts(db: DB, cohortIds: string[]): Promise<Map<string, number>> {
  if (cohortIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('cohortMembers')
    .select(['cohortId', (eb) => eb.fn.countAll().as('n')])
    .where('cohortId', 'in', cohortIds)
    .groupBy('cohortId')
    .execute();
  return new Map(rows.map((r) => [r.cohortId, num(r.n)]));
}

async function courseCounts(db: DB, cohortIds: string[]): Promise<Map<string, number>> {
  if (cohortIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('cohortCourses')
    .select(['cohortId', (eb) => eb.fn.countAll().as('n')])
    .where('cohortId', 'in', cohortIds)
    .groupBy('cohortId')
    .execute();
  return new Map(rows.map((r) => [r.cohortId, num(r.n)]));
}

async function summarize(db: DB, cohorts: CohortRow[]): Promise<CohortSummary[]> {
  const ids = cohorts.map((c) => c.id);
  const [members, courses] = await Promise.all([memberCounts(db, ids), courseCounts(db, ids)]);
  return cohorts.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    memberCount: members.get(c.id) ?? 0,
    courseCount: courses.get(c.id) ?? 0,
    createdAt: c.createdAt,
  }));
}

export async function listCohorts(
  db: DB,
  query: { q?: string | undefined; page: number; pageSize: number },
): Promise<Paginated<CohortSummary>> {
  let base = db.selectFrom('cohorts');
  if (query.q?.trim()) {
    const pattern = likePattern(query.q);
    base = base.where((eb) => eb.or([eb(eb.fn('lower', ['name']), 'like', pattern), eb(eb.fn('lower', ['description']), 'like', pattern)]));
  }
  const total = await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
  const rows = await base
    .selectAll()
    .orderBy(sql`lower(name)`)
    .orderBy('id')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { items: await summarize(db, rows), total: num(total?.n), page: query.page, pageSize: query.pageSize };
}

/** Cohort links, with each cohort's member count, for one cohort or one course. */
async function links(db: DB, where: { cohortId: string } | { courseId: string }): Promise<CohortLink[]> {
  const rows = await db
    .selectFrom('cohortCourses')
    .innerJoin('cohorts', 'cohorts.id', 'cohortCourses.cohortId')
    .innerJoin('courses', 'courses.id', 'cohortCourses.courseId')
    .select([
      'cohortCourses.id',
      'cohortCourses.role',
      'cohortCourses.createdAt',
      'cohorts.id as cohortId',
      'cohorts.name as cohortName',
      'courses.id as courseId',
      'courses.slug as courseSlug',
      'courses.title as courseTitle',
      'courses.coverColor as courseCoverColor',
    ])
    .$if('cohortId' in where, (q) => q.where('cohortCourses.cohortId', '=', (where as { cohortId: string }).cohortId))
    .$if('courseId' in where, (q) => q.where('cohortCourses.courseId', '=', (where as { courseId: string }).courseId))
    .execute();
  const counts = await memberCounts(db, [...new Set(rows.map((r) => r.cohortId))]);
  return rows
    .map((r) => ({
      id: r.id,
      cohort: { id: r.cohortId, name: r.cohortName, memberCount: counts.get(r.cohortId) ?? 0 },
      course: { id: r.courseId, slug: r.courseSlug, title: r.courseTitle, coverColor: r.courseCoverColor },
      role: r.role,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => ('cohortId' in where ? byName({ name: a.course.title }, { name: b.course.title }) : byName(a.cohort, b.cohort)));
}

export async function cohortDetail(db: DB, cohort: CohortRow): Promise<CohortDetail> {
  const [summary] = await summarize(db, [cohort]);
  return { ...summary!, links: await links(db, { cohortId: cohort.id }) };
}

async function assertNameFree(db: DB, name: string, exceptId?: string) {
  const taken = await db
    .selectFrom('cohorts')
    .select('id')
    .where((eb) => eb(eb.fn('lower', ['name']), '=', eb.fn('lower', [eb.cast(eb.val(name), 'text')])))
    .$if(!!exceptId, (q) => q.where('id', '!=', exceptId!))
    .executeTakeFirst();
  if (taken) throw nameTaken();
}

export async function createCohort(deps: Deps, input: { name: string; description: string }): Promise<CohortRow> {
  await assertNameFree(deps.db, input.name);
  const ts = now();
  const cohort: CohortRow = { id: newId(), name: input.name, description: input.description, createdAt: ts, updatedAt: ts };
  try {
    await deps.db.insertInto('cohorts').values(cohort).execute();
  } catch (err) {
    throw isUniqueViolation(err) ? nameTaken() : err;
  }
  deps.events.emit('cohort.created', { cohortId: cohort.id });
  return cohort;
}

export async function updateCohort(deps: Deps, cohort: CohortRow, input: { name?: string | undefined; description?: string | undefined }) {
  if (input.name !== undefined && input.name !== cohort.name) await assertNameFree(deps.db, input.name, cohort.id);
  const update = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    updatedAt: now(),
  };
  try {
    await deps.db.updateTable('cohorts').set(update).where('id', '=', cohort.id).execute();
  } catch (err) {
    throw isUniqueViolation(err) ? nameTaken() : err;
  }
  deps.events.emit('cohort.updated', { cohortId: cohort.id });
  return { ...cohort, ...update };
}

/** Deletes the cohort and its course links. Enrolments made through it are kept. */
export async function deleteCohort(deps: Deps, cohort: CohortRow) {
  await deps.db.deleteFrom('cohorts').where('id', '=', cohort.id).execute();
  deps.events.emit('cohort.deleted', { cohortId: cohort.id });
}

export async function listCohortMembers(
  db: DB,
  cohortId: string,
  query: { q?: string | undefined; page: number; pageSize: number },
): Promise<Paginated<CohortMember>> {
  let base = db
    .selectFrom('cohortMembers')
    .innerJoin('users', 'users.id', 'cohortMembers.userId')
    .where('cohortMembers.cohortId', '=', cohortId);
  if (query.q?.trim()) {
    const pattern = likePattern(query.q);
    base = base.where((eb) => eb.or([eb(eb.fn('lower', ['users.name']), 'like', pattern), eb('users.email', 'like', pattern)]));
  }
  const total = await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
  const rows = await base
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl', 'users.status', 'cohortMembers.createdAt'])
    .orderBy(sql`lower(users.name)`)
    .orderBy('users.id')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return {
    items: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, avatarUrl: r.avatarUrl, status: r.status, addedAt: r.createdAt })),
    total: num(total?.n),
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** People matching a name or email search, marked when they are already in the cohort. */
export async function searchCohortCandidates(db: DB, cohortId: string, q: string): Promise<CohortCandidate[]> {
  const pattern = likePattern(q);
  const rows = await db
    .selectFrom('users')
    .leftJoin('cohortMembers', (join) => join.onRef('cohortMembers.userId', '=', 'users.id').on('cohortMembers.cohortId', '=', cohortId))
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl', 'cohortMembers.userId as memberId'])
    .where((eb) => eb.or([eb(eb.fn('lower', ['users.name']), 'like', pattern), eb('users.email', 'like', pattern)]))
    .orderBy(sql`lower(users.name)`)
    .orderBy('users.id')
    .limit(20)
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, avatarUrl: r.avatarUrl, member: r.memberId != null }));
}

/**
 * Adds people to a cohort by id or email and enrols the new members in every course the cohort is linked to,
 * through the same enrolment code path as "Enrol people" (notifications and `enrolment.created` events).
 * Memberships and enrolments are written in one transaction.
 */
export async function addCohortMembers(
  deps: Deps,
  cohort: CohortRow,
  input: { userIds: string[]; emails: string[] },
  actor: Actor,
): Promise<CohortMembersAdded> {
  const { db } = deps;
  const invalid: string[] = [];
  const emails = new Set<string>();
  for (const raw of input.emails) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    if (emailSchema.safeParse(email).success) emails.add(email);
    else invalid.push(raw.trim());
  }
  const ids = [...new Set(input.userIds)];

  const emailOf = new Map<string, string>();
  for (const part of chunks([...emails])) {
    for (const u of await db.selectFrom('users').select(['id', 'email']).where('email', 'in', part).execute()) emailOf.set(u.id, u.email);
  }
  const foundEmails = new Set(emailOf.values());
  const foundIds = new Set<string>();
  for (const part of chunks(ids)) {
    for (const u of await db.selectFrom('users').select(['id', 'email']).where('id', 'in', part).execute()) {
      emailOf.set(u.id, u.email);
      foundIds.add(u.id);
    }
  }
  const notFound = [...[...emails].filter((e) => !foundEmails.has(e)), ...ids.filter((id) => !foundIds.has(id))];
  const people = [...emailOf.keys()];

  const linked = await db
    .selectFrom('cohortCourses')
    .innerJoin('courses', 'courses.id', 'cohortCourses.courseId')
    .select(['cohortCourses.role', 'courses.id', 'courses.slug', 'courses.title'])
    .where('cohortCourses.cohortId', '=', cohort.id)
    .execute();

  const ts = now();
  const { added, enrolments } = await db.transaction().execute(async (trx) => {
    const added: string[] = [];
    for (const part of chunks(people)) {
      const rows = await trx
        .insertInto('cohortMembers')
        .values(part.map((userId) => ({ cohortId: cohort.id, userId, createdAt: ts })))
        .onConflict((oc) => oc.columns(['cohortId', 'userId']).doNothing())
        .returning('userId')
        .execute();
      for (const row of rows) added.push(row.userId);
    }
    const enrolments: Array<{ course: (typeof linked)[number]; userIds: string[] }> = [];
    for (const course of linked) enrolments.push({ course, userIds: await insertEnrolments(trx, course, added, course.role) });
    return { added, enrolments };
  });

  for (const userId of added) deps.events.emit('cohort.member.added', { cohortId: cohort.id, userId });
  for (const { course, userIds } of enrolments) await announceEnrolments(deps, course, userIds, course.role, { actor, via: via(cohort) });

  const addedSet = new Set(added);
  return {
    added: added.length,
    alreadyMembers: people.filter((id) => !addedSet.has(id)).map((id) => emailOf.get(id) ?? id),
    notFound,
    invalid,
    enrolled: enrolments.reduce((sum, e) => sum + e.userIds.length, 0),
  };
}

/** Removes someone from a cohort. Their course enrolments are kept. */
export async function removeCohortMember(deps: Deps, cohort: CohortRow, userId: string) {
  const result = await deps.db
    .deleteFrom('cohortMembers')
    .where('cohortId', '=', cohort.id)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (num(result.numDeletedRows) === 0) throw notFound('Cohort member');
  deps.events.emit('cohort.member.removed', { cohortId: cohort.id, userId });
}

export function courseCohortLinks(db: DB, courseId: string): Promise<CohortLink[]> {
  return links(db, { courseId });
}

/** Cohorts that aren't linked to the course yet. */
export async function availableCohorts(db: DB, courseId: string): Promise<CohortOption[]> {
  const rows = await db
    .selectFrom('cohorts')
    .select(['cohorts.id', 'cohorts.name'])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('cohortCourses')
            .select('cohortCourses.id')
            .whereRef('cohortCourses.cohortId', '=', 'cohorts.id')
            .where('cohortCourses.courseId', '=', courseId),
        ),
      ),
    )
    .execute();
  const counts = await memberCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, memberCount: counts.get(r.id) ?? 0 })).sort(byName);
}

export async function loadCohortLink(db: DB, courseId: string, linkId: string): Promise<CohortCourseRow> {
  const link = await db
    .selectFrom('cohortCourses')
    .selectAll()
    .where('id', '=', linkId)
    .where('courseId', '=', courseId)
    .executeTakeFirst();
  if (!link) throw notFound('Cohort link');
  return link;
}

const alreadyLinked = () => conflict('This cohort is already linked to the course.');

/**
 * Links a cohort to a course: every current member is enrolled with `role` (people already enrolled keep their
 * enrolment as it is), and members who join the cohort later are enrolled when they are added.
 */
export async function linkCohort(deps: Deps, course: CourseRow, cohort: CohortRow, role: CourseRole, actor: Actor) {
  const { db } = deps;
  const existing = await db
    .selectFrom('cohortCourses')
    .select('id')
    .where('cohortId', '=', cohort.id)
    .where('courseId', '=', course.id)
    .executeTakeFirst();
  if (existing) throw alreadyLinked();
  const row: CohortCourseRow = { id: newId(), cohortId: cohort.id, courseId: course.id, role, createdBy: actor.id, createdAt: now() };
  let result: { added: string[]; memberCount: number };
  try {
    result = await db.transaction().execute(async (trx) => {
      await trx.insertInto('cohortCourses').values(row).execute();
      const members = await trx.selectFrom('cohortMembers').select('userId').where('cohortId', '=', cohort.id).execute();
      const added = await insertEnrolments(
        trx,
        course,
        members.map((m) => m.userId),
        role,
      );
      return { added, memberCount: members.length };
    });
  } catch (err) {
    throw isUniqueViolation(err) ? alreadyLinked() : err;
  }
  deps.events.emit('cohort.linked', { cohortId: cohort.id, courseId: course.id, role });
  await announceEnrolments(deps, course, result.added, role, { actor, via: via(cohort) });
  const link: CohortLink = {
    id: row.id,
    cohort: { id: cohort.id, name: cohort.name, memberCount: result.memberCount },
    course: toCourseRef(course),
    role,
    createdAt: row.createdAt,
  };
  return { link, enrolled: result.added.length };
}

/** Enrols any member of a linked cohort who isn't in the course (for example after a teacher removed them). */
export async function syncCohortLink(deps: Deps, course: CourseRow, link: CohortCourseRow, actor: Actor): Promise<number> {
  const cohort = await loadCohort(deps.db, link.cohortId);
  const added = await deps.db.transaction().execute(async (trx) => {
    const members = await trx.selectFrom('cohortMembers').select('userId').where('cohortId', '=', cohort.id).execute();
    return insertEnrolments(
      trx,
      course,
      members.map((m) => m.userId),
      link.role,
    );
  });
  await announceEnrolments(deps, course, added, link.role, { actor, via: via(cohort) });
  return added.length;
}

/** Unlinks a cohort from a course. Everyone it enrolled stays enrolled. */
export async function unlinkCohort(deps: Deps, link: CohortCourseRow) {
  await deps.db.deleteFrom('cohortCourses').where('id', '=', link.id).execute();
  deps.events.emit('cohort.unlinked', { cohortId: link.cohortId, courseId: link.courseId });
}
