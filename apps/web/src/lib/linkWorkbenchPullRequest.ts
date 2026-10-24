import type { LinkWorkbenchPullRequestResult, Workbench } from '@talyn/shared';

interface LinkApi {
  linkPullRequest(id: string, number: number): Promise<LinkWorkbenchPullRequestResult>;
  unlinkPullRequest(id: string): Promise<Workbench>;
}

/**
 * Link a session to a pull request. The backend asks for a checkout
 * (`needsCheckout`) only for a local session, whose worktree is on a computer
 * with the desktop app. The browser cannot do that git work, so it removes the
 * link again and says where to do it.
 */
export async function linkSessionPullRequest(api: LinkApi, workbench: Workbench, number: number): Promise<Workbench> {
  const result = await api.linkPullRequest(workbench.id, number);
  if (!result.needsCheckout) return result.workbench;
  await api.unlinkPullRequest(workbench.id);
  throw new Error('This session runs on a computer with the Talyn desktop app. Link the pull request there.');
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
