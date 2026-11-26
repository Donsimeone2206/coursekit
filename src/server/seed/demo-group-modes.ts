/**
 * Demo group modes (0.3.0), in Modern Web Development: a "Team rooms" forum in separate groups with a discussion
 * for each project team and one for everyone, and an accessibility checklist that only the accessibility
 * reviewers see. Priya (teaching assistant) is in Team Aurora, so in the team rooms she only sees that team.
 * Runs after the demo groups exist. Quiet: no notifications.
 */
import type { AppDeps } from '../context.js';
import { newId } from '../lib/util.js';

const DAY = 86_400_000;
const at = (daysAgo: number, hours = 0) => new Date(Date.now() - daysAgo * DAY + hours * 3_600_000).toISOString();

type Person = 'maya' | 'priya' | 'alex' | 'sofia' | 'liam' | 'emma' | 'ethan' | 'ava' | 'lucas';

const THREADS: Array<{
  group: 'Team Aurora' | 'Team Borealis' | null;
  title: string;
  posts: Array<[Person, string]>;
  daysAgo: number;
  pinned?: boolean;
}> = [
  {
    group: null,
    title: 'How your team room works',
    pinned: true,
    daysAgo: 9,
    posts: [
      [
        'maya',
        "Each project team has its own room here. Only your team (and the teaching team) can see your team's discussions, so it's a safe place to share half-finished ideas.\n\nPost your plan, split the work and ask each other for reviews. I'll check in on every team once a week.",
      ],
    ],
  },
  {
    group: 'Team Aurora',
    title: 'To-do list: who builds what?',
    daysAgo: 6,
    posts: [
      ['alex', 'I can take the add/remove logic and the localStorage part. Anyone keen on the filters (all / active / done)?'],
      ['sofia', "I'll do the filters! Liam, could you look at the empty state and keyboard support?"],
      ['liam', 'On it. I will also check the focus styles against the accessibility checklist.'],
      ['priya', "Nice split, team. Remember to open a pull request for each part so you can review each other's code."],
    ],
  },
  {
    group: 'Team Aurora',
    title: 'Landing page colour palette',
    daysAgo: 12,
    posts: [
      ['emma', 'Here are three palettes I like. Can we vote by Friday?'],
      ['alex', 'Option two! It has the best contrast for the buttons.'],
    ],
  },
  {
    group: 'Team Borealis',
    title: 'Stand-up notes, week 5',
    daysAgo: 5,
    posts: [
      ['ethan', "Done: the layout grid. Next: the project cards. Blocked: nothing yet, but I'm not sure how to lazy-load the images."],
      ['ava', 'Try loading="lazy" on the img tags first, it might be all you need.'],
      ['lucas', "I'll pair with Ethan on the cards tomorrow."],
    ],
  },
];

const CHECKLIST = `# Accessibility review checklist

You're one of this term's accessibility reviewers. Use this checklist when you review a team's project, and leave your notes in their pull request.

1. **Keyboard**: can you reach and use everything with Tab, Enter and Space? Is the focus always visible?
2. **Contrast**: do text and buttons meet a 4.5:1 contrast ratio (3:1 for large text)?
3. **Structure**: is there one \`h1\`, are headings in order, and are landmarks (\`header\`, \`main\`, \`nav\`) used?
4. **Images**: does every meaningful image have useful alt text, and do decorative ones have \`alt=""\`?
5. **Forms**: does every field have a visible label, and are errors explained in words?

> Be kind and specific: point to the element, explain the problem and suggest a fix.`;

