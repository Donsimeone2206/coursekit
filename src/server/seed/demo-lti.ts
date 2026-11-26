/**
 * Demo data for External tools (LTI 1.3): one registered tool with placeholder tool.example URLs and
 * an External tool activity in UX Design Principles, so the admin and activity pages have something to
 * show. tool.example is not a real tool, so launching it doesn't reach anything. Works offline.
 */
import { DEFAULT_SETTINGS } from '../../shared/constants.js';
import type { AppDeps } from '../context.js';
import { newId, now } from '../lib/util.js';

export async function seedLtiDemo(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const { db } = deps;
  const course = await db.selectFrom('courses').select('id').where('slug', '=', 'ux-design-principles').executeTakeFirst();
  if (!course) return;
  const section = await db
    .selectFrom('sections')
    .select('id')
    .where('courseId', '=', course.id)
    .orderBy('position', 'asc')
    .executeTakeFirst();
  if (!section) return;
  const admin = await db.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('createdAt', 'asc').executeTakeFirst();
  const teacher = await db.selectFrom('users').select('id').where('email', '=', 'maya.chen@coursekit.test').executeTakeFirst();
  const ts = now();
  const toolId = newId();

  await db
    .insertInto('ltiTools')
    .values({
      id: toolId,
      name: 'Prototype studio (demo)',
      description: "A demo tool with placeholder tool.example addresses. It isn't a real tool, so launching it won't connect to anything.",
      toolUrl: 'https://tool.example/lti/launch',
      loginUrl: 'https://tool.example/lti/login',
      redirectUris: JSON.stringify(['https://tool.example/lti/launch']),
      jwksUrl: 'https://tool.example/.well-known/jwks.json',
      publicKey: null,
      deepLinkingUrl: 'https://tool.example/lti/deep-link',
      customParams: JSON.stringify({ workspace: 'ux-course' }),
      shareName: 1,
      shareEmail: 0,
      allowAgs: 1,
      allowNrps: 0,
      clientId: newId(20),
      deploymentId: newId(12),
      status: 'active',
      createdBy: admin?.id ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .execute();

  const max = await db
    .selectFrom('activities')
    .select((eb) => eb.fn.max('position').as('m'))
    .where('sectionId', '=', section.id)
    .executeTakeFirst();
  await db
    .insertInto('activities')
    .values({
      id: newId(),
      courseId: course.id,
      sectionId: section.id,
      type: 'lti',
      title: 'Prototype studio: sketch a sign-up flow',
      description:
        "Sketch a sign-up flow in the prototype studio and get a score back in the gradebook.\n\n**This is a demo:** the studio at tool.example isn't a real tool, so the launch button won't reach anything. An administrator can register a real LTI 1.3 tool under Administration → External tools.",
      position: max?.m == null ? 0 : Number(max.m) + 1,
      visible: 1,
      settings: JSON.stringify({ ...DEFAULT_SETTINGS.lti, toolId, launchUrl: 'https://tool.example/lti/launch?project=sign-up-flow' }),
      dueAt: null,
      maxGrade: 100,
      completion: 'none',
      createdBy: teacher?.id ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .execute();
}
