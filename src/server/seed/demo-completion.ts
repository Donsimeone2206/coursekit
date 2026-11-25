/**
 * Demo data for course completion, certificates and badges. Runs at the end of seedDemo, after the
 * courses, people and their work exist:
 *  - Modern Web Development tracks completion (all activities and a 70% course grade) with a
 *    certificate. Nobody has finished it yet, so the report shows everyone's progress.
 *  - Spanish for Beginners requires its lesson and quiz with a 60% grade; a few students have
 *    completed it, so certificates and completion badges exist.
 *  - Course badges (one awarded by the teacher, two on completion) and site badges (one awarded by
 *    the administrator, one for completing Spanish for Beginners).
 */
import type { AttemptAnswer } from '../../shared/types.js';
import type { BadgeColor, BadgeCriteria, BadgeIcon } from '../../shared/completion.js';
import type { AppDeps } from '../context.js';
import type { BadgeRow } from '../db/schema-completion.js';
import { EventBus } from '../lib/events.js';
import { newId, now, parseJson, round } from '../lib/util.js';
import { insertAwards } from '../services/badges.js';
import {
  completionActivities,
  evaluateCompletion,
  loadCompletionSettings,
  requiredActivities,
  toCompletionSettings,
} from '../services/completion.js';
import { snapshotFromRow } from '../services/question-types.js';
import { gradeQuestion, loadQuizQuestions, type StoredOption } from '../services/quiz.js';

const DAY = 86_400_000;
const daysAgo = (days: number, hour = 9, minute = 0) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

const CERTIFICATE_BODY = 'This certifies that\n{name}\nhas successfully completed\n{course}\non {date}';

