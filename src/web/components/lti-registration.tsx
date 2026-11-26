import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { CircleCheck, ExternalLink, Info, LoaderCircle, Puzzle, TriangleAlert, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { LtiTool } from '@shared/lti';
import type { LtiRegisteredTool, LtiRegistrationStarted, LtiRegistrationState, LtiToolRegistration } from '@shared/lti-registration';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn, formatDate, formatDateTime } from '@/lib/utils';

/**
 * The message a tool posts to window.parent when it is done. Only the frame can send it: the new window is
 * opened without an opener (so the tool's page can't navigate Coursekit away), and the dialog notices that the
 * tool has registered by checking every 2 seconds instead.
 */
const CLOSE_SUBJECT = 'org.imsglobal.lti.close';
const AGS = 'https://purl.imsglobal.org/spec/lti-ags/scope/';
const NRPS = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const NAME_CLAIMS = ['name', 'given_name', 'family_name'];

/** Plain words for the service scopes a tool can ask for. */
export const SCOPE_LABELS: Record<string, string> = {
  [`${AGS}lineitem`]: 'create and change grade columns',
  [`${AGS}lineitem.readonly`]: 'read grade columns',
  [`${AGS}result.readonly`]: 'read results',
  [`${AGS}score`]: 'send scores',
  [NRPS]: 'read the class list',
};

export const isGradeScope = (scope: string) => scope.startsWith(AGS);
export const isClassListScope = (scope: string) => scope === NRPS;
const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const registeredKey = ['admin', 'lti-registrations'] as const;

/** Tools that registered themselves, by tool ID. */
export function useRegisteredTools() {
  return useQuery({ queryKey: registeredKey, queryFn: () => api.get<LtiRegisteredTool[]>('/admin/lti/registrations') });
}

/** What a tool asked for when it registered itself; null for tools added by hand. */
export function useToolRegistration(toolId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'lti-tool-registration', toolId],
    queryFn: async () => {
      try {
        return await api.get<LtiToolRegistration>(`/admin/lti/tools/${toolId}/registration`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: !!toolId && toolId !== 'new',
  });
}

