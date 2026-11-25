import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

// The reload guard for tabs left open across an upgrade (src/web/lib/stale.ts). It tells builds apart by
// import.meta.url, so each simulated build is a copy of the module at its own path, the way each real
// build's entry file has its own hashed name. loadPage() is a page load in the same tab: module state
// starts over, session storage carries on.

interface StaleModule {
  reloadForNewVersion(): boolean;
  waitForReload(error: unknown): Promise<never>;
}

const KEY = 'ck-update-reloads';
const MINUTE = 60_000;
const builds = mkdtempSync(join(tmpdir(), 'coursekit-builds-'));
const reload = vi.fn();
let store: Map<string, string>;

async function loadPage(build = 'a'): Promise<StaleModule> {
  const file = join(builds, build, 'stale.ts');
  if (!existsSync(file)) {
    mkdirSync(join(builds, build));
    copyFileSync(new URL('../src/web/lib/stale.ts', import.meta.url), file);
  }
  vi.resetModules();
  return import(/* @vite-ignore */ file);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-01-01T09:00:00Z') });
  store = new Map();
  reload.mockReset();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  vi.stubGlobal('window', { location: { reload } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => rmSync(builds, { recursive: true, force: true }));

it('reloads once for a missing page file, then shows the error if the same build comes back', async () => {
  let page = await loadPage();
  expect(page.reloadForNewVersion()).toBe(true);
  expect(page.reloadForNewVersion()).toBe(true); // a second failure while the reload is on its way
  expect(reload).toHaveBeenCalledTimes(1);

  page = await loadPage();
  expect(page.reloadForNewVersion()).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reloads for each upgrade while the tab stays open', async () => {
  expect((await loadPage('a')).reloadForNewVersion()).toBe(true);
  expect((await loadPage('b')).reloadForNewVersion()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('stops when the server alternates between builds', async () => {
  expect((await loadPage('a')).reloadForNewVersion()).toBe(true);
  expect((await loadPage('b')).reloadForNewVersion()).toBe(true);
  expect((await loadPage('a')).reloadForNewVersion()).toBe(false);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('allows three reloads in five minutes, whichever builds they were for', async () => {
  for (const build of ['a', 'b', 'c']) {
    expect((await loadPage(build)).reloadForNewVersion()).toBe(true);
    vi.advanceTimersByTime(MINUTE);
  }
  expect((await loadPage('d')).reloadForNewVersion()).toBe(false);

  vi.advanceTimersByTime(2 * MINUTE); // the reload for build a is now five minutes old
  expect((await loadPage('d')).reloadForNewVersion()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(4);
});

it('reloads the same build again after five minutes', async () => {
  (await loadPage()).reloadForNewVersion();
  vi.advanceTimersByTime(5 * MINUTE);
  expect((await loadPage()).reloadForNewVersion()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('shows the error when the reload is cancelled', async () => {
  const page = await loadPage();
  const error = new Error('Failed to fetch dynamically imported module');
  expect(page.reloadForNewVersion()).toBe(true);
  let failed = false;
  const waiting = page.waitForReload(error).catch((err: unknown) => ((failed = true), err));

  await vi.advanceTimersByTimeAsync(9_999);
  expect(failed).toBe(false); // the reload may still come
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toBe(error);
  // The page is still here, so the reload never happened: later failures show the error too.
  expect(page.reloadForNewVersion()).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('ignores a damaged stored value', async () => {
  store.set(KEY, 'not json');
  expect((await loadPage()).reloadForNewVersion()).toBe(true);
  expect(JSON.parse(store.get(KEY)!)).toHaveLength(1);
});

it('never reloads without session storage', async () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('SecurityError');
    },
  });
  expect((await loadPage()).reloadForNewVersion()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
