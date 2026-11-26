import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { OpenBadgesAdminInfo, OpenBadgesIssuerSettings } from '@shared/open-badges';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { openBadgeKeys } from './share-panel';

/** Administration: who the site's Open Badges say issued them. */
export function OpenBadgesIssuerCard() {
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey: openBadgeKeys.admin,
    queryFn: () => api.get<OpenBadgesAdminInfo>('/admin/open-badges'),
  });
  const [form, setForm] = useState<OpenBadgesIssuerSettings | null>(null);
  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);
  const save = useMutation({
    mutationFn: () => api.put<OpenBadgesAdminInfo>('/admin/open-badges', form),
    onSuccess: (info) => {
      qc.setQueryData(openBadgeKeys.admin, info);
      setForm(info.settings);
      toast.success('Issuer details saved');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card className="mt-8">
      <CardHeader
        title="Open Badges issuer"
        description="People can share the badges they earn as Open Badges, to import into a backpack, LinkedIn or a digital wallet. These details say who issued them."
        icon={<Globe className="size-4.5" />}
      />
      <div className="px-5 pb-5">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data || !form ? (
          <Skeleton className="h-48" />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {data.publicUrl ? (
              <p className="text-sm text-muted-foreground">
                {data.activeShares} {data.activeShares === 1 ? 'badge is' : 'badges are'} shared right now. Issuer profile:{' '}
                <a href={data.issuerUrl ?? undefined} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
                  {data.issuerUrl}
                </a>
              </p>
            ) : (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                Sharing is off until the site’s public address is set with COURSEKIT_PUBLIC_URL (for example https://learn.example.org).
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Issuer name" hint={`Leave empty to use the site name (${data.defaults.name}).`}>
                {(p) => (
                  <Input
                    {...p}
                    value={form.name}
                    maxLength={120}
                    placeholder={data.defaults.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Contact email"
                hint={
                  data.defaults.email
                    ? `Published in the public issuer profile of every shared badge (Open Badges 2.0 requires one). Leave empty to publish ${data.defaults.email}, the address outgoing email is sent from.`
                    : 'Published in the public issuer profile of every shared badge (Open Badges 2.0 requires one).'
                }
              >
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    value={form.email}
                    placeholder={data.defaults.email ?? 'badges@example.org'}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label="Description" optional>
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  maxLength={1000}
                  value={form.description}
                  placeholder="Who you are, in a sentence or two."
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              )}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={save.isPending} disabled={JSON.stringify(form) === JSON.stringify(data.settings)}>
                Save issuer details
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
