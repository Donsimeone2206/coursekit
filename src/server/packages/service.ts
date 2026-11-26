/**
 * SCORM and xAPI package activities: importing uploaded zips, attempts, launching, run-time commits,
 * grades (through upsertGrade) and completion (through markCompleted), and the staff report.
 */
import { randomUUID } from 'node:crypto';
import { whereInScope, type StudentScope } from '../services/group-modes.js';
import type {
  PackageAttemptInfo,
  PackageCompletionStatus,
  PackageItemProgress,
  PackageKind,
  PackageLaunch,
  PackageLaunchInput,
  PackagePlayerInfo,
  PackageReport,
  PackageSuccessStatus,
  PackageVersionInfo,
} from '../../shared/packages.js';
import type { PackageSettings } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { ActivityRow, UserRow } from '../db/schema.js';
import type { PackageAttemptRow, PackageScoStateRow, PackageVersionRow } from '../db/schema-packages.js';
import type { DB } from '../db/types.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { newId, now, parseJson, randomToken, round } from '../lib/util.js';
import type { ActivityAccess } from '../services/access.js';
import { parseSettings } from '../services/activity-types.js';
import { upsertGrade } from '../services/grades.js';
import { markCompleted } from '../services/progress.js';
import { launchCmi5 } from './cmi5/launch.js';
import { cmi5AttemptResult } from './cmi5/results.js';
import { cmi5Of, parseCmi5, standaloneCmi5 } from './cmi5/structure.js';
import { parseScormManifest, parseTincan, type PackageStructure, type StructureItem } from './manifest.js';
import { mimeFor } from './mime.js';
import { createModel, type ModelInit, type RuntimeBoot, type ScormVersion } from './runtime.js';
import {
  refreshSequencedAttempt,
  runtimeReport,
  sequencedBoot,
  sequencedCommit,
  sequencedLaunch,
  sequencedRuntime,
  sequencedSummary,
  type SequencedRuntime,
} from './sequencing/service.js';
import { packageSecret, signToken, type PackageToken, type TokenPurpose } from './tokens.js';
import { DEFAULT_MAX_FILES, extractEntry, PackageError, readZipEntries } from './zip.js';

type Deps = Pick<AppDeps, 'db' | 'events' | 'storage' | 'config'>;

/** Most bytes the run-time data of one SCO may take (suspend data, interactions, objectives...). */
export const MAX_SCO_STATE_BYTES = 512 * 1024;
export const CONTENT_PREFIX = '/content/';

// ----- time formats -----

export function parseDuration(value: string | undefined, version: ScormVersion): number {
  if (!value) return 0;
  if (version === '1.2') {
    const m = /^(\d{2,4}):(\d{2}):(\d{2}(?:\.\d{1,2})?)$/.exec(value);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  }
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + s;
}

export function formatDuration(seconds: number, version: ScormVersion): string {
  const total = Math.max(0, Math.round(seconds * 100) / 100);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = round(total % 60, 2);
  if (version === '1.2') {
    const [whole, frac] = s.toFixed(2).split('.') as [string, string];
    return `${String(Math.min(h, 9999)).padStart(4, '0')}:${String(m).padStart(2, '0')}:${whole.padStart(2, '0')}${frac === '00' ? '' : `.${frac}`}`;
  }
  return `PT${h}H${m}M${s}S`;
}

// ----- versions -----

export function structureOf(version: PackageVersionRow): PackageStructure {
  return parseJson<PackageStructure>(version.structure, {
    kind: version.kind,
    edition: null,
    title: version.title,
    items: [],
    activityId: null,
  });
}

export function toVersionInfo(version: PackageVersionRow): PackageVersionInfo {
  const structure = structureOf(version);
  return {
    id: version.id,
    version: version.version,
    kind: version.kind,
    edition: version.edition,
    title: version.title,
    fileName: version.fileName,
    fileCount: version.fileCount,
    totalBytes: version.totalBytes,
    createdAt: version.createdAt,
    // SCORM 2004 items with isvisible="false" stay in the activity tree but not in the table of contents.
    items: structure.items
      .filter((i) => i.visible !== false)
      .map(({ id, title, depth, launchable, sco }) => ({ id, title, depth, launchable, sco })),
    ...(structure.warnings?.length ? { warnings: structure.warnings } : {}),
  };
}

export async function currentVersion(db: DB, activityId: string): Promise<PackageVersionRow | undefined> {
  return db.selectFrom('packageVersions').selectAll().where('activityId', '=', activityId).orderBy('version', 'desc').executeTakeFirst();
}

/** Deletes stored files of the given versions (database rows go with the activity or are deleted by the caller). */
async function deleteVersionFiles(deps: Deps, versions: Array<Pick<PackageVersionRow, 'id' | 'storagePrefix'>>) {
  for (const version of versions) {
    const files = await deps.db.selectFrom('packageFiles').select('path').where('versionId', '=', version.id).execute();
    for (let i = 0; i < files.length; i += 50) {
      await Promise.allSettled(files.slice(i, i + 50).map((f) => deps.storage.delete(version.storagePrefix + f.path)));
    }
  }
}

/**
 * Lists the storage keys of every package file in an activity, a section or a course. Call it before
 * deleting those rows (the file list goes with them), then pass the keys to deleteStoredFiles afterwards.
 */
export async function packageStorageKeys(
  db: DB,
  scope: { activityId: string } | { sectionId: string; courseId: string } | { courseId: string },
): Promise<string[]> {
  let q = db
    .selectFrom('packageFiles')
    .innerJoin('packageVersions', 'packageVersions.id', 'packageFiles.versionId')
    .select(['packageVersions.storagePrefix', 'packageFiles.path']);
  if ('activityId' in scope) q = q.where('packageVersions.activityId', '=', scope.activityId);
  else if ('sectionId' in scope) {
    q = q.where('packageVersions.activityId', 'in', (eb) =>
      eb
        .selectFrom('activities')
        .select('activities.id')
        .where('activities.sectionId', '=', scope.sectionId)
        .where('activities.courseId', '=', scope.courseId),
    );
  } else q = q.where('packageVersions.courseId', '=', scope.courseId);
  const rows = await q.execute();
  return rows.map((r) => r.storagePrefix + r.path);
}

