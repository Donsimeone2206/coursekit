import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Download, MessageSquareText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { usesCategories } from '@shared/grades';
import type { Gradebook, GradebookItem, MyGrades } from '@shared/types';
import { ActivityIcon } from '@/components/course';
import { GroupFilter, useGroupFilter, type GroupFilterState } from '@/components/groups';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState, Progress, ProgressRing, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { formatPercent } from '@/lib/grades';
import { useTitle } from '@/lib/hooks';
import { cn, formatDate, formatNumber } from '@/lib/utils';
import { useCourseContext } from './context';
import {
  CategoryAverageCells,
  CategoryGroupRow,
  CategoryTotalCells,
  CategoryTotalHeaders,
  GradebookSetupButton,
} from './GradebookCategories';
import { MyCategoryGrades } from './MyCategoryGrades';

type GradesResponse = { kind: 'gradebook'; gradebook: Gradebook } | { kind: 'mine'; grades: MyGrades };

function tone(pct: number | null) {
  if (pct == null) return 'text-muted-foreground';
  if (pct >= 85) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 60) return 'text-foreground';
  return 'text-red-600 dark:text-red-400';
}

function GradeCell({
  courseId,
  item,
  userId,
  score,
  feedback,
  editable,
  dropped = false,
}: {
  courseId: string;
  item: GradebookItem;
  userId: string;
  score: number | null;
  feedback: string | null;
  editable: boolean;
  dropped?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(score?.toString() ?? '');
  const [note, setNote] = useState(feedback ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.put(`/courses/${courseId}/grades/${item.activityId}/${userId}`, {
        score: value === '' ? null : Number(value),
        feedback: note.trim() || null,
      }),
    onSuccess: async () => {
      setOpen(false);
      toast.success('Grade saved');
      await qc.invalidateQueries({ queryKey: ['grades', courseId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const pct = score != null && item.maxGrade ? (score / item.maxGrade) * 100 : null;
  const content = (
    <span
      className={cn('inline-flex items-center gap-1 tabular-nums', dropped ? 'text-muted-foreground line-through' : tone(pct))}
      title={dropped ? 'Dropped: one of the lowest grades in its category' : undefined}
    >
      {score != null ? formatNumber(score) : <span className="text-muted-foreground/50">–</span>}
      {dropped && <span className="sr-only"> (dropped)</span>}
      {feedback && <MessageSquareText className="size-3 text-muted-foreground" />}
    </span>
  );
  if (!editable) return content;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setValue(score?.toString() ?? '');
          setNote(feedback ?? '');
        }
      }}
    >
      <PopoverTrigger asChild>
        <button className="w-full rounded-md px-2 py-1 text-right transition-colors hover:bg-accent">{content}</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm font-semibold">{item.title}</p>
          <Field label={`Score (out of ${formatNumber(item.maxGrade)})`}>
            {(p) => (
              <Input
                {...p}
                type="number"
                step="any"
                min={0}
                max={item.maxGrade}
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          <Field label="Feedback" optional>
            {(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function GradebookTable({
  book,
  courseId,
  courseSlug,
  editable,
  groupFilter,
}: {
  book: Gradebook;
  courseId: string;
  courseSlug: string;
  editable: boolean;
  groupFilter: GroupFilterState;
}) {
  const groupQuery = groupFilter.groupId ? `?groupId=${encodeURIComponent(groupFilter.groupId)}` : '';
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return book.rows.filter((r) => !term || r.user.name.toLowerCase().includes(term) || r.user.email.toLowerCase().includes(term));
  }, [book.rows, q]);

  if (book.items.length === 0) {
    return (
      <EmptyState
        icon={Award}
        title="No graded activities yet"
        description="Assignments and quizzes appear here as soon as you add them."
        action={<GradebookSetupButton courseSlug={courseSlug} />}
      />
    );
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
        <GroupFilter filter={groupFilter} />
        <div className="flex items-center gap-4 sm:ml-auto">
          <span className="text-sm text-muted-foreground">
            {groupFilter.active ? 'Group average' : 'Class average'}{' '}
            <span className="font-semibold text-foreground">{formatPercent(book.courseAverage)}</span>
          </span>
          <GradebookSetupButton courseSlug={courseSlug} />
          <Button asChild variant="outline" size="sm">
            <a href={`/api/courses/${courseId}/grades/export.csv${groupQuery}`} download>
              <Download /> Export CSV
            </a>
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="ck-scrollbar overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <CategoryGroupRow book={book} />
              <tr className="text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 min-w-56 border-b bg-card px-5 py-3 font-medium">Student</th>
                {book.items.map((item) => (
                  <th key={item.activityId} className="min-w-32 border-b px-3 py-3 text-right align-bottom font-medium">
                    <Link to={activityPath(courseSlug, item.activityId)} className="group inline-flex flex-col items-end gap-1.5">
                      <ActivityIcon type={item.type} size="sm" />
                      <span className="line-clamp-2 max-w-32 text-foreground group-hover:text-primary">{item.title}</span>
                      <span className="font-normal">/ {formatNumber(item.maxGrade)}</span>
                    </Link>
                  </th>
                ))}
                <CategoryTotalHeaders book={book} />
                <th className="min-w-28 border-b bg-muted/40 px-5 py-3 text-right align-bottom font-medium text-foreground">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user.id} className="group">
                  <td className="sticky left-0 z-10 border-b bg-card px-5 py-2.5 group-hover:bg-accent">
                    <div className="flex items-center gap-3">
                      <Avatar user={row.user} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{row.user.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{row.user.email}</p>
                      </div>
                    </div>
                  </td>
                  {book.items.map((item) => (
                    <td key={item.activityId} className="border-b px-1.5 py-2 text-right group-hover:bg-accent/40">
                      <GradeCell
                        courseId={courseId}
                        item={item}
                        userId={row.user.id}
                        score={row.cells[item.activityId]?.score ?? null}
                        feedback={row.cells[item.activityId]?.feedback ?? null}
                        editable={editable}
                        dropped={row.cells[item.activityId]?.dropped}
                      />
                    </td>
                  ))}
                  <CategoryTotalCells book={book} row={row} />
                  <td className="border-b bg-muted/40 px-5 py-2.5 text-right">
                    <span className={cn('font-semibold tabular-nums', tone(row.percentage))}>{formatPercent(row.percentage)}</span>
                    {book.aggregation !== 'weighted' && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatNumber(row.total)} / {formatNumber(row.max)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-xs text-muted-foreground">
                <td className="sticky left-0 z-10 bg-muted/60 px-5 py-3 font-medium text-foreground">Average</td>
                {book.items.map((item) => (
                  <td key={item.activityId} className="bg-muted/60 px-3 py-3 text-right tabular-nums">
                    {formatNumber(book.averages[item.activityId])}
                  </td>
                ))}
                <CategoryAverageCells book={book} />
                <td className="bg-muted/60 px-5 py-3 text-right font-semibold text-foreground tabular-nums">
                  {formatPercent(book.courseAverage)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      {editable && (
        <p className="mt-3 text-xs text-muted-foreground">
          Click any grade to change it or leave feedback. Students are notified when they receive a grade.
        </p>
      )}
    </>
  );
}

function MyGradesView({ grades, courseSlug }: { grades: MyGrades; courseSlug: string }) {
  if (grades.items.length === 0) {
    return <EmptyState icon={Award} title="Nothing graded yet" description="Grades for assignments and quizzes will show up here." />;
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <Card className="divide-y overflow-hidden">
        {grades.items.map((item) => {
          const pct = item.score != null && item.maxGrade ? (item.score / item.maxGrade) * 100 : null;
          return (
            <div key={item.activityId} className="px-5 py-4">
              <div className="flex items-center gap-3">
                <ActivityIcon type={item.type} />
                <div className="min-w-0 flex-1">
                  <Link to={activityPath(courseSlug, item.activityId)} className="truncate text-sm font-medium hover:text-primary">
                    {item.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {item.gradedAt
                      ? `Graded ${formatDate(item.gradedAt)}`
                      : item.dueAt
                        ? `Due ${formatDate(item.dueAt)}`
                        : 'Not graded yet'}
                  </p>
                </div>
                <div className="text-right">
                  <p className={cn('text-sm font-semibold tabular-nums', tone(pct))}>
                    {item.score != null ? formatNumber(item.score) : '–'}{' '}
                    <span className="font-normal text-muted-foreground">/ {formatNumber(item.maxGrade)}</span>
                  </p>
                  {pct != null && <p className="text-xs text-muted-foreground tabular-nums">{formatNumber(pct)}%</p>}
                </div>
              </div>
              {pct != null && <Progress value={pct} className="mt-3" tone={pct >= 85 ? 'success' : 'primary'} />}
              {item.feedback && (
                <div className="mt-3 rounded-lg bg-muted/60 px-3.5 py-2.5 text-sm">
                  <p className="mb-0.5 text-xs font-medium text-muted-foreground">Feedback</p>
                  {item.feedback}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      <Card className="p-5 text-center lg:sticky lg:top-32">
        <p className="text-sm font-medium text-muted-foreground">Course total</p>
        <ProgressRing
          value={grades.percentage ?? 0}
          size={120}
          stroke={9}
          className="mx-auto mt-4 text-primary"
          label={<span className="text-2xl font-semibold">{formatPercent(grades.percentage)}</span>}
        />
        <p className="mt-4 text-sm tabular-nums">
          {formatNumber(grades.total)} of {formatNumber(grades.max)} points
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Based on graded work so far.</p>
        {grades.percentage != null && (
          <Badge variant={grades.percentage >= 85 ? 'success' : grades.percentage >= 60 ? 'info' : 'warning'} className="mt-3">
            {grades.percentage >= 85 ? 'Excellent work' : grades.percentage >= 60 ? 'On track' : 'Needs attention'}
          </Badge>
        )}
      </Card>
    </div>
  );
}

export default function GradesPage() {
  const { course, can } = useCourseContext();
  useTitle(`Grades · ${course.title}`);
  const groupFilter = useGroupFilter(can('grades:viewAll') ? course.id : undefined);
  const groupId = groupFilter.groupId;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['grades', course.id, groupId],
    queryFn: () => api.get<GradesResponse>(`/courses/${course.id}/grades${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`),
    placeholderData: (previous) => previous, // keep the table while another group loads
  });

  return (
    <Page size="wide">
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : data.kind === 'gradebook' ? (
        <GradebookTable
          book={data.gradebook}
          courseId={course.id}
          courseSlug={course.slug}
          editable={can('grades:edit')}
          groupFilter={groupFilter}
        />
      ) : (
        <div className="mx-auto max-w-5xl">
          {usesCategories(data.grades) ? (
            <MyCategoryGrades grades={data.grades} courseSlug={course.slug} />
          ) : (
            <MyGradesView grades={data.grades} courseSlug={course.slug} />
          )}
        </div>
      )}
    </Page>
  );
}
