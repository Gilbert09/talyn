import { and, eq, lte, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as prTable, workbenches as workbenchesTable } from '../db/schema.js';
import { GitHubApiError, githubService } from './github.js';
import { GitHubRateLimitError } from './githubRateGate.js';
import { prMonitorService } from './prMonitor.js';

/**
 * Close a pull request as the workspace's connected GitHub user, with an
 * optional comment first.
 *
 * An agent that reads untrusted text can be told to close somebody else's
 * work, so the rules are strict:
 * - The PR's GitHub author must be the connected user, or a Talyn session must
 *   have opened it.
 * - From a session token, the PR must be in the session's own repository, and
 *   it must not be the session's own PR. That PR is the work in progress, and
 *   the person closes it in the app.
 * - A merged PR is refused. A closed PR is a no-op success, and Talyn posts no
 *   comment on it.
 * - The comment is posted only after every rule passes.
 */

/** GitHub refuses a comment body longer than this. */
export const MAX_CLOSE_COMMENT_CHARS = 65_536;

/** A session's PR link can lag the PR by a poll. Same slack as `eligiblePr`. */
const SESSION_OPEN_SLACK_MS = 2 * 60_000;

export class PrCloseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'PrCloseError';
  }
}

export interface ClosePullRequestInput {
  workspaceId: string;
  /** The Talyn PR id. Or pass `repository` and `number`. */
  pullRequestId?: string;
  /** `owner/name`. */
  repository?: string;
  number?: unknown;
  comment?: unknown;
  /** Set when the caller is a session's own token. */
  sessionId?: string;
}

export interface ClosePullRequestResult {
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** The Talyn row, when the PR is tracked. */
  pullRequestId: string | null;
  /** GitHub already had the PR closed. Nothing changed. */
  alreadyClosed: boolean;
  commentPosted: boolean;
}

interface TargetRow {
  id: string;
  repositoryId: string;
}

function parseRepository(value: string | undefined): { owner: string; repo: string } {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(value?.trim() ?? '');
  if (!m) throw new PrCloseError('repository must be "owner/name".', 400, 'invalid_repository');
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

function parseNumber(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new PrCloseError('number must be a positive whole number.', 400, 'invalid_number');
  }
  return n;
}

function parseComment(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PrCloseError('comment must be text.', 400, 'invalid_comment');
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_CLOSE_COMMENT_CHARS) {
    throw new PrCloseError(
      `The comment has ${text.length} characters. GitHub accepts at most ${MAX_CLOSE_COMMENT_CHARS}.`,
      400,
      'comment_too_long'
    );
  }
  return text;
}

function githubFailure(err: unknown): string {
  if (err instanceof GitHubRateLimitError) return 'GitHub is rate limiting Talyn. Try again in a few minutes.';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a Talyn session opened this PR: a session of this workspace is linked
 * to it and started before the PR was created. A session started from a PR
 * somebody else opened is linked too, but it started after that PR.
 */
async function openedBySession(workspaceId: string, rowId: string, prCreatedAt: string): Promise<boolean> {
  const created = Date.parse(prCreatedAt);
  if (!Number.isFinite(created)) return false;
  const [hit] = await getDbClient()
    .select({ id: workbenchesTable.id })
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.workspaceId, workspaceId),
        eq(workbenchesTable.pullRequestId, rowId),
        lte(workbenchesTable.createdAt, new Date(created + SESSION_OPEN_SLACK_MS))
      )
    )
    .limit(1);
  return Boolean(hit);
}

