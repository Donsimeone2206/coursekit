import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Plus, Power, PowerOff, Puzzle, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { LtiPlatformDetails, LtiTool, LtiToolDetail, LtiToolInput, LtiToolList } from '@shared/lti';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { ChoiceCards, Field, Input, SwitchField, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { plural } from '@/lib/utils';
import NotFoundPage from '../NotFoundPage';

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function NotConfigured() {
  return (
    <Card className="mb-6 flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="space-y-1">
        <p className="font-medium">Set the site's public URL first</p>
        <p className="text-muted-foreground">
          External tools need to know where Coursekit lives. Set <code className="font-mono text-foreground">COURSEKIT_PUBLIC_URL</code> (or
          the <code className="font-mono text-foreground">publicUrl</code> option) to the address people use, such as
          https://lms.example.edu, then restart Coursekit. Until then, tools can't be launched.
        </p>
      </div>
    </Card>
  );
}

function CopyRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-44 shrink-0 text-sm text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={value ?? undefined}>
        {value ?? '—'}
      </code>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="self-start sm:self-auto"
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
      )}
    </div>
  );
}

function PlatformDetails({ platform, tool }: { platform: LtiPlatformDetails; tool?: LtiTool }) {
  return (
    <Card>
      <CardHeader
        title="Platform details"
        description={
          tool
            ? "Give these to the tool's administrator when they register Coursekit in the tool."
            : 'The client ID and deployment ID appear once the tool is saved.'
        }
      />
      <CardContent className="pb-2">
        <CopyRow label="Issuer" value={platform.issuer} />
        <CopyRow label="Client ID" value={tool?.clientId ?? null} />
        <CopyRow label="Deployment ID" value={tool?.deploymentId ?? null} />
        <CopyRow label="OIDC authorization URL" value={platform.authUrl} />
        <CopyRow label="Access token URL" value={platform.tokenUrl} />
        <CopyRow label="JWKS URL" value={platform.jwksUrl} />
        <CopyRow label="Deep linking return URL" value={platform.deepLinkReturnUrl} />
      </CardContent>
    </Card>
  );
}

