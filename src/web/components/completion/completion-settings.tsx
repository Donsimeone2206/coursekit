import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, ListChecks, ListTodo } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import {
  CERTIFICATE_PLACEHOLDERS,
  type CompletionActivityOption,
  type CourseCompletionSettings,
  type CourseCompletionSettingsResponse,
  type SaveCompletionSettingsResult,
} from '@shared/completion';
import type { CourseDetail } from '@shared/types';
import { ActivityIcon } from '@/components/course';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, ChoiceCards, Field, Input, SwitchField, Textarea } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { achievementKeys } from '@/lib/achievements';
import { api, errorMessage } from '@/lib/api';
import { useUnsavedChanges } from '@/lib/hooks';
import { useMe, useSession } from '@/lib/session';
import { CertificateSheet } from './certificate-sheet';

interface Form {
  enabled: boolean;
  mode: 'all' | 'selected';
  activityIds: string[];
  minGrade: string;
  certificate: CourseCompletionSettings['certificate'];
}

function toForm(s: CourseCompletionSettings): Form {
  return {
    enabled: s.enabled,
    mode: s.mode,
    activityIds: s.activityIds,
    minGrade: s.minGrade == null ? '' : String(s.minGrade),
    certificate: { ...s.certificate },
  };
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 border-b py-8 first:pt-0 last:border-0 last:pb-0 md:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </div>
  );
}

function untrackedReason(a: CompletionActivityOption): string | null {
  if (!a.visible) return 'Hidden from students';
  if (a.completion === 'none') return 'Completion tracking is off';
  return null;
}

