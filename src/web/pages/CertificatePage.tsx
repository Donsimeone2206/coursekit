import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Printer, RotateCcw, ShieldCheck, ShieldX } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { Certificate } from '@shared/completion';
import { CertificateSheet, verifyUrl } from '@/components/completion/certificate-sheet';
import { RevokeCertificateDialog } from '@/components/completion/revoke-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';
import { achievementKeys } from '@/lib/achievements';
import { useTitle } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { formatDate } from '@/lib/utils';

/** Print rules: A4 landscape, no margins, and only the certificate itself. */
const PRINT_CSS = `
@page { size: A4 landscape; margin: 0; }
@media print {
  html, body { background: #fff !important; }
  .ck-print-hide { display: none !important; }
  .ck-certificate-page, .ck-certificate-main { padding: 0 !important; margin: 0 !important; max-width: none !important; background: #fff !important; min-height: 0 !important; }
  .ck-certificate { width: 297mm !important; height: 210mm !important; max-width: none !important; border-radius: 0 !important; box-shadow: none !important; break-inside: avoid; }
  .ck-certificate * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

export default function CertificatePage() {
  const { certificateId } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState(false);
  const key = ['certificate', certificateId];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Certificate>(`/certificates/${certificateId}`),
    enabled: !!certificateId,
  });
  useTitle(data ? `Certificate · ${data.courseTitle}` : 'Certificate');

  const refresh = (updated: Certificate) => {
    qc.setQueryData(key, updated);
    void qc.invalidateQueries({ queryKey: achievementKeys.myCertificates });
    if (updated.course) void qc.invalidateQueries({ queryKey: ['course', updated.course.slug] });
  };
  const restore = useMutation({
    mutationFn: () => api.post<Certificate>(`/certificates/${certificateId}/restore`),
    onSuccess: (updated) => {
      toast.success('Certificate restored');
      refresh(updated);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const own = data && me?.id === data.recipient.id;
  const back =
    data?.course && !own
      ? { to: `/courses/${data.course.slug}/completion`, label: data.course.title }
      : { to: '/profile', label: 'Your profile' };
  const copyLink = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(verifyUrl(data.code));
      toast.success('Verification link copied');
    } catch {
      toast.error('Could not copy the link. Select it from the certificate instead.');
    }
  };

  return (
    <div className="ck-certificate-page min-h-dvh bg-muted/70">
      <style>{PRINT_CSS}</style>
      <header className="ck-print-hide sticky top-0 z-10 border-b bg-background/85 backdrop-blur-lg">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          <Button asChild variant="ghost" size="sm" className="-ml-2 min-w-0">
            <Link to={back.to}>
              <ArrowLeft /> <span className="truncate">{back.label}</span>
            </Link>
          </Button>
          {data && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {data.canManage &&
                (data.revokedAt ? (
                  <Button variant="outline" size="sm" onClick={() => restore.mutate()} loading={restore.isPending}>
                    <RotateCcw /> Restore
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
                    <ShieldX /> Revoke
                  </Button>
                ))}
              {!data.revokedAt && (
                <>
                  <Button variant="outline" size="sm" onClick={copyLink}>
                    <Copy /> <span className="hidden sm:inline">Copy verification link</span>
                    <span className="sm:hidden">Copy link</span>
                  </Button>
                  <Button size="sm" onClick={() => window.print()}>
                    <Printer /> Download PDF
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="ck-certificate-main mx-auto max-w-[1180px] px-4 py-6 sm:px-6 sm:py-10">
        {error ? (
          error instanceof ApiError && error.status === 404 ? (
            <EmptyState
              icon={ShieldX}
              title="Certificate not found"
              description="It may have been removed, or it belongs to someone else."
              action={
                <Button asChild variant="outline">
                  <Link to="/profile">Your certificates</Link>
                </Button>
              }
            />
          ) : (
            <ErrorState error={error} onRetry={() => refetch()} />
          )
        ) : isLoading || !data ? (
          <Skeleton className="aspect-[297/210] w-full" />
        ) : (
          <>
            {data.revokedAt ? (
              <div
                role="status"
                className="ck-print-hide mb-5 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm"
              >
                <ShieldX className="mt-0.5 size-4.5 shrink-0 text-destructive" />
                <p>
                  <span className="font-semibold">This certificate was revoked on {formatDate(data.revokedAt, { year: 'numeric' })}.</span>{' '}
                  {data.revokeReason ? `Reason: ${data.revokeReason}` : 'It no longer counts as proof of completion.'}
                </p>
              </div>
            ) : (
              <p className="ck-print-hide mb-5 flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0 text-success" />
                <span>
                  Anyone can check this certificate at{' '}
                  <Link
                    to={`/verify/${data.code}`}
                    className="font-medium text-foreground underline-offset-2 wrap-anywhere hover:underline"
                  >
                    {window.location.host}/verify/{data.code}
                  </Link>
                </span>
              </p>
            )}
            <CertificateSheet content={data} revoked={!!data.revokedAt} />
            {!data.revokedAt && (
              <p className="ck-print-hide mt-5 text-center text-xs text-muted-foreground">
                Download PDF opens your browser’s print dialog: choose <span className="font-medium">Save as PDF</span>. The page is set to
                A4 landscape.
              </p>
            )}
          </>
        )}
      </main>
      {data && revoking && <RevokeCertificateDialog certificate={data} open={revoking} onOpenChange={setRevoking} onDone={refresh} />}
    </div>
  );
}
