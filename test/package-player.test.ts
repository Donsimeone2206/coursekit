import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_FLAGS } from '../src/server/packages/content-routes.js';

// The parts of the SCORM 2004 player that need no React (src/web/pages/activities/package-player.ts), with
// stand-ins for the browser's windows. The module is web code (DOM types), so it is imported by path.

interface Handlers {
  root(): any;
  initialize(sid: string, source: any): void;
  navigateAck(sid: string): void;
  terminate(sid: string): void;
  progress(): void;
  sync(): void;
}
interface PlayerModule {
  SANDBOX: string;
  REFRESH_DELAY_MS: number;
  listenToPackage(target: any, handlers: () => Handlers): () => void;
  showInWindow(win: any, url: string, title: string): any;
  clearWindow(win: any): void;
  windowLost(win: any, frame: any): boolean;
}

let m: PlayerModule;
beforeAll(async () => {
  m = await import(/* @vite-ignore */ fileURLToPath(new URL('../src/web/pages/activities/package-player.ts', import.meta.url)));
});
beforeEach(() => {
  vi.stubGlobal('location', { href: 'http://localhost/courses/c/activities/a' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The about:blank document of a window the player opened: enough DOM for showInWindow. */
function fakeDocument() {
  const doc: any = {
    title: '',
    body: {
      style: {},
      children: [] as any[],
      appendChild(el: any) {
        el.isConnected = true;
        this.children.push(el);
      },
    },
    getElementById: (id: string) => doc.body.children.find((el: any) => el.id === id) ?? null,
    createElement: (tagName: string) => ({
      tagName: tagName.toUpperCase(),
      ownerDocument: doc,
      isConnected: false,
      style: {},
      attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
      remove() {
        this.isConnected = false;
        doc.body.children = doc.body.children.filter((el: any) => el !== this);
      },
    }),
  };
  return doc;
}

/** A window opened with window.open('about:blank'): records any navigation of the window itself. */
function fakeWindow() {
  const navigations: string[] = [];
  const win: any = {
    closed: false,
    document: fakeDocument(),
    location: {
      set href(url: string) {
        navigations.push(url);
      },
      assign: (url: string) => navigations.push(url),
      replace: (url: string) => navigations.push(url),
    },
  };
  win.parent = win;
  return { win, navigations };
}

describe('display "window"', () => {
  it('frames each part in the activity window with the content sandbox, and never sends the window to the content', () => {
    expect(m.SANDBOX).toBe(SANDBOX_FLAGS);
    const { win, navigations } = fakeWindow();
    const doc = win.document;

    const first = m.showInWindow(win, '/content/t1/sco.html', 'Golf');
    expect(first).toMatchObject({ tagName: 'IFRAME', src: 'http://localhost/content/t1/sco.html', title: 'Golf', isConnected: true });
    expect(first.attributes).toEqual({ sandbox: SANDBOX_FLAGS, allow: 'fullscreen; autoplay' });
    expect(doc.body.children).toEqual([first]);
    expect(doc.title).toBe('Golf');

    // Before the next part opens, only the frame goes: its page sends its last data as it unloads.
    m.clearWindow(win);
    expect(first.isConnected).toBe(false);
    expect(doc.body.children).toEqual([]);
    const second = m.showInWindow(win, '/content/t2/sco.html', 'Golf');
    expect(second.src).toBe('http://localhost/content/t2/sco.html');
    expect(doc.body.children).toEqual([second]);
    // Showing a part again starts it in a new frame.
    const again = m.showInWindow(win, '/content/t2/sco.html', 'Golf');
    expect(doc.body.children).toEqual([again]);
    expect(second.isConnected).toBe(false);

    expect(navigations).toEqual([]);
  });

  it('notices when the window is closed, reloaded or shows another site', () => {
    expect(m.windowLost(null, null)).toBe(true);
    expect(m.showInWindow(null, '/content/t/sco.html', 'Golf')).toBeNull();

    const { win } = fakeWindow();
    const frame = m.showInWindow(win, '/content/t/sco.html', 'Golf');
    expect(m.windowLost(win, frame)).toBe(false);
    expect(m.windowLost(win, null)).toBe(false);

    // Reloaded: a new about:blank document without the frame. The window itself can show the part again.
    win.document = fakeDocument();
    expect(m.windowLost(win, frame)).toBe(true);
    expect(m.windowLost(win, null)).toBe(false);
    const shown = m.showInWindow(win, '/content/t/sco.html', 'Golf');
    expect(win.document.body.children).toEqual([shown]);
    expect(m.windowLost(win, shown)).toBe(false);

    // Another site: its document can't be read.
    Object.defineProperty(win, 'document', {
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(m.windowLost(win, shown)).toBe(true);
    expect(m.showInWindow(win, '/content/t/sco.html', 'Golf')).toBeNull();
    expect(() => m.clearWindow(win)).not.toThrow();

    const closed = fakeWindow().win;
    closed.closed = true;
    expect(m.windowLost(closed, null)).toBe(true);
    expect(m.showInWindow(closed, '/content/t/sco.html', 'Golf')).toBeNull();
  });
});

describe("the run-time's messages", () => {
  // The SCO's page, framed inside the activity's window (or the player's frame), and the window it lives in.
  const shell: any = {};
  shell.parent = shell;
  const content: any = { parent: shell };
  const other: any = {};
  other.parent = other;

  function fakeTarget() {
    const listeners = new Set<(event: any) => void>();
    return {
      listeners,
      addEventListener: (_type: string, fn: (event: any) => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: (event: any) => void) => listeners.delete(fn),
      send(data: unknown, source: any = content) {
        for (const fn of listeners) fn({ data, source });
      },
    };
  }
  function handlers(tag: string, calls: string[]): Handlers {
    return {
      root: () => shell,
      initialize: (sid, source) => calls.push(`initialize ${sid} ${source === content ? 'content' : '?'} ${tag}`),
      navigateAck: (sid) => calls.push(`ack ${sid} ${tag}`),
      terminate: (sid) => calls.push(`terminate ${sid} ${tag}`),
      progress: () => calls.push(`progress ${tag}`),
      sync: () => calls.push(`sync ${tag}`),
    };
  }
  const message = (type: string, sid = 's1') => ({ source: 'coursekit-package', type, sid });

  it('refreshes once after the last commit, also when the player renders again in between', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let current = handlers('first', calls);
    const target = fakeTarget();
    const stop = m.listenToPackage(target, () => current);

    target.send(message('commit'));
    // The commit refetches the page's data, and the page renders the player again with new callbacks.
    current = handlers('second', calls);
    vi.advanceTimersByTime(1000);
    target.send(message('commit'));
    vi.advanceTimersByTime(m.REFRESH_DELAY_MS - 1);
    expect(calls).toEqual(['progress first', 'progress second']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['progress first', 'progress second', 'sync second']);
    expect(target.listeners.size).toBe(1);

    // Closing the player stops listening and drops a refresh on its way.
    target.send(message('commit'));
    stop();
    vi.advanceTimersByTime(10 * m.REFRESH_DELAY_MS);
    expect(calls).toEqual(['progress first', 'progress second', 'sync second', 'progress second']);
    expect(target.listeners.size).toBe(0);
  });

  it('takes messages only from the content, and syncs right away when the SCO terminates', () => {
    const calls: string[] = [];
    const target = fakeTarget();
    m.listenToPackage(target, () => handlers('h', calls));

    target.send(message('initialize'));
    target.send(message('initialize', 's2'), other);
    target.send({ ...message('initialize'), source: 'someone-else' });
    target.send({ source: 'coursekit-package', type: 'commit' }); // no session id
    target.send(null);
    target.send(message('navigate-ack'));
    target.send(message('terminate'));
    expect(calls).toEqual(['initialize s1 content h', 'ack s1 h', 'terminate s1 h', 'progress h', 'sync h']);
  });
});
