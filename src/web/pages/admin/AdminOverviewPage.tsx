import { useQuery } from '@tanstack/react-query';
import { BookOpen, Database, GraduationCap, MessagesSquare, Upload, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { SITE_ROLE_LABELS } from '@shared/permissions';
import type { AdminOverview } from '@shared/types';
import { StatCard } from '@/components/common';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useTitle } from '@/lib/hooks';
import { cn, formatDate, formatRelative } from '@/lib/utils';

function niceMax(n: number) {
  if (n <= 4) return Math.max(1, n);
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= n / 2)! * pow;
  return Math.ceil(n / step) * step;
}

/** Daily sign-ups as a single-series column chart (brand colour, hover/focus tooltips, table for screen readers). */
function SignupsChart({ data }: { data: AdminOverview['signups'] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.count)));
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const total = data.reduce((s, d) => s + d.count, 0);
  const label = (d: { date: string }) => formatDate(`${d.date}T12:00:00Z`, { month: 'short', day: 'numeric' });

  return (
    <Card>
      <CardHeader title="New sign-ups" description={`Last 30 days · ${total} total`} />
      <div className="px-5 pb-5">
        <div className="relative flex h-48 gap-3">
          <div className="flex flex-col-reverse justify-between pb-6 text-right text-[11px] text-muted-foreground tabular-nums" aria-hidden>
            {ticks.map((t) => (
              <span key={t} className="-translate-y-1/2 leading-none first:translate-y-1/2">
                {t}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="absolute inset-x-0 top-0 bottom-6 flex flex-col-reverse justify-between" aria-hidden>
              {ticks.map((t) => (
                <div key={t} className="h-px bg-border" />
              ))}
            </div>
            <div
              className="absolute inset-x-0 top-0 bottom-6 flex items-end gap-[2px]"
              role="img"
              aria-label={`Sign-ups per day for the last 30 days, ${total} in total`}
            >
              {data.map((d, i) => (
                <button
                  key={d.date}
                  type="button"
                  className="group relative flex h-full flex-1 items-end justify-center outline-none"
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  aria-label={`${label(d)}: ${d.count} sign-up${d.count === 1 ? '' : 's'}`}
                >
                  {d.count > 0 && (
                    <span
                      className={cn('w-[70%] max-w-6 rounded-t-[4px] bg-primary transition-[filter]', active === i && 'brightness-110')}
                      style={{ height: `${(d.count / max) * 100}%` }}
                    />
                  )}
                  {active === i && (
                    <span className="pointer-events-none absolute bottom-full z-10 mb-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-left whitespace-nowrap shadow-lg">
                      <span className="block text-sm font-semibold">
                        {d.count} sign-up{d.count === 1 ? '' : 's'}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">{label(d)}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="absolute inset-x-0 bottom-0 flex justify-between text-[11px] text-muted-foreground" aria-hidden>
              <span>{label(data[0]!)}</span>
              <span>{label(data[Math.floor(data.length / 2)]!)}</span>
              <span>{label(data[data.length - 1]!)}</span>
            </div>
          </div>
        </div>
        <table className="sr-only">
          <caption>Sign-ups per day</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Sign-ups</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td>{label(d)}</td>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function AdminOverviewPage() {
  useTitle('Administration');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/admin/overview'),
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[104px]" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  const topMax = Math.max(1, ...data.topCourses.map((c) => c.students));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="People" value={data.counts.users.toLocaleString()} tone="primary" />
        <StatCard icon={BookOpen} label="Courses" value={data.counts.courses.toLocaleString()} tone="sky" />
        <StatCard icon={GraduationCap} label="Enrolments" value={data.counts.enrolments.toLocaleString()} tone="violet" />
        <StatCard
          icon={Upload}
          label="Submissions"
          value={data.counts.submissions.toLocaleString()}
          hint={`${data.counts.posts.toLocaleString()} forum posts`}
          tone="emerald"
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <SignupsChart data={data.signups} />
        <Card>
          <CardHeader title="Most popular courses" description="Active student enrolments" />
          <div className="space-y-3.5 px-5 pb-5">
            {data.topCourses.length === 0 && <p className="text-sm text-muted-foreground">No courses yet.</p>}
            {data.topCourses.map((c) => (
              <Link key={c.id} to={`/courses/${c.slug}`} className="group block">
                <div className="mb-1.5 flex items-center gap-2 text-sm">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={coverDot(c.coverColor)} />
                  <span className="truncate font-medium group-hover:text-primary">{c.title}</span>
                  <span className="ml-auto text-muted-foreground tabular-nums">{c.students}</span>
                </div>
                <div className="h-2 rounded-r-[4px] bg-transparent">
                  <div className="h-2 rounded-r-[4px] bg-primary" style={{ width: `${Math.max(2, (c.students / topMax) * 100)}%` }} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Newest people"
            action={
              <Link to="/admin/users" className="text-xs font-medium text-primary hover:underline">
                Manage users
              </Link>
            }
          />
          <div className="divide-y border-t">
            {data.recentUsers.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar user={u} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{u.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                </div>
                <Badge variant={u.role === 'admin' ? 'violet' : u.role === 'instructor' ? 'info' : 'neutral'}>
                  {SITE_ROLE_LABELS[u.role]}
                </Badge>
                <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">{formatRelative(u.createdAt)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="System" icon={<Database className="size-4.5" />} />
          <dl className="space-y-3 px-5 pb-5 text-sm">
            {[
              ['Version', `Coursekit ${data.version}`],
              ['Database', data.database],
              ['Activities', data.counts.activities.toLocaleString()],
              ['Forum posts', data.counts.posts.toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
              <MessagesSquare className="size-3.5" /> Coursekit is open source. Contributions welcome!
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
