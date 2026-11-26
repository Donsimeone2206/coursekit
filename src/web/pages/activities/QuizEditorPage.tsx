import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Eye, Library, ListChecks, Pencil, Plus, Save, Shuffle, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { BankQuestionSummary, QuizSlotInfo, QuizSlots } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { QuestionEditorDialog, QuestionPreviewDialog, toSummary, TypeIcon, useCategories } from '@/components/questions/bank';
import { formatMark, TYPE_META } from '@/components/questions/meta';
import { BankPickerDialog, RandomSlotDialog } from '@/components/questions/slot-dialogs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { useTitle, useUnsavedChanges } from '@/lib/hooks';
import { plural } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { useActivity } from './frame';

type SlotDraft = QuizSlotInfo & { key: string };

let counter = 0;
const key = () => `s${Date.now().toString(36)}${counter++}`;

/** The request body for a list of slots (also used to tell whether anything changed). */
function slotInput(slots: SlotDraft[]) {
  return slots.map((s) =>
    s.kind === 'question'
      ? { id: s.id || undefined, kind: s.kind, questionId: s.question?.id, points: Number(s.points) }
      : {
          id: s.id || undefined,
          kind: s.kind,
          categoryId: s.category?.id,
          questionCount: Number(s.questionCount),
          includeSubcategories: s.includeSubcategories,
          points: Number(s.points),
        },
  );
}

