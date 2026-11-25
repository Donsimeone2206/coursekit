import { useMutation } from '@tanstack/react-query';
import { ClipboardCheck, Hourglass, MessageSquareText, NotebookPen } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import type { Question, QuestionResult, QuizAttempt } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { formatMark } from './meta';

/** Mark and comment for one essay answer (staff). */
export function EssayMarkForm({
  attempt,
  question,
  onSaved,
}: {
  attempt: QuizAttempt;
  question: Question;
  onSaved: (next: QuizAttempt) => void;
}) {
  const id = useId();
  const result = attempt.results?.[question.id];
  const graded = !!result && !result.pending && !!result.gradedAt;
  const savedPoints = graded ? String(result!.points) : '';
  const savedComment = result?.comment ?? '';
  const [points, setPoints] = useState(savedPoints);
  const [comment, setComment] = useState(savedComment);
  useEffect(() => {
    setPoints(savedPoints);
    setComment(savedComment);
  }, [savedPoints, savedComment]);

  const value = Number(points);
  const invalid = points === '' || !Number.isFinite(value) || value < 0 || value > question.points;
  const save = useMutation({
    mutationFn: () =>
      api.put<QuizAttempt>(`/attempts/${attempt.id}/questions/${question.id}/grade`, { points: value, comment: comment.trim() || null }),
    onSuccess: (next) => {
      onSaved(next);
      toast.success(
        attempt.status === 'needs_grading' && next.status === 'finished'
          ? 'All answers are marked. The grade is recorded and the student has been told.'
          : 'Mark saved',
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <form
      className="mt-4 space-y-3 rounded-xl border bg-muted/25 p-4"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) save.mutate();
      }}
    >
      <p id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
        <ClipboardCheck className="size-4 text-primary" />{' '}
        {graded ? 'Marked' : result?.pending ? 'Mark this answer' : 'No answer given: scored 0. You can still give a mark.'}
      </p>
      {question.graderNotes && (
        <div className="rounded-lg bg-amber-500/10 px-3.5 py-2.5 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <NotebookPen className="size-3.5" /> Notes for graders
          </p>
          <p className="mt-1 whitespace-pre-wrap">{question.graderNotes}</p>
        </div>
      )}
      <Field
        label={`Mark (out of ${formatMark(question.points)})`}
        className="w-44"
        error={points !== '' && invalid ? `Enter 0 to ${formatMark(question.points)}` : null}
      >
        {(p) => (
          <Input
            {...p}
            type="number"
            min={0}
            max={question.points}
            step="any"
            inputMode="decimal"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        )}
      </Field>
      <Field label="Comment for the student" optional>
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What was good, what was missing?"
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {graded ? (
          <p className="text-xs text-muted-foreground">
            Marked {formatRelative(result!.gradedAt)}
            {result!.gradedBy && ` by ${result!.gradedBy.name}`}
          </p>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" loading={save.isPending} disabled={invalid}>
          {graded ? 'Update mark' : 'Save mark'}
        </Button>
      </div>
    </form>
  );
}

/** What the student sees for a hand-marked answer: waiting, or the mark and comment. */
export function EssayFeedback({ result }: { result: QuestionResult | undefined }) {
  if (!result) return null;
  if (result.pending) {
    return (
      <p className="mt-4 flex items-center gap-2 rounded-lg bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        <Hourglass className="size-4 shrink-0" /> Waiting for your teacher to mark this answer.
      </p>
    );
  }
  if (!result.comment) return null;
  return (
    <div className="mt-4 rounded-lg bg-sky-500/[0.07] px-4 py-3 text-sm">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-800 dark:text-sky-300">
        <MessageSquareText className="size-3.5" /> {result.gradedBy ? `${result.gradedBy.name}'s comment` : "Your teacher's comment"}
      </p>
      <p className="mt-1 whitespace-pre-wrap">{result.comment}</p>
    </div>
  );
}
