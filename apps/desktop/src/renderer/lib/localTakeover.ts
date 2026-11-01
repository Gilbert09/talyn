import type { Workbench } from '@talyn/shared';
import { api } from './api';
import { autoDetectCheckouts } from './checkoutDetection';
import { bridgeErrorMessage, getDeviceId, getWorkbenchBridge } from './workbenchBridge';
import { useWorkbenchStore } from '../stores/workbenches';

export const REMOTE_BRANCH_ONLY = "This session's branch is only on the computer that made it. Push it from there, or start a new session.";

export function checkoutFor(paths: Record<string, string>, repoFullName: string): string | null {
  const key = Object.keys(paths).find((name) => name.toLowerCase() === repoFullName.toLowerCase());
  return key ? paths[key] : null;
}

export async function detectedCheckout(repoFullName: string): Promise<string | null> {
  const bridge = getWorkbenchBridge();
  if (!bridge?.repoPaths) return null;
  const found = await autoDetectCheckouts([repoFullName]);
  return checkoutFor(found.map ?? await bridge.repoPaths.get(), repoFullName);
}

export async function takeOverLocalWorkbench(workbench: Workbench, repoPath: string): Promise<Workbench | null> {
  const bridge = getWorkbenchBridge();
  if (!bridge?.takeOverWorktree) throw new Error('Update Talyn to move this session to this computer.');
  const made = await bridge.takeOverWorktree({
    repoPath,
    repoFullName: workbench.repoFullName,
    workbenchId: workbench.id,
    name: workbench.name,
    branch: workbench.branch,
    baseBranch: workbench.baseBranch,
  });
  if (!made.ok) {
    if (made.reason === 'branch_missing') return null;
    throw new Error(made.message);
  }
  if (!made.path) throw new Error('Talyn did not return the new worktree path.');
  try {
    const updated = await api.workbenches.update(workbench.id, { deviceId: getDeviceId(), localPath: made.path });
    useWorkbenchStore.getState().upsertWorkbench(updated);
    return updated;
  } catch (error) {
    throw new Error(bridgeErrorMessage(error, 'Could not claim the session.'));
  }
}
