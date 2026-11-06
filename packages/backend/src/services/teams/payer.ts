import type { WorkbenchTurnPayer } from '@talyn/shared';
import { githubAvatarUrl } from '../billing/teams.js';
import { WorkbenchError } from '../workbenches/errors.js';
import { callerGithubIdentity } from './membership.js';

/**
 * The payer of a turn in a teammate's session (Teams and Spaces): who
 * prompted it, and the workspace that pays. It travels on the queued message,
 * so a queued, held, re-queued or resumed turn keeps its payer.
 */

/** The payer record for a teammate's message, with the login and avatar the transcript shows. */
export async function turnPayerFor(userId: string, workspaceId: string): Promise<WorkbenchTurnPayer> {
  const { githubUserId, githubLogin } = await callerGithubIdentity(userId);
  return {
    userId,
    workspaceId,
    githubLogin,
    avatarUrl: githubUserId !== null ? githubAvatarUrl(githubUserId) : null,
  };
}

/** The backend's view of a payer: a message payer that names its workspace, else none. */
export function payerRef(payer: WorkbenchTurnPayer | undefined | null): { userId: string; workspaceId: string } | null {
  return payer?.userId && payer.workspaceId ? { userId: payer.userId, workspaceId: payer.workspaceId } : null;
}

/**
 * Git identity for a teammate's turn. The box's git config names the owner;
 * these variables come first for every git command the agent runs, so the
 * turn's commits are authored and committed as the payer, with their GitHub
 * no-reply address. A payer with no GitHub identity on record is refused: the
 * commit would otherwise carry the owner's name.
 */
export async function turnGitIdentityEnv(payerUserId: string): Promise<Record<string, string>> {
  const { githubUserId, githubLogin } = await callerGithubIdentity(payerUserId);
  if (githubUserId === null || !githubLogin) {
    throw new WorkbenchError(
      'Talyn does not know your GitHub account yet. Sign out and sign in again with GitHub, then try again.',
      409,
      'payer_identity_unavailable',
    );
  }
  const name = githubLogin;
  const email = `${githubUserId}+${githubLogin}@users.noreply.github.com`;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}
