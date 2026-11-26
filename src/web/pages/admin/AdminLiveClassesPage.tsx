import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, PlugZap, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BBB_CHECKSUM_ALGORITHMS,
  LIVE_PROVIDER_DESCRIPTIONS,
  LIVE_PROVIDER_LABELS,
  type LiveAdminInput,
  type LiveAdminSettings,
  type LiveProviderId,
  type LiveProviderStatus,
} from '@shared/live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, Select, Switch, SwitchField, Textarea } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { plural } from '@/lib/utils';

type SecretState = { mode: 'keep' | 'replace' | 'clear'; value: string };
const KEEP: SecretState = { mode: 'keep', value: '' };

/** What to send for a secret: nothing to keep it, the new value, or null to clear it. */
const secretValue = (s: SecretState) => (s.mode === 'replace' && s.value.trim() ? s.value.trim() : s.mode === 'clear' ? null : undefined);

function SecretField({
  label,
  hint,
  isSet,
  state,
  onChange,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  isSet: boolean;
  state: SecretState;
  onChange: (s: SecretState) => void;
  optional?: boolean;
}) {
  if (isSet && state.mode !== 'replace') {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{label}</p>
        <div className="flex flex-wrap items-center gap-2">
          {state.mode === 'clear' ? (
            <Badge variant="warning">Cleared when you save</Badge>
          ) : (
            <Badge variant="success">
              <KeyRound /> Set
            </Badge>
          )}
          <Button type="button" size="xs" variant="outline" onClick={() => onChange({ mode: 'replace', value: '' })}>
            Replace
          </Button>
          {state.mode === 'clear' ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onChange(KEEP)}>
              Keep it
            </Button>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-destructive"
              onClick={() => onChange({ mode: 'clear', value: '' })}
            >
              Clear
            </Button>
          )}
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  }
  return (
    <Field label={label} hint={hint} optional={optional}>
      {(p) => (
        <div className="flex gap-2">
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={state.value}
            onChange={(e) => onChange({ mode: 'replace', value: e.target.value })}
            placeholder={isSet ? 'Enter the new secret' : ''}
          />
          {isSet && (
            <Button type="button" variant="ghost" onClick={() => onChange(KEEP)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={value}>
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error('Copying is blocked in this browser. Select the text instead.');
            }
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function StatusBadge({ enabled, status }: { enabled: boolean; status: LiveProviderStatus }) {
  if (!enabled) return <Badge variant="neutral">Off</Badge>;
  if (status.ready) return <Badge variant="success">Ready</Badge>;
  return <Badge variant="warning">Needs setting up</Badge>;
}

function ProviderCard({
  id,
  data,
  enabled,
  onEnabled,
  status,
  children,
  onSave,
  saving,
  dirty,
}: {
  id: LiveProviderId;
  data: LiveAdminSettings;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  status: LiveProviderStatus;
  children?: ReactNode;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true; message: string }>(`/admin/live/${id}/test`),
    onSuccess: (res) => toast.success(res.message),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const usage = data.usage[id];
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <div className="flex flex-col gap-3 px-5 pt-5 pb-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold tracking-tight">
              {LIVE_PROVIDER_LABELS[id]} <StatusBadge enabled={enabled} status={status} />
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {LIVE_PROVIDER_DESCRIPTIONS[id]} {usage > 0 && `Used by ${plural(usage, 'live class', 'live classes')}.`}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={onEnabled} aria-label={`Turn ${LIVE_PROVIDER_LABELS[id]} on or off`} />
            {enabled ? 'On' : 'Off'}
          </label>
        </div>
        {(children || status.problem || status.note) && (
          <CardContent className="space-y-4">
            {enabled && status.problem && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {status.problem}
              </p>
            )}
            {enabled && status.note && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{status.note}</p>}
            {children}
          </CardContent>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3.5">
          {id !== 'link' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => test.mutate()}
              loading={test.isPending}
              disabled={dirty || !status.ready}
              title={dirty ? 'Save first' : undefined}
            >
              <PlugZap /> Test connection
            </Button>
          )}
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function useSave(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LiveAdminInput) => api.put<LiveAdminSettings>('/admin/live', body),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'live'], data);
      toast.success('Saved');
      onDone?.();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

function BbbCard({ data }: { data: LiveAdminSettings }) {
  const init = () => ({ enabled: data.bbb.enabled, url: data.bbb.url, algorithm: data.bbb.algorithm, analytics: data.bbb.analytics });
  const [form, setForm] = useState(init);
  const [secret, setSecret] = useState<SecretState>(KEEP);
  // Re-read after saving.
  useEffect(() => setForm(init()), [data.bbb.enabled, data.bbb.url, data.bbb.algorithm, data.bbb.analytics]);
  const save = useSave(() => setSecret(KEEP));
  const dirty =
    form.enabled !== data.bbb.enabled ||
    form.url !== data.bbb.url ||
    form.algorithm !== data.bbb.algorithm ||
    form.analytics !== data.bbb.analytics ||
    secret.mode !== 'keep';
  return (
    <ProviderCard
      id="bbb"
      data={data}
      enabled={form.enabled}
      onEnabled={(enabled) => setForm({ ...form, enabled })}
      status={data.bbb}
      dirty={dirty}
      saving={save.isPending}
      onSave={() => save.mutate({ bbb: { ...form, secret: secretValue(secret) } })}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
        <Field
          label="Server URL"
          hint="The address of the BigBlueButton server (2.4 or later) or Scalelite, such as https://bbb.example.edu/bigbluebutton/"
        >
          {(p) => (
            <Input {...p} type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" />
          )}
        </Field>
        <Field label="Checksum algorithm" hint="SHA-1 works everywhere; the others need BigBlueButton 2.5 or later.">
          {(p) => (
            <Select
              {...p}
              value={form.algorithm}
              onChange={(e) => setForm({ ...form, algorithm: e.target.value as typeof form.algorithm })}
            >
              {BBB_CHECKSUM_ALGORITHMS.map((a) => (
                <option key={a} value={a}>
                  {a.toUpperCase().replace('SHA', 'SHA-')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <SecretField
        label="Shared secret"
        hint={
          <>
            On the server, <code className="font-mono">bbb-conf --secret</code> shows it.
          </>
        }
        isSet={data.bbb.secretSet}
        state={secret}
        onChange={setSecret}
      />
      <SwitchField
        label="Attendance from BigBlueButton’s learning analytics"
        description={
          <>
            When a class ends, BigBlueButton sends exact join and leave times (needs the site’s public URL). For that it keeps each
            meeting’s events, chat included, in <code className="font-mono">/var/bigbluebutton/events/</code> on its server and doesn’t
            delete them: remove old ones there as your retention rules require. Turned off, attendance comes from what Coursekit sees while
            a class runs.
          </>
        }
        checked={form.analytics}
        onCheckedChange={(analytics) => setForm({ ...form, analytics })}
      />
    </ProviderCard>
  );
}

/** One host per line (or separated by commas), as the API takes them. */
const hostList = (text: string) =>
  text
    .split(/[\n,;]+/)
    .map((h) => h.trim())
    .filter(Boolean);

function ZoomCard({ data }: { data: LiveAdminSettings }) {
  const z = data.zoom;
  const init = () => ({
    enabled: z.enabled,
    accountId: z.accountId,
    clientId: z.clientId,
    defaultHost: z.defaultHost,
    hosts: z.hosts.join('\n'),
    concurrentMeetings: z.concurrentMeetings,
  });
  const [form, setForm] = useState(init);
  const [clientSecret, setClientSecret] = useState<SecretState>(KEEP);
  const [webhookSecret, setWebhookSecret] = useState<SecretState>(KEEP);
  useEffect(() => setForm(init()), [z.enabled, z.accountId, z.clientId, z.defaultHost, z.hosts.join('\n'), z.concurrentMeetings]);
  const save = useSave(() => {
    setClientSecret(KEEP);
    setWebhookSecret(KEEP);
  });
  const dirty =
    form.enabled !== z.enabled ||
    form.accountId !== z.accountId ||
    form.clientId !== z.clientId ||
    form.defaultHost !== z.defaultHost ||
    hostList(form.hosts).join('\n') !== z.hosts.join('\n') ||
    form.concurrentMeetings !== z.concurrentMeetings ||
    clientSecret.mode !== 'keep' ||
    webhookSecret.mode !== 'keep';
  return (
    <ProviderCard
      id="zoom"
      data={data}
      enabled={form.enabled}
      onEnabled={(enabled) => setForm({ ...form, enabled })}
      status={z}
      dirty={dirty}
      saving={save.isPending}
      onSave={() =>
        save.mutate({
          zoom: {
            ...form,
            hosts: hostList(form.hosts),
            clientSecret: secretValue(clientSecret),
            webhookSecret: secretValue(webhookSecret),
          },
        })
      }
    >
      <p className="text-sm text-muted-foreground">
        Create a Server-to-Server OAuth app in the Zoom App Marketplace with scopes to create, read, update and delete meetings, read cloud
        recordings and, for attendance without webhooks, read meeting reports.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account ID">
          {(p) => (
            <Input {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} autoComplete="off" />
          )}
        </Field>
        <Field label="Client ID">
          {(p) => (
            <Input {...p} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" />
          )}
        </Field>
      </div>
      <SecretField label="Client secret" isSet={z.clientSecretSet} state={clientSecret} onChange={setClientSecret} />
      <Field
        label="Default host"
        hint="The email of the Zoom user who hosts meetings unless a class names another. Teachers and teaching assistants of a class it hosts get its start link, which starts the meeting as this Zoom user."
      >
        {(p) => (
          <Input
            {...p}
            type="email"
            value={form.defaultHost}
            onChange={(e) => setForm({ ...form, defaultHost: e.target.value })}
            placeholder="zoom-host@school.edu"
          />
        )}
      </Field>
      <Field
        label="Other hosts teachers can pick"
        optional
        hint="One email per line: Zoom users shared the same way as the default host. Teachers can also pick their own Zoom account (the email of their instructor account); then only they start the meetings, and other staff join as participants."
      >
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={form.hosts}
            onChange={(e) => setForm({ ...form, hosts: e.target.value })}
            placeholder={'zoom-room-1@school.edu\nzoom-room-2@school.edu'}
          />
        )}
      </Field>
      <Field
        label="Meetings one host can run at once"
        hint="Zoom lets a user host one meeting at a time, or two on Business, Education and Enterprise plans with concurrent meetings. A class with a room per group runs all of them at once, so it needs a host for each group, or for each pair of groups."
      >
        {(p) => (
          <Select
            {...p}
            value={form.concurrentMeetings}
            onChange={(e) => setForm({ ...form, concurrentMeetings: Number(e.target.value) === 2 ? 2 : 1 })}
          >
            <option value={1}>One (Basic and Pro plans)</option>
            <option value={2}>Two (Business, Education and Enterprise plans)</option>
          </Select>
        )}
      </Field>
      <div className="space-y-3 border-t pt-4">
        <p className="text-sm font-medium">Webhooks</p>
        {data.zoomWebhookUrl ? (
          <>
            <p className="text-sm text-muted-foreground">
              In the app’s event subscriptions, add the events Participant joined, Participant left, Meeting ended and Recording completed,
              with this address. Zoom checks it with the secret token.
            </p>
            <CopyRow label="Event notification endpoint URL" value={data.zoomWebhookUrl} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Webhooks need the site’s public URL. Set <code className="font-mono text-foreground">COURSEKIT_PUBLIC_URL</code> and restart
            Coursekit to see the address to copy into Zoom.
          </p>
        )}
        <SecretField
          label="Webhook secret token"
          hint="From the app’s Features page in the Zoom App Marketplace."
          optional
          isSet={z.webhookSecretSet}
          state={webhookSecret}
          onChange={setWebhookSecret}
        />
      </div>
    </ProviderCard>
  );
}

function JitsiCard({ data }: { data: LiveAdminSettings }) {
  const j = data.jitsi;
  const init = () => ({ enabled: j.enabled, url: j.url, appId: j.appId });
  const [form, setForm] = useState(init);
  const [secret, setSecret] = useState<SecretState>(KEEP);
  useEffect(() => setForm(init()), [j.enabled, j.url, j.appId]);
  const save = useSave(() => setSecret(KEEP));
  const dirty = form.enabled !== j.enabled || form.url !== j.url || form.appId !== j.appId || secret.mode !== 'keep';
  return (
    <ProviderCard
      id="jitsi"
      data={data}
      enabled={form.enabled}
      onEnabled={(enabled) => setForm({ ...form, enabled })}
      status={j}
      dirty={dirty}
      saving={save.isPending}
      onSave={() => save.mutate({ jitsi: { ...form, appSecret: secretValue(secret) } })}
    >
      <Field label="Server URL" hint="meet.jit.si opens in a new tab. A server of your own can also be shown inside the class page.">
        {(p) => (
          <Input
            {...p}
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://meet.jit.si"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="App ID"
          optional
          hint="For a self-hosted server with token authentication. Staff get moderator tokens; the server must take moderator rights from them (Prosody’s token_affiliation module)."
        >
          {(p) => <Input {...p} value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} autoComplete="off" />}
        </Field>
        <SecretField
          label="App secret"
          optional
          hint="A random secret of at least 32 characters: every learner gets a token signed with it."
          isSet={j.appSecretSet}
          state={secret}
          onChange={setSecret}
        />
      </div>
    </ProviderCard>
  );
}

function LinkCard({ data }: { data: LiveAdminSettings }) {
  const [enabled, setEnabled] = useState(data.link.enabled);
  useEffect(() => setEnabled(data.link.enabled), [data.link.enabled]);
  const save = useSave();
  return (
    <ProviderCard
      id="link"
      data={data}
      enabled={enabled}
      onEnabled={setEnabled}
      status={data.link}
      dirty={enabled !== data.link.enabled}
      saving={save.isPending}
      onSave={() => save.mutate({ link: { enabled } })}
    >
      <p className="text-sm text-muted-foreground">
        Teachers paste a link for each session or for the whole class. Coursekit records who opens it, but can’t see who is in the meeting.
      </p>
    </ProviderCard>
  );
}

export default function AdminLiveClassesPage() {
  useTitle('Live classes');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'live'],
    queryFn: () => api.get<LiveAdminSettings>('/admin/live'),
  });
  if (isLoading) return <Skeleton className="h-64" />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted-foreground">
        How teachers can run live classes. Teachers only see the ways to meet that are turned on and set up here. Secrets stay on the
        server: this page only shows whether one is set.
      </p>
      {!data.publicUrl && (
        <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium">Set the site’s public URL for callbacks and webhooks</p>
            <p className="text-muted-foreground">
              BigBlueButton callbacks and Zoom webhooks have to reach Coursekit from outside. Set{' '}
              <code className="font-mono text-foreground">COURSEKIT_PUBLIC_URL</code> (or the{' '}
              <code className="font-mono text-foreground">publicUrl</code> option) to the address people use, then restart Coursekit.
              Classes still work without it, with less attendance detail.
            </p>
          </div>
        </Card>
      )}
      <BbbCard data={data} />
      <ZoomCard data={data} />
      <JitsiCard data={data} />
      <LinkCard data={data} />
    </div>
  );
}
