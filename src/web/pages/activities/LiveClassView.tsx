import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  CalendarPlus,
  CircleCheck,
  CircleDashed,
  ClipboardCheck,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Pencil,
  PhoneOff,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LiveClassInfo, LiveRecording, LiveRoom, LiveSession } from '@shared/live';
import type { ActivityDetail } from '@shared/types';
import { AttendanceDialog, EditSessionDialog, RecordingDialog, ScheduleDialog } from '@/components/live/dialogs';
import { refreshOnSetupChange } from '@/components/live/setup';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState, Progress, Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { cn, formatTime, plural } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { ActivityFrame } from './frame';

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/** "On Zoom", "Through a meeting link". */
function meetsOn(info: LiveClassInfo): string | null {
  if (!info.provider || !info.providerLabel) return null;
  return info.provider === 'link' ? 'Through a meeting link' : `On ${info.providerLabel}`;
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "Starts in 12 minutes", "Live now", "Opens at 9:50". */
function timing(session: LiveSession, now: number): string {
  const start = Date.parse(session.startsAt);
  if (session.state === 'cancelled') return 'Cancelled';
  if (session.state === 'ended') return 'Ended';
  if (session.state === 'live') return 'Live now';
  const minutes = Math.round((start - now) / 60_000);
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `Starts in ${plural(minutes, 'minute')}`;
  if (minutes < 24 * 60) return `Starts in ${plural(Math.round(minutes / 60), 'hour')}`;
  return `Starts in ${plural(Math.round(minutes / (24 * 60)), 'day')}`;
}

function StateBadge({ session }: { session: LiveSession }) {
  if (session.state === 'live')
    return (
      <Badge variant="danger">
        <span className="size-1.5 animate-pulse rounded-full bg-current" /> Live
      </Badge>
    );
  if (session.state === 'open') return <Badge variant="success">Open to join</Badge>;
  if (session.state === 'cancelled') return <Badge variant="warning">Cancelled</Badge>;
  if (session.state === 'ended') return <Badge variant="neutral">Ended</Badge>;
  return null;
}

function DateBlock({ iso, muted }: { iso: string; muted?: boolean }) {
  const d = new Date(iso);
  return (
    <span className={cn('flex w-12 shrink-0 flex-col items-center self-start rounded-lg border bg-card py-1', muted && 'opacity-60')}>
      <span className="text-[10px] font-semibold text-muted-foreground uppercase">
        {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d)}
      </span>
      <span className="text-base leading-tight font-semibold tabular-nums">{d.getDate()}</span>
    </span>
  );
}

function JoinButtons({
  info,
  session,
  onEmbed,
  embedding,
}: {
  info: LiveClassInfo;
  session: LiveSession;
  onEmbed: (session: LiveSession, room: LiveRoom) => void;
  embedding: boolean;
}) {
  const staff = info.canModerate;
  const joinable = session.rooms.filter((r) => r.canJoin && r.joinUrl);
  const others = session.rooms.filter((r) => !r.joinable && r.groupId);
  // Staff start the meeting, except in a Zoom room someone else hosts (canStart false): they join it.
  const verb = (room: LiveRoom) => (staff && room.canStart !== false ? (info.provider === 'link' ? 'Open meeting' : 'Start') : 'Join');
  if (session.status === 'cancelled' || session.state === 'ended') return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {joinable.map((room) =>
        info.embed ? (
          <Button key={room.groupId ?? 'class'} size="sm" onClick={() => onEmbed(session, room)} loading={embedding}>
            <Video /> {verb(room)}
            {room.groupName ? `: ${room.groupName}` : ''}
          </Button>
        ) : (
          <Button key={room.groupId ?? 'class'} asChild size="sm">
            <a href={room.joinUrl!} target="_blank" rel="noopener">
              <Video /> {verb(room)}
              {room.groupName ? `: ${room.groupName}` : ''}
              <ExternalLink className="size-3.5 opacity-70" />
            </a>
          </Button>
        ),
      )}
      {joinable.map(
        (room) =>
          room.participantUrl && (
            <Button key={`p-${room.groupId ?? 'class'}`} asChild size="sm" variant="outline">
              <a href={room.participantUrl} target="_blank" rel="noopener">
                Join as participant{room.groupName ? `: ${room.groupName}` : ''}
              </a>
            </Button>
          ),
      )}
      {!staff && joinable.length === 0 && session.rooms.some((r) => r.joinable) && (
        <Button size="sm" disabled>
          <Video /> Join
        </Button>
      )}
      {others.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" /> Other rooms: {others.map((r) => r.groupName).join(', ')}
        </span>
      )}
    </div>
  );
}

