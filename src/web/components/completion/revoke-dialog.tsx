import { useMutation } from '@tanstack/react-query';
import { ShieldX } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Certificate } from '@shared/completion';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

/** Asks for an optional reason, then revokes the certificate. */
export function RevokeCertificateDialog({
  certificate,
  open,
  onOpenChange,
  onDone,
}: {
  certificate: Pick<Certificate, 'id' | 'recipientName'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: (updated: Certificate) => void;
}) {
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => api.post<Certificate>(`/certificates/${certificate.id}/revoke`, { reason: reason.trim() || null }),
    onSuccess: (updated) => {
      toast.success(`Revoked ${certificate.recipientName}’s certificate`);
      setReason('');
      onOpenChange(false);
      onDone?.(updated);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            revoke.mutate();
          }}
        >
          <DialogHeader
            icon={<ShieldX className="size-5" />}
            title="Revoke this certificate?"
            description={`${certificate.recipientName}’s certificate will show as revoked to anyone who checks its code. You can restore it later.`}
          />
          <DialogBody>
            <Field label="Reason" optional hint="Shown to the student and to staff, never on the public verification page.">
              {(p) => <Textarea {...p} rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={revoke.isPending}>
              Revoke certificate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