export async function seedGroupModesDemo(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const course = await db.selectFrom('courses').select(['id', 'createdBy']).where('slug', '=', 'modern-web-development').executeTakeFirst();
  if (!course) return;
  const groups = new Map(
    (await db.selectFrom('courseGroups').select(['id', 'name']).where('courseId', '=', course.id).execute()).map((g) => [g.name, g.id]),
  );
  const reviewers = groups.get('Accessibility reviewers');
  const aurora = groups.get('Team Aurora');
  if (!reviewers || !aurora) return;
  const users = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where(
      'email',
      'in',
      Object.values(EMAILS).map((e) => `${e}@coursekit.test`),
    )
    .execute();
  const idOf = new Map(users.map((u) => [u.email.split('@')[0]!, u.id]));
  const id = (p: Person) => idOf.get(EMAILS[p]);
  const maya = id('maya');
  const priya = id('priya');

  // Priya, the teaching assistant, helps Team Aurora.
  if (priya) {
    await db
      .insertInto('courseGroupMembers')
      .values({ groupId: aurora, userId: priya, courseId: course.id, createdAt: at(18) })
      .onConflict((oc) => oc.columns(['groupId', 'userId']).doNothing())
      .execute();
  }

  const section = await db
    .selectFrom('sections')
    .select('id')
    .where('courseId', '=', course.id)
    .where('title', '=', 'JavaScript Essentials')
    .executeTakeFirst();
  if (!section) return;
  const last = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  let position = last?.m == null ? 0 : Number(last.m) + 1;

  const forumId = newId();
  const checklistId = newId();
  const base = { courseId: course.id, sectionId: section.id, visible: 1, dueAt: null, maxGrade: null, createdBy: maya ?? course.createdBy };
  await db
    .insertInto('activities')
    .values([
      {
        ...base,
        id: forumId,
        type: 'forum',
        title: 'Team rooms',
        description: 'A private space for each project team to plan, split the work and review each other.',
        position: position++,
        settings: JSON.stringify({ studentsCanStartDiscussions: true }),
        completion: 'none',
        groupMode: 'separate',
        createdAt: at(10),
        updatedAt: at(10),
      },
      {
        ...base,
        id: checklistId,
        type: 'lesson',
        title: 'Accessibility review checklist',
        description: '',
        position: position++,
        settings: JSON.stringify({ body: CHECKLIST, videoUrl: null, estimatedMinutes: 5 }),
        completion: 'manual',
        groupMode: null,
        createdAt: at(15),
        updatedAt: at(15),
      },
    ])
    .execute();
  await db
    .insertInto('activityGroups')
    .values({ activityId: checklistId, groupId: reviewers, courseId: course.id, createdAt: at(15) })
    .execute();

  for (const thread of THREADS) {
    const authors = thread.posts.map(([p]) => id(p));
    if (authors.some((a) => !a)) continue;
    const discussionId = newId();
    const started = at(thread.daysAgo);
    const times = thread.posts.map((_, i) => at(thread.daysAgo, i * 5));
    await db
      .insertInto('discussions')
      .values({
        id: discussionId,
        activityId: forumId,
        courseId: course.id,
        userId: authors[0]!,
        title: thread.title,
        pinned: thread.pinned ? 1 : 0,
        locked: 0,
        replyCount: thread.posts.length - 1,
        lastPostAt: times[times.length - 1]!,
        createdAt: started,
        groupId: thread.group ? (groups.get(thread.group) ?? null) : null,
      })
      .execute();
    const rootId = newId();
    await db
      .insertInto('posts')
      .values(
        thread.posts.map(([, body], i) => ({
          id: i === 0 ? rootId : newId(),
          discussionId,
          courseId: course.id,
          userId: authors[i]!,
          parentId: i === 0 ? null : rootId,
          body,
          createdAt: times[i]!,
          updatedAt: times[i]!,
        })),
      )
      .execute();
  }
}

const EMAILS: Record<Person, string> = {
  maya: 'maya.chen',
  priya: 'priya.raman',
  alex: 'alex.johnson',
  sofia: 'sofia.martinez',
  liam: 'liam.obrien',
  emma: 'emma.wilson',
  ethan: 'ethan.davis',
  ava: 'ava.thompson',
  lucas: 'lucas.silva',
};
