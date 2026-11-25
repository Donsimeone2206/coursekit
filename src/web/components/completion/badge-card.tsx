import { CircleCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { BadgeSummary } from '@shared/completion';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { badgeCriteriaLabel } from '@/lib/achievements';
import { cn, formatDate, plural } from '@/lib/utils';
import { BadgeArt } from './badge-art';

/** A badge in a grid. Staff see how many people have it; learners see whether they earned it. */
export function BadgeCard({ badge, staff, actions }: { badge: BadgeSummary; staff: boolean; actions?: ReactNode }) {
  const locked = !staff && !badge.earnedAt;
  return (
    <Card className="group relative flex flex-col items-center p-5 text-center transition-shadow hover:shadow-md">
      {actions && <div className="absolute top-2 right-2 z-10">{actions}</div>}
      <BadgeArt icon={badge.icon} color={badge.color} size={76} locked={locked} className="transition-transform group-hover:scale-105" />
      <Link to={`/badges/${badge.id}`} className="mt-3 font-semibold tracking-tight after:absolute after:inset-0 hover:text-primary">
        {badge.name}
      </Link>
      {badge.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{badge.description}</p>}
      <div className="mt-auto flex flex-col items-center gap-1.5 pt-4 text-xs text-muted-foreground">
        <span>{badgeCriteriaLabel(badge)}</span>
        {staff ? (
          <span className="flex items-center gap-1 font-medium text-foreground">
            <Users className="size-3.5 text-muted-foreground" /> {plural(badge.recipientCount ?? 0, 'recipient')}
          </span>
        ) : (
          <span className={cn('flex items-center gap-1 font-medium', badge.earnedAt ? 'text-success' : 'text-muted-foreground')}>
            {badge.earnedAt ? (
              <>
                <CircleCheck className="size-3.5" /> Earned {formatDate(badge.earnedAt)}
              </>
            ) : (
              'Not earned yet'
            )}
          </span>
        )}
      </div>
    </Card>
  );
}

export function BadgeGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-60" />
      ))}
    </div>
  );
}
