import { useMutation } from '@tanstack/react-query';
import {
  ArrowRight,
  Award,
  BookOpen,
  CalendarRange,
  Check,
  ChevronRight,
  KeyRound,
  Lock,
  Megaphone,
  Pencil,
  Settings,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { CourseDetail } from '@shared/types';
import { ActivityIcon, CourseCover } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Markdown } from '@/components/markdown';
import { AvatarStack } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { ErrorState, ProgressRing, Skeleton } from '@/components/ui/misc';
import { ACTIVITY_META, activityPath } from '@/lib/activity';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { cn, formatDate, plural } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';
import { allActivities, nextActivity, useCourseQuery, useInvalidateCourse } from './context';

function Meta({ course }: { course: CourseDetail }) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/85">
      {course.teachers.length > 0 && (
        <span className="flex items-center gap-2">
          <AvatarStack users={course.teachers} max={3} size="xs" />
          {course.teachers.map((t) => t.name).join(', ')}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <Users className="size-4" /> {plural(course.studentCount, 'student')}
      </span>
      <span className="flex items-center gap-1.5">
        <BookOpen className="size-4" /> {plural(course.activityCount, 'activity', 'activities')}
      </span>
      {(course.startDate || course.endDate) && (
        <span className="flex items-center gap-1.5">
          <CalendarRange className="size-4" /> {formatDate(course.startDate)} – {formatDate(course.endDate)}
        </span>
      )}
    </div>
  );
}

