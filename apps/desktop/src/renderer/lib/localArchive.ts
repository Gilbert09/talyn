import type { Workbench } from '@talyn/shared';
import { getDeviceId, getWorkbenchBridge } from './workbenchBridge';
import { useWorkbenchStore } from '../stores/workbenches';

const dialogArchives = new Set<string>();
const pending = new Map<string, Promise<void>>();

export function markDialogArchive(id: string, active: boolean): void {
  if (active) dialogArchives.add(id);
  else dialogArchives.delete(id);
}

/** Update the local record when the server reports an archived session. */
export function reconcileLocalArchive(workbench: Workbench): Promise<void> {
  const bridge = getWorkbenchBridge();
  if (
    workbench.runtime !== 'local' || !workbench.localPath ||
    (workbench.deviceId && workbench.deviceId !== getDeviceId()) ||
    (workbench.status !== 'archived' && !workbench.archivedAt) ||
    dialogArchives.has(workbench.id) || !bridge?.processArchivedWorktree
  ) return Promise.resolve();
  const existing = pending.get(workbench.id);
  if (existing) return existing;
  const chatIds = (useWorkbenchStore.getState().chats[workbench.id] ?? []).map((chat) => chat.id);
  useWorkbenchStore.setState((state) => {
    const localQueues = { ...state.localQueues };
    for (const id of chatIds) delete localQueues[id];
    return { localQueues };
  });
  const task = bridge.processArchivedWorktree({ path: workbench.localPath, workbenchId: workbench.id })
    .then(({ keptWorktree }) => {
      const current = useWorkbenchStore.getState().workbenches[workbench.id];
      if (current && (current.status === 'archived' || current.archivedAt)) {
        useWorkbenchStore.getState().upsertWorkbench({ ...current, keptWorktree });
      }
    })
    .finally(() => pending.delete(workbench.id));
  pending.set(workbench.id, task);
  return task;
}
