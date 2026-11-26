import type { QueryClient } from '@tanstack/react-query';
import type { ActivityDetail } from '@shared/types';

/** What the activity editor can change that the class page shows from its own query: provider, link, join window, groups. */
function setupOf(activity: ActivityDetail | undefined): string | undefined {
  return (
    activity && JSON.stringify([activity.settings, activity.completion, activity.visible, activity.groupMode, activity.groupRestriction])
  );
}

/**
 * Saving a live class in the activity editor refetches the activity, not the class page's sessions: refreshes those
 * once the class's setup changed. Returns the unsubscribe function, for an effect.
 */
export function refreshOnSetupChange(qc: QueryClient, activityId: string): () => void {
  let shown = setupOf(qc.getQueryData<ActivityDetail>(['activity', activityId]));
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [kind, id] = event.query.queryKey;
    if (kind !== 'activity' || id !== activityId) return;
    const setup = setupOf(event.query.state.data as ActivityDetail | undefined);
    if (setup === shown) return;
    const edited = shown !== undefined;
    shown = setup;
    if (edited) void qc.invalidateQueries({ queryKey: ['live', activityId] });
  });
}
