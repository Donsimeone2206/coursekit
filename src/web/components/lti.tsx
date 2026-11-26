import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MousePointerClick, Puzzle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { LtiLaunchInfo, LtiToolOption } from '@shared/lti';
import type { ActivityDetail, CourseDetail, LtiSettings } from '@shared/types';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChoiceCards, Field, Input, Select, SwitchField, Textarea } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useInvalidateCourse } from '@/pages/course/context';

/** Messages from the deep linking result page (it runs in the tool's window, which has no opener). */
const CHANNEL = 'coursekit-lti';

interface DeepLinkMessage {
  type: 'coursekit-lti-deep-link';
  courseId: string;
  activityIds: string[];
  msg: string | null;
  errormsg: string | null;
}

function customToText(custom: Record<string, string>) {
  return Object.entries(custom)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToCustom(text: string): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    custom[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return custom;
}

/** External tool settings in the activity editor. */
export function LtiFields({
  course,
  sectionId,
  activityId,
  settings,
  onSettings,
  maxGrade,
  onMaxGrade,
  onSelected,
}: {
  course: CourseDetail;
  /** Where content selected in the tool goes (new activities). */
  sectionId?: string;
  /** The activity being edited. */
  activityId?: string;
  settings: LtiSettings;
  onSettings: (patch: Partial<LtiSettings>) => void;
  maxGrade: string;
  onMaxGrade: (value: string) => void;
  /** Content was selected in the tool and Coursekit saved it. */
  onSelected: () => void;
}) {
  const invalidate = useInvalidateCourse();
  const [customText, setCustomText] = useState(() => customToText(settings.custom));
  const { data: tools, isLoading } = useQuery({
    queryKey: ['lti-tools', course.id],
    queryFn: () => api.get<LtiToolOption[]>(`/courses/${course.id}/lti/tools`),
  });
  const tool = tools?.find((t) => t.id === settings.toolId) ?? null;
  // The latest callbacks, so the channel isn't reopened on every render.
  const latest = useRef({ onSelected, invalidate });
  useEffect(() => {
    latest.current = { onSelected, invalidate };
  });

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = async (event: MessageEvent<DeepLinkMessage>) => {
      const data = event.data;
      if (data?.type !== 'coursekit-lti-deep-link' || data.courseId !== course.id) return;
      if (data.errormsg) toast.error(data.errormsg);
      if (data.activityIds.length)
        toast.success(data.msg || (activityId ? 'Activity updated from the tool' : 'Content added from the tool'));
      else if (!data.errormsg) toast.info(data.msg || 'Nothing was selected in the tool.');
      await latest.current.invalidate(course.slug);
      if (data.activityIds.length) latest.current.onSelected();
    };
    return () => channel.close();
  }, [course.id, course.slug, activityId]);

  const selectContent = () => {
    if (!tool) return;
    const params = new URLSearchParams({ courseId: course.id, toolId: tool.id });
    if (activityId) params.set('activityId', activityId);
    else if (sectionId) params.set('sectionId', sectionId);
    window.open(`/lti/deep-link/start?${params}`, 'coursekit-lti-select', 'popup,width=1024,height=760');
  };

  if (isLoading) return <Skeleton className="h-24" />;
  if (!tools?.length) {
    return (
      <Card className="flex items-start gap-3 p-4 text-sm">
        <Puzzle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          No external tools yet. An administrator can add them under{' '}
          <span className="font-medium text-foreground">Administration → External tools</span>.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Tool">
          {(p) => (
            <Select {...p} required value={settings.toolId ?? ''} onChange={(e) => onSettings({ toolId: e.target.value || null })}>
              <option value="">Choose a tool…</option>
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.status === 'disabled' ? ' (turned off)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {tool?.deepLinking && (
          <Button type="button" variant="outline" onClick={selectContent} disabled={tool.status !== 'active'}>
            <MousePointerClick /> Select content
          </Button>
        )}
      </div>
      {tool?.deepLinking && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {activityId
            ? 'Opens the tool in a new window. What you pick there replaces this activity’s content.'
            : 'Opens the tool in a new window. What you pick there is added to this section straight away.'}
        </p>
      )}
      {tool?.description && <p className="-mt-2 text-xs text-muted-foreground">{tool.description}</p>}
      <Field label="Launch URL" optional hint="Leave empty to use the tool's own URL. It must be on the tool's domain.">
        {(p) => (
          <Input
            {...p}
            value={settings.launchUrl ?? ''}
            onChange={(e) => onSettings({ launchUrl: e.target.value || null })}
            placeholder={tool?.toolUrl ?? 'https://'}
          />
        )}
      </Field>
      <Field label="Custom parameters" optional hint="One per line, as name=value. They are sent to the tool with every launch.">
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              onSettings({ custom: textToCustom(e.target.value) });
            }}
            placeholder="chapter=3"
            className="font-mono text-[13px]"
          />
        )}
      </Field>
      <ChoiceCards
        columns={2}
        value={settings.presentation}
        onChange={(presentation) => onSettings({ presentation })}
        options={[
          { value: 'window', label: 'New window', description: 'Students open the tool with a button.' },
          { value: 'embed', label: 'Embedded', description: 'The tool shows inside the activity page.' },
        ]}
      />
      <SwitchField
        label="Graded"
        description={
          tool && !tool.grades
            ? "This tool isn't allowed to send grades to the gradebook. Administrators decide which tools can."
            : 'The tool sends scores to the gradebook.'
        }
        checked={maxGrade !== ''}
        onCheckedChange={(on) => onMaxGrade(on ? '100' : '')}
      />
      {maxGrade !== '' && (
        <Field label="Maximum points" className="sm:w-48">
          {(p) => <Input {...p} type="number" min={0} value={maxGrade} onChange={(e) => onMaxGrade(e.target.value)} />}
        </Field>
      )}
    </>
  );
}

