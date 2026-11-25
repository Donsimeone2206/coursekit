import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FolderTree, Library, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { AdminCourseRow, Category, Paginated } from '@shared/types';
import { AvatarStack } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useDebounced, useTitle } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';

const VIS_VARIANT = { draft: 'warning', published: 'success', archived: 'neutral' } as const;

export function AdminCoursesPage() {
  useTitle('All courses');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(q.trim(), 300);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'courses', debounced, page],
    queryFn: () =>
      api.get<Paginated<AdminCourseRow>>(
        `/admin/courses?${new URLSearchParams({ ...(debounced ? { q: debounced } : {}), page: String(page), pageSize: '20' })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search courses"
            className="pl-9"
            aria-label="Search courses"
          />
        </div>
        <Button asChild className="sm:ml-auto">
          <Link to="/courses/new">
            <Plus /> New course
          </Link>
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Library} title="No courses found" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Course</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="hidden px-3 py-3 font-medium md:table-cell">Teachers</th>
                  <th className="hidden px-3 py-3 font-medium sm:table-cell">Students</th>
                  <th className="hidden px-3 py-3 font-medium lg:table-cell">Created</th>
                  <th className="w-12 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-accent/30">
                    <td className="px-5 py-3">
                      <Link to={`/courses/${c.slug}`} className="flex items-center gap-3 hover:text-primary">
                        <span className="size-8 shrink-0 rounded-lg" style={coverDot(c.coverColor)} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{c.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{c.categoryName ?? 'Uncategorised'}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={VIS_VARIANT[c.visibility]} className="capitalize">
                        {c.visibility}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-3 md:table-cell">
                      <span className="flex items-center gap-2">
                        <AvatarStack users={c.teachers} max={3} />
                        <span className="truncate text-xs text-muted-foreground">{c.teachers.map((t) => t.name).join(', ')}</span>
                      </span>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground tabular-nums sm:table-cell">{c.studentCount}</td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">{formatDate(c.createdAt)}</td>
                    <td className="px-3 py-3 text-right">
                      <Button asChild variant="ghost" size="icon-sm" aria-label={`Settings for ${c.title}`}>
                        <Link to={`/courses/${c.slug}/settings`}>
                          <Settings />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3 text-sm text-muted-foreground">
              <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <span className="tabular-nums">
                {page} / {pages}
              </span>
              <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function CategoryDialog({
  category,
  open,
  onOpenChange,
  onDone,
}: {
  category?: Category;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const save = useMutation({
    mutationFn: () =>
      category ? api.patch(`/categories/${category.id}`, { name, description }) : api.post('/categories', { name, description }),
    onSuccess: () => {
      toast.success(category ? 'Category updated' : 'Category created');
      onDone();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader icon={<FolderTree className="size-5" />} title={category ? 'Edit category' : 'New category'} />
          <DialogBody className="space-y-4">
            <Field label="Name">{(p) => <Input {...p} autoFocus required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Description" optional>
              {(p) => <Textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminCategoriesPage() {
  useTitle('Categories');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['categories'] });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: async () => {
      await refresh();
      toast.success('Category deleted');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Categories organise the course catalog.</p>
        <Button onClick={() => setEditing('new')}>
          <Plus /> New category
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-64" />
      ) : data.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title="No categories yet"
          description="Create categories like “Science” or “Languages” to organise the catalog."
        />
      ) : (
        <Card className="divide-y overflow-hidden">
          {data.map((c) => (
            <div key={c.id} className="flex items-center gap-4 px-5 py-4">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <FolderTree className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.name}</p>
                <p className="truncate text-sm text-muted-foreground">{c.description || 'No description'}</p>
              </div>
              <Badge variant="neutral">
                {c.courseCount} published course{c.courseCount === 1 ? '' : 's'}
              </Badge>
              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${c.name}`}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete “${c.name}”?`,
                      description: 'Courses in this category are kept and become uncategorised.',
                      confirmLabel: 'Delete',
                      destructive: true,
                    })
                  ) {
                    remove.mutate(c.id);
                  }
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </Card>
      )}
      {editing && (
        <CategoryDialog
          category={editing === 'new' ? undefined : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}
