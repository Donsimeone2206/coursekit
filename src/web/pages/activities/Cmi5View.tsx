import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock, ExternalLink, Eye, Folder, ListTree, Package, Play, RotateCcw, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CMI5_MOVE_ON_LABELS,
  CMI5_STATUS_LABELS,
  type Cmi5Info,
  type Cmi5Launch,
  type Cmi5Report,
  type Cmi5Status,
  type Cmi5TocNode,
} from '@shared/cmi5';
import type { PackageAttemptInfo, PackageLaunchInput, PackagePlayerInfo, PackageVersionInfo } from '@shared/packages';
import type { ActivityDetail } from '@shared/types';
import { FileDrop } from '@/components/common';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn, formatBytes, formatDate, formatRelative, plural } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { ActivityFrame } from './frame';

/** AUs inside the package play like other package content: scripts run, never with Coursekit's origin. */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
/**
 * AUs hosted elsewhere keep their own origin (they need their own storage and cookies). They are never on
 * Coursekit's origin (the server refuses that), and the frame checks it again before adding allow-same-origin.
 */
const EXTERNAL_SANDBOX = `${SANDBOX} allow-same-origin`;

const STATUS_VARIANT: Record<Cmi5Status, BadgeVariant> = {
  'not attempted': 'neutral',
  'in progress': 'info',
  completed: 'success',
  passed: 'success',
  failed: 'danger',
  satisfied: 'success',
};

function StatusBadge({ status, score }: { status: Cmi5Status; score?: number | null }) {
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      {CMI5_STATUS_LABELS[status]}
      {score != null && ` · ${Math.round(score * 10) / 10}%`}
    </Badge>
  );
}

/** An attempt of a SCORM or xAPI package (one this course replaced), as PackageView shows it. */
function AttemptBadge({ attempt }: { attempt: PackageAttemptInfo }) {
  if (attempt.successStatus === 'passed') return <Badge variant="success">Passed</Badge>;
  if (attempt.successStatus === 'failed') return <Badge variant="danger">Failed</Badge>;
  if (attempt.completionStatus === 'completed') return <Badge variant="success">Completed</Badge>;
  if (attempt.status === 'in_progress') return <Badge variant="info">In progress</Badge>;
  return <Badge variant="neutral">Finished</Badge>;
}

