import { ArrowDown, ArrowUp, Check, Plus, X } from 'lucide-react';
import type { Question, QuestionType } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import { QUESTION_TYPES, TYPE_META } from './meta';

export interface QuestionDraft {
  type: QuestionType;
  name: string;
  prompt: string;
  points: number;
  options: Array<{ id: string; text: string; correct: boolean }>;
  pairs: Array<{ id: string; text: string; answer: string }>;
  distractors: string[];
  acceptedAnswers: string[];
  tolerance: number | null;
  explanation: string | null;
  minWords: number | null;
  maxWords: number | null;
  graderNotes: string | null;
}

export const localId = () => Math.random().toString(36).slice(2, 10);

function typeDefaults(type: QuestionType): Pick<QuestionDraft, 'options' | 'pairs' | 'points'> {
  switch (type) {
    case 'single':
    case 'multiple':
      return {
        points: type === 'multiple' ? 2 : 1,
        pairs: [],
        options: [0, 1, 2].map((i) => ({ id: localId(), text: '', correct: i === 0 })),
      };
    case 'truefalse':
      return {
        points: 1,
        pairs: [],
        options: [
          { id: localId(), text: 'True', correct: true },
          { id: localId(), text: 'False', correct: false },
        ],
      };
    case 'ordering':
      return { points: 2, pairs: [], options: [0, 1, 2].map(() => ({ id: localId(), text: '', correct: false })) };
    case 'matching':
      return { points: 2, options: [], pairs: [0, 1, 2].map(() => ({ id: localId(), text: '', answer: '' })) };
    case 'essay':
      return { points: 5, options: [], pairs: [] };
    default:
      return { points: 1, options: [], pairs: [] };
  }
}

export function blankDraft(type: QuestionType = 'single'): QuestionDraft {
  return {
    type,
    name: '',
    prompt: '',
    distractors: [],
    acceptedAnswers: [],
    tolerance: null,
    explanation: null,
    minWords: null,
    maxWords: null,
    graderNotes: null,
    ...typeDefaults(type),
  };
}

export function draftFrom(q: Question & { name?: string }): QuestionDraft {
  return {
    type: q.type,
    name: q.name ?? '',
    prompt: q.prompt,
    points: q.points,
    options: q.options.map((o) => ({ id: o.id, text: o.text, correct: !!o.correct })),
    pairs: (q.pairs ?? []).map((p) => ({ id: p.id, text: p.text, answer: p.answer ?? '' })),
    distractors: q.distractors ?? [],
    acceptedAnswers: q.acceptedAnswers ?? [],
    tolerance: q.tolerance ?? null,
    explanation: q.explanation ?? null,
    minWords: q.minWords ?? null,
    maxWords: q.maxWords ?? null,
    graderNotes: q.graderNotes ?? null,
  };
}

/** Switches type, keeping whatever still makes sense (prompt, explanation, compatible options). */
export function convertDraft(d: QuestionDraft, type: QuestionType): QuestionDraft {
  if (type === d.type) return d;
  const fresh = blankDraft(type);
  const choice = (t: QuestionType) => t === 'single' || t === 'multiple';
  let options = fresh.options;
  if (choice(type) && choice(d.type) && d.options.length >= 2) {
    const first = d.options.findIndex((o) => o.correct);
    options = d.options.map((o, i) => ({ ...o, correct: type === 'single' ? i === Math.max(0, first) : o.correct }));
  } else if (type === 'ordering' && (choice(d.type) || d.type === 'ordering') && d.options.length >= 2) {
    options = d.options.map((o) => ({ ...o, correct: false }));
  } else if (choice(type) && d.type === 'ordering' && d.options.length >= 2) {
    options = d.options.map((o, i) => ({ ...o, correct: i === 0 }));
  }
  return { ...fresh, name: d.name, prompt: d.prompt, explanation: d.explanation, options };
}

/** The request body for the question APIs. */
export function draftInput(d: QuestionDraft) {
  return {
    ...d,
    name: d.name.trim(),
    points: Number(d.points) || 0,
    acceptedAnswers: d.acceptedAnswers.map((a) => a.trim()).filter(Boolean),
    distractors: d.distractors.map((a) => a.trim()).filter(Boolean),
    explanation: d.explanation?.trim() || null,
    graderNotes: d.graderNotes?.trim() || null,
  };
}

