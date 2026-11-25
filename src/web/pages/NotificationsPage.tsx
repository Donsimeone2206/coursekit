import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/common';
import { NotificationIcon, Page, useNotifications } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';

export default function NotificationsPage() {
  useTitle('Notifications');
  const { data, isLoading, error, refetch } = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const read = useMutation({
    mutationFn: (ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <Page size="narrow">
      <PageHeader
        title="Notifications"
        description="Grades, announcements and replies from your courses."
        actions={
          !!data?.unreadCount && (
            <Button variant="outline" onClick={() => read.mutate(undefined)} loading={read.isPending}>
              <CheckCheck /> Mark all as read
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-96" />
      ) : data!.items.length === 0 ? (
        <EmptyState icon={BellOff} title="No notifications" description="You'll see updates from your courses here." />
      ) : (
        <Card className="divide-y overflow-hidden">
          {data!.items.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                if (!n.readAt) read.mutate([n.id]);
                if (n.link) navigate(n.link);
              }}
              className={cn('flex w-full gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/40', !n.readAt && 'bg-primary/[0.03]')}
            >
              <NotificationIcon type={n.type} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm', !n.readAt && 'font-semibold')}>{n.title}</span>
                {n.body && <span className="mt-0.5 block text-sm text-muted-foreground">{n.body}</span>}
                <span className="mt-1 block text-xs text-muted-foreground" title={formatDateTime(n.createdAt)}>
                  {formatRelative(n.createdAt)}
                </span>
              </span>
              {!n.readAt && <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
            </button>
          ))}
        </Card>
      )}
    </Page>
  );
}
