import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleAlert, CircleCheck, Clock, Inbox, LoaderCircle, MailCheck, MailX, RotateCcw, Send } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  EMAIL_FREQUENCIES,
  EMAIL_FREQUENCY_LABELS,
  WEEKDAY_NAMES,
  type EmailAdminStatus,
  type EmailFrequency,
  type EmailMessageInfo,
  type EmailSiteSettings,
} from '@shared/email';
import { StatCard } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';

const statusKey = ['admin', 'email'] as const;

function hourLabel(hour: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hour));
}

/** "Tue, Nov 26, 8:00 AM" in the site's time zone. */
function inZone(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return formatDateTime(iso);
  }
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'warning' | 'danger' | 'info';
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'flex gap-3 rounded-xl border px-4 py-3.5 text-sm',
        tone === 'warning' && 'border-amber-500/25 bg-amber-500/8 text-amber-900 dark:text-amber-200',
        tone === 'danger' && 'border-red-500/25 bg-red-500/8 text-red-900 dark:text-red-200',
        tone === 'info' && 'border-sky-500/25 bg-sky-500/8 text-sky-900 dark:text-sky-200',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        <div className="leading-relaxed opacity-90">{children}</div>
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-foreground/8 px-1 py-0.5 font-mono text-[12px] break-all">{children}</code>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function DeliveryCard({ status }: { status: EmailAdminStatus }) {
  const badge = !status.enabled ? (
    <Badge variant="neutral">Off</Badge>
  ) : status.transportError ? (
    <Badge variant="danger">Not working</Badge>
  ) : status.transport === 'log' ? (
    <Badge variant="info">Logging only</Badge>
  ) : (
    <Badge variant="success">On</Badge>
  );
  const tz = status.settings.timezone;
  return (
    <Card>
      <CardHeader
        title="Delivery"
        description="How this server sends email. Set with environment variables or createCoursekit()."
        action={badge}
      />
      <dl className="divide-y px-5 pb-2">
        <Row label="Transport">
          {status.enabled ? (
            <>
              <span className="font-medium">{status.transportName}</span>
              {status.transportDetail && <span className="text-muted-foreground"> · {status.transportDetail}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">Not configured</span>
          )}
        </Row>
        <Row label="From">
          <span className="font-mono text-[13px]">{status.from}</span>
          {status.fromIsDefault && (
            <Badge variant="outline" className="ml-2">
              default
            </Badge>
          )}
        </Row>
        <Row label="Public URL">
          {status.publicUrl ?? <span className="text-amber-700 dark:text-amber-400">Not set: emails go out without links</span>}
        </Row>
        <Row label="Background delivery">
          {status.worker ? 'Running on this server' : status.enabled ? 'Off on this server (another process or cron sends email)' : 'Off'}
        </Row>
        <Row label="Next digests">
          Daily {inZone(status.nextDigests.daily, tz)} · Weekly {inZone(status.nextDigests.weekly, tz)}
          <span className="block text-xs text-muted-foreground">{tz}</span>
        </Row>
      </dl>
    </Card>
  );
}

