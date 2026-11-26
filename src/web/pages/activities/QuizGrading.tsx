import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ActivityDetail, QuizGradingItem } from '@shared/types';
import { GroupPicker } from '@/components/group-modes';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatRelative, plural } from '@/lib/utils';

/** Students' attempts whose essays wait for a mark (staff). */
export function NeedsGradingCard({ activity }: { activity: ActivityDetail<'quiz'> }) {
  const [groupId, setGroupId] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['grading', activity.id, groupId],
    queryFn: () =>
      api.get<QuizGradingItem[]>(`/activities/${activity.id}/grading${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`),
    placeholderData: (previous) => previous,
  });
  return (
    <Card className="border-amber-500/30">
      <CardHeader
        title="Needs grading"
        description="Attempts with written answers waiting for a mark, oldest first."
        icon={<ClipboardCheck className="size-4.5" />}
        action={data && <Badge variant="warning">{data.length}</Badge>}
      />
      {activity.groups && activity.groups.groups.length > 0 && (
        <div className="px-5 pb-3">
          <GroupPicker choice={activity.groups} value={groupId} onChange={setGroupId} className="sm:w-full" />
        </div>
      )}
      {error ? (
        <div className="px-5 pb-5">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : isLoading || !data ? (
        <div className="space-y-2 px-5 pb-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : data.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">Everything is marked.</p>
      ) : (
        <div className="divide-y border-t">
          {data.slice(0, 50).map((g) => (
            <div key={g.attemptId} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <Avatar user={g.user} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{g.user.name}</span>
                <span className="block text-xs text-muted-foreground">
                  Attempt {g.attemptNumber} · handed in {formatRelative(g.finishedAt)} · {plural(g.pending, 'answer')} to mark
                </span>
              </span>
              <Button asChild size="sm" variant="outline">
                <Link
                  to={`/courses/${activity.course.slug}/attempts/${g.attemptId}`}
                  aria-label={`Mark ${g.user.name}'s attempt ${g.attemptNumber}`}
                >
                  Mark
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
