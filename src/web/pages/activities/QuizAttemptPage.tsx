import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleCheck, CircleX, Clock, Cloud, CloudOff, Lightbulb, LoaderCircle, Send, Trophy, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { AttemptAnswer, Question, QuizAttempt } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { InlineMarkdown, Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/form';
import { ErrorState, ProgressRing, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useNow, useTitle } from '@/lib/hooks';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';
import { useInvalidateCourse } from '../course/context';

const TYPE_HINT: Record<Question['type'], string> = {
  single: 'Choose one answer',
  multiple: 'Select all that apply',
  truefalse: 'True or false',
  short: 'Type your answer',
  numeric: 'Enter a number',
};

function isAnswered(q: Question, a: AttemptAnswer | undefined) {
  if (!a) return false;
  return q.type === 'short' || q.type === 'numeric' ? !!a.text?.trim() : !!a.optionIds?.length;
}

function QuestionInput({
  question,
  answer,
  onChange,
  review,
  disabled,
}: {
  question: Question;
  answer: AttemptAnswer | undefined;
  onChange: (a: AttemptAnswer) => void;
  review: boolean;
  disabled: boolean;
}) {
  if (question.type === 'short' || question.type === 'numeric') {
    return (
      <div className="space-y-2">
        <Input
          value={answer?.text ?? ''}
          disabled={disabled}
          inputMode={question.type === 'numeric' ? 'decimal' : 'text'}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder={question.type === 'numeric' ? 'e.g. 42' : 'Your answer'}
          className="h-11 max-w-md text-[15px]"
          aria-label="Your answer"
        />
        {review && question.acceptedAnswers && (
          <p className="text-sm text-muted-foreground">
            Accepted answer{question.acceptedAnswers.length > 1 ? 's' : ''}:{' '}
            <span className="font-medium text-foreground">
              {question.acceptedAnswers.join(', ')}
              {question.type === 'numeric' && question.tolerance ? ` (± ${question.tolerance})` : ''}
            </span>
          </p>
        )}
      </div>
    );
  }

  const multiple = question.type === 'multiple';
  const chosen = new Set(answer?.optionIds ?? []);
  return (
    <div className="grid gap-2" role={multiple ? 'group' : 'radiogroup'}>
      {question.options.map((o, i) => {
        const selected = chosen.has(o.id);
        const correct = review ? o.correct : undefined;
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={selected}
            onClick={() => {
              if (multiple) {
                const next = new Set(chosen);
                if (selected) next.delete(o.id);
                else next.add(o.id);
                onChange({ optionIds: [...next] });
              } else onChange({ optionIds: [o.id] });
            }}
            className={cn(
              'flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left text-[15px] transition-all',
              !disabled && 'hover:border-primary/50 hover:bg-primary/[0.02]',
              selected && !review && 'border-primary bg-primary/[0.05] ring-3 ring-primary/10',
              review && correct && 'border-emerald-500/50 bg-emerald-500/[0.07]',
              review && selected && !correct && 'border-red-500/50 bg-red-500/[0.06]',
              disabled && 'cursor-default',
            )}
          >
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center border text-xs font-semibold text-muted-foreground',
                multiple ? 'rounded-md' : 'rounded-full',
                selected && 'border-primary bg-primary text-primary-foreground',
                review && correct && 'border-emerald-600 bg-emerald-600 text-white',
                review && selected && !correct && 'border-red-500 bg-red-500 text-white',
              )}
            >
              {review && correct ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : review && selected ? (
                <X className="size-3.5" strokeWidth={3} />
              ) : selected && multiple ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : (
                String.fromCharCode(65 + i)
              )}
            </span>
            <InlineMarkdown source={o.text} className="flex-1" />
            {review && selected && <span className="text-xs font-medium text-muted-foreground">Your answer</span>}
          </button>
        );
      })}
    </div>
  );
}

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
    >
      <Clock className="size-4" />
      {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

function ReviewSummary({ attempt }: { attempt: QuizAttempt }) {
  const pct = attempt.maxScore ? ((attempt.score ?? 0) / attempt.maxScore) * 100 : 0;
  const passed = attempt.passingPercent == null ? null : pct >= attempt.passingPercent;
  const correct = attempt.results ? Object.values(attempt.results).filter((r) => r.correct).length : null;
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-col items-center gap-6 p-6 sm:flex-row">
        <ProgressRing
          value={pct}
          size={112}
          stroke={9}
          className={cn(passed === false ? 'text-red-500' : 'text-primary')}
          label={<span className="text-2xl font-semibold">{Math.round(pct)}%</span>}
        />
        <div className="flex-1 text-center sm:text-left">
          <p className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground sm:justify-start">
            <Trophy className="size-4" /> Attempt {attempt.attemptNumber} · finished {formatDateTime(attempt.finishedAt)}
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatNumber(attempt.score)}{' '}
            <span className="text-lg font-normal text-muted-foreground">/ {formatNumber(attempt.maxScore)} points</span>
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
            {correct != null && (
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
        <Button asChild variant="outline">
          <Link to={activityPath(attempt.course.slug, attempt.activityId)}>
            <ArrowLeft /> Back to quiz
          </Link>
        </Button>
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
      toast.success('Quiz submitted!');
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
    const ok = await confirm({
      title: 'Submit your answers?',
      description: missing
        ? `You haven't answered ${missing} question${missing === 1 ? '' : 's'}. You can't change your answers after submitting.`
        : "You can't change your answers after submitting.",
      confirmLabel: 'Submit quiz',
    });
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
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
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
        {!inProgress && <ReviewSummary attempt={attempt} />}
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
              return (
                <Card
                  key={q.id}
                  id={`q-${q.id}`}
                  className={cn(
                    'scroll-mt-32 p-5 sm:p-6',
                    result && (result.correct ? 'border-emerald-500/40' : result.partial ? 'border-amber-500/40' : 'border-red-500/30'),
                  )}
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Question {i + 1} · {TYPE_HINT[q.type]}
                    </p>
                    {result ? (
                      <Badge variant={result.correct ? 'success' : result.partial ? 'warning' : 'danger'}>
                        {result.correct ? <CircleCheck /> : <CircleX />}
                        {formatNumber(result.points)} / {formatNumber(result.maxPoints)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {formatNumber(q.points)} point{q.points === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <Markdown source={q.prompt} className="mb-4 text-[15px] font-medium [&_p]:my-0" />
                  <QuestionInput
                    question={q}
                    answer={answers[q.id]}
                    onChange={(a) => update(q.id, a)}
                    review={!!attempt.review}
                    disabled={!inProgress}
                  />
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
                    className={cn(
                      'grid aspect-square place-items-center rounded-md border text-xs font-semibold transition-colors hover:border-primary',
                      answered && !result && 'border-primary bg-primary text-primary-foreground',
                      result?.correct && 'border-emerald-600 bg-emerald-600 text-white',
                      result && !result.correct && result.partial && 'border-amber-500 bg-amber-500 text-white',
                      result && !result.correct && !result.partial && 'border-red-500 bg-red-500 text-white',
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
