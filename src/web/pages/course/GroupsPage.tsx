import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, MoreHorizontal, Pencil, Plus, Search, Shuffle, Trash2, UserPlus, UserRoundX, UsersRound, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_GROUP_NAMING, groupCount, groupNames, MAX_AUTO_GROUPS, type GroupSplit } from '@shared/groups';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { CourseDetail, CourseGroup, CourseGroups, GroupMember, GroupMembersAdded, Participant, PublicUser } from '@shared/types';
import { GroupBadges, GroupTile, groupsKey, useCourseGroups } from '@/components/groups';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, ChoiceCards, Field, Input, SwitchField, Textarea } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { EmptyState, ErrorState, Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import { useCourseContext } from './context';

type AutoCreated = { groups: Array<{ id: string; name: string; memberCount: number }> };

const people = (n: number) => plural(n, 'person', 'people');

function useRefreshGroups(course: CourseDetail) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: groupsKey(course.id) }),
      qc.invalidateQueries({ queryKey: ['participants', course.id] }),
      qc.invalidateQueries({ queryKey: ['course', course.slug] }),
    ]);
}

function SearchBox({
  value,
  onChange,
  label,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="pl-9"
        autoFocus={autoFocus}
      />
    </div>
  );
}

function MemberRow({ member, onRemove, groupName }: { member: GroupMember; onRemove?: () => void; groupName: string }) {
  const me = useMe();
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <Avatar user={member} size="xs" />
      <span className="min-w-0 flex-1 truncate text-sm">
        {member.name}
        {member.id === me?.id && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
      </span>
      {member.role !== 'student' && (
        <Badge variant={member.role === 'teacher' ? 'violet' : 'info'}>{COURSE_ROLE_LABELS[member.role]}</Badge>
      )}
      {member.status === 'suspended' && <Badge variant="danger">Suspended</Badge>}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${member.name} from ${groupName}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </li>
  );
}

function GroupCard({
  group,
  onAdd,
  onEdit,
  onDelete,
  onRemove,
}: {
  group: CourseGroup;
  onAdd?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onRemove?: (member: GroupMember) => void;
}) {
  const manage = !!onAdd;
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <GroupTile group={group} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold tracking-tight">{group.name}</h3>
          <p className="text-xs text-muted-foreground">{plural(group.members.length, 'member')}</p>
        </div>
        {manage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Options for ${group.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onAdd}>
                <UserPlus /> Add people
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> Rename or describe
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Delete group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {group.description && <p className="-mt-1 px-4 pb-3 text-sm text-muted-foreground">{group.description}</p>}
      <ul className="ck-scrollbar max-h-80 flex-1 divide-y overflow-y-auto border-t" aria-label={`Members of ${group.name}`}>
        {group.members.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No one in this group yet.</li>}
        {group.members.map((m) => (
          <MemberRow key={m.id} member={m} groupName={group.name} onRemove={onRemove ? () => onRemove(m) : undefined} />
        ))}
      </ul>
      {manage && (
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full" onClick={onAdd}>
            <UserPlus /> Add people
          </Button>
        </div>
      )}
    </Card>
  );
}