function Alerts({ status }: { status: EmailAdminStatus }) {
  const items: ReactNode[] = [];
  if (!status.enabled) {
    items.push(
      <Callout key="off" tone="info" icon={<MailX className="size-4" />} title="Email is off">
        People only see notifications in the app. To send email, set <Code>COURSEKIT_SMTP_URL</Code> (for example{' '}
        <Code>smtp://user:password@smtp.example.com:587</Code>) and <Code>COURSEKIT_MAIL_FROM</Code>, install <Code>nodemailer</Code> and
        restart. To try it out locally, <Code>COURSEKIT_MAIL_TRANSPORT=log</Code> prints emails and saves them in the data folder.
        Everyone&apos;s preferences are kept in the meantime.
      </Callout>,
    );
  }
  if (status.transportError) {
    items.push(
      <Callout key="error" tone="danger" icon={<CircleAlert className="size-4" />} title="Email can't be sent">
        {status.transportError}
      </Callout>,
    );
  }
  if (status.enabled && !status.publicUrl) {
    items.push(
      <Callout key="url" tone="warning" icon={<AlertTriangle className="size-4" />} title="Emails have no links">
        Without the site&apos;s public address, emails can&apos;t link to it or include unsubscribe links. Set{' '}
        <Code>COURSEKIT_PUBLIC_URL</Code> (for example <Code>https://learn.example.com</Code>) and restart.
      </Callout>,
    );
  }
  if (status.transport === 'smtp' && status.fromIsDefault) {
    items.push(
      <Callout key="from" tone="warning" icon={<AlertTriangle className="size-4" />} title="No from address set">
        Mail servers often reject messages from addresses they don&apos;t know. Set <Code>COURSEKIT_MAIL_FROM</Code> to an address your
        server may send from.
      </Callout>,
    );
  }
  return items.length ? <div className="space-y-3">{items}</div> : null;
}

function OutboxCard({ status }: { status: EmailAdminStatus }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.post<{ requeued: number }>('/admin/email/retry-failed'),
    onSuccess: async ({ requeued }) => {
      toast.success(requeued === 1 ? '1 email will be retried' : `${requeued} emails will be retried`);
      await qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const { outbox, lastError } = status;
  return (
    <section aria-labelledby="outbox-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="outbox-title" className="text-[15px] font-semibold tracking-tight">
          Outbox
        </h2>
        <span className="text-xs text-muted-foreground">
          {status.lastSentAt ? `Last sent ${formatRelative(status.lastSentAt)}` : 'Nothing sent yet'} · kept for 30 days
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Inbox} label="Queued" value={outbox.pending} tone="sky" hint="Waiting or retrying" />
        <StatCard icon={Send} label="Sending" value={outbox.sending} tone="violet" />
        <StatCard icon={MailCheck} label="Sent" value={outbox.sent} tone="emerald" />
        <StatCard icon={MailX} label="Failed" value={outbox.failed} tone="rose" hint="Gave up after retries" />
      </div>
      {(lastError || outbox.failed > 0) && (
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 text-sm">
            {lastError ? (
              <>
                <p className="font-medium">Last error {formatRelative(lastError.at)}</p>
                <p className="mt-0.5 break-words text-muted-foreground">{lastError.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  To {lastError.to} ·{' '}
                  {lastError.status === 'sent' ? 'delivered on a later try' : lastError.status === 'failed' ? 'gave up' : 'will be retried'}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Some emails could not be delivered.</p>
            )}
          </div>
          {outbox.failed > 0 && (
            <Button variant="outline" size="sm" onClick={() => retry.mutate()} loading={retry.isPending} className="shrink-0">
              <RotateCcw /> Retry failed
            </Button>
          )}
        </Card>
      )}
    </section>
  );
}

function SettingsCard({ status }: { status: EmailAdminStatus }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<EmailSiteSettings>(status.settings);
  const saved = status.settings;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return list.includes(form.timezone) ? list : [form.timezone, ...list];
  }, [form.timezone]);

  const save = useMutation({
    mutationFn: () => api.put<EmailAdminStatus>('/admin/email/settings', form),
    onSuccess: (next) => {
      qc.setQueryData(statusKey, next);
      setForm(next.settings);
      toast.success('Email settings saved');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card>
      <CardHeader title="Defaults and digests" description="People can change their own delivery on their profile page." />
      <form
        className="grid gap-4 px-5 pb-5 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Default delivery" hint="For new people and anyone who hasn't chosen." className="sm:col-span-2">
          {(p) => (
            <Select
              {...p}
              value={form.defaultFrequency}
              onChange={(e) => setForm({ ...form, defaultFrequency: e.target.value as EmailFrequency })}
            >
              {EMAIL_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {EMAIL_FREQUENCY_LABELS[f]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Digest time">
          {(p) => (
            <Select {...p} value={form.digestHour} onChange={(e) => setForm({ ...form, digestHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Weekly digest day">
          {(p) => (
            <Select {...p} value={form.digestWeekday} onChange={(e) => setForm({ ...form, digestWeekday: Number(e.target.value) })}>
              {WEEKDAY_NAMES.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Time zone" hint="Digest times follow this time zone." className="sm:col-span-2">
          {(p) => (
            <Select {...p} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setForm(saved)}>
              Reset
            </Button>
          )}
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TestEmailCard({ status }: { status: EmailAdminStatus }) {
  const me = useMe();
  const qc = useQueryClient();
  const [to, setTo] = useState(me?.email ?? '');
  const [messageId, setMessageId] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => api.post<{ id: string }>('/admin/email/test', { to: to.trim() }),
    onSuccess: ({ id }) => setMessageId(id),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const message = useQuery({
    queryKey: ['admin', 'email', 'message', messageId],
    queryFn: () => api.get<EmailMessageInfo>(`/admin/email/messages/${messageId}`),
    enabled: !!messageId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'sent' || q.state.data.status === 'failed') ? false : 1500),
  });
  const outcome = message.data?.status;
  useEffect(() => {
    if (outcome === 'sent') toast.success('Test email sent');
    if (outcome === 'failed') toast.error('The test email could not be sent');
    if (outcome === 'sent' || outcome === 'failed') void qc.invalidateQueries({ queryKey: statusKey });
  }, [outcome, qc]);

  const pending = !!messageId && outcome !== 'sent' && outcome !== 'failed';
  // A test email still queued after a while usually means the transport can't send: say so.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const id = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(id);
  }, [pending, messageId]);

  return (
    <Card>
      <CardHeader title="Send a test email" description="Checks the whole path: the outbox, the transport and your inbox." />
      <form
        className="space-y-3 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          setMessageId(null);
          send.mutate();
        }}
      >
        <Field label="Send to">
          {(p) => (
            <Input
              {...p}
              type="email"
              required
              autoComplete="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={!status.enabled}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="w-full"
          loading={send.isPending}
          disabled={!status.enabled || pending || !to.trim()}
        >
          <Send /> Send test email
        </Button>
        {!status.enabled && <p className="text-xs text-muted-foreground">Set up a transport to send a test email.</p>}
        {messageId && (
          <p role="status" aria-live="polite" className="flex items-start gap-2 text-sm">
            {outcome === 'sent' ? (
              <>
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  Sent to {message.data!.to}.{' '}
                  {status.transport === 'log' ? 'It is in the emails folder and the server log.' : 'Check the inbox (and the spam folder).'}
                </span>
              </>
            ) : outcome === 'failed' ? (
              <>
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span className="min-w-0 break-words">{message.data!.lastError ?? 'Sending failed.'}</span>
              </>
            ) : status.worker && !slow ? (
              <>
                <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Sending…</span>
              </>
            ) : status.worker ? (
              <>
                <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Still queued. Check the delivery status at the top of this page.</span>
              </>
            ) : (
              <>
                <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  Queued. Background delivery is off here, so it goes out with the next delivery run.
                </span>
              </>
            )}
          </p>
        )}
      </form>
    </Card>
  );
}

export default function AdminEmailPage() {
  useTitle('Email');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: () => api.get<EmailAdminStatus>('/admin/email'),
    refetchInterval: 15_000,
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Alerts status={data} />
      <DeliveryCard status={data} />
      <OutboxCard status={data} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SettingsCard key={JSON.stringify(data.settings)} status={data} />
        <TestEmailCard status={data} />
      </div>
    </div>
  );
}
