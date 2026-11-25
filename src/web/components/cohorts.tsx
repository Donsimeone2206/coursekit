import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact, Link2, Link2Off, MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { CohortLink, CohortOption, CourseRef, CourseRole } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { cn, plural } from '@/lib/utils';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { useConfirm } from './ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from './ui/dialog';
import { Field, Input, Select } from './ui/form';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/menu';
import { Spinner } from './ui/misc';

export const cohortLinksKey = (courseId: string) => ['cohort-links', courseId] as const;

const people = (n: number) => plural(n, 'person', 'people');

export function RoleSelect({
  value,
  onChange,
  ...props
}: Omit<ComponentProps<'select'>, 'value' | 'onChange'> & { value: CourseRole; onChange: (role: CourseRole) => void }) {
  return (
    <Select {...props} value={value} onChange={(e) => onChange(e.target.value as CourseRole)}>
      <option value="student">Student</option>
      <option value="assistant">Teaching assistant</option>
      <option value="teacher">Teacher</option>
    </Select>
  );
}

/** Explains what linking does; used wherever a cohort is linked. */
export const LINK_EXPLAINER =
  "Everyone in the cohort is enrolled now, and people added to it later are enrolled automatically. People who are already enrolled keep their role. Unlinking keeps everyone's enrolment.";

function LinkCohortDialog({
  course,
  open,
  onOpenChange,
  onLinked,
}: {
  course: CourseRef;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onLinked: () => void;
}) {
  const qc = useQueryClient();
  const [cohortId, setCohortId] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['cohort-links', course.id, 'available'],
    queryFn: () => api.get<CohortOption[]>(`/courses/${course.id}/cohorts/available`),
    enabled: open,
  });
  const term = q.trim().toLowerCase();
  const shown = (data ?? []).filter((c) => !term || c.name.toLowerCase().includes(term));
  const chosen = data?.find((c) => c.id === cohortId) ?? null;
  const link = useMutation({
    mutationFn: () => api.post<{ link: CohortLink; enrolled: number }>(`/courses/${course.id}/cohorts`, { cohortId, role }),
    onSuccess: async (res) => {
      toast.success(
        `Linked ${res.link.cohort.name}. ${res.enrolled ? `Enrolled ${people(res.enrolled)}.` : 'Everyone in it was already enrolled.'}`,
      );
      await qc.invalidateQueries({ queryKey: ['cohort-links', course.id] });
      onLinked();
      onOpenChange(false);
      setCohortId('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen) link.mutate();
          }}
        >
          <DialogHeader icon={<Link2 className="size-5" />} title="Link a cohort" description={LINK_EXPLAINER} />
          <DialogBody className="space-y-4">
            {error ? (
              <p className="text-sm text-destructive">{errorMessage(error)}</p>
            ) : isLoading || !data ? (
              <div className="grid place-items-center py-8">
                <Spinner />
              </div>
            ) : data.length === 0 ? (
              <p className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground">
                There are no cohorts to link. Administrators create cohorts in Administration, under Cohorts.
              </p>
            ) : (
              <>
                {data.length > 6 && (
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search cohorts"
                      aria-label="Search cohorts"
                      className="pl-9"
                    />
                  </div>
                )}
                <div role="radiogroup" aria-label="Cohort" className="ck-scrollbar max-h-64 divide-y overflow-y-auto rounded-lg border">
                  {shown.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No cohorts match your search.</p>}
                  {shown.map((c) => (
                    <label
                      key={c.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40',
                        c.id === cohortId && 'bg-primary/[0.06]',
                      )}
                    >
                      <input
                        type="radio"
                        name="cohort"
                        value={c.id}
                        checked={c.id === cohortId}
                        onChange={() => setCohortId(c.id)}
                        className="size-4 accent-[var(--primary)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{plural(c.memberCount, 'member')}</span>
                    </label>
                  ))}
                </div>
                <Field label="Enrol them as">{(p) => <RoleSelect {...p} value={role} onChange={setRole} />}</Field>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={link.isPending} disabled={!chosen}>
              {chosen ? `Link and enrol ${people(chosen.memberCount)}` : 'Link cohort'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Link cohort" button and dialog for the course's Participants page. */
export function LinkCohortButton({ course, onLinked }: { course: CourseRef; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Link2 /> Link cohort
      </Button>
      <LinkCohortDialog course={course} open={open} onOpenChange={setOpen} onLinked={onLinked} />
    </>
  );
}

/** The cohorts linked to a course, with sync and unlink. Renders nothing when none are linked. */
export function LinkedCohorts({ course, onChange }: { course: CourseRef; onChange: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data } = useQuery({
    queryKey: cohortLinksKey(course.id),
    queryFn: () => api.get<CohortLink[]>(`/courses/${course.id}/cohorts`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['cohort-links', course.id] });
  const sync = useMutation({
    mutationFn: (link: CohortLink) => api.post<{ enrolled: number }>(`/courses/${course.id}/cohorts/${link.id}/sync`),
    onSuccess: (res, link) => {
      toast.success(
        res.enrolled ? `Enrolled ${people(res.enrolled)} from ${link.cohort.name}` : `Everyone in ${link.cohort.name} is enrolled`,
      );
      if (res.enrolled) onChange();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const unlink = useMutation({
    mutationFn: (link: CohortLink) => api.delete(`/courses/${course.id}/cohorts/${link.id}`),
    onSuccess: async (_res, link) => {
      await refresh();
      toast.success(`Unlinked ${link.cohort.name}. Everyone stays enrolled.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!data?.length) return null;
  return (
    <Card className="mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex shrink-0 items-center gap-2 text-sm font-medium">
        <Contact className="size-4 text-primary" /> Linked cohorts
      </div>
      <ul className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap" aria-label="Linked cohorts">
        {data.map((link) => (
          <li
            key={link.id}
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border bg-card py-1.5 pr-1 pl-3 text-sm shadow-xs sm:rounded-full sm:py-1"
          >
            <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-1.5">
              <span className="block truncate font-medium">{link.cohort.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {plural(link.cohort.memberCount, 'member')} · {COURSE_ROLE_LABELS[link.role]}
              </span>
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="rounded-full" aria-label={`Options for ${link.cohort.name}`}>
                  {sync.isPending && sync.variables?.id === link.id ? <Spinner className="size-3.5" /> : <MoreHorizontal />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <DropdownMenuItem onSelect={() => sync.mutate(link)}>
                  <RefreshCw /> Enrol missing members
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={async () => {
                    if (
                      await confirm({
                        title: `Unlink ${link.cohort.name}?`,
                        description: 'Everyone it enrolled stays enrolled. People added to the cohort later are no longer enrolled here.',
                        confirmLabel: 'Unlink',
                        destructive: true,
                      })
                    )
                      unlink.mutate(link);
                  }}
                >
                  <Link2Off /> Unlink cohort
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </Card>
  );
}
