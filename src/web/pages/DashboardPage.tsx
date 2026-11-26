import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Award,
  BookOpen,
  CalendarClock,
  CircleCheck,
  ClipboardCheck,
  Compass,
  Megaphone,
  Palette,
  Plus,
  Presentation,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { canCreateCourses } from '@shared/permissions';
import type { DashboardData, TimelineItem } from '@shared/types';
import { PageHeader, SectionTitle, StatCard } from '@/components/common';
import { ActivityIcon, CourseCard, CourseCardSkeleton } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useTitle } from '@/lib/hooks';
import { useMe, useSession } from '@/lib/session';
import { cn, dueLabel, excerptOf, formatNumber, formatRelative, greeting } from '@/lib/utils';

function bucket(item: TimelineItem): string {
  if (item.status === 'overdue') return 'Overdue';
  const due = new Date(item.dueAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((due.getTime() - today.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return 'This week';
  return 'Later';
}

/** Live class sessions in the upcoming list: "Live now", "Starts today at 10:00". */
function liveLabel(item: TimelineItem): string {
  const start = new Date(item.dueAt).getTime();
  const end = item.endsAt ? new Date(item.endsAt).getTime() : start;
  if (Date.now() >= start && Date.now() < end) return 'Live now';
  return dueLabel(item.dueAt, true).replace(/^Due/, 'Starts');
}

const isLiveNow = (item: TimelineItem) =>
  item.type === 'live' && Date.now() >= new Date(item.dueAt).getTime() && Date.now() < new Date(item.endsAt ?? item.dueAt).getTime();

const STATUS: Record<TimelineItem['status'], { label: string; variant: 'neutral' | 'danger' | 'success' | 'info' }> = {
  todo: { label: 'To do', variant: 'neutral' },
  overdue: { label: 'Overdue', variant: 'danger' },
  submitted: { label: 'Submitted', variant: 'info' },
  graded: { label: 'Graded', variant: 'success' },
  done: { label: 'Done', variant: 'success' },
};

function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="px-5 pb-6">
        <EmptyState
          icon={CalendarClock}
          title="Nothing due soon"
          description="Deadlines from your courses will show up here."
          className="py-8"
        />
      </div>
    );
  }
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) groups.set(bucket(item), [...(groups.get(bucket(item)) ?? []), item]);
  const order = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later'];
  return (
    <div className="pb-2">
      {order
        .filter((g) => groups.has(g))
        .map((g) => (
          <div key={g}>
            <p className={cn('px-5 pt-2 pb-1 text-xs font-semibold', g === 'Overdue' ? 'text-destructive' : 'text-muted-foreground')}>
              {g}
            </p>
            {groups.get(g)!.map((item) => {
              const done = item.status !== 'todo' && item.status !== 'overdue';
              return (
                <Link
                  key={item.activityId}
                  to={activityPath(item.course.slug, item.activityId)}
                  className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-accent/50"
                >
                  <ActivityIcon type={item.type} />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'truncate text-sm font-medium',
                        done && 'text-muted-foreground line-through decoration-muted-foreground/40',
                      )}
                    >
                      {item.title}
                    </p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span className="size-2 shrink-0 rounded-[3px]" style={coverDot(item.course.coverColor)} />
                      <span className="truncate">{item.course.title}</span>
                      <span>·</span>
                      <span className={cn('shrink-0', item.status === 'overdue' && 'text-destructive')}>
                        {item.type === 'live' ? liveLabel(item) : dueLabel(item.dueAt, done)}
                      </span>
                    </p>
                  </div>
                  {item.type === 'live' ? (
                    <Badge variant={isLiveNow(item) ? 'danger' : 'info'} className="hidden sm:inline-flex">
                      {isLiveNow(item) ? 'Live' : 'Live class'}
                    </Badge>
                  ) : (
                    <Badge variant={STATUS[item.status].variant} className="hidden sm:inline-flex">
                      {STATUS[item.status].label}
                    </Badge>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
    </div>
  );
}

function AdminQuickStart() {
  const actions: Array<{ to: string; icon: LucideIcon; title: string; text: string }> = [
    { to: '/courses/new', icon: Plus, title: 'Create a course', text: 'Start a draft and add lessons, quizzes and assignments.' },
    { to: '/admin/users', icon: UserPlus, title: 'Add people', text: 'Invite teachers and students, or log in as them.' },
    { to: '/admin/settings', icon: Palette, title: 'Make it yours', text: 'Set the site name, tagline and brand colour.' },
    { to: '/catalog', icon: Compass, title: 'Browse the catalog', text: 'See every published course the way students do.' },
  ];
  return (
    <section className="mt-8">
      <SectionTitle>Get started</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="group rounded-xl border bg-card p-5 shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <a.icon className="size-5" />
            </span>
            <p className="mt-4 flex items-center gap-1.5 font-semibold group-hover:text-primary">
              {a.title} <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{a.text}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <CourseCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  useTitle('Dashboard');
  const me = useMe()!;
  const { data: session } = useSession();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
  });
  const firstName = me.name.split(' ')[0];

  const cards = [];
  if (data) {
    const { stats } = data;
    if (stats.enrolled > 0) {
      cards.push(
        <StatCard key="enrolled" icon={BookOpen} label="Courses in progress" value={stats.enrolled} tone="primary" />,
        <StatCard key="done" icon={CircleCheck} label="Activities completed" value={stats.completedActivities} tone="emerald" />,
        <StatCard
          key="avg"
          icon={TrendingUp}
          label="Average grade"
          value={stats.averageGrade != null ? `${formatNumber(stats.averageGrade)}%` : '–'}
          tone="violet"
        />,
        <StatCard key="due" icon={CalendarClock} label="Due this week" value={stats.dueThisWeek} tone="amber" />,
      );
    }
    if (stats.teaching > 0) {
      const students = data.courses.filter((c) => c.myRole !== 'student').reduce((sum, c) => sum + c.studentCount, 0);
      const toGrade = data.toGrade.reduce((sum, t) => sum + t.count, 0);
      cards.push(
        <StatCard key="teaching" icon={Presentation} label="Courses teaching" value={stats.teaching} tone="sky" />,
        <StatCard key="students" icon={Users} label="Students" value={students} tone="primary" />,
        <StatCard key="grade" icon={ClipboardCheck} label="Waiting for grading" value={toGrade} tone="rose" />,
      );
    }
  }

  const learning = data?.courses ?? [];

  return (
    <Page>
      <PageHeader
        eyebrow={new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}
        title={`${greeting()}, ${firstName}`}
        description={session?.site.welcomeMessage}
        actions={
          canCreateCourses(me.role) ? (
            <Button asChild variant="outline">
              <Link to="/courses/new">
                <Plus /> New course
              </Link>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link to="/catalog">
                <Compass /> Explore courses
              </Link>
            </Button>
          )
        }
      />

      {isLoading ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <>
          {cards.length > 0 && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{cards.slice(0, 4)}</div>}

          {learning.length === 0 && me.role === 'admin' ? (
            <AdminQuickStart />
          ) : learning.length === 0 ? (
            <EmptyState
              className="mt-8"
              icon={Compass}
              title="You're not enrolled in any courses yet"
              description="Browse the catalog to find something to learn, or create your own course."
              action={
                <Button asChild>
                  <Link to="/catalog">
                    Explore courses <ArrowRight />
                  </Link>
                </Button>
              }
            />
          ) : (
            <section className="mt-8">
              <SectionTitle
                action={
                  <Link to="/my-courses" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                    All courses <ArrowRight className="size-3.5" />
                  </Link>
                }
              >
                Jump back in
              </SectionTitle>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {learning.slice(0, 3).map((c) => (
                  <CourseCard key={c.id} course={c} />
                ))}
              </div>
            </section>
          )}

          {(data.toGrade.length > 0 || data.stats.enrolled > 0 || data.announcements.length > 0 || data.recentGrades.length > 0) && (
            <div className="mt-8 grid items-start gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                {data.toGrade.length > 0 && (
                  <Card>
                    <CardHeader
                      title="Needs grading"
                      description="Submissions waiting for your feedback."
                      icon={<ClipboardCheck className="size-4.5" />}
                    />
                    <div className="pb-2">
                      {data.toGrade.map((t) => (
                        <div key={t.activityId} className="flex items-center gap-3 px-5 py-2.5">
                          <ActivityIcon type="assignment" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{t.title}</p>
                            <p className="truncate text-xs text-muted-foreground">{t.course.title}</p>
                          </div>
                          <Badge variant="warning">{t.count} to grade</Badge>
                          <Button asChild size="sm" variant="outline">
                            <Link to={`${activityPath(t.course.slug, t.activityId)}/submissions`}>Grade</Link>
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                {data.stats.enrolled > 0 && (
                  <Card>
                    <CardHeader
                      title="Upcoming"
                      description="Deadlines and live classes across your courses."
                      icon={<CalendarClock className="size-4.5" />}
                    />
                    <Timeline items={data.timeline} />
                  </Card>
                )}
              </div>

              <div className="space-y-6">
                <Card>
                  <CardHeader title="Announcements" icon={<Megaphone className="size-4.5" />} />
                  <div className="space-y-1 px-2 pb-3">
                    {data.announcements.length === 0 && <p className="px-3 pb-3 text-sm text-muted-foreground">No announcements yet.</p>}
                    {data.announcements.slice(0, 4).map((a) => (
                      <Link
                        key={a.id}
                        to={`/courses/${a.course.slug}/announcements`}
                        className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
                      >
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                          <span className="size-2 rounded-[3px]" style={coverDot(a.course.coverColor)} />
                          {a.course.title}
                        </p>
                        <p className="mt-1 text-sm font-medium">{a.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{excerptOf(a.body)}</p>
                        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Avatar user={a.author} size="xs" className="size-4 text-[7px] ring-1" />
                          {a.author.name} · {formatRelative(a.createdAt)}
                        </p>
                      </Link>
                    ))}
                  </div>
                </Card>

                {data.recentGrades.length > 0 && (
                  <Card>
                    <CardHeader title="Recent grades" icon={<Award className="size-4.5" />} />
                    <div className="space-y-1 px-2 pb-3">
                      {data.recentGrades.map((g) => {
                        const pct = g.maxGrade ? Math.round((g.score / g.maxGrade) * 100) : 0;
                        return (
                          <Link
                            key={g.activityId}
                            to={activityPath(g.course.slug, g.activityId)}
                            className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{g.title}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {formatNumber(g.score)} / {formatNumber(g.maxGrade)} · {formatRelative(g.gradedAt)}
                              </p>
                            </div>
                            <Badge variant={pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'danger'}>{pct}%</Badge>
                          </Link>
                        );
                      })}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
