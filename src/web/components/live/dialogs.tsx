import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ClipboardCheck, Film, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type {
  LiveAttendanceRow,
  LiveClassInfo,
  LiveProviderId,
  LiveScheduleInput,
  LiveSession,
  LiveSessionAttendance,
  LiveSessionUpdate,
} from '@shared/live';
import { GroupPicker } from '@/components/group-modes';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDateTime, formatTime, fromLocalInput, toLocalInput } from '@/lib/utils';

const DURATIONS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240];

/** The browser's IANA time zone, sent with every schedule so repeats keep the local time. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function nextHour(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function DurationField({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  return (
    <Field label="Duration">
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {[...new Set([...DURATIONS, value])]
            .sort((a, b) => a - b)
            .map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${Math.floor(m / 60)} h ${m % 60} min`}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}

function useRefresh(activityId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['live', activityId] }),
      qc.invalidateQueries({ queryKey: ['calendar'] }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
}

/** Schedule one session, or a daily or weekly repeat. */
export function ScheduleDialog({
  activityId,
  provider,
  open,
  onOpenChange,
}: {
  activityId: string;
  provider: LiveProviderId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const refresh = useRefresh(activityId);
  const zone = browserTimeZone();
  const [form, setForm] = useState({ title: '', startsAt: nextHour(), duration: 60, repeat: 'none', count: 8, meetingUrl: '', agenda: '' });
  const save = useMutation({
    mutationFn: () => {
      const startsAt = fromLocalInput(form.startsAt);
      if (!startsAt) throw new Error('Pick when the session starts.');
      const body: LiveScheduleInput = {
        startsAt,
        durationMinutes: form.duration,
        title: form.title,
        agenda: form.agenda,
        meetingUrl: form.meetingUrl || null,
        timeZone: zone,
        repeat: form.repeat === 'none' ? null : { frequency: form.repeat as 'daily' | 'weekly', count: form.count },
      };
      return api.post<{ ids: string[] }>(`/live/activities/${activityId}/sessions`, body);
    },
    onSuccess: async (res) => {
      toast.success(res.ids.length === 1 ? 'Session scheduled' : `${res.ids.length} sessions scheduled`);
      await refresh();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<CalendarPlus className="size-5" />}
            title="Schedule sessions"
            description={`Times are in your time zone (${zone}). Repeats keep the same local time when the clocks change.`}
          />
          <DialogBody className="space-y-4">
            <Field label="Title" optional hint="For example “Week 3: Forms and validation”.">
              {(p) => <Input {...p} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts">
                {(p) => (
                  <Input
                    {...p}
                    type="datetime-local"
                    required
                    value={form.startsAt}
                    onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  />
                )}
              </Field>
              <DurationField value={form.duration} onChange={(duration) => setForm({ ...form, duration })} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Repeat">
                {(p) => (
                  <Select {...p} value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
                    <option value="none">Doesn’t repeat</option>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                  </Select>
                )}
              </Field>
              {form.repeat !== 'none' && (
                <Field label="Number of sessions">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={2}
                      max={100}
                      value={form.count}
                      onChange={(e) => setForm({ ...form, count: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
                    />
                  )}
                </Field>
              )}
            </div>
            {provider === 'link' && (
              <Field label="Meeting link" optional hint="Leave empty to use the class’s link.">
                {(p) => (
                  <Input
                    {...p}
                    type="url"
                    value={form.meetingUrl}
                    onChange={(e) => setForm({ ...form, meetingUrl: e.target.value })}
                    placeholder="https://"
                  />
                )}
              </Field>
            )}
            <Field label="Agenda" optional>
              {(p) => (
                <Textarea
                  {...p}
                  rows={3}
                  maxLength={5000}
                  value={form.agenda}
                  onChange={(e) => setForm({ ...form, agenda: e.target.value })}
                />
              )}
            </Field>
            <p className="text-xs text-muted-foreground">Students who can see the class are told about new sessions.</p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {form.repeat === 'none' ? 'Schedule session' : `Schedule ${form.count} sessions`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Change one session: its time, length, title, agenda or link. */
export function EditSessionDialog({
  activityId,
  provider,
  session,
  onClose,
}: {
  activityId: string;
  provider: LiveProviderId | null;
  session: LiveSession;
  onClose: () => void;
}) {
  const refresh = useRefresh(activityId);
  const zone = browserTimeZone();
  const [form, setForm] = useState({
    title: session.title,
    startsAt: toLocalInput(session.startsAt),
    duration: session.durationMinutes,
    meetingUrl: session.meetingUrl ?? '',
    agenda: session.agenda,
  });
  const save = useMutation({
    mutationFn: () => {
      const startsAt = fromLocalInput(form.startsAt);
      if (!startsAt) throw new Error('Pick when the session starts.');
      const body: LiveSessionUpdate = {
        title: form.title,
        agenda: form.agenda,
        durationMinutes: form.duration,
        ...(startsAt !== session.startsAt ? { startsAt, timeZone: zone } : {}),
        ...(provider === 'link' ? { meetingUrl: form.meetingUrl || null } : {}),
      };
      return api.patch(`/live/sessions/${session.id}`, body);
    },
    onSuccess: async () => {
      toast.success('Session saved');
      await refresh();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<Pencil className="size-5" />}
            title="Edit session"
            description="Students are told when a session moves. Calendar files they downloaded update when they download them again."
          />
          <DialogBody className="space-y-4">
            <Field label="Title" optional>
              {(p) => <Input {...p} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts" hint={`In your time zone (${zone}).`}>
                {(p) => (
                  <Input
                    {...p}
                    type="datetime-local"
                    required
                    value={form.startsAt}
                    onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  />
                )}
              </Field>
              <DurationField value={form.duration} onChange={(duration) => setForm({ ...form, duration })} />
            </div>
            {provider === 'link' && (
              <Field label="Meeting link" optional hint="Leave empty to use the class’s link.">
                {(p) => (
                  <Input
                    {...p}
                    type="url"
                    value={form.meetingUrl}
                    onChange={(e) => setForm({ ...form, meetingUrl: e.target.value })}
                    placeholder="https://"
                  />
                )}
              </Field>
            )}
            <Field label="Agenda" optional>
              {(p) => (
                <Textarea
                  {...p}
                  rows={3}
                  maxLength={5000}
                  value={form.agenda}
                  onChange={(e) => setForm({ ...form, agenda: e.target.value })}
                />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
] as const;

function sourceLabel(row: LiveAttendanceRow): string | null {
  if (row.source === 'manual') return 'Marked by staff';
  if (row.source === 'provider') return row.minutes != null ? `${row.minutes} min in the class` : 'Seen in the class';
  if (row.source === 'join') return 'Joined through Coursekit';
  return null;
}

/** Who came to a session, and marking people present or absent by hand. */
export function AttendanceDialog({ activityId, session, onClose }: { activityId: string; session: LiveSession; onClose: () => void }) {
  const qc = useQueryClient();
  const [groupId, setGroupId] = useState('');
  const key = ['live', activityId, 'attendance', session.id, groupId];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<LiveSessionAttendance>(`/live/sessions/${session.id}/attendance${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`),
    refetchInterval: session.state === 'live' ? 30_000 : false,
  });
  const mark = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: 'present' | 'absent' | null }) =>
      api.put(`/live/sessions/${session.id}/attendance/${userId}`, { status }),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: ['live', activityId] }), qc.invalidateQueries({ queryKey: ['activity', activityId] })]),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const present = data?.rows.filter((r) => r.status === 'present').length ?? 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader
          icon={<ClipboardCheck className="size-5" />}
          title="Attendance"
          description={`${session.title || 'Session'} · ${formatDateTime(session.startsAt)}`}
        />
        <DialogBody className="space-y-4 pb-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {data ? (
                <>
                  <span className="font-semibold tabular-nums">{present}</span> of <span className="tabular-nums">{data.rows.length}</span>{' '}
                  present
                </>
              ) : (
                ' '
              )}
            </p>
            <GroupPicker choice={data?.groupChoice} value={groupId} onChange={setGroupId} />
          </div>
          {isLoading || !data ? (
            <Skeleton className="h-48" />
          ) : data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">There are no students to show.</p>
          ) : (
            <div className="divide-y rounded-xl border">
              {data.rows.map((row) => (
                <div key={row.user.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar user={row.user} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.user.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[row.groups.map((g) => g.name).join(', '), row.joinedAt && `Joined ${formatTime(row.joinedAt)}`, sourceLabel(row)]
                          .filter(Boolean)
                          .join(' · ') || row.user.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={row.status === 'present' ? 'success' : 'neutral'}>
                      {row.status === 'present' ? 'Present' : 'Absent'}
                    </Badge>
                    {data.canMark && (
                      <Segmented
                        value={row.marked ?? 'auto'}
                        onChange={(v) => mark.mutate({ userId: row.user.id, status: v === 'auto' ? null : v })}
                        options={STATUS_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {data && data.guests.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Others in the class</p>
              <p className="text-xs text-muted-foreground">
                People the provider saw who didn’t match anyone in the course, such as guests or phone callers.
              </p>
              <ul className="text-sm">
                {data.guests.map((g) => (
                  <li key={g.name} className="flex justify-between gap-3 py-1">
                    <span className="truncate">{g.name}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{g.minutes != null ? `${g.minutes} min` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data && <p className={cn('text-xs text-muted-foreground')}>{data.sourceNote}</p>}
          {data && !data.canMark && (
            <p className="text-xs text-muted-foreground">Attendance can be marked by hand once the session has started.</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Add a recording link by hand (for any provider, e.g. a video uploaded elsewhere). */
export function RecordingDialog({ info, session, onClose }: { info: LiveClassInfo; session: LiveSession; onClose: () => void }) {
  const refresh = useRefresh(info.activityId);
  const groups = session.rooms.filter((r) => r.groupId && r.joinable);
  const [form, setForm] = useState({ title: 'Recording', url: '', groupId: groups.length === 1 ? groups[0]!.groupId! : '' });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/live/sessions/${session.id}/recordings`, { title: form.title, url: form.url, groupId: form.groupId || null }),
    onSuccess: async () => {
      toast.success('Recording added');
      await refresh();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<Film className="size-5" />}
            title="Add a recording"
            description="Learners who could see this session can watch it."
          />
          <DialogBody className="space-y-4">
            <Field label="Title">
              {(p) => (
                <Input {...p} required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              )}
            </Field>
            <Field label="Link" hint="Where the recording can be watched, starting with https://">
              {(p) => (
                <Input
                  {...p}
                  required
                  type="url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://"
                />
              )}
            </Field>
            {groups.length > 0 && (
              <Field label="For">
                {(p) => (
                  <Select {...p} value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })}>
                    {info.canManage && <option value="">Everyone in the class</option>}
                    {groups.map((g) => (
                      <option key={g.groupId!} value={g.groupId!}>
                        {g.groupName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Add recording
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
