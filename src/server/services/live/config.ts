/**
 * Site-wide live class settings, kept in the settings table under `live.` so every server process shares them:
 * one JSON value per provider, secrets included. Secrets never leave the server: the admin API only says whether
 * one is set. Also the internal secret that signs the per-room callback addresses given to BigBlueButton.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  BBB_CHECKSUM_ALGORITHMS,
  LIVE_PROVIDER_IDS,
  type BbbChecksumAlgorithm,
  type LiveAdminInput,
  type LiveAdminSettings,
  type LiveProviderId,
  type LiveProviderStatus,
  type LiveSettings,
  type ZoomConcurrentMeetings,
} from '../../../shared/live.js';
import type { DB } from '../../db/types.js';
import { randomToken } from '../../lib/util.js';

export interface BbbConfig {
  enabled: boolean;
  url: string;
  algorithm: BbbChecksumAlgorithm;
  secret: string | null;
  /** Ask for the learning analytics callback (and so meetingKeepEvents) when the site has a public URL. */
  analytics: boolean;
}

export interface ZoomConfig {
  enabled: boolean;
  accountId: string;
  clientId: string;
  clientSecret: string | null;
  webhookSecret: string | null;
  /** Email (or user id) of the Zoom user who hosts meetings unless a live class names another. */
  defaultHost: string;
  /** Other Zoom users an administrator shared: teachers can pick them, and any staff member of the class can start. */
  hosts: string[];
  /** Meetings one host can run at once (Zoom plan): more group rooms than this on one host can't all run. */
  concurrentMeetings: ZoomConcurrentMeetings;
}

export interface JitsiConfig {
  enabled: boolean;
  url: string;
  appId: string;
  appSecret: string | null;
}

export interface LiveConfig {
  bbb: BbbConfig;
  zoom: ZoomConfig;
  jitsi: JitsiConfig;
  link: { enabled: boolean };
}

export const DEFAULT_JITSI_URL = 'https://meet.jit.si';

const KEYS: Record<LiveProviderId, string> = { bbb: 'live.bbb', zoom: 'live.zoom', jitsi: 'live.jitsi', link: 'live.link' };
const SECRET_KEY = 'live.secret';

const DEFAULTS: LiveConfig = {
  bbb: { enabled: false, url: '', algorithm: 'sha1', secret: null, analytics: true },
  zoom: {
    enabled: false,
    accountId: '',
    clientId: '',
    clientSecret: null,
    webhookSecret: null,
    defaultHost: '',
    hosts: [],
    concurrentMeetings: 1,
  },
  jitsi: { enabled: false, url: DEFAULT_JITSI_URL, appId: '', appSecret: null },
  link: { enabled: true },
};

/** Secrets that sign tokens learners receive (Jitsi) should resist guessing offline. */
const MIN_SECRET_LENGTH = 32;

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const secret = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 50) : []);

function parse(key: string, rows: Map<string, string>): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(rows.get(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function loadLiveConfig(db: DB): Promise<LiveConfig> {
  const rows = new Map(
    (await db.selectFrom('settings').selectAll().where('key', 'in', Object.values(KEYS)).execute()).map((r) => [r.key, r.value]),
  );
  const bbb = parse(KEYS.bbb, rows);
  const zoom = parse(KEYS.zoom, rows);
  const jitsi = parse(KEYS.jitsi, rows);
  const link = parse(KEYS.link, rows);
  const algorithm = BBB_CHECKSUM_ALGORITHMS.find((a) => a === bbb.algorithm) ?? 'sha1';
  return {
    bbb: {
      enabled: bool(bbb.enabled, false),
      url: str(bbb.url, ''),
      algorithm,
      secret: secret(bbb.secret),
      analytics: bool(bbb.analytics, DEFAULTS.bbb.analytics),
    },
    zoom: {
      enabled: bool(zoom.enabled, false),
      accountId: str(zoom.accountId, ''),
      clientId: str(zoom.clientId, ''),
      clientSecret: secret(zoom.clientSecret),
      webhookSecret: secret(zoom.webhookSecret),
      defaultHost: str(zoom.defaultHost, ''),
      hosts: strings(zoom.hosts),
      concurrentMeetings: zoom.concurrentMeetings === 2 ? 2 : 1,
    },
    jitsi: {
      enabled: bool(jitsi.enabled, false),
      url: str(jitsi.url, DEFAULT_JITSI_URL) || DEFAULT_JITSI_URL,
      appId: str(jitsi.appId, ''),
      appSecret: secret(jitsi.appSecret),
    },
    link: { enabled: bool(link.enabled, DEFAULTS.link.enabled) },
  };
}

/** https, or http for a server on this machine (local testing). */
function isAllowedServerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'));
}

const serverUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || isAllowedServerUrl(v), 'Enter the server address, starting with https://');