/** Deletes stored package files listed by packageStorageKeys (after their rows are gone). */
export async function deleteStoredFiles(deps: Pick<AppDeps, 'storage'>, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 50) {
    await Promise.allSettled(keys.slice(i, i + 50).map((key) => deps.storage.delete(key)));
  }
}

/** Files that archivers add (macOS Finder's __MACOSX folder, .DS_Store, Thumbs.db): never package content. */
function isArchiveMetadata(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return name.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._');
}

/** Finds the folder the package lives in: the zip root, or a single top-level folder. */
function packageRoot(names: string[]): { root: string; marker: string | null } {
  const markers = ['imsmanifest.xml', 'cmi5.xml', 'tincan.xml'];
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const m of markers) if (lower.has(m)) return { root: '', marker: m };
  const tops = new Set(names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
  if (tops.size === 1) {
    const [top] = [...tops];
    if (top) for (const m of markers) if (lower.has((top + m).toLowerCase())) return { root: top, marker: m };
  }
  return { root: '', marker: null };
}

/** Unzips, checks and stores an uploaded package as the activity's new current version. */
export async function importPackage(
  deps: Deps,
  activity: ActivityRow,
  user: UserRow,
  zip: Uint8Array,
  fileName: string,
): Promise<PackageVersionRow> {
  // cmi5: a cmi5.xml uploaded on its own (every AU hosted elsewhere) imports as a zip holding just that file.
  const cmi5Xml = standaloneCmi5(zip);
  if (cmi5Xml) zip = cmi5Xml;
  const entries = readZipEntries(zip, { maxFiles: DEFAULT_MAX_FILES, maxBytes: deps.config.maxPackageBytes }).filter(
    (e) => !isArchiveMetadata(e.name),
  );
  if (entries.length === 0) throw new PackageError('The zip is empty.');
  const { root, marker } = packageRoot(entries.map((e) => e.name));
  if (!marker) {
    throw new PackageError(
      "This zip doesn't look like a SCORM, xAPI or cmi5 package: it needs an imsmanifest.xml or tincan.xml file (or a cmi5.xml) at the top level.",
    );
  }
  const files = entries
    .filter((e) => e.name.startsWith(root))
    .map((e) => ({ entry: e, path: e.name.slice(root.length) }))
    .filter((f) => f.path !== '');
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byLower = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const hasFile = (path: string) => byPath.has(path) || byLower.has(path.toLowerCase());
  const read = (name: string) => {
    const f = byLower.get(name);
    if (!f) return null;
    if (f.entry.size > 5 * 1024 * 1024) throw new PackageError(`${name} is too large.`);
    return new TextDecoder('utf-8').decode(extractEntry(zip, f.entry));
  };

  const manifest = read('imsmanifest.xml');
  let structure: PackageStructure;
  if (manifest !== null) structure = parseScormManifest(manifest, hasFile);
  else if (marker === 'cmi5.xml') {
    const ownOrigin = deps.config.publicUrl ? new URL(deps.config.publicUrl).origin : null;
    structure = parseCmi5(read('cmi5.xml') ?? '', { hasFile, standalone: !!cmi5Xml, ownOrigin });
  } else structure = parseTincan(read('tincan.xml') ?? '', hasFile);
  // Launch paths must match stored file names exactly.
  for (const item of structure.items) {
    if (item.path && !byPath.has(item.path)) {
      const actual = byLower.get(item.path.toLowerCase())!.path;
      item.href = item.href!.replace(/^[^?#]*/, actual.split('/').map(encodeURIComponent).join('/'));
      item.path = actual;
    }
  }

  const latest = await currentVersion(deps.db, activity.id);
  const id = newId();
  const prefix = `packages/${activity.id}/${id}/`;
  const stored: string[] = [];
  let totalBytes = 0;
  try {
    for (const f of files) {
      if (f.path.startsWith('__coursekit/')) continue;
      const data = extractEntry(zip, f.entry);
      await deps.storage.put(prefix + f.path, data, mimeFor(f.path));
      stored.push(f.path);
      totalBytes += data.length;
    }
    const version: PackageVersionRow = {
      id,
      activityId: activity.id,
      courseId: activity.courseId,
      version: (latest?.version ?? 0) + 1,
      kind: structure.kind,
      edition: structure.edition,
      title: structure.title,
      fileName: fileName.slice(0, 200),
      structure: JSON.stringify(structure),
      fileCount: stored.length,
      totalBytes,
      storagePrefix: prefix,
      uploadedBy: user.id,
      createdAt: now(),
    };
    const sizes = new Map(files.map((f) => [f.path, f.entry.size]));
    await deps.db.transaction().execute(async (trx) => {
      await trx.insertInto('packageVersions').values(version).execute();
      for (let i = 0; i < stored.length; i += 400) {
        await trx
          .insertInto('packageFiles')
          .values(stored.slice(i, i + 400).map((path) => ({ versionId: id, path, size: sizes.get(path) ?? 0 })))
          .execute();
      }
    });
    await pruneVersions(deps, activity.id, id);
    return version;
  } catch (err) {
    await Promise.allSettled(stored.map((path) => deps.storage.delete(prefix + path)));
    throw err;
  }
}

/** Deletes older versions that no attempt uses. */
async function pruneVersions(deps: Deps, activityId: string, keepId: string) {
  const unused = await deps.db
    .selectFrom('packageVersions')
    .select(['id', 'storagePrefix'])
    .where('activityId', '=', activityId)
    .where('id', '!=', keepId)
    .where((eb) =>
      eb.not(eb.exists(eb.selectFrom('packageAttempts').select('id').whereRef('packageAttempts.versionId', '=', 'packageVersions.id'))),
    )
    .execute();
  if (!unused.length) return;
  await deleteVersionFiles(deps, unused);
  await deps.db
    .deleteFrom('packageVersions')
    .where(
      'id',
      'in',
      unused.map((v) => v.id),
    )
    .execute();
}

// ----- results -----

interface ItemResult extends PackageItemProgress {
  /** Passed, or completed without a passing score to meet. */
  passed: boolean;
  /** 0..1 */
  scaled: number | null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function scaledFrom(raw: string | undefined, min: string | undefined, max: string | undefined, defaultMax: number | null): number | null {
  if (raw === undefined || raw === '') return null;
  const r = Number(raw);
  const lo = min !== undefined && min !== '' ? Number(min) : 0;
  const hi = max !== undefined && max !== '' ? Number(max) : defaultMax;
  if (!Number.isFinite(r)) return null;
  if (hi === null || !Number.isFinite(hi) || hi <= lo) return r >= 0 && r <= 1 ? r : null;
  return clamp01((r - lo) / (hi - lo));
}

/** Completion, success and score of one SCO from its stored data model values. */
export function scoResult(version: ScormVersion, item: StructureItem, data: { values: Record<string, string> }): ItemResult {
  const v = data.values;
  if (version === '1.2') {
    const status = v['cmi.core.lesson_status'] ?? 'not attempted';
    const completion: PackageCompletionStatus = ['completed', 'passed', 'failed'].includes(status)
      ? 'completed'
      : status === 'not attempted'
        ? 'not attempted'
        : 'incomplete';
    const success: PackageSuccessStatus = status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unknown';
    const scaled = scaledFrom(v['cmi.core.score.raw'], v['cmi.core.score.min'], v['cmi.core.score.max'], 100);
    return {
      completionStatus: completion,
      successStatus: success,
      scaled,
      score: scaled === null ? null : round(scaled * 100, 2),
      passed: success === 'passed' || (success === 'unknown' && completion === 'completed' && item.masteryScore === null),
    };
  }
  const model = createModel('2004', { values: v, lms: lmsThresholds(item) });
  const cs = model.get('cmi.completion_status').value;
  const ss = model.get('cmi.success_status').value;
  const completion: PackageCompletionStatus = cs === 'completed' ? 'completed' : cs === 'incomplete' ? 'incomplete' : 'not attempted';
  const success: PackageSuccessStatus = ss === 'passed' ? 'passed' : ss === 'failed' ? 'failed' : 'unknown';
  const scaledRaw = v['cmi.score.scaled'];
  const scaled =
    scaledRaw !== undefined && scaledRaw !== ''
      ? clamp01(Number(scaledRaw))
      : scaledFrom(v['cmi.score.raw'], v['cmi.score.min'], v['cmi.score.max'], null);
  return {
    completionStatus: completion,
    successStatus: success,
    scaled,
    score: scaled === null ? null : round(scaled * 100, 2),
    passed: success === 'passed' || (success === 'unknown' && completion === 'completed' && item.scaledPassingScore === null),
  };
}

function lmsThresholds(item: StructureItem): Record<string, string> {
  const out: Record<string, string> = {};
  if (item.completionThreshold !== null) out['cmi.completion_threshold'] = String(item.completionThreshold);
  if (item.scaledPassingScore !== null) out['cmi.scaled_passing_score'] = String(item.scaledPassingScore);
  return out;
}

const scormVersion = (kind: PackageVersionRow['kind']): ScormVersion => (kind === 'scorm12' ? '1.2' : '2004');

interface StoredData {
  values: Record<string, string>;
  counts: Record<string, number>;
}

function storedData(row: Pick<PackageScoStateRow, 'data'> | undefined): StoredData {
  const data = parseJson<Partial<StoredData>>(row?.data, {});
  return { values: data.values ?? {}, counts: data.counts ?? {} };
}

const ADL = 'http://adlnet.gov/expapi/verbs/';

/** Recomputes an attempt's status and score from its SCOs (SCORM) or statements (xAPI), then the grade and completion. */
export async function refreshAttempt(deps: Deps, attemptId: string, options: { sessionEnded?: boolean } = {}): Promise<void> {
  const { db } = deps;
  const attempt = await db.selectFrom('packageAttempts').selectAll().where('id', '=', attemptId).executeTakeFirst();
  if (!attempt) return;
  const version = await db.selectFrom('packageVersions').selectAll().where('id', '=', attempt.versionId).executeTakeFirstOrThrow();
  // SCORM 2004: the result is the root activity's rolled-up status (sequencing/service.ts).
  if (version.kind === 'scorm2004') return refreshSequencedAttempt(deps, attempt, version);
  const structure = structureOf(version);
  const items = structure.items.filter((i) => i.launchable);

  let completion: PackageCompletionStatus = 'not attempted';
  let success: PackageSuccessStatus = 'unknown';
  let score: number | null = null;
  let seconds = 0;
  let finished = false;

  if (version.kind === 'cmi5') {
    const course = cmi5Of(structure);
    if (course) ({ completion, success, score, seconds, finished } = await cmi5AttemptResult(db, attempt.id, course));
  } else if (version.kind === 'xapi') {
    const statements = await db
      .selectFrom('xapiStatements')
      .select(['verbId', 'objectId', 'statement'])
      .where('attemptId', '=', attempt.id)
      .where('voided', '=', 0)
      .orderBy('stored', 'asc')
      .execute();
    let done = false;
    // Session verbs (terminated, exited, suspended) give the time; the root activity's longest
    // result.duration is used only when no session verb reported one.
    let rootSeconds = 0;
    for (const row of statements) {
      const st = parseJson<{
        result?: {
          score?: { scaled?: number; raw?: number; min?: number; max?: number };
          success?: boolean;
          completion?: boolean;
          duration?: string;
        };
      }>(row.statement, {});
      const result = st.result;
      const seconds2 = parseDuration(result?.duration, '2004');
      if (['terminated', 'exited', 'suspended'].some((v) => row.verbId === ADL + v)) seconds += seconds2;
      if (row.objectId !== structure.activityId) continue;
      const verb = row.verbId.startsWith(ADL) ? row.verbId.slice(ADL.length) : '';
      if (['completed', 'passed', 'failed'].includes(verb) || result?.completion === true) done = true;
      if (verb === 'passed' || result?.success === true) success = 'passed';
      else if (verb === 'failed' || result?.success === false) success = 'failed';
      const s = result?.score;
      if (s) {
        const scaled =
          typeof s.scaled === 'number'
            ? clamp01(s.scaled)
            : typeof s.raw === 'number'
              ? scaledFrom(
                  String(s.raw),
                  s.min === undefined ? undefined : String(s.min),
                  s.max === undefined ? undefined : String(s.max),
                  null,
                )
              : null;
        if (scaled !== null) score = scaled;
      }
      rootSeconds = Math.max(rootSeconds, seconds2);
    }
    if (!seconds) seconds = rootSeconds;
    completion = done ? 'completed' : statements.length ? 'incomplete' : 'not attempted';
    finished = done;
  } else {
    const rows = await db.selectFrom('packageScoStates').selectAll().where('attemptId', '=', attempt.id).execute();
    const byItem = new Map(rows.map((r) => [r.itemId, r]));
    const results = items.map((item) => {
      const row = byItem.get(item.id);
      if (!row) return null;
      seconds += row.totalSeconds;
      return { row, completion: row.completionStatus, success: row.successStatus, score: row.score, passed: isPassed(item, row) };
    });
    const scored = results.filter((r): r is NonNullable<typeof r> => r !== null && r.score !== null);
    score = scored.length ? scored.reduce((sum, r) => sum + r.score!, 0) / scored.length : null;
    const all = results.every((r) => r && r.completion === 'completed');
    completion = all ? 'completed' : results.some((r) => r) ? 'incomplete' : 'not attempted';
    success = results.every((r) => r && r.passed) ? 'passed' : results.some((r) => r?.success === 'failed') ? 'failed' : 'unknown';
    finished = all && !!options.sessionEnded;
  }

  const ts = now();
  const becameFinished = attempt.status === 'in_progress' && finished;
  await db
    .updateTable('packageAttempts')
    .set({
      completionStatus: completion,
      successStatus: success,
      score,
      totalSeconds: round(seconds, 2),
      lastAccessedAt: ts,
      ...(becameFinished ? { status: 'finished' as const, finishedAt: ts } : {}),
    })
    .where('id', '=', attempt.id)
    .execute();

  const activity = await db.selectFrom('activities').selectAll().where('id', '=', attempt.activityId).executeTakeFirst();
  if (activity) await syncResults(deps, activity, attempt.userId);
}

function isPassed(item: StructureItem, row: Pick<PackageScoStateRow, 'completionStatus' | 'successStatus'>): boolean {
  if (row.successStatus === 'passed') return true;
  if (row.successStatus === 'failed' || row.completionStatus !== 'completed') return false;
  return !item.sco || (item.masteryScore === null && item.scaledPassingScore === null);
}

/** Records the activity grade (highest or last attempt) and completion from the learner's attempts. */
export async function syncResults(deps: Pick<AppDeps, 'db' | 'events'>, activity: ActivityRow, userId: string): Promise<void> {
  const { db } = deps;
  const settings = parseSettings('package', activity.settings);
  const attempts = await db
    .selectFrom('packageAttempts')
    .selectAll()
    .where('activityId', '=', activity.id)
    .where('userId', '=', userId)
    .orderBy('attemptNumber', 'asc')
    .execute();
  const scored = attempts.filter((a) => a.score !== null);
  const pick =
    settings.gradingMethod === 'last'
      ? scored[scored.length - 1]
      : scored.reduce<PackageAttemptRow | undefined>((best, a) => (!best || a.score! > best.score! ? a : best), undefined);
  if (pick && activity.maxGrade != null) {
    const points = round(pick.score! * activity.maxGrade, 2);
    const current = await db
      .selectFrom('grades')
      .select('score')
      .where('activityId', '=', activity.id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!current || current.score !== points) {
      await upsertGrade(deps, { activityId: activity.id, courseId: activity.courseId, userId, score: points, gradedBy: null });
    }
  }
  if (
    activity.completion === 'auto' &&
    attempts.some((a) => a.completionStatus === 'completed' && (!settings.requirePass || a.successStatus === 'passed'))
  ) {
    await markCompleted(deps, activity, userId);
  }
}

// ----- attempts and launching -----

async function attemptsOf(db: DB, activityId: string, userId: string) {
  return db
    .selectFrom('packageAttempts')
    .selectAll()
    .where('activityId', '=', activityId)
    .where('userId', '=', userId)
    .orderBy('attemptNumber', 'asc')
    .execute();
}

export async function toAttemptInfos(db: DB, attempts: PackageAttemptRow[]): Promise<PackageAttemptInfo[]> {
  if (!attempts.length) return [];
  const ids = attempts.map((a) => a.id);
  const [rows, versions] = await Promise.all([
    db
      .selectFrom('packageScoStates')
      .select(['attemptId', 'itemId', 'completionStatus', 'successStatus', 'score'])
      .where('attemptId', 'in', ids)
      .execute(),
    db
      .selectFrom('packageVersions')
      .select(['id', 'version', 'kind'])
      .where('id', 'in', [...new Set(attempts.map((a) => a.versionId))])
      .execute(),
  ]);
  const versionNumber = new Map(versions.map((v) => [v.id, v.version]));
  const versionKind = new Map(versions.map((v) => [v.id, v.kind]));
  return attempts.map((a) => {
    const items: Record<string, PackageItemProgress> = {};
    for (const r of rows) {
      if (r.attemptId !== a.id) continue;
      items[r.itemId] = {
        completionStatus: r.completionStatus,
        successStatus: r.successStatus,
        score: r.score === null ? null : round(r.score * 100, 2),
      };
    }
    return {
      id: a.id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      completionStatus: a.completionStatus,
      successStatus: a.successStatus,
      score: a.score === null ? null : round(a.score * 100, 2),
      totalSeconds: a.totalSeconds,
      startedAt: a.startedAt,
      lastAccessedAt: a.lastAccessedAt,
      finishedAt: a.finishedAt,
      version: versionNumber.get(a.versionId) ?? 0,
      // The version can't be gone: deleting it deletes its attempts.
      kind: versionKind.get(a.versionId)!,
      items,
    };
  });
}

const isLearner = (access: ActivityAccess) => access.enrolment?.role === 'student';

function canStartNew(access: ActivityAccess, settings: PackageSettings, attempts: PackageAttemptRow[], hasVersion: boolean): boolean {
  if (!isLearner(access) || access.readOnly || !hasVersion) return false;
  if (attempts.some((a) => a.status === 'in_progress')) return false;
  return settings.attemptsAllowed === 0 || attempts.length < settings.attemptsAllowed;
}

export async function playerInfo(deps: Deps, access: ActivityAccess): Promise<PackagePlayerInfo> {
  const { db } = deps;
  const { activity } = access;
  const settings = parseSettings('package', activity.settings);
  const current = await currentVersion(db, activity.id);
  const learner = isLearner(access);
  const attempts = learner ? await attemptsOf(db, activity.id, access.user.id) : [];
  const resume = attempts.find((a) => a.status === 'in_progress') ?? null;
  const launchVersion =
    resume && resume.versionId !== current?.id
      ? await db.selectFrom('packageVersions').selectAll().where('id', '=', resume.versionId).executeTakeFirst()
      : current;
  const grade = learner
    ? await db
        .selectFrom('grades')
        .select('score')
        .where('activityId', '=', activity.id)
        .where('userId', '=', access.user.id)
        .executeTakeFirst()
    : undefined;
  return {
    activityId: activity.id,
    settings,
    current: current ? toVersionInfo(current) : null,
    attempts: await toAttemptInfos(db, attempts),
    mode: learner ? 'learner' : 'preview',
    canStartNew: canStartNew(access, settings, attempts, !!current),
    resumeAttemptId: resume?.id ?? null,
    launchVersion: launchVersion ? toVersionInfo(launchVersion) : null,
    grade: learner && activity.maxGrade != null ? { score: grade?.score ?? null, maxGrade: activity.maxGrade } : null,
    canManage: access.can('course:manageContent'),
    canViewReports: access.can('grades:viewAll'),
    maxUploadBytes: deps.config.maxUploadBytes,
  };
}

/** The Coursekit actor of a learner in xAPI statements: an account on the site, never an email address. */
export function xapiActor(user: Pick<UserRow, 'id' | 'name'>, homePage: string) {
  return { objectType: 'Agent' as const, name: user.name, account: { homePage, name: user.id } };
}

/**
 * Launches the package for the viewer. With `kind` (POST /cmi5/launch), a launch of a version of another kind is
 * 409, before any attempt starts: the page asking was open while the teacher replaced the package.
 */
export async function launch(
  deps: Deps,
  access: ActivityAccess,
  input: PackageLaunchInput,
  origin: string,
  options: { kind?: PackageKind } = {},
): Promise<PackageLaunch> {
  const { db } = deps;
  const { activity, user } = access;
  const settings = parseSettings('package', activity.settings);
  const current = await currentVersion(db, activity.id);
  if (!current) throw badRequest('No package has been uploaded to this activity yet.');
  const expectKind = (v: PackageVersionRow) => {
    if (options.kind && v.kind !== options.kind) throw conflict("This activity's package has changed. Reload the page to open it.");
  };

  let purpose: TokenPurpose;
  let attempt: PackageAttemptRow | null = null;
  let version = current;
  if (!isLearner(access)) {
    purpose = 'preview';
    expectKind(current);
  } else {
    const attempts = await attemptsOf(db, activity.id, user.id);
    if (input.attemptId) {
      attempt = attempts.find((a) => a.id === input.attemptId) ?? null;
      if (!attempt) throw notFound('Attempt');
    } else if (!input.newAttempt) {
      attempt = attempts.find((a) => a.status === 'in_progress') ?? null;
    }
    if (!attempt && (input.newAttempt || attempts.length === 0 || canStartNew(access, settings, attempts, true))) {
      if (!canStartNew(access, settings, attempts, true)) {
        throw forbidden(
          access.readOnly
            ? 'This course is archived and read-only.'
            : attempts.some((a) => a.status === 'in_progress')
              ? 'Finish your current attempt before starting a new one.'
              : "You've used all your attempts at this activity.",
        );
      }
      expectKind(current);
      const ts = now();
      attempt = {
        id: newId(),
        activityId: activity.id,
        courseId: activity.courseId,
        userId: user.id,
        versionId: current.id,
        attemptNumber: (attempts[attempts.length - 1]?.attemptNumber ?? 0) + 1,
        registration: randomUUID(),
        status: 'in_progress',
        completionStatus: 'not attempted',
        successStatus: 'unknown',
        score: null,
        totalSeconds: 0,
        lastItemId: null,
        startedAt: ts,
        lastAccessedAt: ts,
        finishedAt: null,
      };
      await db.insertInto('packageAttempts').values(attempt).execute();
    }
    attempt ??= attempts[attempts.length - 1] ?? null;
    if (!attempt) throw forbidden("You can't start this activity.");
    purpose = attempt.status === 'finished' || access.readOnly ? 'review' : 'play';
    if (attempt.versionId !== current.id) {
      version = await db.selectFrom('packageVersions').selectAll().where('id', '=', attempt.versionId).executeTakeFirstOrThrow();
    }
    expectKind(version);
    // SCORM 2004 attempts follow the package's sequencing rules (sequencing/service.ts).
    if (version.kind === 'scorm2004') {
      const sequencing = { activityId: activity.id, userId: user.id, settings, version, attempt };
      if (purpose === 'play') return sequencedLaunch(deps, sequencing, input);
      // The sequenced player asking after its attempt finished (its content ended it while the player
      // was open): it gets the attempt's summary, not a review.
      if (input.nav !== undefined && attempt.status === 'finished') return sequencedSummary(deps, sequencing);
    }
  }

  if (version.kind === 'cmi5') return launchCmi5(deps, access, { attempt, purpose, version, input, origin });
  const structure = structureOf(version);
  // Items hidden from the table of contents (SCORM 2004 isvisible="false") only open when asked for.
  const launchable = structure.items.filter((i) => i.launchable);
  const listed = launchable.filter((i) => i.visible !== false);
  let item: StructureItem | undefined;
  if (input.itemId) {
    item = launchable.find((i) => i.id === input.itemId);
    if (!item) throw badRequest('That part of the package does not exist.');
  } else {
    const states = attempt
      ? await db.selectFrom('packageScoStates').select(['itemId', 'completionStatus']).where('attemptId', '=', attempt.id).execute()
      : [];
    const done = new Set(states.filter((s) => s.completionStatus === 'completed').map((s) => s.itemId));
    item =
      listed.find((i) => i.id === attempt?.lastItemId && !done.has(i.id)) ??
      listed.find((i) => !done.has(i.id)) ??
      listed[0] ??
      launchable[0];
  }
  if (!item?.href) throw badRequest('This package has nothing to launch.');

  if (attempt && purpose === 'play') {
    const ts = now();
    if (version.kind !== 'xapi') {
      await db
        .insertInto('packageScoStates')
        .values({
          attemptId: attempt.id,
          itemId: item.id,
          data: JSON.stringify({ values: {}, counts: {} }),
          completionStatus: item.sco ? 'not attempted' : 'completed',
          successStatus: 'unknown',
          score: null,
          totalSeconds: 0,
          lastExit: null,
          sessions: 0,
          sessionId: null,
          seq: 0,
          terminatedSessionId: null,
          sessionSeconds: 0,
          updatedAt: ts,
        })
        .onConflict((oc) => oc.columns(['attemptId', 'itemId']).doNothing())
        .execute();
    }
    await db.updateTable('packageAttempts').set({ lastItemId: item.id, lastAccessedAt: ts }).where('id', '=', attempt.id).execute();
    if (!item.sco) await refreshAttempt(deps, attempt.id, { sessionEnded: true });
  }

  const secret = await packageSecret(db);
  const base = { a: activity.id, v: version.id, u: user.id, t: attempt?.id ?? '' };
  const token = signToken(secret, { ...base, p: purpose, i: item.id });
  let url = `${CONTENT_PREFIX}${token}/${item.href}`;
  if (version.kind === 'xapi') {
    const publicOrigin = (deps.config.publicUrl ?? origin).replace(/\/+$/, '');
    const auth = signToken(secret, { ...base, p: 'xapi', i: purpose === 'play' ? 'xapi' : 'readonly' });
    const params = new URLSearchParams({
      endpoint: `${publicOrigin}/xapi/`,
      auth: `Basic ${Buffer.from(`coursekit:${auth}`).toString('base64')}`,
      actor: JSON.stringify(xapiActor(user, publicOrigin)),
      registration: attempt?.registration ?? randomUUID(),
      activity_id: structure.activityId ?? '',
    });
    const hashAt = url.indexOf('#');
    const [main, hash] = hashAt < 0 ? [url, ''] : [url.slice(0, hashAt), url.slice(hashAt)];
    url = `${main}${main.includes('?') ? '&' : '?'}${params.toString()}${hash}`;
  }
  return {
    url,
    attemptId: attempt?.id ?? null,
    itemId: item.id,
    mode: purpose === 'play' ? 'normal' : purpose === 'review' ? 'review' : 'browse',
    display: settings.display,
    items: toVersionInfo(version).items,
  };
}

// ----- the run-time -----

function learnerName12(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts.pop()!;
  return `${last}, ${parts.join(' ')}`.slice(0, 255);
}

export interface RuntimeContext {
  token: PackageToken;
  version: PackageVersionRow;
  structure: PackageStructure;
  item: StructureItem;
  attempt: PackageAttemptRow | null;
}

/** Loads and checks what a content token points at. Returns null when it no longer matches. */
export async function loadRuntimeContext(db: DB, token: PackageToken): Promise<RuntimeContext | null> {
  const version = await db.selectFrom('packageVersions').selectAll().where('id', '=', token.v).executeTakeFirst();
  if (!version || version.activityId !== token.a) return null;
  let attempt: PackageAttemptRow | null = null;
  if (token.p !== 'preview') {
    attempt = (await db.selectFrom('packageAttempts').selectAll().where('id', '=', token.t).executeTakeFirst()) ?? null;
    if (!attempt || attempt.userId !== token.u || attempt.versionId !== version.id || attempt.activityId !== token.a) return null;
  }
  const structure = structureOf(version);
  const item = structure.items.find((i) => i.id === token.i && i.launchable);
  if (!item) return null;
  return { token, version, structure, item, attempt };
}

function lmsValues(
  ctx: RuntimeContext,
  user: Pick<UserRow, 'id' | 'name'>,
  row: PackageScoStateRow | undefined,
  seqRt?: SequencedRuntime | null,
): Record<string, string> {
  const { item, token } = ctx;
  const mode = token.p === 'play' ? 'normal' : token.p === 'review' ? 'review' : 'browse';
  const credit = token.p === 'play' ? 'credit' : 'no-credit';
  const entry = !row || row.sessions === 0 ? 'ab-initio' : row.lastExit === 'suspend' ? 'resume' : '';
  const total = row?.totalSeconds ?? 0;
  if (ctx.version.kind === 'scorm12') {
    return {
      'cmi.core.student_id': user.id,
      'cmi.core.student_name': learnerName12(user.name),
      'cmi.core.credit': credit,
      'cmi.core.entry': entry,
      'cmi.core.lesson_mode': mode,
      'cmi.core.total_time': formatDuration(total, '1.2'),
      'cmi.launch_data': item.dataFromLms ?? '',
      'cmi.comments_from_lms': '',
      'cmi.student_data.mastery_score': item.masteryScore === null ? '' : String(item.masteryScore),
      'cmi.student_data.max_time_allowed': item.maxTimeAllowed ?? '',
      'cmi.student_data.time_limit_action': item.timeLimitAction ?? 'continue,no message',
    };
  }
  const out: Record<string, string> = {
    'cmi.learner_id': user.id,
    'cmi.learner_name': user.name.slice(0, 250),
    'cmi.credit': credit,
    'cmi.entry': entry,
    'cmi.mode': mode,
    'cmi.total_time': formatDuration(total, '2004'),
    'cmi.time_limit_action': item.timeLimitAction ?? 'continue,no message',
    ...lmsThresholds(item),
    // SCORM 2004 deliveries: entry, total time (of the current attempt on the activity) and credit.
    ...(seqRt ? seqRt.lms(row) : {}),
  };
  if (item.dataFromLms !== null) out['cmi.launch_data'] = item.dataFromLms;
  if (item.maxTimeAllowed) out['cmi.max_time_allowed'] = item.maxTimeAllowed;
  return out;
}

function navOf(ctx: RuntimeContext) {
  const items = ctx.structure.items.filter((i) => i.launchable).map((i) => i.id);
  return { items, index: items.indexOf(ctx.item.id) };
}

/** Whether a play token opens a sequenced SCORM 2004 delivery. */
const sequenced = (ctx: RuntimeContext) => ctx.version.kind === 'scorm2004' && ctx.token.p === 'play' && !!ctx.attempt;
/** SCORM 2004: the edition decides the run-time's vocabulary (jump navigation requests are 4th edition only). */
const editionOf = (ctx: RuntimeContext): Pick<ModelInit, 'edition'> =>
  ctx.version.kind === 'scorm2004' ? { edition: ctx.version.edition } : {};
const MOVED_ON = 'This part has moved on: progress here is no longer saved.';

/**
 * What the browser run-time starts from: the stored data of this SCO plus Coursekit's read-only values.
 * Returns null for a SCORM 2004 delivery that is no longer the current one (the learner moved on).
 */
export async function runtimeBoot(
  deps: Pick<AppDeps, 'db' | 'storage'>,
  ctx: RuntimeContext,
  tokenString: string,
  origin: string,
): Promise<RuntimeBoot | null> {
  const { db } = deps;
  const seqRt = sequenced(ctx) ? await sequencedRuntime(deps, ctx) : null;
  if (sequenced(ctx) && !seqRt?.current) return null;
  const user = await db.selectFrom('users').select(['id', 'name']).where('id', '=', ctx.token.u).executeTakeFirst();
  const row =
    ctx.attempt && ctx.version.kind !== 'xapi'
      ? await db
          .selectFrom('packageScoStates')
          .selectAll()
          .where('attemptId', '=', ctx.attempt.id)
          .where('itemId', '=', ctx.item.id)
          .executeTakeFirst()
      : undefined;
  const data = storedData(row);
  const boot = seqRt ? sequencedBoot(seqRt, data.values) : null;
  return {
    version: ctx.version.kind === 'xapi' ? 'xapi' : scormVersion(ctx.version.kind),
    commitUrl: `${CONTENT_PREFIX}${tokenString}/__coursekit/commit`,
    sid: randomToken(12),
    item: ctx.item.id,
    origin,
    values: boot?.values ?? data.values,
    counts: data.counts,
    lms: user ? lmsValues(ctx, user, row, seqRt) : {},
    nav: boot?.nav ?? navOf(ctx),
    ...(seqRt ? { data: seqRt.data } : {}),
    ...editionOf(ctx),
    maxBytes: MAX_SCO_STATE_BYTES,
  };
}

export interface CommitBody {
  sid: string;
  seq: number;
  ops: Array<[string, string]>;
  terminate: boolean;
  /** Seconds since Initialize, used when the SCO reports no session time. */
  elapsed: number;
  /** The session ended because the page went away (SCORM 2004: the SCO's navigation isn't implied). */
  unload: boolean;
  /** The player is about to navigate for the learner (SCORM 2004: the SCO's navigation request is ignored). */
  lms: boolean;
}

export function parseCommitBody(text: string): CommitBody | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.sid !== 'string' || d.sid.length < 1 || d.sid.length > 64) return null;
  if (typeof d.seq !== 'number' || !Number.isInteger(d.seq) || d.seq < 1 || d.seq > 1e9) return null;
  if (!Array.isArray(d.ops) || d.ops.length > 10_000) return null;
  const ops: Array<[string, string]> = [];
  for (const op of d.ops) {
    if (!Array.isArray(op) || op.length !== 2 || typeof op[0] !== 'string' || typeof op[1] !== 'string' || op[0].length > 300) return null;
    ops.push([op[0], op[1]]);
  }
  const elapsed = typeof d.elapsed === 'number' && Number.isFinite(d.elapsed) ? Math.min(Math.max(0, d.elapsed), 12 * 3600) : 0;
  return { sid: d.sid, seq: d.seq, ops, terminate: d.terminate === true, elapsed, unload: d.unload === true, lms: d.lms === true };
}

/** Applies a commit from the run-time after validating every element again. */
export async function applyCommit(deps: Deps, ctx: RuntimeContext, body: CommitBody): Promise<{ recorded: boolean; rejected: number }> {
  const { db } = deps;
  const { token, attempt, item, version } = ctx;
  if (token.p !== 'play' || !attempt || version.kind === 'xapi') return { recorded: false, rejected: 0 };
  const user = await db.selectFrom('users').select(['id', 'name', 'status']).where('id', '=', token.u).executeTakeFirst();
  const enrolment = await db
    .selectFrom('enrolments')
    .select('id')
    .where('courseId', '=', attempt.courseId)
    .where('userId', '=', token.u)
    .where('status', '=', 'active')
    .where('role', '=', 'student')
    .executeTakeFirst();
  if (!user || user.status !== 'active' || !enrolment) throw forbidden('You are no longer enrolled in this course.');
  const course = await db.selectFrom('courses').select('visibility').where('id', '=', attempt.courseId).executeTakeFirst();
  if (course?.visibility === 'archived') return { recorded: false, rejected: 0 };
  // SCORM 2004: only the latest delivery of this part records. A page of an earlier one is told so
  // (403): its run-time then reports a commit failure (391) to the SCO instead of pretending to save.
  const seqRt = sequenced(ctx) ? await sequencedRuntime(deps, ctx) : null;
  if (sequenced(ctx) && !seqRt) throw forbidden(MOVED_ON);

  for (let tries = 0; tries < 3; tries++) {
    const row = await db
      .selectFrom('packageScoStates')
      .selectAll()
      .where('attemptId', '=', attempt.id)
      .where('itemId', '=', item.id)
      .executeTakeFirst();
    if (!row) throw notFound('Attempt');
    // A finished attempt takes no more commits, except from the page session whose ending finished it:
    // content that calls Finish from its own pagehide/unload handler ends that session a second time,
    // after the run-time's own pagehide ending, with its final score, exit and session time.
    if (attempt.status !== 'in_progress' && row.terminatedSessionId !== body.sid) return { recorded: false, rejected: 0 };
    if (row.sessionId === body.sid && body.seq <= row.seq) return { recorded: false, rejected: 0 };
    // Once the learner has moved on from a delivery, only its page sessions that already recorded may finish.
    if (seqRt && !seqRt.current && row.sessionId !== body.sid && row.terminatedSessionId !== body.sid) throw forbidden(MOVED_ON);
    const sv = scormVersion(version.kind);
    const stored = storedData(row);
    const init: ModelInit = {
      values: stored.values,
      counts: stored.counts,
      lms: lmsValues(ctx, user, row, seqRt),
      nav: navOf(ctx),
      maxBytes: MAX_SCO_STATE_BYTES,
      ...editionOf(ctx),
    };
    if (seqRt) init.data = seqRt.data;
    const model = createModel(sv, init);
    let rejected = 0;
    for (const [element, value] of body.ops) if (model.set(element, value)) rejected++;
    const report = seqRt ? runtimeReport(model) : null;
    const values = { ...model.values };
    // Shared data stores (adl.data) live in the sequencing state, not in this SCO's data.
    const shared = new Map<string, string>();
    for (const key of Object.keys(values)) {
      const m = /^adl\.data\.(\d+)\.store$/.exec(key);
      if (!m) continue;
      const target = seqRt?.data[Number(m[1])];
      if (target) shared.set(target.id, values[key]!);
      delete values[key];
    }
    const navRequest = values['adl.nav.request'] ?? '_none_';
    const exitKey = sv === '1.2' ? 'cmi.core.exit' : 'cmi.exit';
    const timeKey = sv === '1.2' ? 'cmi.core.session_time' : 'cmi.session_time';
    // A session ends with Finish/Terminate, or when the page goes away (pagehide). Content that calls
    // Finish from its own unload handler ends the same session again: that corrects the first ending.
    const ending = body.terminate;
    const endedBefore = row.terminatedSessionId === body.sid;
    let totalSeconds = row.totalSeconds;
    let sessionSeconds = row.sessionSeconds;
    let lastExit = row.lastExit;
    if (ending) {
      const reported = values[timeKey];
      sessionSeconds = round(reported ? parseDuration(reported, sv) : body.elapsed, 2);
      totalSeconds = round((endedBefore ? row.totalSeconds - row.sessionSeconds : row.totalSeconds) + sessionSeconds, 2);
      lastExit = values[exitKey] ?? '';
      delete values[timeKey];
      delete values[exitKey];
      // A navigation request is for this session only (the next one starts with _none_).
      delete values['adl.nav.request'];
      // SCORM 1.2 (RTE 3.4.4): a SCO that ends its session without setting a status is completed.
      if (sv === '1.2' && (values['cmi.core.lesson_status'] ?? 'not attempted') === 'not attempted') {
        values['cmi.core.lesson_status'] = 'completed';
      }
      // SCORM 1.2: with a mastery score, the LMS decides passed or failed from the raw score.
      const raw = values['cmi.core.score.raw'];
      if (
        sv === '1.2' &&
        item.masteryScore !== null &&
        raw !== undefined &&
        raw !== '' &&
        values['cmi.core.lesson_status'] === 'completed'
      ) {
        values['cmi.core.lesson_status'] = Number(raw) >= item.masteryScore ? 'passed' : 'failed';
      }
    }
    const result = scoResult(sv, item, { values });
    const newSession = row.sessionId !== body.sid;
    const updated = await db
      .updateTable('packageScoStates')
      .set({
        data: JSON.stringify({ values, counts: model.counts }),
        completionStatus: item.sco ? result.completionStatus : 'completed',
        successStatus: result.successStatus,
        score: result.scaled,
        totalSeconds,
        lastExit,
        sessions: newSession ? row.sessions + 1 : row.sessions,
        sessionId: body.sid,
        seq: body.seq,
        terminatedSessionId: ending ? body.sid : row.terminatedSessionId,
        sessionSeconds: ending ? sessionSeconds : row.sessionSeconds,
        updatedAt: now(),
      })
      .where('attemptId', '=', attempt.id)
      .where('itemId', '=', item.id)
      .where('seq', '=', row.seq)
      .where((eb) => (row.sessionId === null ? eb('sessionId', 'is', null) : eb('sessionId', '=', row.sessionId)))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) continue; // a concurrent commit won; re-read
    if (seqRt && report) {
      await sequencedCommit(deps, ctx, seqRt, {
        report,
        ending,
        unload: body.unload,
        lms: body.lms,
        navRequest,
        exit: ending ? (lastExit ?? '') : '',
        data: shared,
      });
    } else await refreshAttempt(deps, attempt.id, { sessionEnded: ending });
    return { recorded: true, rejected };
  }
  return { recorded: false, rejected: 0 };
}

