/**
 * Tables for SCORM and xAPI content packages (migration 008_packages).
 * Same conventions as schema.ts: 0/1 booleans, ISO-8601 strings and JSON stored as text.
 */
import type { Selectable } from 'kysely';
import type { PackageKind } from '../../shared/packages.js';

/** One uploaded version of a package activity's content. The newest version is the current one. */
export interface PackageVersionsTable {
  id: string;
  activityId: string;
  courseId: string;
  /** 1, 2, 3... per activity. */
  version: number;
  kind: PackageKind;
  /** SCORM 2004 edition: '2nd', '3rd' or '4th'. */
  edition: string | null;
  title: string;
  fileName: string;
  /** JSON PackageStructure: the table of contents and launch details. */
  structure: string;
  fileCount: number;
  totalBytes: number;
  /** Storage key prefix of the extracted files, ending with '/'. */
  storagePrefix: string;
  uploadedBy: string | null;
  createdAt: string;
}

export interface PackageFilesTable {
  versionId: string;
  /** Path inside the package, with '/' separators. */
  path: string;
  size: number;
}

/** A learner's attempt at a package activity. */
export interface PackageAttemptsTable {
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  versionId: string;
  attemptNumber: number;
  /** UUID; the xAPI registration of the attempt. */
  registration: string;
  status: 'in_progress' | 'finished';
  completionStatus: 'not attempted' | 'incomplete' | 'completed';
  successStatus: 'unknown' | 'passed' | 'failed';
  /** 0..1, null while nothing reported a score. */
  score: number | null;
  totalSeconds: number;
  lastItemId: string | null;
  startedAt: string;
  lastAccessedAt: string;
  finishedAt: string | null;
}

/** Run-time data of one SCO (or launched asset) within an attempt. */
export interface PackageScoStatesTable {
  attemptId: string;
  itemId: string;
  /** JSON { values, counts }: the data model elements the SCO wrote. */
  data: string;
  completionStatus: 'not attempted' | 'incomplete' | 'completed';
  successStatus: 'unknown' | 'passed' | 'failed';
  score: number | null;
  totalSeconds: number;
  lastExit: string | null;
  sessions: number;
  sessionId: string | null;
  seq: number;
  terminatedSessionId: string | null;
  sessionSeconds: number;
  updatedAt: string;
}

export interface XapiStatementsTable {
  /** The statement id (a lower-case UUID). */
  id: string;
  activityId: string;
  courseId: string;
  userId: string;
  attemptId: string | null;
  registration: string | null;
  verbId: string;
  objectId: string | null;
  voided: number;
  /** Set on voiding statements: the statement they void. */
  voidsId: string | null;
  /** The stored statement as JSON. */
  statement: string;
  timestamp: string;
  stored: string;
}

export interface XapiDocumentsTable {
  id: string;
  activityId: string;
  kind: 'state' | 'activity_profile' | 'agent_profile';
  ownerId: string;
  activityIri: string;
  registration: string;
  docId: string;
  contentType: string;
  /** base64 of the document bytes. */
  content: string;
  etag: string;
  updatedAt: string;
}

export type PackageVersionRow = Selectable<PackageVersionsTable>;
export type PackageAttemptRow = Selectable<PackageAttemptsTable>;
export type PackageScoStateRow = Selectable<PackageScoStatesTable>;
export type XapiStatementRow = Selectable<XapiStatementsTable>;
export type XapiDocumentRow = Selectable<XapiDocumentsTable>;
