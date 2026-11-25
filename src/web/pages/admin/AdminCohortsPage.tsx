import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Contact,
  Link2,
  Link2Off,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type {
  AdminCourseRow,
  CohortCandidate,
  CohortDetail,
  CohortLink,
  CohortMember,
  CohortMembersAdded,
  CohortSummary,
  CourseRole,
  Paginated,
} from '@shared/types';
import { LINK_EXPLAINER, RoleSelect } from '@/components/cohorts';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useDebounced, useTitle } from '@/lib/hooks';
import { cn, formatRelative, plural } from '@/lib/utils';

const PAGE_SIZE = 20;
const MAX_PASTE = 1000;

const people = (n: number) => plural(n, 'person', 'people');
const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]]))).toString();

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

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft />
      </Button>
      <span className="tabular-nums">
        {page} / {pages}
      </span>
      <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight />
      </Button>
    </div>
  );
}

/** Refreshes everything that shows cohorts, their members or the enrolments they made. */
function useRefreshCohorts() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin', 'cohorts'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'cohort'] }),
      qc.invalidateQueries({ queryKey: ['cohort-links'] }),
      qc.invalidateQueries({ queryKey: ['participants'] }),
    ]);
}

function CohortDialog({
  cohort,
  open,
  onOpenChange,
  onSaved,
}: {
  cohort?: Pick<CohortSummary, 'id' | 'name' | 'description'>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (saved: CohortDetail) => Promise<unknown> | void;
}) {
  const [name, setName] = useState(cohort?.name ?? '');
  const [description, setDescription] = useState(cohort?.description ?? '');
  const save = useMutation({
    mutationFn: () =>
      cohort
        ? api.patch<CohortDetail>(`/admin/cohorts/${cohort.id}`, { name, description })
        : api.post<CohortDetail>('/admin/cohorts', { name, description }),
    onSuccess: async (saved) => {
      toast.success(cohort ? 'Cohort saved' : `Created ${saved.name}`);
      onOpenChange(false);
      await onSaved(saved);
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
            icon={<Contact className="size-5" />}
            title={cohort ? 'Edit cohort' : 'New cohort'}
            description={
              cohort
                ? undefined
                : 'A site-wide group of people, such as a year group or a department. Link it to courses to enrol everyone in it.'
            }
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
                  placeholder="Class of 2027"
                />
              )}
            </Field>
            <Field label="Description" optional>
              {(p) => <Textarea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
              {cohort ? 'Save' : 'Create cohort'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminCohortsPage() {
  useTitle('Cohorts');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const refresh = useRefreshCohorts();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CohortSummary | 'new' | null>(null);
  const debounced = useDebounced(q.trim(), 300);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'cohorts', debounced, page],
    queryFn: () => api.get<Paginated<CohortSummary>>(`/admin/cohorts?${query({ q: debounced, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (cohort: CohortSummary) => api.delete(`/admin/cohorts/${cohort.id}`),
    onSuccess: async (_res, cohort) => {
      await refresh();
      toast.success(`Deleted ${cohort.name}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          label="Search cohorts"
          className="sm:w-80"
        />
        <p className="hidden text-sm text-muted-foreground lg:block">
          Site-wide groups of people. Link one to a course to enrol everyone in it.
        </p>
        <Button className="sm:ml-auto" onClick={() => setEditing('new')}>
          <Plus /> New cohort
        </Button>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-64" />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={Contact}
          title={debounced ? 'No cohorts found' : 'No cohorts yet'}
          description={
            debounced
              ? 'Try another name.'
              : 'Cohorts are site-wide groups of people, such as a year group or a department. Link a cohort to a course to enrol all its members, including people who join later.'
          }
          action={
            !debounced && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> New cohort
              </Button>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {data.items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary" aria-hidden>
                  <Contact className="size-4.5" />
                </span>
                <Link to={`/admin/cohorts/${c.id}`} className="group min-w-0 flex-1">
                  <span className="block truncate font-medium group-hover:text-primary">{c.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">{c.description || 'No description'}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground sm:hidden">
                    {plural(c.memberCount, 'member')} · {c.courseCount ? `linked to ${plural(c.courseCount, 'course')}` : 'not linked'}
                  </span>
                </Link>
                <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                  <Badge variant="neutral">{plural(c.memberCount, 'member')}</Badge>
                  <Badge variant={c.courseCount ? 'info' : 'outline'}>
                    {c.courseCount ? `Linked to ${plural(c.courseCount, 'course')}` : 'Not linked'}
                  </Badge>
                </span>
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${c.name}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete “${c.name}”?`,
                        description: 'The cohort and its course links are removed. Everyone it enrolled stays enrolled in those courses.',
                        confirmLabel: 'Delete cohort',
                        destructive: true,
                      })
                    )
                      remove.mutate(c);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t px-5 py-3 text-sm text-muted-foreground">
            <span>{plural(data.total, 'cohort')}</span>
            <Pager page={page} pages={pages} onPage={setPage} />
          </div>
        </Card>
      )}

      {editing && (
        <CohortDialog
          cohort={editing === 'new' ? undefined : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onSaved={async (saved) => {
            await refresh();
            if (editing === 'new') navigate(`/admin/cohorts/${saved.id}`);
          }}
        />
      )}
    </>
  );
}

function reportAdded(res: CohortMembersAdded, cohortName: string) {
  if (res.added) {
    toast.success(`Added ${people(res.added)} to ${cohortName}`, {
      description: res.enrolled ? `${plural(res.enrolled, 'new course enrolment')} through linked courses.` : undefined,
    });
  } else {
    toast.info('No one new was added');
  }
}

function AddPeopleDialog({
  cohort,
  open,
  onOpenChange,
  onAdded,
}: {
  cohort: CohortDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => Promise<unknown>;
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const [selected, setSelected] = useState<Map<string, CohortCandidate>>(() => new Map());
  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'cohort', cohort.id, 'candidates', debounced],
    queryFn: () => api.get<CohortCandidate[]>(`/admin/cohorts/${cohort.id}/candidates?${query({ q: debounced })}`),
    enabled: open && debounced.length > 0,
    placeholderData: keepPreviousData,
  });
  const toggle = (user: CohortCandidate, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(user.id, user);
      else next.delete(user.id);
      return next;
    });
  const add = useMutation({
    mutationFn: () => api.post<CohortMembersAdded>(`/admin/cohorts/${cohort.id}/members`, { userIds: [...selected.keys()] }),
    onSuccess: async (res) => {
      reportAdded(res, cohort.name);
      setSelected(new Map());
      setQ('');
      onOpenChange(false);
      await onAdded();
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
            if (selected.size) add.mutate();
          }}
        >
          <DialogHeader
            icon={<UserPlus className="size-5" />}
            title={`Add people to ${cohort.name}`}
            description={
              cohort.courseCount
                ? `They are also enrolled in the ${plural(cohort.courseCount, 'course')} this cohort is linked to.`
                : 'Search for people by name or email.'
            }
          />
          <DialogBody className="space-y-3">
            <SearchBox value={q} onChange={setQ} label="Search by name or email" autoFocus />
            {selected.size > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Selected people">
                {[...selected.values()].map((u) => (
                  <li
                    key={u.id}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary"
                  >
                    {u.name}
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-primary/15"
                      aria-label={`Unselect ${u.name}`}
                      onClick={() => toggle(u, false)}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!debounced ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Start typing a name or email address.</p>
            ) : !data ? (
              <div className="grid place-items-center py-8">
                <Spinner />
              </div>
            ) : data.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No one matches “{debounced}”.</p>
            ) : (
              <ul className={cn('divide-y overflow-hidden rounded-lg border transition-opacity', isFetching && 'opacity-70')}>
                {data.map((u) => (
                  <li key={u.id}>
                    <label
                      className={cn('flex items-center gap-3 px-3 py-2', u.member ? 'opacity-60' : 'cursor-pointer hover:bg-accent/40')}
                    >
                      <Checkbox
                        disabled={u.member}
                        checked={u.member || selected.has(u.id)}
                        onCheckedChange={(v) => toggle(u, v === true)}
                      />
                      <Avatar user={u} size="xs" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{u.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                      </span>
                      {u.member && <Badge variant="neutral">Member</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {data?.length === 20 && (
              <p className="text-xs text-muted-foreground">Showing the first 20 matches. Type more to narrow them down.</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={add.isPending} disabled={selected.size === 0}>
              {selected.size ? `Add ${people(selected.size)}` : 'Add people'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResultList({ title, items, hint }: { title: string; items: string[]; hint?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium text-amber-800 dark:text-amber-300">
        {title} ({items.length})
      </p>
      {hint && <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">{hint}</p>}
      <ul className="ck-scrollbar mt-2 max-h-36 space-y-0.5 overflow-y-auto font-mono text-xs break-all">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function AddByEmailDialog({
  cohort,
  open,
  onOpenChange,
  onAdded,
}: {
  cohort: CohortDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<CohortMembersAdded | null>(null);
  const entries = text.split(/[\s,;]+/).filter(Boolean);
  const add = useMutation({
    mutationFn: () => api.post<CohortMembersAdded>(`/admin/cohorts/${cohort.id}/members`, { emails: entries }),
    onSuccess: async (res) => {
      setResult(res);
      reportAdded(res, cohort.name);
      await onAdded();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setResult(null);
      setText('');
    }
  };
  const failed = result ? [...result.notFound, ...result.invalid] : [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader
              icon={<Check className="size-5" />}
              title={result.added ? `Added ${people(result.added)}` : 'No one new was added'}
              description={
                result.enrolled
                  ? `That made ${plural(result.enrolled, 'new course enrolment')} through the cohort's linked courses.`
                  : undefined
              }
            />
            <DialogBody className="space-y-3">
              <ResultList title="No account found" items={result.notFound} hint="Create their accounts under Users, then add them again." />
              <ResultList title="Not email addresses" items={result.invalid} />
              {result.alreadyMembers.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {people(result.alreadyMembers.length)} on the list were already in the cohort.
                </p>
              )}
              {failed.length === 0 && result.alreadyMembers.length === 0 && (
                <p className="text-sm text-muted-foreground">Everyone on the list was added.</p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setText(failed.join('\n'));
                  setResult(null);
                }}
              >
                {failed.length ? 'Fix the rest' : 'Add more'}
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (entries.length && entries.length <= MAX_PASTE) add.mutate();
            }}
          >
            <DialogHeader
              icon={<ClipboardPaste className="size-5" />}
              title="Add people by email"
              description="Paste email addresses, for example a column from a spreadsheet. Each person needs an account on this site."
            />
            <DialogBody>
              <Field
                label="Email addresses"
                hint={
                  entries.length > MAX_PASTE
                    ? `That's ${entries.length} entries. Add up to ${MAX_PASTE} at a time.`
                    : `${plural(entries.length, 'entry', 'entries')}. Separate them with commas, spaces or new lines.`
                }
                error={entries.length > MAX_PASTE ? `Add up to ${MAX_PASTE} at a time.` : null}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    rows={8}
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={'ada@school.edu\ngrace@school.edu'}
                    className="font-mono text-[13px]"
                  />
                )}
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={add.isPending} disabled={entries.length === 0 || entries.length > MAX_PASTE}>
                {entries.length ? `Add ${people(entries.length)}` : 'Add people'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MembersCard({ cohort, onChanged }: { cohort: CohortDetail; onChanged: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [pasting, setPasting] = useState(false);
  const debounced = useDebounced(q.trim(), 300);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'cohort', cohort.id, 'members', debounced, page],
    queryFn: () =>
      api.get<Paginated<CohortMember>>(`/admin/cohorts/${cohort.id}/members?${query({ q: debounced, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (member: CohortMember) => api.delete(`/admin/cohorts/${cohort.id}/members/${member.id}`),
    onSuccess: async (_res, member) => {
      await onChanged();
      toast.success(`Removed ${member.name} from ${cohort.name}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-tight">Members</h3>
          <p className="text-sm text-muted-foreground">{people(cohort.memberCount)}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => setPasting(true)}>
            <ClipboardPaste /> Add by email
          </Button>
          <Button size="sm" className="flex-1 sm:flex-none" onClick={() => setSearching(true)}>
            <UserPlus /> Add people
          </Button>
        </div>
      </div>
      {(cohort.memberCount > 0 || debounced) && (
        <div className="border-b p-3">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            label="Search members"
          />
        </div>
      )}
      {error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : isLoading || !data ? (
        <div className="p-4">
          <Skeleton className="h-48" />
        </div>
      ) : data.items.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={UsersRound}
            className="border-none"
            title={debounced ? 'No members match your search' : 'No one in this cohort yet'}
            description={debounced ? undefined : 'Add people one at a time, or paste a list of email addresses.'}
          />
        </div>
      ) : (
        <ul className="divide-y" aria-label={`Members of ${cohort.name}`}>
          {data.items.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar user={m} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.name}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              {m.status === 'suspended' && <Badge variant="danger">Suspended</Badge>}
              <span className="hidden shrink-0 text-xs text-muted-foreground md:block">Added {formatRelative(m.addedAt)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${m.name} from the cohort`}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Remove ${m.name} from ${cohort.name}?`,
                      description: cohort.courseCount
                        ? 'They stay enrolled in the courses the cohort is linked to.'
                        : 'They can be added back at any time.',
                      confirmLabel: 'Remove',
                      destructive: true,
                    })
                  )
                    remove.mutate(m);
                }}
              >
                <UserMinus />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <div className="flex items-center justify-end border-t px-4 py-3 text-sm text-muted-foreground">
          <Pager page={page} pages={pages} onPage={setPage} />
        </div>
      )}
      <AddPeopleDialog cohort={cohort} open={searching} onOpenChange={setSearching} onAdded={onChanged} />
      <AddByEmailDialog cohort={cohort} open={pasting} onOpenChange={setPasting} onAdded={onChanged} />
    </Card>
  );
}

