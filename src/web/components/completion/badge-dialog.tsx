import { useMutation, useQuery } from '@tanstack/react-query';
import { Flag, Hand, Library, Medal, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BADGE_COLORS,
  BADGE_ICONS,
  type BadgeColor,
  type BadgeCriteria,
  type BadgeDetail,
  type BadgeIcon,
  type BadgeSummary,
} from '@shared/completion';
import type { AdminCourseRow, Paginated } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Checkbox, ChoiceCards, Field, Input, Textarea } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { cn } from '@/lib/utils';
import { BADGE_COLOR_META, BADGE_ICON_META, BadgeArt } from './badge-art';

export type BadgeScope = { kind: 'course'; courseId: string } | { kind: 'site' };

function IconPicker({ value, onChange }: { value: BadgeIcon; onChange: (v: BadgeIcon) => void }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">Icon</legend>
      <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
        {BADGE_ICONS.map((key) => {
          const meta = BADGE_ICON_META[key];
          const selected = key === value;
          return (
            <label
              key={key}
              title={meta.label}
              className={cn(
                'grid aspect-square cursor-pointer place-items-center rounded-lg border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary/25',
                selected && 'border-primary bg-primary/[0.06] text-primary',
              )}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={selected}
                onChange={() => onChange(key)}
                aria-label={meta.label}
              />
              <meta.icon className="size-4.5" aria-hidden />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ColorPicker({ value, onChange }: { value: BadgeColor; onChange: (v: BadgeColor) => void }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">Colour</legend>
      <div className="flex flex-wrap gap-2">
        {BADGE_COLORS.map((key) => {
          const meta = BADGE_COLOR_META[key];
          const selected = key === value;
          return (
            <label
              key={key}
              title={meta.label}
              className={cn(
                'size-8 cursor-pointer rounded-full ring-offset-2 ring-offset-popover transition-transform hover:scale-110 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary',
                selected && 'ring-2 ring-foreground',
              )}
              style={{ backgroundImage: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={selected}
                onChange={() => onChange(key)}
                aria-label={meta.label}
              />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CoursePicker({ selected, onToggle }: { selected: string[]; onToggle: (id: string, checked: boolean) => void }) {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'courses', 'all'],
    queryFn: () => api.get<Paginated<AdminCourseRow>>('/admin/courses?pageSize=100'),
  });
  const chosen = new Set(selected);
  const courses = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.items ?? []).filter((c) => !term || c.title.toLowerCase().includes(term));
  }, [data, q]);
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-1.5 text-sm font-medium">Courses to complete</legend>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a course" className="pl-9" aria-label="Find a course" />
      </div>
      {isLoading ? (
        <Skeleton className="h-32" />
      ) : (
        <ul className="ck-scrollbar max-h-52 divide-y overflow-y-auto rounded-lg border">
          {courses.map((c) => {
            const id = `badge-course-${c.id}`;
            return (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox id={id} checked={chosen.has(c.id)} onCheckedChange={(v) => onToggle(c.id, v === true)} />
                <span className="size-3 shrink-0 rounded-[4px]" style={coverDot(c.coverColor)} />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                  {c.title}
                </label>
                {c.visibility !== 'published' && <span className="text-xs text-muted-foreground capitalize">{c.visibility}</span>}
              </li>
            );
          })}
          {courses.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">No courses match.</li>}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {selected.length === 0 ? 'Choose at least one course.' : `Awarded once someone completes all ${selected.length} of them.`}
      </p>
    </fieldset>
  );
}

/** Create or edit a course badge (teachers) or a site badge (administrators). */
export function BadgeFormDialog({
  open,
  onOpenChange,
  scope,
  badge,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: BadgeScope;
  badge?: BadgeSummary;
  onSaved?: (badge: BadgeDetail) => void;
}) {
  const [name, setName] = useState(badge?.name ?? '');
  const [description, setDescription] = useState(badge?.description ?? '');
  const [icon, setIcon] = useState<BadgeIcon>(badge?.icon ?? 'award');
  const [color, setColor] = useState<BadgeColor>(badge?.color ?? 'gold');
  const [criteria, setCriteria] = useState<BadgeCriteria>(badge?.criteria ?? 'manual');
  const [courseIds, setCourseIds] = useState<string[]>(badge?.criteriaCourses.map((c) => c.id) ?? []);
  const isSite = scope.kind === 'site';

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, icon, color, criteria, courseIds: criteria === 'courses' ? courseIds : [] };
      if (badge) return api.patch<BadgeDetail>(`/badges/${badge.id}`, body);
      return api.post<BadgeDetail>(scope.kind === 'course' ? `/courses/${scope.courseId}/badges` : '/badges', body);
    },
    onSuccess: (saved) => {
      const auto = saved.recipientCount && saved.criteria !== 'manual' && saved.recipientCount > (badge?.recipientCount ?? 0);
      toast.success(badge ? 'Badge saved' : `Created “${saved.name}”`, {
        description: auto
          ? `Awarded to ${saved.recipientCount} ${saved.recipientCount === 1 ? 'person' : 'people'} who already qualify.`
          : undefined,
      });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const criteriaOptions = isSite
    ? [
        {
          value: 'manual' as const,
          label: 'Awarded by administrators',
          description: 'You give it to people by hand.',
          icon: <Hand className="size-4" />,
        },
        {
          value: 'courses' as const,
          label: 'On completing courses',
          description: 'Automatic, once someone completes every course you choose.',
          icon: <Library className="size-4" />,
        },
      ]
    : [
        {
          value: 'manual' as const,
          label: 'Awarded by teachers',
          description: 'From the badge page or the participants list.',
          icon: <Hand className="size-4" />,
        },
        {
          value: 'completion' as const,
          label: 'On course completion',
          description: 'Automatic, when a student completes this course.',
          icon: <Flag className="size-4" />,
        },
      ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader
            icon={<Medal className="size-5" />}
            title={badge ? 'Edit badge' : isSite ? 'New site badge' : 'New course badge'}
            description={isSite ? 'Site badges recognise achievements across courses.' : 'Celebrate achievements in this course.'}
          />
          <DialogBody className="space-y-5">
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              <div className="flex w-32 shrink-0 flex-col items-center rounded-xl border bg-muted/40 px-3 py-4 text-center">
                <BadgeArt icon={icon} color={color} size={84} />
                <p className="mt-2 line-clamp-2 text-xs font-semibold break-words">{name.trim() || 'Badge name'}</p>
              </div>
              <div className="w-full min-w-0 flex-1 space-y-4">
                <Field label="Name">
                  {(p) => (
                    <Input
                      {...p}
                      autoFocus
                      required
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Bug hunter"
                    />
                  )}
                </Field>
                <Field label="Description" optional hint="What someone did to earn it.">
                  {(p) => (
                    <Textarea
                      {...p}
                      rows={2}
                      maxLength={500}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="min-h-0"
                    />
                  )}
                </Field>
              </div>
            </div>
            <IconPicker value={icon} onChange={setIcon} />
            <ColorPicker value={color} onChange={setColor} />
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-sm font-medium">How it’s earned</legend>
              <ChoiceCards<BadgeCriteria> columns={2} value={criteria} onChange={setCriteria} options={criteriaOptions} />
            </fieldset>
            {isSite && criteria === 'courses' && (
              <CoursePicker
                selected={courseIds}
                onToggle={(id, checked) => setCourseIds((ids) => (checked ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)))}
              />
            )}
            {criteria !== 'manual' && (
              <p className="text-xs text-muted-foreground">
                Anyone who already qualifies receives it when you save. Staff can also award it by hand.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim() || (criteria === 'courses' && courseIds.length === 0)}>
              {badge ? 'Save badge' : 'Create badge'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
