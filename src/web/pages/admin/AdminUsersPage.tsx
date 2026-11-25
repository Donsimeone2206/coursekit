import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ChevronLeft, ChevronRight, Copy, LogIn, MoreHorizontal, Search, Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SITE_ROLE_LABELS } from '@shared/permissions';
import type { AdminUserRow, Paginated, SiteRole, User } from '@shared/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { EmptyState, ErrorState, Segmented, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useDebounced, useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { formatRelative } from '@/lib/utils';

const ROLE_VARIANT: Record<SiteRole, 'violet' | 'info' | 'neutral'> = { admin: 'violet', instructor: 'info', student: 'neutral' };
const PAGE_SIZE = 20;

function AddUserDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'student' as SiteRole, password: '' });
  const [temp, setTemp] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: User; temporaryPassword: string | null }>('/admin/users', { ...form, password: form.password || undefined }),
    onSuccess: (res) => {
      onDone();
      if (res.temporaryPassword) setTemp(res.temporaryPassword);
      else {
        toast.success(`Created ${res.user.name}`);
        onOpenChange(false);
      }
      setForm({ name: '', email: '', role: 'student', password: '' });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTemp(null);
      }}
    >
      <DialogContent>
        {temp ? (
          <>
            <DialogHeader
              icon={<Check className="size-5" />}
              title="Account created"
              description="Share this temporary password securely. It won't be shown again."
            />
            <DialogBody>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-3 font-mono text-sm">
                <span className="flex-1 break-all">{temp}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy password"
                  onClick={() => {
                    void navigator.clipboard.writeText(temp);
                    toast.success('Copied');
                  }}
                >
                  <Copy />
                </Button>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader icon={<UserPlus className="size-5" />} title="Add a person" />
            <DialogBody className="space-y-4">
              <Field label="Full name">
                {(p) => <Input {...p} autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
              </Field>
              <Field label="Email">
                {(p) => (
                  <Input {...p} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                )}
              </Field>
              <Field label="Site role" hint="Instructors can create courses. Administrators manage the whole site.">
                {(p) => (
                  <Select {...p} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as SiteRole })}>
                    <option value="student">Student</option>
                    <option value="instructor">Instructor</option>
                    <option value="admin">Administrator</option>
                  </Select>
                )}
              </Field>
              <Field label="Password" optional hint="Leave empty to generate a temporary password.">
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                )}
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create account
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AdminUsersPage() {
  useTitle('Users');
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [role, setRole] = useState<'' | SiteRole>('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(q.trim(), 300);

  const key = ['admin', 'users', debounced, role, page];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<Paginated<AdminUserRow>>(
        `/admin/users?${new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(role ? { role } : {}), page: String(page), pageSize: String(PAGE_SIZE) })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/admin/users/${id}`, body),
    onSuccess: async () => {
      await refresh();
      toast.success('User updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: async () => {
      await refresh();
      toast.success('User deleted');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const impersonate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/impersonate`),
    onSuccess: async () => {
      qc.clear();
      navigate('/');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name or email"
            className="pl-9"
            aria-label="Search users"
          />
        </div>
        <Segmented
          value={role}
          onChange={(r) => {
            setRole(r);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Everyone' },
            { value: 'student', label: 'Students' },
            { value: 'instructor', label: 'Instructors' },
            { value: 'admin', label: 'Admins' },
          ]}
        />
        <Button className="sm:ml-auto" onClick={() => setAdding(true)}>
          <UserPlus /> Add person
        </Button>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Users} title="No people found" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Person</th>
                  <th className="px-3 py-3 font-medium">Role</th>
                  <th className="hidden px-3 py-3 font-medium md:table-cell">Courses</th>
                  <th className="hidden px-3 py-3 font-medium lg:table-cell">Last sign-in</th>
                  <th className="w-12 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map((u) => (
                  <tr key={u.id} className="hover:bg-accent/30">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar user={u} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {u.name}
                            {u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={ROLE_VARIANT[u.role]}>{SITE_ROLE_LABELS[u.role]}</Badge>
                        {u.status === 'suspended' && <Badge variant="danger">Suspended</Badge>}
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground tabular-nums md:table-cell">{u.courseCount}</td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">
                      {u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {u.id !== me?.id && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent className="w-56">
                            {u.role !== 'admin' && u.status === 'active' && (
                              <>
                                <DropdownMenuItem onSelect={() => impersonate.mutate(u.id)}>
                                  <LogIn /> Log in as {u.name.split(' ')[0]}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}
                            <DropdownMenuLabel>Site role</DropdownMenuLabel>
                            {(['student', 'instructor', 'admin'] as const).map((r) => (
                              <DropdownMenuCheckItem
                                key={r}
                                checked={u.role === r}
                                onSelect={() => update.mutate({ id: u.id, body: { role: r } })}
                              >
                                {SITE_ROLE_LABELS[r]}
                              </DropdownMenuCheckItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => update.mutate({ id: u.id, body: { status: u.status === 'active' ? 'suspended' : 'active' } })}
                            >
                              {u.status === 'active' ? <Ban /> : <Check />}
                              {u.status === 'active' ? 'Suspend account' : 'Reactivate account'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              destructive
                              onSelect={async () => {
                                if (
                                  await confirm({
                                    title: `Delete ${u.name}?`,
                                    description: 'Their account, enrolments, submissions, grades and posts are permanently deleted.',
                                    confirmLabel: 'Delete account',
                                    destructive: true,
                                  })
                                )
                                  remove.mutate(u.id);
                              }}
                            >
                              <Trash2 /> Delete account
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-5 py-3 text-sm text-muted-foreground">
            <span>
              {data.total} {data.total === 1 ? 'person' : 'people'}
            </span>
            {pages > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <span className="tabular-nums">
                  {page} / {pages}
                </span>
                <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      <AddUserDialog open={adding} onOpenChange={setAdding} onDone={refresh} />
    </>
  );
}