function Recordings({
  info,
  session,
  onHide,
  onRemove,
}: {
  info: LiveClassInfo;
  session: LiveSession;
  onHide: (r: LiveRecording) => void;
  onRemove: (r: LiveRecording) => void;
}) {
  if (session.recordings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {session.recordings.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Film className="size-4 shrink-0 text-muted-foreground" />
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('font-medium text-primary hover:underline', r.hidden && 'opacity-60')}
          >
            {r.title}
          </a>
          {r.groupName && <span className="text-xs text-muted-foreground">{r.groupName}</span>}
          {r.durationMinutes != null && <span className="text-xs text-muted-foreground">{minutesLabel(r.durationMinutes)}</span>}
          {r.passcode && <span className="text-xs text-muted-foreground">Passcode: {r.passcode}</span>}
          {r.hidden && <Badge variant="warning">Hidden from students</Badge>}
          {info.canModerate && (
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onHide(r)}
                aria-label={r.hidden ? 'Show to students' : 'Hide from students'}
              >
                {r.hidden ? <Eye /> : <EyeOff />}
              </Button>
              <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => onRemove(r)} aria-label="Remove recording">
                <Trash2 />
              </Button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SessionRow({
  info,
  session,
  now,
  actions,
}: {
  info: LiveClassInfo;
  session: LiveSession;
  now: number;
  actions: {
    edit: (s: LiveSession) => void;
    cancel: (s: LiveSession) => void;
    remove: (s: LiveSession) => void;
    attendance: (s: LiveSession) => void;
    addRecording: (s: LiveSession) => void;
    refresh: (s: LiveSession) => void;
    end: (s: LiveSession) => void;
    embed: (s: LiveSession, room: LiveRoom) => void;
    hideRecording: (r: LiveRecording) => void;
    removeRecording: (r: LiveRecording) => void;
    embedding: boolean;
  };
}) {
  const cancelled = session.status === 'cancelled';
  const started = session.state === 'live' || session.state === 'ended';
  const staffMenu = info.canModerate && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Session actions">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {started && !cancelled && (
          <DropdownMenuItem onSelect={() => actions.attendance(session)}>
            <ClipboardCheck /> Attendance
          </DropdownMenuItem>
        )}
        {!cancelled && (
          <DropdownMenuItem onSelect={() => actions.addRecording(session)}>
            <Film /> Add a recording
          </DropdownMenuItem>
        )}
        {started && !cancelled && (info.provider === 'bbb' || info.provider === 'zoom') && (
          <DropdownMenuItem onSelect={() => actions.refresh(session)}>
            <RefreshCw /> Check for recordings and attendance
          </DropdownMenuItem>
        )}
        {session.state === 'live' && info.canEndForEveryone && (
          <DropdownMenuItem onSelect={() => actions.end(session)}>
            <PhoneOff /> End for everyone
          </DropdownMenuItem>
        )}
        {info.canManage && (
          <>
            <DropdownMenuSeparator />
            {!cancelled && (
              <DropdownMenuItem onSelect={() => actions.edit(session)}>
                <Pencil /> Edit
              </DropdownMenuItem>
            )}
            {!cancelled && session.state !== 'ended' && (
              <DropdownMenuItem onSelect={() => actions.cancel(session)}>
                <X /> Cancel session
              </DropdownMenuItem>
            )}
            <DropdownMenuItem destructive onSelect={() => actions.remove(session)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex gap-3 border-b px-4 py-4 last:border-b-0 sm:px-5">
      <DateBlock iso={session.startsAt} muted={cancelled} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'flex flex-wrap items-center gap-2 font-medium',
                cancelled && 'text-muted-foreground line-through decoration-muted-foreground/40',
              )}
            >
              <span className="min-w-0 break-words">{session.title || dayFormat.format(new Date(session.startsAt))}</span>
              <StateBadge session={session} />
            </p>
            <p className="text-sm text-muted-foreground">
              {session.title && `${dayFormat.format(new Date(session.startsAt))} · `}
              {formatTime(session.startsAt)} – {formatTime(session.endsAt)} · {minutesLabel(session.durationMinutes)}
              {!cancelled && session.state !== 'ended' && <span> · {timing(session, now)}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!cancelled && (
              <Button asChild variant="ghost" size="icon-sm" aria-label="Add to calendar" title="Add to calendar">
                <a href={session.icsUrl} download>
                  <CalendarPlus />
                </a>
              </Button>
            )}
            {staffMenu}
          </div>
        </div>
        {session.agenda && <p className="text-sm break-words whitespace-pre-line text-foreground/90">{session.agenda}</p>}
        <JoinButtons info={info} session={session} onEmbed={actions.embed} embedding={actions.embedding} />
        {session.joinNote && <p className="text-xs text-muted-foreground">{session.joinNote}</p>}
        {session.syncError && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {session.syncError}
          </p>
        )}
        {session.attendance && session.attendance.status && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {session.attendance.status === 'present' ? (
              <CircleCheck className="size-3.5 text-success" />
            ) : (
              <CircleDashed className="size-3.5" />
            )}
            {session.attendance.status === 'present'
              ? `You attended${session.attendance.minutes != null ? ` for ${minutesLabel(session.attendance.minutes)}` : ''}`
              : 'You didn’t attend'}
            {session.attendance.marked && ' (marked by your teacher)'}
          </p>
        )}
        {session.attendanceSummary && (
          <button
            type="button"
            onClick={() => actions.attendance(session)}
            className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <ClipboardCheck className="size-3.5" /> {session.attendanceSummary.present} of {session.attendanceSummary.total} present
          </button>
        )}
        <Recordings info={info} session={session} onHide={actions.hideRecording} onRemove={actions.removeRecording} />
      </div>
    </div>
  );
}

