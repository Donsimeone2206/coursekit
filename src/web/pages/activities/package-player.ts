/**
 * The parts of the SCORM 2004 player (SequencedPlayer) that need no React: listening to the run-time's
 * messages, and showing the content in the activity's own window (display "window").
 */

/** The sandbox for package content: scripts run, but never with Coursekit's origin (no allow-same-origin). */
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** How long after the SCO's last commit the player asks the server what is open now. */
export const REFRESH_DELAY_MS = 1500;

const FRAME_ID = 'coursekit-package-frame';

/** True when a message comes from `root` or a frame nested inside it. */
export function fromWindow(source: MessageEventSource | null, root: Window | null | undefined): boolean {
  let win = source as Window | null;
  for (let i = 0; win && root && i < 10; i++) {
    if (win === root) return true;
    if (win.parent === win) break;
    win = win.parent;
  }
  return false;
}

export interface PackageMessageHandlers {
  /** The window the content plays in: the player's frame, or the activity's window. Messages from others are ignored. */
  root(): Window | null | undefined;
  initialize(sid: string, source: MessageEventSource | null): void;
  navigateAck(sid: string): void;
  terminate(sid: string): void;
  /** The SCO saved: what the page shows about progress may be out of date. */
  progress(): void;
  /** Asks the server what is open now. */
  sync(): void;
}

/**
 * Listens to the run-time's messages until the returned function is called. A commit asks for a refresh
 * REFRESH_DELAY_MS after the SCO's last one. `handlers` is read for each message and when the refresh runs,
 * so the player passes its latest callbacks without listening again, which would drop a pending refresh.
 */
export function listenToPackage(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  handlers: () => PackageMessageHandlers,
): () => void {
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (event: MessageEvent) => {
    const h = handlers();
    if (!fromWindow(event.source, h.root())) return;
    const data = event.data as { source?: string; type?: string; sid?: string } | null;
    if (!data || data.source !== 'coursekit-package' || typeof data.sid !== 'string') return;
    if (data.type === 'initialize') h.initialize(data.sid, event.source);
    else if (data.type === 'navigate-ack') h.navigateAck(data.sid);
    else if (data.type === 'commit') {
      h.progress();
      clearTimeout(refresh);
      refresh = setTimeout(() => handlers().sync(), REFRESH_DELAY_MS);
    } else if (data.type === 'terminate') {
      h.terminate(data.sid);
      h.progress();
      h.sync();
    }
  };
  target.addEventListener('message', onMessage);
  return () => {
    target.removeEventListener('message', onMessage);
    clearTimeout(refresh);
  };
}

/**
 * Display "window": shows the content in the activity's window, in a frame with the embedded player's sandbox,
 * and returns that frame (null when the window is closed or no longer shows Coursekit's page).
 *
 * The window itself stays on the page it opened with (about:blank, Coursekit's origin). Sending the window to
 * the content would cut it off from the player: under Cross-Origin-Opener-Policy same-origin, the content's
 * opaque origin moves it to another browsing context group, so the player's handle reads as closed and the
 * run-time's messages (sent to the opener of its top window) never arrive.
 */
export function showInWindow(win: Window | null, url: string, title: string): HTMLIFrameElement | null {
  try {
    if (!win || win.closed) return null;
    const doc = win.document; // throws when the window shows another site
    doc.getElementById(FRAME_ID)?.remove();
    doc.title = title;
    doc.body.style.margin = '0';
    const frame = doc.createElement('iframe');
    frame.id = FRAME_ID;
    frame.title = title;
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', 'fullscreen; autoplay');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff';
    frame.src = new URL(url, location.href).href;
    doc.body.appendChild(frame);
    return frame;
  } catch {
    return null;
  }
}

/** Closes the content's page in the activity's window (it sends its last data as it goes); the window stays open. */
export function clearWindow(win: Window | null): void {
  try {
    if (win && !win.closed) win.document.getElementById(FRAME_ID)?.remove();
  } catch {
    // the window shows another site
  }
}

/** True when the activity's window can't show `frame` any more: closed, reloaded or showing another site. */
export function windowLost(win: Window | null, frame: HTMLIFrameElement | null): boolean {
  try {
    if (!win || win.closed) return true;
    return !!frame && (frame.ownerDocument !== win.document || !frame.isConnected);
  } catch {
    return true;
  }
}
