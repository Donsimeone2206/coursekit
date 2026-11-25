import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Compass, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { canCreateCourses } from '@shared/permissions';
import type { Category, CourseSummary, Paginated } from '@shared/types';
import { PageHeader } from '@/components/common';
import { CourseCard, CourseCardSkeleton } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { EmptyState, ErrorState, Segmented } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useDebounced, useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 12;

export default function CatalogPage() {
  useTitle('Explore courses');
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q.trim(), 300);

  useEffect(() => {
    setParams(
      (p) => {
        if (debounced) p.set('q', debounced);
        else p.delete('q');
        p.delete('page');
        return p;
      },
      { replace: true },
    );
  }, [debounced, setParams]);

  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['catalog', debounced, category, page],
    queryFn: () =>
      api.get<Paginated<CourseSummary>>(
        `/courses?${new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(category ? { category } : {}), page: String(page), pageSize: String(PAGE_SIZE) })}`,
      ),
    placeholderData: keepPreviousData,
  });

  const setCategory = (id: string) =>
    setParams((p) => {
      if (id) p.set('category', id);
      else p.delete('category');
      p.delete('page');
      return p;
    });
  const setPage = (n: number) =>
    setParams((p) => {
      p.set('page', String(n));
      return p;
    });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Page>
      <PageHeader
        title="Explore courses"
        description="Find your next course. Enrol in open courses instantly, or use an enrolment key from your teacher."
        actions={
          canCreateCourses(me?.role) && (
            <Button asChild>
              <Link to="/courses/new">
                <Plus /> New course
              </Link>
            </Button>
          )
        }
      />

      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative lg:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title or topic"
            className="h-10 pl-9"
            aria-label="Search courses"
          />
        </div>
        <Segmented
          value={category}
          onChange={setCategory}
          className="lg:ml-auto"
          options={[
            { value: '', label: 'All' },
            ...(categories ?? []).filter((c) => c.courseCount > 0).map((c) => ({ value: c.id, label: c.name, count: c.courseCount })),
          ]}
        />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <CourseCardSkeleton key={i} />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={Compass}
          title={debounced || category ? 'No courses match your search' : 'No courses yet'}
          description={debounced || category ? 'Try a different keyword or category.' : 'Published courses will appear here.'}
        />
      ) : (
        <>
          <div className={cn('grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4')}>
            {data.items.map((course) => (
              <CourseCard key={course.id} course={course} showProgress={course.myRole === 'student'} />
            ))}
          </div>
          {pages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft /> Previous
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Page {page} of {pages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next <ChevronRight />
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
