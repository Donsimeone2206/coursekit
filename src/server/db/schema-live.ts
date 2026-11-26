/**
 * Tables for live classes (migration 015_live_classes). Same conventions as schema.ts: 0/1 booleans,
 * ISO-8601 strings and JSON stored as text.
 */
import type { Generated, Selectable } from 'kysely';
import type { LiveProviderId } from '../../shared/live.js';

export interface LiveSessionsTable {
  id: string;
  activityId: string;
  courseId: string;
  seriesId: string | null;
  title: Generated<string>;
  agenda: Generated<string>;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timeZone: string | null;
  status: Generated<'scheduled' | 'cancelled'>;
  meetingUrl: string | null;
  sequence: Generated<number>;
  remindedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiveRoomsTable {
  id: string;
  /** null once the session is deleted (the worker then deletes the meeting at the provider). */
  sessionId: string | null;
  activityId: string | null;
  courseId: string | null;
  /** '' for the whole class, otherwise the group id. */
  groupKey: Generated<string>;
  groupId: string | null;
  provider: LiveProviderId;
  roomKey: string;
  externalId: string | null;
  runId: string | null;
  joinUrl: string | null;
  host: string | null;
  syncedHash: string | null;
  state: Generated<'active' | 'delete'>;
  syncError: string | null;
  syncAttempts: Generated<number>;
  nextSyncAt: string | null;
  claimId: string | null;
  claimedUntil: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastPolledAt: string | null;
  followUpCount: Generated<number>;
  nextFollowUpAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LivePresenceSource = 'join' | 'bbb' | 'bbb-analytics' | 'zoom' | 'zoom-report';

export interface LivePresenceTable {
  id: string;
  sessionId: string;
  roomId: string | null;
  groupKey: Generated<string>;
  userId: string | null;
  source: LivePresenceSource;
  sourceKey: string;
  name: string | null;
  role: 'moderator' | 'viewer' | null;
  joinedAt: string;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiveAttendanceTable {
  sessionId: string;
  userId: string;
  courseId: string;
  status: 'present' | 'absent';
  markedBy: string | null;
  markedAt: string;
}

export interface LiveRecordingsTable {
  id: string;
  sessionId: string;
  courseId: string;
  roomId: string | null;
  groupKey: Generated<string>;
  source: 'bbb' | 'zoom' | 'manual';
  externalId: string | null;
  title: string;
  url: string;
  passcode: string | null;
  durationMinutes: number | null;
  recordedAt: string | null;
  hidden: Generated<number>;
  removedAt: string | null;
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LiveSessionRow = Selectable<LiveSessionsTable>;
export type LiveRoomRow = Selectable<LiveRoomsTable>;
export type LivePresenceRow = Selectable<LivePresenceTable>;
export type LiveAttendanceRow = Selectable<LiveAttendanceTable>;
export type LiveRecordingRow = Selectable<LiveRecordingsTable>;
