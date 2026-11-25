import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, CircleCheck, Flag, Hand, Library, Medal, Pencil, Plus, RotateCcw, Search, Trash2, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { BadgeDetail, BadgeRecipient } from '@shared/completion';
import { AwardBadgeDialog } from '@/components/completion/award-dialog';
import { BADGE_COLOR_META, BadgeArt } from '@/components/completion/badge-art';
import { BadgeFormDialog } from '@/components/completion/badge-dialog';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { achievementKeys, badgeCriteriaLabel } from '@/lib/achievements';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { cn, formatDate } from '@/lib/utils';
import NotFoundPage from './NotFoundPage';

function RecipientRow({
  recipient,
  canAward,
  onRevoke,
  onRestore,
}: {
  recipient: BadgeRecipient;
  canAward: boolean;
  onRevoke: () => void;
  onRestore: () => void;
}) {
  const revoked = !!recipient.revokedAt;
  return (
    <li className={cn('flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center', revoked && 'bg-muted/40')}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar user={recipient.user} size="sm" className={cn(revoked && 'opacity-60')} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 truncate text-sm font-medium">
            {recipient.user.name}
            {revoked && <Badge variant="danger">Revoked</Badge>}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {recipient.user.email && <span>{recipient.user.email} · </span>}
            {recipient.awardedBy ? `Awarded by ${recipient.awardedBy.name}` : 'Awarded automatically'} on{' '}
            {formatDate(recipient.awardedAt, { year: 'numeric' })}
          </p>
          {recipient.note && <p className="mt-1 text-xs text-foreground/80 italic">“{recipient.note}”</p>}
        </div>
      </div>
      {canAward && (
        <div className="shrink-0 pl-11 sm:pl-0">
          {revoked ? (
            <Button variant="outline" size="sm" onClick={onRestore}>
              <RotateCcw /> Restore
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={onRevoke}>
              <UserMinus /> Revoke
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function Recipients({ badge, onChange }: { badge: BadgeDetail; onChange: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [awarding, setAwarding] = useState(false);
  const recipients = badge.recipients ?? [];
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return recipients.filter((r) => !term || r.user.name.toLowerCase().includes(term) || r.user.email?.toLowerCase().includes(term));
  }, [recipients, q]);
  const active = recipients.filter((r) => !r.revokedAt).length;

  const revoke = useMutation({
    mutationFn: (userId: string) => api.delete(`/badges/${badge.id}/awards/${userId}`),
    onSuccess: async () => {
      toast.success('Badge revoked');
      await onChange();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const restore = useMutation({
    mutationFn: (userId: string) => api.post(`/badges/${badge.id}/awards`, { userIds: [userId] }),
    onSuccess: async () => {
      toast.success('Badge restored');
      await onChange();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader
        title="Recipients"
        description={`${active} ${active === 1 ? 'person has' : 'people have'} this badge${recipients.length > active ? `, ${recipients.length - active} revoked` : ''}.`}
        action={
          badge.canAward && (
            <Button size="sm" onClick={() => setAwarding(true)}>
              <Plus /> Award badge
            </Button>
          )
        }
      />
      {recipients.length > 6 && (
        <div className="px-5 pb-3">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a recipient"
              className="pl-9"
              aria-label="Find a recipient"
            />
          </div>
        </div>
      )}
      {recipients.length === 0 ? (
        <div className="border-t px-5 py-10 text-center text-sm text-muted-foreground">
          Nobody has this badge yet.
          {badge.criteria !== 'manual' && ' It is awarded automatically as soon as someone qualifies.'}
        </div>
      ) : (
        <ul className="divide-y border-t">
          {filtered.map((r) => (
            <RecipientRow
              key={r.user.id}
              recipient={r}
              canAward={badge.canAward}
              onRestore={() => restore.mutate(r.user.id)}
              onRevoke={async () => {
                if (
                  await confirm({
                    title: `Revoke the badge from ${r.user.name}?`,
                    description:
                      badge.criteria === 'manual'
                        ? 'It disappears from their profile. You can restore it later.'
                        : 'It disappears from their profile and is not awarded to them automatically again. You can restore it later.',
                    confirmLabel: 'Revoke',
                    destructive: true,
                  })
                )
                  revoke.mutate(r.user.id);
              }}
            />
          ))}
          {filtered.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted-foreground">Nobody matches your search.</li>}
        </ul>
      )}
      {awarding && <AwardBadgeDialog badge={badge} open={awarding} onOpenChange={setAwarding} onDone={() => void onChange()} />}
    </Card>
  );
}

export default function BadgePage() {
  const { badgeId } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const key = achievementKeys.badge(badgeId ?? '');
  const {
    data: badge,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: key,
    queryFn: () => api.get<BadgeDetail>(`/badges/${badgeId}`),
    enabled: !!badgeId,
  });
  useTitle(badge ? `${badge.name} badge` : 'Badge');

  const listKey = badge?.course ? achievementKeys.courseBadges(badge.course.slug) : achievementKeys.siteBadges;
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: listKey }),
      qc.invalidateQueries({ queryKey: achievementKeys.myBadges }),
    ]);
  const remove = useMutation({
    mutationFn: () => api.delete(`/badges/${badgeId}`),
    onSuccess: async () => {
      toast.success('Badge deleted');
      await qc.invalidateQueries({ queryKey: listKey });
      navigate(badge?.course ? `/courses/${badge.course.slug}/badges` : '/admin/badges');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;

  const back = badge?.course
    ? { to: `/courses/${badge.course.slug}/badges`, label: `${badge.course.title} badges` }
    : me?.role === 'admin'
      ? { to: '/admin/badges', label: 'Site badges' }
      : { to: '/profile', label: 'Your profile' };
  const staff = !!badge && (badge.canAward || badge.canManage);
  const tone = badge ? BADGE_COLOR_META[badge.color] : null;
  const CriteriaIcon = badge?.criteria === 'completion' ? Flag : badge?.criteria === 'courses' ? Library : Hand;

  return (
    <Page size="narrow">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
        <Link to={back.to}>
          <ArrowLeft /> {back.label}
        </Link>
      </Button>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !badge ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div
              className="flex flex-col items-center gap-6 px-6 py-8 text-center sm:flex-row sm:items-center sm:text-left"
              style={tone ? { backgroundImage: `radial-gradient(circle at 12% 50%, ${tone.from}33, transparent 45%)` } : undefined}
            >
              <BadgeArt icon={badge.icon} color={badge.color} size={124} locked={!staff && !badge.earnedAt} label={`${badge.name} badge`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">
                  {badge.course ? (
                    <>
                      Course badge ·{' '}
                      <Link to={`/courses/${badge.course.slug}`} className="hover:text-foreground hover:underline">
                        {badge.course.title}
                      </Link>
                    </>
                  ) : (
                    'Site badge'
                  )}
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{badge.name}</h1>
                {badge.description && <p className="mt-2 text-[15px] text-muted-foreground">{badge.description}</p>}
                <p className="mt-3 inline-flex items-center gap-1.5 text-sm">
                  <CriteriaIcon className="size-4 text-muted-foreground" /> {badgeCriteriaLabel(badge)}
                </p>
                {badge.canManage && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2 sm:justify-start">
                    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                      <Pencil /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      loading={remove.isPending}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete “${badge.name}”?`,
                            description: 'Everyone who has it loses it. This cannot be undone.',
                            confirmLabel: 'Delete badge',
                            destructive: true,
                          })
                        )
                          remove.mutate();
                      }}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {badge.earnedAt ? (
              <div className="flex items-start gap-2.5 border-t bg-success/[0.07] px-6 py-3.5 text-sm">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                <p>
                  <span className="font-medium">You earned this badge on {formatDate(badge.earnedAt, { year: 'numeric' })}.</span>
                  {badge.earnedNote && <span className="text-muted-foreground"> “{badge.earnedNote}”</span>}
                </p>
              </div>
            ) : (
              !staff && (
                <div className="flex items-start gap-2.5 border-t bg-muted/40 px-6 py-3.5 text-sm text-muted-foreground">
                  {badge.criteria === 'manual' ? <Medal className="mt-0.5 size-4 shrink-0" /> : <Bot className="mt-0.5 size-4 shrink-0" />}
                  <p>
                    {badge.criteria === 'manual'
                      ? 'You haven’t earned this badge yet.'
                      : 'You haven’t earned this badge yet. It is awarded automatically when you qualify.'}
                  </p>
                </div>
              )
            )}
          </Card>
          {badge.recipients && <Recipients badge={badge} onChange={refresh} />}
          {editing && (
            <BadgeFormDialog
              open={editing}
              onOpenChange={setEditing}
              scope={badge.course ? { kind: 'course', courseId: badge.course.id } : { kind: 'site' }}
              badge={badge}
              onSaved={(saved) => {
                qc.setQueryData(key, saved);
                void refresh();
              }}
            />
          )}
        </>
      )}
    </Page>
  );
}
