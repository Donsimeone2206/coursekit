import { useMutation, useQuery } from '@tanstack/react-query';
import { Medal, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { BadgeDetail } from '@shared/completion';
import type { AdminUserRow, Paginated, Participant } from '@shared/types';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';

interface Candidate {
  id: string;
  name: string;
  avatarUrl: string | null;
  detail: string;
}

function useCandidates(badge: BadgeDetail, q: string) {
  const term = useDebounced(q.trim(), 250);
  const course = badge.course;
  const participants = useQuery({
    queryKey: ['participants', course?.id],
    queryFn: () => api.get<Participant[]>(`/courses/${course!.id}/participants`),
    enabled: !!course,
  });
  const users = useQuery({
    queryKey: ['admin', 'users', 'award', term],
    queryFn: () => api.get<Paginated<AdminUserRow>>(`/admin/users?${new URLSearchParams({ q: term, status: 'active', pageSize: '30' })}`),
    enabled: !course,
  });
  const candidates = useMemo<Candidate[]>(() => {
    if (course) {
      const lower = q.trim().toLowerCase();
      const order = { student: 0, assistant: 1, teacher: 2 } as const;
      return (participants.data ?? [])
        .filter((p) => p.status === 'active')
        .filter((p) => !lower || p.user.name.toLowerCase().includes(lower) || p.user.email?.toLowerCase().includes(lower))
        .sort((a, b) => order[a.role] - order[b.role] || a.user.name.localeCompare(b.user.name))
        .map((p) => ({
          id: p.user.id,
          name: p.user.name,
          avatarUrl: p.user.avatarUrl,
          detail: p.user.email ?? COURSE_ROLE_LABELS[p.role],
        }));
    }
    return (users.data?.items ?? []).map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl, detail: u.email }));
  }, [course, participants.data, users.data, q]);
  return { candidates, isLoading: course ? participants.isLoading : users.isLoading };
}

/** Choose people to receive a badge by hand. People who already have it are not listed. */
export function AwardBadgeDialog({
  badge,
  open,
  onOpenChange,
  onDone,
}: {
  badge: BadgeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const { candidates, isLoading } = useCandidates(badge, q);
  const holders = new Set((badge.recipients ?? []).filter((r) => !r.revokedAt).map((r) => r.user.id));
  const available = candidates.filter((c) => !holders.has(c.id));

  const award = useMutation({
    mutationFn: () =>
      api.post<{ awarded: number; alreadyAwarded: number }>(`/badges/${badge.id}/awards`, { userIds: selected, note: note.trim() || null }),
    onSuccess: (res) => {
      toast.success(
        res.awarded
          ? `Awarded “${badge.name}” to ${res.awarded} ${res.awarded === 1 ? 'person' : 'people'}`
          : 'They already have this badge',
      );
      setSelected([]);
      setNote('');
      onDone();
      onOpenChange(false);
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
            award.mutate();
          }}
        >
          <DialogHeader
            icon={<Medal className="size-5" />}
            title={`Award “${badge.name}”`}
            description={
              badge.course
                ? 'Choose participants of the course. They get a notification.'
                : 'Search for people on this site. They get a notification.'
            }
          />
          <DialogBody className="space-y-4">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={badge.course ? 'Find a participant' : 'Search by name or email'}
                className="pl-9"
                aria-label="Find people"
                autoFocus
              />
            </div>
            {isLoading ? (
              <Skeleton className="h-48" />
            ) : (
              <fieldset className="min-w-0">
                <legend className="sr-only">People</legend>
                <ul className="ck-scrollbar max-h-64 divide-y overflow-y-auto rounded-lg border">
                  {available.map((c) => {
                    const id = `award-${c.id}`;
                    const checked = selected.includes(c.id);
                    return (
                      <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(v) => setSelected((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                        />
                        <Avatar user={c} size="sm" />
                        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block truncate text-sm font-medium">{c.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{c.detail}</span>
                        </label>
                      </li>
                    );
                  })}
                  {available.length === 0 && (
                    <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {q.trim() ? 'Nobody matches your search.' : 'Everyone here already has this badge.'}
                    </li>
                  )}
                </ul>
              </fieldset>
            )}
            <Field label="Note" optional hint="Shown to the recipients on the badge, for example what they did.">
              {(p) => (
                <Textarea {...p} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-0" />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <span className="mr-auto self-center text-sm text-muted-foreground">{selected.length} selected</span>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={award.isPending} disabled={selected.length === 0}>
              Award badge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
