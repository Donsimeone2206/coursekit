/**
 * Live classes: scheduled online classes with BigBlueButton, Zoom, Jitsi Meet or any meeting link.
 * Shapes and constants shared by the server and the web UI.
 */
import type { GroupChoice, GroupMode, GroupRef, PublicUser } from './types.js';

/** How a live class meets. More providers can be added behind the same interface on the server. */
export type LiveProviderId = 'bbb' | 'zoom' | 'jitsi' | 'link';

export const LIVE_PROVIDER_IDS: readonly LiveProviderId[] = ['bbb', 'zoom', 'jitsi', 'link'];

export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
  bbb: 'BigBlueButton',
  zoom: 'Zoom',
  jitsi: 'Jitsi Meet',
  link: 'Meeting link',
};

export const LIVE_PROVIDER_DESCRIPTIONS: Record<LiveProviderId, string> = {
  bbb: 'A virtual classroom with a whiteboard, breakout rooms and recordings.',
  zoom: "Meetings created in your school's Zoom account.",
  jitsi: 'Video meetings that open in the browser.',
  link: 'Google Meet, Microsoft Teams, Webex or any other meeting link.',
};

/** Checksum algorithms BigBlueButton accepts. SHA-1 works with every version; the others need 2.5 or later. */
export type BbbChecksumAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';
export const BBB_CHECKSUM_ALGORITHMS: readonly BbbChecksumAlgorithm[] = ['sha1', 'sha256', 'sha384', 'sha512'];

/** `off`: no recording; `manual`: moderators start and stop it; `auto`: it starts with the class. */
export type LiveRecordingMode = 'off' | 'manual' | 'auto';

/** Settings of a Live class activity. */
export interface LiveSettings {
  provider: LiveProviderId | null;
  /** Students can join this many minutes before a session starts. Staff can start at any time. */
  joinMinutesBefore: number;
  /** Learners get a reminder this many minutes before each session; null sends none. */
  reminderMinutes: number | null;
  /** BigBlueButton and Zoom: students wait until a teacher has started the class. */
  waitForModerator: boolean;
  /** BigBlueButton and Zoom. */
  recording: LiveRecordingMode;
  /** Automatic completion: attend at least this many sessions. */
  attendanceRequired: number;
  /** BigBlueButton: shown in the chat when people join. */
  welcomeMessage: string;
  /** Meeting link: the link for every session that has none of its own. Only staff see it. */
  meetingUrl: string | null;
  /**
   * Zoom: the email of the Zoom user who hosts this class's meetings; null uses the site's default host. Teachers can
   * pick the default host, a host an administrator added, or their own Zoom account. Only people who edit the class see it.
   */
  zoomHost: string | null;
  /**
   * Zoom with a room per group: a host for each group's room (group id → email), since a Zoom user can only host one
   * or two meetings at a time. Groups without one use `zoomHost`. Only people who edit the class see it.
   */
  zoomGroupHosts: Record<string, string>;
  /** Jitsi Meet on a self-hosted server: show the meeting inside the page instead of a new tab. */
  embed: boolean;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  provider: null,
  joinMinutesBefore: 10,
  reminderMinutes: 15,
  waitForModerator: true,
  recording: 'manual',
  attendanceRequired: 1,
  welcomeMessage: '',
  meetingUrl: null,
  zoomHost: null,
  zoomGroupHosts: {},
  embed: false,
};

export const LIVE_LIMITS = {
  /** Sessions one repeat can create. */
  maxRepeat: 100,
  /** Sessions in one live class. */
  maxSessions: 300,
  minDuration: 5,
  maxDuration: 720,
  maxJoinMinutesBefore: 120,
  maxReminderMinutes: 1440,
} as const;

export const REMINDER_CHOICES: readonly number[] = [5, 10, 15, 30, 60, 1440];

/** What a teacher sees about a provider that is set up on the site. */
export interface LiveProviderOption {
  id: LiveProviderId;
  label: string;
  description: string;
  /** Recordings come from the provider (BigBlueButton, Zoom). Links can be added by hand for any provider. */
  recordings: boolean;
  /** The "wait for a teacher" setting applies. */
  waitForModerator: boolean;
  /** Can be shown inside the page (self-hosted Jitsi Meet). */
  embeddable: boolean;
  /** Separate rooms for each group. */
  groupRooms: boolean;
  /** Zoom: the site's default host. */
  defaultHost?: string | null;
  /** Zoom: the hosts teachers can pick (the default host first, then the ones an administrator added). */
  hosts?: string[];
  /** Zoom: how many meetings one host can run at once on the site's Zoom plan. */
  concurrentMeetings?: number;
}