export async function seedCompletionDemo(deps: Pick<AppDeps, 'db' | 'events'>): Promise<void> {
  const { db } = deps;
  // Demo history is recorded as it happened, without notifying or emitting events now.
  const quiet = { db, events: new EventBus() };
  const ts = now();

  const courses = new Map(
    (await db.selectFrom('courses').selectAll().where('slug', 'in', ['modern-web-development', 'spanish-for-beginners']).execute()).map(
      (c) => [c.slug, c],
    ),
  );
  const web = courses.get('modern-web-development');
  const spanish = courses.get('spanish-for-beginners');
  if (!web || !spanish) return;
  const people = new Map(
    (await db.selectFrom('users').select(['id', 'email']).where('email', 'like', '%@coursekit.test').execute()).map((u) => [
      u.email.split('@')[0]!,
      u.id,
    ]),
  );
  const id = (handle: string) => people.get(handle)!;
  const admin = await db.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('createdAt', 'asc').executeTakeFirst();
  const activity = async (courseId: string, title: string) =>
    db.selectFrom('activities').selectAll().where('courseId', '=', courseId).where('title', '=', title).executeTakeFirstOrThrow();

  // Completion settings.
  const greetings = await activity(spanish.id, 'Greetings and introductions');
  const vocabulary = await activity(spanish.id, 'Vocabulary check');
  const settingsRow = (
    courseId: string,
    by: string,
    values: { mode: 'all' | 'selected'; activityIds: string[]; minGrade: number; signature: [string, string] },
  ) => ({
    courseId,
    enabled: 1,
    mode: values.mode,
    activityIds: JSON.stringify(values.activityIds),
    minGrade: values.minGrade,
    certificateEnabled: 1,
    certificateTitle: 'Certificate of Completion',
    certificateBody: CERTIFICATE_BODY,
    certificateSignatureName: values.signature[0],
    certificateSignatureTitle: values.signature[1],
    updatedAt: daysAgo(20),
    updatedBy: by,
  });
  await db
    .insertInto('courseCompletionSettings')
    .values([
      settingsRow(web.id, id('maya.chen'), { mode: 'all', activityIds: [], minGrade: 70, signature: ['Maya Chen', 'Lead instructor'] }),
      settingsRow(spanish.id, id('daniel.okafor'), {
        mode: 'selected',
        activityIds: [greetings.id, vocabulary.id],
        minGrade: 60,
        signature: ['Daniel Okafor', 'Course teacher'],
      }),
    ])
    .execute();

  // Badges.
  const badge = async (spec: {
    courseId: string | null;
    name: string;
    description: string;
    icon: BadgeIcon;
    color: BadgeColor;
    criteria: BadgeCriteria;
    courseIds?: string[];
    by: string | undefined;
    created: number;
  }): Promise<BadgeRow> => {
    const row: BadgeRow = {
      id: newId(),
      courseId: spec.courseId,
      name: spec.name,
      description: spec.description,
      icon: spec.icon,
      color: spec.color,
      criteria: spec.criteria,
      criteriaCourseIds: JSON.stringify(spec.courseIds ?? []),
      createdBy: spec.by ?? null,
      createdAt: daysAgo(spec.created),
      updatedAt: daysAgo(spec.created),
    };
    await db.insertInto('badges').values(row).execute();
    return row;
  };
  const landingPro = await badge({
    courseId: web.id,
    name: 'Landing page pro',
    description: 'Built an outstanding, accessible personal landing page.',
    icon: 'rocket',
    color: 'sky',
    criteria: 'manual',
    by: id('maya.chen'),
    created: 18,
  });
  await badge({
    courseId: web.id,
    name: 'Web developer',
    description: 'Completed Modern Web Development, from HTML to a shipped React app.',
    icon: 'code',
    color: 'indigo',
    criteria: 'completion',
    by: id('maya.chen'),
    created: 20,
  });
  const hola = await badge({
    courseId: spanish.id,
    name: '¡Hola!',
    description: 'Finished the first unit of Spanish for Beginners.',
    icon: 'message-circle',
    color: 'gold',
    criteria: 'completion',
    by: id('daniel.okafor'),
    created: 13,
  });
  const helper = await badge({
    courseId: null,
    name: 'Community helper',
    description: 'Went out of their way to help classmates in the forums.',
    icon: 'heart',
    color: 'rose',
    criteria: 'manual',
    by: admin?.id,
    created: 25,
  });
  const explorer = await badge({
    courseId: null,
    name: 'Language explorer',
    description: 'Completed a language course on this site.',
    icon: 'globe',
    color: 'teal',
    criteria: 'courses',
    courseIds: [spanish.id],
    by: admin?.id,
    created: 25,
  });

  // Spanish for Beginners: Alex, Sofia and Mia have read the lesson; Alex also takes the quiz.
  const lessonDone: Array<[string, string]> = [
    ['alex.johnson', daysAgo(9, 18, 5)],
    ['sofia.martinez', daysAgo(12, 8, 40)],
    ['mia.garcia', daysAgo(11, 19, 15)],
  ];
  await db
    .insertInto('completions')
    .values(lessonDone.map(([who, at]) => ({ activityId: greetings.id, userId: id(who), courseId: spanish.id, completedAt: at })))
    .onConflict((oc) => oc.columns(['activityId', 'userId']).doNothing())
    .execute();
  const alexAttempt = await db
    .selectFrom('quizAttempts')
    .select('id')
    .where('activityId', '=', vocabulary.id)
    .where('userId', '=', id('alex.johnson'))
    .executeTakeFirst();
  if (!alexAttempt) {
    const questions = await loadQuizQuestions(db, vocabulary.id);
    const answers: Record<string, AttemptAnswer> = {};
    for (const [i, q] of questions.entries()) {
      const options = parseJson<StoredOption[]>(q.options, []);
      const accepted = parseJson<string[]>(q.acceptedAnswers, []);
      // One slip ("gracia") so the review shows a mistake.
      if (q.type === 'short') answers[q.id] = { text: i === 1 ? 'gracia' : (accepted[0] ?? '') };
      else answers[q.id] = { optionIds: options.filter((o) => o.correct).map((o) => o.id) };
    }
    const results = Object.fromEntries(questions.map((q) => [q.id, gradeQuestion(q, answers[q.id])]));
    const score = round(Object.values(results).reduce((sum, r) => sum + r.points, 0));
    const maxScore = round(questions.reduce((sum, q) => sum + q.points, 0));
    const startedAt = daysAgo(3, 17, 42);
    const finishedAt = daysAgo(3, 17, 51);
    await db
      .insertInto('quizAttempts')
      .values({
        id: newId(),
        activityId: vocabulary.id,
        courseId: spanish.id,
        userId: id('alex.johnson'),
        attemptNumber: 1,
        status: 'finished',
        questionOrder: JSON.stringify(questions.map((q) => q.id)),
        snapshot: JSON.stringify(questions.map((q) => snapshotFromRow(q))),
        answers: JSON.stringify(answers),
        results: JSON.stringify(results),
        score,
        maxScore,
        startedAt,
        deadlineAt: null,
        finishedAt,
      })
      .execute();
    await db
      .insertInto('grades')
      .values({
        activityId: vocabulary.id,
        userId: id('alex.johnson'),
        courseId: spanish.id,
        score: round(maxScore > 0 ? (score / maxScore) * (vocabulary.maxGrade ?? maxScore) : 0),
        feedback: null,
        gradedBy: null,
        gradedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .onConflict((oc) => oc.columns(['activityId', 'userId']).doNothing())
      .execute();
    await db
      .insertInto('completions')
      .values({ activityId: vocabulary.id, userId: id('alex.johnson'), courseId: spanish.id, completedAt: finishedAt })
      .onConflict((oc) => oc.columns(['activityId', 'userId']).doNothing())
      .execute();
  }

  // Everyone who now meets the criteria completed the course when they finished the last requirement.
  const settings = toCompletionSettings(await loadCompletionSettings(db, spanish.id));
  const required = requiredActivities(settings, await completionActivities(db, spanish.id)).map((a) => a.id);
  const finished = await db
    .selectFrom('completions')
    .select(['userId', (eb) => eb.fn.max('completedAt').as('at')])
    .where('courseId', '=', spanish.id)
    .where('activityId', 'in', required)
    .groupBy('userId')
    .execute();
  const notifications = [];
  for (const row of finished) {
    const at = String(row.at) > ts ? ts : String(row.at);
    const [completed] = await evaluateCompletion(quiet, spanish.id, [row.userId], { at, announce: false });
    if (!completed) continue;
    notifications.push({
      id: newId(),
      userId: completed,
      type: 'completion',
      title: `You completed ${spanish.title}`,
      body: 'Congratulations! Your certificate is ready to view and download.',
      link: `/courses/${spanish.slug}`,
      readAt: completed === id('alex.johnson') ? null : at,
      createdAt: at,
    });
    for (const b of [hola, explorer]) {
      notifications.push({
        id: newId(),
        userId: completed,
        type: 'badge',
        title: `You earned the “${b.name}” badge`,
        body: b.description,
        link: `/badges/${b.id}`,
        readAt: completed === id('alex.johnson') ? null : at,
        createdAt: at,
      });
    }
  }

  // Badges awarded by hand.
  const manual: Array<[BadgeRow, string, string | undefined, string, string]> = [
    [landingPro, 'alex.johnson', id('maya.chen'), 'Clean, semantic HTML and a great mobile layout.', daysAgo(2, 15, 10)],
    [landingPro, 'zara.ahmed', id('maya.chen'), 'Lovely use of grid areas.', daysAgo(2, 15, 12)],
    [landingPro, 'sofia.martinez', id('maya.chen'), 'A designer’s eye for detail.', daysAgo(2, 15, 14)],
    [helper, 'priya.raman', admin?.id, 'Answered dozens of forum questions.', daysAgo(15, 11)],
    [helper, 'sofia.martinez', admin?.id, 'Paired with classmates on the landing page.', daysAgo(15, 11, 5)],
    [helper, 'alex.johnson', admin?.id, 'Welcomed everyone in the Introductions forum.', daysAgo(6, 10)],
  ];
  for (const [b, who, by, note, at] of manual) {
    const awarded = await insertAwards(db, b, [id(who)], { awardedBy: by ?? null, note, at, restoreRevoked: true });
    if (awarded.length === 0) continue;
    notifications.push({
      id: newId(),
      userId: id(who),
      type: 'badge',
      title: `You earned the “${b.name}” badge`,
      body: b.description,
      link: `/badges/${b.id}`,
      readAt: Date.parse(at) < Date.now() - 4 * DAY ? at : null,
      createdAt: at,
    });
  }
  if (notifications.length) await db.insertInto('notifications').values(notifications).execute();
}
