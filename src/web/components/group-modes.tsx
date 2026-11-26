import { UsersRound } from 'lucide-react';
import { GROUP_MODE_DESCRIPTIONS, GROUP_MODE_LABELS, GROUP_MODES, DELETED_GROUP_NAME } from '@shared/group-modes';
import type { GroupChoice, GroupMode, GroupRef } from '@shared/types';
import { cn } from '@/lib/utils';
import { useCourseGroups } from './groups';
import { Badge } from './ui/badge';
import { Checkbox, Field, Select } from './ui/form';

/** "Groups: Team A, Team B" for staff, on an activity that only some groups can see. */
export function GroupRestrictionBadge({ groups, className }: { groups: GroupRef[] | undefined; className?: string }) {
  if (!groups?.length) return null;
  const names = groups.map((g) => g.name).join(', ');
  return (
    <Badge variant="info" className={cn('relative max-w-56', className)} title={`Only members of ${names} can see this`}>
      <UsersRound />
      <span className="truncate">Groups: {names}</span>
    </Badge>
  );
}

/** The group a discussion belongs to, in a forum with groups. */
export function DiscussionGroupBadge({ group }: { group: GroupRef | null | undefined }) {
  return (
    <Badge variant={group ? 'info' : 'neutral'} className="max-w-48" title={group ? group.name : 'For all participants'}>
      <UsersRound />
      <span className="truncate">{group ? group.name : 'All participants'}</span>
    </Badge>
  );
}

/** Course default group mode, for course settings. */
export function GroupModeSelect({ id, value, onChange }: { id?: string; value: GroupMode; onChange: (mode: GroupMode) => void }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as GroupMode)}>
      {GROUP_MODES.map((m) => (
        <option key={m} value={m}>
          {GROUP_MODE_LABELS[m]}
        </option>
      ))}
    </Select>
  );
}

/**
 * Picks a group to look at. The first option is everyone the viewer may see: "All participants", or "All my groups"
 * in separate groups mode for people who only see their own groups. Renders nothing when there are no groups.
 */
export function GroupPicker({
  choice,
  value,
  onChange,
  className,
}: {
  choice: GroupChoice | undefined;
  value: string;
  onChange: (groupId: string) => void;
  className?: string;
}) {
  if (!choice?.groups.length) return null;
  return (
    <Select aria-label="Show group" value={value} onChange={(e) => onChange(e.target.value)} className={cn('sm:w-56', className)}>
      <option value="">{choice.allParticipants ? 'All participants' : 'All my groups'}</option>
      {choice.groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </Select>
  );
}

/** Activity editor fields: the activity's group mode and the groups it is limited to. */
export function ActivityGroupFields({
  courseId,
  courseMode,
  mode,
  onModeChange,
  groupIds,
  onGroupIdsChange,
}: {
  courseId: string;
  courseMode: GroupMode;
  mode: GroupMode | null;
  onModeChange: (mode: GroupMode | null) => void;
  groupIds: string[];
  onGroupIdsChange: (ids: string[]) => void;
}) {
  const { data } = useCourseGroups(courseId);
  const groups: GroupRef[] = data?.groups ?? [];
  // A restriction can still name a group that was deleted: show it so it can be removed.
  const missing = groupIds.filter((id) => !groups.some((g) => g.id === id)).map((id) => ({ id, name: DELETED_GROUP_NAME }));
  const options = [...groups, ...missing];
  const effective = mode ?? courseMode;
  const toggle = (id: string, on: boolean) => onGroupIdsChange(on ? [...groupIds, id] : groupIds.filter((g) => g !== id));

  return (
    <div className="space-y-4 border-t pt-5">
      <Field label="Group mode" hint={GROUP_MODE_DESCRIPTIONS[effective]}>
        {(p) => (
          <Select {...p} value={mode ?? ''} onChange={(e) => onModeChange((e.target.value || null) as GroupMode | null)}>
            <option value="">Course default ({GROUP_MODE_LABELS[courseMode].toLowerCase()})</option>
            {GROUP_MODES.map((m) => (
              <option key={m} value={m}>
                {GROUP_MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {options.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Only for these groups</legend>
          <p className="text-xs text-muted-foreground">
            {groupIds.length
              ? 'Students outside these groups won’t see this activity, and it won’t count towards their grades or progress.'
              : 'Leave all unticked to make it available to everyone.'}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((g) => (
              <label key={g.id} className="flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm">
                <Checkbox checked={groupIds.includes(g.id)} onCheckedChange={(v) => toggle(g.id, v === true)} />
                <span className="truncate">{g.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
