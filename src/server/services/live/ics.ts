/**
 * iCalendar files (RFC 5545) for live class sessions: "Add to calendar". Times are UTC; each session has a stable UID
 * and a SEQUENCE that goes up when it changes, so calendar apps update their copy; cancelled sessions are
 * STATUS:CANCELLED. Lines are folded at 75 octets and text is escaped.
 */
import type { LiveSessionRow } from '../../db/schema-live.js';

export interface IcsEvent {
  session: Pick<LiveSessionRow, 'id' | 'title' | 'agenda' | 'startsAt' | 'endsAt' | 'status' | 'sequence' | 'updatedAt'>;
  summary: string;
  description: string;
  url: string | null;
  location: string;
  reminderMinutes: number | null;
}

function stamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Folds a content line to 75 octets, never splitting a UTF-8 character. */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(events: IcsEvent[], options: { host: string; calendarName: string }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Coursekit//Live classes//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  lines.push(`X-WR-CALNAME:${escapeIcsText(options.calendarName)}`);
  const host = options.host.replace(/[^A-Za-z0-9.-]/g, '') || 'coursekit';
  const dtstamp = stamp(new Date().toISOString());
  for (const e of events) {
    const s = e.session;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:live-${s.id}@${host}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`LAST-MODIFIED:${stamp(s.updatedAt)}`);
    lines.push(`DTSTART:${stamp(s.startsAt)}`);
    lines.push(`DTEND:${stamp(s.endsAt)}`);
    lines.push(`SEQUENCE:${s.sequence}`);
    lines.push(`STATUS:${s.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push(`SUMMARY:${escapeIcsText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, '')}`);
    if (e.reminderMinutes && s.status !== 'cancelled') {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeIcsText(e.summary)}`,
        `TRIGGER:-PT${e.reminderMinutes}M`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** A safe file name: "Weekly Q&A 2026-03-03.ics". */
export function icsFileName(title: string, startsAt?: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} _.-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'live-class';
  return `${base}${startsAt ? ` ${startsAt.slice(0, 10)}` : ''}.ics`;
}