function UngroupedCard({
  people: list,
  groups,
  onAdd,
}: {
  people: Participant[];
  groups: CourseGroup[];
  onAdd?: (group: CourseGroup, user: PublicUser) => void;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden border-dashed bg-muted/20 shadow-none">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-dashed text-muted-foreground" aria-hidden>
          <UserRoundX className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-tight">Not in a group</h3>
          <p className="text-xs text-muted-foreground">{plural(list.length, 'active student')}</p>
        </div>
      </div>
      <ul className="ck-scrollbar max-h-80 flex-1 divide-y overflow-y-auto border-t" aria-label="Students not in a group">
        {list.map((p) => (
          <li key={p.user.id} className="flex items-center gap-3 px-4 py-2">
            <Avatar user={p.user} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm">{p.user.name}</span>
            {onAdd && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" aria-label={`Add ${p.user.name} to a group`}>
                    <Plus /> Add to
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="ck-scrollbar max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>Add to group</DropdownMenuLabel>
                  {groups.map((g) => (
                    <DropdownMenuItem key={g.id} onSelect={() => onAdd(g, p.user)}>
                      <UsersRound /> <span className="truncate">{g.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GroupDialog({
  course,
  group,
  open,
  onOpenChange,
  onSaved,
}: {
  course: CourseDetail;
  group?: CourseGroup;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (created: CourseGroup | null) => Promise<unknown> | void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const save = useMutation({
    mutationFn: () =>
      group
        ? api.patch(`/courses/${course.id}/groups/${group.id}`, { name, description }).then(() => null)
        : api.post<CourseGroup>(`/courses/${course.id}/groups`, { name, description }),
    onSuccess: async (created) => {
      toast.success(group ? 'Group saved' : `Created ${name.trim()}`);
      onOpenChange(false);
      await onSaved(created);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<UsersRound className="size-5" />}
            title={group ? 'Edit group' : 'New group'}
            description={group ? undefined : 'You can add people as soon as it is created.'}
          />
          <DialogBody className="space-y-4">
            <Field label="Name">
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Team Aurora"
                />
              )}
            </Field>
            <Field label="Description" optional hint="Shown to the people in the group.">
              {(p) => <Textarea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
              {group ? 'Save' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddMembersDialog({
  group,
  participants,
  open,
  onOpenChange,
  onAdd,
  pending,
}: {
  group: CourseGroup;
  participants: Participant[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (userIds: string[]) => Promise<unknown>;
  pending: boolean;
}) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'student' | 'all'>('student');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const inGroup = new Set(group.members.map((m) => m.id));
  const candidates = participants.filter((p) => !inGroup.has(p.user.id) && (scope === 'all' || p.role === 'student'));
  const term = q.trim().toLowerCase();
  const shown = term
    ? candidates.filter((p) => p.user.name.toLowerCase().includes(term) || p.user.email?.toLowerCase().includes(term))
    : candidates;
  const allShown = shown.length > 0 && shown.every((p) => selected.has(p.user.id));
  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const chosen = [...selected].filter((id) => !inGroup.has(id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onAdd(chosen);
              onOpenChange(false);
            } catch {
              // The mutation shows the error; keep the dialog open to try again.
            }
          }}
        >
          <DialogHeader
            icon={<UserPlus className="size-5" />}
            title={`Add people to ${group.name}`}
            description="Only people enrolled in this course can join its groups. Someone can be in several groups."
          />
          <DialogBody className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchBox value={q} onChange={setQ} label="Search by name or email" className="flex-1" autoFocus />
              <Segmented
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'student', label: 'Students' },
                  { value: 'all', label: 'Everyone' },
                ]}
              />
            </div>
            {shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {candidates.length === 0 ? 'Everyone here is already in this group.' : 'No one matches your search.'}
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <label className="flex cursor-pointer items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <Checkbox
                    checked={allShown}
                    onCheckedChange={(v) =>
                      toggle(
                        shown.map((p) => p.user.id),
                        v === true,
                      )
                    }
                  />
                  Select all {shown.length}
                </label>
                <ul className="ck-scrollbar max-h-[45vh] divide-y overflow-y-auto">
                  {shown.map((p) => (
                    <li key={p.user.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40">
                        <Checkbox checked={selected.has(p.user.id)} onCheckedChange={(v) => toggle([p.user.id], v === true)} />
                        <Avatar user={p.user} size="xs" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{p.user.name}</span>
                          {p.user.email && <span className="block truncate text-xs text-muted-foreground">{p.user.email}</span>}
                        </span>
                        <GroupBadges groups={p.groups} className="hidden justify-end md:flex" />
                        {p.role !== 'student' && (
                          <Badge variant={p.role === 'teacher' ? 'violet' : 'info'}>{COURSE_ROLE_LABELS[p.role]}</Badge>
                        )}
                        {p.status === 'suspended' && <Badge variant="danger">Suspended</Badge>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={chosen.length === 0}>
              {chosen.length ? `Add ${people(chosen.length)}` : 'Add people'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AutoCreateDialog({
  course,
  data,
  participants,
  open,
  onOpenChange,
  onDone,
}: {
  course: CourseDetail;
  data: CourseGroups;
  participants: Participant[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => Promise<unknown>;
}) {
  const [split, setSplit] = useState<GroupSplit>('groups');
  const [size, setSize] = useState('3');
  const [naming, setNaming] = useState(DEFAULT_GROUP_NAMING);
  const [onlyUngrouped, setOnlyUngrouped] = useState(false);

  const students = participants.filter((p) => p.role === 'student' && p.status === 'active');
  const eligible = onlyUngrouped ? students.filter((p) => !p.groups?.length).length : students.length;
  const n = Number(size);
  const valid = size.trim() !== '' && Number.isInteger(n) && n >= 1;
  const count = valid && eligible ? groupCount(split, n, eligible) : 0;
  const problem = !eligible
    ? onlyUngrouped
      ? 'Every active student is already in a group.'
      : 'There are no active students to place yet.'
    : !valid
      ? 'Enter a whole number of 1 or more.'
      : split === 'groups' && n > eligible
        ? `There ${eligible === 1 ? 'is only 1 student' : `are only ${eligible} students`} to place, so make at most ${eligible}.`
        : count > MAX_AUTO_GROUPS
          ? `That would make ${count} groups. The most at once is ${MAX_AUTO_GROUPS}.`
          : !naming.trim()
            ? 'Enter a naming scheme.'
            : null;
  const preview = problem
    ? []
    : groupNames(
        naming.trim(),
        Math.min(count, 4),
        data.groups.map((g) => g.name),
      );
  const small = count ? Math.floor(eligible / count) : 0;
  const large = count ? Math.ceil(eligible / count) : 0;

  const create = useMutation({
    mutationFn: () => api.post<AutoCreated>(`/courses/${course.id}/groups/auto`, { split, size: n, naming: naming.trim(), onlyUngrouped }),
    onSuccess: async (res) => {
      toast.success(`Created ${plural(res.groups.length, 'group')}`);
      onOpenChange(false);
      await onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) create.mutate();
          }}
        >
          <DialogHeader
            icon={<Shuffle className="size-5" />}
            title="Auto-create groups"
            description="Shuffle the active students into new groups at random, with sizes as even as possible."
          />
          <DialogBody className="space-y-5">
            <ChoiceCards<GroupSplit>
              columns={2}
              value={split}
              onChange={setSplit}
              options={[
                {
                  value: 'groups',
                  label: 'Number of groups',
                  description: 'Split the class into this many groups.',
                  icon: <LayoutGrid className="size-4" />,
                },
                {
                  value: 'members',
                  label: 'Members per group',
                  description: 'Make groups of at most this many people.',
                  icon: <UsersRound className="size-4" />,
                },
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={split === 'groups' ? 'Number of groups' : 'Members per group'}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={split === 'groups' ? MAX_AUTO_GROUPS : 1000}
                    step={1}
                    required
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Naming scheme" hint="# becomes a number and @ a letter.">
                {(p) => <Input {...p} required maxLength={80} value={naming} onChange={(e) => setNaming(e.target.value)} />}
              </Field>
            </div>
            <SwitchField
              label="Only students without a group"
              description="Leave people who are already in a group where they are."
              checked={onlyUngrouped}
              onCheckedChange={setOnlyUngrouped}
            />
            <div
              role="status"
              aria-live="polite"
              className={cn(
                'rounded-lg border px-4 py-3 text-sm',
                problem ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-muted/40',
              )}
            >
              {problem ?? (
                <>
                  <p className="font-medium">
                    {plural(count, 'group')} of {small === large ? small : `${small} to ${large}`} from {plural(eligible, 'student')}
                  </p>
                  <p className="mt-0.5 truncate text-muted-foreground">
                    {preview.join(', ')}
                    {count > preview.length ? ', …' : ''}
                  </p>
                </>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!!problem}>
              <Shuffle /> {count && !problem ? `Create ${plural(count, 'group')}` : 'Create groups'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StaffGroups({ course, data }: { course: CourseDetail; data: CourseGroups }) {
  const manage = data.canManage;
  const refresh = useRefreshGroups(course);
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CourseGroup | 'new' | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const { data: participants } = useQuery({
    queryKey: ['participants', course.id],
    queryFn: () => api.get<Participant[]>(`/courses/${course.id}/participants`),
  });

  const addMembers = useMutation({
    mutationFn: ({ group, userIds }: { group: CourseGroup; userIds: string[] }) =>
      api.post<GroupMembersAdded>(`/courses/${course.id}/groups/${group.id}/members`, { userIds }),
    onSuccess: async (res, { group }) => {
      await refresh();
      if (res.added.length) toast.success(`Added ${people(res.added.length)} to ${group.name}`);
      if (res.alreadyMembers.length) toast.info(`${people(res.alreadyMembers.length)} already in ${group.name}`);
      if (res.notEnrolled.length) toast.warning(`${people(res.notEnrolled.length)} not enrolled in the course`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const removeMember = useMutation({
    mutationFn: ({ group, member }: { group: CourseGroup; member: GroupMember }) =>
      api.delete(`/courses/${course.id}/groups/${group.id}/members/${member.id}`),
    onSuccess: async (_res, { group, member }) => {
      await refresh();
      toast.success(`Removed ${member.name} from ${group.name}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const removeGroup = useMutation({
    mutationFn: (group: CourseGroup) => api.delete(`/courses/${course.id}/groups/${group.id}`),
    onSuccess: async (_res, group) => {
      await refresh();
      toast.success(`Deleted ${group.name}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const ungrouped = (participants ?? []).filter((p) => p.role === 'student' && p.status === 'active' && !p.groups?.length);
  const term = q.trim().toLowerCase();
  const shown = term
    ? data.groups.filter((g) => g.name.toLowerCase().includes(term) || g.members.some((m) => m.name.toLowerCase().includes(term)))
    : data.groups;
  const shownUngrouped = term ? ungrouped.filter((p) => p.user.name.toLowerCase().includes(term)) : ungrouped;
  const adding = data.groups.find((g) => g.id === addingTo) ?? null;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {data.groups.length > 0 && <SearchBox value={q} onChange={setQ} label="Search groups or people" className="sm:w-72" />}
        <p className="text-sm text-muted-foreground">
          {plural(data.groups.length, 'group')}
          {participants &&
            data.groups.length > 0 &&
            (ungrouped.length ? ` · ${plural(ungrouped.length, 'student')} without a group` : ' · every student is in a group')}
        </p>
        {manage && (
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="outline" className="flex-1 sm:flex-none" disabled={!participants} onClick={() => setAuto(true)}>
              <Shuffle /> Auto-create
            </Button>
            <Button className="flex-1 sm:flex-none" onClick={() => setEditing('new')}>
              <Plus /> New group
            </Button>
          </div>
        )}
      </div>

      {data.groups.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No groups yet"
          description={
            manage
              ? 'Groups organise students into teams, sections or study groups. Make them one at a time, or split the class automatically.'
              : 'No one has made any groups in this course yet.'
          }
          action={
            manage && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" disabled={!participants} onClick={() => setAuto(true)}>
                  <Shuffle /> Auto-create groups
                </Button>
                <Button onClick={() => setEditing('new')}>
                  <Plus /> New group
                </Button>
              </div>
            )
          }
        />
      ) : shown.length === 0 && shownUngrouped.length === 0 ? (
        <EmptyState icon={Search} title="Nothing matches your search" description="Try a group name or the name of someone in it." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              onAdd={manage ? () => setAddingTo(g.id) : undefined}
              onEdit={() => setEditing(g)}
              onDelete={async () => {
                if (
                  await confirm({
                    title: `Delete “${g.name}”?`,
                    description: 'The people in it stay in the course. Only the group is removed.',
                    confirmLabel: 'Delete group',
                    destructive: true,
                  })
                )
                  removeGroup.mutate(g);
              }}
              onRemove={manage ? (member) => removeMember.mutate({ group: g, member }) : undefined}
            />
          ))}
          {shownUngrouped.length > 0 && (
            <UngroupedCard
              people={shownUngrouped}
              groups={data.groups}
              onAdd={manage ? (group, user) => addMembers.mutate({ group: group, userIds: [user.id] }) : undefined}
            />
          )}
        </div>
      )}

      {editing && (
        <GroupDialog
          course={course}
          group={editing === 'new' ? undefined : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onSaved={async (created) => {
            await refresh();
            if (created) setAddingTo(created.id);
          }}
        />
      )}
      {adding && (
        <AddMembersDialog
          key={adding.id}
          group={adding}
          participants={participants ?? []}
          open={!!adding}
          onOpenChange={(o) => !o && setAddingTo(null)}
          pending={addMembers.isPending}
          onAdd={(userIds) => addMembers.mutateAsync({ group: adding, userIds })}
        />
      )}
      {auto && (
        <AutoCreateDialog
          course={course}
          data={data}
          participants={participants ?? []}
          open={auto}
          onOpenChange={setAuto}
          onDone={refresh}
        />
      )}
    </>
  );
}

function MyGroups({ data }: { data: CourseGroups }) {
  if (data.groups.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title="You're not in a group yet"
        description="When your teacher puts you in a group, it shows up here with the people in it."
      />
    );
  }
  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">Your groups</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">The groups you belong to in this course, and who else is in them.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data.groups.map((g) => (
          <GroupCard key={g.id} group={g} />
        ))}
      </div>
    </>
  );
}

export default function GroupsPage() {
  const { course } = useCourseContext();
  useTitle(`Groups · ${course.title}`);
  const { data, isLoading, error, refetch } = useCourseGroups(course.id);
  return (
    <Page>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : data.allGroups ? (
        <StaffGroups course={course} data={data} />
      ) : (
        <MyGroups data={data} />
      )}
    </Page>
  );
}