function LinkCourseDialog({
  cohort,
  open,
  onOpenChange,
  onLinked,
}: {
  cohort: CohortDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onLinked: () => Promise<unknown>;
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const [courseId, setCourseId] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'courses', debounced, 1, 'cohort-link'],
    queryFn: () => api.get<Paginated<AdminCourseRow>>(`/admin/courses?${query({ q: debounced, pageSize: 8 })}`),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const linked = new Set(cohort.links.map((l) => l.course.id));
  const chosen = data?.items.find((c) => c.id === courseId) ?? null;
  const link = useMutation({
    mutationFn: () => api.post<{ link: CohortLink; enrolled: number }>(`/courses/${courseId}/cohorts`, { cohortId: cohort.id, role }),
    onSuccess: async (res) => {
      toast.success(`Linked to ${res.link.course.title}`, {
        description: res.enrolled ? `Enrolled ${people(res.enrolled)}.` : 'Everyone in the cohort was already enrolled.',
      });
      onOpenChange(false);
      setCourseId('');
      await onLinked();
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
          <DialogHeader icon={<Link2 className="size-5" />} title={`Link ${cohort.name} to a course`} description={LINK_EXPLAINER} />
          <DialogBody className="space-y-4">
            <SearchBox value={q} onChange={setQ} label="Search courses" autoFocus />
            <div
              role="radiogroup"
              aria-label="Course"
              className={cn('divide-y overflow-hidden rounded-lg border', isFetching && 'opacity-70')}
            >
              {!data ? (
                <div className="grid place-items-center py-6">
                  <Spinner />
                </div>
              ) : data.items.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">No courses match your search.</p>
              ) : (
                data.items.map((c) => {
                  const isLinked = linked.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5',
                        isLinked ? 'opacity-60' : 'cursor-pointer hover:bg-accent/40',
                        c.id === courseId && 'bg-primary/[0.06]',
                      )}
                    >
                      <input
                        type="radio"
                        name="course"
                        value={c.id}
                        disabled={isLinked}
                        checked={c.id === courseId}
                        onChange={() => setCourseId(c.id)}
                        className="size-4 accent-[var(--primary)]"
                      />
                      <span className="size-6 shrink-0 rounded-md" style={coverDot(c.coverColor)} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span>
                      {isLinked ? (
                        <Badge variant="info">Linked</Badge>
                      ) : (
                        c.visibility !== 'published' && (
                          <Badge variant="neutral" className="capitalize">
                            {c.visibility}
                          </Badge>
                        )
                      )}
                    </label>
                  );
                })
              )}
            </div>
            <Field label="Enrol members as">{(p) => <RoleSelect {...p} value={role} onChange={setRole} />}</Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={link.isPending} disabled={!chosen}>
              {chosen ? `Link and enrol ${people(cohort.memberCount)}` : 'Link to course'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinksCard({ cohort, onChanged }: { cohort: CohortDetail; onChanged: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [linking, setLinking] = useState(false);
  const unlink = useMutation({
    mutationFn: (link: CohortLink) => api.delete(`/courses/${link.course.id}/cohorts/${link.id}`),
    onSuccess: async (_res, link) => {
      await onChanged();
      toast.success(`Unlinked from ${link.course.title}. Everyone stays enrolled.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader title="Linked courses" description="Members are enrolled in these courses, including people added later." />
      {cohort.links.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-muted-foreground">Not linked to any course yet.</p>
      ) : (
        <ul className="divide-y border-y" aria-label="Linked courses">
          {cohort.links.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-5 py-3">
              <span className="size-8 shrink-0 rounded-lg" style={coverDot(l.course.coverColor)} aria-hidden />
              <div className="min-w-0 flex-1">
                <Link to={`/courses/${l.course.slug}/participants`} className="block truncate text-sm font-medium hover:text-primary">
                  {l.course.title}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  As {COURSE_ROLE_LABELS[l.role].toLowerCase()}s · linked {formatRelative(l.createdAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Unlink from ${l.course.title}`}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Unlink from ${l.course.title}?`,
                      description:
                        'Everyone the cohort enrolled stays enrolled. People added to the cohort later are no longer enrolled in this course.',
                      confirmLabel: 'Unlink',
                      destructive: true,
                    })
                  )
                    unlink.mutate(l);
                }}
              >
                <Link2Off />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="p-3">
        <Button variant="outline" className="w-full" onClick={() => setLinking(true)}>
          <Link2 /> Link to a course
        </Button>
      </div>
      <LinkCourseDialog cohort={cohort} open={linking} onOpenChange={setLinking} onLinked={onChanged} />
    </Card>
  );
}

export function AdminCohortPage() {
  const { cohortId } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const refresh = useRefreshCohorts();
  const [editing, setEditing] = useState(false);
  const {
    data: cohort,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'cohort', cohortId],
    queryFn: () => api.get<CohortDetail>(`/admin/cohorts/${cohortId}`),
    enabled: !!cohortId,
  });
  useTitle(cohort ? `${cohort.name} · Cohorts` : 'Cohort');
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/cohorts/${cohortId}`),
    onSuccess: async () => {
      toast.success(`Deleted ${cohort?.name ?? 'the cohort'}`);
      navigate('/admin/cohorts');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const back = (
    <Link to="/admin/cohorts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> All cohorts
    </Link>
  );
  if (error instanceof ApiError && error.status === 404) {
    return (
      <>
        {back}
        <EmptyState className="mt-4" icon={Contact} title="Cohort not found" description="It may have been deleted." />
      </>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !cohort) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <>
      {back}
      <div className="mt-3 mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-balance">{cohort.name}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{cohort.description || 'No description'}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="outline"
            className="text-destructive hover:bg-destructive/10"
            loading={remove.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete “${cohort.name}”?`,
                  description: 'The cohort and its course links are removed. Everyone it enrolled stays enrolled in those courses.',
                  confirmLabel: 'Delete cohort',
                  destructive: true,
                })
              )
                remove.mutate();
            }}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <MembersCard cohort={cohort} onChanged={refresh} />
        <LinksCard cohort={cohort} onChanged={refresh} />
      </div>
      {editing && <CohortDialog cohort={cohort} open={editing} onOpenChange={setEditing} onSaved={refresh} />}
    </>
  );
}
