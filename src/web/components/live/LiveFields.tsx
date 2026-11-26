import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, Video } from 'lucide-react';
import { useEffect, useId } from 'react';
import { LIVE_PROVIDER_LABELS, REMINDER_CHOICES, type LiveProviderId, type LiveProviderOption, type LiveSettings } from '@shared/live';
import type { CompletionMode, CourseDetail, GroupMode } from '@shared/types';
import { useCourseGroups } from '@/components/groups';
import { Card } from '@/components/ui/card';
import { ChoiceCards, Field, Input, Label, Select, SwitchField, Textarea } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';

const JOIN_CHOICES = [0, 5, 10, 15, 30, 60];

export function reminderLabel(minutes: number): string {
  if (minutes === 1440) return '1 day before';
  if (minutes === 60) return '1 hour before';
  return `${minutes} minutes before`;
}

/** Live class settings in the activity editor. Teachers only see the providers an administrator set up. */
export function LiveFields({
  course,
  settings,
  onSettings,
  completion,
  groupMode,
  groupIds,
}: {
  course: CourseDetail;
  settings: LiveSettings;
  onSettings: (patch: Partial<LiveSettings>) => void;
  completion: CompletionMode;
  /** The class's group mode in effect, and the groups it is limited to: which groups get a room of their own. */
  groupMode: GroupMode;
  groupIds: string[];
}) {
  const hostsListId = useId();
  const { data: providers, isLoading } = useQuery({
    queryKey: ['live-providers', course.id],
    queryFn: () => api.get<LiveProviderOption[]>(`/live/providers?courseId=${encodeURIComponent(course.id)}`),
  });
  const zoomRooms = settings.provider === 'zoom' && groupMode !== 'none';
  const { data: courseGroups } = useCourseGroups(zoomRooms ? course.id : undefined);
  const first = providers?.[0]?.id;
  // A new class starts with the first provider the site offers.
  useEffect(() => {
    if (first && !settings.provider) onSettings({ provider: first });
  }, [first, settings.provider, onSettings]);

  if (isLoading) return <Skeleton className="h-24" />;
  if (!providers?.length) {
    return (
      <Card className="flex items-start gap-3 p-4 text-sm">
        <Video className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          No way to meet is set up yet. An administrator can turn on BigBlueButton, Zoom, Jitsi Meet or meeting links under{' '}
          <span className="font-medium text-foreground">Administration → Live classes</span>.
        </p>
      </Card>
    );
  }
  const current = providers.find((p) => p.id === settings.provider) ?? null;
  // Zoom with a room per group: each group's meeting runs at the same time, so they need hosts of their own.
  const groupHosts = settings.zoomGroupHosts ?? {};
  const roomGroups =
    zoomRooms && current?.groupRooms ? (courseGroups?.groups ?? []).filter((g) => groupIds.length === 0 || groupIds.includes(g.id)) : [];
  const classHost = settings.zoomHost || current?.defaultHost || '';
  const limit = current?.concurrentMeetings ?? 1;
  const perHost = new Map<string, number>();
  for (const g of roomGroups) {
    const host = (groupHosts[g.id] || classHost).trim().toLowerCase();
    if (host) perHost.set(host, (perHost.get(host) ?? 0) + 1);
  }
  const crowded = [...perHost.values()].some((rooms) => rooms > limit);
  const setGroupHost = (groupId: string, host: string) => {
    const next = { ...groupHosts };
    if (host.trim()) next[groupId] = host;
    else delete next[groupId];
    onSettings({ zoomGroupHosts: next });
  };

  return (
    <>
      <div className="space-y-2">
        <Label>How the class meets</Label>
        <ChoiceCards<LiveProviderId>
          columns={2}
          value={(settings.provider ?? '') as LiveProviderId}
          onChange={(provider) => onSettings({ provider })}
          options={providers.map((p) => ({ value: p.id, label: p.label, description: p.description }))}
        />
        {settings.provider && !current && (
          <p className="text-xs text-destructive">
            {LIVE_PROVIDER_LABELS[settings.provider]} isn’t available on this site any more. Pick another way to meet.
          </p>
        )}
      </div>
      {settings.provider === 'link' && (
        <Field label="Meeting link" optional hint="Used for every session without a link of its own. Students only get it when they join.">
          {(p) => (
            <Input
              {...p}
              type="url"
              value={settings.meetingUrl ?? ''}
              onChange={(e) => onSettings({ meetingUrl: e.target.value || null })}
              placeholder="https://meet.google.com/…"
            />
          )}
        </Field>
      )}
      {settings.provider === 'zoom' && (
        <>
          <Field
            label="Zoom host"
            optional
            hint={`The Zoom user whose account hosts the meetings: the site’s default host (leave empty for ${current?.defaultHost ?? 'it'}), another host an administrator added, or your own Zoom account. Staff start the meetings of the site’s hosts; when you are the host, other staff join as participants.`}
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                list={hostsListId}
                value={settings.zoomHost ?? ''}
                onChange={(e) => onSettings({ zoomHost: e.target.value || null })}
                placeholder={current?.defaultHost ?? 'teacher@school.edu'}
              />
            )}
          </Field>
          {roomGroups.length > 0 && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Zoom host for each group</legend>
              <p className="text-xs text-muted-foreground">
                Every group’s room meets at the same time, and Zoom lets one user host{' '}
                {limit === 1 ? 'only one meeting' : 'at most two meetings'} at a time. Leave a group empty to use the class’s host.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {roomGroups.map((g) => (
                  <Field key={g.id} label={g.name} optional>
                    {(p) => (
                      <Input
                        {...p}
                        type="email"
                        list={hostsListId}
                        value={groupHosts[g.id] ?? ''}
                        onChange={(e) => setGroupHost(g.id, e.target.value)}
                        placeholder={classHost}
                      />
                    )}
                  </Field>
                ))}
              </div>
              {crowded && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  More groups share a host than Zoom can run at once, so some groups won’t get in. Give them hosts of their own.
                </p>
              )}
            </fieldset>
          )}
          <datalist id={hostsListId}>
            {(current?.hosts ?? []).map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </>
      )}
      {current?.embeddable && (
        <SwitchField
          label="Show the meeting on the class page"
          description="People join inside Coursekit instead of in a new tab."
          checked={settings.embed}
          onCheckedChange={(embed) => onSettings({ embed })}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Students can join" hint="Staff can start a session at any time.">
          {(p) => (
            <Select {...p} value={settings.joinMinutesBefore} onChange={(e) => onSettings({ joinMinutesBefore: Number(e.target.value) })}>
              {[...new Set([...JOIN_CHOICES, settings.joinMinutesBefore])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'When it starts' : `${m} minutes before it starts`}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Reminder" hint="Sent to students who can see the class.">
          {(p) => (
            <Select
              {...p}
              value={settings.reminderMinutes ?? ''}
              onChange={(e) => onSettings({ reminderMinutes: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">No reminder</option>
              {[...new Set([...REMINDER_CHOICES, ...(settings.reminderMinutes ? [settings.reminderMinutes] : [])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {reminderLabel(m)}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </div>
      {current?.waitForModerator && (
        <SwitchField
          label="Students wait for a teacher"
          description="Students can only get in once a teacher or teaching assistant has started the session."
          checked={settings.waitForModerator}
          onCheckedChange={(waitForModerator) => onSettings({ waitForModerator })}
        />
      )}
      {current?.recordings && (
        <Field label="Recording">
          {(p) => (
            <Select
              {...p}
              value={settings.recording}
              onChange={(e) => onSettings({ recording: e.target.value as LiveSettings['recording'] })}
            >
              <option value="off">Don’t record</option>
              <option value="manual">Teachers start and stop recording</option>
              <option value="auto">Record every session automatically</option>
            </Select>
          )}
        </Field>
      )}
      {settings.provider === 'bbb' && (
        <Field label="Welcome message" optional hint="Shown in the chat when people join.">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              maxLength={2000}
              value={settings.welcomeMessage}
              onChange={(e) => onSettings({ welcomeMessage: e.target.value })}
            />
          )}
        </Field>
      )}
      {completion === 'auto' && (
        <Field label="Sessions to attend" hint="Students complete the class once they attend this many sessions." className="sm:w-64">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={1}
              max={300}
              value={settings.attendanceRequired}
              onChange={(e) => onSettings({ attendanceRequired: Math.max(1, Number(e.target.value) || 1) })}
            />
          )}
        </Field>
      )}
    </>
  );
}
