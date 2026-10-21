import {
  pullRequestCheckoutSteps,
  workingTreeStatus,
  type LinkWorkbenchPullRequestResult,
  type Workbench,
  type WorkbenchLocalBridge,
} from '@talyn/shared';
import { getDeviceId } from './workbenchBridge';

interface LinkApi {
  linkPullRequest(id: string, number: number): Promise<LinkWorkbenchPullRequestResult>;
  unlinkPullRequest(id: string): Promise<Workbench>;
  update(id: string, patch: { branch: string }): Promise<Workbench>;
}

export async function linkSessionPullRequest(
  api: LinkApi,
  bridge: Pick<WorkbenchLocalBridge, 'exec'> | null,
  workbench: Workbench,
  number: number
): Promise<Workbench> {
  if (workbench.runtime === 'local' && workbench.deviceId && workbench.deviceId !== getDeviceId()) {
    throw new Error('This session lives on another computer. Open it there.');
  }
  if (workbench.runtime === 'local' && (!bridge || !workbench.localPath)) {
    throw new Error('This session has no local worktree on this device.');
  }
  const result = await api.linkPullRequest(workbench.id, number);
  if (!result.needsCheckout) return result.workbench;
  const path = workbench.localPath!;
  try {
    const status = await bridge!.exec(path, [workingTreeStatus()]);
    if (status.exitCode !== 0) throw new Error('Could not read the git status.');
    if (status.stdout.trim()) throw new Error('Commit or discard the changes in this session first.');
    const checked = await bridge!.exec(path, pullRequestCheckoutSteps(result.needsCheckout));
    if (checked.exitCode !== 0) throw new Error('Could not check out the PR branch.');
  } catch (err) {
    await api.unlinkPullRequest(workbench.id);
    throw err;
  }
  return api.update(workbench.id, { branch: result.needsCheckout.branch });
}

export function parsePullRequestNumber(value: string, repoFullName: string): number | null {
  const text = value.trim();
  let number = /^#?\d+$/.test(text) ? Number(text.replace(/^#/, '')) : NaN;
  if (!Number.isFinite(number)) {
    try {
      const url = new URL(text);
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || !match) return null;
      if (match[1].toLowerCase() !== repoFullName.toLowerCase()) return null;
      number = Number(match[2]);
    } catch {
      return null;
    }
  }
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
