import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDashed,
  Eye,
  EyeOff,
  FolderInput,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { ActivitySummary, Announcement, CourseDetail, Section } from '@shared/types';
import { CompletionCard } from '@/components/completion/completion-card';
import { ActivityIcon } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Tooltip,
} from '@/components/ui/menu';
import { EmptyState, Progress } from '@/components/ui/misc';
import { ACTIVITY_META, activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { cn, dueLabel, excerptOf, formatRelative, isPast } from '@/lib/utils';
import { ActivityEditor } from './ActivityEditor';
import { useCourseContext, useInvalidateCourse } from './context';

function CompletionMark({ activity, onToggle, busy }: { activity: ActivitySummary; onToggle: () => void; busy: boolean }) {
  if (activity.completion === 'none') return null;
  if (activity.completed) {
    return activity.completion === 'manual' ? (
      <Tooltip content="Completed. Click to undo">
        <button
          onClick={onToggle}
          disabled={busy}
          className="text-success transition-transform hover:scale-110"
          aria-label="Mark as not done"
        >
          <CircleCheck className="size-5" />
        </button>
      </Tooltip>
    ) : (
      <Tooltip content="Completed">
        <CircleCheck className="size-5 text-success" />
      </Tooltip>
    );
  }
  return activity.completion === 'manual' ? (
    <Tooltip content="Mark as done">
      <button
        onClick={onToggle}
        disabled={busy}
        className="text-muted-foreground/50 transition-colors hover:text-success"
        aria-label="Mark as done"
      >
        <Circle className="size-5" />
      </button>
    </Tooltip>
  ) : (
    <Tooltip content="Completes automatically">
      <CircleDashed className="size-5 text-muted-foreground/40" />
    </Tooltip>
  );
}

function SectionDialog({
  open,
  onOpenChange,
  course,
  section,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  course: CourseDetail;
  section?: Section;
}) {
  const [title, setTitle] = useState(section?.title ?? '');
  const [summary, setSummary] = useState(section?.summary ?? '');
  const invalidate = useInvalidateCourse();
  const save = useMutation({
    mutationFn: () =>
      section
        ? api.patch(`/courses/${course.id}/sections/${section.id}`, { title, summary })
        : api.post(`/courses/${course.id}/sections`, { title, summary }),
    onSuccess: async () => {
      await invalidate(course.slug);
      onOpenChange(false);
      toast.success(section ? 'Section updated' : 'Section added');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            title={section ? 'Edit section' : 'New section'}
            description="Sections group activities into weeks, topics or modules."
          />
          <DialogBody className="space-y-4">
            <Field label="Title">
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Week 3: Working with data"
                />
              )}
            </Field>
            <Field label="Summary" optional>
              {(p) => (
                <Textarea
                  {...p}
                  rows={3}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="What students will do in this section"
                />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {section ? 'Save' : 'Add section'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ActivityRow({
  activity,
  course,
  editing,
  isStudent,
  onEdit,
  onMove,
  onMoveTo,
}: {
  activity: ActivitySummary;
  course: CourseDetail;
  editing: boolean;
  isStudent: boolean;
  onEdit: () => void;
  onMove: (dir: -1 | 1) => void;
  onMoveTo: (sectionId: string) => void;
}) {
  const invalidate = useInvalidateCourse();
  const confirm = useConfirm();
  const toggle = useMutation({
    mutationFn: () =>
      activity.completed ? api.delete(`/activities/${activity.id}/complete`) : api.post(`/activities/${activity.id}/complete`),
    onSuccess: () => invalidate(course.slug),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/activities/${activity.id}`, body),
    onSuccess: () => invalidate(course.slug),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/activities/${activity.id}`),
    onSuccess: async () => {
      await invalidate(course.slug);
      toast.success('Activity deleted');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const overdue = isStudent && activity.dueAt && isPast(activity.dueAt) && !activity.completed;

  return (
    <li
      className={cn(
        'group relative flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-accent/40',
        !activity.visible && 'bg-muted/40',
      )}
    >
      <ActivityIcon type={activity.type} className={cn(!activity.visible && 'opacity-50')} />
      <Link to={activityPath(course.slug, activity.id)} className="min-w-0 flex-1 after:absolute after:inset-0">
        <p className={cn('truncate text-sm font-medium group-hover:text-primary', !activity.visible && 'text-muted-foreground')}>
          {activity.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{ACTIVITY_META[activity.type].label}</span>
          {activity.meta && (
            <>
              <span className="text-muted-foreground/40">•</span>
              <span>{activity.meta}</span>
            </>
          )}
          {activity.dueAt && (
            <>
              <span className="text-muted-foreground/40">•</span>
              <span className={cn('flex items-center gap-1', overdue && 'font-medium text-destructive')}>
                <CalendarClock className="size-3" />
                {dueLabel(activity.dueAt, !isStudent || activity.completed)}
              </span>
            </>
          )}
        </p>
      </Link>
      {!activity.visible && (
        <Badge variant="outline" className="relative">
          <EyeOff /> Hidden
        </Badge>
      )}
      {editing ? (
        <div className="relative flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit activity">
            <Pencil />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => onMove(-1)}>
                <ArrowUp /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onMove(1)}>
                <ArrowDown /> Move down
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput /> Move to section
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {course.sections
                    .filter((s) => s.id !== activity.sectionId)
                    .map((s) => (
                      <DropdownMenuItem key={s.id} onSelect={() => onMoveTo(s.id)}>
                        {s.title}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={() => update.mutate({ visible: !activity.visible })}>
                {activity.visible ? <EyeOff /> : <Eye />} {activity.visible ? 'Hide from students' : 'Show to students'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={async () => {
                  if (
                    await confirm({
                      title: `Delete “${activity.title}”?`,
                      description: 'This removes the activity and all of its submissions, attempts, posts and grades.',
                      confirmLabel: 'Delete',
                      destructive: true,
                    })
                  )
                    remove.mutate();
                }}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        isStudent && (
          <span className="relative">
            <CompletionMark activity={activity} onToggle={() => toggle.mutate()} busy={toggle.isPending} />
          </span>
        )
      )}
    </li>
  );
}

function SectionCard({
  section,
  index,
  course,
  editing,
  isStudent,
  onAddActivity,
  onEditActivity,
}: {
  section: Section;
  index: number;
  course: CourseDetail;
  editing: boolean;
  isStudent: boolean;
  onAddActivity: () => void;
  onEditActivity: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [editingSection, setEditingSection] = useState(false);
  const invalidate = useInvalidateCourse();
  const confirm = useConfirm();
  const tracked = section.activities.filter((a) => a.visible && a.completion !== 'none');
  const done = tracked.filter((a) => a.completed).length;

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => invalidate(course.slug),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const moveSection = (dir: -1 | 1) => {
    const ids = course.sections.map((s) => s.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    run.mutate(() => api.put(`/courses/${course.id}/sections/order`, { ids }));
  };

  const moveActivity = (activityId: string, dir: -1 | 1) => {
    const ids = section.activities.map((a) => a.id);
    const i = ids.indexOf(activityId);
    const target = i + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[i], ids[target]] = [ids[target]!, ids[i]!];
    run.mutate(() => api.put(`/courses/${course.id}/activities/order`, { sectionId: section.id, ids }));
  };

  const moveActivityTo = (activityId: string, sectionId: string) => {
    const targetSection = course.sections.find((s) => s.id === sectionId);
    if (!targetSection) return;
    const ids = [...targetSection.activities.map((a) => a.id), activityId];
    run.mutate(() => api.put(`/courses/${course.id}/activities/order`, { sectionId, ids }));
  };

  return (
    <Card className={cn('overflow-hidden', !section.visible && 'border-dashed')}>
      <div className="flex items-start gap-3 px-5 py-4">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-3 text-left" aria-expanded={open}>
          <span
            className={cn(
              'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
              isStudent && tracked.length > 0 && done === tracked.length ? 'bg-success text-white' : 'bg-muted text-muted-foreground',
            )}
          >
            {isStudent && tracked.length > 0 && done === tracked.length ? <CircleCheck className="size-4" /> : index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold tracking-tight">{section.title}</span>
              {!section.visible && (
                <Badge variant="outline">
                  <EyeOff /> Hidden
                </Badge>
              )}
            </span>
            {section.summary && <span className="mt-0.5 block text-sm text-muted-foreground">{section.summary}</span>}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {isStudent && tracked.length > 0 && (
            <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
              <Progress value={(done / tracked.length) * 100} className="w-16" tone={done === tracked.length ? 'success' : 'primary'} />
              {done}/{tracked.length}
            </span>
          )}
          {editing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Section actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Section</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setEditingSection(true)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => moveSection(-1)} disabled={index === 0}>
                  <ArrowUp /> Move up
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => moveSection(1)} disabled={index === course.sections.length - 1}>
                  <ArrowDown /> Move down
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    run.mutate(() => api.patch(`/courses/${course.id}/sections/${section.id}`, { visible: !section.visible }))
                  }
                >
                  {section.visible ? <EyeOff /> : <Eye />} {section.visible ? 'Hide section' : 'Show section'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={async () => {
                    if (
                      await confirm({
                        title: `Delete “${section.title}”?`,
                        description: `This also deletes its ${section.activities.length} activities and everything students submitted to them.`,
                        confirmLabel: 'Delete section',
                        destructive: true,
                      })
                    ) {
                      run.mutate(() => api.delete(`/courses/${course.id}/sections/${section.id}`));
                    }
                  }}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button
            onClick={() => setOpen(!open)}
            className="text-muted-foreground"
            aria-label={open ? 'Collapse section' : 'Expand section'}
          >
            <ChevronDown className={cn('size-4.5 transition-transform', !open && '-rotate-90')} />
          </button>
        </div>
      </div>
      {open && (
        <>
          {section.activities.length > 0 ? (
            <ul className="divide-y border-t">
              {section.activities.map((a) => (
                <ActivityRow
                  key={a.id}
                  activity={a}
                  course={course}
                  editing={editing}
                  isStudent={isStudent}
                  onEdit={() => onEditActivity(a.id)}
                  onMove={(dir) => moveActivity(a.id, dir)}
                  onMoveTo={(sid) => moveActivityTo(a.id, sid)}
                />
              ))}
            </ul>
          ) : (
            !editing && <p className="border-t px-5 py-4 text-sm text-muted-foreground">Nothing here yet.</p>
          )}
          {editing && (
            <div className="border-t p-2">
              <button
                onClick={onAddActivity}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/[0.03] hover:text-primary"
              >
                <Plus className="size-4" /> Add activity
              </button>
            </div>
          )}
        </>
      )}
      {editingSection && <SectionDialog open={editingSection} onOpenChange={setEditingSection} course={course} section={section} />}
    </Card>
  );
}

export default function CourseContentPage() {
  const { course, editing } = useCourseContext();
  const [editor, setEditor] = useState<{ sectionId?: string; activityId?: string } | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const isStudent = course.myRole === 'student';
  const { data: announcements } = useQuery({
    queryKey: ['announcements', course.id],
    queryFn: () => api.get<Announcement[]>(`/courses/${course.id}/announcements`),
  });
  const upcoming = course.sections
    .flatMap((s) => s.activities)
    .filter((a) => a.dueAt && !isPast(a.dueAt) && a.visible)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
    .slice(0, 4);

  return (
    <Page>
      {editing && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.05] px-4 py-3 text-sm">
          <Pencil className="size-4 text-primary" />
          <span>
            <span className="font-medium">Edit mode is on.</span> Add, reorder, hide or delete sections and activities.
          </span>
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          {course.sections.length === 0 && (
            <EmptyState icon={Plus} title="This course is empty" description="Turn on edit mode to add the first section." />
          )}
          {course.sections.map((s, i) => (
            <SectionCard
              key={s.id}
              section={s}
              index={i}
              course={course}
              editing={editing}
              isStudent={isStudent}
              onAddActivity={() => setEditor({ sectionId: s.id })}
              onEditActivity={(id) => setEditor({ activityId: id })}
            />
          ))}
          {editing && (
            <Button variant="outline" className="w-full border-dashed" size="lg" onClick={() => setAddingSection(true)}>
              <Plus /> Add section
            </Button>
          )}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-32">
          <CompletionCard course={course} />
          {upcoming.length > 0 && (
            <Card>
              <CardHeader title="Coming up" icon={<CalendarClock className="size-4.5" />} />
              <div className="space-y-1 px-2 pb-3">
                {upcoming.map((a) => (
                  <Link
                    key={a.id}
                    to={activityPath(course.slug, a.id)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50"
                  >
                    <ActivityIcon type={a.type} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{a.title}</span>
                      <span className="block text-xs text-muted-foreground">{dueLabel(a.dueAt!)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          )}
          <Card>
            <CardHeader
              title="Latest news"
              icon={<Megaphone className="size-4.5" />}
              action={
                <Link to={`/courses/${course.slug}/announcements`} className="text-xs font-medium text-primary hover:underline">
                  View all
                </Link>
              }
            />
            <div className="space-y-1 px-2 pb-3">
              {(announcements ?? []).slice(0, 2).map((a) => (
                <Link key={a.id} to={`/courses/${course.slug}/announcements`} className="block rounded-lg px-3 py-2 hover:bg-accent/50">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{excerptOf(a.body)}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{formatRelative(a.createdAt)}</p>
                </Link>
              ))}
              {announcements?.length === 0 && <p className="px-3 pb-2 text-sm text-muted-foreground">No announcements yet.</p>}
            </div>
          </Card>
          {course.description && (
            <Card>
              <CardHeader title="Overview" />
              <div className="max-h-72 overflow-hidden px-5 pb-5 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
                <Markdown source={course.description} className="prose-sm" />
              </div>
            </Card>
          )}
        </aside>
      </div>

      {editor && (
        <ActivityEditor
          course={course}
          open={!!editor}
          onOpenChange={(o) => !o && setEditor(null)}
          sectionId={editor.sectionId}
          activityId={editor.activityId}
        />
      )}
      {addingSection && <SectionDialog open={addingSection} onOpenChange={setAddingSection} course={course} />}
    </Page>
  );
}
