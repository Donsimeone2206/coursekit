import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, ClipboardCheck, Inbox } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { Grade, PublicUser, Submission } from '@shared/types';
import { FileChip } from '@/components/common';
import { Page } from '@/components/layout/shell';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState, Segmented, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { cn, formatDateTime, formatNumber, formatRelative } from '@/lib/utils';
import { useActivity } from './frame';

interface Row {
  user: PublicUser & { email: string };
  submission: Submission | null;
  grade: Grade | null;
  needsGrading: boolean;
}

type Filter = 'all' | 'needs' | 'graded' | 'missing';

function statusOf(row: Row): { label: string; variant: 'warning' | 'success' | 'neutral' } {
  if (row.needsGrading) return { label: 'Needs grading', variant: 'warning' };
  if (row.grade?.score != null)
    return { label: `${formatNumber(row.grade.score)} / ${formatNumber(row.grade.maxGrade)}`, variant: 'success' };
  return { label: 'Not submitted', variant: 'neutral' };
}

export default function SubmissionsPage() {
  const { activityId } = useParams();
  const qc = useQueryClient();
  const { data: activity } = useActivity(activityId);
  useTitle(activity ? `Submissions · ${activity.title}` : 'Submissions');
  const key = ['submissions', activityId];
  const {
    data: rows,
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: key, queryFn: () => api.get<Row[]>(`/activities/${activityId}/submissions`) });
  const [filter, setFilter] = useState<Filter>('needs');
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState('');
  const [feedback, setFeedback] = useState('');

  const filtered = useMemo(
    () =>
      (rows ?? []).filter((r) =>
        filter === 'needs'
          ? r.needsGrading
          : filter === 'graded'
            ? r.grade?.score != null && !r.needsGrading
            : filter === 'missing'
              ? !r.submission
              : true,
      ),
    [rows, filter],
  );

  useEffect(() => {
    if (rows && rows.length && !rows.some((r) => r.needsGrading) && filter === 'needs') setFilter('all');
  }, [rows, filter]);

  useEffect(() => {
    if (!selected && filtered[0]) setSelected(filtered[0].user.id);
  }, [filtered, selected]);

  const current = rows?.find((r) => r.user.id === selected) ?? null;
  useEffect(() => {
    setScore(current?.grade?.score != null ? String(current.grade.score) : '');
    setFeedback(current?.grade?.feedback ?? '');
  }, [current?.user.id, current?.grade?.score, current?.grade?.feedback]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/activities/${activityId}/grades/${current!.user.id}`, {
        score: score === '' ? null : Number(score),
        feedback: feedback.trim() || null,
      }),
    onSuccess: async () => {
      toast.success(`Saved grade for ${current!.user.name}`);
      const remaining = (rows ?? []).filter((r) => r.needsGrading && r.user.id !== current!.user.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ['activity', activityId] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      if (remaining[0]) setSelected(remaining[0].user.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const count = (f: Filter) =>
    (rows ?? []).filter((r) =>
      f === 'needs' ? r.needsGrading : f === 'graded' ? r.grade?.score != null && !r.needsGrading : f === 'missing' ? !r.submission : true,
    ).length;

  return (
    <Page size="wide">
      {activity && (
        <div className="mb-6">
          <Link
            to={activityPath(activity.course.slug, activity.id)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> {activity.title}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Grade submissions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activity.course.title} · out of {formatNumber(activity.maxGrade)} points
          </p>
        </div>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !rows ? (
        <Skeleton className="h-[480px]" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Inbox} title="No students yet" description="Students enrolled in this course will appear here." />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
          <Card className="overflow-hidden lg:sticky lg:top-20">
            <div className="border-b p-3">
              <Segmented
                value={filter}
                onChange={(f) => {
                  setFilter(f);
                  setSelected(null);
                }}
                className="w-full"
                options={[
                  { value: 'needs', label: 'To grade', count: count('needs') },
                  { value: 'graded', label: 'Graded', count: count('graded') },
                  { value: 'missing', label: 'Missing', count: count('missing') },
                  { value: 'all', label: 'All' },
                ]}
              />
            </div>
            <div className="ck-scrollbar max-h-[65vh] divide-y overflow-y-auto">
              {filtered.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Nothing here. 🎉</p>}
              {filtered.map((r) => {
                const s = statusOf(r);
                return (
                  <button
                    key={r.user.id}
                    onClick={() => setSelected(r.user.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50',
                      selected === r.user.id && 'bg-primary/[0.06]',
                    )}
                  >
                    <Avatar user={r.user} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.user.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.submission ? `Submitted ${formatRelative(r.submission.submittedAt)}` : 'No submission'}
                      </span>
                    </span>
                    <Badge variant={s.variant}>{s.label}</Badge>
                    <ChevronRight className="size-4 text-muted-foreground/50" />
                  </button>
                );
              })}
            </div>
          </Card>

          {current ? (
            <div className="space-y-5">
              <Card className="p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <Avatar user={current.user} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{current.user.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{current.user.email}</p>
                  </div>
                  {current.submission && (
                    <div className="shrink-0 text-right text-sm">
                      <p className="text-muted-foreground">Submitted</p>
                      <p className="font-medium">{formatDateTime(current.submission.submittedAt)}</p>
                    </div>
                  )}
                  {current.submission?.late && <Badge variant="warning">Late</Badge>}
                </div>
                <div className="mt-6 space-y-4">
                  {!current.submission && (
                    <p className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground">
                      This student hasn't submitted anything yet. You can still record a grade.
                    </p>
                  )}
                  {current.submission?.text && (
                    <div className="rounded-lg border bg-muted/20 p-5">
                      <Markdown source={current.submission.text} className="prose-sm" />
                    </div>
                  )}
                  {current.submission && current.submission.files.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {current.submission.files.map((f) => (
                        <FileChip key={f.id} file={f} />
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              <Card className="p-6">
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                  }}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <ClipboardCheck className="size-4 text-primary" /> Grade and feedback
                  </div>
                  <Field label={`Score (out of ${formatNumber(activity?.maxGrade ?? 0)})`} className="sm:w-56">
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        step="any"
                        min={0}
                        max={activity?.maxGrade ?? undefined}
                        value={score}
                        onChange={(e) => setScore(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Feedback for the student" optional>
                    {(p) => (
                      <Textarea
                        {...p}
                        rows={5}
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="What went well? What could be better?"
                      />
                    )}
                  </Field>
                  <div className="flex items-center justify-between gap-3">
                    {current.grade?.gradedAt ? (
                      <p className="text-xs text-muted-foreground">
                        Last graded {formatRelative(current.grade.gradedAt)}
                        {current.grade.gradedBy && ` by ${current.grade.gradedBy.name}`}
                      </p>
                    ) : (
                      <span />
                    )}
                    <Button type="submit" loading={save.isPending} disabled={score === ''}>
                      Save grade
                    </Button>
                  </div>
                </form>
              </Card>
            </div>
          ) : (
            <EmptyState icon={ClipboardCheck} title="Select a student" description="Pick someone from the list to review their work." />
          )}
        </div>
      )}
    </Page>
  );
}
