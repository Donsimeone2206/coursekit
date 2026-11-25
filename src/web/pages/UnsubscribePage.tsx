import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, MailX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { UnsubscribeInfo } from '@shared/email';
import { Logo } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

const PREFERENCES = '/profile?section=email';

function Panel({
  icon,
  tone,
  title,
  children,
}: {
  icon: ReactNode;
  tone: 'primary' | 'success' | 'danger';
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full p-6 sm:p-8">
      <span
        className={cn(
          'mb-5 grid size-11 place-items-center rounded-full',
          tone === 'primary' && 'bg-primary/10 text-primary',
          tone === 'success' && 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
          tone === 'danger' && 'bg-red-500/12 text-red-600 dark:text-red-400',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
      <div className="mt-2 space-y-5 text-sm text-muted-foreground">{children}</div>
    </Card>
  );
}

/** Reached from the "Unsubscribe" link in emails. Works without signing in: the signed token is enough. */
export default function UnsubscribePage() {
  useTitle('Unsubscribe');
  const [params] = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const { data: session } = useSession();
  const qc = useQueryClient();
  const [done, setDone] = useState<'all' | 'category' | null>(null);
  const key = ['unsubscribe', token];

  const info = useQuery({
    queryKey: key,
    queryFn: () => api.get<UnsubscribeInfo>(`/email/unsubscribe?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

  const unsubscribe = useMutation({
    mutationFn: (scope: 'all' | 'category') => api.post<UnsubscribeInfo>('/email/unsubscribe', { token, scope }),
    onSuccess: (data, scope) => {
      qc.setQueryData(key, data);
      setDone(scope);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const siteName = info.data?.siteName ?? session?.site.name ?? 'Coursekit';
  const manage = (
    <Button asChild variant="outline">
      <Link to={PREFERENCES}>Manage email preferences</Link>
    </Button>
  );

  let content: ReactNode;
  if (!token || info.error) {
    content = (
      <Panel icon={<CircleAlert className="size-5" />} tone="danger" title="This link doesn't work">
        <p>{token ? errorMessage(info.error) : 'The unsubscribe link is incomplete. Use the link from a recent email.'}</p>
        <p>You can also change which emails you get from your profile after signing in.</p>
        {manage}
      </Panel>
    );
  } else if (!info.data) {
    content = (
      <Card className="grid w-full place-items-center p-10" aria-busy>
        <Spinner className="size-6" />
        <span className="sr-only">Loading</span>
      </Card>
    );
  } else if (done || info.data.unsubscribed) {
    const categoryOnly = done === 'category' && info.data.category;
    content = (
      <Panel
        icon={<CircleCheck className="size-5" />}
        tone="success"
        title={categoryOnly ? `${info.data.category!.label} emails are off` : done ? "You're unsubscribed" : "You're already unsubscribed"}
      >
        <p>
          {categoryOnly
            ? `You won't get emails about ${info.data.category!.label.toLowerCase()} from ${siteName} any more. Other emails continue as before.`
            : `${siteName} won't email ${info.data.maskedEmail} any more. You'll still see notifications when you sign in.`}
        </p>
        <p>Changed your mind? You can turn emails back on from your profile.</p>
        {manage}
      </Panel>
    );
  } else {
    const { category } = info.data;
    content = (
      <Panel icon={<MailX className="size-5" />} tone="primary" title={`Unsubscribe from ${siteName} emails?`}>
        <p>
          We&apos;ll stop emailing <span className="font-medium text-foreground">{info.data.maskedEmail}</span>. You&apos;ll still see
          notifications when you sign in.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            onClick={() => unsubscribe.mutate('all')}
            loading={unsubscribe.isPending && unsubscribe.variables === 'all'}
            disabled={unsubscribe.isPending}
          >
            Unsubscribe from all emails
          </Button>
          {category && !info.data.categoryDisabled && (
            <Button
              variant="outline"
              onClick={() => unsubscribe.mutate('category')}
              loading={unsubscribe.isPending && unsubscribe.variables === 'category'}
              disabled={unsubscribe.isPending}
            >
              Only stop {category.label.toLowerCase()} emails
            </Button>
          )}
        </div>
        <p className="text-xs">
          Or{' '}
          <Link to={PREFERENCES} className="font-medium text-primary underline-offset-4 hover:underline">
            choose which emails you get
          </Link>
          .
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background px-4 py-7 sm:px-12">
      <Logo name={siteName} />
      <main className="mx-auto flex w-full max-w-md flex-1 items-center py-12">{content}</main>
    </div>
  );
}
