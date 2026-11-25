import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Announcement } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { Markdown, MarkdownEditor } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { useCourseContext } from './context';

export default function AnnouncementsPage() {
  const { course, can } = useCourseContext();
  useTitle(`Announcements · ${course.title}`);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const key = ['announcements', course.id];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Announcement[]>(`/courses/${course.id}/announcements`),
  });

  const post = useMutation({
    mutationFn: () => api.post<Announcement>(`/courses/${course.id}/announcements`, { title, body }),
    onSuccess: async () => {
      setTitle('');
      setBody('');
      toast.success('Announcement posted. Everyone in the course has been notified.');
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/courses/${course.id}/announcements/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <Page size="narrow">
      {can('announcement:post') && (
        <Card className="mb-8 p-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              post.mutate();
            }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Megaphone className="size-4 text-primary" /> New announcement
            </div>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" required aria-label="Announcement title" />
            <MarkdownEditor value={body} onChange={setBody} rows={4} placeholder="Write your message to the class…" />
            <div className="flex justify-end">
              <Button type="submit" loading={post.isPending} disabled={!title.trim() || !body.trim()}>
                <Send /> Post announcement
              </Button>
            </div>
          </form>
        </Card>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : data!.length === 0 ? (
        <EmptyState icon={Megaphone} title="No announcements yet" description="Course news from your teachers will show up here." />
      ) : (
        <ol className="relative space-y-6 border-l pl-6">
          {data!.map((a) => (
            <li key={a.id} className="relative">
              <span className="absolute top-5 -left-[31px] size-2.5 rounded-full bg-primary ring-4 ring-background" />
              <Card className="p-5">
                <div className="flex items-start gap-3">
                  <Avatar user={a.author} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{a.author.name}</p>
                    <p className="text-xs text-muted-foreground" title={formatDateTime(a.createdAt)}>
                      {formatRelative(a.createdAt)}
                    </p>
                  </div>
                  {can('announcement:post') && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete announcement"
                      onClick={async () => {
                        if (await confirm({ title: 'Delete this announcement?', confirmLabel: 'Delete', destructive: true }))
                          remove.mutate(a.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight">{a.title}</h2>
                <Markdown source={a.body} className="mt-2 prose-sm" />
              </Card>
            </li>
          ))}
        </ol>
      )}
    </Page>
  );
}
