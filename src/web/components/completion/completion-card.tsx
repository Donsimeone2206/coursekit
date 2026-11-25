import { useQuery } from '@tanstack/react-query';
import { Award, Circle, CircleCheck, Flag, PartyPopper, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { CompletionCriterion, CourseCompletionStatus } from '@shared/completion';
import type { CourseDetail } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Progress } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { achievementKeys, percent } from '@/lib/achievements';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';

const SHOWN = 5;

function CriterionRow({ criterion, courseSlug }: { criterion: CompletionCriterion; courseSlug: string }) {
  const done = criterion.kind === 'grade' ? criterion.met : criterion.done;
  const Icon = done ? CircleCheck : Circle;
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <Icon className={cn('mt-0.5 size-4 shrink-0', done ? 'text-success' : 'text-muted-foreground/50')} aria-hidden />
      <span className="sr-only">{done ? 'Done:' : 'To do:'}</span>
      {criterion.kind === 'grade' ? (
        <span className="min-w-0 text-sm">
          <span className={cn(done && 'text-muted-foreground')}>Course grade of at least {percent(criterion.minGrade)}</span>
          <span className="block text-xs text-muted-foreground">
            {criterion.current == null ? 'Nothing graded yet' : `Your grade so far: ${percent(criterion.current)}`}
          </span>
        </span>
      ) : (
        <Link
          to={activityPath(courseSlug, criterion.activityId)}
          className={cn(
            'min-w-0 text-sm hover:text-primary hover:underline',
            done && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {criterion.title}
        </Link>
      )}
    </li>
  );
}

function Completed({ status, courseSlug }: { status: CourseCompletionStatus; courseSlug: string }) {
  return (
    <div className="px-5 pb-5">
      <div className="flex items-center gap-3 rounded-xl bg-success/[0.08] p-3.5 ring-1 ring-success/20">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-success/15 text-success">
          <PartyPopper className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">You completed this course</p>
          <p className="text-xs text-muted-foreground">on {formatDate(status.completedAt, { year: 'numeric' })}</p>
        </div>
      </div>
      {status.certificate &&
        (status.certificate.revoked ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Your certificate for this course was revoked. Ask your teacher if you have questions.
          </p>
        ) : (
          <Button asChild variant="outline" className="mt-3 w-full">
            <Link to={`/certificates/${status.certificate.id}`}>
              <ScrollText /> View certificate
            </Link>
          </Button>
        ))}
      <Button asChild variant="ghost" size="sm" className="mt-1 w-full text-muted-foreground">
        <Link to={`/courses/${courseSlug}/badges`}>
          <Award /> Course badges
        </Link>
      </Button>
    </div>
  );
}

/** The student's completion checklist, shown on the course page when completion tracking is on. */
export function CompletionCard({ course }: { course: CourseDetail }) {
  const [showAll, setShowAll] = useState(false);
  const isStudent = course.myRole === 'student';
  const { data } = useQuery({
    queryKey: achievementKeys.status(course.slug),
    queryFn: () => api.get<CourseCompletionStatus>(`/courses/${course.id}/completion`),
    enabled: isStudent,
  });
  if (!isStudent) return null;
  // Most courses don't track completion, so nothing is shown (no placeholder) until the status arrives.
  if (!data || (!data.enabled && !data.completed)) return null;

  const met = data.criteria.filter((c) => (c.kind === 'grade' ? c.met : c.done)).length;
  // Outstanding requirements first, so the next thing to do is always visible.
  const ordered = [...data.criteria].sort(
    (a, b) => Number(a.kind === 'grade' ? a.met : a.done) - Number(b.kind === 'grade' ? b.met : b.done),
  );
  const shown = showAll ? ordered : ordered.slice(0, SHOWN);

  return (
    <Card>
      <CardHeader
        title="Course completion"
        icon={<Flag className="size-4.5" />}
        action={!data.completed && data.criteria.length > 0 && <span className="text-xs font-semibold tabular-nums">{data.progress}%</span>}
      />
      {data.completed ? (
        <Completed status={data} courseSlug={course.slug} />
      ) : (
        <div className="px-5 pb-5">
          {data.criteria.length === 0 ? (
            <p className="text-sm text-muted-foreground">Your teacher is still setting up what completes this course.</p>
          ) : (
            <>
              <Progress value={data.progress} />
              <p className="mt-2 text-xs text-muted-foreground">
                {met} of {data.criteria.length} requirements met
              </p>
              <ul className="mt-2" aria-label="Requirements">
                {shown.map((c) => (
                  <CriterionRow key={c.kind === 'grade' ? 'grade' : c.activityId} criterion={c} courseSlug={course.slug} />
                ))}
              </ul>
              {ordered.length > SHOWN && (
                <button
                  type="button"
                  onClick={() => setShowAll(!showAll)}
                  className="mt-1 text-xs font-medium text-primary hover:underline"
                  aria-expanded={showAll}
                >
                  {showAll ? 'Show fewer' : `Show all ${ordered.length} requirements`}
                </button>
              )}
            </>
          )}
          {data.certificateEnabled && (
            <p className="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
              <ScrollText className="size-3.5 shrink-0" /> You’ll get a certificate when you complete the course.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
