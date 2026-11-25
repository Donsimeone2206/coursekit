import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GraduationCap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { SiteSettings } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, SwitchField, Textarea } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { cn, contrastRatio, contrastText } from '@/lib/utils';

const SWATCHES = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#16a34a', '#d97706', '#ea580c', '#dc2626', '#db2777', '#9333ea', '#0f172a'];

export default function AdminSettingsPage() {
  useTitle('Site settings');
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<SiteSettings>('/admin/settings') });
  const [form, setForm] = useState<SiteSettings | null>(null);
  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => api.put<SiteSettings>('/admin/settings', form),
    onSuccess: async (settings) => {
      setForm(settings);
      toast.success('Site settings saved');
      await qc.invalidateQueries({ queryKey: ['session'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!form) return <Skeleton className="h-96" />;
  const dirty = JSON.stringify(form) !== JSON.stringify(data);
  const validColor = /^#[0-9a-fA-F]{6}$/.test(form.brandColor);

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-6">
        <Card>
          <CardHeader title="Identity" description="Your site's name and messaging." />
          <div className="space-y-4 px-5 pb-5">
            <Field label="Site name">
              {(p) => <Input {...p} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </Field>
            <Field label="Tagline" hint="Shown on the sign-in page.">
              {(p) => <Input {...p} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} />}
            </Field>
            <Field label="Dashboard welcome message">
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  value={form.welcomeMessage}
                  onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
                />
              )}
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Brand colour" description="Used for buttons, links and highlights across the site." />
          <div className="space-y-4 px-5 pb-5">
            <div className="flex flex-wrap gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, brandColor: c })}
                  className={cn(
                    'grid size-9 place-items-center rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110',
                    form.brandColor.toLowerCase() === c && 'ring-2 ring-foreground',
                  )}
                  style={{ background: c }}
                  aria-label={`Use ${c}`}
                >
                  {form.brandColor.toLowerCase() === c && <Check className="size-4" style={{ color: contrastText(c) }} strokeWidth={3} />}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={validColor ? form.brandColor : '#4f46e5'}
                onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
                className="size-9 cursor-pointer rounded-lg border bg-card p-1"
                aria-label="Custom colour"
              />
              <Input
                value={form.brandColor}
                onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
                className="w-32 font-mono"
                aria-label="Hex colour"
              />
              {!validColor && <span className="text-xs text-destructive">Use a 6-digit hex colour</span>}
            </div>
            {validColor && contrastRatio(form.brandColor, '#ffffff') < 4.5 && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                This colour is light for text on white ({contrastRatio(form.brandColor, '#ffffff').toFixed(1)}:1). Links and labels may be
                hard to read; a darker shade is more accessible.
              </p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Access" />
          <div className="px-5 pb-5">
            <SwitchField
              label="Allow self-registration"
              description="Anyone can create a student account from the sign-in page. Turn off to add people yourself."
              checked={form.allowSignup}
              onCheckedChange={(allowSignup) => setForm({ ...form, allowSignup })}
            />
          </div>
        </Card>
      </div>

      <div className="space-y-4 lg:sticky lg:top-20">
        <Card className="overflow-hidden">
          <p className="border-b px-5 py-3 text-xs font-medium text-muted-foreground">Preview</p>
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-2.5">
              <span
                className="grid size-8 place-items-center rounded-[10px] text-white"
                style={{
                  background: validColor ? form.brandColor : undefined,
                  color: validColor ? contrastText(form.brandColor) : undefined,
                }}
              >
                <GraduationCap className="size-[18px]" />
              </span>
              <span className="font-semibold">{form.name || 'Your site'}</span>
            </div>
            <p className="text-sm text-muted-foreground">{form.tagline}</p>
            <div className="flex gap-2">
              <span
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{
                  background: validColor ? form.brandColor : undefined,
                  color: validColor ? contrastText(form.brandColor) : undefined,
                }}
              >
                Primary button
              </span>
              <span
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{ color: validColor ? form.brandColor : undefined, background: validColor ? `${form.brandColor}1a` : undefined }}
              >
                Soft
              </span>
            </div>
          </div>
        </Card>
        <Button type="submit" className="w-full" loading={save.isPending} disabled={!dirty || !validColor}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
