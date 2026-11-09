import { loops, workflows } from '@talyn/client/native';
import type { LoopRun, LoopWithStats, WorkflowRun, WorkflowWithStats } from '@talyn/shared';
import { useState } from 'react';

import { useWorkspace } from '../../auth/AuthProvider';
import { showActionError } from '../../lib/errors';
import { useRemote, type Remote } from '../more/useRemote';
import { loopToggleInput, withEnabled, workflowToggleInput, type AutomationKind } from './model';

export type AutomationItem = WorkflowWithStats | LoopWithStats;
export const RUN_PAGE = 25;

export function useWorkflowList(enabled = true) {
  const workspace = useWorkspace().selected;
  return useRemote<WorkflowWithStats[]>(enabled && workspace ? `workflows:${workspace}` : null,
    () => workflows.list(workspace ?? ''), { intervalMs: 60_000 });
}
export function useLoopList(enabled = true) {
  const workspace = useWorkspace().selected;
  return useRemote<LoopWithStats[]>(enabled && workspace ? `loops:${workspace}` : null,
    () => loops.list(workspace ?? ''), { intervalMs: 60_000 });
}

/**
 * The enabled switch, as web does it: optimistic, then the server's row. A
 * failure refetches the list, which puts the switch back, and says why.
 */
export function useToggle<T extends AutomationItem>(kind: AutomationKind, list: Remote<T[]>) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const toggle = async (item: T, enabled: boolean) => {
    if (busy[item.id]) return;
    setBusy((prev) => ({ ...prev, [item.id]: true }));
    list.mutate((items) => withEnabled(items, item.id, enabled));
    try {
      const next = kind === 'workflow'
        ? await workflows.update(item.id, workflowToggleInput(item as WorkflowWithStats, enabled))
        : await loops.update(item.id, loopToggleInput(item as LoopWithStats, enabled));
      list.mutate((items) => items.map((row) => row.id === next.id ? next as T : row));
    } catch (error) {
      list.mutate((items) => withEnabled(items, item.id, item.enabled));
      void list.refresh();
      showActionError(enabled ? `Could not turn on the ${kind}` : `Could not turn off the ${kind}`, error);
    } finally {
      setBusy((prev) => { const next = { ...prev }; delete next[item.id]; return next; });
    }
  };
  return { toggle, busy };
}

/** The newest runs of one workflow or loop, read-only. */
export function useRuns(kind: AutomationKind, id: string) {
  return useRemote<Array<WorkflowRun | LoopRun>>(id ? `${kind}-runs:${id}` : null,
    () => kind === 'workflow' ? workflows.runs(id, { limit: RUN_PAGE }) : loops.runs(id, { limit: RUN_PAGE }),
    { intervalMs: 60_000 });
}
