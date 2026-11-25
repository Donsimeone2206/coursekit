import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FolderInput,
  FolderPlus,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { BankQuestionSummary, Paginated, QuestionCategory, QuestionType } from '@shared/types';
import { Page } from '@/components/layout/shell';
import {
  CategorySelect,
  QuestionEditorDialog,
  QuestionPreviewDialog,
  TypeIcon,
  useCategories,
  useInvalidateBank,
} from '@/components/questions/bank';
import { formatMark, QUESTION_TYPES, subtree, TYPE_META, withDepth } from '@/components/questions/meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, SwitchField, Textarea } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useDebounced, useTitle } from '@/lib/hooks';
import { cn, formatRelative, plural } from '@/lib/utils';
import { useCourseContext } from './context';

const PAGE_SIZE = 20;

type CategoryEdit = { mode: 'new'; parentId: string | null } | { mode: 'edit'; category: QuestionCategory };

function CategoryDialog({
  courseId,
  edit,
  categories,
  onClose,
}: {
  courseId: string;
  edit: CategoryEdit | null;
  categories: QuestionCategory[];
  onClose: () => void;
}) {
  const invalidate = useInvalidateBank();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  useEffect(() => {
    if (!edit) return;
    setName(edit.mode === 'edit' ? edit.category.name : '');
    setDescription(edit.mode === 'edit' ? edit.category.description : '');
    setParentId((edit.mode === 'edit' ? edit.category.parentId : edit.parentId) ?? '');
  }, [edit]);
  const exclude = edit?.mode === 'edit' ? subtree(categories, edit.category.id) : [];
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, parentId: parentId || null };
      return edit?.mode === 'edit'
        ? api.patch(`/question-categories/${edit.category.id}`, body)
        : api.post(`/courses/${courseId}/question-categories`, body);
    },
    onSuccess: async () => {
      toast.success(edit?.mode === 'edit' ? 'Category saved' : 'Category created');
      onClose();
      await invalidate(courseId);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={!!edit} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader icon={<FolderPlus className="size-5" />} title={edit?.mode === 'edit' ? 'Edit category' : 'New category'} />
          <DialogBody className="space-y-4">
            <Field label="Name">
              {(p) => <Input {...p} autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Description" optional>
              {(p) => <Textarea {...p} rows={2} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
            <Field label="Inside">
              {(p) => (
                <CategorySelect
                  {...p}
                  categories={categories}
                  allLabel="Top level"
                  exclude={exclude}
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
              {edit?.mode === 'edit' ? 'Save' : 'Create category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCategoryDialog({
  courseId,
  category,
  categories,
  onClose,
  onDeleted,
}: {
  courseId: string;
  category: QuestionCategory | null;
  categories: QuestionCategory[];
  onClose: () => void;
  onDeleted: (moveTo: string) => void;
}) {
  const invalidate = useInvalidateBank();
  const targets = category ? categories.filter((c) => !subtree(categories, category.id).includes(c.id)) : [];
  const [moveTo, setMoveTo] = useState('');
  const fallback = category ? (category.parentId ?? targets[0]?.id ?? '') : '';
  useEffect(() => setMoveTo(fallback), [fallback]);
  const hasContent = !!category && (category.questionCount > 0 || categories.some((c) => c.parentId === category.id));
  const remove = useMutation({
    mutationFn: () => api.delete(`/question-categories/${category!.id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`),
    onSuccess: async () => {
      toast.success(`Deleted “${category!.name}”`);
      onDeleted(moveTo);
      onClose();
      await invalidate(courseId);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });
  return (
    <Dialog open={!!category} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader icon={<Trash2 className="size-5" />} title={`Delete “${category?.name ?? ''}”?`} />
        <DialogBody className="space-y-4">
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">This is the bank's only category. Create another one before deleting it.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {hasContent
                  ? `Its ${plural(category!.questionCount, 'question')}, any subcategories and random quiz questions drawn from it move to the category you pick.`
                  : 'It has no questions. Random quiz questions drawn from it, if any, move to the category you pick.'}
              </p>
              <Field label="Move contents to">
                {(p) => <CategorySelect {...p} categories={targets} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} />}
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => remove.mutate()}
            loading={remove.isPending}
            disabled={targets.length === 0 || !moveTo}
          >
            Delete category
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryList({
  categories,
  total,
  selected,
  onSelect,
  onNew,
  onEdit,
  onDelete,
}: {
  categories: QuestionCategory[];
  total: number;
  selected: string;
  onSelect: (id: string) => void;
  onNew: (parentId: string | null) => void;
  onEdit: (c: QuestionCategory) => void;
  onDelete: (c: QuestionCategory) => void;
}) {
  const rows = withDepth(categories);
  const item = (active: boolean) =>
    cn(
      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
      active && 'bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary',
    );
  return (
    <Card className="overflow-hidden lg:sticky lg:top-32">
      <CardHeader
        title="Categories"
        className="pb-2"
        action={
          <Button variant="ghost" size="icon-sm" onClick={() => onNew(null)} aria-label="New category">
            <FolderPlus />
          </Button>
        }
      />
      <nav aria-label="Question categories" className="ck-scrollbar max-h-72 overflow-y-auto px-2 pb-3 lg:max-h-[calc(100dvh-14rem)]">
        <button
          type="button"
          className={item(selected === '')}
          aria-current={selected === '' ? 'true' : undefined}
          onClick={() => onSelect('')}
        >
          <span className="flex-1 truncate">All questions</span>
          <span className="text-[11px] tabular-nums">{total}</span>
        </button>
        {rows.map((c) => (
          <div key={c.id} className="group flex items-center" style={{ paddingLeft: `${c.depth * 14}px` }}>
            <button
              type="button"
              className={item(selected === c.id)}
              aria-current={selected === c.id ? 'true' : undefined}
              onClick={() => onSelect(c.id)}
            >
              <span className="flex-1 truncate" title={c.description || undefined}>
                {c.name}
              </span>
              <span className="text-[11px] tabular-nums">{c.questionCount}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label={`Actions for ${c.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => onEdit(c)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onNew(c.id)}>
                  <FolderPlus /> Add subcategory
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => onDelete(c)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </nav>
    </Card>
  );
}

export default function QuestionBankPage() {
  const { course, can } = useCourseContext();
  useTitle(`Question bank · ${course.title}`);
  const allowed = can('questionbank:manage');
  const confirm = useConfirm();
  const invalidate = useInvalidateBank();
  const [categoryId, setCategoryId] = useState('');
  const [includeSub, setIncludeSub] = useState(true);
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 250);
  const [type, setType] = useState<QuestionType | ''>('');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<{ questionId: string | null } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [categoryEdit, setCategoryEdit] = useState<CategoryEdit | null>(null);
  const [deleting, setDeleting] = useState<QuestionCategory | null>(null);

  const categories = useCategories(course.id, allowed);
  const cats = useMemo(() => categories.data ?? [], [categories.data]);
  const selected = cats.find((c) => c.id === categoryId) ?? null;
  const hasChildren = !!selected && cats.some((c) => c.parentId === selected.id);
  const filters = { categoryId, includeSub: includeSub && hasChildren, term, type, page };
  useEffect(() => setPage(1), [categoryId, includeSub, term, type]);

  const list = useQuery({
    queryKey: ['bank-questions', course.id, filters],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (categoryId) params.set('categoryId', categoryId);
      if (filters.includeSub) params.set('subcategories', '1');
      if (term) params.set('q', term);
      if (type) params.set('type', type);
      return api.get<Paginated<BankQuestionSummary>>(`/courses/${course.id}/questions?${params}`);
    },
    enabled: allowed,
    placeholderData: keepPreviousData,
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/questions/${id}/duplicate`),
    onSuccess: async () => {
      toast.success('Question duplicated');
      await invalidate(course.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.post(`/courses/${course.id}/questions/move`, { ids: [id], categoryId: to }),
    onSuccess: async (_, { to }) => {
      toast.success(`Moved to “${cats.find((c) => c.id === to)?.name}”`);
      await invalidate(course.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/questions/${id}`),
    onSuccess: async () => {
      toast.success('Question deleted');
      await invalidate(course.id);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 10_000 }),
  });

  if (!allowed) {
    return (
      <Page>
        <EmptyState icon={Library} title="Only teachers can open the question bank" />
      </Page>
    );
  }

  const total = cats.reduce((n, c) => n + c.questionCount, 0);
  const data = list.data;
  const filtering = !!term || !!type;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const askDelete = async (q: BankQuestionSummary) => {
    const ok = await confirm({
      title: 'Delete this question?',
      description:
        q.quizCount > 0
          ? `It's used in ${plural(q.quizCount, 'quiz', 'quizzes')}. Remove it from ${q.quizCount === 1 ? 'that quiz' : 'those quizzes'} first.`
          : 'Attempts that already used it keep their own copy. This cannot be undone.',
      confirmLabel: 'Delete question',
      destructive: true,
    });
    if (ok) remove.mutate(q.id);
  };

  return (
    <Page>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Question bank</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every question for this course&apos;s quizzes lives here. Organise them in categories, then add them to quizzes one by one or as
            random picks.
          </p>
        </div>
        <Button onClick={() => setEditor({ questionId: null })}>
          <Plus /> New question
        </Button>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        {categories.error ? (
          <ErrorState error={categories.error} onRetry={() => categories.refetch()} />
        ) : categories.isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <CategoryList
            categories={cats}
            total={total}
            selected={categoryId}
            onSelect={setCategoryId}
            onNew={(parentId) => setCategoryEdit({ mode: 'new', parentId })}
            onEdit={(category) => setCategoryEdit({ mode: 'edit', category })}
            onDelete={setDeleting}
          />
        )}

        <div className="min-w-0 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search questions"
                className="pl-9"
                aria-label="Search questions"
              />
            </div>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as QuestionType | '')}
              className="sm:w-56"
              aria-label="Question type"
            >
              <option value="">All types</option>
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_META[t].short}
                </option>
              ))}
            </Select>
            {hasChildren && (
              <div className="sm:ml-auto">
                <SwitchField label="Include subcategories" checked={includeSub} onCheckedChange={setIncludeSub} />
              </div>
            )}
          </div>

          {selected?.description && <p className="text-sm text-muted-foreground">{selected.description}</p>}

          {list.error ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !data ? (
            <Skeleton className="h-96" />
          ) : data.items.length === 0 ? (
            filtering ? (
              <EmptyState icon={SearchX} title="No questions match" description="Try another search or question type." />
            ) : (
              <EmptyState
                icon={Library}
                title={selected ? `No questions in “${selected.name}” yet` : 'The question bank is empty'}
                description="Write questions once and reuse them in any quiz in this course."
                action={
                  <Button onClick={() => setEditor({ questionId: null })}>
                    <Plus /> New question
                  </Button>
                }
              />
            )
          ) : (
            <Card className={cn('overflow-hidden transition-opacity', list.isPlaceholderData && 'opacity-60')}>
              <ul className="divide-y" aria-label="Questions">
                {data.items.map((q) => (
                  <li key={q.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                    <TypeIcon type={q.type} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setEditor({ questionId: q.id })}
                        className="block max-w-full text-left text-sm font-medium break-words hover:text-primary focus-visible:text-primary"
                      >
                        {q.name || q.excerpt}
                      </button>
                      {q.name && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{q.excerpt}</p>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral">{TYPE_META[q.type].short}</Badge>
                        <Badge variant="outline">
                          {formatMark(q.points)} mark{q.points === 1 ? '' : 's'}
                        </Badge>
                        {(!categoryId || categoryId !== q.categoryId) && <Badge variant="outline">{q.categoryName}</Badge>}
                        {q.quizCount > 0 && <Badge variant="info">In {plural(q.quizCount, 'quiz', 'quizzes')}</Badge>}
                        <span className="text-xs text-muted-foreground">Updated {formatRelative(q.updatedAt)}</span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPreview(q.id)}
                      aria-label="Preview"
                      className="hidden sm:inline-flex"
                    >
                      <Eye />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${q.name || q.excerpt}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-52">
                        <DropdownMenuItem onSelect={() => setPreview(q.id)}>
                          <Eye /> Preview
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setEditor({ questionId: q.id })}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => duplicate.mutate(q.id)}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <FolderInput className="size-4 text-muted-foreground" /> Move to
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="ck-scrollbar max-h-72 overflow-y-auto">
                            {withDepth(cats).map((c) => (
                              <DropdownMenuItem
                                key={c.id}
                                disabled={c.id === q.categoryId}
                                onSelect={() => move.mutate({ id: q.id, to: c.id })}
                                style={{ paddingLeft: `${10 + c.depth * 12}px` }}
                              >
                                {c.name}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onSelect={() => void askDelete(q)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
              {data.total > PAGE_SIZE && (
                <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
                  <span>
                    {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setPage(page - 1)}
                      disabled={page <= 1}
                      aria-label="Previous page"
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setPage(page + 1)}
                      disabled={page >= pages}
                      aria-label="Next page"
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      <QuestionEditorDialog
        courseId={course.id}
        open={!!editor}
        onOpenChange={(o) => !o && setEditor(null)}
        questionId={editor?.questionId}
        defaultCategoryId={categoryId || null}
      />
      <QuestionPreviewDialog questionId={preview} open={!!preview} onOpenChange={(o) => !o && setPreview(null)} />
      <CategoryDialog courseId={course.id} edit={categoryEdit} categories={cats} onClose={() => setCategoryEdit(null)} />
      <DeleteCategoryDialog
        courseId={course.id}
        category={deleting}
        categories={cats}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          if (deleting?.id === categoryId) setCategoryId('');
        }}
      />
    </Page>
  );
}
