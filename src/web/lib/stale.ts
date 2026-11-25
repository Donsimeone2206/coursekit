// After an upgrade, a tab still running the old build asks for page files that no longer exist.
// reloadForNewVersion() reloads the tab to pick up the new build. Limits keep a file that is really
// missing (or a server that keeps switching builds mid-deploy) from reloading the tab forever; once a
// limit is reached the error screen shows instead, with its own Reload button:
//  - each build reloads at most once per tab within WINDOW_MS;
//  - a tab reloads at most MAX_RELOADS times within WINDOW_MS, whichever builds they were for.
// The cost: if a passing network error already used up a build's reload, a deploy within WINDOW_MS
// of it shows the error screen rather than reloading on its own.

const KEY = 'ck-update-reloads';
const WINDOW_MS = 5 * 60_000;
const MAX_RELOADS = 3;
/** If the page is still here this long after asking for a reload, the reload was cancelled (Stop, Esc). */
const RELOAD_TIMEOUT_MS = 10_000;

/** Identifies the running build: the entry file's URL has a content hash that changes with every build. */
const BUILD = import.meta.url;

interface Reload {
  build: string;
  at: number;
}

let reloadPending = false;

/** Reloads the tab for a newer build and returns true, or returns false when a limit says to show the error. */
export function reloadForNewVersion(): boolean {
  // A reload is already on its way: keep the current screen (e.g. the page spinner) until it happens.
  if (reloadPending) return true;
  const now = Date.now();
  try {
    const recent = recentReloads(sessionStorage.getItem(KEY), now);
    if (recent.length >= MAX_RELOADS || recent.some((r) => r.build === BUILD)) return false;
    sessionStorage.setItem(KEY, JSON.stringify([...recent, { build: BUILD, at: now }]));
  } catch {
    // Without storage, one reload can't be told from the next: show the error rather than risk a loop.
    return false;
  }
  reloadPending = true;
  setTimeout(() => (reloadPending = false), RELOAD_TIMEOUT_MS);
  window.location.reload();
  return true;
}

/** Waits for the reload that reloadForNewVersion() asked for. If it never comes, fails with `error`. */
export function waitForReload(error: unknown): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), RELOAD_TIMEOUT_MS));
}

function recentReloads(stored: string | null, now: number): Reload[] {
  let list: unknown;
  try {
    list = JSON.parse(stored ?? '[]');
  } catch {
    return []; // damaged: start over
  }
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Reload => typeof r?.build === 'string' && typeof r.at === 'number' && now - r.at < WINDOW_MS);
}