function duration(seconds: number): string {
  if (!seconds) return '–';
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function requirement(node: Cmi5TocNode): string | null {
  if (!node.moveOn) return null;
  const mastery = node.masteryScore != null ? ` · pass mark ${Math.round(node.masteryScore * 1000) / 10}%` : '';
  return `${CMI5_MOVE_ON_LABELS[node.moveOn]}${mastery}`;
}

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

const sameOrigin = (url: string) => {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
};

interface Opener {
  input: PackageLaunchInput;
  node: Cmi5TocNode;
  /** Open in a new window even if the AU could be shown on the page. */
  newWindow?: boolean;
}

function Player({
  launch,
  nodes,
  onOpen,
  onClose,
}: {
  launch: Cmi5Launch;
  nodes: Cmi5TocNode[];
  onOpen: (opener: Opener) => void;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = nodes.find((n) => n.key === launch.itemId);
  const aus = nodes.filter((n) => n.kind === 'au');
  const external = launch.cmi5.external && !sameOrigin(launch.url);
  const reopen = (node: Cmi5TocNode, newWindow = false) =>
    onOpen({ node, newWindow, input: { itemId: node.key, ...(launch.attemptId ? { attemptId: launch.attemptId } : { preview: true }) } });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!fromFrame(event.source, frame.current?.contentWindow)) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source === 'coursekit-cmi5' && data.type === 'returned') onClose();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {current?.title}
          {launch.mode !== 'normal' && (
            <Badge variant="warning" className="ml-2">
              {launch.mode === 'review' ? 'Review: nothing is recorded' : 'Preview: nothing is recorded'}
            </Badge>
          )}
        </p>
        {current && launch.cmi5.external && (
          <Button size="sm" variant="ghost" onClick={() => reopen(current, true)}>
            <ExternalLink /> Open in a new window
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          <X /> Exit
        </Button>
      </div>
      <div className={cn('grid', aus.length > 1 && 'lg:grid-cols-[220px_1fr]')}>
        {aus.length > 1 && (
          <nav className="hidden border-r p-2 lg:block" aria-label="Course structure">
            {nodes.map((node) =>
              node.kind === 'au' ? (
                <button
                  key={node.key}
                  type="button"
                  onClick={() => reopen(node)}
                  style={{ paddingLeft: 10 + node.depth * 12 }}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground',
                    node.key === launch.itemId && 'bg-primary/10 font-medium text-primary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{node.title}</span>
                  {node.satisfied && <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Done" />}
                </button>
              ) : (
                <p
                  key={node.key}
                  style={{ paddingLeft: 10 + node.depth * 12 }}
                  className="pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  {node.title}
                </p>
              ),
            )}
          </nav>
        )}
        <iframe
          key={launch.url}
          ref={frame}
          src={launch.url}
          title={current?.title ?? 'Course'}
          sandbox={external ? EXTERNAL_SANDBOX : SANDBOX}
          allow="fullscreen; autoplay"
          referrerPolicy="no-referrer"
          className="h-[75vh] min-h-[420px] w-full bg-white"
        />
      </div>
    </Card>
  );
}

function Contents({
  toc,
  info,
  onOpen,
  busy,
}: {
  toc: Cmi5Info;
  info: PackagePlayerInfo;
  onOpen: (opener: Opener) => void;
  busy: boolean;
}) {
  const learner = info.mode === 'learner';
  const action = (node: Cmi5TocNode): { label: string; icon: typeof Play; input: PackageLaunchInput } | null => {
    if (!learner) return { label: 'Preview', icon: Eye, input: { itemId: node.key, preview: true } };
    // The unfinished attempt, or the finished one shown: AUs the learner hasn't finished still record results.
    const attemptId = info.resumeAttemptId ?? (toc.attemptStatus === 'finished' ? toc.attemptId : null);
    if (attemptId) {
      const label = node.review ? 'Review' : node.status === 'not attempted' ? 'Start' : 'Continue';
      return { label, icon: node.review ? Eye : Play, input: { attemptId, itemId: node.key } };
    }
    // No attempt yet, or only attempts of a SCORM or xAPI package this course replaced: a new attempt starts here.
    if (info.canStartNew && (info.attempts.length === 0 || !toc.attemptId))
      return { label: 'Start', icon: Play, input: { itemId: node.key } };
    return null;
  };
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ListTree className="size-4" />}
        title={toc.course.title}
        description={toc.course.description || undefined}
        action={toc.course.satisfied ? <StatusBadge status="satisfied" /> : undefined}
      />
      <ul className="divide-y border-t">
        {toc.nodes.map((node) => {
          if (node.kind === 'block') {
            return (
              <li key={node.key} className="flex items-center gap-2 bg-muted/30 px-5 py-2.5" style={{ paddingLeft: 20 + node.depth * 16 }}>
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{node.title}</span>
                {learner && toc.attemptId && node.status !== 'not attempted' && <StatusBadge status={node.status} />}
              </li>
            );
          }
          const act = action(node);
          const opensWindow = node.launchMethod === 'OwnWindow' || info.settings.display === 'window';
          return (
            <li
              key={node.key}
              className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center"
              style={{ paddingLeft: 20 + node.depth * 16 }}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{node.title}</span>
                  {learner && toc.attemptId && <StatusBadge status={node.status} score={node.score} />}
                </div>
                {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
                <p className="text-xs text-muted-foreground">
                  {requirement(node)}
                  {node.external && ' · Hosted on another website'}
                  {opensWindow && ' · Opens in a new window'}
                </p>
              </div>
              {act && (
                <Button
                  size="sm"
                  variant={act.label === 'Review' || act.label === 'Preview' ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={() => onOpen({ input: act.input, node })}
                  className="shrink-0 self-start sm:self-center"
                >
                  <act.icon /> {act.label}
                  {opensWindow && <ExternalLink className="opacity-70" />}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function LearnerSummary({
  info,
  toc,
  onOpen,
  onPackageLaunch,
  busy,
}: {
  info: PackagePlayerInfo;
  toc: Cmi5Info;
  onOpen: (opener: Opener) => void;
  onPackageLaunch: (input: PackageLaunchInput) => void;
  busy: boolean;
}) {
  const latest = info.attempts[info.attempts.length - 1];
  const limit = info.settings.attemptsAllowed;
  const firstAu = toc.nodes.find((n) => n.kind === 'au');
  const nextAu = toc.nodes.find((n) => n.kind === 'au' && !n.review) ?? firstAu;
  const unfinished = toc.attemptStatus === 'finished' && toc.nodes.some((n) => n.kind === 'au' && !n.review);
  // The latest attempt is of a SCORM or xAPI package this course replaced: PackageView's player reviews it.
  const other = latest && latest.kind !== 'cmi5' ? latest : undefined;
  // A new attempt starts on the current version, which may be a SCORM or xAPI package that replaced this course.
  const startNew = () =>
    info.current && info.current.kind !== 'cmi5'
      ? onPackageLaunch({ newAttempt: true })
      : firstAu && onOpen({ node: firstAu, input: info.attempts.length ? { newAttempt: true } : { itemId: firstAu.key } });
  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {!latest ? (
              <Badge variant="neutral">Not started</Badge>
            ) : other ? (
              <AttemptBadge attempt={other} />
            ) : toc.course.satisfied ? (
              <Badge variant="success">
                <CircleCheck /> Completed
              </Badge>
            ) : (
              <Badge variant="info">In progress</Badge>
            )}
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
          <p className="text-sm text-muted-foreground">
            {!latest
              ? info.canStartNew
                ? 'Open the parts below in any order. Your progress is saved as you go.'
                : "This course can't be started right now."
              : info.resumeAttemptId
                ? 'Pick up where you left off, or open any part below.'
                : other
                  ? info.canStartNew
                    ? 'Your last attempt was on an earlier version of this activity. You can review it, or start a new attempt.'
                    : "You've used all your attempts. You can still review them."
                  : unfinished
                    ? info.canStartNew
                      ? "You finished this course. You can still do the parts you haven't finished, review the others, or start a new attempt."
                      : "You finished this course. You can still do the parts you haven't finished, and review the others."
                    : info.canStartNew
                      ? 'You finished this course. You can review it, or start a new attempt.'
                      : limit > 0 && info.attempts.length >= limit
                        ? "You've used all your attempts. You can still review them."
                        : 'You finished this course. You can still review it.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {other?.status === 'finished' && (
            <Button variant="outline" onClick={() => onPackageLaunch({ attemptId: other.id })} disabled={busy}>
              <Eye /> Review
            </Button>
          )}
          {info.resumeAttemptId && nextAu ? (
            <Button
              onClick={() => onOpen({ node: nextAu, input: { attemptId: info.resumeAttemptId!, itemId: nextAu.key } })}
              loading={busy}
            >
              <Play /> Continue
            </Button>
          ) : info.canStartNew && firstAu ? (
            // A new attempt starts on the current version, whose AUs may not be the ones shown: the server picks its first AU.
            <Button onClick={startNew} loading={busy}>
              {info.attempts.length ? <RotateCcw /> : <Play />} {info.attempts.length ? 'Start a new attempt' : 'Start'}
            </Button>
          ) : null}
        </div>
      </CardContent>
      {(info.attempts.length > 1 || other) && (
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
                    {a.kind !== 'cmi5' ? (
                      <AttemptBadge attempt={a} />
                    ) : a.completionStatus === 'completed' ? (
                      <Badge variant="success">Completed</Badge>
                    ) : a.status === 'in_progress' ? (
                      <Badge variant="info">In progress</Badge>
                    ) : (
                      <Badge variant="neutral">Finished</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{a.score == null ? '–' : `${Math.round(a.score * 10) / 10}%`}</td>
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

function Manage({ activity, info }: { activity: ActivityDetail; info: PackagePlayerInfo }) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const importFile = useMutation({
    mutationFn: (fileId: string) => api.post<PackageVersionInfo>(`/packages/${activity.id}/import`, { fileId }),
    onSuccess: async (v) => {
      toast.success(`Package uploaded (version ${v.version}).`);
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
        description="Learners who already started keep the version they started with."
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
              <dd>cmi5 course</dd>
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
                {plural(v.items.filter((i) => i.launchable).length, 'AU')} · {plural(v.fileCount, 'file')} · {formatBytes(v.totalBytes)}
              </dd>
            </div>
          </dl>
        )}
        {importFile.isPending ? (
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-sm text-muted-foreground">
            <Upload className="size-4" /> Checking and unpacking the package…
          </div>
        ) : (
          <FileDrop
            context="activity"
            courseId={activity.courseId}
            accept=".zip,.xml,application/zip,application/xml,text/xml"
            label="Drop a new zip or cmi5.xml here to replace the package"
            onUploaded={(file) => importFile.mutate(file.id)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ReportCard({ activity }: { activity: ActivityDetail }) {
  const { data, isLoading } = useQuery({
    queryKey: ['package', activity.id, 'cmi5', 'report'],
    queryFn: () => api.get<Cmi5Report>(`/packages/${activity.id}/cmi5/report`),
  });
  if (isLoading) return <Skeleton className="h-48" />;
  if (!data) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ListTree className="size-4" />}
        title="Learner report"
        description="Each student's latest attempt, with the status of every AU."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Student</th>
              <th className="px-3 py-3 font-medium">AUs</th>
              <th className="hidden px-3 py-3 font-medium sm:table-cell">Grade</th>
              <th className="hidden px-3 py-3 font-medium md:table-cell">Time spent</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.rows.map((r) => {
              const latest = r.attempts[r.attempts.length - 1];
              const time = r.attempts.reduce((sum, a) => sum + a.totalSeconds, 0);
              return (
                <tr key={r.user.id} className="align-top">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar user={r.user} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {r.user.name} {r.completed && <CircleCheck className="inline size-3.5 text-success" aria-label="Completed" />}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {latest ? `Attempt ${latest.attemptNumber}${latest.satisfied ? ' · course satisfied' : ''}` : r.user.email}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {!latest ? (
                      <span className="text-muted-foreground">Not started</span>
                    ) : latest.kind !== 'cmi5' ? (
                      // An attempt of a SCORM or xAPI package this course replaced: it has no AUs.
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <AttemptBadge attempt={latest} />
                        {latest.score != null && <span className="tabular-nums">{Math.round(latest.score * 10) / 10}%</span>}
                        <span className="text-muted-foreground">Version {latest.version}</span>
                      </span>
                    ) : (
                      <ul className="flex flex-wrap gap-1.5">
                        {data.aus.map((au) => {
                          const p = latest.aus[au.key];
                          return (
                            <li key={au.key} className="flex items-center gap-1 text-xs">
                              <span className="max-w-40 truncate text-muted-foreground">{au.title}:</span>
                              {p ? <StatusBadge status={p.status} score={p.score} /> : <span className="text-muted-foreground">–</span>}
                            </li>
                          );
                        })}
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
                </tr>
              );
            })}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-muted-foreground">
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

/** The player of cmi5 courses: the course structure with each part's status, and the AU being played. */
export function Cmi5View({
  activity,
  info,
  onPlayingChange,
  onPackageLaunch,
}: {
  activity: ActivityDetail<'package'>;
  info: PackagePlayerInfo;
  /** Told while an AU plays, on the page or in a window: the page keeps this view until it ends. */
  onPlayingChange: (playing: boolean) => void;
  /** Opens (or starts) an attempt of a SCORM or xAPI package in PackageView's player. */
  onPackageLaunch: (input: PackageLaunchInput) => void;
}) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const [player, setPlayer] = useState<Cmi5Launch | null>(null);
  const [popup, setPopup] = useState(false);
  const playing = !!player || popup;
  useEffect(() => onPlayingChange(playing), [onPlayingChange, playing]);
  const { data: toc, isLoading } = useQuery({
    queryKey: ['package', activity.id, 'cmi5'],
    queryFn: () => api.get<Cmi5Info>(`/packages/${activity.id}/cmi5`),
    refetchInterval: player || popup ? 15_000 : false,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['package', activity.id] });
    void invalidate(activity.course.slug);
  }, [qc, invalidate, activity.id, activity.course.slug]);

  const launch = useMutation({
    mutationFn: async ({ input, win }: { input: PackageLaunchInput; win: Window | null }) => {
      try {
        return { result: await api.post<Cmi5Launch>(`/packages/${activity.id}/cmi5/launch`, input), win };
      } catch (err) {
        win?.close();
        throw err;
      }
    },
    onSuccess: ({ result, win }) => {
      if (!result.cmi5) {
        // Not a cmi5 course (the page was open while the teacher replaced it): show what is there now.
        win?.close();
        toast.error("This activity's package has changed. Open it again.");
        refresh();
        return;
      }
      if (win || result.display === 'window') {
        if (win) win.location.href = result.url;
        else window.open(result.url, '_blank');
        setPopup(true);
        setPlayer(null);
      } else {
        setPlayer(result);
      }
      refresh();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      // A refused launch may still have changed the attempts (for example, started a new one): show what is there now.
      refresh();
    },
  });
  const open = useCallback(
    ({ input, node, newWindow }: Opener) => {
      // A new window has to open in the click itself, or popup blockers stop it.
      const opensWindow = newWindow || node.launchMethod === 'OwnWindow' || info.settings.display === 'window';
      launch.mutate({ input, win: opensWindow ? window.open('about:blank', '_blank') : null });
    },
    [launch, info.settings.display],
  );
  const close = useCallback(() => {
    setPlayer(null);
    // The AU sends its last statements as it unloads; read the result a moment later.
    setTimeout(refresh, 800);
  }, [refresh]);

  return (
    <ActivityFrame activity={activity}>
      <div className="space-y-6">
        {activity.description && !player && (
          <Card className="p-6">
            <Markdown source={activity.description} />
          </Card>
        )}
        {isLoading || !toc ? (
          <Skeleton className="h-40" />
        ) : player ? (
          <Player launch={player} nodes={toc.nodes} onOpen={open} onClose={close} />
        ) : (
          <>
            {popup && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-primary/5 px-4 py-3 text-sm">
                <span className="flex-1">The course opened in a new window. Your progress here updates when you come back.</span>
                <Button size="sm" variant="ghost" onClick={() => setPopup(false)}>
                  Dismiss
                </Button>
              </div>
            )}
            {info.mode === 'learner' ? (
              <LearnerSummary info={info} toc={toc} onOpen={open} onPackageLaunch={onPackageLaunch} busy={launch.isPending} />
            ) : (
              <Card className="flex flex-wrap items-center gap-3 p-5">
                <p className="flex-1 text-sm text-muted-foreground">Staff open AUs as a preview (Browse mode): nothing is recorded.</p>
              </Card>
            )}
            <Contents toc={toc} info={info} onOpen={open} busy={launch.isPending} />
          </>
        )}
        {info.canManage && !player && <Manage activity={activity} info={info} />}
        {info.canViewReports && !player && info.current && <ReportCard activity={activity} />}
      </div>
    </ActivityFrame>
  );
}
