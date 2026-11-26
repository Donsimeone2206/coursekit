import {
  ArrowLeft,
  ArrowRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  ExternalLink,
  Flag,
  ListTree,
  LogOut,
  Save,
  SkipForward,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { PackageNavRequest, PackageSequencingInfo, PackageTocEntry } from '@shared/package-sequencing';
import type { PackageLaunch } from '@shared/packages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { clearWindow, listenToPackage, SANDBOX, showInWindow, windowLost, type PackageMessageHandlers } from './package-player';

interface Session {
  sid: string;
  source: MessageEventSource | null;
  /** Initialized and not terminated yet. */
  live: boolean;
}

interface Shown {
  url: string;
  deliveryId: string | null;
  key: number;
}

function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function StatusIcon({ entry }: { entry: PackageTocEntry }) {
  if (entry.successStatus === 'failed') return <CircleX className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />;
  if (entry.successStatus === 'passed' || entry.completionStatus === 'completed') {
    return <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Done" />;
  }
  if (entry.suspended) return <CirclePause className="size-3.5 shrink-0 text-amber-600" aria-label="Paused" />;
  if (entry.attempted) return <CircleDashed className="size-3.5 shrink-0 text-primary" aria-label="In progress" />;
  return <Circle className="size-3.5 shrink-0 opacity-40" aria-label="Not started" />;
}

function Contents({ toc, busy, onChoose }: { toc: PackageTocEntry[]; busy: boolean; onChoose: (id: string) => void }) {
  return (
    <nav className="space-y-0.5" aria-label="Table of contents">
      {toc
        .filter((e) => e.visible)
        .map((e) => {
          const indent = { paddingLeft: 8 + e.depth * 12 };
          if (!e.leaf) {
            return e.canChoose ? (
              <button
                key={e.id}
                type="button"
                onClick={() => onChoose(e.id)}
                disabled={busy}
                style={indent}
                className="block w-full truncate rounded-lg pt-2 pb-1 pr-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground"
              >
                {e.title}
              </button>
            ) : (
              <p
                key={e.id}
                style={indent}
                className="truncate pt-2 pb-1 pr-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
              >
                {e.title}
              </p>
            );
          }
          const body = (
            <>
              <StatusIcon entry={e} />
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              {e.score != null && <span className="shrink-0 text-[11px] tabular-nums opacity-80">{Math.round(e.score)}%</span>}
            </>
          );
          const classes = 'flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px]';
          if (e.current) {
            return (
              <div key={e.id} style={indent} aria-current="step" className={cn(classes, 'bg-primary/10 font-medium text-primary')}>
                {body}
              </div>
            );
          }
          return (
            <button
              key={e.id}
              type="button"
              disabled={!e.canChoose || busy}
              onClick={() => onChoose(e.id)}
              style={indent}
              title={e.canChoose ? undefined : "This part can't be opened from here right now."}
              className={cn(
                classes,
                'text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default disabled:opacity-50',
              )}
            >
              {body}
            </button>
          );
        })}
    </nav>
  );
}

function Summary({ info, onClose }: { info: PackageSequencingInfo; onClose: () => void }) {
  const finished = info.ended;
  return (
    <div className="grid min-h-[320px] place-items-center p-8 text-center">
      <div className="max-w-md space-y-4">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          {finished ? <Flag className="size-5" /> : <Save className="size-5" />}
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">{finished ? "You've finished this attempt" : 'Your progress is saved'}</h2>
          <p className="text-sm text-muted-foreground">
            {finished ? 'Your result is recorded.' : 'Open the activity again whenever you like: you carry on exactly where you left off.'}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {info.completionStatus === 'completed' ? (
            <Badge variant="success">Completed</Badge>
          ) : (
            <Badge variant="neutral">{info.completionStatus === 'incomplete' ? 'Not complete yet' : 'Not started'}</Badge>
          )}
          {info.successStatus === 'passed' && <Badge variant="success">Passed</Badge>}
          {info.successStatus === 'failed' && <Badge variant="danger">Failed</Badge>}
          {info.score != null && <Badge variant="neutral">Score {Math.round(info.score * 10) / 10}%</Badge>}
          {info.totalSeconds > 0 && <Badge variant="neutral">{duration(info.totalSeconds)}</Badge>}
        </div>
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

/**
 * The player for SCORM 2004 attempts: the server runs the sequencing rules, and this shows what it
 * delivers, the table of contents and the navigation the rules allow. Learner requests close the SCO's
 * page first (after telling its run-time), so its last data counts before the next part opens.
 */
export function SequencedPlayer({
  activityId,
  launch: initial,
  title,
  popup,
  onClose,
  onProgress,
}: {
  activityId: string;
  launch: PackageLaunch;
  title: string;
  /** Display "window": the content goes to this window; the page keeps the controls. */
  popup: Window | null;
  onClose: () => void;
  onProgress: () => void;
}) {
  const [launch, setLaunch] = useState(initial);
  const [shown, setShown] = useState<Shown | null>(
    initial.url ? { url: initial.url, deliveryId: initial.sequencing?.deliveryId ?? null, key: 0 } : null,
  );
  const [busy, setBusy] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [windowClosed, setWindowClosed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const popupRef = useRef<Window | null>(popup);
  /** Display "window": the frame the content plays in, inside popupRef's window. */
  const popupFrame = useRef<HTMLIFrameElement | null>(null);
  const session = useRef<Session | null>(null);
  const acks = useRef(new Map<string, () => void>());
  const latest = useRef(0);
  const busyRef = useRef(false);
  /** The delivery the server last said is open: every request says it was made for that one. */
  const deliveryRef = useRef<string | null>(initial.sequencing?.deliveryId ?? null);
  const info = launch.sequencing!;
  const attemptId = launch.attemptId!;
  const windowMode = launch.display === 'window';

  const apply = useCallback(
    (next: PackageLaunch, reload: boolean) => {
      // The attempt can't be played here any more (the course was archived, for example): leave the player.
      if (!next.sequencing) return onClose();
      deliveryRef.current = next.sequencing.deliveryId;
      setLaunch(next);
      setShown((prev) => {
        const deliveryId = next.sequencing?.deliveryId ?? null;
        if (!next.url) return null;
        if (!reload && prev && prev.deliveryId === deliveryId) return prev; // the same delivery stays as it is
        return { url: next.url, deliveryId, key: (prev?.key ?? 0) + 1 };
      });
    },
    [onClose],
  );

  // A request made for a delivery another window has moved on from changes nothing on the server:
  // it answers with where the attempt is now, and the player catches up.
  const post = useCallback(
    (body: { nav: PackageNavRequest; itemId?: string; sid?: string }) =>
      api.post<PackageLaunch>(`/packages/${activityId}/launch`, { attemptId, deliveryId: deliveryRef.current, ...body }),
    [activityId, attemptId],
  );

  /** Fetches what is open now (after the SCO saved or finished). */
  const sync = useCallback(async () => {
    if (busyRef.current) return;
    const id = ++latest.current;
    try {
      const next = await post({ nav: '_none_' });
      if (id === latest.current && !busyRef.current) apply(next, false);
    } catch {
      // the next save or click tries again
    }
  }, [apply, post]);

  /** Asks the SCO's run-time to treat the coming page close as the player's navigation (waits up to 400 ms). */
  const handshake = useCallback((s: Session) => {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 400);
      acks.current.set(s.sid, () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        (s.source as Window).postMessage({ source: 'coursekit-player', type: 'navigate' }, '*');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }, []);

  const request = useCallback(
    async (nav: PackageNavRequest, itemId?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setTocOpen(false);
      const id = ++latest.current;
      try {
        const live = session.current?.live ? session.current : null;
        if (live) {
          await handshake(live);
          // Close the SCO's page: it saves as it goes, and the server waits for that last commit.
          setShown(null);
          // In the activity's window only the content's frame goes: the window stays on Coursekit's page.
          clearWindow(popupRef.current);
          popupFrame.current = null;
          session.current = null;
        }
        const next = await post({ nav, ...(itemId ? { itemId } : {}), ...(live ? { sid: live.sid } : {}) });
        if (id !== latest.current) return;
        apply(next, !!live);
        if (next.sequencing?.message && next.url) toast(next.sequencing.message);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
        onProgress();
      }
    },
    [apply, handshake, onProgress, post],
  );

  // One listener while the player is open: the page passes new callbacks on most renders (after each
  // refetch), and listening again would drop the refresh a commit asked for. It reads the latest ones here.
  const handlers = useRef<PackageMessageHandlers | null>(null);
  useEffect(() => {
    handlers.current = {
      root: () => (windowMode ? popupRef.current : frame.current?.contentWindow),
      initialize: (sid, source) => {
        session.current = { sid, source, live: true };
      },
      navigateAck: (sid) => acks.current.get(sid)?.(),
      terminate: (sid) => {
        if (session.current?.sid === sid) session.current.live = false;
      },
      progress: onProgress,
      sync: () => void sync(),
    };
  });
  useEffect(() => listenToPackage(window, () => handlers.current!), []);

  // A new page has no SCO session until its content calls Initialize.
  const shownKey = shown?.key;
  useEffect(() => {
    session.current = null;
  }, [shownKey]);

  // Window display: each new delivery opens in the activity's window, framed as in the embedded player.
  useEffect(() => {
    if (!windowMode || !shown) return;
    popupFrame.current = showInWindow(popupRef.current, shown.url, title);
    setWindowClosed(!popupFrame.current);
  }, [shown, title, windowMode]);
  useEffect(() => {
    if (!windowMode) return;
    const timer = setInterval(() => {
      if (windowLost(popupRef.current, popupFrame.current)) setWindowClosed(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [windowMode]);

  const reopenWindow = () => {
    if (!shown) return;
    // The window may still be open (the learner reloaded it, say): show the part there again.
    if (windowLost(popupRef.current, null)) popupRef.current = window.open('about:blank', '_blank');
    popupFrame.current = showInWindow(popupRef.current, shown.url, title);
    setWindowClosed(!popupFrame.current);
    popupRef.current?.focus();
  };

  const visibleToc = info.toc.filter((e) => e.visible);
  const showToc = visibleToc.length > 1;
  const current = info.toc.find((e) => e.current);
  const c = info.controls;
  const exitOptions = c.suspendAll || c.exit || c.exitAll;
  const over = info.ended || info.suspended;

  const contents = <Contents toc={info.toc} busy={busy} onChoose={(id) => void request('choice', id)} />;

  let body;
  if (over) body = <Summary info={info} onClose={onClose} />;
  else if (shown && !windowMode) {
    body = (
      <iframe
        key={shown.key}
        ref={frame}
        src={shown.url}
        title={current?.title ?? title}
        sandbox={SANDBOX}
        allow="fullscreen; autoplay"
        className="h-[75vh] min-h-[420px] w-full bg-white"
      />
    );
  } else if (shown) {
    body = (
      <div className="grid min-h-[240px] place-items-center p-8 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-sm text-muted-foreground">
            {windowClosed
              ? 'The activity window is closed. Open it again to carry on.'
              : 'The activity is open in its own window. Use the buttons here to move between its parts.'}
          </p>
          {windowClosed && (
            <Button onClick={reopenWindow}>
              <ExternalLink /> Open the activity window
            </Button>
          )}
        </div>
      </div>
    );
  } else if (busy) {
    body = (
      <div className="grid min-h-[320px] place-items-center p-8 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Spinner /> Opening…
        </span>
      </div>
    );
  } else {
    body = (
      <div className="grid min-h-[320px] place-items-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <p className="font-medium">{info.message ?? 'Choose what to open next.'}</p>
          <p className="text-sm text-muted-foreground">
            {showToc ? 'Pick a part from the contents' : 'Use the buttons above'}
            {c.continue ? ', or press Continue.' : '.'}
          </p>
          {showToc && <div className="pt-3 text-left lg:hidden">{contents}</div>}
        </div>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* On phones the title and Close share the first row, and the controls wrap onto the next. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{current?.title ?? title}</p>
        {!over && (
          <div className="flex flex-wrap items-center gap-2 max-sm:order-last max-sm:w-full">
            {showToc && (
              <Button size="sm" variant="ghost" className="lg:hidden" aria-expanded={tocOpen} onClick={() => setTocOpen((o) => !o)}>
                <ListTree /> Contents
              </Button>
            )}
            {c.previous && (
              <Button size="sm" variant="ghost" onClick={() => void request('previous')} disabled={busy}>
                <ArrowLeft /> Previous
              </Button>
            )}
            {c.continue && (
              <Button size="sm" variant="ghost" onClick={() => void request('continue')} disabled={busy}>
                Continue <ArrowRight />
              </Button>
            )}
            {exitOptions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <LogOut /> Exit
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64">
                  {c.suspendAll && (
                    <DropdownMenuItem onSelect={() => void request('suspendAll')}>
                      <Save />
                      <div>
                        <p className="font-medium">Suspend</p>
                        <p className="text-xs text-muted-foreground">Save and close; carry on later where you left off.</p>
                      </div>
                    </DropdownMenuItem>
                  )}
                  {c.exit && (
                    <DropdownMenuItem onSelect={() => void request('exit')}>
                      <SkipForward />
                      <div>
                        <p className="font-medium">Exit this part</p>
                        <p className="text-xs text-muted-foreground">Leave it and choose what to open next.</p>
                      </div>
                    </DropdownMenuItem>
                  )}
                  {c.exitAll && (
                    <DropdownMenuItem onSelect={() => void request('exitAll')}>
                      <Flag />
                      <div>
                        <p className="font-medium">Exit all</p>
                        <p className="text-xs text-muted-foreground">Finish this attempt and see your result.</p>
                      </div>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close the player">
          <X />
        </Button>
      </div>
      {tocOpen && showToc && !over && <div className="border-b p-2 lg:hidden">{contents}</div>}
      <div className={cn('grid', showToc && !over && 'lg:grid-cols-[240px_1fr]')}>
        {showToc && !over && <aside className="hidden border-r p-2 lg:block">{contents}</aside>}
        <div className="min-w-0">{body}</div>
      </div>
    </Card>
  );
}
