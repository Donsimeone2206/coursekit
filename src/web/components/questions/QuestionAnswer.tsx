import { ArrowDown, ArrowUp, Check, GripVertical, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { AttemptAnswer, Question } from '@shared/types';
import { InlineMarkdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/form';
import { cn, excerptOf } from '@/lib/utils';
import { wordCount, wordLimitIssue } from './meta';

interface Props {
  question: Question;
  answer: AttemptAnswer | undefined;
  onChange: (a: AttemptAnswer) => void;
  /** Correct answers are included and shown. */
  review: boolean;
  disabled: boolean;
}

function ChoiceInput({ question, answer, onChange, review, disabled }: Props) {
  const multiple = question.type === 'multiple';
  const chosen = new Set(answer?.optionIds ?? []);
  return (
    <div className="grid gap-2" role={multiple ? 'group' : 'radiogroup'} aria-label="Answer options">
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

function TextInput({ question, answer, onChange, review, disabled }: Props) {
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

function limitText(q: Question): string | null {
  if (q.minWords && q.maxWords) return `${q.minWords}–${q.maxWords} words`;
  if (q.maxWords) return `up to ${q.maxWords} words`;
  if (q.minWords) return `at least ${q.minWords} words`;
  return null;
}

function EssayInput({ question, answer, onChange, disabled }: Props) {
  const id = useId();
  const text = answer?.text ?? '';
  const n = wordCount(text);
  const issue = wordLimitIssue(question, text);
  const limits = limitText(question);
  const counter = (
    <p
      id={`${id}-count`}
      className={cn('text-xs text-muted-foreground tabular-nums', issue && 'font-medium text-amber-700 dark:text-amber-400')}
    >
      {n} word{n === 1 ? '' : 's'}
      {limits && ` · ${issue === 'long' ? 'over the limit of' : issue === 'short' ? 'aim for' : 'suggested length:'} ${limits}`}
    </p>
  );
  if (disabled) {
    return (
      <div className="space-y-2">
        {text.trim() ? (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap">{text}</div>
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">No answer was given.</p>
        )}
        {text.trim() && counter}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={8}
        placeholder="Write your answer here."
        aria-label="Your answer"
        aria-describedby={`${id}-count`}
        className="text-[15px]"
      />
      {counter}
    </div>
  );
}

function MatchingInput({ question, answer, onChange, review, disabled }: Props) {
  const id = useId();
  const matches = answer?.matches ?? {};
  const choices = question.choices ?? [];
  const textOf = (choiceId: string | undefined) => choices.find((c) => c.id === choiceId)?.text;
  return (
    <div className="divide-y rounded-xl border bg-card">
      {(question.pairs ?? []).map((pair) => {
        const chosen = matches[pair.id];
        const right = review && !!chosen && chosen === pair.answerId;
        return (
          <div key={pair.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-center sm:gap-4">
            <label htmlFor={`${id}-${pair.id}`} className="text-[15px] font-medium">
              <InlineMarkdown source={pair.text} />
            </label>
            {review || disabled ? (
              <div className="space-y-1 text-sm">
                <p
                  className={cn(
                    'flex items-start gap-2',
                    review && (right ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'),
                  )}
                >
                  {review &&
                    (right ? (
                      <Check className="mt-0.5 size-4 shrink-0" strokeWidth={3} aria-label="Right" />
                    ) : (
                      <X className="mt-0.5 size-4 shrink-0" strokeWidth={3} aria-label="Wrong" />
                    ))}
                  <span id={`${id}-${pair.id}`} className={cn(!chosen && 'text-muted-foreground italic')}>
                    {chosen ? <InlineMarkdown source={textOf(chosen) ?? ''} /> : 'No answer'}
                  </span>
                </p>
                {review && !right && pair.answer && (
                  <p className="text-muted-foreground">
                    Right answer: <InlineMarkdown source={pair.answer} className="font-medium text-foreground" />
                  </p>
                )}
              </div>
            ) : (
              <Select
                id={`${id}-${pair.id}`}
                value={chosen ?? ''}
                onChange={(e) => {
                  const next = { ...matches };
                  if (e.target.value) next[pair.id] = e.target.value;
                  else delete next[pair.id];
                  onChange({ matches: next });
                }}
                className="h-10"
              >
                <option value="">Choose a match…</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {excerptOf(c.text, 120)}
                  </option>
                ))}
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OrderingInput({ question, answer, onChange, disabled }: Props) {
  const byId = new Map(question.options.map((o) => [o.id, o]));
  const order = (answer?.order ?? question.options.map((o) => o.id)).filter((id) => byId.has(id));
  // State drives the styling; refs keep drag events that arrive between renders consistent.
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const drag = useRef<{ id: string | null; over: number | null }>({ id: null, over: null });
  const endDrag = () => {
    drag.current = { id: null, over: null };
    setDragging(null);
    setOver(null);
  };
  const [announcement, setAnnouncement] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const label = (id: string) => excerptOf(byId.get(id)?.text ?? '', 60);

  const moveTo = (id: string, to: number, focus?: 'up' | 'down') => {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || to === from) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onChange({ order: next });
    setAnnouncement(`“${label(id)}” moved to position ${to + 1} of ${order.length}.`);
    if (focus) {
      const target = focus === 'up' && to === 0 ? 'down' : focus === 'down' && to === order.length - 1 ? 'up' : focus;
      requestAnimationFrame(() => buttons.current.get(`${id}:${target}`)?.focus());
    }
  };

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {disabled ? 'Your order:' : 'Drag the items, or use the arrow buttons, to put them in order.'}
      </p>
      <ol className="space-y-2" aria-label="Items to put in order">
        {order.map((id, i) => {
          const item = byId.get(id)!;
          return (
            <li
              key={id}
              draggable={!disabled}
              onDragStart={(e) => {
                drag.current = { id, over: null };
                setDragging(id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', id);
              }}
              onDragOver={(e) => {
                if (!drag.current.id) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const target = e.clientY > rect.top + rect.height / 2 ? i + 1 : i;
                drag.current.over = target;
                setOver(target);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const { id: moving, over: target } = drag.current;
                if (moving && target != null) {
                  const from = order.indexOf(moving);
                  moveTo(moving, target > from ? target - 1 : target);
                }
                endDrag();
              }}
              onDragEnd={endDrag}
              className={cn(
                'relative flex items-center gap-2.5 rounded-xl border bg-card py-2 pr-2 pl-2.5 text-[15px] transition-shadow',
                !disabled && 'cursor-grab active:cursor-grabbing',
                dragging === id && 'opacity-50',
                over === i && dragging !== id && 'shadow-[0_-3px_0_0_var(--primary)]',
                over === i + 1 && i === order.length - 1 && dragging !== id && 'shadow-[0_3px_0_0_var(--primary)]',
              )}
            >
              {!disabled && <GripVertical className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />}
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                {i + 1}
              </span>
              <InlineMarkdown source={item.text} className="min-w-0 flex-1 py-1" />
              {!disabled && (
                <span className="flex shrink-0">
                  <Button
                    ref={(el) => {
                      buttons.current.set(`${id}:up`, el);
                    }}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === 0}
                    onClick={() => moveTo(id, i - 1, 'up')}
                    aria-label={`Move “${label(id)}” up`}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    ref={(el) => {
                      buttons.current.set(`${id}:down`, el);
                    }}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === order.length - 1}
                    onClick={() => moveTo(id, i + 1, 'down')}
                    aria-label={`Move “${label(id)}” down`}
                  >
                    <ArrowDown />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function OrderingReview({ question, answer }: Props) {
  const byId = new Map(question.options.map((o) => [o.id, o]));
  const right = question.options.map((o) => o.id);
  const index = new Map(right.map((id, i) => [id, i]));
  const order = (answer?.order ?? []).filter((id) => byId.has(id));
  const follows = (i: number) => i > 0 && index.get(order[i]!) === (index.get(order[i - 1]!) ?? -9) + 1;
  const pairs = order.reduce((n, _, i) => n + (follows(i) ? 1 : 0), 0);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground">
          Your order · {pairs} of {Math.max(0, right.length - 1)} pairs in the right order
        </p>
        <ol className="space-y-1.5">
          {order.map((id, i) => (
            <li key={id} className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums">
                {i + 1}
              </span>
              <InlineMarkdown source={byId.get(id)!.text} className="min-w-0 flex-1" />
              {i > 0 &&
                (follows(i) ? (
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                    strokeWidth={3}
                    aria-label="Follows the item above correctly"
                  />
                ) : (
                  <X
                    className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
                    strokeWidth={3}
                    aria-label="Doesn't belong after the item above"
                  />
                ))}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">A tick means the item rightly follows the one above it.</p>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Right order</p>
        <ol className="space-y-1.5">
          {question.options.map((o, i) => (
            <li key={o.id} className="flex items-start gap-2.5 rounded-lg bg-emerald-500/[0.07] px-3 py-2 text-sm">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-600 text-[11px] font-semibold text-white tabular-nums">
                {i + 1}
              </span>
              <InlineMarkdown source={o.text} className="min-w-0 flex-1" />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Answer area for any question type: answering, read-only after submitting, or with the right answers in review. */
export function QuestionAnswer(props: Props) {
  switch (props.question.type) {
    case 'short':
    case 'numeric':
      return <TextInput {...props} />;
    case 'essay':
      return <EssayInput {...props} />;
    case 'matching':
      return <MatchingInput {...props} />;
    case 'ordering':
      return props.review ? <OrderingReview {...props} /> : <OrderingInput {...props} />;
    default:
      return <ChoiceInput {...props} />;
  }
}
