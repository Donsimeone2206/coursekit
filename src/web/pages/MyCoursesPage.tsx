import { useQuery } from '@tanstack/react-query';
import { BookOpen, Compass } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { CourseSummary } from '@shared/types';
import { PageHeader } from '@/components/common';
import { CourseCard, CourseCardSkeleton } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Segmented } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/hooks';

type Filter = 'all' | 'progress' | 'completed' | 'teaching';

export default function MyCoursesPage() {
  useTitle('My courses');
  const [filter, setFilter] = useState<Filter>('all');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['courses', 'mine'],
    queryFn: () => api.get<CourseSummary[]>('/courses/mine'),
  });

  const courses = data ?? [];
  const counts = {
    all: courses.length,
    progress: courses.filter((c) => c.myRole === 'student' && (c.progress ?? 0) < 100).length,
    completed: courses.filter((c) => c.myRole === 'student' && c.progress === 100).length,
    teaching: courses.filter((c) => c.myRole === 'teacher' || c.myRole === 'assistant').length,
  };
  const shown = courses.filter((c) => {
    if (filter === 'progress') return c.myRole === 'student' && (c.progress ?? 0) < 100;
    if (filter === 'completed') return c.myRole === 'student' && c.progress === 100;
    if (filter === 'teaching') return c.myRole === 'teacher' || c.myRole === 'assistant';
    return true;
  });

  return (
    <Page>
      <PageHeader title="My courses" description="Everything you're learning and teaching, most recently visited first." />
      <Segmented
        value={filter}
        onChange={setFilter}
        className="mb-6"
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'progress', label: 'In progress', count: counts.progress },
          { value: 'completed', label: 'Completed', count: counts.completed },
          ...(counts.teaching ? [{ value: 'teaching' as const, label: 'Teaching', count: counts.teaching }] : []),
        ]}
      />
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <CourseCardSkeleton key={i} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={filter === 'completed' ? BookOpen : Compass}
          title={filter === 'completed' ? 'No completed courses yet' : 'No courses here'}
          description={
            filter === 'completed' ? 'Finish every activity in a course to see it here.' : 'Find a course in the catalog to get started.'
          }
          action={
            <Button asChild variant="outline">
              <Link to="/catalog">Explore courses</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((c) => (
            <CourseCard key={c.id} course={c} />
          ))}
        </div>
      )}
    </Page>
  );
}
