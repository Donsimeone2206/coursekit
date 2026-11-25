import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Flag, Plus, Trash2, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { CalendarEvent, CourseSummary } from '@shared/types';
import { PageHeader } from '@/components/common';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cover } from '@/lib/covers';
import { useTitle } from '@/lib/hooks';
import { cn, formatDateTime, formatTime, fromLocalInput, toLocalInput } from '@/lib/utils';

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + i)),
);

function startOfGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // weeks start on Monday
  return new Date(first.getFullYear(), first.getMonth(), 1 - offset);
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function eventColor(e: CalendarEvent) {
  if (e.kind === 'personal') return { background: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary)' };
  const c = cover(e.course?.coverColor ?? 'slate');
  return { background: `color-mix(in oklab, ${c.from} 16%, transparent)`, color: `color-mix(in oklab, ${c.to} 80%, var(--foreground))` };
}

function EventIcon({ kind }: { kind: CalendarEvent['kind'] }) {
  if (kind === 'due') return <ClipboardList className="size-3 shrink-0" />;
  if (kind === 'course-start' || kind === 'course-end') return <Flag className="size-3 shrink-0" />;
  return <Video className="size-3 shrink-0" />;
}

function EventDetails({ event, onDeleted }: { event: CalendarEvent; onDeleted: () => void }) {
  const del = useMutation({
    mutationFn: () => api.delete(`/calendar/events/${event.id}`),
    onSuccess: onDeleted,
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-2">
      <p className="font-semibold leading-snug">{event.title}</p>
      <p className="text-xs text-muted-foreground">
        {formatDateTime(event.startsAt)}
        {event.endsAt && ` – ${formatTime(event.endsAt)}`}
      </p>
      {event.course && <p className="text-xs text-muted-foreground">{event.course.title}</p>}
      {event.description && <p className="text-sm">{event.description}</p>}
      <div className="flex gap-2 pt-1">
        {event.link && (
          <Button asChild size="xs" variant="outline">
            <Link to={event.link}>Open</Link>
          </Button>
        )}
        {event.canDelete && (
          <Button size="xs" variant="ghost" className="text-destructive" onClick={() => del.mutate()} loading={del.isPending}>
            <Trash2 /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function NewEventDialog({
  open,
  onOpenChange,
  onCreated,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  defaultDate: Date;
}) {
  const { data: courses } = useQuery({ queryKey: ['courses', 'mine'], queryFn: () => api.get<CourseSummary[]>('/courses/mine') });
  const teaching = (courses ?? []).filter((c) => c.myRole === 'teacher');
  const start = new Date(defaultDate);
  start.setHours(17, 0, 0, 0);
  const [form, setForm] = useState({ title: '', description: '', startsAt: toLocalInput(start.toISOString()), endsAt: '', courseId: '' });
  const create = useMutation({
    mutationFn: () =>
      api.post('/calendar/events', {
        title: form.title,
        description: form.description || null,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        courseId: form.courseId || null,
      }),
    onSuccess: () => {
      toast.success('Event added');
      onCreated();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader
            icon={<CalendarDays className="size-5" />}
            title="New event"
            description="Personal events are only visible to you. Course events are shown to everyone in the course."
          />
          <DialogBody className="space-y-4">
            <Field label="Title">
              {(p) => <Input {...p} autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
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
              <Field label="Ends" optional>
                {(p) => (
                  <Input {...p} type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
                )}
              </Field>
            </div>
            {teaching.length > 0 && (
              <Field label="Visible to">
                {(p) => (
                  <Select {...p} value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
                    <option value="">Only me</option>
                    {teaching.map((c) => (
                      <option key={c.id} value={c.id}>
                        Everyone in {c.title}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Notes" optional>
              {(p) => (
                <Textarea {...p} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add event
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CalendarPage() {
  useTitle('Calendar');
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [creating, setCreating] = useState<Date | null>(null);
  const gridStart = startOfGrid(month);
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
  const range = { from: gridStart.toISOString(), to: gridEnd.toISOString() };
  const key = ['calendar', range.from, range.to];
  const { data: events, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<CalendarEvent[]>(`/calendar?${new URLSearchParams(range)}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['calendar'] });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events ?? []) {
      const k = dayKey(new Date(e.startsAt));
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return map;
  }, [events]);

  const today = new Date();
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const upcoming = (events ?? [])
    .filter((e) => new Date(e.startsAt) >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
    .slice(0, 8);
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month);

  return (
    <Page size="wide">
      <PageHeader
        title="Calendar"
        description="Due dates, course events and your own reminders in one place."
        actions={
          <Button onClick={() => setCreating(new Date())}>
            <Plus /> New event
          </Button>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b px-5 py-3">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>
                Today
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                aria-label="Previous month"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                aria-label="Next month"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          {isLoading ? (
            <Skeleton className="h-[540px] rounded-none" />
          ) : (
            <div className="grid grid-cols-7">
              {days.map((d, i) => {
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = dayKey(d) === dayKey(today);
                const list = byDay.get(dayKey(d)) ?? [];
                return (
                  <div
                    key={i}
                    onDoubleClick={() => setCreating(d)}
                    className={cn(
                      'group min-h-24 border-r border-b p-1.5 sm:min-h-28',
                      (i + 1) % 7 === 0 && 'border-r-0',
                      !inMonth && 'bg-muted/30',
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={cn(
                          'grid size-6 place-items-center rounded-full text-xs tabular-nums',
                          !inMonth && 'text-muted-foreground/60',
                          isToday && 'bg-primary font-semibold text-primary-foreground',
                        )}
                      >
                        {d.getDate()}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {list.slice(0, 3).map((e) => (
                        <Popover key={e.id}>
                          <PopoverTrigger asChild>
                            <button
                              className="flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium transition-opacity hover:opacity-80"
                              style={eventColor(e)}
                            >
                              <EventIcon kind={e.kind} />
                              <span className="truncate">{e.title}</span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64">
                            <EventDetails event={e} onDeleted={refresh} />
                          </PopoverContent>
                        </Popover>
                      ))}
                      {list.length > 3 && <p className="px-1.5 text-[11px] text-muted-foreground">+{list.length - 3} more</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Coming up" description="The next things on your calendar." />
          <div className="space-y-1 px-2 pb-3">
            {upcoming.length === 0 && <p className="px-3 pb-3 text-sm text-muted-foreground">Nothing scheduled in this view.</p>}
            {upcoming.map((e) => {
              const d = new Date(e.startsAt);
              const inner = (
                <>
                  <span className="flex w-11 shrink-0 flex-col items-center rounded-lg border bg-card py-1">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase">
                      {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d)}
                    </span>
                    <span className="text-base leading-tight font-semibold tabular-nums">{d.getDate()}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{e.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatTime(e.startsAt)}
                      {e.course && ` · ${e.course.title}`}
                    </span>
                  </span>
                </>
              );
              return e.link ? (
                <Link key={e.id} to={e.link} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50">
                  {inner}
                </Link>
              ) : (
                <div key={e.id} className="flex items-center gap-3 rounded-lg px-3 py-2">
                  {inner}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      {creating && (
        <NewEventDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} onCreated={refresh} defaultDate={creating} />
      )}
    </Page>
  );
}
