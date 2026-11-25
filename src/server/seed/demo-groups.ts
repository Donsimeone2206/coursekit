/**
 * Demo groups and cohorts: project teams in Modern Web Development (Alex is in two groups) and a
 * bootcamp cohort linked to Data Science Fundamentals. Runs after the rest of the demo is inserted.
 */
import type { AppDeps } from '../context.js';
import { newId } from '../lib/util.js';

const GROUPS: Array<{ name: string; description: string; members: string[] }> = [
  {
    name: 'Team Aurora',
    description: 'Project team for the landing page and to-do list builds.',
    members: ['alex.johnson', 'sofia.martinez', 'liam.obrien', 'emma.wilson', 'noah.kim', 'olivia.brown'],
  },
  {
    name: 'Team Borealis',
    description: 'Project team for the landing page and to-do list builds.',
    members: ['ethan.davis', 'ava.thompson', 'lucas.silva', 'mia.garcia', 'james.lee', 'zara.ahmed'],
  },
  {
    name: 'Accessibility reviewers',
    description: 'Peer reviewers who check each project against the accessibility checklist.',
    members: ['alex.johnson', 'olivia.brown', 'mia.garcia', 'zara.ahmed'],
  },
];

const COHORTS: Array<{ name: string; description: string; members: string[]; course?: string }> = [
  {
    name: 'Fall 2026 bootcamp',
    description: 'Evening bootcamp learners who started in September.',
    members: ['alex.johnson', 'emma.wilson', 'noah.kim', 'mia.garcia', 'zara.ahmed', 'james.lee'],
    course: 'data-science-fundamentals',
  },
  {
    name: 'Teaching team',
    description: 'Instructors and teaching assistants.',
    members: ['maya.chen', 'daniel.okafor', 'priya.raman'],
  },
];

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

export async function seedDemoGroups(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const emails = [...new Set([...GROUPS, ...COHORTS].flatMap((g) => g.members))].map((m) => `${m}@coursekit.test`);
  const users = await db.selectFrom('users').select(['id', 'email']).where('email', 'in', emails).execute();
  const idOf = new Map(users.map((u) => [u.email.replace('@coursekit.test', ''), u.id]));
  const ids = (members: string[]) => members.map((m) => idOf.get(m)).filter((id): id is string => !!id);

  const webDev = await db.selectFrom('courses').select('id').where('slug', '=', 'modern-web-development').executeTakeFirst();
  if (webDev) {
    for (const [i, spec] of GROUPS.entries()) {
      const ts = daysAgo(20 - i);
      const groupId = newId();
      await db
        .insertInto('courseGroups')
        .values({ id: groupId, courseId: webDev.id, name: spec.name, description: spec.description, createdAt: ts, updatedAt: ts })
        .execute();
      const members = ids(spec.members);
      if (members.length) {
        await db
          .insertInto('courseGroupMembers')
          .values(members.map((userId) => ({ groupId, userId, courseId: webDev.id, createdAt: ts })))
          .execute();
      }
    }
  }

  for (const [i, spec] of COHORTS.entries()) {
    const ts = daysAgo(40 - i);
    const cohortId = newId();
    await db
      .insertInto('cohorts')
      .values({ id: cohortId, name: spec.name, description: spec.description, createdAt: ts, updatedAt: ts })
      .execute();
    const members = ids(spec.members);
    if (members.length) {
      await db
        .insertInto('cohortMembers')
        .values(members.map((userId) => ({ cohortId, userId, createdAt: ts })))
        .execute();
    }
    const course = spec.course ? await db.selectFrom('courses').select('id').where('slug', '=', spec.course).executeTakeFirst() : undefined;
    if (!course) continue;
    const admin = await db.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('createdAt', 'asc').executeTakeFirst();
    await db
      .insertInto('cohortCourses')
      .values({ id: newId(), cohortId, courseId: course.id, role: 'student', createdBy: admin?.id ?? null, createdAt: ts })
      .execute();
    // The linked cohort's members are enrolled, as cohort enrolment would have done (quietly: no demo notifications).
    if (members.length) {
      await db
        .insertInto('enrolments')
        .values(
          members.map((userId) => ({
            id: newId(),
            courseId: course.id,
            userId,
            role: 'student' as const,
            status: 'active' as const,
            lastAccessAt: null,
            createdAt: ts,
          })),
        )
        .onConflict((oc) => oc.columns(['courseId', 'userId']).doNothing())
        .execute();
    }
  }
}
