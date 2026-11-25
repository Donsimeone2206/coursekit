import { useMutation, useQuery } from '@tanstack/react-query';
import { Lock, MessageCircle, MessagesSquare, Pin, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { ActivityDetail, Discussion, ForumSettings } from '@shared/types';
import { Markdown, MarkdownEditor } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { ActivityFrame } from './frame';

function NewDiscussionDialog({
  activity,
  open,
  onOpenChange,
}: {
  activity: ActivityDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const navigate = useNavigate();
  const invalidate = useInvalidateCourse();
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/activities/${activity.id}/discussions`, { title, body }),
    onSuccess: async (d) => {
      await invalidate(activity.course.slug);
      onOpenChange(false);
      navigate(`/courses/${activity.course.slug}/discussions/${d.id}`);
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
            create.mutate();
          }}
        >
          <DialogHeader
            icon={<MessagesSquare className="size-5" />}
            title="Start a discussion"
            description={`Post in ${activity.title}.`}
          />
          <DialogBody className="space-y-4">
            <Field label="Subject">
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's this about?"
                />
              )}
            </Field>
            <Field label="Message">{(p) => <MarkdownEditor id={p.id} value={body} onChange={setBody} rows={8} />}</Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!title.trim() || !body.trim()}>
              Post discussion
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ForumView({ activity }: { activity: ActivityDetail<'forum'> }) {
  const settings = activity.settings as ForumSettings;
  const [creating, setCreating] = useState(false);
  const canStart =
    activity.capabilities.includes('forum:post') &&
    (activity.capabilities.includes('forum:moderate') || settings.studentsCanStartDiscussions);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['discussions', activity.id],
    queryFn: () => api.get<Discussion[]>(`/activities/${activity.id}/discussions`),
  });

  return (
    <ActivityFrame
      activity={activity}
      actions={
        canStart && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New discussion
          </Button>
        )
      }
    >
      {activity.description && (
        <Card className="mb-6 p-5">
          <Markdown source={activity.description} className="prose-sm" />
        </Card>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : data!.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No discussions yet"
          description={canStart ? 'Be the first to start a conversation.' : 'Discussions started by your teachers will appear here.'}
          action={
            canStart && (
              <Button onClick={() => setCreating(true)}>
                <Plus /> Start a discussion
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {data!.map((d) => (
            <Link
              key={d.id}
              to={`/courses/${activity.course.slug}/discussions/${d.id}`}
              className="group flex gap-4 rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/30 hover:shadow-md"
            >
              <Avatar user={d.author} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold tracking-tight group-hover:text-primary">{d.title}</h3>
                  {d.pinned && (
                    <Badge variant="warning">
                      <Pin /> Pinned
                    </Badge>
                  )}
                  {d.locked && (
                    <Badge variant="neutral">
                      <Lock /> Locked
                    </Badge>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{d.excerpt}</p>
                <p className="mt-2.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{d.author.name}</span> · started {formatRelative(d.createdAt)}
                  {d.replyCount > 0 && ` · last reply ${formatRelative(d.lastPostAt)}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-center justify-center rounded-lg bg-muted/60 px-3 text-center">
                <MessageCircle className="size-4 text-muted-foreground" />
                <span className="mt-0.5 text-sm font-semibold tabular-nums">{d.replyCount}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <NewDiscussionDialog activity={activity} open={creating} onOpenChange={setCreating} />
    </ActivityFrame>
  );
}