function SlotCard({
  slot,
  index,
  total,
  first,
  onChange,
  onMove,
  onRemove,
  onEdit,
  onPreview,
}: {
  slot: SlotDraft;
  index: number;
  total: number;
  /** Number of the slot's first question in the quiz. */
  first: number;
  onChange: (s: SlotDraft) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onEdit: () => void;
  onPreview: () => void;
}) {
  const q = slot.question;
  const label = slot.kind === 'random' && slot.questionCount > 1 ? `${first}–${first + slot.questionCount - 1}` : String(first);
  const title = q ? q.name || q.excerpt : '';
  const short = slot.kind === 'random' && slot.available != null && slot.needed != null && slot.needed > slot.available;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-7 min-w-7 shrink-0 place-items-center rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground tabular-nums">
          {label}
        </span>
        {slot.kind === 'question' ? (
          q ? (
            <>
              <TypeIcon type={q.type} className="hidden sm:grid" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{title}</p>
                {q.name && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{q.excerpt}</p>}
                <p className="mt-1 text-xs text-muted-foreground">
                  {TYPE_META[q.type].short} · {q.categoryName}
                  {q.sharedFrom && ` · Shared from ${q.sharedFrom.courseTitle}`}
                </p>
              </div>
            </>
          ) : (
            <p className="flex-1 text-sm text-muted-foreground">This question is no longer in the bank.</p>
          )
        ) : (
          <>
            <span className="hidden size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary sm:grid">
              <Shuffle className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">
                {plural(slot.questionCount, 'random question')} from “{slot.category?.name}”
                {slot.includeSubcategories && ' and its subcategories'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {slot.category?.sharedFrom && `Shared from ${slot.category.sharedFrom.courseTitle}. `}
                Picked for each attempt, never repeating a question.
                {slot.available != null && ` ${plural(slot.available, 'question')} to choose from.`}
              </p>
              {short && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" /> Not enough questions: random slots need {slot.needed} from here.
                  Students can&apos;t start the quiz until there are more.
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3 sm:pl-10">
        {slot.kind === 'random' && (
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span className="block">Questions</span>
            <Input
              type="number"
              min={1}
              max={200}
              step={1}
              value={slot.questionCount}
              onChange={(e) => onChange({ ...slot, questionCount: Number(e.target.value) })}
              className="h-8 w-20"
            />
          </label>
        )}
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          <span className="block">{slot.kind === 'random' ? 'Mark each' : 'Mark'}</span>
          <Input
            type="number"
            min={0}
            step="any"
            value={slot.points}
            onChange={(e) => onChange({ ...slot, points: Number(e.target.value) })}
            className="h-8 w-20"
          />
        </label>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${label} up`}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(1)} disabled={index === total - 1} aria-label={`Move ${label} down`}>
            <ArrowDown />
          </Button>
          {slot.kind === 'question' && q && (
            <>
              <Button variant="ghost" size="icon-sm" onClick={onPreview} aria-label={`Preview question ${label}`}>
                <Eye />
              </Button>
              {!q.sharedFrom && (
                <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit question ${label}`}>
                  <Pencil />
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={`Remove ${label} from the quiz`}
            className="hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function QuizEditorPage() {
  const { activityId } = useParams();
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const { data: activity } = useActivity(activityId);
  useTitle(activity ? `Questions · ${activity.title}` : 'Questions');
  const courseId = activity?.courseId ?? '';
  const { data: categories } = useCategories(courseId, !!courseId);
  const query = useQuery({ queryKey: ['slots', activityId], queryFn: () => api.get<QuizSlots>(`/activities/${activityId}/slots`) });
  const [draft, setDraft] = useState<SlotDraft[] | null>(null);
  const [saved, setSaved] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [random, setRandom] = useState(false);
  const [editor, setEditor] = useState<{ questionId: string | null; slotKey?: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = (data: QuizSlots) => {
    const slots = data.slots.map((s) => ({ ...s, key: key() }));
    setDraft(slots);
    setSaved(JSON.stringify(slotInput(slots)));
    setProblems(data.problems);
  };
  useEffect(() => {
    if (query.data && draft === null) load(query.data);
  }, [query.data, draft]);

  const dirty = draft !== null && JSON.stringify(slotInput(draft)) !== saved;
  useUnsavedChanges(dirty);

  const save = useMutation({
    mutationFn: () => api.put<QuizSlots>(`/activities/${activityId}/slots`, { slots: slotInput(draft!) }),
    onSuccess: async (result) => {
      toast.success(result.problems.length ? 'Saved, but some random questions need attention' : 'Quiz questions saved');
      load(result);
      qc.setQueryData(['slots', activityId], result);
      await invalidate(activity?.course.slug);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });

  const slots = useMemo(() => draft ?? [], [draft]);
  const firsts = slots.reduce<number[]>((acc, s, i) => [...acc, i === 0 ? 1 : acc[i - 1]! + slots[i - 1]!.questionCount], []);
  const questionCount = slots.reduce((n, s) => n + (Number(s.questionCount) || 0), 0);
  const total = slots.reduce((sum, s) => sum + (Number(s.points) || 0) * (Number(s.questionCount) || 0), 0);
  const fixed = slots.flatMap((s) => (s.kind === 'question' && s.question ? [s.question] : []));
  const inQuiz = new Set(fixed.map((q) => q.id));

  const update = (i: number, s: SlotDraft) => setDraft((d) => d!.map((x, j) => (j === i ? s : x)));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const next = [...d!];
      [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
      return next;
    });
  const addQuestions = (qs: BankQuestionSummary[]) =>
    setDraft((d) => [
      ...d!,
      ...qs.map((q) => ({
        key: key(),
        id: '',
        kind: 'question' as const,
        points: q.points,
        questionCount: 1,
        question: q,
        category: null,
        includeSubcategories: false,
        available: null,
        needed: null,
      })),
    ]);

  const addButtons = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setPicker(true)}>
        <Library /> Add from bank
      </Button>
      <Button variant="outline" onClick={() => setRandom(true)}>
        <Shuffle /> Add random questions
      </Button>
      <Button variant="outline" onClick={() => setEditor({ questionId: null })}>
        <Plus /> Create new question
      </Button>
    </div>
  );

  return (
    <Page size="narrow" className="pb-28 lg:pb-28">
      {activity && (
        <div className="mb-6">
          <Link
            to={activityPath(activity.course.slug, activity.id)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> {activity.title}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Quiz questions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Questions come from the course&apos;s{' '}
            <Link to={`/courses/${activity.course.slug}/question-bank`} className="font-medium text-primary hover:underline">
              question bank
            </Link>
            . Add specific questions, or random ones picked for each attempt. Essays are marked by hand; everything else is graded
            automatically.
          </p>
        </div>
      )}
      {query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !draft || !activity ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          {!dirty && problems.length > 0 && (
            <div role="alert" className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium">Students can&apos;t start this quiz yet</p>
                {problems.map((p) => (
                  <p key={p} className="text-muted-foreground">
                    {p}
                  </p>
                ))}
              </div>
            </div>
          )}
          {draft.length === 0 && (
            <EmptyState
              icon={ListChecks}
              title="No questions yet"
              description="Pick questions from the bank, draw random ones from a category, or write a new one."
              action={addButtons}
            />
          )}
          {draft.map((s, i) => (
            <SlotCard
              key={s.key}
              slot={s}
              index={i}
              total={draft.length}
              first={firsts[i]!}
              onChange={(next) => update(i, next)}
              onMove={(dir) => move(i, dir)}
              onRemove={() => setDraft((d) => d!.filter((_, j) => j !== i))}
              onEdit={() => setEditor({ questionId: s.question!.id, slotKey: s.key })}
              onPreview={() => setPreview(s.question!.id)}
            />
          ))}
          {draft.length > 0 && addButtons}
        </div>
      )}

      {draft && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/90 backdrop-blur-lg lg:left-64">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
            <p className="text-sm text-muted-foreground">
              {plural(questionCount, 'question')} · {formatMark(total)} point{total === 1 ? '' : 's'}
              {dirty && <span className="ml-2 font-medium text-amber-600 dark:text-amber-400">Unsaved changes</span>}
            </p>
            <Button className="ml-auto" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              <Save /> Save
            </Button>
          </div>
        </div>
      )}

      {activity && (
        <>
          <BankPickerDialog courseId={courseId} open={picker} onOpenChange={setPicker} inQuiz={inQuiz} onAdd={addQuestions} />
          <RandomSlotDialog
            courseId={courseId}
            open={random}
            onOpenChange={setRandom}
            fixed={fixed}
            onAdd={(r) =>
              setDraft((d) => [
                ...d!,
                {
                  key: key(),
                  id: '',
                  kind: 'random',
                  points: r.points,
                  questionCount: r.questionCount,
                  question: null,
                  category: r.category,
                  includeSubcategories: r.includeSubcategories,
                  available: r.available,
                  needed: r.questionCount,
                },
              ])
            }
          />
          <QuestionEditorDialog
            courseId={courseId}
            open={!!editor}
            onOpenChange={(o) => !o && setEditor(null)}
            questionId={editor?.questionId}
            defaultCategoryId={fixed.at(-1)?.categoryId ?? null}
            onSaved={(q) => {
              const summary = toSummary(q, categories);
              if (editor?.slotKey) setDraft((d) => d!.map((s) => (s.key === editor.slotKey ? { ...s, question: summary } : s)));
              else addQuestions([summary]);
            }}
          />
          <QuestionPreviewDialog questionId={preview} open={!!preview} onOpenChange={(o) => !o && setPreview(null)} />
        </>
      )}
    </Page>
  );
}
