import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import type { CourseCapability } from '@shared/permissions';
import type { ActivitySummary, CourseDetail } from '@shared/types';
import { api } from '@/lib/api';

export function useCourseQuery(slug: string | undefined) {
  return useQuery({
    queryKey: ['course', slug],
    queryFn: () => api.get<CourseDetail>(`/courses/${slug}`),
    enabled: !!slug,
  });
}

export interface CourseOutletContext {
  course: CourseDetail;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  can: (cap: CourseCapability) => boolean;
}

export function useCourseContext() {
  return useOutletContext<CourseOutletContext>();
}

/** Refresh everything that depends on a course's structure or progress. */
export function useInvalidateCourse() {
  const qc = useQueryClient();
  return (slug?: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['course', slug] }),
      qc.invalidateQueries({ queryKey: ['courses'] }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
      qc.invalidateQueries({ queryKey: ['activity'] }),
    ]);
}

export function allActivities(course: CourseDetail): ActivitySummary[] {
  return course.sections.flatMap((s) => s.activities);
}

/** First visible activity the student hasn't completed yet. */
export function nextActivity(course: CourseDetail): ActivitySummary | null {
  const list = allActivities(course).filter((a) => a.visible);
  return list.find((a) => a.completion !== 'none' && !a.completed) ?? null;
}