export function AdminLtiToolsPage() {
  useTitle('External tools');
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'lti-tools'],
    queryFn: () => api.get<LtiToolList>('/admin/lti/tools'),
  });

  if (isLoading) return <Skeleton className="h-64" />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      {!data.platform.configured && <NotConfigured />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Learning tools from other sites that teachers can add to their courses (LTI 1.3). Coursekit signs people in to the tool and can
          take grades back.
        </p>
        <Button onClick={() => navigate('/admin/external-tools/new')}>
          <Plus /> Add a tool
        </Button>
      </div>
      {data.tools.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="No external tools yet"
          description="Register a tool with the details its provider gives you, then teachers can add it as an activity."
        />
      ) : (
        <div className="grid gap-3">
          {data.tools.map((t) => (
            <Link
              key={t.id}
              to={`/admin/external-tools/${t.id}`}
              className="flex flex-col gap-3 rounded-xl border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-md sm:flex-row sm:items-center"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                <Puzzle className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.status === 'disabled' && <Badge variant="warning">Turned off</Badge>}
                  {t.allowAgs && <Badge variant="info">Grades</Badge>}
                  {t.allowNrps && <Badge variant="violet">Class list</Badge>}
                  {t.deepLinkingUrl && <Badge variant="neutral">Content selection</Badge>}
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted-foreground">{host(t.toolUrl)}</span>
              </span>
              <span className="text-sm text-muted-foreground">{plural(t.activityCount, 'activity', 'activities')}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

interface FormState {
  name: string;
  description: string;
  toolUrl: string;
  loginUrl: string;
  redirectUris: string;
  keyType: 'jwks' | 'key';
  jwksUrl: string;
  publicKey: string;
  deepLinkingUrl: string;
  customParams: string;
  shareName: boolean;
  shareEmail: boolean;
  allowAgs: boolean;
  allowNrps: boolean;
}

const EMPTY: FormState = {
  name: '',
  description: '',
  toolUrl: '',
  loginUrl: '',
  redirectUris: '',
  keyType: 'jwks',
  jwksUrl: '',
  publicKey: '',
  deepLinkingUrl: '',
  customParams: '',
  shareName: true,
  shareEmail: false,
  allowAgs: true,
  allowNrps: false,
};

function toForm(t: LtiTool): FormState {
  return {
    name: t.name,
    description: t.description,
    toolUrl: t.toolUrl,
    loginUrl: t.loginUrl,
    redirectUris: t.redirectUris.join('\n'),
    keyType: t.keyType,
    jwksUrl: t.jwksUrl ?? '',
    publicKey: t.publicKey ?? '',
    deepLinkingUrl: t.deepLinkingUrl ?? '',
    customParams: Object.entries(t.customParams)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    shareName: t.shareName,
    shareEmail: t.shareEmail,
    allowAgs: t.allowAgs,
    allowNrps: t.allowNrps,
  };
}

function toInput(f: FormState): LtiToolInput {
  const lines = (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const customParams: Record<string, string> = {};
  for (const line of lines(f.customParams)) {
    const at = line.indexOf('=');
    if (at > 0) customParams[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    name: f.name,
    description: f.description,
    toolUrl: f.toolUrl.trim(),
    loginUrl: f.loginUrl.trim(),
    redirectUris: lines(f.redirectUris),
    keyType: f.keyType,
    jwksUrl: f.keyType === 'jwks' ? f.jwksUrl.trim() || null : null,
    publicKey: f.keyType === 'key' ? f.publicKey.trim() || null : null,
    deepLinkingUrl: f.deepLinkingUrl.trim() || null,
    customParams,
    shareName: f.shareName,
    shareEmail: f.shareEmail,
    allowAgs: f.allowAgs,
    allowNrps: f.allowNrps,
  };
}

function ToolForm({ tool, onSaved }: { tool?: LtiTool; onSaved: (detail: LtiToolDetail) => void }) {
  const [form, setForm] = useState<FormState>(() => (tool ? toForm(tool) : EMPTY));
  useEffect(() => {
    if (tool) setForm(toForm(tool));
  }, [tool]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const save = useMutation({
    mutationFn: () =>
      tool
        ? api.patch<LtiToolDetail>(`/admin/lti/tools/${tool.id}`, toInput(form))
        : api.post<LtiToolDetail>('/admin/lti/tools', toInput(form)),
    onSuccess: (detail) => {
      toast.success(tool ? 'Tool saved' : `${detail.tool.name} added`);
      onSaved(detail);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const url = (key: 'toolUrl' | 'loginUrl' | 'deepLinkingUrl' | 'jwksUrl') => (p: { id: string }) => (
    <Input {...p} type="url" value={form[key]} onChange={(e) => set(key, e.target.value)} placeholder="https://" />
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <CardHeader
          title={tool ? 'Tool settings' : 'New external tool'}
          description="Copy these from the tool provider's LTI 1.3 setup page."
        />
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              {(p) => (
                <Input
                  {...p}
                  required
                  maxLength={200}
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Coding lab"
                />
              )}
            </Field>
            <Field label="Tool URL" hint="Where launches go unless an activity sets its own URL.">
              {url('toolUrl')}
            </Field>
          </div>
          <Field label="Description" optional hint="Teachers see this when they pick the tool.">
            {(p) => (
              <Textarea {...p} rows={2} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="OIDC login initiation URL">{url('loginUrl')}</Field>
            <Field label="Deep linking URL" optional hint="Lets teachers pick content inside the tool.">
              {url('deepLinkingUrl')}
            </Field>
          </div>
          <Field label="Redirect URIs" hint="One per line. Launches only go to these exact addresses.">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={form.redirectUris}
                onChange={(e) => set('redirectUris', e.target.value)}
                className="font-mono text-[13px]"
                placeholder="https://tool.example/lti/launch"
              />
            )}
          </Field>
          <div className="space-y-3">
            <p className="text-sm font-medium">Tool's public keys</p>
            <ChoiceCards
              columns={2}
              value={form.keyType}
              onChange={(keyType) => set('keyType', keyType)}
              options={[
                { value: 'jwks', label: 'JWKS URL', description: 'Keys are fetched from the tool, so it can rotate them.' },
                { value: 'key', label: 'Public key', description: 'Paste one key as PEM or JWK.' },
              ]}
            />
            {form.keyType === 'jwks' ? (
              <Field label="JWKS URL">{url('jwksUrl')}</Field>
            ) : (
              <Field label="Public key">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={5}
                    value={form.publicKey}
                    onChange={(e) => set('publicKey', e.target.value)}
                    className="font-mono text-[12px]"
                    placeholder="-----BEGIN PUBLIC KEY-----"
                  />
                )}
              </Field>
            )}
          </div>
          <Field label="Custom parameters" optional hint="One per line, as name=value. Sent with every launch of this tool.">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={form.customParams}
                onChange={(e) => set('customParams', e.target.value)}
                className="font-mono text-[13px]"
                placeholder="region=eu"
              />
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <SwitchField
              label="Share names"
              description="Send each person's name to the tool."
              checked={form.shareName}
              onCheckedChange={(v) => set('shareName', v)}
            />
            <SwitchField
              label="Share email addresses"
              description="Send each person's email address to the tool."
              checked={form.shareEmail}
              onCheckedChange={(v) => set('shareEmail', v)}
            />
            <SwitchField
              label="Grades"
              description="Assignment and Grade Services: the tool can send scores to the gradebook."
              checked={form.allowAgs}
              onCheckedChange={(v) => set('allowAgs', v)}
            />
            <SwitchField
              label="Class list"
              description="Names and Role Provisioning Services: the tool can read who is in a course that uses it."
              checked={form.allowNrps}
              onCheckedChange={(v) => set('allowNrps', v)}
            />
          </div>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="submit" loading={save.isPending}>
              {tool ? 'Save changes' : 'Add tool'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

export function AdminLtiToolPage() {
  const { toolId } = useParams();
  const isNew = toolId === 'new';
  const navigate = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'lti-tool', toolId],
    queryFn: () => api.get<LtiToolDetail>(`/admin/lti/tools/${toolId}`),
    enabled: !isNew,
  });
  const list = useQuery({ queryKey: ['admin', 'lti-tools'], queryFn: () => api.get<LtiToolList>('/admin/lti/tools'), enabled: isNew });
  useTitle(isNew ? 'New external tool' : data?.tool.name);

  const refresh = async (detail: LtiToolDetail) => {
    qc.setQueryData(['admin', 'lti-tool', detail.tool.id], detail);
    await qc.invalidateQueries({ queryKey: ['admin', 'lti-tools'] });
  };
  const toggle = useMutation({
    mutationFn: (status: 'active' | 'disabled') => api.patch<LtiToolDetail>(`/admin/lti/tools/${toolId}`, { status }),
    onSuccess: async (detail) => {
      toast.success(detail.tool.status === 'active' ? 'Tool turned on' : 'Tool turned off');
      await refresh(detail);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!isNew && error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (!isNew && (isLoading || (!data && !error))) return <Skeleton className="h-96" />;
  if (!isNew && (error || !data)) return <ErrorState error={error} onRetry={() => refetch()} />;

  const tool = data?.tool;
  const platform = data?.platform ?? list.data?.platform;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link to="/admin/external-tools" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> External tools
        </Link>
        {tool && (
          <div className="flex flex-wrap items-center gap-2">
            {tool.status === 'disabled' && <Badge variant="warning">Turned off</Badge>}
            <span className="text-sm text-muted-foreground">Used by {plural(tool.activityCount, 'activity', 'activities')}</span>
            {tool.status === 'active' ? (
              <Button
                variant="outline"
                loading={toggle.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Turn off ${tool.name}?`,
                    description:
                      'Nobody can launch it and it loses access to grades and class lists until you turn it on again. Activities and grades are kept.',
                    confirmLabel: 'Turn off',
                    destructive: true,
                  });
                  if (ok) toggle.mutate('disabled');
                }}
              >
                <PowerOff /> Turn off
              </Button>
            ) : (
              <Button variant="outline" loading={toggle.isPending} onClick={() => toggle.mutate('active')}>
                <Power /> Turn on
              </Button>
            )}
          </div>
        )}
      </div>
      {platform && !platform.configured && <NotConfigured />}
      {tool && platform && <PlatformDetails platform={platform} tool={tool} />}
      <ToolForm
        tool={tool}
        onSaved={async (detail) => {
          await refresh(detail);
          if (isNew) navigate(`/admin/external-tools/${detail.tool.id}`, { replace: true });
        }}
      />
      {isNew && platform && <PlatformDetails platform={platform} />}
    </div>
  );
}
