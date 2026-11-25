import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Medal, Plus } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { BadgeSummary } from '@shared/completion';
import type { CourseDetail, Participant } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/misc';
import { achievementKeys, badgeCriteriaLabel } from '@/lib/achievements';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { BadgeArt } from './badge-art';

// The participants menu closes (and unmounts) before a dialog could open from it, so the person
// whose badges are open lives in this tiny store and the dialog is rendered once per page.
let target: Participant | null = null;
const listeners = new Set<() => void>();
const store = {
  set(p: Participant | null) {
    target = p;
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => target,
};

/** "Badges…" in a participant's actions menu. */
export function ParticipantBadgesMenuItem({ course, participant }: { course: CourseDetail; participant: Participant }) {
  if (!course.capabilities.includes('badges:award')) return null;
  return (
    <DropdownMenuItem onSelect={() => store.set(participant)}>
      <Medal /> Badges…
    </DropdownMenuItem>
  );
}

function BadgeRow({ badge, course, participant }: { badge: BadgeSummary; course: CourseDetail; participant: Participant }) {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['course', course.slug, 'badges'] }),
      qc.invalidateQueries({ queryKey: achievementKeys.badge(badge.id) }),
    ]);
  const toggle = useMutation({
    mutationFn: () =>
      badge.earnedAt
        ? api.delete(`/badges/${badge.id}/awards/${participant.user.id}`)
        : api.post(`/badges/${badge.id}/awards`, { userIds: [participant.user.id] }),
    onSuccess: async () => {
      toast.success(
        badge.earnedAt ? `Revoked “${badge.name}” from ${participant.user.name}` : `Awarded “${badge.name}” to ${participant.user.name}`,
      );
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <li className="flex items-center gap-3 py-3">
      <BadgeArt icon={badge.icon} color={badge.color} size={40} locked={!badge.earnedAt} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{badge.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {badge.earnedAt ? `Awarded ${formatDate(badge.earnedAt, { year: 'numeric' })}` : badgeCriteriaLabel(badge)}
        </p>
      </div>
      <Button
        size="sm"
        variant={badge.earnedAt ? 'ghost' : 'outline'}
        className={badge.earnedAt ? 'text-destructive hover:bg-destructive/10' : undefined}
        loading={toggle.isPending}
        onClick={() => toggle.mutate()}
        aria-label={`${badge.earnedAt ? 'Revoke' : 'Award'} ${badge.name}`}
      >
        {badge.earnedAt ? 'Revoke' : 'Award'}
      </Button>
    </li>
  );
}

function Content({ course, participant }: { course: CourseDetail; participant: Participant }) {
  const { data, isLoading } = useQuery({
    queryKey: ['course', course.slug, 'badges', 'for', participant.user.id],
    queryFn: () => api.get<BadgeSummary[]>(`/courses/${course.id}/badges?for=${participant.user.id}`),
  });
  if (isLoading || !data) return <Skeleton className="h-32" />;
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        This course has no badges yet.
        {course.capabilities.includes('badges:manage') && (
          <Button asChild size="sm" className="mt-3 flex w-fit mx-auto">
            <Link to={`/courses/${course.slug}/badges`} onClick={() => store.set(null)}>
              <Plus /> Create a badge
            </Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <ul className="divide-y">
      {data.map((b) => (
        <BadgeRow key={b.id} badge={b} course={course} participant={participant} />
      ))}
    </ul>
  );
}

/** Render once on the participants page; opens for whoever was picked from a menu. */
export function ParticipantBadgesDialog({ course }: { course: CourseDetail }) {
  const participant = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => () => store.set(null), []);
  return (
    <Dialog open={!!participant} onOpenChange={(o) => !o && store.set(null)}>
      {participant && (
        <DialogContent>
          <DialogHeader
            icon={<Medal className="size-5" />}
            title={`Badges for ${participant.user.name}`}
            description="Award or revoke this course’s badges. They get a notification when they receive one."
          />
          <DialogBody>
            <Content course={course} participant={participant} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => store.set(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
