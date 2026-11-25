import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, ListChecks, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { Question, QuestionType } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/form';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { useTitle, useUnsavedChanges } from '@/lib/hooks';
import { cn, formatNumber } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { useActivity } from './frame';

type Draft = Question & { key: string };

const TYPE_LABELS: Record<QuestionType, string> = {
  single: 'Multiple choice (one answer)',
  multiple: 'Multiple choice (several answers)',
  truefalse: 'True / false',
  short: 'Short answer',
  numeric: 'Numerical',
};

let counter = 0;
const key = () => `k${Date.now().toString(36)}${counter++}`;
const optionId = () => Math.random().toString(36).slice(2, 10);

function blank(type: QuestionType): Draft {
  const base = {
    key: key(),
    id: '',
    type,
    prompt: '',
    points: type === 'multiple' ? 2 : 1,
    options: [],
    acceptedAnswers: [],
    tolerance: null,
    explanation: null,
  };
  if (type === 'single' || type === 'multiple') {
    return { ...base, options: [0, 1, 2].map((i) => ({ id: optionId(), text: '', correct: i === 0 })) };
  }
  if (type === 'truefalse') {
    return {
      ...base,
      options: [
        { id: optionId(), text: 'True', correct: true },
        { id: optionId(), text: 'False', correct: false },
      ],
    };
  }
  return base;
}

function convert(q: Draft, type: QuestionType): Draft {
  const fresh = blank(type);
  if (type === q.type) return q;
  const keepOptions = (type === 'single' || type === 'multiple') && (q.type === 'single' || q.type === 'multiple') && q.options.length >= 2;
  return {
    ...fresh,
    key: q.key,
    id: q.id,
    prompt: q.prompt,
    explanation: q.explanation,
    options: keepOptions
      ? q.options.map((o, i) => ({ ...o, correct: type === 'single' ? i === q.options.findIndex((x) => x.correct) : o.correct }))
      : fresh.options,
  };
}

function QuestionCard({
  q,
  index,
  total,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: {
  q: Draft;
  index: number;
  total: number;
  onChange: (q: Draft) => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const setOption = (i: number, patch: Partial<Draft['options'][number]>) => {
    const options = q.options.map((o, j) => {
      if (q.type === 'single' && patch.correct) return j === i ? { ...o, ...patch } : { ...o, correct: false };
      return j === i ? { ...o, ...patch } : o;
    });
    onChange({ ...q, options });
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-5 py-3">
        <span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {index + 1}
        </span>
        <Select
          value={q.type}
          onChange={(e) => onChange(convert(q, e.target.value as QuestionType))}
          className="h-8 w-auto min-w-56 text-[13px]"
          aria-label="Question type"
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Points
          <Input
            type="number"
            min={0}
            step="any"
            value={q.points}
            onChange={(e) => onChange({ ...q, points: Number(e.target.value) })}
            className="h-8 w-20"
          />
        </label>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move up">
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Move down">
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDuplicate} aria-label="Duplicate">
            <Copy />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Delete question" className="hover:text-destructive">
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="space-y-5 p-5">
        <Field label="Question">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={q.prompt}
              onChange={(e) => onChange({ ...q, prompt: e.target.value })}
              placeholder="What would you like to ask? Markdown and `code` work here."
            />
          )}
        </Field>

        {(q.type === 'single' || q.type === 'multiple') && (
          <div className="space-y-2">
            <Label>
              Options{' '}
              {q.type === 'multiple' ? (
                <span className="font-normal text-muted-foreground">(tick every correct option)</span>
              ) : (
                <span className="font-normal text-muted-foreground">(pick the correct one)</span>
              )}
            </Label>
            {q.options.map((o, i) => (
              <div key={o.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOption(i, { correct: q.type === 'single' ? true : !o.correct })}
                  className={cn(
                    'grid size-8 shrink-0 place-items-center border transition-colors',
                    q.type === 'single' ? 'rounded-full' : 'rounded-md',
                    o.correct ? 'border-emerald-600 bg-emerald-600 text-white' : 'text-muted-foreground hover:border-emerald-600',
                  )}
                  aria-label={o.correct ? 'Correct answer' : 'Mark as correct'}
                >
                  {o.correct ? (
                    <Check className="size-4" strokeWidth={3} />
                  ) : (
                    <span className="text-xs">{String.fromCharCode(65 + i)}</span>
                  )}
                </button>
                <Input
                  value={o.text}
                  onChange={(e) => setOption(i, { text: e.target.value })}
                  placeholder={`Option ${String.fromCharCode(65 + i)}`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={q.options.length <= 2}
                  onClick={() => onChange({ ...q, options: q.options.filter((_, j) => j !== i) })}
                  aria-label="Remove option"
                >
                  <X />
                </Button>
              </div>
            ))}
            {q.options.length < 10 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...q, options: [...q.options, { id: optionId(), text: '', correct: false }] })}
              >
                <Plus /> Add option
              </Button>
            )}
          </div>
        )}

        {q.type === 'truefalse' && (
          <div className="space-y-2">
            <Label>The statement is</Label>
            <div className="flex gap-2">
              {q.options.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onChange({ ...q, options: q.options.map((x, j) => ({ ...x, correct: j === i })) })}
                  className={cn(
                    'flex h-10 items-center gap-2 rounded-lg border px-5 text-sm font-medium transition-colors',
                    o.correct ? 'border-emerald-600 bg-emerald-600 text-white' : 'hover:border-emerald-600',
                  )}
                >
                  {o.correct && <Check className="size-4" />}
                  {o.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {q.type === 'short' && (
          <Field label="Accepted answers" hint="One per line. Matching ignores case and extra spaces; use * as a wildcard (e.g. colou*r).">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={(q.acceptedAnswers ?? []).join('\n')}
                onChange={(e) => onChange({ ...q, acceptedAnswers: e.target.value.split('\n') })}
                className="font-mono text-[13px]"
              />
            )}
          </Field>
        )}

        {q.type === 'numeric' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Correct answer">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={q.acceptedAnswers?.[0] ?? ''}
                  onChange={(e) => onChange({ ...q, acceptedAnswers: [e.target.value] })}
                />
              )}
            </Field>
            <Field label="Allowed error (±)" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step="any"
                  value={q.tolerance ?? ''}
                  onChange={(e) => onChange({ ...q, tolerance: e.target.value ? Number(e.target.value) : null })}
                />
              )}
            </Field>
          </div>
        )}

        <Field label="Explanation" optional hint="Shown to students when they review their attempt.">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={q.explanation ?? ''}
              onChange={(e) => onChange({ ...q, explanation: e.target.value || null })}
            />
          )}
        </Field>
      </div>
    </Card>
  );
}