// ----- reports -----

/** `scope` (from studentScope) limits the rows to the students the viewer may see under the activity's group mode. */
export async function packageReport(
  db: DB,
  access: ActivityAccess,
  scope?: Pick<StudentScope, 'groupIds' | 'restrictedTo'>,
): Promise<PackageReport> {
  const { activity } = access;
  let studentsQuery = db
    .selectFrom('enrolments')
    .innerJoin('users', 'users.id', 'enrolments.userId')
    .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
    .where('enrolments.courseId', '=', activity.courseId)
    .where('enrolments.role', '=', 'student')
    .where('enrolments.status', '=', 'active')
    .orderBy('users.name', 'asc');
  if (scope) studentsQuery = whereInScope(db, studentsQuery, 'enrolments.userId', scope);
  const students = await studentsQuery.execute();
  const ids = students.map((s) => s.id);
  const [attempts, grades, completions] = ids.length
    ? await Promise.all([
        db
          .selectFrom('packageAttempts')
          .selectAll()
          .where('activityId', '=', activity.id)
          .where('userId', 'in', ids)
          .orderBy('attemptNumber', 'asc')
          .execute(),
        db.selectFrom('grades').select(['userId', 'score']).where('activityId', '=', activity.id).where('userId', 'in', ids).execute(),
        db.selectFrom('completions').select('userId').where('activityId', '=', activity.id).where('userId', 'in', ids).execute(),
      ])
    : [[], [], []];
  const infos = await toAttemptInfos(db, attempts);
  const byUser = new Map<string, PackageAttemptInfo[]>();
  for (const [i, a] of attempts.entries()) {
    const list = byUser.get(a.userId) ?? [];
    list.push(infos[i]!);
    byUser.set(a.userId, list);
  }
  const gradeMap = new Map(grades.map((g) => [g.userId, g.score]));
  const done = new Set(completions.map((c) => c.userId));
  return {
    maxGrade: activity.maxGrade,
    rows: students.map((s) => ({
      user: { id: s.id, name: s.name, avatarUrl: s.avatarUrl, email: s.email },
      attempts: byUser.get(s.id) ?? [],
      grade: gradeMap.get(s.id) ?? null,
      completed: done.has(s.id),
    })),
  };
}
