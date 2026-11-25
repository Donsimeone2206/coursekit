import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDashed,
  Clock,
  Flag,
  ListChecks,
  MoreHorizontal,
  RotateCcw,
  ScrollText,
  Search,
  Settings,
  ShieldX,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { Certificate, CertificateSummary, CompletionReport, CompletionReportRow } from '@shared/completion';
import { StatCard } from '@/components/common';
import { RevokeCertificateDialog } from '@/components/completion/revoke-dialog';
import { ActivityIcon } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState, Progress, Segmented, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { achievementKeys, percent } from '@/lib/achievements';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { cn, formatDate } from '@/lib/utils';
import { useCourseContext } from './context';

type StatusFilter = 'all' | 'completed' | 'progress' | 'notStarted';

function rowStatus(r: CompletionReportRow): Exclude<StatusFilter, 'all'> {
  if (r.completedAt) return 'completed';
  return r.activitiesDone > 0 || r.gradeMet ? 'progress' : 'notStarted';
}

function StatusBadge({ row }: { row: CompletionReportRow }) {
  const status = rowStatus(row);
  if (status === 'completed') {
    return (
      <Badge variant="success">
        <CircleCheck /> Completed {formatDate(row.completedAt)}
      </Badge>
    );
  }
  return status === 'progress' ? (
    <Badge variant="info">
      <Clock /> In progress
    </Badge>
  ) : (
    <Badge variant="neutral">
      <CircleDashed /> Not started
    </Badge>
  );
}

