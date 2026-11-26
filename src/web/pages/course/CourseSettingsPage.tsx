import { useMutation, useQuery } from '@tanstack/react-query';
import { Archive, Check, Eye, FileLock2, Globe, KeyRound, Mail, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { COVER_COLORS } from '@shared/constants';
import { GROUP_MODE_DESCRIPTIONS } from '@shared/group-modes';
import type { Category, CourseDetail, CourseVisibility, EnrolmentMethod } from '@shared/types';
import { CompletionSettingsCard } from '@/components/completion/completion-settings';
import { GroupModeSelect } from '@/components/group-modes';
import { Page } from '@/components/layout/shell';
import { MarkdownEditor } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { ChoiceCards, Field, Input, Select, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { COVERS, coverStyle } from '@/lib/covers';
import { useTitle, useUnsavedChanges } from '@/lib/hooks';
import { cn, fromLocalInput, toDateInput } from '@/lib/utils';
import { useCourseContext, useInvalidateCourse } from './context';

export function CoverPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {COVER_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={COVERS[c]?.label}
          onClick={() => onChange(c)}
          className={cn(
            'grid size-10 place-items-center rounded-xl ring-offset-2 ring-offset-background transition-transform hover:scale-105',
            value === c && 'ring-2 ring-foreground',
          )}
          style={coverStyle(c)}
        >
          {value === c && <Check className="size-4 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 border-b py-8 first:pt-0 last:border-0 md:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  );
}

function toForm(c: CourseDetail) {
  return {
    title: c.title,
    slug: c.slug,
    summary: c.summary,
    description: c.description,
    categoryId: c.categoryId ?? '',
    coverColor: c.coverColor,
    visibility: c.visibility,
    enrolment: c.enrolment,
    enrolmentKey: c.enrolmentKey ?? '',
    startDate: toDateInput(c.startDate),
    endDate: toDateInput(c.endDate),
    groupMode: c.groupMode ?? 'none',
  };
}

export default function CourseSettingsPage() {
  const { course } = useCourseContext();
  useTitle(`Settings · ${course.title}`);
  const navigate = useNavigate();
  const invalidate = useInvalidateCourse();
  const confirm = useConfirm();
  const [form, setForm] = useState(() => toForm(course));
  const initial = JSON.stringify(toForm(course));
  const dirty = JSON.stringify(form) !== initial;
  useUnsavedChanges(dirty);
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ id: string; slug: string }>(`/courses/${course.id}`, {
        ...form,
        categoryId: form.categoryId || null,
        enrolmentKey: form.enrolment === 'key' ? form.enrolmentKey.trim() || null : null,
        startDate: form.startDate ? fromLocalInput(`${form.startDate}T00:00`) : null,
        endDate: form.endDate ? fromLocalInput(`${form.endDate}T23:59`) : null,
      }),
    onSuccess: async (res) => {
      toast.success('Course settings saved');
      await invalidate(course.slug);
      if (res.slug !== course.slug) navigate(`/courses/${res.slug}/settings`, { replace: true });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/courses/${course.id}`),
    onSuccess: async () => {
      toast.success('Course deleted');
      await invalidate(course.slug);
      navigate('/my-courses');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Page>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Card className="p-6 sm:p-8">
          <Section title="General" description="How the course appears in the catalog and on the dashboard.">
            <Field label="Title">
              {(p) => <Input {...p} required value={form.title} onChange={(e) => set('title', e.target.value)} />}
            </Field>
            <Field label="Short summary" hint="One or two sentences shown on course cards.">
              {(p) => <Textarea {...p} rows={2} value={form.summary} onChange={(e) => set('summary', e.target.value)} />}
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="URL" hint={`${window.location.origin}/courses/${form.slug}`}>
                {(p) => (
                  <Input {...p} value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
                )}
              </Field>
              <Field label="Category">
                {(p) => (
                  <Select {...p} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                    <option value="">No category</option>
                    {categories?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Cover">{() => <CoverPicker value={form.coverColor} onChange={(v) => set('coverColor', v)} />}</Field>
          </Section>

          <Section title="Description" description="The full course overview shown to people before and after they enrol.">
            <MarkdownEditor value={form.description} onChange={(v) => set('description', v)} rows={10} />
          </Section>

          <Section title="Availability" description="Drafts are only visible to teachers. Archived courses are read-only.">
            <ChoiceCards<CourseVisibility>
              value={form.visibility}
              onChange={(v) => set('visibility', v)}
              options={[
                { value: 'draft', label: 'Draft', description: 'Hidden while you build it.', icon: <FileLock2 className="size-4" /> },
                { value: 'published', label: 'Published', description: 'Listed in the catalog.', icon: <Globe className="size-4" /> },
                { value: 'archived', label: 'Archived', description: 'Read-only for students.', icon: <Archive className="size-4" /> },
              ]}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Start date" optional>
                {(p) => <Input {...p} type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />}
              </Field>
              <Field label="End date" optional>
                {(p) => <Input {...p} type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />}
              </Field>
            </div>
          </Section>

          <Section
            title="Groups"
            description="How groups work in this course. Each activity can use the course default or its own group mode."
          >
            <Field label="Default group mode" hint={GROUP_MODE_DESCRIPTIONS[form.groupMode]}>
              {(p) => <GroupModeSelect id={p.id} value={form.groupMode} onChange={(v) => set('groupMode', v)} />}
            </Field>
          </Section>

          <Section title="Enrolment" description="How students join the course.">
            <ChoiceCards<EnrolmentMethod>
              value={form.enrolment}
              onChange={(v) => set('enrolment', v)}
              options={[
                { value: 'open', label: 'Open', description: 'Anyone can enrol themselves.', icon: <Eye className="size-4" /> },
                { value: 'key', label: 'Enrolment key', description: 'Students need a secret key.', icon: <KeyRound className="size-4" /> },
                { value: 'invite', label: 'Invite only', description: 'Teachers add students.', icon: <Mail className="size-4" /> },
              ]}
            />
            {form.enrolment === 'key' && (
              <Field label="Enrolment key" hint="Share this with your students.">
                {(p) => (
                  <Input {...p} value={form.enrolmentKey} onChange={(e) => set('enrolmentKey', e.target.value)} className="sm:w-72" />
                )}
              </Field>
            )}
          </Section>
        </Card>

        <div className="sticky bottom-4 z-10 mt-6 flex items-center justify-end gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur">
          {dirty && <span className="mr-auto pl-2 text-sm text-muted-foreground">You have unsaved changes</span>}
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setForm(toForm(course))}>
            Discard
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      </form>
      <CompletionSettingsCard course={course} />

      <Card className="mt-8 border-destructive/30 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Delete this course</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Permanently removes the course with all activities, submissions, grades and posts.
            </p>
          </div>
          <Button
            variant="destructive"
            loading={remove.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete “${course.title}”?`,
                  description: 'This cannot be undone. Everything in the course, including student work and grades, will be deleted.',
                  confirmLabel: 'Delete course',
                  destructive: true,
                })
              )
                remove.mutate();
            }}
          >
            <Trash2 /> Delete course
          </Button>
        </div>
      </Card>
    </Page>
  );
}
