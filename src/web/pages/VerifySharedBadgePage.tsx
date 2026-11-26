import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { SharedBadgeVerification } from '@shared/open-badges';
import { BADGE_COLOR_META, BadgeArt } from '@/components/completion/badge-art';
import { Logo } from '@/components/layout/shell';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { formatDate } from '@/lib/utils';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function Result({ shareId }: { shareId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['verify-badge', shareId],
    queryFn: () => api.get<SharedBadgeVerification>(`/open-badges/shares/${encodeURIComponent(shareId)}`),
    retry: false,
  });
  useTitle(data?.badge ? `${data.badge.name} badge` : 'Verify a badge');
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" /> Checking…
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div role="status" className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-sm">
          <p className="font-semibold">We couldn’t find this badge</p>
          <p className="mt-1 text-muted-foreground">Check that the link is complete, or ask the person who shared it for a new one.</p>
        </div>
      </div>
    );
  }
  if (error || !data) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;

  if (data.status !== 'valid' || !data.badge) {
    return (
      <div role="status" className="rounded-xl border border-destructive/35 bg-destructive/[0.06] p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-destructive/12 text-destructive">
            <ShieldX className="size-5" />
          </span>
          <div>
            <p className="font-semibold">This badge is no longer valid</p>
            <p className="text-sm text-muted-foreground">{data.revocationReason}</p>
          </div>
        </div>
        <dl className="mt-4 space-y-2.5 border-t pt-4">
          <Detail label="Issued by">{data.issuer.name}</Detail>
        </dl>
      </div>
    );
  }

  const tone = BADGE_COLOR_META[data.badge.color];
  return (
    <div role="status">
      <div
        className="flex flex-col items-center gap-4 rounded-xl px-4 py-6 text-center"
        style={tone ? { backgroundImage: `radial-gradient(circle at 50% 40%, ${tone.from}33, transparent 60%)` } : undefined}
      >
        <BadgeArt icon={data.badge.icon} color={data.badge.color} size={112} label={`${data.badge.name} badge`} />
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-balance">{data.badge.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{data.badge.description}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-success/35 bg-success/[0.07] p-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-success/15 text-success">
          <ShieldCheck className="size-5" />
        </span>
        <p className="text-sm">
          <span className="font-semibold">Valid badge.</span>{' '}
          <span className="text-muted-foreground">Issued by {data.issuer.name} and shared by its recipient.</span>
        </p>
      </div>
      <dl className="mt-4 space-y-2.5">
        <Detail label="Awarded to">{data.recipientName}</Detail>
        <Detail label="Issued by">
          <a href={data.issuer.url} className="hover:underline">
            {data.issuer.name}
          </a>
        </Detail>
        {data.badge.course && <Detail label="Course">{data.badge.course}</Detail>}
        {data.issuedOn && <Detail label="Awarded on">{formatDate(data.issuedOn, { year: 'numeric' })}</Detail>}
        <Detail label="How it’s earned">{data.badge.criteria}</Detail>
        {data.note && <Detail label="Note">“{data.note}”</Detail>}
        <Detail label="Status">Valid</Detail>
      </dl>
      {data.links && (
        <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
          Open Badges:{' '}
          <a href={data.links.assertion} className="font-medium text-primary hover:underline">
            2.0 assertion
          </a>{' '}
          ·{' '}
          <a href={data.links.credential} className="font-medium text-primary hover:underline">
            3.0 credential
          </a>
        </p>
      )}
    </div>
  );
}

/** Public page: anyone with the link can check a badge its recipient shared. */
export default function VerifySharedBadgePage() {
  const { shareId } = useParams();
  const { data: session } = useSession();
  const siteName = session?.site.name ?? 'Coursekit';

  return (
    <div className="ck-dots grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mx-auto flex w-fit">
          <Logo name={siteName} />
        </Link>
        <Card className="mt-6 p-5 sm:p-6">{shareId && <Result key={shareId} shareId={shareId} />}</Card>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Badges are issued by {siteName} as Open Badges.{' '}
          <Link to="/" className="font-medium text-primary hover:underline">
            Go to the site
          </Link>
        </p>
      </div>
    </div>
  );
}