function Criteria({ report, slug, canManage }: { report: CompletionReport; slug: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const facts = [
    {
      label: 'Students must complete',
      value: `${report.mode === 'all' ? 'All activities' : 'Selected activities'} (${report.activities.length})`,
    },
    { label: 'Minimum course grade', value: report.minGrade == null ? 'None' : percent(report.minGrade) },
    { label: 'Certificate', value: report.certificateEnabled ? 'Issued on completion' : 'Off' },
  ];
  return (
    <Card className="mt-4">
      <div className="flex flex-col gap-4 p-5 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <ListChecks className="mt-0.5 size-4.5 shrink-0 text-muted-foreground" />
          <dl className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
            {facts.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                <dd className="mt-0.5 text-sm font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 pl-7.5 md:pl-0">
          {report.activities.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="completion-activities">
              {open ? 'Hide activities' : 'Show activities'}
            </Button>
          )}
          {canManage && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/courses/${slug}/settings#completion`}>
                <Settings /> Edit criteria
              </Link>
            </Button>
          )}
        </div>
      </div>
      {report.activities.length === 0 && (
        <p className="border-t px-5 py-3 text-sm text-muted-foreground">
          No activity counts towards completion yet: turn on completion tracking for some activities.
        </p>
      )}
      {open && (
        <ul id="completion-activities" className="grid gap-1 border-t px-3 py-3 sm:grid-cols-2 lg:grid-cols-3">
          {report.activities.map((a) => (
            <li key={a.id} className="min-w-0">
              <Link
                to={activityPath(slug, a.id)}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/50 hover:text-primary"
              >
                <ActivityIcon type={a.type} size="sm" />
                <span className="truncate">{a.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StudentsTable({ report, slug }: { report: CompletionReport; slug: string }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return report.rows.filter(
      (r) =>
        (status === 'all' || rowStatus(r) === status) &&
        (!term || r.user.name.toLowerCase().includes(term) || r.user.email.toLowerCase().includes(term)),
    );
  }, [report.rows, q, status]);
  const showGrade = report.minGrade != null;

  if (report.rows.length === 0) {
    return <EmptyState icon={Users} title="No students yet" description="Students appear here once they enrol in the course." />;
  }
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a student"
            className="pl-9"
            aria-label="Find a student"
          />
        </div>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: report.summary.students },
            { value: 'completed', label: 'Completed', count: report.summary.completed },
            { value: 'progress', label: 'In progress', count: report.summary.inProgress },
            { value: 'notStarted', label: 'Not started', count: report.summary.notStarted },
          ]}
        />
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Student</th>
                <th className="hidden px-3 py-3 font-medium md:table-cell">Activities</th>
                {showGrade && <th className="hidden px-3 py-3 font-medium sm:table-cell">Grade</th>}
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="hidden px-3 py-3 font-medium lg:table-cell">Certificate</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.user.id} className="transition-colors hover:bg-accent/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar user={r.user} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.user.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{r.user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-3 md:table-cell">
                    <div className="flex items-center gap-2">
                      <Progress
                        value={r.activitiesTotal ? (r.activitiesDone / r.activitiesTotal) * 100 : 0}
                        className="w-24"
                        tone={r.activitiesTotal > 0 && r.activitiesDone === r.activitiesTotal ? 'success' : 'primary'}
                      />
                      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {r.activitiesDone}/{r.activitiesTotal}
                      </span>
                    </div>
                  </td>
                  {showGrade && (
                    <td className="hidden px-3 py-3 tabular-nums sm:table-cell">
                      <span className={cn(r.gradeMet ? 'text-success' : r.grade == null ? 'text-muted-foreground' : 'text-foreground')}>
                        {percent(r.grade)}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-3">
                    <StatusBadge row={r} />
                  </td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    {r.certificate ? (
                      <Link
                        to={`/certificates/${r.certificate.id}`}
                        className={cn(
                          'font-mono text-xs hover:text-primary hover:underline',
                          r.certificate.revoked && 'text-muted-foreground line-through',
                        )}
                      >
                        {r.certificate.code}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                    Nobody matches these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        <Link to={`/courses/${slug}/participants`} className="hover:underline">
          Manage participants
        </Link>{' '}
        · Completion is permanent: changing the criteria later never takes it away.
      </p>
    </>
  );
}

function CertificatesTable({ slug, courseId, canManage }: { slug: string; courseId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState<CertificateSummary | null>(null);
  const key = achievementKeys.certificates(slug);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<CertificateSummary[]>(`/courses/${courseId}/certificates`),
  });
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: achievementKeys.report(slug) })]);
  const restore = useMutation({
    mutationFn: (id: string) => api.post<Certificate>(`/certificates/${id}/restore`),
    onSuccess: async () => {
      toast.success('Certificate restored');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) return <Skeleton className="h-64" />;
  if (data.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No certificates yet"
        description="Certificates are issued automatically when students complete the course."
      />
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Recipient</th>
              <th className="px-3 py-3 font-medium">Code</th>
              <th className="hidden px-3 py-3 font-medium sm:table-cell">Completed</th>
              <th className="hidden px-3 py-3 font-medium md:table-cell">Status</th>
              <th className="w-12 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.map((c) => (
              <tr key={c.id} className={cn('transition-colors hover:bg-accent/30', c.revokedAt && 'bg-muted/30')}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar user={c.recipient} size="sm" />
                    <span className="min-w-0 truncate font-medium">{c.recipientName}</span>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Link to={`/certificates/${c.id}`} className="font-mono text-xs whitespace-nowrap hover:text-primary hover:underline">
                    {c.code}
                  </Link>
                </td>
                <td className="hidden px-3 py-3 whitespace-nowrap text-muted-foreground sm:table-cell">
                  {formatDate(c.completedAt, { year: 'numeric' })}
                </td>
                <td className="hidden px-3 py-3 md:table-cell">
                  {c.revokedAt ? (
                    <Badge variant="danger" title={c.revokeReason ?? undefined}>
                      <ShieldX /> Revoked
                    </Badge>
                  ) : (
                    <Badge variant="success">Valid</Badge>
                  )}
                </td>
                <td className="px-3 py-3 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.recipientName}’s certificate`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem asChild>
                        <Link to={`/certificates/${c.id}`}>
                          <ScrollText /> View certificate
                        </Link>
                      </DropdownMenuItem>
                      {canManage &&
                        (c.revokedAt ? (
                          <DropdownMenuItem onSelect={() => restore.mutate(c.id)}>
                            <RotateCcw /> Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem destructive onSelect={() => setRevoking(c)}>
                            <ShieldX /> Revoke…
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {revoking && (
        <RevokeCertificateDialog
          certificate={revoking}
          open={!!revoking}
          onOpenChange={(o) => !o && setRevoking(null)}
          onDone={() => void refresh()}
        />
      )}
    </Card>
  );
}

export default function CompletionPage() {
  const { course, can } = useCourseContext();
  useTitle(`Completion · ${course.title}`);
  const [tab, setTab] = useState<'students' | 'certificates'>('students');
  const canManage = can('completion:manage');
  const {
    data: report,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: achievementKeys.report(course.slug),
    queryFn: () => api.get<CompletionReport>(`/courses/${course.id}/completion/report`),
  });

  if (error) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Page>
    );
  }
  if (isLoading || !report) {
    return (
      <Page>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="mt-6 h-96" />
      </Page>
    );
  }
  if (!report.enabled && report.summary.completed === 0) {
    return (
      <Page>
        <EmptyState
          icon={Flag}
          title="Completion tracking is off"
          description="Choose what completes this course, such as finishing every activity or reaching a minimum grade, and optionally issue certificates."
          action={
            canManage && (
              <Button asChild>
                <Link to={`/courses/${course.slug}/settings#completion`}>
                  <Settings /> Set up completion
                </Link>
              </Button>
            )
          }
        />
      </Page>
    );
  }

  const { summary } = report;
  const share = summary.students ? Math.round((summary.completed / summary.students) * 100) : 0;
  return (
    <Page>
      {!report.enabled && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <Flag className="size-4 text-warning" />
          <span className="flex-1">Completion tracking is off, so no new completions are recorded. Earlier completions are kept.</span>
          {canManage && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/courses/${course.slug}/settings#completion`}>Turn it on</Link>
            </Button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard icon={Users} label="Students" value={summary.students} />
        <StatCard icon={CircleCheck} label="Completed" value={summary.completed} hint={`${share}% of students`} tone="emerald" />
        <StatCard icon={Clock} label="In progress" value={summary.inProgress} tone="sky" />
        <StatCard icon={CircleDashed} label="Not started" value={summary.notStarted} tone="amber" />
      </div>
      <Criteria report={report} slug={course.slug} canManage={canManage} />

      <div className="mt-6 mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'students', label: 'Students' },
            { value: 'certificates', label: 'Certificates' },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Checked whenever students finish activities or get grades, and when this page opens.
        </p>
      </div>
      {tab === 'students' ? (
        <StudentsTable report={report} slug={course.slug} />
      ) : (
        <CertificatesTable slug={course.slug} courseId={course.id} canManage={canManage} />
      )}
    </Page>
  );
}
