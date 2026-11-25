import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CalendarDays, CalendarRange, Info, Mail, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EMAIL_CATEGORIES, type EmailCategoryId, type EmailFrequency, type EmailPreferences } from '@shared/email';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ChoiceCards, SwitchField } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

export const emailPreferencesKey = ['email', 'preferences'] as const;

function scheduleText(next: EmailPreferences['nextDigests']) {
  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(next.weekly));
  return {
    daily: `One summary a day, around ${time(next.daily)}`,
    weekly: `One summary every ${weekday}, around ${time(next.weekly)}`,
  };
}

/** Profile card: how often to email notifications, and which kinds. */
export function EmailPreferencesCard() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: emailPreferencesKey,
    queryFn: () => api.get<EmailPreferences>('/email/preferences'),
  });
  const [frequency, setFrequency] = useState<EmailFrequency | null>(null);
  const [disabled, setDisabled] = useState<EmailCategoryId[] | null>(null);

  // Emails link to /profile?section=email: bring this card into view once it has loaded.
  const loaded = !!data;
  useEffect(() => {
    if (loaded && params.get('section') === 'email') ref.current?.scrollIntoView({ block: 'start' });
  }, [loaded, params]);

  const save = useMutation({
    mutationFn: (body: { frequency: EmailFrequency; disabledCategories: EmailCategoryId[] }) =>
      api.put<EmailPreferences>('/email/preferences', body),
    onSuccess: (prefs) => {
      qc.setQueryData(emailPreferencesKey, prefs);
      setFrequency(null);
      setDisabled(null);
      toast.success('Email preferences saved');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const header = (
    <CardHeader
      title="Email notifications"
      description="Choose whether we email you about activity in your courses, and how often."
      icon={<Mail className="size-4.5" />}
    />
  );

  if (error) {
    return (
      <Card ref={ref} id="email" className="scroll-mt-20">
        {header}
        <div className="px-5 pb-5">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card ref={ref} id="email" className="scroll-mt-20">
        {header}
        <div className="space-y-3 px-5 pb-5">
          <Skeleton className="h-28" />
          <Skeleton className="h-40" />
        </div>
      </Card>
    );
  }

  const currentFrequency = frequency ?? data.frequency;
  const currentDisabled = disabled ?? data.disabledCategories;
  const dirty =
    currentFrequency !== data.frequency ||
    currentDisabled.length !== data.disabledCategories.length ||
    currentDisabled.some((c) => !data.disabledCategories.includes(c));
  const schedule = scheduleText(data.nextDigests);
  const off = currentFrequency === 'off';

  return (
    <Card ref={ref} id="email" className="scroll-mt-20">
      {header}
      <form
        className="space-y-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ frequency: currentFrequency, disabledCategories: currentDisabled });
        }}
      >
        {!data.deliveryEnabled && (
          <p className="flex gap-2.5 rounded-lg bg-muted px-3.5 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              This site isn&apos;t sending email yet, so for now you&apos;ll see notifications here in the app. Your choices apply as soon
              as email is turned on.
            </span>
          </p>
        )}

        <fieldset className="space-y-2.5">
          <legend className="mb-2.5 text-sm font-medium">How often</legend>
          <ChoiceCards<EmailFrequency>
            value={currentFrequency}
            onChange={setFrequency}
            columns={2}
            options={[
              {
                value: 'immediately',
                label: 'Immediately',
                description: 'An email for each new notification',
                icon: <Zap className="size-4" />,
              },
              { value: 'daily', label: 'Daily digest', description: schedule.daily, icon: <CalendarDays className="size-4" /> },
              { value: 'weekly', label: 'Weekly digest', description: schedule.weekly, icon: <CalendarRange className="size-4" /> },
              { value: 'off', label: 'Off', description: 'Only see notifications in the app', icon: <BellOff className="size-4" /> },
            ]}
          />
          {data.isDefault && frequency === null && <p className="text-xs text-muted-foreground">This is your site&apos;s default.</p>}
        </fieldset>

        <fieldset className="space-y-2" disabled={off}>
          <legend className="mb-1 text-sm font-medium">What to email you about</legend>
          <p className="mb-2.5 text-xs text-muted-foreground">
            {off ? 'Turn email on to choose what it covers.' : 'Switch off anything you would rather only see in the app.'}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {EMAIL_CATEGORIES.map((category) => (
              <SwitchField
                key={category.id}
                label={category.label}
                description={category.description}
                checked={!off && !currentDisabled.includes(category.id)}
                disabled={off}
                onCheckedChange={(on) =>
                  setDisabled(on ? currentDisabled.filter((c) => c !== category.id) : [...currentDisabled, category.id])
                }
              />
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-xs break-words text-muted-foreground">
            Emails go to <span className="font-medium text-foreground">{data.address}</span>.
          </p>
          <Button type="submit" loading={save.isPending} disabled={!dirty} className="self-end sm:self-auto">
            Save email preferences
          </Button>
        </div>
      </form>
    </Card>
  );
}
