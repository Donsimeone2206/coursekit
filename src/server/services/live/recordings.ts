/**
 * Recordings of live class sessions: from the provider (BigBlueButton, Zoom) or links staff add by hand. A recording
 * belongs to a session and, in a class with group rooms, to one group's room; learners see it when they could see
 * that room. Staff can hide recordings or remove them.
 */
import type { LiveRecording } from '../../../shared/live.js';
import type { LiveRecordingRow, LiveRoomRow, LiveSessionRow } from '../../db/schema-live.js';
import type { DB } from '../../db/types.js';
import { newId, now } from '../../lib/util.js';
import type { ProviderRecording } from './providers.js';

/** Adds new provider recordings and refreshes known ones. Hidden and removed recordings stay that way. */
export async function saveProviderRecordings(
  db: DB,
  session: Pick<LiveSessionRow, 'id' | 'courseId'>,
  room: Pick<LiveRoomRow, 'id' | 'groupKey'>,
  source: 'bbb' | 'zoom',
  recordings: ProviderRecording[],
): Promise<void> {
  const ts = now();
  for (const r of recordings.slice(0, 100)) {
    await db
      .insertInto('liveRecordings')
      .values({
        id: newId(),
        sessionId: session.id,
        courseId: session.courseId,
        roomId: room.id,
        groupKey: room.groupKey,
        source,
        externalId: r.externalId.slice(0, 300),
        title: (r.title || 'Recording').slice(0, 200),
        url: r.url.slice(0, 2000),
        passcode: r.passcode?.slice(0, 100) ?? null,
        durationMinutes: r.durationMinutes,
        recordedAt: r.recordedAt,
        hidden: r.published ? 0 : 1,
        removedAt: null,
        addedBy: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflict((oc) =>
        oc.columns(['sessionId', 'source', 'externalId']).doUpdateSet((eb) => ({
          title: eb.ref('excluded.title'),
          url: eb.ref('excluded.url'),
          passcode: eb.ref('excluded.passcode'),
          durationMinutes: eb.ref('excluded.durationMinutes'),
          recordedAt: eb.ref('excluded.recordedAt'),
          updatedAt: ts,
        })),
      )
      .execute();
  }
}

export function toLiveRecording(row: LiveRecordingRow, groupNames: Map<string, string>, staff: boolean): LiveRecording {
  return {
    id: row.id,
    sessionId: row.sessionId,
    groupId: row.groupKey || null,
    groupName: row.groupKey ? (groupNames.get(row.groupKey) ?? 'Deleted group') : null,
    title: row.title,
    url: row.url,
    passcode: row.passcode,
    durationMinutes: row.durationMinutes,
    recordedAt: row.recordedAt,
    source: row.source,
    ...(staff ? { hidden: !!row.hidden } : {}),
  };
}

/**
 * Recordings of some sessions the viewer may see: not removed, not hidden (unless staff), and for the whole class
 * or a group room the viewer sees (`groupKeys` null: every room).
 */
export async function visibleRecordings(
  db: DB,
  sessionIds: string[],
  viewer: { staff: boolean; groupKeys: Set<string> | null },
  groupNames: Map<string, string>,
): Promise<Map<string, LiveRecording[]>> {
  const result = new Map<string, LiveRecording[]>();
  for (let i = 0; i < sessionIds.length; i += 400) {
    const rows = await db
      .selectFrom('liveRecordings')
      .selectAll()
      .where('sessionId', 'in', sessionIds.slice(i, i + 400))
      .where('removedAt', 'is', null)
      .$if(!viewer.staff, (q) => q.where('hidden', '=', 0))
      .orderBy('recordedAt', 'asc')
      .orderBy('createdAt', 'asc')
      .execute();
    for (const row of rows) {
      if (row.groupKey && viewer.groupKeys && !viewer.groupKeys.has(row.groupKey)) continue;
      const list = result.get(row.sessionId) ?? [];
      list.push(toLiveRecording(row, groupNames, viewer.staff));
      result.set(row.sessionId, list);
    }
  }
  return result;
}
