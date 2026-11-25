import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Eye, Hourglass, Lightbulb, Library, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import type { AttemptAnswer, BankQuestion, BankQuestionSummary, Question, QuestionCategory, QuestionResult } from '@shared/types';
import { InlineMarkdown, Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { excerptOf } from '@/lib/utils';
import { formatMark, indentLabel, TYPE_META, withDepth } from './meta';
import { QuestionAnswer } from './QuestionAnswer';
import { blankDraft, draftFrom, draftInput, QuestionForm, type QuestionDraft } from './QuestionForm';

export function useCategories(courseId: string, enabled = true) {
  return useQuery({
    queryKey: ['question-categories', courseId],
    queryFn: () => api.get<QuestionCategory[]>(`/courses/${courseId}/question-categories`),
    enabled,
  });
}

/** Refresh the bank's lists after a change. */
export function useInvalidateBank() {
  const qc = useQueryClient();
  return (courseId: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['question-categories', courseId] }),
      qc.invalidateQueries({ queryKey: ['bank-questions', courseId] }),
      qc.invalidateQueries({ queryKey: ['bank-question'] }),
      qc.invalidateQueries({ queryKey: ['slots'] }),
    ]);
}

export function toSummary(q: BankQuestion, categories: QuestionCategory[] = []): BankQuestionSummary {
  return {
    id: q.id,
    type: q.type,
    name: q.name,
    excerpt: excerptOf(q.prompt, 160),
    points: q.points,
    categoryId: q.categoryId,
    categoryName: categories.find((c) => c.id === q.categoryId)?.name ?? '',
    quizCount: new Set(q.usage.filter((u) => u.kind === 'question').map((u) => u.activityId)).size,
    updatedAt: q.updatedAt,
  };
}

/** Select of categories, indented to show nesting. */
export function CategorySelect({
  categories,
  allLabel,
  exclude,
  ...props
}: ComponentProps<typeof Select> & { categories: QuestionCategory[]; allLabel?: string; exclude?: string[] }) {
  const options = useMemo(() => withDepth(categories).filter((c) => !exclude?.includes(c.id)), [categories, exclude]);
  return (
    <Select {...props}>
      {allLabel && <option value="">{allLabel}</option>}
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {indentLabel(c)}
        </option>
      ))}
    </Select>
  );
}