function ActivityPicker({
  activities,
  selected,
  onToggle,
}: {
  activities: CompletionActivityOption[];
  selected: string[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  const chosen = new Set(selected);
  const sections = useMemo(() => {
    const groups: Array<{ title: string; items: CompletionActivityOption[] }> = [];
    for (const a of activities) {
      const last = groups.at(-1);
      if (last?.title === a.sectionTitle) last.items.push(a);
      else groups.push({ title: a.sectionTitle, items: [a] });
    }
    return groups;
  }, [activities]);
  if (activities.length === 0) return <p className="text-sm text-muted-foreground">This course has no activities yet.</p>;
  return (
    <fieldset className="min-w-0 overflow-hidden rounded-xl border">
      <legend className="sr-only">Required activities</legend>
      <div className="ck-scrollbar max-h-80 divide-y overflow-y-auto">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="bg-muted/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground">{section.title}</p>
            <ul className="divide-y">
              {section.items.map((a) => {
                const reason = untrackedReason(a);
                const id = `completion-activity-${a.id}`;
                return (
                  <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <Checkbox
                      id={id}
                      checked={chosen.has(a.id)}
                      disabled={!a.tracked && !chosen.has(a.id)}
                      onCheckedChange={(v) => onToggle(a.id, v === true)}
                    />
                    <ActivityIcon type={a.type} size="sm" />
                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
                      <span className="block truncate font-medium">{a.title}</span>
                      {reason && (
                        <span className="block text-xs text-muted-foreground">
                          {reason}
                          {chosen.has(a.id) ? ', so it doesn’t count for now' : ''}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function PlaceholderButtons({ onInsert }: { onInsert: (key: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Insert:</span>
      {CERTIFICATE_PLACEHOLDERS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onInsert(p.key)}
          className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          title={p.label}
          aria-label={`Insert ${p.label} (${p.key})`}
        >
          {p.key}
        </button>
      ))}
    </div>
  );
}

/** Completion criteria and certificate settings, shown on the course settings page. */
export function CompletionSettingsCard({ course }: { course: CourseDetail }) {
  const canManage = course.capabilities.includes('completion:manage');
  const qc = useQueryClient();
  const me = useMe();
  const { data: session } = useSession();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: achievementKeys.settings(course.slug),
    queryFn: () => api.get<CourseCompletionSettingsResponse>(`/courses/${course.id}/completion/settings`),
    enabled: canManage,
  });
  const [form, setForm] = useState<Form | null>(null);
  const [preview, setPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (data && !form) setForm(toForm(data.settings));
  }, [data, form]);
  // The Completion tab links here with #completion.
  const ready = !!form;
  useEffect(() => {
    if (ready && hash === '#completion') formRef.current?.scrollIntoView({ block: 'start' });
  }, [ready, hash]);
  const initial = data ? JSON.stringify(toForm(data.settings)) : '';
  const dirty = !!form && JSON.stringify(form) !== initial;
  useUnsavedChanges(dirty);

  const save = useMutation({
    mutationFn: (f: Form) =>
      api.put<SaveCompletionSettingsResult>(`/courses/${course.id}/completion/settings`, {
        enabled: f.enabled,
        mode: f.mode,
        activityIds: f.activityIds,
        minGrade: f.minGrade.trim() === '' ? null : Number(f.minGrade),
        certificate: f.certificate,
      }),
    onSuccess: async (res) => {
      const extra = [
        res.newlyCompleted
          ? `${res.newlyCompleted} ${res.newlyCompleted === 1 ? 'student has' : 'students have'} completed the course`
          : '',
        res.certificatesIssued ? `${res.certificatesIssued} ${res.certificatesIssued === 1 ? 'certificate' : 'certificates'} issued` : '',
      ].filter(Boolean);
      toast.success('Completion settings saved', extra.length ? { description: `${extra.join('. ')}.` } : undefined);
      qc.setQueryData<CourseCompletionSettingsResponse>(achievementKeys.settings(course.slug), (old) =>
        old ? { ...old, settings: res.settings } : old,
      );
      setForm(toForm(res.settings));
      await qc.invalidateQueries({ queryKey: ['course', course.slug] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!canManage) return null;
  if (error) {
    return (
      <Card className="mt-8 p-6">
        <ErrorState error={error} onRetry={() => refetch()} />
      </Card>
    );
  }
  if (isLoading || !data || !form) return <Skeleton className="mt-8 h-72" />;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const setCertificate = (patch: Partial<Form['certificate']>) =>
    setForm((f) => (f ? { ...f, certificate: { ...f.certificate, ...patch } } : f));
  const tracked = data.activities.filter((a) => a.tracked);
  const selectedTracked = data.activities.filter((a) => a.tracked && form.activityIds.includes(a.id));
  const minGrade = form.minGrade.trim() === '' ? null : Number(form.minGrade);
  const gradeError =
    minGrade != null && (!Number.isFinite(minGrade) || minGrade < 0 || minGrade > 100) ? 'Use a grade from 0 to 100.' : null;
  const selectionError = form.enabled && form.mode === 'selected' && form.activityIds.length === 0 ? 'Choose at least one activity.' : null;

  const insertPlaceholder = (key: string) => {
    const el = bodyRef.current;
    const body = form.certificate.body;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setCertificate({ body: body.slice(0, start) + key + body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + key.length, start + key.length);
    });
  };

  return (
    <form
      ref={formRef}
      id="completion"
      className="mt-8 scroll-mt-32"
      onSubmit={(e) => {
        e.preventDefault();
        if (!gradeError && !selectionError) save.mutate(form);
      }}
    >
      <Card className="p-6 sm:p-8">
        <Section
          title="Course completion"
          description="Decide what completes the course. Students see a checklist on the course page and you see who has finished on the Completion tab."
        >
          <SwitchField
            label="Track course completion"
            description="Completion is checked automatically whenever students finish activities or get grades."
            checked={form.enabled}
            onCheckedChange={(v) => set('enabled', v)}
          />
          {form.enabled && (
            <>
              <fieldset className="min-w-0">
                <legend className="mb-1.5 text-sm font-medium">Students must complete</legend>
                <ChoiceCards<'all' | 'selected'>
                  columns={2}
                  value={form.mode}
                  onChange={(v) => set('mode', v)}
                  options={[
                    {
                      value: 'all',
                      label: 'All activities',
                      description: `Every visible activity that tracks completion (${tracked.length} now).`,
                      icon: <ListChecks className="size-4" />,
                    },
                    {
                      value: 'selected',
                      label: 'Selected activities',
                      description: 'Only the activities you choose below.',
                      icon: <ListTodo className="size-4" />,
                    },
                  ]}
                />
              </fieldset>
              {form.mode === 'all' && tracked.length === 0 && (
                <p className="rounded-lg bg-warning/10 px-3.5 py-2.5 text-sm">
                  No activity tracks completion yet. Turn completion on for some activities, or add a minimum grade.
                </p>
              )}
              {form.mode === 'selected' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Required activities</p>
                    <span className="text-xs text-muted-foreground">{selectedTracked.length} selected</span>
                  </div>
                  <ActivityPicker
                    activities={data.activities}
                    selected={form.activityIds}
                    onToggle={(id, checked) =>
                      setForm((f) =>
                        f
                          ? { ...f, activityIds: checked ? [...new Set([...f.activityIds, id])] : f.activityIds.filter((x) => x !== id) }
                          : f,
                      )
                    }
                  />
                  {selectionError && <p className="text-xs text-destructive">{selectionError}</p>}
                </div>
              )}
              <Field
                label="Minimum course grade"
                optional
                error={gradeError}
                hint="The course total from the gradebook, in percent. Leave empty for no grade requirement."
              >
                {(p) => (
                  <div className="relative sm:w-40">
                    <Input
                      {...p}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step="any"
                      value={form.minGrade}
                      onChange={(e) => set('minGrade', e.target.value)}
                      className="pr-8"
                      placeholder="None"
                    />
                    <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                  </div>
                )}
              </Field>
              <p className="text-xs text-muted-foreground">
                Students who have already completed the course keep their completion when you change these settings.
              </p>
            </>
          )}
        </Section>

        <Section title="Certificate" description="A printable certificate with a code anyone can check on this site’s verification page.">
          <SwitchField
            label="Issue a certificate on completion"
            description="Students who already completed the course get one too."
            checked={form.certificate.enabled}
            onCheckedChange={(v) => setCertificate({ enabled: v })}
          />
          {form.certificate.enabled && (
            <>
              <Field label="Title">
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={120}
                    value={form.certificate.title}
                    onChange={(e) => setCertificate({ title: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Text" hint="Each line is its own line on the certificate. A line with only {name} or {course} is set large.">
                {(p) => (
                  <div className="space-y-2">
                    <Textarea
                      {...p}
                      ref={bodyRef}
                      required
                      rows={6}
                      maxLength={2000}
                      value={form.certificate.body}
                      onChange={(e) => setCertificate({ body: e.target.value })}
                    />
                    <PlaceholderButtons onInsert={insertPlaceholder} />
                  </div>
                )}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Signed by" optional>
                  {(p) => (
                    <Input
                      {...p}
                      maxLength={100}
                      value={form.certificate.signatureName}
                      onChange={(e) => setCertificate({ signatureName: e.target.value })}
                      placeholder={me?.name}
                    />
                  )}
                </Field>
                <Field label="Signer’s title" optional>
                  {(p) => (
                    <Input
                      {...p}
                      maxLength={100}
                      value={form.certificate.signatureTitle}
                      onChange={(e) => setCertificate({ signatureTitle: e.target.value })}
                      placeholder="Course teacher"
                    />
                  )}
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setPreview(true)}>
                  <Eye /> Preview certificate
                </Button>
                {data.settings.certificate.enabled && !dirty && <Badge variant="success">Issuing certificates</Badge>}
              </div>
            </>
          )}
        </Section>
      </Card>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved completion settings</span>}
        <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setForm(toForm(data.settings))}>
          Discard
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!dirty || !!gradeError || !!selectionError}>
          Save completion settings
        </Button>
      </div>

      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent size="xl">
          <DialogHeader
            title="Certificate preview"
            description="With your name and today’s date. Real certificates use the student’s details."
          />
          <DialogBody className="pb-6">
            <CertificateSheet
              content={{
                ...form.certificate,
                siteName: session?.site.name ?? 'Coursekit',
                recipientName: me?.name ?? 'Student Name',
                courseTitle: course.title,
                completedAt: new Date().toISOString(),
                code: '7QK2-M9XD-4TPA',
              }}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </form>
  );
}