function Hero({ course, editing, setEditing }: { course: CourseDetail; editing: boolean; setEditing: (v: boolean) => void }) {
  const canEdit = course.capabilities.includes('course:manageContent');
  const tracked = allActivities(course).filter((a) => a.visible && a.completion !== 'none');
  const done = tracked.filter((a) => a.completed).length;
  const next = course.myRole === 'student' ? nextActivity(course) : null;

  return (
    <CourseCover color={course.coverColor} imageUrl={course.coverImageUrl} className="text-white">
      <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
      <div className="relative mx-auto max-w-7xl px-4 pt-6 pb-8 sm:px-6 lg:px-8 lg:pt-8">
        <nav className="flex items-center gap-1.5 text-[13px] text-white/75">
          <Link to="/catalog" className="hover:text-white">
            Courses
          </Link>
          {course.categoryName && (
            <>
              <ChevronRight className="size-3.5" />
              <Link to={`/catalog?category=${course.categoryId}`} className="hover:text-white">
                {course.categoryName}
              </Link>
            </>
          )}
        </nav>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl min-w-0">
            <div className="mb-3 flex flex-wrap gap-2">
              {course.visibility !== 'published' && (
                <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-900 capitalize">
                  {course.visibility}
                </span>
              )}
              {course.myRole && (
                <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium backdrop-blur">
                  {COURSE_ROLE_LABELS[course.myRole]}
                </span>
              )}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{course.title}</h1>
            {course.summary && <p className="mt-2.5 max-w-2xl text-[15px] leading-relaxed text-white/85">{course.summary}</p>}
            <Meta course={course} />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            {course.progress != null && (
              <div className="flex items-center gap-3 rounded-xl bg-black/15 py-2.5 pr-4 pl-2.5 ring-1 ring-white/20 backdrop-blur-md">
                <ProgressRing value={course.progress} size={46} className="text-white" />
                <div className="text-sm">
                  <p className="font-semibold">Your progress</p>
                  <p className="text-white/75">
                    {done} of {tracked.length} done
                  </p>
                </div>
              </div>
            )}
            {next && (
              <Button asChild className="bg-white text-slate-900 shadow-lg hover:bg-white/90 hover:brightness-100" size="lg">
                <Link to={activityPath(course.slug, next.id)}>
                  Continue <ArrowRight />
                </Link>
              </Button>
            )}
            {canEdit && (
              <Button
                size="lg"
                onClick={() => setEditing(!editing)}
                className={cn(
                  'hover:brightness-100',
                  editing
                    ? 'bg-white text-slate-900 hover:bg-white/90'
                    : 'bg-white/15 text-white ring-1 ring-white/25 backdrop-blur hover:bg-white/25',
                )}
              >
                {editing ? <Check /> : <Pencil />}
                {editing ? 'Done editing' : 'Edit course'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </CourseCover>
  );
}

/** What people who aren't enrolled see: description, outline and an enrol button. */
function CourseLanding({ course }: { course: CourseDetail }) {
  const [key, setKey] = useState('');
  const invalidate = useInvalidateCourse();
  const enrol = useMutation({
    mutationFn: () => api.post(`/courses/${course.id}/enrol`, course.hasEnrolmentKey ? { key } : {}),
    onSuccess: async () => {
      toast.success(`You're enrolled in ${course.title}. Have fun!`);
      await invalidate(course.slug);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <CourseCover color={course.coverColor} imageUrl={course.coverImageUrl} className="text-white">
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
        <div className="relative mx-auto max-w-7xl px-4 pt-10 pb-12 sm:px-6 lg:px-8">
          <p className="text-sm text-white/75">{course.categoryName ?? 'Course'}</p>
          <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">{course.title}</h1>
          <p className="mt-3 max-w-2xl text-base text-white/85">{course.summary}</p>
          <Meta course={course} />
        </div>
      </CourseCover>
      <Page>
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-8">
            {course.description && (
              <Card className="p-6">
                <Markdown source={course.description} />
              </Card>
            )}
            <div>
              <h2 className="mb-3 text-lg font-semibold tracking-tight">Course outline</h2>
              <div className="space-y-3">
                {course.sections.map((s, i) => (
                  <Card key={s.id}>
                    <div className="flex items-center gap-3 border-b px-5 py-3.5">
                      <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
                      <p className="font-medium">{s.title}</p>
                      <span className="ml-auto text-xs text-muted-foreground">{plural(s.activities.length, 'activity', 'activities')}</span>
                    </div>
                    <ul className="divide-y">
                      {s.activities.map((a) => (
                        <li key={a.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                          <ActivityIcon type={a.type} size="sm" />
                          <span className="flex-1 truncate">{a.title}</span>
                          <span className="text-xs text-muted-foreground">{ACTIVITY_META[a.type].label}</span>
                          <Lock className="size-3.5 text-muted-foreground/60" />
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            </div>
          </div>
          <Card className="sticky top-20">
            <CardHeader
              title="Join this course"
              description={course.canEnrol ? 'Get instant access to every lesson and activity.' : undefined}
            />
            <div className="space-y-3 px-5 pb-5">
              {course.canEnrol ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    enrol.mutate();
                  }}
                  className="space-y-3"
                >
                  {course.hasEnrolmentKey && (
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder="Enrolment key"
                        className="pl-9"
                        aria-label="Enrolment key"
                      />
                    </div>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    loading={enrol.isPending}
                    disabled={course.hasEnrolmentKey && !key.trim()}
                  >
                    Enrol now
                  </Button>
                  {course.hasEnrolmentKey && (
                    <p className="text-xs text-muted-foreground">Your teacher gives you the key for this course.</p>
                  )}
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">This course is invite-only. Ask a teacher to add you.</p>
              )}
            </div>
          </Card>
        </div>
      </Page>
    </div>
  );
}

function CourseSkeleton() {
  return (
    <div>
      <Skeleton className="h-64 rounded-none" />
      <Page>
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </Page>
    </div>
  );
}

export default function CourseLayout() {
  const { slug } = useParams();
  const { data: course, isLoading, error, refetch } = useCourseQuery(slug);
  const [editing, setEditing] = useState(false);
  useTitle(course?.title);

  if (isLoading) return <CourseSkeleton />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !course) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Page>
    );
  }
  if (course.outlineOnly) return <CourseLanding course={course} />;

  const can = (cap: Parameters<typeof course.capabilities.includes>[0]) => course.capabilities.includes(cap);
  const tabs = [
    { to: '', label: 'Course', icon: BookOpen, end: true },
    { to: 'announcements', label: 'Announcements', icon: Megaphone },
    { to: 'participants', label: 'Participants', icon: Users, show: can('course:viewParticipants') },
    { to: 'grades', label: 'Grades', icon: Award },
    { to: 'settings', label: 'Settings', icon: Settings, show: can('course:update') },
  ].filter((t) => t.show !== false);

  return (
    <div>
      <Hero course={course} editing={editing} setEditing={setEditing} />
      <div className="sticky top-14 z-20 border-b bg-background/85 backdrop-blur-lg">
        <nav className="ck-no-scrollbar mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8">
          {tabs.map((t) => (
            <NavLink
              key={t.label}
              to={t.to ? `/courses/${course.slug}/${t.to}` : `/courses/${course.slug}`}
              end={t.end}
              className={({ isActive }) =>
                cn(
                  'relative flex h-12 shrink-0 items-center gap-2 px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                  isActive &&
                    'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary',
                )
              }
            >
              <t.icon className="size-4" />
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet context={{ course, editing, setEditing, can }} />
    </div>
  );
}