/** `upcoming`: not open yet; `open`: students can join, it hasn't started; `live`: under way; `ended`; `cancelled`. */
export type LiveSessionState = 'upcoming' | 'open' | 'live' | 'ended' | 'cancelled';

/** A room of a session: the whole class, or one group's room in a live class with groups. */
export interface LiveRoom {
  /** null: the whole class. */
  groupId: string | null;
  groupName: string | null;
  /** One of the viewer's own groups (or the whole class). */
  mine: boolean;
  /** The viewer takes part in this room: their own group's, or any group's for staff who can access all groups. */
  joinable: boolean;
  /** The viewer may join (or, staff, start) this room now. */
  canJoin: boolean;
  /** Opens the room in a new tab (a Coursekit address that checks access and redirects). Null when it can't be joined. */
  joinUrl: string | null;
  /**
   * Staff in a Zoom class: whether joinUrl starts the meeting as its host. False when the meeting's host is another
   * Zoom user (not a host an administrator shared), so the viewer joins as a participant.
   */
  canStart?: boolean;
  /** Staff: open the room as a participant instead of starting it as the host (Zoom). */
  participantUrl?: string | null;
}

export interface LiveRecording {
  id: string;
  sessionId: string;
  groupId: string | null;
  groupName: string | null;
  title: string;
  url: string;
  /** Zoom: the passcode to watch the recording. */
  passcode: string | null;
  durationMinutes: number | null;
  recordedAt: string | null;
  source: 'bbb' | 'zoom' | 'manual';
  /** Staff only: hidden recordings aren't shown to learners. */
  hidden?: boolean;
}

/** A learner's own attendance for one session. */
export interface LiveMyAttendance {
  status: 'present' | 'absent' | null;
  joinedAt: string | null;
  minutes: number | null;
  /** Set by a teacher. */
  marked: boolean;
}

export interface LiveSession {
  id: string;
  seriesId: string | null;
  title: string;
  agenda: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  /** The IANA time zone it was scheduled in. */
  timeZone: string | null;
  status: 'scheduled' | 'cancelled';
  state: LiveSessionState;
  /** When students can join. */
  joinOpensAt: string;
  rooms: LiveRoom[];
  /** The viewer can join at least one room right now. */
  canJoin: boolean;
  /** Why the viewer can't join, when that is worth saying. */
  joinNote: string | null;
  recordings: LiveRecording[];
  /** Learners: their own attendance, once the session has started. */
  attendance?: LiveMyAttendance;
  /** Staff: people present out of the students it applies to, once the session has started. */
  attendanceSummary?: { present: number; total: number };
  /** Staff: this session's own meeting link (Meeting link provider). */
  meetingUrl?: string | null;
  /** Staff: the provider could not set up a meeting for this session. */
  syncError?: string | null;
  /** Calendar file for this session. */
  icsUrl: string;
}

export interface LiveClassInfo {
  activityId: string;
  provider: LiveProviderId | null;
  providerLabel: string | null;
  /** The provider is set up, so sessions can be joined. */
  ready: boolean;
  problem: string | null;
  /** Staff: something about the class's setup that will get in the way (Zoom group rooms sharing one host). */
  warning: string | null;
  /** May schedule, edit and cancel sessions. */
  canManage: boolean;
  /** Staff: may start sessions, take attendance and manage recordings. */
  canModerate: boolean;
  groupMode: GroupMode;
  /** The viewer's own groups in the course. */
  myGroups: GroupRef[];
  /** Jitsi Meet on a self-hosted server shown inside the page. */
  embed: boolean;
  /** The provider can end a session for everyone. */
  canEndForEveryone: boolean;
  joinMinutesBefore: number;
  sessions: LiveSession[];
  /** Learners with automatic completion: sessions needed and sessions attended. */
  completion: { required: number; attended: number } | null;
  /** Calendar file with every session. */
  icsUrl: string;
  /** Server clock, so countdowns don't depend on the device's clock. */
  serverTime: string;
}

/** Body of POST /api/live/activities/:id/sessions. */
export interface LiveScheduleInput {
  /** First session (ISO). */
  startsAt: string;
  durationMinutes: number;
  title?: string;
  agenda?: string;
  /** Meeting link provider: the link for these sessions (leave empty to use the class's link). */
  meetingUrl?: string | null;
  /** The browser's IANA time zone. Repeats keep the same local time in it across daylight saving changes. */
  timeZone: string;
  repeat?: { frequency: 'daily' | 'weekly'; count: number } | null;
}

