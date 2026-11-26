import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleCheck, Clock, Eye, ListTree, Package, Play, RotateCcw, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  PACKAGE_KIND_LABELS,
  type PackageAttemptInfo,
  type PackageLaunch,
  type PackageLaunchInput,
  type PackagePlayerInfo,
  type PackageReport,
  type PackageVersionInfo,
} from '@shared/packages';
import type { ActivityDetail } from '@shared/types';
import { FileDrop } from '@/components/common';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn, formatBytes, formatDate, formatRelative, plural } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { ActivityFrame } from './frame';

/** The sandbox for package content: scripts run, but never with Coursekit's origin (no allow-same-origin). */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

function duration(seconds: number): string {
  if (!seconds) return '–';
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function kindLabel(v: PackageVersionInfo) {
  return `${PACKAGE_KIND_LABELS[v.kind]}${v.edition ? ` ${v.edition} edition` : ''}`;
}

function StatusBadge({ attempt }: { attempt: PackageAttemptInfo }) {
  if (attempt.successStatus === 'passed') return <Badge variant="success">Passed</Badge>;
  if (attempt.successStatus === 'failed') return <Badge variant="danger">Failed</Badge>;
  if (attempt.completionStatus === 'completed') return <Badge variant="success">Completed</Badge>;
  if (attempt.status === 'in_progress') return <Badge variant="info">In progress</Badge>;
  return <Badge variant="neutral">Not started</Badge>;
}

const percent = (score: number | null) => (score == null ? '–' : `${Math.round(score * 10) / 10}%`);

/** True when a message comes from the player frame or a frame nested inside it. */
function fromFrame(source: MessageEventSource | null, frame: Window | null | undefined): boolean {
  let win = source as Window | null;
  for (let i = 0; win && frame && i < 10; i++) {
    if (win === frame) return true;
    if (win.parent === win) break;
    win = win.parent;
  }
  return false;
}

function Player({
  launch,
  title,
  onLaunch,
  onClose,
  onProgress,
}: {
  launch: PackageLaunch;
  title: string;
  onLaunch: (input: PackageLaunchInput) => void;
  onClose: () => void;
  onProgress: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const items = launch.items.filter((i) => i.launchable);
  const index = items.findIndex((i) => i.id === launch.itemId);
  const go = useCallback(
    (itemId: string | undefined) => {
      if (itemId) onLaunch({ itemId, ...(launch.attemptId ? { attemptId: launch.attemptId } : { preview: true }) });
    },
    [launch.attemptId, onLaunch],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!fromFrame(event.source, frame.current?.contentWindow)) return;
      const data = event.data as { source?: string; type?: string; nav?: string } | null;
      if (!data || data.source !== 'coursekit-package') return;
      onProgress();
      if (data.type !== 'terminate' || !data.nav) return;
      const target = /^\{target=([^}]+)\}(choice|jump)$/.exec(data.nav)?.[1];
      if (data.nav === 'continue') go(items[index + 1]?.id);
      else if (data.nav === 'previous') go(items[index - 1]?.id);
      else if (target) go(items.find((i) => i.id === target)?.id);
      else if (['exit', 'exitAll', 'suspendAll', 'abandon', 'abandonAll'].includes(data.nav)) onClose();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [go, index, items, onClose, onProgress]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {items[index]?.title ?? title}
          {launch.mode !== 'normal' && (
            <Badge variant="warning" className="ml-2">
              {launch.mode === 'review' ? 'Review: nothing is recorded' : 'Preview: nothing is recorded'}
            </Badge>
          )}
        </p>
        {items.length > 1 && (
          <>
            <Button size="sm" variant="ghost" disabled={index <= 0} onClick={() => go(items[index - 1]?.id)}>
              <ArrowLeft /> Previous
            </Button>
            <Button size="sm" variant="ghost" disabled={index >= items.length - 1} onClick={() => go(items[index + 1]?.id)}>
              Next <ArrowRight />
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          <X /> Exit
        </Button>
      </div>
      <div className={cn('grid', items.length > 1 && 'lg:grid-cols-[220px_1fr]')}>
        {items.length > 1 && (
          <nav className="hidden border-r p-2 lg:block" aria-label="Table of contents">
            {launch.items.map((item) =>
              item.launchable ? (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => go(item.id)}
                  style={{ paddingLeft: 10 + item.depth * 12 }}
                  className={cn(
                    'block w-full truncate rounded-lg py-1.5 pr-2 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground',
                    item.id === launch.itemId && 'bg-primary/10 font-medium text-primary',
                  )}
                >
                  {item.title}
                </button>
              ) : (
                <p
                  key={item.id}
                  style={{ paddingLeft: 10 + item.depth * 12 }}
                  className="pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  {item.title}
                </p>
              ),
            )}
          </nav>
        )}
        <iframe
          key={launch.url}
          ref={frame}
          src={launch.url}
          title={items[index]?.title ?? title}
          sandbox={SANDBOX}
          allow="fullscreen; autoplay"
          className="h-[75vh] min-h-[420px] w-full bg-white"
        />
      </div>
    </Card>
  );
}

function LearnerSummary({
  info,
  onLaunch,
  busy,
}: {
  info: PackagePlayerInfo;
  onLaunch: (input: PackageLaunchInput) => void;
  busy: boolean;
}) {
  const latest = info.attempts[info.attempts.length - 1];
  const limit = info.settings.attemptsAllowed;
  const finished = [...info.attempts].reverse().find((a) => a.status === 'finished');
  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {latest ? <StatusBadge attempt={latest} /> : <Badge variant="neutral">Not started</Badge>}
            {latest && (
              <span className="text-sm text-muted-foreground">
                Attempt {latest.attemptNumber}
                {limit ? ` of ${limit}` : ''}
              </span>
            )}
          </div>
          {info.grade && (
            <p className="text-sm">
              Your grade:{' '}
              <span className="font-semibold tabular-nums">
                {info.grade.score == null ? 'not graded yet' : `${info.grade.score} / ${info.grade.maxGrade}`}
              </span>
            </p>
          )}
          {info.resumeAttemptId && <p className="text-sm text-muted-foreground">You can pick up where you left off.</p>}
          {!info.canStartNew && !info.resumeAttemptId && limit > 0 && info.attempts.length >= limit && (
            <p className="text-sm text-muted-foreground">You've used all your attempts. You can still review them.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {finished && (
            <Button variant="outline" onClick={() => onLaunch({ attemptId: finished.id })} disabled={busy}>
              <Eye /> Review
            </Button>
          )}
          {info.resumeAttemptId ? (
            <Button onClick={() => onLaunch({ attemptId: info.resumeAttemptId! })} loading={busy}>
              <Play /> Continue
            </Button>
          ) : info.canStartNew ? (
            <Button onClick={() => onLaunch({ newAttempt: true })} loading={busy}>
              {info.attempts.length ? <RotateCcw /> : <Play />} {info.attempts.length ? 'Start a new attempt' : 'Start'}
            </Button>
          ) : null}
        </div>
      </CardContent>
      {info.attempts.length > 0 && (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-2.5 font-medium">Attempt</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Score</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Time spent</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Last opened</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {info.attempts.map((a) => (
                <tr key={a.id}>
                  <td className="px-5 py-2.5 tabular-nums">{a.attemptNumber}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge attempt={a} />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{percent(a.score)}</td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">{duration(a.totalSeconds)}</td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">{formatRelative(a.lastAccessedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ManagePackage({
  activity,
  info,
  onPreview,
  busy,
}: {
  activity: ActivityDetail;
  info: PackagePlayerInfo;
  onPreview: () => void;
  busy: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const importZip = useMutation({
    mutationFn: (fileId: string) => api.post<PackageVersionInfo>(`/packages/${activity.id}/import`, { fileId }),
    onSuccess: async (v) => {
      toast.success(`${kindLabel(v)} package uploaded (version ${v.version}).`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['package', activity.id] }), invalidate(activity.course.slug)]);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const v = info.current;
  return (
    <Card>
      <CardHeader
        icon={<Package className="size-4" />}
        title="Package"
        description={
          v
            ? 'Learners who already started keep the version they started with.'
            : 'Upload a SCORM 1.2, SCORM 2004 or xAPI (tincan.xml) zip.'
        }
        action={
          v && (
            <Button variant="outline" size="sm" onClick={onPreview} loading={busy}>
              <Eye /> Preview
            </Button>
          )
        }
      />
      <CardContent className="space-y-4">
        {v && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Title</dt>
              <dd className="font-medium">{v.title}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Type</dt>
              <dd>{kindLabel(v)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Version</dt>
              <dd>
                {v.version} · uploaded {formatDate(v.createdAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Contents</dt>
              <dd>
                {plural(v.fileCount, 'file')} · {formatBytes(v.totalBytes)} · {plural(v.items.filter((i) => i.launchable).length, 'part')}
              </dd>
            </div>
          </dl>
        )}
        {importZip.isPending ? (
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-sm text-muted-foreground">
            <Upload className="size-4" /> Checking and unpacking the package…
          </div>
        ) : (
          <FileDrop
            context="activity"
            courseId={activity.courseId}
            accept=".zip,application/zip"
            label={v ? 'Drop a new zip here to replace the package' : 'Drop the package zip here or click to upload'}
            onUploaded={(file) => importZip.mutate(file.id)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PackageReportCard({ activity }: { activity: ActivityDetail }) {
  const { data, isLoading } = useQuery({
    queryKey: ['package', activity.id, 'report'],
    queryFn: () => api.get<PackageReport>(`/packages/${activity.id}/report`),
  });
  if (isLoading) return <Skeleton className="h-48" />;
  if (!data) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ListTree className="size-4" />}
        title="Learner report"
        description="Attempts, scores and time spent for each student."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Student</th>
              <th className="px-3 py-3 font-medium">Attempts</th>
              <th className="hidden px-3 py-3 font-medium sm:table-cell">Grade</th>
              <th className="hidden px-3 py-3 font-medium md:table-cell">Time spent</th>
              <th className="hidden px-3 py-3 font-medium md:table-cell">Last opened</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.rows.map((r) => {
              const time = r.attempts.reduce((sum, a) => sum + a.totalSeconds, 0);
              const last = r.attempts.reduce<string | null>((max, a) => (!max || a.lastAccessedAt > max ? a.lastAccessedAt : max), null);
              return (
                <tr key={r.user.id} className="align-top">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar user={r.user} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {r.user.name} {r.completed && <CircleCheck className="inline size-3.5 text-success" aria-label="Completed" />}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{r.user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {r.attempts.length === 0 ? (
                      <span className="text-muted-foreground">Not started</span>
                    ) : (
                      <ul className="space-y-1">
                        {r.attempts.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="tabular-nums text-muted-foreground">#{a.attemptNumber}</span>
                            <StatusBadge attempt={a} />
                            <span className="tabular-nums">{percent(a.score)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="hidden px-3 py-3 tabular-nums sm:table-cell">
                    {r.grade == null ? <span className="text-muted-foreground">–</span> : `${r.grade} / ${data.maxGrade ?? '–'}`}
                  </td>
                  <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3.5" /> {duration(time)}
                    </span>
                  </td>
                  <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">{last ? formatRelative(last) : '–'}</td>
                </tr>
              );
            })}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                  No students are enrolled yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PackageView({ activity }: { activity: ActivityDetail<'package'> }) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const [player, setPlayer] = useState<PackageLaunch | null>(null);
  const [popup, setPopup] = useState(false);
  const { data: info, isLoading } = useQuery({
    queryKey: ['package', activity.id],
    queryFn: () => api.get<PackagePlayerInfo>(`/packages/${activity.id}`),
    refetchInterval: player || popup ? 15_000 : false,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['package', activity.id] });
    void invalidate(activity.course.slug);
  }, [qc, invalidate, activity.id, activity.course.slug]);

  const launch = useMutation({
    mutationFn: async (input: PackageLaunchInput & { win?: Window | null }) => {
      const { win, ...body } = input;
      try {
        const result = await api.post<PackageLaunch>(`/packages/${activity.id}/launch`, body);
        return { result, win };
      } catch (err) {
        win?.close();
        throw err;
      }
    },
    onSuccess: ({ result, win }) => {
      if (result.display === 'window') {
        if (win) win.location.href = result.url;
        else window.open(result.url, '_blank');
        setPopup(true);
        setPlayer(null);
      } else {
        setPlayer(result);
      }
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const start = (input: PackageLaunchInput) => {
    // A new window has to open in the click itself, or popup blockers stop it.
    const win = info?.settings.display === 'window' ? window.open('about:blank', '_blank') : null;
    launch.mutate({ ...input, win });
  };
  const close = useCallback(() => {
    setPlayer(null);
    // The package saves as it unloads; read the result a moment later.
    setTimeout(refresh, 800);
  }, [refresh]);
  const onLaunch = useCallback((input: PackageLaunchInput) => launch.mutate(input), [launch]);

  return (
    <ActivityFrame activity={activity}>
      <div className="space-y-6">
        {activity.description && !player && (
          <Card className="p-6">
            <Markdown source={activity.description} />
          </Card>
        )}
        {isLoading || !info ? (
          <Skeleton className="h-40" />
        ) : player ? (
          <Player launch={player} title={activity.title} onLaunch={onLaunch} onClose={close} onProgress={refresh} />
        ) : !info.current ? (
          info.canManage ? null : (
            <EmptyState
              icon={Package}
              title="Not ready yet"
              description="Your teacher hasn't uploaded the package for this activity yet."
            />
          )
        ) : (
          <>
            {popup && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-primary/5 px-4 py-3 text-sm">
                <span className="flex-1">The activity opened in a new window. Your progress here updates when you come back.</span>
                <Button size="sm" variant="ghost" onClick={() => setPopup(false)}>
                  Dismiss
                </Button>
              </div>
            )}
            {info.mode === 'learner' ? (
              <LearnerSummary info={info} onLaunch={start} busy={launch.isPending} />
            ) : (
              !info.canManage && (
                <Card className="flex flex-wrap items-center gap-3 p-5">
                  <p className="flex-1 text-sm text-muted-foreground">Staff open packages as a preview: nothing is recorded.</p>
                  <Button variant="outline" onClick={() => start({ preview: true })} loading={launch.isPending}>
                    <Eye /> Preview
                  </Button>
                </Card>
              )
            )}
          </>
        )}
        {info?.canManage && !player && (
          <ManagePackage activity={activity} info={info} onPreview={() => start({ preview: true })} busy={launch.isPending} />
        )}
        {info?.canViewReports && !player && info.current && <PackageReportCard activity={activity} />}
      </div>
    </ActivityFrame>
  );
}
