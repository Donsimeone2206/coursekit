import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Copy, Download, ExternalLink, Globe, Link2Off, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import type { BadgeShareStatus } from '@shared/open-badges';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/form';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';

export const openBadgeKeys = {
  share: (badgeId: string) => ['badge', badgeId, 'share'] as const,
  myShares: ['me', 'badge-shares'] as const,
  admin: ['admin', 'open-badges'] as const,
};

/** Downloads come from this server, so the browser keeps the file name (the public URL may use another host name). */
function downloadPath(url: string): string {
  try {
    const { pathname } = new URL(url);
    return `${pathname}?download`;
  } catch {
    return url;
  }
}

/**
 * Sharing one of your own badges: a public link and Open Badges 2.0 / 3.0 files for backpacks and wallets.
 * Renders nothing when the viewer doesn't hold the badge.
 */
export function BadgeSharePanel({ badgeId, className }: { badgeId: string; className?: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = openBadgeKeys.share(badgeId);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<BadgeShareStatus>(`/badges/${badgeId}/share`),
  });
  const done = (status: BadgeShareStatus) => {
    qc.setQueryData(key, status);
    void qc.invalidateQueries({ queryKey: openBadgeKeys.myShares });
  };
  const share = useMutation({
    mutationFn: () => api.post<BadgeShareStatus>(`/badges/${badgeId}/share`),
    onSuccess: (status) => {
      done(status);
      toast.success('Badge shared');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const stop = useMutation({
    mutationFn: () => api.delete<BadgeShareStatus>(`/badges/${badgeId}/share`),
    onSuccess: (status) => {
      done(status);
      toast.success('You stopped sharing this badge');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) return <Skeleton className={cn('h-20', className)} />;
  if (!data.earned) return null;

  if (data.unavailableReason) {
    return (
      <div className={cn('flex items-start gap-2.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground', className)}>
        <Globe className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium text-foreground">Sharing isn’t available on this site yet.</span> {data.unavailableReason}
        </p>
      </div>
    );
  }

  const current = data.share;
  if (!current) {
    return (
      <div className={cn('flex flex-col gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center', className)}>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Share this badge</p>
          <p className="mt-0.5 text-muted-foreground">
            Get a public link and Open Badges files for a backpack, LinkedIn or a digital wallet. Anyone with the link can see your name,
            this badge, the date you earned it and any note that came with it. You can stop sharing at any time.
          </p>
        </div>
        <Button className="shrink-0" loading={share.isPending} onClick={() => share.mutate()}>
          <Share2 /> Share badge
        </Button>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.links.assertion);
      toast.success('Link copied');
    } catch {
      toast.error('Your browser blocked copying. Select the link and copy it yourself.');
    }
  };

  return (
    <div className={cn('rounded-xl border px-4 py-3.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Globe className="size-4 text-success" /> Shared publicly since {formatDate(current.sharedAt, { year: 'numeric' })}
        </p>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <a href={current.links.page} target="_blank" rel="noreferrer">
            View public page <ExternalLink />
          </a>
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Paste the link into your backpack to import the badge, or download it as a file.</p>
      <div className="mt-3 flex gap-2">
        <Input
          readOnly
          value={current.links.assertion}
          aria-label="Link to your badge"
          className="min-w-0 flex-1 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="outline" className="shrink-0" onClick={() => void copy()}>
          <Copy /> Copy link
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={downloadPath(current.links.badgeImage)} download>
            <Download /> Download badge (Open Badges 2.0)
          </a>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Download /> Download credential (Open Badges 3.0) <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem asChild>
              <a href={downloadPath(current.links.credential)} download>
                Credential file (.jwt)
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={downloadPath(current.links.credentialImage)} download>
                Badge image with the credential (.svg)
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 sm:ml-auto"
          loading={stop.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: 'Stop sharing this badge?',
                description:
                  'The public link and the files you downloaded will show the badge as no longer valid. You can share it again later with a new link.',
                confirmLabel: 'Stop sharing',
                destructive: true,
              })
            )
              stop.mutate();
          }}
        >
          <Link2Off /> Stop sharing
        </Button>
      </div>
    </div>
  );
}
