import { useQuery } from '@tanstack/react-query';
import { SearchCheck, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatCertificateCode, normalizeCertificateCode, type CertificateVerification } from '@shared/completion';
import { certificateDate } from '@/components/completion/certificate-sheet';
import { Logo } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/form';
import { Spinner } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function Result({ code }: { code: string }) {
  const normalized = normalizeCertificateCode(code);
  const { data, isLoading, error } = useQuery({
    queryKey: ['verify', normalized],
    queryFn: () => api.get<CertificateVerification>(`/certificates/verify/${normalized}`),
    enabled: !!normalized,
    retry: false,
  });
  if (normalized && isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" /> Checking…
      </div>
    );
  }
  if (!normalized || (error instanceof ApiError && error.status === 404)) {
    return (
      <div role="status" className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-sm">
          <p className="font-semibold">No certificate matches this code</p>
          <p className="mt-1 text-muted-foreground">
            Check that you typed all 12 characters as printed on the certificate, for example 7QK2-M9XD-4TPA.
          </p>
        </div>
      </div>
    );
  }
  if (error || !data) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;
  const valid = data.valid;
  return (
    <div
      role="status"
      className={cn(
        'rounded-xl border p-4 sm:p-5',
        valid ? 'border-success/35 bg-success/[0.07]' : 'border-destructive/35 bg-destructive/[0.06]',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-full',
            valid ? 'bg-success/15 text-success' : 'bg-destructive/12 text-destructive',
          )}
        >
          {valid ? <ShieldCheck className="size-5" /> : <ShieldX className="size-5" />}
        </span>
        <div>
          <p className="font-semibold">{valid ? 'Valid certificate' : 'This certificate has been revoked'}</p>
          <p className="text-sm text-muted-foreground">
            {valid ? 'Issued by this site for completing a course.' : 'It no longer counts as proof of completion.'}
          </p>
        </div>
      </div>
      <dl className="mt-4 space-y-2.5 border-t pt-4">
        <Detail label="Awarded to">{data.recipientName}</Detail>
        <Detail label="Course">{data.courseTitle}</Detail>
        <Detail label="Completed">{certificateDate(data.completedAt)}</Detail>
        <Detail label="Code">
          <span className="font-mono">{data.code}</span>
        </Detail>
      </dl>
    </div>
  );
}

/** Public page: anyone can check a certificate code without signing in. */
export default function VerifyCertificatePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [value, setValue] = useState(code ?? '');
  useTitle('Verify a certificate');
  const siteName = session?.site.name ?? 'Coursekit';

  return (
    <div className="ck-dots grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mx-auto flex w-fit">
          <Logo name={siteName} />
        </Link>
        <Card className="mt-6 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <SearchCheck className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Verify a certificate</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">Enter the code printed at the bottom of the certificate.</p>
            </div>
          </div>
          <form
            className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const normalized = normalizeCertificateCode(value);
              navigate(`/verify/${normalized ? formatCertificateCode(normalized) : encodeURIComponent(value.trim())}`, { replace: !!code });
            }}
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="certificate-code">Certificate code</Label>
              <Input
                id="certificate-code"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="font-mono tracking-wider uppercase placeholder:normal-case placeholder:tracking-normal"
                required
              />
            </div>
            <Button type="submit" disabled={!value.trim()}>
              Verify
            </Button>
          </form>
          {code && (
            <div className="mt-5" aria-live="polite">
              <Result key={code} code={code} />
            </div>
          )}
        </Card>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Certificates are issued by {siteName}.{' '}
          <Link to="/" className="font-medium text-primary hover:underline">
            Go to the site
          </Link>
        </p>
      </div>
    </div>
  );
}
