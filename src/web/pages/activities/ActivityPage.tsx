import { Download, ExternalLink, FileText } from 'lucide-react';
import { useParams } from 'react-router';
import type { ActivityDetail, LessonSettings, ResourceSettings } from '@shared/types';
import { Page } from '@/components/layout/shell';
import { LtiView } from '@/components/lti';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { formatBytes } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';
import { AssignmentView } from './AssignmentView';
import { ForumView } from './ForumView';
import { ActivityFrame, useActivity } from './frame';
import { LiveClassView } from './LiveClassView';
import { PackageView } from './PackageView';
import { QuizView } from './QuizView';

function videoEmbed(url: string): { kind: 'iframe' | 'video' | 'link'; src: string } {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vimeo[1]}` };
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return { kind: 'video', src: url };
  return { kind: 'link', src: url };
}

function LessonView({ activity }: { activity: ActivityDetail<'lesson'> }) {
  const s = activity.settings as LessonSettings;
  const video = s.videoUrl ? videoEmbed(s.videoUrl) : null;
  return (
    <div className="space-y-6">
      {video && video.kind !== 'link' && (
        <div className="overflow-hidden rounded-2xl border bg-black shadow-lg">
          {video.kind === 'iframe' ? (
            <iframe
              src={video.src}
              title={activity.title}
              className="aspect-video w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <video src={video.src} controls className="aspect-video w-full" />
          )}
        </div>
      )}
      {video?.kind === 'link' && (
        <a
          href={video.src}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-sm font-medium text-primary hover:underline"
        >
          <ExternalLink className="size-4" /> Watch the video
        </a>
      )}
      <Card className="px-6 py-8 sm:px-10 sm:py-10">
        {s.body.trim() ? (
          <Markdown source={s.body} className="mx-auto max-w-3xl" />
        ) : (
          <p className="text-muted-foreground">This lesson has no content yet.</p>
        )}
      </Card>
    </div>
  );
}

function ResourceView({ activity }: { activity: ActivityDetail<'resource'> }) {
  const s = activity.settings as ResourceSettings;
  const file = activity.file;
  return (
    <div className="space-y-6">
      {activity.description && (
        <Card className="p-6">
          <Markdown source={activity.description} />
        </Card>
      )}
      {s.kind === 'link' && s.url ? (
        <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-slate-500/10 text-slate-600 dark:text-slate-300">
            <ExternalLink className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{new URL(s.url).hostname.replace(/^www\./, '')}</p>
            <p className="truncate text-sm text-muted-foreground">{s.url}</p>
          </div>
          <Button asChild>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              Open link <ExternalLink />
            </a>
          </Button>
        </Card>
      ) : file ? (
        <>
          <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <FileText className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {formatBytes(file.size)} · {file.mime}
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <a href={file.url} target="_blank" rel="noreferrer">
                  Open <ExternalLink />
                </a>
              </Button>
              <Button asChild>
                <a href={`${file.url}?download=1`}>
                  <Download /> Download
                </a>
              </Button>
            </div>
          </Card>
          {file.mime.startsWith('image/') && (
            <img src={file.url} alt={file.name} className="max-h-[70vh] rounded-xl border object-contain" />
          )}
          {file.mime === 'application/pdf' && (
            <iframe src={file.url} title={file.name} className="h-[75vh] w-full rounded-xl border bg-white" />
          )}
          {file.mime.startsWith('video/') && <video src={file.url} controls className="w-full rounded-xl border" />}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">The file for this resource is missing.</p>
      )}
    </div>
  );
}

export default function ActivityPage() {
  const { activityId } = useParams();
  const { data: activity, isLoading, error, refetch } = useActivity(activityId);
  useTitle(activity?.title);

  if (isLoading) {
    return (
      <Page className="max-w-5xl">
        <Skeleton className="mb-6 h-16" />
        <Skeleton className="h-96" />
      </Page>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !activity) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Page>
    );
  }

  switch (activity.type) {
    case 'lesson':
      return (
        <ActivityFrame activity={activity}>
          <LessonView activity={activity as ActivityDetail<'lesson'>} />
        </ActivityFrame>
      );
    case 'resource':
      return (
        <ActivityFrame activity={activity}>
          <ResourceView activity={activity as ActivityDetail<'resource'>} />
        </ActivityFrame>
      );
    case 'assignment':
      return <AssignmentView activity={activity as ActivityDetail<'assignment'>} />;
    case 'quiz':
      return <QuizView activity={activity as ActivityDetail<'quiz'>} />;
    case 'forum':
      return <ForumView activity={activity as ActivityDetail<'forum'>} />;
    case 'lti':
      return (
        <ActivityFrame activity={activity}>
          <LtiView activity={activity as ActivityDetail<'lti'>} />
        </ActivityFrame>
      );
    case 'package':
      return <PackageView activity={activity as ActivityDetail<'package'>} />;
    case 'live':
      return <LiveClassView activity={activity as ActivityDetail<'live'>} />;
  }
}