const numberOrNull = (v: string) => (v === '' ? null : Number(v));

function MoveButtons({ index, total, onMove, label }: { index: number; total: number; onMove: (dir: -1 | 1) => void; label: string }) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label={`Move ${label} up`}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onMove(1)}
        disabled={index === total - 1}
        aria-label={`Move ${label} down`}
      >
        <ArrowDown />
      </Button>
    </>
  );
}

function move<T>(items: T[], index: number, dir: -1 | 1): T[] {
  const next = [...items];
  const target = index + dir;
  if (target < 0 || target >= next.length) return items;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Editing form for every question type. Controlled: pass the draft and receive changes. */
export function QuestionForm({
  draft: q,
  onChange,
  showType = true,
}: {
  draft: QuestionDraft;
  onChange: (d: QuestionDraft) => void;
  showType?: boolean;
}) {
  const set = (patch: Partial<QuestionDraft>) => onChange({ ...q, ...patch });
  const setOption = (i: number, patch: Partial<QuestionDraft['options'][number]>) =>
    set({
      options: q.options.map((o, j) => {
        if (q.type === 'single' && patch.correct) return j === i ? { ...o, ...patch } : { ...o, correct: false };
        return j === i ? { ...o, ...patch } : o;
      }),
    });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        {showType ? (
          <Field label="Question type">
            {(p) => (
              <Select {...p} value={q.type} onChange={(e) => onChange(convertDraft(q, e.target.value as QuestionType))}>
                {QUESTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_META[t].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <div />
        )}
        <Field label="Default mark" hint="Used when it's added to a quiz.">
          {(p) => (
            <Input {...p} type="number" min={0} step="any" value={q.points} onChange={(e) => set({ points: Number(e.target.value) })} />
          )}
        </Field>
      </div>

      <Field label="Question">
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={q.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="What would you like to ask? Markdown and `code` work here."
          />
        )}
      </Field>

      {(q.type === 'single' || q.type === 'multiple') && (
        <div className="space-y-2">
          <Label>
            Options{' '}
            <span className="font-normal text-muted-foreground">
              {q.type === 'multiple' ? '(tick every correct option)' : '(pick the correct one)'}
            </span>
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
                aria-pressed={o.correct}
                aria-label={
                  o.correct ? `Option ${String.fromCharCode(65 + i)} is correct` : `Mark option ${String.fromCharCode(65 + i)} as correct`
                }
              >
                {o.correct ? <Check className="size-4" strokeWidth={3} /> : <span className="text-xs">{String.fromCharCode(65 + i)}</span>}
              </button>
              <Input
                value={o.text}
                onChange={(e) => setOption(i, { text: e.target.value })}
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={q.options.length <= 2}
                onClick={() => set({ options: q.options.filter((_, j) => j !== i) })}
                aria-label={`Remove option ${String.fromCharCode(65 + i)}`}
              >
                <X />
              </Button>
            </div>
          ))}
          {q.options.length < 10 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => set({ options: [...q.options, { id: localId(), text: '', correct: false }] })}
            >
              <Plus /> Add option
            </Button>
          )}
        </div>
      )}

      {q.type === 'truefalse' && (
        <div className="space-y-2">
          <Label>The statement is</Label>
          <div className="flex gap-2" role="radiogroup" aria-label="The statement is">
            {q.options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={o.correct}
                onClick={() => set({ options: q.options.map((x, j) => ({ ...x, correct: j === i })) })}
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
              value={q.acceptedAnswers.join('\n')}
              onChange={(e) => set({ acceptedAnswers: e.target.value.split('\n') })}
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
                value={q.acceptedAnswers[0] ?? ''}
                onChange={(e) => set({ acceptedAnswers: [e.target.value] })}
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
                onChange={(e) => set({ tolerance: numberOrNull(e.target.value) })}
              />
            )}
          </Field>
        </div>
      )}

      {q.type === 'essay' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Minimum words" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  step={1}
                  value={q.minWords ?? ''}
                  onChange={(e) => set({ minWords: numberOrNull(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Maximum words" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  step={1}
                  value={q.maxWords ?? ''}
                  onChange={(e) => set({ maxWords: numberOrNull(e.target.value) })}
                />
              )}
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Students see a live word count. Limits are guidance: answers outside them can still be handed in, and graders see the count.
          </p>
          <Field label="Notes for graders" optional hint="Only teachers see these, while marking. Students never do.">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={q.graderNotes ?? ''}
                onChange={(e) => set({ graderNotes: e.target.value || null })}
                placeholder="What a good answer includes, how to split the marks…"
              />
            )}
          </Field>
        </>
      )}

      {q.type === 'matching' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Items and their matches</Label>
            <p className="text-xs text-muted-foreground">
              Students pick a match for each item from a shuffled list of all the answers. Each right match earns an equal share of the
              marks.
            </p>
            {q.pairs.map((p, i) => (
              <div
                key={p.id}
                className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-2.5 sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0"
              >
                <Input
                  value={p.text}
                  onChange={(e) => set({ pairs: q.pairs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                  placeholder={`Item ${i + 1}`}
                  aria-label={`Item ${i + 1}`}
                />
                <span className="hidden text-muted-foreground sm:block" aria-hidden>
                  →
                </span>
                <div className="flex items-center gap-2 sm:contents">
                  <Input
                    value={p.answer}
                    onChange={(e) => set({ pairs: q.pairs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })}
                    placeholder="Its match"
                    aria-label={`Match for item ${i + 1}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={q.pairs.length <= 2}
                    onClick={() => set({ pairs: q.pairs.filter((_, j) => j !== i) })}
                    aria-label={`Remove item ${i + 1}`}
                  >
                    <X />
                  </Button>
                </div>
              </div>
            ))}
            {q.pairs.length < 20 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => set({ pairs: [...q.pairs, { id: localId(), text: '', answer: '' }] })}
              >
                <Plus /> Add item
              </Button>
            )}
          </div>
          <div className="space-y-2">
            <Label>
              Distractors <span className="font-normal text-muted-foreground">(extra wrong answers, optional)</span>
            </Label>
            {q.distractors.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={d}
                  onChange={(e) => set({ distractors: q.distractors.map((x, j) => (j === i ? e.target.value : x)) })}
                  placeholder="A wrong answer"
                  aria-label={`Distractor ${i + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => set({ distractors: q.distractors.filter((_, j) => j !== i) })}
                  aria-label={`Remove distractor ${i + 1}`}
                >
                  <X />
                </Button>
              </div>
            ))}
            {q.distractors.length < 10 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => set({ distractors: [...q.distractors, ''] })}>
                <Plus /> Add distractor
              </Button>
            )}
          </div>
        </div>
      )}

      {q.type === 'ordering' && (
        <div className="space-y-2">
          <Label>Items in the right order</Label>
          <p className="text-xs text-muted-foreground">
            Students see them shuffled. Each neighbouring pair they put in the right order earns an equal share of the marks (5 items make 4
            pairs).
          </p>
          <ol className="space-y-2">
            {q.options.map((o, i) => (
              <li key={o.id} className="flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                  {i + 1}
                </span>
                <Input
                  value={o.text}
                  onChange={(e) => setOption(i, { text: e.target.value })}
                  placeholder={`Item ${i + 1}`}
                  aria-label={`Item ${i + 1}`}
                />
                <div className="flex shrink-0 items-center">
                  <MoveButtons
                    index={i}
                    total={q.options.length}
                    label={`item ${i + 1}`}
                    onMove={(dir) => set({ options: move(q.options, i, dir) })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={q.options.length <= 2}
                    onClick={() => set({ options: q.options.filter((_, j) => j !== i) })}
                    aria-label={`Remove item ${i + 1}`}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          {q.options.length < 20 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => set({ options: [...q.options, { id: localId(), text: '', correct: false }] })}
            >
              <Plus /> Add item
            </Button>
          )}
        </div>
      )}

      <Field label="Explanation" optional hint="Shown to students when they review their attempt.">
        {(p) => <Textarea {...p} rows={2} value={q.explanation ?? ''} onChange={(e) => set({ explanation: e.target.value || null })} />}
      </Field>
      <Field
        label="Name in the question bank"
        optional
        hint="A short label for finding it later. The question text is shown when it's empty."
      >
        {(p) => <Input {...p} value={q.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />}
      </Field>
    </div>
  );
}