/** Body of PATCH /api/live/sessions/:id. */
export interface LiveSessionUpdate {
  startsAt?: string;
  durationMinutes?: number;
  title?: string;
  agenda?: string;
  meetingUrl?: string | null;
  timeZone?: string;
}

/** One person in a session's attendance list (staff). */
export interface LiveAttendanceRow {
  user: PublicUser & { email: string };
  groups: GroupRef[];
  status: 'present' | 'absent';
  /** Where the status comes from: a teacher's mark, the provider's attendance, or Coursekit's join log. */
  source: 'manual' | 'provider' | 'join' | null;
  /** A teacher's mark, if any. */
  marked: 'present' | 'absent' | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** Time in the class, when the provider reports it. */
  minutes: number | null;
}

/** People the provider saw who aren't participants of the course (guests, or names that didn't match anyone). */
export interface LiveGuestRow {
  name: string;
  joinedAt: string | null;
  minutes: number | null;
}

export interface LiveSessionAttendance {
  sessionId: string;
  rows: LiveAttendanceRow[];
  guests: LiveGuestRow[];
  groupChoice: GroupChoice;
  /** Where the times come from, in a sentence. */
  sourceNote: string;
  /** Attendance can be marked by hand (the session has started). */
  canMark: boolean;
}

export interface LiveBbbAdmin {
  enabled: boolean;
  url: string;
  algorithm: BbbChecksumAlgorithm;
  secretSet: boolean;
  /**
   * Ask BigBlueButton for its learning analytics when a class ends (exact join and leave times). BigBlueButton then
   * keeps each meeting's events on its server (meetingKeepEvents), which it doesn't delete by itself.
   */
  analytics: boolean;
}

/** Meetings one Zoom user can host at once: 1 on Basic and Pro plans, 2 on Business, Education and Enterprise. */
export type ZoomConcurrentMeetings = 1 | 2;

export interface LiveZoomAdmin {
  enabled: boolean;
  accountId: string;
  clientId: string;
  clientSecretSet: boolean;
  webhookSecretSet: boolean;
  defaultHost: string;
  /** Other Zoom users teachers can pick as a class's (or a group's) host. Any staff member of such a class can start it. */
  hosts: string[];
  concurrentMeetings: ZoomConcurrentMeetings;
}

export interface LiveJitsiAdmin {
  enabled: boolean;
  url: string;
  appId: string;
  appSecretSet: boolean;
}

export interface LiveProviderStatus {
  /** Turned on and every required value is set. */
  ready: boolean;
  /** What is missing before teachers can use it. */
  problem: string | null;
  /** What works differently, e.g. without the site's public URL callbacks and webhooks can't reach Coursekit. */
  note: string | null;
}

/** GET /api/admin/live */
export interface LiveAdminSettings {
  publicUrl: string | null;
  bbb: LiveBbbAdmin & LiveProviderStatus;
  zoom: LiveZoomAdmin & LiveProviderStatus;
  jitsi: LiveJitsiAdmin & LiveProviderStatus;
  link: { enabled: boolean } & LiveProviderStatus;
  /** The address to copy into the Zoom app's event subscription; null without a public URL. */
  zoomWebhookUrl: string | null;
  /** Live classes using each provider. */
  usage: Record<LiveProviderId, number>;
}

/** PUT /api/admin/live. Secrets: leave out to keep, a string replaces, null clears. */
export interface LiveAdminInput {
  bbb?: { enabled?: boolean; url?: string; algorithm?: BbbChecksumAlgorithm; secret?: string | null; analytics?: boolean };
  zoom?: {
    enabled?: boolean;
    accountId?: string;
    clientId?: string;
    clientSecret?: string | null;
    webhookSecret?: string | null;
    defaultHost?: string;
    hosts?: string[];
    concurrentMeetings?: ZoomConcurrentMeetings;
  };
  jitsi?: { enabled?: boolean; url?: string; appId?: string; appSecret?: string | null };
  link?: { enabled?: boolean };
}

/** Where a session stands at `now`, for a viewer. Shared so the server and the page agree. */
export function liveSessionState(
  session: { status: 'scheduled' | 'cancelled'; startsAt: string; endsAt: string },
  joinMinutesBefore: number,
  now: number,
): LiveSessionState {
  if (session.status === 'cancelled') return 'cancelled';
  const start = Date.parse(session.startsAt);
  const end = Date.parse(session.endsAt);
  if (now >= end) return 'ended';
  if (now >= start) return 'live';
  if (now >= start - joinMinutesBefore * 60_000) return 'open';
  return 'upcoming';
}
