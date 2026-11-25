import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, LockOpen, MoreHorizontal, Pencil, Pin, PinOff, Reply, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { COURSE_ROLE_LABELS } from '@shared/permissions';
import type { DiscussionDetail, Post } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { Markdown, MarkdownEditor } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { ApiError, api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useTitle } from '@/lib/hooks';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';

function Composer({
  onSubmit,
  onCancel,
  initial = '',
  submitLabel = 'Reply',
  autoFocus,
}: {
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  initial?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(body);
          setBody('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <MarkdownEditor value={body} onChange={setBody} rows={4} autoFocus={autoFocus} placeholder="Write a reply…" />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function PostItem({
  post,
  childrenOf,
  depth,
  discussion,
  onReply,
  onEdit,
  onDelete,
}: {
  post: Post;
  childrenOf: Map<string, Post[]>;
  depth: number;
  discussion: DiscussionDetail;
  onReply: (parentId: string, body: string) => Promise<unknown>;
  onEdit: (postId: string, body: string) => Promise<unknown>;
  onDelete: (post: Post) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const children = childrenOf.get(post.id) ?? [];
  const isStaff = post.authorRole === 'teacher' || post.authorRole === 'assistant';
  return (
    <div className={cn(depth > 0 && 'border-l-2 border-border pl-4 sm:pl-6')}>
      <div className="py-4">
        <div className="flex items-center gap-3">
          <Avatar user={post.author} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {post.author.name}
              {isStaff && <Badge variant="violet">{COURSE_ROLE_LABELS[post.authorRole!]}</Badge>}
            </p>
            <p className="text-xs text-muted-foreground" title={formatDateTime(post.createdAt)}>
              {formatRelative(post.createdAt)}
              {post.updatedAt !== post.createdAt && ' · edited'}
            </p>
          </div>
          {(post.canEdit || post.canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Post actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {post.canEdit && (
                  <DropdownMenuItem onSelect={() => setEditing(true)}>
                    <Pencil /> Edit
                  </DropdownMenuItem>
                )}
                {post.canDelete && (
                  <DropdownMenuItem destructive onSelect={() => onDelete(post)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="mt-3 pl-11">
          {editing ? (
            <Composer
              initial={post.body}
              submitLabel="Save"
              autoFocus
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                await onEdit(post.id, body);
                setEditing(false);
              }}
            />
          ) : (
            <Markdown source={post.body} className="prose-sm" />
          )}
          {discussion.canReply && !editing && (
            <button
              onClick={() => setReplying(!replying)}
              className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary"
            >
              <Reply className="size-3.5" /> Reply
            </button>
          )}
          {replying && (
            <div className="mt-3">
              <Composer
                autoFocus
                onCancel={() => setReplying(false)}
                onSubmit={async (body) => {
                  await onReply(post.id, body);
                  setReplying(false);
                }}
              />
            </div>
          )}
        </div>
      </div>
      {children.length > 0 && (
        <div className={cn(depth >= 3 ? '' : 'ml-4 sm:ml-5')}>
          {children.map((c) => (
            <PostItem
              key={c.id}
              post={c}
              childrenOf={childrenOf}
              depth={Math.min(depth + 1, 4)}
              discussion={discussion}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DiscussionPage() {
  const { slug, discussionId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const key = ['discussion', discussionId];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<DiscussionDetail>(`/discussions/${discussionId}`),
  });
  useTitle(data?.title);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['discussions'] })]);
  const reply = (parentId: string | null, body: string) =>
    api
      .post(`/discussions/${discussionId}/posts`, { body, parentId })
      .then(refresh)
      .catch((err) => {
        toast.error(errorMessage(err));
        throw err;
      });
  const edit = (postId: string, body: string) =>
    api
      .patch(`/posts/${postId}`, { body })
      .then(refresh)
      .catch((err) => {
        toast.error(errorMessage(err));
        throw err;
      });
  const moderate = useMutation({
    mutationFn: (body: Record<string, boolean>) => api.patch(`/discussions/${discussionId}`, body),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) {
    return (
      <Page size="narrow">
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="h-64" />
      </Page>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !data) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Page>
    );
  }

  const root = data.posts.find((p) => p.parentId === null);
  const childrenOf = new Map<string, Post[]>();
  for (const p of data.posts) if (p.parentId) childrenOf.set(p.parentId, [...(childrenOf.get(p.parentId) ?? []), p]);
  const forumPath = activityPath(data.course.slug, data.activityId);

  const remove = async (post: Post) => {
    const isRoot = post.parentId === null;
    const ok = await confirm({
      title: isRoot ? 'Delete this discussion?' : 'Delete this post?',
      description: isRoot ? 'The whole discussion and every reply will be removed.' : 'Replies to this post are deleted too.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/posts/${post.id}`);
      if (isRoot) {
        toast.success('Discussion deleted');
        navigate(forumPath);
      } else await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page size="narrow">
      <Link to={forumPath} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {data.activityTitle}
      </Link>
      <div className="mt-3 mb-6 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-[3px]" style={coverDot(data.course.coverColor)} />
            <Link to={`/courses/${slug}`} className="hover:text-foreground">
              {data.course.title}
            </Link>
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{data.title}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.pinned && (
              <Badge variant="warning">
                <Pin /> Pinned
              </Badge>
            )}
            {data.locked && (
              <Badge variant="neutral">
                <Lock /> Locked: no new replies
              </Badge>
            )}
            <Badge variant="neutral">
              {data.replyCount} {data.replyCount === 1 ? 'reply' : 'replies'}
            </Badge>
          </div>
        </div>
        {data.canModerate && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Moderate
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => moderate.mutate({ pinned: !data.pinned })}>
                {data.pinned ? <PinOff /> : <Pin />} {data.pinned ? 'Unpin' : 'Pin to top'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => moderate.mutate({ locked: !data.locked })}>
                {data.locked ? <LockOpen /> : <Lock />} {data.locked ? 'Unlock' : 'Lock replies'}
              </DropdownMenuItem>
              {root && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => remove(root)}>
                    <Trash2 /> Delete discussion
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <Card className="px-5 sm:px-6">
        {root && (
          <div className="divide-y">
            <PostItem
              post={root}
              childrenOf={new Map()}
              depth={0}
              discussion={{ ...data, canReply: false }}
              onReply={(id, b) => reply(id, b)}
              onEdit={edit}
              onDelete={remove}
            />
          </div>
        )}
      </Card>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          {data.replyCount} {data.replyCount === 1 ? 'reply' : 'replies'}
        </h2>
        {root && (childrenOf.get(root.id) ?? []).length > 0 && (
          <Card className="divide-y px-5 sm:px-6">
            {(childrenOf.get(root.id) ?? []).map((p) => (
              <PostItem
                key={p.id}
                post={p}
                childrenOf={childrenOf}
                depth={0}
                discussion={data}
                onReply={(id, b) => reply(id, b)}
                onEdit={edit}
                onDelete={remove}
              />
            ))}
          </Card>
        )}
      </div>

      {data.canReply ? (
        <Card className="mt-6 p-5">
          <p className="mb-3 text-sm font-semibold">Join the discussion</p>
          <Composer onSubmit={(body) => reply(null, body)} submitLabel="Post reply" />
        </Card>
      ) : (
        data.locked && (
          <p className="mt-6 rounded-lg bg-muted px-4 py-3 text-center text-sm text-muted-foreground">This discussion is locked.</p>
        )
      )}
    </Page>
  );
}
