import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Globe, Medal, ScrollText, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { CertificateSummary, EarnedBadge } from '@shared/completion';
import type { MyBadgeShare } from '@shared/open-badges';
import { BadgeSharePanel, openBadgeKeys } from '@/components/open-badges/share-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { achievementKeys } from '@/lib/achievements';
import { api } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { cn, formatDate } from '@/lib/utils';
import { BadgeArt } from './badge-art';

function Certificates() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: achievementKeys.myCertificates,
    queryFn: () => api.get<CertificateSummary[]>('/me/certificates'),
  });
  return (
    <Card>
      <CardHeader title="Certificates" description="Earned by completing courses." icon={<ScrollText className="size-4.5" />} />
      <div className="px-2 pb-3">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="mx-3 mb-2 h-16" />
        ) : data.length === 0 ? (
          <p className="px-3 pb-2 text-sm text-muted-foreground">
            When you complete a course that gives certificates, yours will appear here.
          </p>
        ) : (
          <ul>
            {data.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/certificates/${c.id}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
                >
                  <span
                    className="grid size-9 shrink-0 place-items-center rounded-lg text-white"
                    style={c.course ? coverDot(c.course.coverColor) : { background: 'var(--color-muted-foreground)' }}
                  >
                    <ScrollText className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm font-medium', c.revokedAt && 'text-muted-foreground')}>
                      {c.courseTitle}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      Completed {formatDate(c.completedAt, { year: 'numeric' })} · <span className="font-mono">{c.code}</span>
                    </span>
                  </span>
                  {c.revokedAt && <Badge variant="danger">Revoked</Badge>}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Badges() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: achievementKeys.myBadges,
    queryFn: () => api.get<EarnedBadge[]>('/me/badges'),
  });
  const { data: shares } = useQuery({ queryKey: openBadgeKeys.myShares, queryFn: () => api.get<MyBadgeShare[]>('/me/badge-shares') });
  const shared = new Set(shares?.map((s) => s.badgeId));
  const [sharing, setSharing] = useState<EarnedBadge | null>(null);
  return (
    <Card>
      <CardHeader title="Badges" description="Awarded by teachers and for completing courses." icon={<Medal className="size-4.5" />} />
      <div className="px-5 pb-5">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="h-28" />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No badges yet. Teachers award them for great work, and some courses give one when you finish.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.map((b) => (
              <li key={b.badge.id} className="relative">
                <Link
                  to={`/badges/${b.badge.id}`}
                  className="flex h-full flex-col items-center rounded-xl border px-3 py-4 text-center transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <BadgeArt icon={b.badge.icon} color={b.badge.color} size={56} />
                  <span className="mt-2 line-clamp-2 text-sm font-medium break-words">{b.badge.name}</span>
                  <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{b.badge.course?.title ?? 'Site badge'}</span>
                  <span className="mt-0.5 text-[11px] text-muted-foreground">{formatDate(b.awardedAt, { year: 'numeric' })}</span>
                  {shared.has(b.badge.id) && (
                    <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-success">
                      <Globe className="size-3" /> Shared
                    </span>
                  )}
                </Link>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-1.5 right-1.5 text-muted-foreground"
                  aria-label={`Share ${b.badge.name}`}
                  onClick={() => setSharing(b)}
                >
                  <Share2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={!!sharing} onOpenChange={(open) => !open && setSharing(null)}>
        {sharing && (
          <DialogContent size="lg">
            <DialogHeader title={`Share “${sharing.badge.name}”`} icon={<Share2 className="size-5" />} />
            <DialogBody className="pb-6">
              <BadgeSharePanel badgeId={sharing.badge.id} />
            </DialogBody>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

/** The profile's certificates and badges. */
export function MyAchievements() {
  return (
    <>
      <Badges />
      <Certificates />
    </>
  );
}
