/**
 * Time zones for live classes, with Node's built-in Intl (full ICU). Repeating sessions keep the same local time in
 * the teacher's IANA time zone, so a weekly class at 10:00 stays at 10:00 across a daylight saving change.
 */

export interface LocalTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (partsCache.size > 200) partsCache.clear();
    partsCache.set(timeZone, f);
  }
  return f;
}

/** True for an IANA time zone name Node knows, such as "Europe/London" or "UTC". */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock date and time at `ms` in a time zone (seconds dropped). */
export function localTimeAt(ms: number, timeZone: string): LocalTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second ?? 0,
  };
}

/** The time zone's offset from UTC at `ms`, in milliseconds (positive east of Greenwich). */
export function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const l = localTimeAt(whole, timeZone);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - whole;
}

/**
 * The UTC instant of a wall-clock time in a time zone. A time that happens twice (clocks going back) gives the
 * earlier one; a time that doesn't exist (clocks going forward) moves forward by the gap, as calendar apps do.
 */
export function zonedTimeToUtc(local: LocalTime, timeZone: string): number {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(asUtc - 86_400_000, timeZone);
  const after = offsetAt(asUtc + 86_400_000, timeZone);
  const fits = (candidate: number) => candidate + offsetAt(candidate, timeZone) === asUtc;
  const a = asUtc - before;
  const b = asUtc - after;
  const valid = [a, b].filter(fits);
  if (valid.length) return Math.min(...valid);
  // In a gap: read the wall time with the offset from before the change, which lands just after it.
  return a;
}

/**
 * Start times of a repeating series: the first one as given, then every day or week at the same local time in
 * `timeZone`.
 */
export function repeatStarts(first: number, frequency: 'daily' | 'weekly', count: number, timeZone: string): number[] {
  const local = localTimeAt(first, timeZone);
  const step = frequency === 'daily' ? 1 : 7;
  const starts = [first];
  for (let i = 1; i < count; i++) {
    // Date.UTC normalises day overflow into the next month or year.
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + i * step));
    starts.push(
      zonedTimeToUtc(
        { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: local.hour, minute: local.minute },
        timeZone,
      ),
    );
  }
  return starts;
}

const labelCache = new Map<string, Intl.DateTimeFormat>();

/** "Tuesday 3 March, 10:00 GMT": for notifications, in the time zone the session was scheduled in. */
export function formatInZone(iso: string, timeZone: string | null | undefined): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  let f = labelCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    if (labelCache.size > 200) labelCache.clear();
    labelCache.set(zone, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(iso))) if (p.type !== 'literal') parts[p.type] = p.value;
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${parts.timeZoneName ?? zone}`;
}
