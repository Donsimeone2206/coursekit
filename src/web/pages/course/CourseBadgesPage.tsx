import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Medal, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { BadgeSummary } from '@shared/completion';
import { BadgeCard, BadgeGridSkeleton } from '@/components/completion/badge-card';
import { BadgeFormDialog } from '@/components/completion/badge-dialog';
import { Page } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { EmptyState, ErrorState } from '@/components/ui/misc';
import { achievementKeys } from '@/lib/achievements';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useCourseContext } from './context';

export default function CourseBadgesPage() {
  const { course, can } = useCourseContext();
  useTitle(`Badges · ${course.title}`);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const manage = can('badges:manage');
  const staff = manage || can('badges:award');
  const [editing, setEditing] = useState<BadgeSummary | 'new' | null>(null);
  const key = achievementKeys.courseBadges(course.slug);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<BadgeSummary[]>(`/courses/${course.id}/badges`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/badges/${id}`),
    onSuccess: async () => {
      toast.success('Badge deleted');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const earned = (data ?? []).filter((b) => b.earnedAt).length;

  return (
    <Page>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Course badges</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {staff
              ? 'Recognise great work. Award badges by hand or automatically when students complete the course.'
              : data?.length
                ? `You have earned ${earned} of ${data.length} badges in this course.`
                : 'Badges your teachers award for great work in this course.'}
          </p>
        </div>
        {manage && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> New badge
          </Button>
        )}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <BadgeGridSkeleton />
      ) : data.length === 0 ? (
        <EmptyState
          icon={Medal}
          title="No badges yet"
          description={
            manage
              ? 'Create a badge to celebrate milestones, great work or finishing the course.'
              : 'Your teachers haven’t created any badges yet.'
          }
          action={
            manage && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> Create a badge
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.map((badge) => (
            <BadgeCard
              key={badge.id}
              badge={badge}
              staff={staff}
              actions={
                manage && (
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
                )
              }
            />
          ))}
        </div>
      )}
      {editing && (
        <BadgeFormDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          scope={{ kind: 'course', courseId: course.id }}
          badge={editing === 'new' ? undefined : editing}
          onSaved={() => void refresh()}
        />
      )}
    </Page>
  );
}