const secretInput = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/** A secret that signs tokens learners receive: long enough that it can't be guessed from one of them offline. */
const tokenSecretInput = secretInput.refine(
  (v) => v == null || v.length >= MIN_SECRET_LENGTH,
  `Use a random secret of at least ${MIN_SECRET_LENGTH} characters`,
);

const plain = (max: number) => z.string().trim().max(max);

/** A meeting or recording link: https only, no credentials in it. */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Enter a link starting with https://')
  // Stored normalised (percent-encoded), so it can go in a Location header as it is.
  .transform((v) => new URL(v).toString());

/** An email address or a Zoom user id. */
export const zoomHostSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === '' || z.email().safeParse(v).success || /^[A-Za-z0-9_-]{6,64}$/.test(v), 'Enter the Zoom user’s email address');

/** Other Zoom hosts an administrator shares with teachers: one per entry, empty entries and repeats dropped. */
const zoomHostListSchema = z
  .array(zoomHostSchema)
  .max(50, 'Add at most 50 hosts')
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((host) => {
      const key = host.toLowerCase();
      if (!host || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const liveAdminInputSchema = z.object({
  bbb: z
    .object({
      enabled: z.boolean().optional(),
      url: serverUrl.optional(),
      algorithm: z.enum(BBB_CHECKSUM_ALGORITHMS as [BbbChecksumAlgorithm, ...BbbChecksumAlgorithm[]]).optional(),
      secret: secretInput,
      analytics: z.boolean().optional(),
    })
    .optional(),
  zoom: z
    .object({
      enabled: z.boolean().optional(),
      accountId: plain(200).optional(),
      clientId: plain(200).optional(),
      clientSecret: secretInput,
      webhookSecret: secretInput,
      defaultHost: zoomHostSchema.optional(),
      hosts: zoomHostListSchema.optional(),
      concurrentMeetings: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .optional(),
  jitsi: z
    .object({
      enabled: z.boolean().optional(),
      url: serverUrl.optional(),
      appId: plain(200).optional(),
      // Signs the token every learner gets: a short one could be guessed offline and used to sign moderator tokens.
      appSecret: tokenSecretInput,
    })
    .optional(),
  link: z.object({ enabled: z.boolean().optional() }).optional(),
}) satisfies z.ZodType<LiveAdminInput, unknown>;

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

function merge<T extends object>(current: T, patch: Patch<T> | undefined): T {
  const next = { ...current };
  if (!patch) return next;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

async function writeSetting(db: DB, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db
    .insertInto('settings')
    .values({ key, value: json })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: json }))
    .execute();
}

/** Applies an admin change: leave a field out to keep it; for secrets, a string replaces and null clears. */
export async function saveLiveConfig(db: DB, input: z.output<typeof liveAdminInputSchema>): Promise<LiveConfig> {
  const current = await loadLiveConfig(db);
  const next: LiveConfig = {
    bbb: merge(current.bbb, input.bbb),
    zoom: merge(current.zoom, input.zoom),
    jitsi: merge(current.jitsi, input.jitsi),
    link: merge(current.link, input.link),
  };
  if (!next.jitsi.url) next.jitsi.url = DEFAULT_JITSI_URL;
  for (const id of LIVE_PROVIDER_IDS) {
    if (input[id]) await writeSetting(db, KEYS[id], next[id]);
  }
  return next;
}

const NEEDS_PUBLIC_URL = 'Set the site’s public URL (COURSEKIT_PUBLIC_URL) and restart Coursekit';

/** Token authentication alone doesn't make Jitsi Meet take moderator rights from the token. */
const JITSI_TOKEN_NOTE =
  'Staff only become moderators if the Jitsi server takes moderator rights from the token: enable Prosody’s token_affiliation module on the conference component, and stop Jicofo from handing out moderator rights itself (turn off auto-owner, and don’t make every signed-in participant an owner). Otherwise the first person in, or everyone with a token, becomes a moderator, students included.';

/** Whether teachers can use a provider, and what an administrator should know about it. */
export function providerStatus(config: LiveConfig, id: LiveProviderId, publicUrl: string | null): LiveProviderStatus {
  const off = (problem: string | null = null): LiveProviderStatus => ({ ready: false, problem, note: null });
  switch (id) {
    case 'bbb': {
      const c = config.bbb;
      if (!c.enabled) return off();
      if (!c.url || !c.secret) return off('Add the server URL and the shared secret.');
      const notes: string[] = [];
      if (!publicUrl) {
        notes.push(
          `${NEEDS_PUBLIC_URL} so BigBlueButton can send recordings${c.analytics ? ' and attendance' : ''} back when a class ends. Until then Coursekit asks BigBlueButton for them every few minutes, and attendance comes from what it sees while the class runs.`,
        );
      }
      if (c.secret.length < MIN_SECRET_LENGTH) {
        notes.push(
          `The shared secret is short. The join links learners get are signed with it, so use a random secret of at least ${MIN_SECRET_LENGTH} characters (bbb-conf --setsecret on the server), then enter it here.`,
        );
      }
      return { ready: true, problem: null, note: notes.join(' ') || null };
    }
    case 'zoom': {
      const c = config.zoom;
      if (!c.enabled) return off();
      if (!c.accountId || !c.clientId || !c.clientSecret)
        return off('Add the account ID, client ID and client secret of a Server-to-Server OAuth app.');
      if (!c.defaultHost) return off('Add the default host: the email of the Zoom user who hosts meetings.');
      const report =
        'Without webhooks, attendance comes from Zoom’s participant report after each meeting (it needs a paid Zoom plan and the report scope).';
      return {
        ready: true,
        problem: null,
        note: !publicUrl
          ? `${NEEDS_PUBLIC_URL} to receive Zoom webhooks. ${report}`
          : !c.webhookSecret
            ? `Add the webhook secret token to receive Zoom webhooks. ${report}`
            : null,
      };
    }
    case 'jitsi': {
      const c = config.jitsi;
      if (!c.enabled) return off();
      if (!!c.appId !== !!c.appSecret) return off('Add both the app ID and the app secret for token authentication, or leave both empty.');
      if (c.appSecret && c.appSecret.length < MIN_SECRET_LENGTH) {
        return off(
          `Replace the app secret with a random one of at least ${MIN_SECRET_LENGTH} characters: every learner gets a token signed with it, so a short one can be guessed.`,
        );
      }
      return { ready: true, problem: null, note: c.appSecret ? JITSI_TOKEN_NOTE : null };
    }
    case 'link':
      return config.link.enabled ? { ready: true, problem: null, note: null } : off();
  }
}

/** What the admin page shows. Secrets only as "set" or "not set". */
export function toLiveAdminSettings(
  config: LiveConfig,
  publicUrl: string | null,
  usage: Record<LiveProviderId, number>,
): LiveAdminSettings {
  const base = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  return {
    publicUrl: base,
    bbb: {
      enabled: config.bbb.enabled,
      url: config.bbb.url,
      algorithm: config.bbb.algorithm,
      secretSet: !!config.bbb.secret,
      analytics: config.bbb.analytics,
      ...providerStatus(config, 'bbb', base),
    },
    zoom: {
      enabled: config.zoom.enabled,
      accountId: config.zoom.accountId,
      clientId: config.zoom.clientId,
      clientSecretSet: !!config.zoom.clientSecret,
      webhookSecretSet: !!config.zoom.webhookSecret,
      defaultHost: config.zoom.defaultHost,
      hosts: config.zoom.hosts,
      concurrentMeetings: config.zoom.concurrentMeetings,
      ...providerStatus(config, 'zoom', base),
    },
    jitsi: {
      enabled: config.jitsi.enabled,
      url: config.jitsi.url,
      appId: config.jitsi.appId,
      appSecretSet: !!config.jitsi.appSecret,
      ...providerStatus(config, 'jitsi', base),
    },
    link: { enabled: config.link.enabled, ...providerStatus(config, 'link', base) },
    zoomWebhookUrl: base ? `${base}/live/zoom/webhook` : null,
    usage,
  };
}

/** The site's public URL without a trailing slash, or null. */
export function publicBase(publicUrl: string | null): string | null {
  return publicUrl ? publicUrl.replace(/\/+$/, '') : null;
}

// ---- Zoom hosts -----------------------------------------------------------------------------------------

/** Zoom users are named by email (or user id), compared without case. */
export function sameZoomHost(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The default host and the hosts an administrator added: shared, so any staff member of a class they host may start it. */
export function isSharedZoomHost(zoom: Pick<ZoomConfig, 'defaultHost' | 'hosts'>, host: string): boolean {
  return sameZoomHost(host, zoom.defaultHost) || zoom.hosts.some((h) => sameZoomHost(h, host));
}

/** Who hosts a room's Zoom meeting: the group's own host, the class's, or the site's default host ('' when none is set). */
export function zoomHostFor(
  zoom: Pick<ZoomConfig, 'defaultHost'>,
  settings: Pick<LiveSettings, 'zoomHost' | 'zoomGroupHosts'>,
  groupKey: string,
): string {
  return (groupKey && settings.zoomGroupHosts?.[groupKey]) || settings.zoomHost || zoom.defaultHost;
}

/**
 * Whether a staff member gets the start link of a meeting. It carries the host's Zoom access key and starts the
 * meeting as that Zoom user, so only for a shared host or for the host themselves (their Coursekit email).
 */
export function zoomCanStart(zoom: Pick<ZoomConfig, 'defaultHost' | 'hosts'>, host: string, email: string): boolean {
  return !!host && (isSharedZoomHost(zoom, host) || sameZoomHost(host, email));
}

// ---- callback addresses -----------------------------------------------------------------------------

const secretCache = new WeakMap<DB, Promise<Buffer>>();

/** Coursekit's own secret for live class callback tokens, created on first use (the first insert wins). */
export function liveSecret(db: DB): Promise<Buffer> {
  let promise = secretCache.get(db);
  if (!promise) {
    promise = (async () => {
      const read = async () => {
        const row = await db.selectFrom('settings').select('value').where('key', '=', SECRET_KEY).executeTakeFirst();
        try {
          const value: unknown = row ? JSON.parse(row.value) : null;
          return typeof value === 'string' && value.length >= 43 ? value : null;
        } catch {
          return null;
        }
      };
      let value = await read();
      if (!value) {
        await db
          .insertInto('settings')
          .values({ key: SECRET_KEY, value: JSON.stringify(randomToken(32)) })
          .onConflict((oc) => oc.column('key').doNothing())
          .execute();
        value = await read();
      }
      if (!value) throw new Error('Could not create the live class secret.');
      return Buffer.from(value, 'base64url');
    })();
    promise.catch(() => secretCache.delete(db));
    secretCache.set(db, promise);
  }
  return promise;
}

export type CallbackPurpose = 'bbb-ended' | 'bbb-recording' | 'bbb-analytics';

function mac(key: Buffer, purpose: CallbackPurpose, roomId: string): string {
  return createHmac('sha256', key).update(`coursekit-live:${purpose}:${roomId}`).digest('base64url');
}

/** `<roomId>.<signature>`: names the room and proves Coursekit made the address. Stable, so repeated creates match. */
export async function signRoomToken(db: DB, roomId: string, purpose: CallbackPurpose): Promise<string> {
  return `${roomId}.${mac(await liveSecret(db), purpose, roomId)}`;
}

/** The room id of a valid token, or null. */
export async function verifyRoomToken(db: DB, token: string, purpose: CallbackPurpose): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 200) return null;
  const at = token.indexOf('.');
  if (at < 1) return null;
  const roomId = token.slice(0, at);
  if (!/^[0-9a-z]{8,40}$/.test(roomId)) return null;
  const given = Buffer.from(token.slice(at + 1));
  const expected = Buffer.from(mac(await liveSecret(db), purpose, roomId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? roomId : null;
}
