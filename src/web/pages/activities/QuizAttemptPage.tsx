import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  CloudOff,
  Hourglass,
  Lightbulb,
  LoaderCircle,
  Send,
  Trophy,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { AttemptAnswer, QuizAttempt, QuizGradingItem } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { InlineMarkdown, Markdown } from '@/components/markdown';
import { EssayFeedback, EssayMarkForm } from '@/components/questions/EssayGrading';
import { formatMark, isAnswered, TYPE_META, wordLimitIssue } from '@/components/questions/meta';
import { QuestionAnswer } from '@/components/questions/QuestionAnswer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { ErrorState, ProgressRing, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useNow, useTitle } from '@/lib/hooks';
import { cn, formatDateTime, plural } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';
import { useInvalidateCourse } from '../course/context';

function Countdown({ deadline, onExpire }: { deadline: string; onExpire: () => void }) {
  const now = useNow(1000);
  const left = Math.max(0, new Date(deadline).getTime() - now);
  const fired = useRef(false);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpire();
    }
  }, [left, onExpire]);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-sm font-semibold tabular-nums',
        left < 60_000 ? 'bg-red-500/10 text-red-600' : left < 300_000 ? 'bg-amber-500/12 text-amber-600' : 'bg-muted',
      )}
      role="timer"
      aria-label={`${m} minutes ${s} seconds left`}
    >
      <Clock className="size-4" />
      {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

function ReviewSummary({ attempt, next }: { attempt: QuizAttempt; next: QuizGradingItem | null }) {
  const pending = attempt.status === 'needs_grading';
  const pct = attempt.maxScore ? ((attempt.score ?? 0) / attempt.maxScore) * 100 : 0;
  const passed = pending || attempt.passingPercent == null ? null : pct >= attempt.passingPercent;
  const correct = attempt.results && attempt.review ? Object.values(attempt.results).filter((r) => r.correct).length : null;
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-col items-center gap-6 p-6 sm:flex-row">
        {pending ? (
          <span className="grid size-28 shrink-0 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Hourglass className="size-10" aria-hidden />
          </span>
        ) : (
          <ProgressRing
            value={pct}
            size={112}
            stroke={9}
            className={cn(passed === false ? 'text-red-500' : 'text-primary')}
            label={<span className="text-2xl font-semibold">{Math.round(pct)}%</span>}
          />
        )}
        <div className="flex-1 text-center sm:text-left">
          <p className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground sm:justify-start">
            <Trophy className="size-4" />
            {attempt.user && attempt.canGrade ? `${attempt.user.name} · ` : ''}Attempt {attempt.attemptNumber} · handed in{' '}
            {formatDateTime(attempt.finishedAt)}
          </p>
          {pending ? (
            <>
              <p className="mt-1 text-2xl font-semibold tracking-tight">Score pending</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {attempt.canGrade
                  ? `${plural(attempt.pendingCount, 'written answer')} to mark below. The grade is recorded when every answer has a mark.`
                  : 'Your written answers are waiting to be marked. Your score appears once your teacher has graded them.'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
              {formatMark(attempt.score)}{' '}
              <span className="text-lg font-normal text-muted-foreground">/ {formatMark(attempt.maxScore)} points</span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
            {pending && (
              <Badge variant="warning">
                <Hourglass /> Waiting for grading
              </Badge>
            )}
            {correct != null && !pending && (
              <Badge variant="neutral">
                {correct} of {attempt.questions.length} correct
              </Badge>
            )}
            {passed != null && (
              <Badge variant={passed ? 'success' : 'danger'}>{passed ? 'Passed' : `Below the ${attempt.passingPercent}% pass mark`}</Badge>
            )}
            {!attempt.review && <Badge variant="outline">Correct answers are hidden for now</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {next && (
            <Button asChild>
              <Link to={`/courses/${attempt.course.slug}/attempts/${next.attemptId}`}>
                Next to mark: {next.user.name.split(' ')[0]} <ArrowRight />
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to={activityPath(attempt.course.slug, attempt.activityId)}>
              <ArrowLeft /> Back to quiz
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function QuizAttemptPage() {
  const { attemptId } = useParams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidate = useInvalidateCourse();
  const key = ['attempt', attemptId];
  const {
    data: attempt,
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: key, queryFn: () => api.get<QuizAttempt>(`/attempts/${attemptId}`) });
  useTitle(attempt?.quizTitle);

  const grading = useQuery({
    queryKey: ['grading', attempt?.activityId],
    queryFn: () => api.get<QuizGradingItem[]>(`/activities/${attempt!.activityId}/grading`),
    enabled: !!attempt?.canGrade,
  });
  const next = attempt?.canGrade ? (grading.data?.find((g) => g.attemptId !== attempt.id) ?? null) : null;

  const [answers, setAnswers] = useState<Record<string, AttemptAnswer>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(answers);
  latest.current = answers;

  useEffect(() => {
    if (attempt && loadedFor !== attempt.id) {
      setAnswers(attempt.answers);
      setLoadedFor(attempt.id);
    }
  }, [attempt, loadedFor]);

  const inProgress = attempt?.status === 'in_progress';

  const saveNow = useCallback(async () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    setSaveState('saving');
    try {
      await api.put(`/attempts/${attemptId}`, { answers: latest.current });
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [attemptId]);

  const update = (questionId: string, a: AttemptAnswer) => {
    setAnswers((prev) => ({ ...prev, [questionId]: a }));
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void saveNow(), 700);
  };

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  const submit = useMutation({
    mutationFn: () => api.post<QuizAttempt>(`/attempts/${attemptId}/submit`, { answers: latest.current }),
    onSuccess: async (result) => {
      if (pending.current) clearTimeout(pending.current);
      qc.setQueryData(key, result);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast.success(result.status === 'needs_grading' ? 'Quiz handed in. Your written answers will be marked soon.' : 'Quiz submitted!');
      await invalidate(result.course.slug);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const expire = useCallback(() => {
    if (!submit.isPending) {
      toast.info("Time's up! Submitting your answers.");
      submit.mutate();
    }
  }, [submit]);

  const graded = async (next: QuizAttempt) => {
    qc.setQueryData(key, next);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['grading', next.activityId] }),
      qc.invalidateQueries({ queryKey: ['attempts', next.activityId] }),
      qc.invalidateQueries({ queryKey: ['activity', next.activityId] }),
    ]);
  };

  if (isLoading) {
    return (
      <Page size="narrow">
        <Skeleton className="mb-4 h-24" />
        <Skeleton className="h-64" />
      </Page>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !attempt) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Page>
    );
  }

  const answeredCount = attempt.questions.filter((q) => isAnswered(q, answers[q.id])).length;

  const finish = async () => {
    const missing = attempt.questions.length - answeredCount;
    const lengths = attempt.questions
      .map((q, i) => ({ i, issue: q.type === 'essay' ? wordLimitIssue(q, answers[q.id]?.text) : null }))
      .filter((x) => x.issue);
    const notes = [
      missing ? `You haven't answered ${plural(missing, 'question')}.` : '',
      ...lengths.map(
        (x) => `Your answer to question ${x.i + 1} is ${x.issue === 'long' ? 'over the word limit' : 'shorter than suggested'}.`,
      ),
      "You can't change your answers after submitting.",
    ].filter(Boolean);
    const ok = await confirm({ title: 'Submit your answers?', description: notes.join(' '), confirmLabel: 'Submit quiz' });
    if (ok) submit.mutate();
  };

  return (
    <div>
      {inProgress && (
        <div className="sticky top-14 z-20 border-b bg-background/90 backdrop-blur-lg">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:px-6">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{attempt.quizTitle}</p>
              <p className="text-xs text-muted-foreground">
                {answeredCount} of {attempt.questions.length} answered
              </p>
            </div>
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" aria-live="polite">
              {saveState === 'saving' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : saveState === 'error' ? (
                <CloudOff className="size-3.5 text-destructive" />
              ) : (
                <Cloud className="size-3.5" />
              )}
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'error'
                  ? 'Not saved'
                  : saveState === 'saved'
                    ? 'All changes saved'
                    : 'Autosave on'}
            </span>
            {attempt.deadlineAt && <Countdown deadline={attempt.deadlineAt} onExpire={expire} />}
            <Button onClick={finish} loading={submit.isPending}>
              <Send /> Submit
            </Button>
          </div>
        </div>
      )}
      <Page className="max-w-5xl">
        {!inProgress && <ReviewSummary attempt={attempt} next={next} />}
        {inProgress && (
          <div className="mb-6">
            <Link
              to={activityPath(attempt.course.slug, attempt.activityId)}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" /> {attempt.course.title}
            </Link>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{attempt.quizTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Attempt {attempt.attemptNumber}. Your answers save automatically as you go.
            </p>
          </div>
        )}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_200px]">
          <div className="space-y-4">
            {attempt.questions.map((q, i) => {
              const result = attempt.results?.[q.id];
              const waiting = !!result?.pending;
              return (
                <Card
                  key={q.id}
                  id={`q-${q.id}`}
                  className={cn(
                    'scroll-mt-32 p-5 sm:p-6',
                    result &&
                      !waiting &&
                      (result.correct ? 'border-emerald-500/40' : result.partial ? 'border-amber-500/40' : 'border-red-500/30'),
                    waiting && 'border-amber-500/40 border-dashed',
                  )}
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Question {i + 1} · {TYPE_META[q.type].hint}
                    </p>
                    {waiting ? (
                      <Badge variant="warning">
                        <Hourglass /> {attempt.canGrade ? 'Needs marking' : 'Being marked'} · {formatMark(q.points)} pt
                        {q.points === 1 ? '' : 's'}
                      </Badge>
                    ) : result ? (
                      <Badge variant={result.correct ? 'success' : result.partial ? 'warning' : 'danger'}>
                        {result.correct ? <CircleCheck /> : <CircleX />}
                        {formatMark(result.points)} / {formatMark(result.maxPoints)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {formatMark(q.points)} point{q.points === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <Markdown source={q.prompt} className="mb-4 text-[15px] font-medium [&_p]:my-0" />
                  <QuestionAnswer
                    question={q}
                    answer={answers[q.id]}
                    onChange={(a) => update(q.id, a)}
                    review={!!attempt.review}
                    disabled={!inProgress}
                  />
                  {q.type === 'essay' &&
                    !inProgress &&
                    (attempt.canGrade ? (
                      <EssayMarkForm attempt={attempt} question={q} onSaved={graded} />
                    ) : (
                      <EssayFeedback result={result} />
                    ))}
                  {attempt.review && q.explanation && (
                    <div className="mt-4 flex gap-3 rounded-lg bg-sky-500/[0.07] px-4 py-3 text-sm">
                      <Lightbulb className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                      <InlineMarkdown source={q.explanation} />
                    </div>
                  )}
                </Card>
              );
            })}
            {inProgress && (
              <div className="flex justify-end pt-2">
                <Button size="lg" onClick={finish} loading={submit.isPending}>
                  <Send /> Submit answers
                </Button>
              </div>
            )}
          </div>
          <Card className="hidden p-4 lg:sticky lg:top-36 lg:block">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">Questions</p>
            <div className="grid grid-cols-5 gap-1.5">
              {attempt.questions.map((q, i) => {
                const result = attempt.results?.[q.id];
                const answered = isAnswered(q, answers[q.id]);
                return (
                  <a
                    key={q.id}
                    href={`#q-${q.id}`}
                    aria-label={`Question ${i + 1}`}
                    className={cn(
                      'grid aspect-square place-items-center rounded-md border text-xs font-semibold transition-colors hover:border-primary',
                      answered && !result && 'border-primary bg-primary text-primary-foreground',
                      result?.pending && 'border-dashed border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300',
                      result && !result.pending && result.correct && 'border-emerald-600 bg-emerald-600 text-white',
                      result && !result.pending && !result.correct && result.partial && 'border-amber-500 bg-amber-500 text-white',
                      result && !result.pending && !result.correct && !result.partial && 'border-red-500 bg-red-500 text-white',
                    )}
                  >
                    {i + 1}
                  </a>
                );
              })}
            </div>
          </Card>
        </div>
      </Page>
    </div>
  );
}