function AddQuestion({ onAdd, variant = 'outline' }: { onAdd: (t: QuestionType) => void; variant?: 'outline' | 'default' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant}>
          <Plus /> Add question
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
          <DropdownMenuItem key={t} onSelect={() => onAdd(t)}>
            {TYPE_LABELS[t]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function QuizEditorPage() {
  const { activityId } = useParams();
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const { data: activity } = useActivity(activityId);
  useTitle(activity ? `Questions · ${activity.title}` : 'Questions');
  const {
    data: questions,
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: ['questions', activityId], queryFn: () => api.get<Question[]>(`/activities/${activityId}/questions`) });
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (questions && draft === null) {
      const d = questions.map((q) => ({ ...q, key: key() }));
      setDraft(d);
      setSaved(JSON.stringify(questions));
    }
  }, [questions, draft]);

  const strip = (d: Draft[]) => d.map(({ key: _k, ...q }) => q);
  const dirty = draft !== null && JSON.stringify(strip(draft)) !== saved;
  useUnsavedChanges(dirty);

  const save = useMutation({
    mutationFn: () =>
      api.put<Question[]>(`/activities/${activityId}/questions`, {
        questions: strip(draft!).map((q) => ({
          ...q,
          id: q.id || undefined,
          acceptedAnswers: (q.acceptedAnswers ?? []).map((a) => a.trim()).filter(Boolean),
        })),
      }),
    onSuccess: async (result) => {
      toast.success('Questions saved');
      setDraft(result.map((q) => ({ ...q, key: key() })));
      setSaved(JSON.stringify(result));
      qc.setQueryData(['questions', activityId], result);
      await invalidate(activity?.course.slug);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });

  const total = (draft ?? []).reduce((s, q) => s + (Number(q.points) || 0), 0);
  const update = (i: number, q: Draft) => setDraft((d) => d!.map((x, j) => (j === i ? q : x)));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const next = [...d!];
      [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
      return next;
    });

  return (
    <Page size="narrow" className="pb-28">
      {activity && (
        <div className="mb-6">
          <Link
            to={activityPath(activity.course.slug, activity.id)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> {activity.title}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit questions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Students see these questions when they attempt the quiz. Grading is automatic.
          </p>
        </div>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !draft ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          {draft.length === 0 && (
            <EmptyState
              icon={ListChecks}
              title="No questions yet"
              description="Add your first question. Mix and match multiple choice, true/false, short answer and numerical questions."
              action={<AddQuestion variant="default" onAdd={(t) => setDraft([blank(t)])} />}
            />
          )}
          {draft.map((q, i) => (
            <QuestionCard
              key={q.key}
              q={q}
              index={i}
              total={draft.length}
              onChange={(next) => update(i, next)}
              onMove={(dir) => move(i, dir)}
              onDuplicate={() =>
                setDraft((d) => {
                  const copy = { ...structuredClone(q), key: key(), id: '', options: q.options.map((o) => ({ ...o, id: optionId() })) };
                  return [...d!.slice(0, i + 1), copy, ...d!.slice(i + 1)];
                })
              }
              onDelete={() => setDraft((d) => d!.filter((_, j) => j !== i))}
            />
          ))}
          {draft.length > 0 && <AddQuestion onAdd={(t) => setDraft((d) => [...d!, blank(t)])} />}
        </div>
      )}

      {draft && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/90 backdrop-blur-lg lg:left-64">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
            <p className="text-sm text-muted-foreground">
              {draft.length} question{draft.length === 1 ? '' : 's'} · {formatNumber(total)} point{total === 1 ? '' : 's'}
              {dirty && <span className="ml-2 font-medium text-amber-600 dark:text-amber-400">Unsaved changes</span>}
            </p>
            <Button className="ml-auto" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              <Save /> Save questions
            </Button>
          </div>
        </div>
      )}
    </Page>
  );
}