export function LiveClassView({ activity }: { activity: ActivityDetail<'live'> }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidateCourse = useInvalidateCourse();
  const now = useNow(30_000);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [scheduling, setScheduling] = useState(false);
  const [editing, setEditing] = useState<LiveSession | null>(null);
  const [attendance, setAttendance] = useState<LiveSession | null>(null);
  const [recordingFor, setRecordingFor] = useState<LiveSession | null>(null);
  const [embedded, setEmbedded] = useState<{ url: string; title: string } | null>(null);
  const {
    data: info,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['live', activity.id],
    queryFn: () => api.get<LiveClassInfo>(`/live/activities/${activity.id}`),
    // Often while a session is open or about to open (so Join appears on time), rarely otherwise.
    refetchInterval: (q) => {
      const sessions = q.state.data?.sessions ?? [];
      if (
        sessions.some(
          (s) => s.state === 'open' || s.state === 'live' || (s.state === 'upcoming' && Date.parse(s.joinOpensAt) - Date.now() < 3_600_000),
        )
      )
        return 30_000;
      return sessions.some((s) => s.state === 'upcoming') ? 300_000 : false;
    },
  });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['live', activity.id] }), invalidateCourse(activity.course.slug)]);
  // Saving the class in the editor refetches only the activity: the sessions follow when its setup changed.
  useEffect(() => refreshOnSetupChange(qc, activity.id), [qc, activity.id]);
  const run = (fn: () => Promise<unknown>, done?: string) =>
    fn()
      .then(async () => {
        if (done) toast.success(done);
        await refresh();
      })
      .catch((err) => toast.error(errorMessage(err)));

  const embed = useMutation({
    mutationFn: ({ session, room }: { session: LiveSession; room: LiveRoom }) =>
      api.post<{ url: string }>(`/live/sessions/${session.id}/embed`, { groupId: room.groupId }).then((r) => ({ ...r, session })),
    onSuccess: ({ url, session }) => {
      setEmbedded({ url, title: session.title || activity.title });
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const actions = {
    edit: setEditing,
    attendance: setAttendance,
    addRecording: setRecordingFor,
    embed: (session: LiveSession, room: LiveRoom) => embed.mutate({ session, room }),
    embedding: embed.isPending,
    cancel: async (s: LiveSession) => {
      if (
        await confirm({
          title: 'Cancel this session?',
          description: 'Students who can see the class are told it won’t take place.',
          confirmLabel: 'Cancel session',
          destructive: true,
        })
      )
        await run(() => api.post(`/live/sessions/${s.id}/cancel`), 'Session cancelled');
    },
    remove: async (s: LiveSession) => {
      if (
        await confirm({
          title: 'Delete this session?',
          description: 'Its attendance and recordings are deleted too. This can’t be undone.',
          confirmLabel: 'Delete',
          destructive: true,
        })
      )
        await run(() => api.delete(`/live/sessions/${s.id}`), 'Session deleted');
    },
    end: async (s: LiveSession) => {
      if (
        await confirm({
          title: 'End the session for everyone?',
          description: 'Everyone in the room is sent out of the meeting.',
          confirmLabel: 'End for everyone',
          destructive: true,
        })
      )
        await run(() => api.post(`/live/sessions/${s.id}/end`, {}), 'Session ended');
    },
    refresh: (s: LiveSession) => run(() => api.post(`/live/sessions/${s.id}/refresh`), 'Checked for recordings and attendance'),
    hideRecording: (r: LiveRecording) =>
      run(
        () => api.patch(`/live/recordings/${r.id}`, { hidden: !r.hidden }),
        r.hidden ? 'Recording shown to students' : 'Recording hidden',
      ),
    removeRecording: async (r: LiveRecording) => {
      const description =
        r.source === 'bbb'
          ? 'It is also deleted from BigBlueButton. This can’t be undone.'
          : r.source === 'zoom'
            ? 'It is also moved to the Zoom trash, where an administrator can restore it for 30 days.'
            : 'Students won’t see the link any more.';
      if (await confirm({ title: 'Remove this recording?', description, confirmLabel: 'Remove', destructive: true }))
        await run(() => api.delete(`/live/recordings/${r.id}`), 'Recording removed');
    },
  };

  const upcoming = (info?.sessions ?? []).filter((s) => s.state !== 'ended' && s.state !== 'cancelled');
  const past = (info?.sessions ?? []).filter((s) => s.state === 'ended' || s.state === 'cancelled').reverse();
  const shown = tab === 'upcoming' ? upcoming : past;
  const next = upcoming[0] ?? null;

  return (
    <ActivityFrame
      activity={activity}
      actions={
        info?.canManage && (
          <Button onClick={() => setScheduling(true)}>
            <CalendarPlus /> Schedule sessions
          </Button>
        )
      }
    >
      <div className="space-y-6">
        {activity.description && (
          <Card className="p-6">
            <Markdown source={activity.description} />
          </Card>
        )}
        {isLoading ? (
          <Skeleton className="h-48" />
        ) : error || !info ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (
          <>
            {[info.problem, info.warning].filter(Boolean).map((text) => (
              <Card key={text} className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p>{text}</p>
              </Card>
            ))}
            {info.completion && (
              <Card className="space-y-2 px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">Attendance</span>
                  <span className="text-muted-foreground tabular-nums">
                    {Math.min(info.completion.attended, info.completion.required)} of {plural(info.completion.required, 'session')} needed
                    to complete the class
                  </span>
                </div>
                <Progress
                  value={(Math.min(info.completion.attended, info.completion.required) / info.completion.required) * 100}
                  tone={info.completion.attended >= info.completion.required ? 'success' : 'primary'}
                />
              </Card>
            )}
            {embedded && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{embedded.title}</p>
                  <Button size="sm" variant="outline" onClick={() => setEmbedded(null)}>
                    <PhoneOff /> Leave
                  </Button>
                </div>
                <iframe
                  src={embedded.url}
                  title={embedded.title}
                  className="h-[75vh] min-h-[420px] w-full rounded-xl border bg-black"
                  allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write; screen-wake-lock"
                  allowFullScreen
                />
              </div>
            )}
            {next && !embedded && (
              <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
                <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400">
                  <CalendarClock className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-muted-foreground">{next.state === 'live' ? 'Happening now' : 'Next session'}</p>
                  <p className="font-semibold break-words">{next.title || activity.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {dayFormat.format(new Date(next.startsAt))}, {formatTime(next.startsAt)} – {formatTime(next.endsAt)} ·{' '}
                    {timing(next, now)}
                  </p>
                  {meetsOn(info) && <p className="mt-0.5 text-xs text-muted-foreground">{meetsOn(info)}</p>}
                </div>
                <div className="sm:max-w-[50%]">
                  <JoinButtons info={info} session={next} onEmbed={actions.embed} embedding={actions.embedding} />
                  {!next.canJoin && next.joinNote && <p className="mt-1 text-xs text-muted-foreground">{next.joinNote}</p>}
                </div>
              </Card>
            )}
            <Card>
              <CardHeader
                title="Sessions"
                description={
                  info.provider && info.providerLabel
                    ? info.provider === 'link'
                      ? 'This class meets through a meeting link.'
                      : `This class meets on ${info.providerLabel}.`
                    : undefined
                }
                action={
                  info.sessions.length > 0 && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={info.icsUrl} download>
                        <CalendarPlus /> <span className="sr-only sm:not-sr-only">Add all to calendar</span>
                      </a>
                    </Button>
                  )
                }
              />
              {info.sessions.length === 0 ? (
                <EmptyState
                  icon={Video}
                  title="No sessions yet"
                  description={
                    info.canManage ? 'Schedule the first session, or a weekly series.' : 'Your teacher hasn’t scheduled any sessions yet.'
                  }
                  action={
                    info.canManage && (
                      <Button onClick={() => setScheduling(true)}>
                        <CalendarPlus /> Schedule sessions
                      </Button>
                    )
                  }
                  className="pb-8"
                />
              ) : (
                <>
                  <div className="px-4 pb-3 sm:px-5">
                    <Segmented
                      value={tab}
                      onChange={setTab}
                      options={[
                        { value: 'upcoming', label: 'Upcoming', count: upcoming.length },
                        { value: 'past', label: 'Past', count: past.length },
                      ]}
                    />
                  </div>
                  <div className="border-t">
                    {shown.length === 0 ? (
                      <p className="px-5 py-6 text-sm text-muted-foreground">
                        {tab === 'upcoming' ? 'No upcoming sessions.' : 'No past sessions yet.'}
                      </p>
                    ) : (
                      shown.map((s) => <SessionRow key={s.id} info={info} session={s} now={now} actions={actions} />)
                    )}
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </div>
      {scheduling && info && (
        <ScheduleDialog activityId={activity.id} provider={info.provider} open={scheduling} onOpenChange={setScheduling} />
      )}
      {editing && info && (
        <EditSessionDialog activityId={activity.id} provider={info.provider} session={editing} onClose={() => setEditing(null)} />
      )}
      {attendance && <AttendanceDialog activityId={activity.id} session={attendance} onClose={() => setAttendance(null)} />}
      {recordingFor && info && <RecordingDialog info={info} session={recordingFor} onClose={() => setRecordingFor(null)} />}
    </ActivityFrame>
  );
}
