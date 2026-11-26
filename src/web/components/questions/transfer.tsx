import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Copy, Download, FileUp, Globe, Share2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  MAX_IMPORT_BYTES,
  QUESTION_FILE_FORMATS,
  type QuestionCopyResult,
  type QuestionExportResult,
  type QuestionFileFormat,
  type QuestionImportIssue,
  type QuestionImportPreview,
  type QuestionImportResult,
  type QuestionShare,
  type QuestionShareSettings,
  type SharedQuestionCategory,
} from '@shared/question-sharing';
import type { CourseRef, QuestionCategory } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, SwitchField } from '@/components/ui/form';
import { ErrorState, Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { plural } from '@/lib/utils';
import { CategorySelect, useCategories, useInvalidateBank } from './bank';
import { TYPE_META } from './meta';

export function useSharedCategories(courseId: string, enabled = true) {
  return useQuery({
    queryKey: ['shared-question-categories', courseId],
    queryFn: () => api.get<SharedQuestionCategory[]>(`/courses/${courseId}/shared-question-categories`),
    enabled: enabled && !!courseId,
  });
}

function useBankCourses(enabled: boolean) {
  return useQuery({ queryKey: ['question-bank-courses'], queryFn: () => api.get<CourseRef[]>('/question-bank/courses'), enabled });
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MAX_MB = Math.round(MAX_IMPORT_BYTES / 1024 / 1024);

function where(issue: QuestionImportIssue): string {
  if (issue.number == null) return '';
  return issue.line != null ? `Question ${issue.number} (line ${issue.line})` : `Question ${issue.number}`;
}

function IssueList({ issues, tone }: { issues: QuestionImportIssue[]; tone: 'error' | 'warning' }) {
  const [all, setAll] = useState(false);
  if (issues.length === 0) return null;
  const shown = all ? issues : issues.slice(0, 8);
  const Icon = tone === 'error' ? CircleAlert : TriangleAlert;
  return (
    <div
      className={
        tone === 'error'
          ? 'rounded-lg bg-red-500/[0.07] px-3.5 py-2.5 text-[13px] text-red-800 dark:text-red-300'
          : 'rounded-lg bg-amber-500/[0.08] px-3.5 py-2.5 text-[13px] text-amber-900 dark:text-amber-200'
      }
    >
      <p className="mb-1.5 flex items-center gap-1.5 font-medium">
        <Icon className="size-4 shrink-0" />
        {tone === 'error'
          ? `${plural(issues.length, 'problem')}: these questions will be skipped`
          : `${plural(issues.length, 'note')} about what changes`}
      </p>
      <ul className="space-y-1">
        {shown.map((issue, i) => (
          <li key={i}>
            {where(issue) && <span className="font-medium">{where(issue)}: </span>}
            {issue.message}
          </li>
        ))}
      </ul>
      {issues.length > shown.length && (
        <button type="button" className="mt-1.5 text-xs font-medium underline underline-offset-2" onClick={() => setAll(true)}>
          Show all {issues.length}
        </button>
      )}
    </div>
  );
}

/** Import questions from a Moodle XML or GIFT file: pick it, check what will happen, then import. */
export function ImportDialog({
  courseId,
  categories,
  open,
  onOpenChange,
  defaultCategoryId,
}: {
  courseId: string;
  categories: QuestionCategory[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCategoryId: string | null;
}) {
  const invalidate = useInvalidateBank();
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [format, setFormat] = useState<QuestionFileFormat | ''>('');
  const [keepCategories, setKeepCategories] = useState(true);
  const [categoryId, setCategoryId] = useState('');
  const [preview, setPreview] = useState<QuestionImportPreview | null>(null);
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFormat('');
    setKeepCategories(true);
    setCategoryId(defaultCategoryId ?? '');
    setPreview(null);
  }, [open, defaultCategoryId]);
  useEffect(() => setPreview(null), [file, format, keepCategories, categoryId]);
  useEffect(() => {
    if (!keepCategories && !categoryId && categories[0]) setCategoryId(categories[0].id);
  }, [keepCategories, categoryId, categories]);

  const body = () => ({
    content: file!.content,
    filename: file!.name,
    ...(format ? { format } : {}),
    categoryId: categoryId || null,
    createCategories: keepCategories,
  });
  const check = useMutation({
    mutationFn: () => api.post<QuestionImportPreview>(`/courses/${courseId}/question-import/preview`, body()),
    onSuccess: setPreview,
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });
  const run = useMutation({
    mutationFn: () => api.post<QuestionImportResult>(`/courses/${courseId}/question-import`, body()),
    onSuccess: async (result) => {
      toast.success(
        `Imported ${plural(result.imported, 'question')}${result.categoriesCreated ? ` and ${plural(result.categoriesCreated, 'category', 'categories')}` : ''}`,
        result.skipped ? { description: `${plural(result.skipped, 'question')} skipped.` } : undefined,
      );
      onOpenChange(false);
      await invalidate(courseId);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });

  const pick = async (picked: File | undefined) => {
    if (!picked) return setFile(null);
    if (picked.size > MAX_IMPORT_BYTES) {
      toast.error(`That file is too large. Import files of up to ${MAX_MB} MB.`);
      return setFile(null);
    }
    setFile({ name: picked.name, content: await picked.text() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          icon={<FileUp className="size-5" />}
          title="Import questions"
          description="From a Moodle XML or GIFT file, such as an export from Moodle or another Coursekit course."
        />
        <DialogBody className="space-y-4">
          <Field label="File" hint={`Moodle XML (.xml) or GIFT (.gift, .txt), up to ${MAX_MB} MB.`}>
            {(p) => (
              <Input {...p} type="file" accept=".xml,.gift,.txt,text/xml,text/plain" onChange={(e) => void pick(e.target.files?.[0])} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format">
              {(p) => (
                <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as QuestionFileFormat | '')}>
                  <option value="">Detect from the file</option>
                  {(Object.keys(QUESTION_FILE_FORMATS) as QuestionFileFormat[]).map((f) => (
                    <option key={f} value={f}>
                      {QUESTION_FILE_FORMATS[f].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={keepCategories ? 'Create the categories inside' : 'Put every question in'}>
              {(p) => (
                <CategorySelect
                  {...p}
                  categories={categories}
                  allLabel={keepCategories ? 'Top level of the bank' : undefined}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                />
              )}
            </Field>
          </div>
          <SwitchField label="Keep the categories from the file" checked={keepCategories} onCheckedChange={setKeepCategories} />

          {preview && (
            <div className="space-y-3 border-t pt-4" aria-live="polite">
              <p className="text-sm font-medium">
                {preview.ready === 0
                  ? 'Nothing in this file can be imported.'
                  : `${plural(preview.ready, 'question')} ready to import from this ${QUESTION_FILE_FORMATS[preview.format].label} file`}
                {preview.found > preview.ready && preview.ready > 0 && ` (${preview.found - preview.ready} skipped)`}.
              </p>
              {preview.counts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {preview.counts.map((c) => (
                    <Badge key={c.type} variant="neutral">
                      {TYPE_META[c.type].short} · {c.count}
                    </Badge>
                  ))}
                </div>
              )}
              {preview.categories.length > 0 && (
                <ul className="divide-y rounded-lg border text-[13px]">
                  {preview.categories.map((c) => (
                    <li key={c.label} className="flex items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.isNew && <Badge variant="info">New</Badge>}
                      <span className="text-xs text-muted-foreground tabular-nums">{plural(c.questionCount, 'question')}</span>
                    </li>
                  ))}
                </ul>
              )}
              <IssueList issues={preview.errors} tone="error" />
              <IssueList issues={preview.warnings} tone="warning" />
            </div>
          )}
        </DialogBody>
        <DialogFooter className="border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {preview && preview.ready > 0 ? (
            <Button onClick={() => run.mutate()} loading={run.isPending}>
              Import {plural(preview.ready, 'question')}
            </Button>
          ) : (
            <Button onClick={() => check.mutate()} loading={check.isPending} disabled={!file || (!keepCategories && !categoryId)}>
              Check file
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ExportScope {
  /** What is exported, for the dialog's title. */
  label: string;
  categoryId?: string;
  hasSubcategories?: boolean;
  questionIds?: string[];
}

/** Download questions as Moodle XML or GIFT. */
export function ExportDialog({
  courseId,
  scope,
  onOpenChange,
}: {
  courseId: string;
  scope: ExportScope | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [format, setFormat] = useState<QuestionFileFormat>('moodle');
  const [includeSub, setIncludeSub] = useState(true);
  useEffect(() => {
    if (scope) setIncludeSub(true);
  }, [scope]);
  const run = useMutation({
    mutationFn: () =>
      api.post<QuestionExportResult>(`/courses/${courseId}/question-export`, {
        format,
        ...(scope?.questionIds ? { questionIds: scope.questionIds } : {}),
        ...(scope?.categoryId ? { categoryId: scope.categoryId, includeSubcategories: includeSub } : {}),
      }),
    onSuccess: (result) => {
      downloadFile(result.filename, result.content, result.mimeType);
      const reasons = [...new Set(result.skipped.map((s) => s.reason))].join(' ');
      const left = result.skipped.length ? [`${plural(result.skipped.length, 'question')} left out. ${reasons}`] : [];
      const description = [...left, ...result.notes].join(' ');
      toast.success(`Exported ${plural(result.exported, 'question')}`, description ? { description, duration: 10_000 } : undefined);
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });
  return (
    <Dialog open={!!scope} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader icon={<Download className="size-5" />} title="Export questions" description={scope?.label} />
        <DialogBody className="space-y-4">
          <Segmented
            value={format}
            onChange={setFormat}
            options={(Object.keys(QUESTION_FILE_FORMATS) as QuestionFileFormat[]).map((f) => ({
              value: f,
              label: QUESTION_FILE_FORMATS[f].label,
            }))}
          />
          <p className="text-sm text-muted-foreground">
            {format === 'moodle'
              ? 'Keeps every question type and setting. Moodle and Coursekit can both import it.'
              : 'Plain text you can edit by hand. GIFT can’t hold ordering questions, marks or essay word limits.'}
          </p>
          {scope?.categoryId && scope.hasSubcategories && (
            <SwitchField label="Include subcategories" checked={includeSub} onCheckedChange={setIncludeSub} />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending}>
            <Download /> Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface CopySource {
  label: string;
  questionIds?: string[];
  categoryId?: string;
  hasSubcategories?: boolean;
}

/** Copy questions or a category into a course whose bank you manage. Copies are independent. */
export function CopyDialog({
  courseId,
  source,
  onOpenChange,
}: {
  courseId: string;
  source: CopySource | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = !!source;
  const qc = useQueryClient();
  const invalidate = useInvalidateBank();
  const courses = useBankCourses(open);
  const [target, setTarget] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [includeSub, setIncludeSub] = useState(true);
  const targetCategories = useCategories(target, open && !!target);
  const isCategory = !!source?.categoryId;
  useEffect(() => {
    if (!open || !courses.data) return;
    setTarget((t) =>
      t && courses.data.some((c) => c.id === t) ? t : ((courses.data.find((c) => c.id !== courseId) ?? courses.data[0])?.id ?? ''),
    );
  }, [open, courses.data, courseId]);
  useEffect(() => {
    setCategoryId(isCategory ? '' : (targetCategories.data?.[0]?.id ?? ''));
  }, [targetCategories.data, isCategory, source]);
  useEffect(() => {
    if (open) setIncludeSub(true);
  }, [open]);

  const copy = useMutation({
    mutationFn: () =>
      api.post<QuestionCopyResult>('/question-copies', {
        targetCourseId: target,
        targetCategoryId: categoryId || null,
        ...(isCategory ? { categoryId: source!.categoryId, includeSubcategories: includeSub } : { questionIds: source!.questionIds }),
      }),
    onSuccess: async (result) => {
      const course = courses.data?.find((c) => c.id === target)?.title ?? 'the course';
      toast.success(`Copied ${plural(result.questions, 'question')} to “${course}”`);
      onOpenChange(false);
      await Promise.all([invalidate(target), invalidate(courseId), qc.invalidateQueries({ queryKey: ['shared-question-categories'] })]);
    },
    onError: (err) => toast.error(errorMessage(err), { duration: 8000 }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          icon={<Copy className="size-5" />}
          title={isCategory ? 'Copy category' : 'Copy questions'}
          description={`${source?.label ?? ''}. The copies are independent: editing one never changes the other.`}
        />
        <DialogBody className="space-y-4">
          {courses.error ? (
            <ErrorState error={courses.error} onRetry={() => courses.refetch()} />
          ) : !courses.data ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <Field label="Course">
                {(p) => (
                  <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
                    {courses.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                        {c.id === courseId ? ' (this course)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={isCategory ? 'Put the copy inside' : 'Category'}>
                {(p) => (
                  <CategorySelect
                    {...p}
                    categories={targetCategories.data ?? []}
                    allLabel={isCategory ? 'Top level of the bank' : undefined}
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  />
                )}
              </Field>
              {isCategory && source?.hasSubcategories && (
                <SwitchField label="Include subcategories" checked={includeSub} onCheckedChange={setIncludeSub} />
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => copy.mutate()} loading={copy.isPending} disabled={!target || (!isCategory && !categoryId)}>
            <Copy /> Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Share a category (and its subcategories) with other courses the teacher manages, or the whole site. */
export function ShareDialog({ category, onOpenChange }: { category: QuestionCategory | null; onOpenChange: (open: boolean) => void }) {
  const open = !!category;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const settings = useQuery({
    queryKey: ['question-shares', category?.id],
    queryFn: () => api.get<QuestionShareSettings>(`/question-categories/${category!.id}/shares`),
    enabled: open,
  });
  const [courseId, setCourseId] = useState('');
  const shared = useMemo(() => new Set((settings.data?.shares ?? []).map((s) => s.course?.id ?? '*')), [settings.data]);
  const available = (settings.data?.courses ?? []).filter((c) => !shared.has(c.id));
  useEffect(() => {
    if (!available.some((c) => c.id === courseId)) setCourseId(available[0]?.id ?? '');
  }, [available, courseId]);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['question-shares', category?.id] }),
      qc.invalidateQueries({ queryKey: ['shared-question-categories'] }),
    ]);
  const add = useMutation({
    mutationFn: (body: { courseId: string } | { site: true }) =>
      api.post<QuestionShare>(`/question-categories/${category!.id}/shares`, body),
    onSuccess: async (share) => {
      toast.success(share.course ? `Shared with “${share.course.title}”` : 'Shared with every course');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (share: QuestionShare) => api.delete(`/question-category-shares/${share.id}`),
    onSuccess: async () => {
      toast.success('Stopped sharing');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const stop = async (share: QuestionShare) => {
    const ok = await confirm({
      title: `Stop sharing with ${share.course ? `“${share.course.title}”` : 'every course'}?`,
      description: 'Quizzes that already use these questions keep them, but they can’t be added to quizzes again.',
      confirmLabel: 'Stop sharing',
      destructive: true,
    });
    if (ok) remove.mutate(share);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          icon={<Share2 className="size-5" />}
          title={`Share “${category?.name ?? ''}”`}
          description="Teachers of these courses can use the category and its subcategories in their quizzes, or copy them. Only this course can edit them."
        />
        <DialogBody className="space-y-4">
          {settings.error ? (
            <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
          ) : !settings.data ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              {settings.data.shares.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not shared with any other course yet.</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {settings.data.shares.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      {s.course ? null : <Globe className="size-4 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{s.course ? s.course.title : 'Every course on the site'}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void stop(s)}
                        aria-label={`Stop sharing with ${s.course?.title ?? 'every course'}`}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {available.length > 0 ? (
                <div className="flex items-end gap-2">
                  <Field label="Share with" className="min-w-0 flex-1">
                    {(p) => (
                      <Select {...p} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                        {available.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button onClick={() => add.mutate({ courseId })} loading={add.isPending && !!courseId} disabled={!courseId}>
                    Share
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {settings.data.courses.length === 0
                    ? 'You can share with other courses you teach. You don’t teach any other course yet.'
                    : 'Shared with every other course you teach.'}
                </p>
              )}
              {settings.data.canShareWithSite && !shared.has('*') && (
                <Button variant="outline" className="w-full" onClick={() => add.mutate({ site: true })}>
                  <Globe /> Share with every course on the site
                </Button>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