function isCloseMessage(data: unknown): boolean {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return !!value && typeof value === 'object' && (value as { subject?: unknown }).subject === CLOSE_SUBJECT;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const fetchState = (qc: QueryClient, id: string) =>
  qc.fetchQuery({
    queryKey: ['admin', 'lti-registration', id],
    queryFn: () => api.get<LtiRegistrationState>(`/admin/lti/registrations/${id}`),
    staleTime: 0,
  });

/**
 * Registers a tool with LTI Dynamic Registration: the administrator pastes the tool's registration URL,
 * Coursekit opens it in a frame (or a new window when the tool can't be framed), and the tool registers
 * itself. When the tool in the frame posts its close message, or once a tool in a new window has registered,
 * the dialog closes and shows the new tool.
 */
export function RegisterToolDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [started, setStarted] = useState<LtiRegistrationStarted | null>(null);
  const [mode, setMode] = useState<'frame' | 'window'>('frame');
  const frame = useRef<HTMLIFrameElement>(null);
  const finishing = useRef(false);

  const start = useMutation({
    mutationFn: () => api.post<LtiRegistrationStarted>('/admin/lti/registrations', { url: url.trim() }),
    onSuccess: (s) => {
      finishing.current = false;
      setStarted(s);
      setMode('frame');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const state = useQuery({
    queryKey: ['admin', 'lti-registration', started?.id],
    queryFn: () => api.get<LtiRegistrationState>(`/admin/lti/registrations/${started!.id}`),
    enabled: !!started,
    refetchInterval: (q) => ((q.state.data?.status ?? 'pending') === 'pending' ? 2000 : false),
  });
  const status = state.data?.status ?? 'pending';

  const refreshLists = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'lti-tools'] }), qc.invalidateQueries({ queryKey: registeredKey })]);

  const reset = () => {
    setStarted(null);
    setMode('frame');
  };

  /** Leaves the dialog. A registration the tool hasn't used is cancelled, so its token stops working. */
  const cancel = () => {
    if (started && status !== 'completed') void api.delete(`/admin/lti/registrations/${started.id}`).catch(() => {});
    void refreshLists();
    reset();
    setUrl('');
    onOpenChange(false);
  };

  /** The tool is done (it posted its close message, or registered from a new window), or the administrator chose to review it. */
  const finish = async () => {
    if (!started || finishing.current) return;
    finishing.current = true;
    const id = started.id;
    let latest: LtiRegistrationState | null = null;
    try {
      latest = await fetchState(qc, id);
      // The tool posts the message once its registration went through; allow a moment for a slow one.
      if (latest.status === 'pending') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        latest = await fetchState(qc, id);
      }
    } catch {
      latest = null;
    }
    await refreshLists();
    reset();
    setUrl('');
    onOpenChange(false);
    if (latest?.status === 'completed' && latest.toolId) {
      toast.success(`${latest.toolName ?? 'The tool'} is registered. Check its details, then turn it on.`);
      navigate(`/admin/external-tools/${latest.toolId}`);
    } else {
      if (latest?.status === 'pending') void api.delete(`/admin/lti/registrations/${id}`).catch(() => {});
      toast.error('The tool closed without registering. You can try again, or add it by hand.');
    }
  };
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });

  // Only the registration frame may close the dialog.
  useEffect(() => {
    if (!started) return;
    const onMessage = (event: MessageEvent) => {
      if (!event.source || event.source !== frame.current?.contentWindow) return;
      if (isCloseMessage(event.data)) void finishRef.current();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [started]);

  // A tool in a new window can't send the close message: show the new tool as soon as it has registered.
  useEffect(() => {
    if (mode === 'window' && status === 'completed') void finishRef.current();
  }, [mode, status]);

  const openWindow = () => {
    if (!started) return;
    // noopener: the tool's page gets no handle on Coursekit's window (window.open then returns null, so a
    // blocked pop-up can't be detected either).
    window.open(started.openUrl, '_blank', 'noopener,popup,width=1024,height=760');
    setMode('window');
  };

  const host = started ? hostOf(started.openUrl) : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
        else onOpenChange(true);
      }}
    >
      <DialogContent
        size={started ? 'xl' : 'md'}
        // A stray click next to the tool's page shouldn't throw the registration away.
        onInteractOutside={(e) => {
          if (started) e.preventDefault();
        }}
      >
        {!started ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              start.mutate();
            }}
          >
            <DialogHeader
              icon={<Wand2 className="size-5" />}
              title="Register a tool with a URL"
              description="Tools that support LTI Dynamic Registration give you a registration URL. Coursekit opens it, and the tool sets itself up."
            />
            <DialogBody className="space-y-4">
              <Field label="Registration URL" hint="Copy it from the tool's LTI 1.3 setup page.">
                {(p) => (
                  <Input
                    {...p}
                    type="url"
                    required
                    autoFocus
                    maxLength={2000}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://tool.example.com/lti/register"
                  />
                )}
              </Field>
              <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                The tool is added turned off. You'll see what it asks for, can change its settings and then turn it on.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" loading={start.isPending}>
                Open registration page
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader
              icon={<Wand2 className="size-5" />}
              title={`Register ${host}`}
              description="Follow the steps on the tool's page. When it's done, this closes and you can check the new tool."
            />
            <DialogBody className="space-y-2">
              {mode === 'frame' ? (
                <>
                  <iframe
                    ref={frame}
                    src={started.openUrl}
                    title={`Registration page of ${host}`}
                    className="h-[min(62dvh,640px)] w-full rounded-lg border bg-white"
                    // No allow-top-navigation: the tool's page can't navigate Coursekit away. Windows it opens get no
                    // opener either, because Coursekit's pages send Cross-Origin-Opener-Policy: same-origin.
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  />
                  <p className="text-xs text-muted-foreground">
                    Page blank, or asking you to sign in again? Some tools don't work inside another site: open it in a new window instead.
                  </p>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
                  <ExternalLink className="size-6 text-muted-foreground" />
                  <p className="max-w-md text-sm text-muted-foreground">
                    The tool's page opened in a new window. Finish there: once the tool has registered, this dialog closes by itself and
                    shows the new tool.
                  </p>
                  <p className="max-w-md text-xs text-muted-foreground">
                    No new window, or you closed it? Allow pop-ups for this site if your browser blocked it, then open it again.
                  </p>
                  <Button variant="outline" size="sm" onClick={openWindow}>
                    <ExternalLink /> Open it again
                  </Button>
                </div>
              )}
            </DialogBody>
            <div className="flex flex-col gap-3 px-6 pt-4 pb-6 sm:flex-row sm:items-center sm:justify-between">
              <RegistrationStatus status={status} toolName={state.data?.toolName ?? null} expiresAt={started.expiresAt} />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={cancel}>
                  {status === 'completed' ? 'Close' : 'Cancel'}
                </Button>
                {status === 'expired' ? (
                  <Button type="button" onClick={reset}>
                    Start again
                  </Button>
                ) : status === 'completed' ? (
                  <Button type="button" onClick={() => void finish()}>
                    Review the tool
                  </Button>
                ) : (
                  mode === 'frame' && (
                    <Button type="button" variant="secondary" onClick={openWindow}>
                      <ExternalLink /> Open in a new window
                    </Button>
                  )
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RegistrationStatus({ status, toolName, expiresAt }: { status: string; toolName: string | null; expiresAt: string }) {
  if (status === 'completed') {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CircleCheck className="size-4 shrink-0" /> {toolName ?? 'The tool'} has registered.
      </p>
    );
  }
  if (status === 'expired') {
    return (
      <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4 shrink-0" /> This registration expired. Start again to get a new link.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 shrink-0 animate-spin" /> Waiting for the tool (the link works until {formatDateTime(expiresAt)})
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function Note({ tone, children }: { tone: 'warning' | 'info'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'mb-3 flex gap-3 rounded-xl border px-4 py-3 text-sm',
        tone === 'warning' && 'border-amber-500/25 bg-amber-500/8 text-amber-900 dark:text-amber-200',
        tone === 'info' && 'border-sky-500/25 bg-sky-500/8 text-sky-900 dark:text-sky-200',
      )}
    >
      {tone === 'warning' ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}

function ToolLogo({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
        <Puzzle className="size-5" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className="size-10 shrink-0 rounded-xl border bg-white object-contain p-1"
      onError={() => setFailed(true)}
    />
  );
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** What a tool that registered itself asked for, for the administrator's review. */
export function ToolRegistrationCard({ registration: r, tool }: { registration: LtiToolRegistration; tool: LtiTool }) {
  const dropped = r.requestedScopes.filter((s) => !r.grantedScopes.includes(s) && s !== 'openid');
  const grades = r.grantedScopes.filter(isGradeScope);
  const classList = r.grantedScopes.some(isClassListScope);
  const names = r.requestedClaims.some((c) => NAME_CLAIMS.includes(c));
  const emails = r.requestedClaims.includes('email');
  const contentSelection = r.messages.some((m) => m.used && m.type === 'LtiDeepLinkingRequest');
  const ignoredMessages = r.messages.filter((m) => !m.used);
  const links = [
    { href: r.clientUri, label: 'Website' },
    { href: r.policyUri, label: 'Privacy policy' },
    { href: r.tosUri, label: 'Terms of use' },
  ].filter((l): l is { href: string; label: string } => !!l.href);

  return (
    <Card>
      <CardHeader
        title="Registered automatically"
        description={`It registered itself on ${formatDate(r.registeredAt)}${
          r.startedBy ? ` (started by ${r.startedBy.name})` : ''
        }. This is what it asked for.`}
        action={<Badge variant="info">Dynamic Registration</Badge>}
      />
      <CardContent className="pb-3">
        {tool.status === 'disabled' && (
          <Note tone="info">
            Check what it asks for and the settings below, then choose <span className="font-medium">Turn on</span>. Until then nobody can
            use it.
          </Note>
        )}
        {r.outsideDomains.length > 0 && (
          <Note tone="warning">
            Some of its addresses aren't on the domain it gave ({r.domain}): {r.outsideDomains.join(', ')}. Make sure they belong to the
            tool's provider.
          </Note>
        )}
        <dl className="divide-y">
          <Row label="Tool">
            <span className="flex items-start gap-3">
              <ToolLogo src={r.logoUri} />
              <span className="min-w-0">
                <span className="block font-medium">{r.clientName || tool.name}</span>
                {r.description && <span className="mt-0.5 block text-muted-foreground">{r.description}</span>}
              </span>
            </span>
          </Row>
          <Row label="Domain">
            <code className="font-mono text-[13px]">{r.domain}</code>
            {r.secondaryDomains.length > 0 && <span className="text-muted-foreground"> and {r.secondaryDomains.join(', ')}</span>}
          </Row>
          <Row label="Services">
            {grades.length === 0 && !classList ? (
              <span className="text-muted-foreground">None: launches only.</span>
            ) : (
              <ul className="space-y-0.5">
                {grades.length > 0 && <li>Grades: {grades.map(scopeLabel).join(', ')}</li>}
                {classList && <li>Class list: read who is in the courses that use it</li>}
              </ul>
            )}
            {dropped.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Not supported by Coursekit, so it won't get: <span className="break-all">{dropped.join(', ')}</span>
              </p>
            )}
          </Row>
          <Row label="Personal data">
            {names || emails ? (
              <>{capitalize([names && 'names', emails && 'email addresses'].filter(Boolean).join(' and '))}, and an ID for each person.</>
            ) : (
              <span className="text-muted-foreground">Only an ID for each person, no names or email addresses.</span>
            )}
          </Row>
          <Row label="Content selection">
            {contentSelection ? 'Yes: teachers can pick content inside the tool.' : <span className="text-muted-foreground">No</span>}
            {ignoredMessages.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Not supported, so left out: {ignoredMessages.map((m) => [m.type, ...m.placements].join(' ')).join(', ')}
              </p>
            )}
          </Row>
          {r.contacts.length > 0 && (
            <Row label="Contacts">
              {r.contacts.map((email, i) => (
                <span key={email}>
                  {i > 0 && ', '}
                  <a href={`mailto:${email}`} className="text-primary hover:underline">
                    {email}
                  </a>
                </span>
              ))}
            </Row>
          )}
          {links.length > 0 && (
            <Row label="Links">
              <span className="flex flex-wrap gap-x-4 gap-y-1">
                {links.map((l) => (
                  <a key={l.label} href={l.href} {...external} className="inline-flex items-center gap-1 text-primary hover:underline">
                    {l.label} <ExternalLink className="size-3.5" />
                  </a>
                ))}
              </span>
            </Row>
          )}
          <Row label="Registration URL">
            <code className="font-mono text-[13px] break-all">{r.url}</code>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

/** The description of the Grades or Class list switch for a tool that registered itself. */
export function registeredServiceHint(granted: string[] | null | undefined, service: 'grades' | 'classList'): string | null {
  if (!granted) return null;
  const scopes = granted.filter(service === 'grades' ? isGradeScope : isClassListScope);
  if (scopes.length === 0) {
    return service === 'grades'
      ? "This tool didn't ask for grades when it registered, so it can't use them."
      : "This tool didn't ask for the class list when it registered, so it can't use it.";
  }
  return service === 'grades' ? `Only what it asked for: ${scopes.map(scopeLabel).join(', ')}.` : 'It asked to read the class list.';
}