/** The activity page of an External tool: a launch button, or the tool embedded in the page. */
export function LtiView({ activity }: { activity: ActivityDetail<'lti'> }) {
  const { data: info, isLoading } = useQuery({
    queryKey: ['lti-launch', activity.id],
    queryFn: () => api.get<LtiLaunchInfo>(`/lti/activities/${activity.id}`),
  });
  const grade = info?.grade;

  return (
    <div className="space-y-6">
      {activity.description && (
        <Card className="p-6">
          <Markdown source={activity.description} />
        </Card>
      )}
      {grade && grade.score != null && activity.myRole === 'student' && (
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-4 text-sm">
          <span className="text-muted-foreground">Your grade</span>
          <span className="text-lg font-semibold tabular-nums">
            {grade.score} / {grade.maxGrade}
          </span>
          {grade.feedback && <span className="w-full text-muted-foreground">{grade.feedback}</span>}
        </Card>
      )}
      {isLoading || !info ? (
        <Skeleton className="h-40" />
      ) : !info.available ? (
        <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>{info.problem}</p>
        </Card>
      ) : info.presentation === 'embed' ? (
        <div className="space-y-3">
          <iframe
            src={info.embedUrl}
            title={info.toolName ?? activity.title}
            className="h-[75vh] min-h-[420px] w-full rounded-xl border bg-white"
            allow="fullscreen; clipboard-write; autoplay; microphone; camera"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
          />
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <a href={info.windowUrl} target="_blank" rel="noopener">
                Open in a new window <ExternalLink />
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
            <Puzzle className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{info.toolName}</p>
            <p className="text-sm text-muted-foreground">
              Opens in a new window. You're signed in to the tool with your Coursekit account.
            </p>
          </div>
          <Button asChild>
            <a href={info.windowUrl} target="_blank" rel="noopener">
              Launch <ExternalLink />
            </a>
          </Button>
        </Card>
      )}
    </div>
  );
}
