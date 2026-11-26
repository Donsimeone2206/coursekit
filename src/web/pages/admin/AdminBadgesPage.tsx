import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Medal, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { BadgeSummary } from '@shared/completion';
import { BadgeCard, BadgeGridSkeleton } from '@/components/completion/badge-card';
import { BadgeFormDialog } from '@/components/completion/badge-dialog';
import { OpenBadgesIssuerCard } from '@/components/open-badges/issuer-settings';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState } from '@/components/ui/misc';
import { achievementKeys } from '@/lib/achievements';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';

/** Site badges: made by administrators, awarded by hand or for completing a set of courses. */
export default function AdminBadgesPage() {
  useTitle('Site badges');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<BadgeSummary | 'new' | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: achievementKeys.siteBadges,
    queryFn: () => api.get<BadgeSummary[]>('/badges'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: achievementKeys.siteBadges });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/badges/${id}`),
    onSuccess: async () => {
      toast.success('Badge deleted');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Site badges recognise achievements across courses: award them by hand, or automatically when someone completes a set of courses.
          Teachers make course badges on each course’s Badges tab.
        </p>
        <Button onClick={() => setEditing('new')} className="shrink-0">
          <Plus /> New site badge
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <BadgeGridSkeleton />
      ) : data.length === 0 ? (
        <EmptyState
          icon={Medal}
          title="No site badges yet"
          description="Create one for community helpers, early adopters or people who finish a learning path."
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus /> Create a site badge
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.map((badge) => (
            <BadgeCard
              key={badge.id}
              badge={badge}
              staff
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${badge.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setEditing(badge)}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      destructive
                      onSelect={async () => {
                        if (
                          await confirm({
                            title: `Delete “${badge.name}”?`,
                            description: `It is taken away from ${badge.recipientCount ?? 0} ${badge.recipientCount === 1 ? 'person' : 'people'}. This cannot be undone.`,
                            confirmLabel: 'Delete badge',
                            destructive: true,
                          })
                        )
                          remove.mutate(badge.id);
                      }}
                    >
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
        </div>
      )}
      <OpenBadgesIssuerCard />
      {editing && (
        <BadgeFormDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          scope={{ kind: 'site' }}
          badge={editing === 'new' ? undefined : editing}
          onSaved={() => void refresh()}
        />
      )}
    </>
  );
}
