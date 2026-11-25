import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Users } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { canCreateCourses } from '@shared/permissions';
import type { Category } from '@shared/types';
import { PageHeader } from '@/components/common';
import { CourseCover } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { CoverPicker } from './CourseSettingsPage';

export default function CreateCoursePage() {
  useTitle('New course');
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: '', summary: '', categoryId: '', coverColor: 'indigo' });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; slug: string }>('/courses', { ...form, categoryId: form.categoryId || null }),
    onSuccess: async (course) => {
      await qc.invalidateQueries({ queryKey: ['courses'] });
      toast.success('Course created as a draft. Add your first activities!');
      navigate(`/courses/${course.slug}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!canCreateCourses(me?.role)) return <Navigate to="/" replace />;

  return (
    <Page size="narrow">
      <PageHeader title="Create a course" description="Start with the basics. You can change everything later in course settings." />
      <div className="grid gap-6">
        <Card className="overflow-hidden">
          <CourseCover color={form.coverColor} title={form.title || 'New course'} className="h-36">
            <div className="absolute inset-x-6 bottom-5 text-white">
              <p className="text-xs font-medium text-white/80">{categories?.find((c) => c.id === form.categoryId)?.name ?? 'Preview'}</p>
              <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{form.title || 'Your course title'}</p>
            </div>
          </CourseCover>
          <div className="flex items-center gap-2 px-6 py-3 text-xs text-muted-foreground">
            <Users className="size-3.5" /> You'll be the teacher. The course starts as a hidden draft.
          </div>
        </Card>
        <Card className="p-6">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Course title">
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  required
                  minLength={3}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. Introduction to Psychology"
                />
              )}
            </Field>
            <Field label="Short summary" optional hint="One or two sentences for the catalog.">
              {(p) => <Textarea {...p} rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />}
            </Field>
            <Field label="Category" optional>
              {(p) => (
                <Select {...p} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">No category</option>
                  {categories?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Cover">
              {() => <CoverPicker value={form.coverColor} onChange={(coverColor) => setForm({ ...form, coverColor })} />}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} disabled={form.title.trim().length < 3}>
                Create course <ArrowRight />
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Page>
  );
}
