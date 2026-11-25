import { useMutation, useQuery } from '@tanstack/react-query';
import { Award, CircleHelp, Clock, Hourglass, ListOrdered, Play, RotateCcw, Target, Trophy, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { ActivityDetail, QuizAttemptSummary, QuizSettings } from '@shared/types';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative, isPast } from '@/lib/utils';
import { ActivityFrame } from './frame';
import { NeedsGradingCard } from './QuizGrading';

function Tile({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <Icon className="size-4 text-muted-foreground" />
      <p className="mt-2 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

const GRADING: Record<QuizSettings['gradingMethod'], string> = {
  highest: 'Highest attempt counts',
  last: 'Last attempt counts',
  average: 'Average of attempts',
};

export function QuizView({ activity }: { activity: ActivityDetail<'quiz'> }) {
  const navigate = useNavigate();
  const quiz = activity.quiz!;
  const settings = activity.settings as QuizSettings;
  const isManager = activity.capabilities.includes('course:manageContent');
  const isStaff = activity.capabilities.includes('quiz:viewAllAttempts');
  const finished = quiz.attempts.filter((a) => a.status !== 'in_progress');
  const remaining = settings.attemptsAllowed ? Math.max(0, settings.attemptsAllowed - finished.length) : null;
  const closed = !!activity.dueAt && isPast(activity.dueAt);

  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/activities/${activity.id}/attempts`),
    onSuccess: (a) => navigate(`/courses/${activity.course.slug}/attempts/${a.id}`),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const { data: allAttempts } = useQuery({
    queryKey: ['attempts', activity.id, 'all'],
    queryFn: () => api.get<QuizAttemptSummary[]>(`/activities/${activity.id}/attempts?all=1`),
    enabled: isStaff,
  });

  const reason =
    quiz.questionCount === 0
      ? 'This quiz has no questions yet.'
      : closed
        ? 'This quiz has closed.'
        : remaining === 0
          ? "You've used all of your attempts."
          : null;

  return (
    <ActivityFrame
      activity={activity}
      actions={
        isManager && (
          <Button asChild variant="outline">
            <Link to={`${activityPath(activity.course.slug, activity.id)}/questions`}>
              <ListOrdered /> Questions
            </Link>
          </Button>
        )
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile icon={CircleHelp} label="Questions" value={String(quiz.questionCount)} />
          <Tile icon={Target} label="Points" value={formatNumber(quiz.totalPoints)} />
          <Tile icon={Clock} label="Time limit" value={settings.timeLimitMinutes ? `${settings.timeLimitMinutes} min` : 'None'} />
          <Tile
            icon={RotateCcw}
            label="Attempts"
            value={settings.attemptsAllowed ? `${finished.length} / ${settings.attemptsAllowed}` : `${finished.length} / ∞`}
          />
        </div>

        <Card className="overflow-hidden">
          {activity.description && (
            <div className="border-b p-6">
              <Markdown source={activity.description} />
            </div>
          )}
          <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
            <div className="flex-1 space-y-1 text-sm text-muted-foreground">
              <p>{GRADING[settings.gradingMethod]}.</p>
              {activity.dueAt && (
                <p>
                  {closed ? 'Closed' : 'Closes'} {formatDateTime(activity.dueAt)}.
                </p>
              )}
              {settings.passingPercent != null && <p>You need {settings.passingPercent}% to pass.</p>}
              {settings.reviewMode !== 'immediate' && (
                <p>
                  {settings.reviewMode === 'after_due'
                    ? 'Correct answers are shown after the quiz closes.'
                    : 'Only your score is shown after each attempt.'}
                </p>
              )}
            </div>
            {quiz.inProgressAttemptId ? (
              <Button size="lg" onClick={() => navigate(`/courses/${activity.course.slug}/attempts/${quiz.inProgressAttemptId}`)}>
                <Play /> Continue attempt
              </Button>
            ) : quiz.canAttempt ? (
              <Button size="lg" onClick={() => start.mutate()} loading={start.isPending}>
                <Play /> {isManager ? 'Preview quiz' : finished.length ? 'Try again' : 'Start quiz'}
              </Button>
            ) : (
              <p className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">{reason ?? 'You cannot attempt this quiz.'}</p>
            )}
          </div>
        </Card>

        {activity.grade?.score != null && activity.myRole === 'student' && (
          <Card className="flex items-center gap-4 p-5">
            <span className="grid size-11 place-items-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Trophy className="size-5" />
            </span>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">Your grade for this quiz</p>
              <p className="text-xl font-semibold tabular-nums">
                {formatNumber(activity.grade.score)}{' '}
                <span className="text-sm font-normal text-muted-foreground">/ {formatNumber(activity.grade.maxGrade)}</span>
              </p>
            </div>
            <Badge variant="success">{Math.round((activity.grade.score / (activity.grade.maxGrade || 1)) * 100)}%</Badge>
          </Card>
        )}

        {quiz.attempts.length > 0 && (
          <Card>
            <CardHeader title={isManager ? 'Your previews' : 'Your attempts'} icon={<Award className="size-4.5" />} />
            <div className="divide-y border-t">
              {quiz.attempts.map((a) => (
                <Link
                  key={a.id}
                  to={`/courses/${activity.course.slug}/attempts/${a.id}`}
                  className="flex items-center gap-4 px-5 py-3 text-sm transition-colors hover:bg-accent/40"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-muted text-xs font-semibold">{a.attemptNumber}</span>
                  <span className="flex-1">
                    <span className="block font-medium">Attempt {a.attemptNumber}</span>
                    <span className="block text-xs text-muted-foreground">
                      {a.status !== 'in_progress' ? `Finished ${formatRelative(a.finishedAt)}` : `Started ${formatRelative(a.startedAt)}`}
                    </span>
                  </span>
                  {a.status === 'needs_grading' ? (
                    <Badge variant="warning">
                      <Hourglass /> Waiting for grading
                    </Badge>
                  ) : a.status === 'finished' ? (
                    <span className="text-right">
                      <span className="block font-semibold tabular-nums">
                        {formatNumber(a.score)} / {formatNumber(a.maxScore)}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {a.maxScore ? Math.round(((a.score ?? 0) / a.maxScore) * 100) : 0}%
                      </span>
                    </span>
                  ) : (
                    <Badge variant="info">In progress</Badge>
                  )}
                </Link>
              ))}
            </div>
          </Card>
        )}

        {isStaff && !!quiz.needsGrading && <NeedsGradingCard activity={activity} />}

        {isStaff && (
          <Card>
            <CardHeader title="Student attempts" description="Every attempt, newest first." icon={<Users className="size-4.5" />} />
            {allAttempts && allAttempts.filter((a) => a.status !== 'in_progress').length > 0 ? (
              <div className="divide-y border-t">
                {allAttempts
                  .filter((a) => a.status !== 'in_progress')
                  .slice(0, 50)
                  .map((a) => (
                    <Link
                      key={a.id}
                      to={`/courses/${activity.course.slug}/attempts/${a.id}`}
                      className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-accent/40"
                    >
                      {a.user && <Avatar user={a.user} size="sm" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{a.user?.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          Attempt {a.attemptNumber} · {formatRelative(a.finishedAt)}
                        </span>
                      </span>
                      {a.status === 'needs_grading' ? (
                        <Badge variant="warning">
                          <Hourglass /> Needs grading
                        </Badge>
                      ) : (
                        <span className="font-semibold tabular-nums">
                          {formatNumber(a.score)} / {formatNumber(a.maxScore)}
                        </span>
                      )}
                    </Link>
                  ))}
              </div>
            ) : (
              <div className="px-5 pb-5">
                <EmptyState icon={Users} title="No attempts yet" className="py-8" />
              </div>
            )}
          </Card>
        )}
      </div>
    </ActivityFrame>
  );
}