export async function closePullRequest(input: ClosePullRequestInput): Promise<ClosePullRequestResult> {
  const { workspaceId } = input;
  const comment = parseComment(input.comment);
  const db = getDbClient();

  let owner: string;
  let repo: string;
  let number: number;
  let row: TargetRow | null = null;
  if (input.pullRequestId) {
    const [found] = await db
      .select({
        id: prTable.id,
        repositoryId: prTable.repositoryId,
        owner: prTable.owner,
        repo: prTable.repo,
        number: prTable.number,
      })
      .from(prTable)
      .where(and(eq(prTable.id, input.pullRequestId), eq(prTable.workspaceId, workspaceId)))
      .limit(1);
    if (!found) throw new PrCloseError('Pull request not found.', 404, 'pr_not_found');
    ({ owner, repo, number } = found);
    row = { id: found.id, repositoryId: found.repositoryId };
  } else {
    ({ owner, repo } = parseRepository(input.repository));
    number = parseNumber(input.number);
    const [found] = await db
      .select({ id: prTable.id, repositoryId: prTable.repositoryId })
      .from(prTable)
      .where(
        and(
          eq(prTable.workspaceId, workspaceId),
          sql`lower(${prTable.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${prTable.repo}) = ${repo.toLowerCase()}`,
          eq(prTable.number, number)
        )
      )
      .limit(1);
    row = found ?? null;
  }
  const fullName = `${owner}/${repo}`;
  const ref = `${fullName}#${number}`;

  let session: { repoFullName: string; branch: string; pullRequestId: string | null } | null = null;
  if (input.sessionId) {
    const [wb] = await db
      .select({
        kind: workbenchesTable.kind,
        repoFullName: workbenchesTable.repoFullName,
        branch: workbenchesTable.branch,
        pullRequestId: workbenchesTable.pullRequestId,
      })
      .from(workbenchesTable)
      .where(and(eq(workbenchesTable.id, input.sessionId), eq(workbenchesTable.workspaceId, workspaceId)))
      .limit(1);
    if (!wb) throw new PrCloseError('The calling session is not in this workspace.', 403, 'session_not_found');
    if (wb.kind === 'thread' || !wb.repoFullName) {
      throw new PrCloseError(
        'A thread has no repository, so it cannot close pull requests. A session closes pull requests in its own repository.',
        403,
        'session_has_no_repository'
      );
    }
    if (wb.repoFullName.toLowerCase() !== fullName.toLowerCase()) {
      throw new PrCloseError(
        `A session closes pull requests only in its own repository, ${wb.repoFullName}. ${ref} is in another repository.`,
        403,
        'not_session_repository'
      );
    }
    session = wb;
  }

  const ownSessionPr = () =>
    new PrCloseError(
      `${ref} is this session's own pull request. Talyn does not close it from the session. Ask the person to close it in the app.`,
      403,
      'own_session_pull_request'
    );
  if (session && row && session.pullRequestId === row.id) throw ownSessionPr();

  let gh: Awaited<ReturnType<typeof githubService.getPullRequest>>;
  try {
    gh = await githubService.getPullRequest(workspaceId, owner, repo, number);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new PrCloseError(`GitHub has no pull request ${ref} that you can see.`, 404, 'pr_not_found');
    }
    throw err;
  }

  if (session && gh.head?.ref === session.branch) {
    const headRepo = gh.head.repo?.full_name;
    if (!headRepo || headRepo.toLowerCase() === session.repoFullName.toLowerCase()) throw ownSessionPr();
  }

  const author = gh.user?.login ?? '';
  const viewer = await githubService.getViewerLogin(workspaceId);
  const authored = Boolean(viewer && author && viewer.toLowerCase() === author.toLowerCase());
  if (!authored && !(row && (await openedBySession(workspaceId, row.id, gh.created_at)))) {
    throw new PrCloseError(
      viewer
        ? `Talyn closes only your own pull requests. ${ref} was opened by @${author || 'unknown'}, not by @${viewer}.`
        : `Talyn closes only your own pull requests. Talyn could not read your GitHub login, so it cannot confirm that you opened ${ref}.`,
      403,
      'not_your_pull_request'
    );
  }

  if (gh.merged || gh.merged_at) {
    throw new PrCloseError(`${ref} is merged. A merged pull request cannot be closed.`, 409, 'pull_request_merged');
  }

  const refreshRow = async () => {
    if (!row) return;
    try {
      await prMonitorService.markPrTerminal([{ repositoryId: row.repositoryId }], number, {
        merged: false,
        mergedAt: null,
      });
    } catch (err) {
      console.warn(`[prClose] marking ${ref} closed failed:`, err instanceof Error ? err.message : err);
    }
  };

  const result = (alreadyClosed: boolean, commentPosted: boolean): ClosePullRequestResult => ({
    owner,
    repo,
    number,
    url: gh.html_url,
    pullRequestId: row?.id ?? null,
    alreadyClosed,
    commentPosted,
  });

  if (gh.state === 'closed') {
    await refreshRow();
    return result(true, false);
  }

  if (comment) {
    try {
      await githubService.createIssueComment(workspaceId, owner, repo, number, comment);
    } catch (err) {
      throw new PrCloseError(
        `GitHub did not post the comment, so Talyn did not close ${ref}: ${githubFailure(err)}`,
        502,
        'comment_failed'
      );
    }
  }

  try {
    await githubService.updatePullRequest(workspaceId, owner, repo, number, { state: 'closed' });
  } catch (err) {
    throw new PrCloseError(
      comment
        ? `Talyn posted the comment on ${ref}, but GitHub did not close the pull request: ${githubFailure(err)}`
        : `GitHub did not close ${ref}: ${githubFailure(err)}`,
      502,
      'close_failed'
    );
  }

  await refreshRow();
  return result(false, Boolean(comment));
}
