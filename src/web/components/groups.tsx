import { useQuery } from '@tanstack/react-query';
import { UsersRound } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { CourseGroups, GroupRef } from '@shared/types';
import { api } from '@/lib/api';
import { cn, colorFor, initials } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Select } from './ui/form';

export const groupsKey = (courseId: string | undefined) => ['groups', courseId] as const;

/** The course's groups as the viewer may see them (every group for staff, their own for students). */
export function useCourseGroups(courseId: string | undefined) {
  return useQuery({
    queryKey: groupsKey(courseId),
    queryFn: () => api.get<CourseGroups>(`/courses/${courseId}/groups`),
    enabled: !!courseId,
  });
}

/** Rounded tile with a group's initials, coloured like user avatars. */
export function GroupTile({ group, className }: { group: GroupRef; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-xl text-xs font-semibold text-white shadow-xs',
        colorFor(group.id),
        className,
      )}
    >
      {initials(group.name)}
    </span>
  );
}

/** A person's groups as small badges. Renders nothing when there are none. */
export function GroupBadges({ groups, className }: { groups: GroupRef[] | undefined; className?: string }) {
  if (!groups?.length) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {groups.map((g) => (
        <Badge key={g.id} variant="outline" className="max-w-44" title={g.name}>
          <UsersRound />
          <span className="truncate">{g.name}</span>
        </Badge>
      ))}
    </span>
  );
}

/**
 * State for filtering a list of people by group. `matches(userId)` is true for everyone while no group is
 * chosen, and stays that way if the chosen group disappears.
 */
export function useGroupFilter(courseId: string | undefined) {
  const { data } = useCourseGroups(courseId);
  const [groupId, setGroupId] = useState('');
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const active = groups.find((g) => g.id === groupId) ?? null;
  const memberIds = useMemo(() => (active ? new Set(active.members.map((m) => m.id)) : null), [active]);
  const matches = useCallback((userId: string) => !memberIds || memberIds.has(userId), [memberIds]);
  return { groups, groupId: active ? groupId : '', setGroupId, active, matches };
}

export type GroupFilterState = ReturnType<typeof useGroupFilter>;

/** "All groups" picker for {@link useGroupFilter}. Renders nothing when there are no groups to choose from. */
export function GroupFilter({
  filter,
  onChange,
  className,
}: {
  filter: GroupFilterState;
  onChange?: (groupId: string) => void;
  className?: string;
}) {
  if (filter.groups.length === 0) return null;
  return (
    <Select
      aria-label="Filter by group"
      value={filter.groupId}
      onChange={(e) => {
        filter.setGroupId(e.target.value);
        onChange?.(e.target.value);
      }}
      className={cn('sm:w-52', className)}
    >
      <option value="">All groups</option>
      {filter.groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name} ({g.members.length})
        </option>
      ))}
    </Select>
  );
}
