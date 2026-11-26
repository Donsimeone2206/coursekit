/**
 * The Live class activity type: its settings schema and the checks registered in services/activity-types.ts.
 * Kept free of other live class modules (only config.ts), so the activity type registry has no import cycles.
 */
import { z } from 'zod';
import { LIVE_LIMITS, LIVE_PROVIDER_IDS, LIVE_PROVIDER_LABELS, type LiveProviderId, type LiveSettings } from '../../../shared/live.js';
import type { UserRow } from '../../db/schema.js';
import type { DB } from '../../db/types.js';
import { badRequest } from '../../lib/http.js';
import {
  httpsUrlSchema,
  isSharedZoomHost,
  loadLiveConfig,
  providerStatus,
  sameZoomHost,
  zoomHostSchema,
  type LiveConfig,
} from './config.js';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Groups without a host of their own are left out (an empty field in the form). */
const dropEmptyHosts = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, host]) => !(typeof host === 'string' && host.trim() === '')),
      )
    : v;

export const liveSettingsSchema = z.object({
  provider: z
    .enum(LIVE_PROVIDER_IDS as [LiveProviderId, ...LiveProviderId[]])
    .nullable()
    .default(null),
  joinMinutesBefore: z.number().int().min(0).max(LIVE_LIMITS.maxJoinMinutesBefore).default(10),
  reminderMinutes: z.number().int().min(1).max(LIVE_LIMITS.maxReminderMinutes).nullable().default(15),
  waitForModerator: z.boolean().default(true),
  recording: z.enum(['off', 'manual', 'auto']).default('manual'),
  attendanceRequired: z.number().int().min(1).max(LIVE_LIMITS.maxSessions).default(1),
  welcomeMessage: z.string().max(2000).default(''),
  meetingUrl: z.preprocess(emptyToNull, httpsUrlSchema.nullable()).default(null),
  zoomHost: z.preprocess(emptyToNull, zoomHostSchema.nullable()).default(null),
  zoomGroupHosts: z
    .preprocess(
      dropEmptyHosts,
      z
        .record(z.string().min(1).max(40), zoomHostSchema)
        .refine((hosts) => Object.keys(hosts).length <= 200, 'Set hosts for at most 200 groups'),
    )
    .default({}),
  embed: z.boolean().default(false),
}) satisfies z.ZodType<LiveSettings, unknown>;

/** Who is saving the class, and its settings before (null for a new class): see ActivityValidateContext. */
export interface LiveValidateContext {
  user: Pick<UserRow, 'email' | 'role'> | null;
  previous: LiveSettings | null;
}

/** The provider must be set up on the site (teachers only see those), and Zoom hosts must be ones the teacher may use. */
export async function validateLiveSettings(
  db: DB,
  courseId: string,
  settings: LiveSettings,
  context: LiveValidateContext = { user: null, previous: null },
): Promise<void> {
  const config = await loadLiveConfig(db);
  // Checked whatever the provider, so a host saved while the class used another provider was checked too.
  await assertZoomHosts(db, config, courseId, settings, context);
  if (!settings.provider) return;
  if (!providerStatus(config, settings.provider, null).ready) {
    throw badRequest(
      `${LIVE_PROVIDER_LABELS[settings.provider]} isn’t set up on this site. Pick another way to meet, or ask an administrator to set it up under Administration → Live classes.`,
    );
  }
}

/**
 * Staff get the start link of a class's Zoom meetings, which starts the meeting as its host with that Zoom user's
 * access key. So a teacher may only name the site's default host, a host an administrator added, or their own Zoom
 * account (the email of their instructor account). Administrators may name anyone. Hosts that didn't change pass,
 * so other teachers of the class can still save it.
 */
async function assertZoomHosts(
  db: DB,
  config: LiveConfig,
  courseId: string,
  settings: LiveSettings,
  { user, previous }: LiveValidateContext,
): Promise<void> {
  const changed: string[] = [];
  if (settings.zoomHost && !sameZoomHost(settings.zoomHost, previous?.zoomHost)) changed.push(settings.zoomHost);
  const newGroups = Object.entries(settings.zoomGroupHosts).filter(
    ([groupId, host]) => !sameZoomHost(host, previous?.zoomGroupHosts?.[groupId]),
  );
  for (const [, host] of newGroups) changed.push(host);
  if (newGroups.length) {
    // Hosts for groups of this course only. Hosts kept for groups deleted since are ignored.
    const ids = newGroups.map(([groupId]) => groupId);
    const known = await db.selectFrom('courseGroups').select('id').where('courseId', '=', courseId).where('id', 'in', ids).execute();
    if (known.length !== new Set(ids).size) throw badRequest('zoomGroupHosts: that group isn’t in this course.');
  }
  if (user?.role === 'admin') return;
  const self = user?.role === 'instructor' ? user.email : null;
  for (const host of changed) {
    if (isSharedZoomHost(config.zoom, host) || sameZoomHost(host, self)) continue;
    const choices = [
      config.zoom.defaultHost ? `the default host (${config.zoom.defaultHost})` : null,
      config.zoom.hosts.length ? 'a host an administrator added under Administration → Live classes' : null,
      self ? `your own Zoom account (${self})` : null,
    ].filter((choice): choice is string => !!choice);
    const pick = choices.length > 1 ? `${choices.slice(0, -1).join(', ')} or ${choices.at(-1)}` : choices[0];
    throw badRequest(`${host} isn’t one of this site’s Zoom hosts. ${pick ? `Pick ${pick}, or ask` : 'Ask'} an administrator to add it.`);
  }
}

/** Learners and teaching assistants don't see the class's meeting link or its Zoom hosts. */
export function publicLiveSettings(settings: LiveSettings): LiveSettings {
  return { ...settings, meetingUrl: null, zoomHost: null, zoomGroupHosts: {} };
}
