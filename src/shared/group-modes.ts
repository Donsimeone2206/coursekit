/** Group modes, shared by the server and the web UI. */
import type { GroupMode } from './types.js';

export const GROUP_MODES: readonly GroupMode[] = ['none', 'separate', 'visible'];

export const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  none: 'No groups',
  separate: 'Separate groups',
  visible: 'Visible groups',
};

export const GROUP_MODE_DESCRIPTIONS: Record<GroupMode, string> = {
  none: 'Everyone works together as one class.',
  separate: 'Students only see their own groups. Teaching assistants only see the groups they are in.',
  visible: 'Everyone can see every group, but students only take part in their own groups.',
};

/** Shown instead of the name of a group that was deleted but is still used by a restriction or a discussion. */
export const DELETED_GROUP_NAME = 'Deleted group';