export function TypeIcon({ type, className }: { type: Question['type']; className?: string }) {
  const meta = TYPE_META[type];
  return (
    <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${meta.tint} ${className ?? ''}`} title={meta.short}>
      <meta.icon className="size-4" aria-hidden />
    </span>
  );
}

/** Create or edit a bank question in a dialog. */
export function QuestionEditorDialog({
  courseId,
  open,
  onOpenChange,
  questionId,
  defaultCategoryId,
  onSaved,
}: {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionId?: string | null;
  defaultCategoryId?: string | null;
  onSaved?: (q: BankQuestion) => void;
}) {
  const editing = !!questionId;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidate = useInvalidateBank();
  const { data: categories } = useCategories(courseId, open);
  const existing = useQuery({
    queryKey: ['bank-question', questionId],
    queryFn: () => api.get<BankQuestion>(`/questions/${questionId}`),
    enabled: open && editing,
  });
  const [draft, setDraft] = useState<QuestionDraft | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [initial, setInitial] = useState('');

  useEffect(() => {
    if (!open) {
      setDraft(null);
      return;
    }
    if (draft) return;
    if (editing && existing.data) {
      const d = draftFrom(existing.data);
      setDraft(d);
      setCategoryId(existing.data.categoryId);
      setInitial(JSON.stringify([d, existing.data.categoryId]));
    } else if (!editing && categories) {
      const d = blankDraft('single');
      const cat = defaultCategoryId && categories.some((c) => c.id === defaultCategoryId) ? defaultCategoryId : (categories[0]?.id ?? '');
      setDraft(d);
      setCategoryId(cat);
      setInitial(JSON.stringify([d, cat]));
    }
  }, [open, editing, existing.data, categories, defaultCategoryId, draft]);

  const dirty = !!draft && JSON.stringify([draft, categoryId]) !== initial;
  const close = async () => {
    if (
      dirty &&
      !(await confirm({
        title: 'Discard your changes?',
        description: "The question hasn't been saved.",
        confirmLabel: 'Discard',
        destructive: true,
      }))
    )
      return;
    onOpenChange(false);
  };

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.put<BankQuestion>(`/questions/${questionId}`, { ...draftInput(draft!), categoryId })
        : api.post<BankQuestion>(`/courses/${courseId}/questions`, { ...draftInput(draft!), categoryId }),
    onSuccess: async (q) => {
      toast.success(editing ? 'Question saved' : 'Question added to the bank');
      qc.setQueryData(['bank-question', q.id], q);
      onSaved?.(q);
      onOpenChange(false);
      await invalidate(courseId);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });

  const usedIn = existing.data?.usage ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : void close())}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<Library className="size-5" />}
            title={editing ? 'Edit question' : 'New question'}
            description={editing ? 'Changes apply wherever this question is used.' : 'Saved to the course question bank.'}
          />
          <DialogBody className="space-y-5">
            {existing.error ? (
              <ErrorState error={existing.error} onRetry={() => existing.refetch()} />
            ) : !draft || !categories ? (
              <div className="space-y-3">
                <Skeleton className="h-9" />
                <Skeleton className="h-24" />
                <Skeleton className="h-32" />
              </div>
            ) : (
              <>
                {usedIn.length > 0 && (
                  <p className="rounded-lg bg-sky-500/[0.08] px-3.5 py-2.5 text-[13px] text-sky-900 dark:text-sky-200">
                    Used in {usedIn.map((u) => `“${u.title}”`).join(', ')}. Attempts already started keep the version they began with.
                  </p>
                )}
                <Field label="Category">
                  {(p) => (
                    <CategorySelect {...p} categories={categories} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} />
                  )}
                </Field>
                <QuestionForm draft={draft} onChange={setDraft} />
              </>
            )}
          </DialogBody>
          <DialogFooter className="border-t">
            <Button type="button" variant="outline" onClick={() => void close()}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!draft || !categoryId}>
              {editing ? 'Save question' : 'Add to bank'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResultBadge({ result }: { result: QuestionResult }) {
  if (result.pending)
    return (
      <Badge variant="warning">
        <Hourglass /> Marked by a teacher
      </Badge>
    );
  return (
    <Badge variant={result.correct ? 'success' : result.partial ? 'warning' : 'danger'}>
      {result.correct ? <CircleCheck /> : <CircleX />}
      {formatMark(result.points)} / {formatMark(result.maxPoints)}
    </Badge>
  );
}

/** Try a question as a student would, then check the answer. */
export function QuestionPreviewDialog({
  questionId,
  open,
  onOpenChange,
}: {
  questionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useQuery({
    queryKey: ['question-preview', questionId],
    queryFn: () => api.get<{ question: Question; answer: AttemptAnswer | null }>(`/questions/${questionId}/preview`),
    enabled: open && !!questionId,
    gcTime: 0,
  });
  const [answer, setAnswer] = useState<AttemptAnswer | undefined>();
  const [checked, setChecked] = useState<{ result: QuestionResult; question: Question } | null>(null);
  useEffect(() => {
    setAnswer(preview.data?.answer ?? undefined);
    setChecked(null);
  }, [preview.data]);

  const check = useMutation({
    mutationFn: () => api.post<{ result: QuestionResult; question: Question }>(`/questions/${questionId}/check`, { answer: answer ?? {} }),
    onSuccess: setChecked,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const q = checked?.question ?? preview.data?.question;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          icon={<Eye className="size-5" />}
          title="Preview"
          description="This is how students see the question. Try answering it."
        />
        <DialogBody className="space-y-4 pb-4">
          {preview.error ? (
            <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
          ) : !q ? (
            <Skeleton className="h-48" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{TYPE_META[q.type].hint}</p>
                {checked ? (
                  <ResultBadge result={checked.result} />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {formatMark(q.points)} point{q.points === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <Markdown source={q.prompt} className="text-[15px] font-medium [&_p]:my-0" />
              <QuestionAnswer question={q} answer={answer} onChange={setAnswer} review={!!checked} disabled={!!checked} />
              {checked?.result.pending && (
                <p className="text-sm text-muted-foreground">Essay answers are marked by hand after the attempt is handed in.</p>
              )}
              {checked && q.explanation && (
                <div className="flex gap-3 rounded-lg bg-sky-500/[0.07] px-4 py-3 text-sm">
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                  <InlineMarkdown source={q.explanation} />
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter className="border-t">
          <Button type="button" variant="outline" onClick={() => preview.refetch()} disabled={!q || preview.isFetching}>
            <RotateCcw /> Start over
          </Button>
          <Button type="button" onClick={() => check.mutate()} loading={check.isPending} disabled={!q || !!checked}>
            Check answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
