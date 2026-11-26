import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ACTIVITY_DESCRIPTIONS, ACTIVITY_TYPES, DEFAULT_COMPLETION, DEFAULT_SETTINGS } from '@shared/constants';
import type {
  ActivityDetail,
  ActivitySettingsMap,
  ActivityType,
  AssignmentSettings,
  CompletionMode,
  CourseDetail,
  FileInfo,
  ForumSettings,
  LessonSettings,
  LtiSettings,
  GroupMode,
  PackageSettings,
  QuizSettings,
  ResourceSettings,
} from '@shared/types';
import { FileChip, FileDrop } from '@/components/common';
import { ActivityIcon } from '@/components/course';
import { LtiFields } from '@/components/lti';
import { ActivityGroupFields } from '@/components/group-modes';
import { MarkdownEditor } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, ChoiceCards, Field, Input, Label, Select, SwitchField } from '@/components/ui/form';
import { PageLoader } from '@/components/ui/misc';
import { ACTIVITY_META, activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { fromLocalInput, toLocalInput } from '@/lib/utils';
import { useInvalidateCourse } from './context';

const COMPLETION_LABELS: Record<ActivityType, string> = {
  lesson: 'When the lesson is opened',
  resource: 'When the resource is opened',
  assignment: 'When work is submitted',
  quiz: 'When an attempt is finished (and passed, if a pass mark is set)',
  forum: 'When the student posts',
  lti: 'When the tool reports it done (or when opened, if ungraded)',
  package: 'When every part is completed (and passed, if required)',
};

interface FormState {
  type: ActivityType;
  title: string;
  description: string;
  visible: boolean;
  completion: CompletionMode;
  dueAt: string;
  maxGrade: string;
  settings: ActivitySettingsMap[ActivityType];
  /** The activity's own group mode (null: the course default) and the groups it is limited to. */
  groupMode: GroupMode | null;
  groupIds: string[];
  groupIdsChanged: boolean;
}

function initialState(type: ActivityType): FormState {
  return {
    type,
    title: '',
    description: '',
    visible: true,
    completion: DEFAULT_COMPLETION[type],
    dueAt: '',
    maxGrade: type === 'assignment' || type === 'package' ? '100' : '',
    settings: structuredClone(DEFAULT_SETTINGS[type]),
    groupMode: null,
    groupIds: [],
    groupIdsChanged: false,
  };
}

function TypePicker({ onPick }: { onPick: (t: ActivityType) => void }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {ACTIVITY_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onPick(t)}
          className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-md"
        >
          <ActivityIcon type={t} size="lg" />
          <span>
            <span className="block text-sm font-semibold">{ACTIVITY_META[t].label}</span>
            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{ACTIVITY_DESCRIPTIONS[t]}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function SettingsFields({ form, setForm, course }: { form: FormState; setForm: (f: FormState) => void; course: CourseDetail }) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm({ ...form, [key]: value });
  const setSettings = (patch: Record<string, unknown>) =>
    setForm({ ...form, settings: { ...form.settings, ...patch } as FormState['settings'] });
  const [file, setFile] = useState<FileInfo | null>(null);

  switch (form.type) {
    case 'lesson': {
      const s = form.settings as LessonSettings;
      return (
        <>
          <Field label="Lesson content">
            {(p) => (
              <MarkdownEditor
                id={p.id}
                value={s.body}
                onChange={(body) => setSettings({ body })}
                rows={14}
                placeholder="# Lesson title&#10;&#10;Write your lesson here…"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
            <Field label="Video URL" optional hint="YouTube, Vimeo or a direct .mp4 link.">
              {(p) => (
                <Input
                  {...p}
                  value={s.videoUrl ?? ''}
                  onChange={(e) => setSettings({ videoUrl: e.target.value || null })}
                  placeholder="https://www.youtube.com/watch?v=…"
                />
              )}
            </Field>
            <Field label="Duration (minutes)" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  value={s.estimatedMinutes ?? ''}
                  onChange={(e) => setSettings({ estimatedMinutes: e.target.value ? Number(e.target.value) : null })}
                />
              )}
            </Field>
          </div>
        </>
      );
    }
    case 'resource': {
      const s = form.settings as ResourceSettings;
      return (
        <>
          <ChoiceCards
            columns={2}
            value={s.kind}
            onChange={(kind) => setSettings({ kind })}
            options={[
              { value: 'link', label: 'Link', description: 'Point to a web page or document.' },
              { value: 'file', label: 'File', description: 'Upload a PDF, slides, a dataset…' },
            ]}
          />
          {s.kind === 'link' ? (
            <Field label="URL">
              {(p) => <Input {...p} value={s.url ?? ''} onChange={(e) => setSettings({ url: e.target.value })} placeholder="https://" />}
            </Field>
          ) : (
            <div className="space-y-2">
              <Label>File</Label>
              {s.fileId && file ? (
                <FileChip
                  file={file}
                  onRemove={() => {
                    setFile(null);
                    setSettings({ fileId: null });
                  }}
                />
              ) : s.fileId ? (
                <p className="text-sm text-muted-foreground">
                  A file is attached.{' '}
                  <button type="button" className="text-primary hover:underline" onClick={() => setSettings({ fileId: null })}>
                    Replace it
                  </button>
                </p>
              ) : (
                <FileDrop
                  context="activity"
                  courseId={course.id}
                  onUploaded={(f) => {
                    setFile(f);
                    setForm({ ...form, title: form.title || f.name.replace(/\.[^.]+$/, ''), settings: { ...s, fileId: f.id } });
                  }}
                />
              )}
            </div>
          )}
        </>
      );
    }
    case 'assignment': {
      const s = form.settings as AssignmentSettings;
      const toggleType = (t: 'text' | 'file', on: boolean) => {
        const next = on ? [...new Set([...s.submissionTypes, t])] : s.submissionTypes.filter((x) => x !== t);
        if (next.length) setSettings({ submissionTypes: next });
      };
      return (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Due date" optional>
              {(p) => <Input {...p} type="datetime-local" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} />}
            </Field>
            <Field label="Maximum points">
              {(p) => <Input {...p} type="number" min={0} value={form.maxGrade} onChange={(e) => set('maxGrade', e.target.value)} />}
            </Field>
          </div>
          <div className="space-y-2">
            <Label>Students can submit</Label>
            <div className="flex flex-wrap gap-5">
              {(['text', 'file'] as const).map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={s.submissionTypes.includes(t)} onCheckedChange={(v) => toggleType(t, v === true)} />
                  {t === 'text' ? 'Online text' : 'File uploads'}
                </label>
              ))}
            </div>
          </div>
          {s.submissionTypes.includes('file') && (
            <Field label="Maximum files" className="sm:w-48">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={20}
                  value={s.maxFiles}
                  onChange={(e) => setSettings({ maxFiles: Number(e.target.value) || 1 })}
                />
              )}
            </Field>
          )}
          <SwitchField
            label="Accept late submissions"
            description="Students can still submit after the due date; late work is flagged."
            checked={s.allowLate}
            onCheckedChange={(allowLate) => setSettings({ allowLate })}
          />
        </>
      );
    }
    case 'quiz': {
      const s = form.settings as QuizSettings;
      return (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Closes" optional hint="Students can't start attempts after this.">
              {(p) => <Input {...p} type="datetime-local" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} />}
            </Field>
            <Field label="Time limit (minutes)" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  value={s.timeLimitMinutes ?? ''}
                  onChange={(e) => setSettings({ timeLimitMinutes: e.target.value ? Number(e.target.value) : null })}
                  placeholder="No limit"
                />
              )}
            </Field>
            <Field label="Attempts allowed">
              {(p) => (
                <Select {...p} value={s.attemptsAllowed} onChange={(e) => setSettings({ attemptsAllowed: Number(e.target.value) })}>
                  <option value={0}>Unlimited</option>
                  {[1, 2, 3, 4, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Grade to keep">
              {(p) => (
                <Select {...p} value={s.gradingMethod} onChange={(e) => setSettings({ gradingMethod: e.target.value })}>
                  <option value="highest">Highest attempt</option>
                  <option value="last">Last attempt</option>
                  <option value="average">Average of attempts</option>
                </Select>
              )}
            </Field>
            <Field label="Show correct answers">
              {(p) => (
                <Select {...p} value={s.reviewMode} onChange={(e) => setSettings({ reviewMode: e.target.value })}>
                  <option value="immediate">Right after each attempt</option>
                  <option value="after_due">After the quiz closes</option>
                  <option value="score_only">Never (score only)</option>
                </Select>
              )}
            </Field>
            <Field label="Pass mark (%)" optional>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  max={100}
                  value={s.passingPercent ?? ''}
                  onChange={(e) => setSettings({ passingPercent: e.target.value ? Number(e.target.value) : null })}
                  placeholder="None"
                />
              )}
            </Field>
          </div>
          <SwitchField
            label="Shuffle questions"
            description="Each attempt gets the questions in a random order."
            checked={s.shuffleQuestions}
            onCheckedChange={(shuffleQuestions) => setSettings({ shuffleQuestions })}
          />
        </>
      );
    }
    case 'package': {
      const s = form.settings as PackageSettings;
      return (
        <>
          <ChoiceCards
            columns={2}
            value={s.display}
            onChange={(display) => setSettings({ display })}
            options={[
              { value: 'embed', label: 'On the activity page', description: 'The package plays inside Coursekit.' },
              { value: 'window', label: 'In a new window', description: 'For packages that need the whole screen.' },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Maximum points">
              {(p) => <Input {...p} type="number" min={0} value={form.maxGrade} onChange={(e) => set('maxGrade', e.target.value)} />}
            </Field>
            <Field label="Attempts allowed">
              {(p) => (
                <Select {...p} value={s.attemptsAllowed} onChange={(e) => setSettings({ attemptsAllowed: Number(e.target.value) })}>
                  <option value={0}>Unlimited</option>
                  {[1, 2, 3, 4, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Grade to keep">
              {(p) => (
                <Select {...p} value={s.gradingMethod} onChange={(e) => setSettings({ gradingMethod: e.target.value })}>
                  <option value="highest">Highest attempt</option>
                  <option value="last">Last attempt</option>
                </Select>
              )}
            </Field>
          </div>
          <SwitchField
            label="Completion needs a pass"
            description="Automatic completion waits until the package reports a pass, not just a completed status."
            checked={s.requirePass}
            onCheckedChange={(requirePass) => setSettings({ requirePass })}
          />
        </>
      );
    }
    case 'forum': {
      const s = form.settings as ForumSettings;
      return (
        <SwitchField
          label="Students can start discussions"
          description="Turn off for a teacher-led forum where students only reply."
          checked={s.studentsCanStartDiscussions}
          onCheckedChange={(studentsCanStartDiscussions) => setSettings({ studentsCanStartDiscussions })}
        />
      );
    }
  }
}

export function ActivityEditor({
  course,
  open,
  onOpenChange,
  sectionId,
  activityId,
}: {
  course: CourseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sectionId?: string;
  activityId?: string;
}) {
  const navigate = useNavigate();
  const invalidate = useInvalidateCourse();
  const editing = !!activityId;
  const [form, setForm] = useState<FormState | null>(null);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => api.get<ActivityDetail>(`/activities/${activityId}`),
    enabled: open && editing,
  });

  useEffect(() => {
    if (!open) setForm(null);
  }, [open]);

  useEffect(() => {
    if (open && editing && existing && !form) {
      setForm({
        type: existing.type,
        title: existing.title,
        description: existing.description,
        visible: existing.visible,
        completion: existing.completion,
        dueAt: toLocalInput(existing.dueAt),
        maxGrade: existing.maxGrade != null ? String(existing.maxGrade) : '',
        settings: existing.settings,
        groupMode: existing.groupMode ?? null,
        groupIds: (existing.groupRestriction ?? []).map((g) => g.id),
        groupIdsChanged: false,
      });
    }
  }, [open, editing, existing, form]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return null;
      const body = {
        title: form.title,
        description: form.description,
        visible: form.visible,
        completion: form.completion,
        settings: form.settings,
        ...(form.type === 'assignment' || form.type === 'quiz' ? { dueAt: fromLocalInput(form.dueAt) } : {}),
        ...((form.type === 'assignment' || form.type === 'package') && form.maxGrade !== '' ? { maxGrade: Number(form.maxGrade) } : {}),
        ...(form.type === 'lti' ? { maxGrade: form.maxGrade === '' ? null : Number(form.maxGrade) } : {}),
        groupMode: form.groupMode,
        // Only sent when changed, so a restriction to a deleted group isn't lost by saving other fields.
        ...(form.groupIdsChanged ? { groupIds: form.groupIds } : {}),
      };
      if (editing) {
        await api.patch(`/activities/${activityId}`, body);
        return { id: activityId! };
      }
      return api.post<{ id: string }>(`/courses/${course.id}/activities`, { ...body, type: form.type, sectionId });
    },
    onSuccess: async (result) => {
      await invalidate(course.slug);
      onOpenChange(false);
      if (!editing && result && form?.type === 'quiz') {
        toast.success('Quiz created. Now add some questions.');
        navigate(`${activityPath(course.slug, result.id)}/questions`);
      } else if (!editing && result && form?.type === 'package') {
        toast.success('Activity added. Now upload your package.');
        navigate(activityPath(course.slug, result.id));
      } else {
        toast.success(editing ? 'Changes saved' : `${ACTIVITY_META[form!.type].label} added`);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const descriptionLabel = form?.type === 'assignment' ? 'Instructions' : form?.type === 'quiz' ? 'Introduction' : 'Description';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={form ? 'lg' : 'md'}>
        {!form ? (
          editing ? (
            isLoading ? (
              <PageLoader />
            ) : (
              <DialogHeader title="Loading…" />
            )
          ) : (
            <>
              <DialogHeader title="Add an activity" description="Choose what you'd like to add to this section." />
              <DialogBody className="pb-6">
                <TypePicker onPick={(t) => setForm(initialState(t))} />
              </DialogBody>
            </>
          )
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <DialogHeader
              icon={<ActivityIcon type={form.type} className="size-10 bg-transparent" />}
              title={
                editing ? `Edit ${ACTIVITY_META[form.type].label.toLowerCase()}` : `New ${ACTIVITY_META[form.type].label.toLowerCase()}`
              }
              description={ACTIVITY_DESCRIPTIONS[form.type]}
            />
            <DialogBody className="space-y-5 pb-4">
              <Field label="Title">
                {(p) => (
                  <Input {...p} autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                )}
              </Field>
              {form.type !== 'lesson' && (
                <Field label={descriptionLabel} optional={form.type !== 'assignment'}>
                  {(p) => (
                    <MarkdownEditor
                      id={p.id}
                      value={form.description}
                      onChange={(description) => setForm({ ...form, description })}
                      rows={form.type === 'assignment' ? 8 : 4}
                    />
                  )}
                </Field>
              )}
              <SettingsFields form={form} setForm={setForm} course={course} />
              {form.type === 'lti' && (
                <LtiFields
                  course={course}
                  sectionId={editing ? undefined : sectionId}
                  activityId={activityId}
                  settings={form.settings as LtiSettings}
                  onSettings={(patch) => setForm({ ...form, settings: { ...form.settings, ...patch } as FormState['settings'] })}
                  maxGrade={form.maxGrade}
                  onMaxGrade={(maxGrade) => setForm({ ...form, maxGrade })}
                  onSelected={() => onOpenChange(false)}
                />
              )}
              <ActivityGroupFields
                courseId={course.id}
                courseMode={course.groupMode ?? 'none'}
                mode={form.groupMode}
                onModeChange={(groupMode) => setForm({ ...form, groupMode })}
                groupIds={form.groupIds}
                onGroupIdsChange={(groupIds) => setForm({ ...form, groupIds, groupIdsChanged: true })}
              />
              <div className="grid gap-4 border-t pt-5 sm:grid-cols-2">
                <Field label="Completion tracking">
                  {(p) => (
                    <Select
                      {...p}
                      value={form.completion}
                      onChange={(e) => setForm({ ...form, completion: e.target.value as CompletionMode })}
                    >
                      <option value="none">Don't track</option>
                      <option value="manual">Students mark it as done</option>
                      <option value="auto">{COMPLETION_LABELS[form.type]}</option>
                    </Select>
                  )}
                </Field>
                <div className="sm:pt-6">
                  <SwitchField
                    label="Visible to students"
                    checked={form.visible}
                    onCheckedChange={(visible) => setForm({ ...form, visible })}
                  />
                </div>
              </div>
            </DialogBody>
            <DialogFooter className="border-t">
              {!editing && (
                <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setForm(null)}>
                  <ArrowLeft /> Change type
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                {editing
                  ? 'Save changes'
                  : form.type === 'quiz'
                    ? 'Create and add questions'
                    : `Add ${ACTIVITY_META[form.type].label.toLowerCase()}`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
