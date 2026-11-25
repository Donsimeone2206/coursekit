import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, MoreHorizontal, Search, UserMinus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { CourseRole, Participant } from '@shared/types';
import { LinkCohortButton, LinkedCohorts } from '@/components/cohorts';
import { GroupBadges, GroupFilter, useGroupFilter } from '@/components/groups';
import { ParticipantBadgesDialog, ParticipantBadgesMenuItem } from '@/components/completion/participant-badges';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { EmptyState, ErrorState, Progress, Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { formatRelative } from '@/lib/utils';
import { useCourseContext, useInvalidateCourse } from './context';

const ROLE_VARIANT: Record<CourseRole, 'violet' | 'info' | 'neutral'> = { teacher: 'violet', assistant: 'info', student: 'neutral' };

function EnrolDialog({
  open,
  onOpenChange,
  courseId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  courseId: string;
  onDone: () => void;
}) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const enrol = useMutation({
    mutationFn: () =>
      api.post<{ added: number; alreadyEnrolled: string[]; notFound: string[] }>(`/courses/${courseId}/participants`, {
        emails: emails.split(/[\s,;]+/).filter(Boolean),
        role,
      }),
    onSuccess: (r) => {
      if (r.added) toast.success(`Enrolled ${r.added} ${r.added === 1 ? 'person' : 'people'}`);
      if (r.alreadyEnrolled.length) toast.info(`Already enrolled: ${r.alreadyEnrolled.join(', ')}`);
      if (r.notFound.length) toast.warning(`No account found for: ${r.notFound.join(', ')}`);
      setEmails('');
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
            enrol.mutate();
          }}
        >
          <DialogHeader
            icon={<UserPlus className="size-5" />}
            title="Enrol people"
            description="Add people who already have an account on this site."
          />
          <DialogBody className="space-y-4">
            <Field label="Email addresses" hint="Separate with commas, spaces or new lines.">
              {(p) => (
                <Textarea
                  {...p}
                  rows={5}
                  autoFocus
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="ada@school.edu, grace@school.edu"
                />
              )}
            </Field>
            <Field label="Role">
              {(p) => (
                <Select {...p} value={role} onChange={(e) => setRole(e.target.value as CourseRole)}>
                  <option value="student">Student</option>
                  <option value="assistant">Teaching assistant</option>
                  <option value="teacher">Teacher</option>
                </Select>
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={enrol.isPending} disabled={!emails.trim()}>
              Enrol
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ParticipantsPage() {
  const { course, can } = useCourseContext();
  useTitle(`Participants · ${course.title}`);
  const me = useMe();
  const qc = useQueryClient();
  const invalidate = useInvalidateCourse();
  const confirm = useConfirm();
  const manage = can('course:manageParticipants');
  const [q, setQ] = useState('');
  const [role, setRole] = useState<'all' | CourseRole>('all');
  const [enrolling, setEnrolling] = useState(false);
  const groupFilter = useGroupFilter(course.id);
  const key = ['participants', course.id];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Participant[]>(`/courses/${course.id}/participants`),
  });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), invalidate(course.slug)]);
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/courses/${course.id}/participants/${id}`, body),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/courses/${course.id}/participants/${id}`),
    onSuccess: async () => {
      await refresh();
      toast.success('Removed from the course');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? []).filter(
      (p) =>
        (role === 'all' || p.role === role) &&
        groupFilter.matches(p.user.id) &&
        (!term || p.user.name.toLowerCase().includes(term) || p.user.email?.toLowerCase().includes(term)),
    );
  }, [data, q, role, groupFilter.matches]);
  const count = (r: CourseRole) => (data ?? []).filter((p) => p.role === r).length;
  const showDetails = !!data?.some((p) => p.user.email);
  const showGroups = !!data?.some((p) => p.groups?.length);

  return (
    <Page>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search participants"
            className="pl-9"
            aria-label="Search participants"
          />
        </div>
        <Segmented
          value={role}
          onChange={setRole}
          options={[
            { value: 'all', label: 'Everyone', count: data?.length },
            { value: 'teacher', label: 'Teachers', count: count('teacher') + count('assistant') },
            { value: 'student', label: 'Students', count: count('student') },
          ]}
        />
        <GroupFilter filter={groupFilter} />
        {manage && (
          <Button className="sm:ml-auto" onClick={() => setEnrolling(true)}>
            <UserPlus /> Enrol people
          </Button>
        )}
        {manage && <LinkCohortButton course={course} onLinked={refresh} />}
      </div>
      {manage && <LinkedCohorts course={course} onChange={refresh} />}

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-96" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Users} title="No participants found" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Role</th>
                  {showGroups && <th className="hidden px-3 py-3 font-medium md:table-cell">Groups</th>}
                  {showDetails && <th className="hidden px-3 py-3 font-medium md:table-cell">Progress</th>}
                  {showDetails && <th className="hidden px-3 py-3 font-medium whitespace-nowrap lg:table-cell">Last access</th>}
                  {manage && <th className="w-12 px-3 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((p) => (
                  <tr key={p.enrolmentId} className="transition-colors hover:bg-accent/30">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar user={p.user} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {p.user.name}
                            {p.user.id === me?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                          </p>
                          {p.user.email && <p className="truncate text-xs text-muted-foreground">{p.user.email}</p>}
                          {showGroups && <GroupBadges groups={p.groups} className="mt-1 md:hidden" />}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={ROLE_VARIANT[p.role]}>{COURSE_ROLE_LABELS[p.role]}</Badge>
                        {p.status === 'suspended' && <Badge variant="danger">Suspended</Badge>}
                      </div>
                    </td>
                    {showGroups && (
                      <td className="hidden px-3 py-3 md:table-cell">
                        <GroupBadges groups={p.groups} />
                      </td>
                    )}
                    {showDetails && (
                      <td className="hidden px-3 py-3 md:table-cell">
                        {p.progress != null ? (
                          <div className="flex items-center gap-2">
                            <Progress value={p.progress} className="w-24" tone={p.progress === 100 ? 'success' : 'primary'} />
                            <span className="text-xs tabular-nums text-muted-foreground">{p.progress}%</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">–</span>
                        )}
                      </td>
                    )}
                    {showDetails && (
                      <td className="hidden px-3 py-3 whitespace-nowrap text-muted-foreground lg:table-cell">
                        {p.lastAccessAt ? formatRelative(p.lastAccessAt) : 'Never'}
                      </td>
                    )}
                    {manage && (
                      <td className="px-3 py-3 text-right">
                        {p.user.id !== me?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.user.name}`}>
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuLabel>Role</DropdownMenuLabel>
                              {(['student', 'assistant', 'teacher'] as const).map((r) => (
                                <DropdownMenuCheckItem
                                  key={r}
                                  checked={p.role === r}
                                  onSelect={() => update.mutate({ id: p.enrolmentId, body: { role: r } })}
                                >
                                  {COURSE_ROLE_LABELS[r]}
                                </DropdownMenuCheckItem>
                              ))}
                              <DropdownMenuSeparator />
                              <ParticipantBadgesMenuItem course={course} participant={p} />
                              <DropdownMenuItem
                                onSelect={() =>
                                  update.mutate({ id: p.enrolmentId, body: { status: p.status === 'active' ? 'suspended' : 'active' } })
                                }
                              >
                                {p.status === 'active' ? <Ban /> : <Check />}
                                {p.status === 'active' ? 'Suspend enrolment' : 'Reactivate enrolment'}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                destructive
                                onSelect={async () => {
                                  if (
                                    await confirm({
                                      title: `Remove ${p.user.name}?`,
                                      description: 'They lose access to the course. Their grades are kept and come back if they re-enrol.',
                                      confirmLabel: 'Remove',
                                      destructive: true,
                                    })
                                  )
                                    remove.mutate(p.enrolmentId);
                                }}
                              >
                                <UserMinus /> Remove from course
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <EnrolDialog open={enrolling} onOpenChange={setEnrolling} courseId={course.id} onDone={refresh} />
      <ParticipantBadgesDialog course={course} />
    </Page>
  );
}
