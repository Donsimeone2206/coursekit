import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarClock, Check, ChevronRight, Circle, CircleCheck, EyeOff, PanelLeft, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { ActivityDetail, CourseDetail } from '@shared/types';
import { ActivityIcon } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { GroupRestrictionBadge } from '@/components/group-modes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/misc';
import { ACTIVITY_META, activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { cn, dueLabel, isPast } from '@/lib/utils';
import { ActivityEditor } from '../course/ActivityEditor';
import { allActivities, useCourseQuery, useInvalidateCourse } from '../course/context';

export function useActivity(activityId: string | undefined) {
  return useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => api.get<ActivityDetail>(`/activities/${activityId}`),
    enabled: !!activityId,
  });
}

function CourseOutline({ course, currentId, onNavigate }: { course: CourseDetail; currentId: string; onNavigate?: () => void }) {
  const tracked = allActivities(course).filter((a) => a.visible && a.completion !== 'none');
  const done = tracked.filter((a) => a.completed).length;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <Link to={`/courses/${course.slug}`} onClick={onNavigate} className="flex items-center gap-2.5 font-semibold hover:text-primary">
          <span className="size-3 shrink-0 rounded" style={coverDot(course.coverColor)} />
          <span className="truncate text-sm">{course.title}</span>
        </Link>
        {course.progress != null && (
          <div className="mt-3 space-y-1.5">
            <Progress value={course.progress} tone={course.progress === 100 ? 'success' : 'primary'} />
            <p className="text-xs text-muted-foreground">
              {done} of {tracked.length} complete
            </p>
          </div>
        )}
      </div>
      <nav className="ck-scrollbar flex-1 overflow-y-auto p-2">
        {course.sections.map((s, i) => (
          <div key={s.id} className="mb-2">
            <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {i + 1}. {s.title}
            </p>
            {s.activities.map((a) => {
              const active = a.id === currentId;
              return (
                <Link
                  key={a.id}
                  to={activityPath(course.slug, a.id)}
                  onClick={onNavigate}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    active && 'bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary',
                    !a.visible && 'opacity-60',
                  )}
                >
                  {course.myRole === 'student' && a.completion !== 'none' ? (
                    a.completed ? (
                      <CircleCheck className="size-4 shrink-0 text-success" />
                    ) : (
                      <Circle className="size-4 shrink-0 opacity-40" />
                    )
                  ) : (
                    (() => {
                      const Icon = ACTIVITY_META[a.type].icon;
                      return <Icon className="size-4 shrink-0" />;
                    })()
                  )}
                  <span className="truncate">{a.title}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </div>
  );
}

function CompletionButton({ activity }: { activity: ActivityDetail }) {
  const invalidate = useInvalidateCourse();
  const toggle = useMutation({
    mutationFn: () =>
      activity.completed ? api.delete(`/activities/${activity.id}/complete`) : api.post(`/activities/${activity.id}/complete`),
    onSuccess: async () => {
      if (!activity.completed) toast.success('Nice work! Marked as done.');
      await invalidate(activity.course.slug);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (activity.myRole !== 'student' || activity.completion !== 'manual') return null;
  return (
    <Button
      variant={activity.completed ? 'outline' : 'default'}
      onClick={() => toggle.mutate()}
      loading={toggle.isPending}
      className={cn(activity.completed && 'border-success/40 text-success hover:bg-success/5')}
    >
      {activity.completed ? <CircleCheck /> : <Check />}
      {activity.completed ? 'Completed' : 'Mark as done'}
    </Button>
  );
}

function PrevNext({ activity }: { activity: ActivityDetail }) {
  if (!activity.prev && !activity.next) return null;
  const card = (item: NonNullable<ActivityDetail['prev']>, dir: 'prev' | 'next') => (
    <Link
      to={activityPath(activity.course.slug, item.id)}
      className={cn(
        'group flex items-center gap-3 rounded-xl border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-md',
        dir === 'next' && 'flex-row-reverse text-right',
      )}
    >
      {dir === 'prev' ? (
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
      ) : (
        <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
      )}
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{dir === 'prev' ? 'Previous' : 'Next up'}</span>
        <span className="block truncate text-sm font-medium group-hover:text-primary">{item.title}</span>
      </span>
    </Link>
  );
  return (
    <div className="mt-10 grid gap-3 sm:grid-cols-2">
      <div>{activity.prev && card(activity.prev, 'prev')}</div>
      <div>{activity.next && card(activity.next, 'next')}</div>
    </div>
  );
}

export function ActivityHeader({ activity, actions }: { activity: ActivityDetail; actions?: ReactNode }) {
  const isStudent = activity.myRole === 'student';
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start">
      <ActivityIcon type={activity.type} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-muted-foreground">
          {ACTIVITY_META[activity.type].label}
          {activity.sectionTitle && ` · ${activity.sectionTitle}`}
        </p>
        <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{activity.title}</h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {activity.dueAt && (
            <Badge variant={isStudent && isPast(activity.dueAt) && !activity.completed ? 'danger' : 'neutral'}>
              <CalendarClock /> {dueLabel(activity.dueAt, !isStudent || activity.completed)}
            </Badge>
          )}
          {activity.maxGrade != null && <Badge variant="neutral">{activity.maxGrade} points</Badge>}
          {activity.meta && activity.type !== 'assignment' && <Badge variant="neutral">{activity.meta}</Badge>}
          {!activity.visible && (
            <Badge variant="warning">
              <EyeOff /> Hidden from students
            </Badge>
          )}
          <GroupRestrictionBadge groups={activity.groupRestriction} />
          {isStudent && activity.completed && (
            <Badge variant="success">
              <CircleCheck /> Completed
            </Badge>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ActivityFrame({ activity, children, actions }: { activity: ActivityDetail; children: ReactNode; actions?: ReactNode }) {
  const { data: course } = useCourseQuery(activity.course.slug);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const canEdit = activity.capabilities.includes('course:manageContent');

  return (
    <div className="flex">
      {course && (
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-72 shrink-0 border-r bg-sidebar/50 xl:block">
          <CourseOutline course={course} currentId={activity.id} />
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <Page size="default" className="max-w-5xl">
          <nav className="mb-5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {course && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="mr-1 xl:hidden"
                onClick={() => setOutlineOpen(true)}
                aria-label="Course outline"
              >
                <PanelLeft />
              </Button>
            )}
            <Link to={`/courses/${activity.course.slug}`} className="flex min-w-0 items-center gap-1.5 hover:text-foreground">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={coverDot(activity.course.coverColor)} />
              <span className="truncate">{activity.course.title}</span>
            </Link>
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="truncate text-foreground">{activity.title}</span>
          </nav>
          <ActivityHeader
            activity={activity}
            actions={
              <>
                {actions}
                {canEdit && (
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    <Pencil /> Edit
                  </Button>
                )}
                <CompletionButton activity={activity} />
              </>
            }
          />
          {children}
          <PrevNext activity={activity} />
        </Page>
      </div>
      {course && (
        <Dialog open={outlineOpen} onOpenChange={setOutlineOpen}>
          <SheetContent className="w-80 bg-card">
            <CourseOutline course={course} currentId={activity.id} onNavigate={() => setOutlineOpen(false)} />
          </SheetContent>
        </Dialog>
      )}
      {course && editing && <ActivityEditor course={course} open={editing} onOpenChange={setEditing} activityId={activity.id} />}
    </div>
  );
}
