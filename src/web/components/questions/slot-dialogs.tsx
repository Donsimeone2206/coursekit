import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Library, Search, Shuffle, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BankQuestionSummary, Paginated, QuestionType } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, SwitchField } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { cn, plural } from '@/lib/utils';
import { CategorySelect, TypeIcon, useCategories } from './bank';
import { formatMark, QUESTION_TYPES, subtree, TYPE_META } from './meta';
import { useSharedCategories } from './transfer';

const PAGE_SIZE = 25;

/** Pick questions from the bank to add to a quiz. */
export function BankPickerDialog({
  courseId,
  open,
  onOpenChange,
  inQuiz,
  onAdd,
}: {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inQuiz: Set<string>;
  onAdd: (questions: BankQuestionSummary[]) => void;
}) {
  const categories = useCategories(courseId, open);
  const shared = useSharedCategories(courseId, open);
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 250);
  const [type, setType] = useState<QuestionType | ''>('');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Map<string, BankQuestionSummary>>(new Map());
  useEffect(() => {
    if (open) setPicked(new Map());
  }, [open]);
  useEffect(() => setPage(1), [categoryId, term, type]);

  const list = useQuery({
    queryKey: ['bank-questions', courseId, 'picker', { categoryId, term, type, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), subcategories: '1' });
      if (categoryId) params.set('categoryId', categoryId);
      if (term) params.set('q', term);
      if (type) params.set('type', type);
      return api.get<Paginated<BankQuestionSummary>>(`/courses/${courseId}/questions?${params}`);
    },
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const toggle = (q: BankQuestionSummary) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(q.id)) next.delete(q.id);
      else next.set(q.id, q);
      return next;
    });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          icon={<Library className="size-5" />}
          title="Add from the question bank"
          description="Tick the questions to add. They go at the end of the quiz."
        />
        <div className="grid gap-2 px-6 pb-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="pl-9"
              aria-label="Search questions"
            />
          </div>
          <CategorySelect
            categories={categories.data ?? []}
            shared={shared.data}
            allLabel="All categories"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-label="Category"
          />
          <Select value={type} onChange={(e) => setType(e.target.value as QuestionType | '')} aria-label="Question type">
            <option value="">All types</option>
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].short}
              </option>
            ))}
          </Select>
        </div>
        <DialogBody className="border-t px-0 pb-0">
          {list.error ? (
            <div className="p-6">
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            </div>
          ) : !data ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : data.items.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={Library} title="No questions found" description="Create questions in the bank, or change the filters." />
            </div>
          ) : (
            <ul className={cn('divide-y', list.isPlaceholderData && 'opacity-60')}>
              {data.items.map((q) => {
                const already = inQuiz.has(q.id);
                const id = `pick-${q.id}`;
                return (
                  <li key={q.id} className={cn('flex items-start gap-3 px-6 py-3', already && 'opacity-60')}>
                    <Checkbox
                      id={id}
                      checked={already || picked.has(q.id)}
                      disabled={already}
                      onCheckedChange={() => toggle(q)}
                      className="mt-2"
                    />
                    <TypeIcon type={q.type} />
                    <label htmlFor={id} className={cn('min-w-0 flex-1', !already && 'cursor-pointer')}>
                      <span className="block text-sm font-medium break-words">{q.name || q.excerpt}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {TYPE_META[q.type].short} · {q.categoryName} · {formatMark(q.points)} mark{q.points === 1 ? '' : 's'}
                        {q.sharedFrom && <Badge variant="violet">Shared from {q.sharedFrom.courseTitle}</Badge>}
                        {already && <Badge variant="info">In this quiz</Badge>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogBody>
        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t px-6 py-2 text-xs text-muted-foreground">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="icon-xs" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-xs" onClick={() => setPage(page + 1)} disabled={page >= pages} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
        <DialogFooter className="border-t sm:items-center">
          <span className="mr-auto hidden text-sm text-muted-foreground sm:block">{plural(picked.size, 'question')} selected</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => {
              onAdd([...picked.values()]);
              onOpenChange(false);
            }}
          >
            Add {picked.size || ''} to quiz
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RandomSlotInput {
  category: { id: string; name: string; sharedFrom?: { courseId: string; courseTitle: string } };
  questionCount: number;
  includeSubcategories: boolean;
  points: number;
  available: number;
}

/** Add "N random questions from a category". */
export function RandomSlotDialog({
  courseId,
  open,
  onOpenChange,
  fixed,
  onAdd,
}: {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Questions already added to the quiz one by one (they are never picked at random). */
  fixed: BankQuestionSummary[];
  onAdd: (slot: RandomSlotInput) => void;
}) {
  const categories = useCategories(courseId, open);
  const shared = useSharedCategories(courseId, open);
  const own = useMemo(() => categories.data ?? [], [categories.data]);
  const cats = useMemo(() => [...own, ...(shared.data ?? [])], [own, shared.data]);
  const [categoryId, setCategoryId] = useState('');
  const [includeSub, setIncludeSub] = useState(false);
  const [count, setCount] = useState('1');
  const [points, setPoints] = useState('1');
  useEffect(() => {
    if (!open) return;
    setCount('1');
    setPoints('1');
    setIncludeSub(false);
  }, [open]);
  useEffect(() => {
    if (open && cats.length && !cats.some((c) => c.id === categoryId))
      setCategoryId(cats.find((c) => c.questionCount > 0)?.id ?? cats[0]!.id);
  }, [open, cats, categoryId]);

  const ids = categoryId ? (includeSub ? subtree(cats, categoryId) : [categoryId]) : [];
  const inCategory = cats.filter((c) => ids.includes(c.id)).reduce((n, c) => n + c.questionCount, 0);
  const already = fixed.filter((q) => ids.includes(q.categoryId)).length;
  const available = Math.max(0, inCategory - already);
  const n = Number(count);
  const hasChildren = cats.some((c) => c.parentId === categoryId);
  const valid = !!categoryId && Number.isInteger(n) && n >= 1 && n <= 200 && Number(points) >= 0 && points !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const category = cats.find((c) => c.id === categoryId)!;
            const from = shared.data?.find((c) => c.id === categoryId)?.sharedFrom;
            onAdd({
              category: { id: category.id, name: category.name, ...(from ? { sharedFrom: from } : {}) },
              questionCount: n,
              includeSubcategories: includeSub && hasChildren,
              points: Number(points),
              available,
            });
            onOpenChange(false);
          }}
        >
          <DialogHeader
            icon={<Shuffle className="size-5" />}
            title="Add random questions"
            description="Each attempt gets its own pick from the category, never repeating a question already in the quiz."
          />
          <DialogBody className="space-y-4">
            {categories.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                <Field label="Category">
                  {(p) => (
                    <CategorySelect
                      {...p}
                      categories={own}
                      shared={shared.data}
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                    />
                  )}
                </Field>
                {hasChildren && <SwitchField label="Include subcategories" checked={includeSub} onCheckedChange={setIncludeSub} />}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Questions">
                    {(p) => (
                      <Input {...p} type="number" min={1} max={200} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
                    )}
                  </Field>
                  <Field label="Mark for each">
                    {(p) => <Input {...p} type="number" min={0} step="any" value={points} onChange={(e) => setPoints(e.target.value)} />}
                  </Field>
                </div>
                <p
                  className={cn(
                    'flex items-start gap-2 text-sm',
                    n > available ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
                  )}
                >
                  {n > available && <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                  <span>
                    {plural(available, 'question')} to pick from
                    {already > 0 && ` (${already} already in the quiz ${already === 1 ? "isn't" : "aren't"} counted)`}.
                    {n > available && ' Add more questions to the category, or students won’t be able to start the quiz.'}
                  </span>
                </p>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add to quiz
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
