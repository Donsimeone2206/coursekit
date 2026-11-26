/**
 * Fixed-window counters per key (a client address, an email), kept in memory for one Coursekit instance.
 * Several server processes each count on their own.
 */
export interface RateLimiter {
  /** Counts one hit and returns true, or returns false (counting nothing) once the key has used up its limit in the current window. */
  hit(key: string): boolean;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const t = Date.now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        if (limit < 1) return false;
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
  };
}

/**
 * Limits failed attempts per key (failed sign-ins per client address) when an attempt's outcome is only known
 * after an await, such as a password check. Each attempt takes a place before the check and keeps it only if it
 * fails, so attempts sent at the same time can never get past the limit. While all the places left are taken by
 * attempts still being checked, the next attempts wait for one instead of being refused, so a burst of correct
 * sign-ins from one address (a school behind one address) is only slowed down.
 */
export interface FailureLimiter {
  /**
   * Waits for a place. Resolves to `end`, to call once the outcome is known (`end(true)` counts a failure,
   * `end(false)` gives the place back), or to null when the key has used up its limit in the current window, or
   * when it waited too long.
   */
  begin(key: string): Promise<((failed: boolean) => void) | null>;
}

interface FailureEntry {
  failures: number;
  resetAt: number;
  /** Attempts holding a place while they are checked. */
  checking: number;
  waiting: Set<() => void>;
}

export function createFailureLimiter(
  limit: number,
  windowMs: number,
  { maxWaitMs = 15_000, maxWaiting = 1000 }: { maxWaitMs?: number; maxWaiting?: number } = {},
): FailureLimiter {
  const entries = new Map<string, FailureEntry>();
  const entryFor = (key: string): FailureEntry => {
    const t = Date.now();
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size > 10_000) {
        for (const [k, e] of entries) if (e.resetAt <= t && e.checking === 0 && e.waiting.size === 0) entries.delete(k);
      }
      entry = { failures: 0, resetAt: t + windowMs, checking: 0, waiting: new Set() };
      entries.set(key, entry);
    } else if (entry.resetAt <= t) {
      entry.failures = 0;
      entry.resetAt = t + windowMs;
    }
    return entry;
  };
  return {
    async begin(key) {
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        const entry = entryFor(key);
        if (entry.failures >= limit) return null;
        if (entry.failures + entry.checking < limit) {
          entry.checking += 1;
          let ended = false;
          return (failed) => {
            if (ended) return;
            ended = true;
            entry.checking -= 1;
            if (failed) entry.failures += 1;
            // Everyone waiting checks again: one may take the place, or all learn that the limit is used up.
            for (const wake of [...entry.waiting]) wake();
          };
        }
        const wait = deadline - Date.now();
        if (wait <= 0 || entry.waiting.size >= maxWaiting) return null;
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            entry.waiting.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, wait);
          entry.waiting.add(wake);
        });
      }
    },
  };
}
