import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import {
  isValidBranchName,
  pickWorkbenchName,
  workbenchBranchFromTask,
  workbenchNameFromTask,
  type CreateWorkbenchInput,
  type Workbench,
  type WorkbenchQueuedMessage,
  type WorkbenchSource,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable, repositories as reposTable } from '../../db/schema.js';
import { reconcileDefaultBranch } from '../repoDefaultBranch.js';
import { allocateWorkbenchBranch, sessionBranchPrefix, uniqueViolationConstraint } from './branchAllocation.js';
import { emitWorkbenchUpdated } from './emit.js';
import { WorkbenchError } from './errors.js';
import { scheduleProvision } from './lifecycle.js';
import { publicWorkbench } from './prLink.js';
import { sandboxRefusal, workbenchReadiness, type ReadinessUser } from './readiness.js';
import { sandboxIdFor } from './sandboxRuntime.js';
import { insertChat, insertWorkbench, liveWorkbenchNames, type WorkbenchRow } from './store.js';
import { normaliseMessage } from './turns.js';

/**
 * Create a session: the one path behind `POST /workbenches` and a Slack
 * trigger, so both get the same validation, branch naming, readiness refusal,
 * provisioning and first message.
 *
 * The caller has already decided the actor may use this workspace (the route
 * through `requireWorkspaceAccess` and the flag, Slack through the identity
 * link and the flag). Everything here runs on the pool.
 *
 * A refusal is a {@link WorkbenchError}. The 400s carry an EMPTY code: the
 * route has always answered them without one, and a client may compare the
 * whole body.
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const refuse = (status: number, message: string, code = ''): WorkbenchError => new WorkbenchError(message, status, code);

export interface CreateWorkbenchServiceInput extends CreateWorkbenchInput {
  /** Where the session came from, when not the app. Stored once on the row. */
  source?: WorkbenchSource | null;
  /**
   * The text the session's name and branch are made from, when it differs
   * from the prompt. A Slack prompt starts with Talyn's own framing, which
   * would name every branch the same.
   */
  namingText?: string;
}

export async function createWorkbench(body: CreateWorkbenchServiceInput, actor: ReadinessUser): Promise<Workbench> {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (body.runtime !== 'sandbox' && body.runtime !== 'local') throw refuse(400, 'runtime must be "sandbox" or "local"');
  if (body.agent !== 'claude' && body.agent !== 'codex') throw refuse(400, 'agent must be "claude" or "codex"');
  if (body.internetAccess !== undefined && typeof body.internetAccess !== 'boolean') {
    throw refuse(400, 'internetAccess must be a boolean');
  }
  if (body.autoCreatePr !== undefined && typeof body.autoCreatePr !== 'boolean') {
    throw refuse(400, 'autoCreatePr must be a boolean');
  }

  const db = getPoolDbClient();
  const repo = (
    await db
      .select({ id: reposTable.id, url: reposTable.url, name: reposTable.name, defaultBranch: reposTable.defaultBranch })
      .from(reposTable)
      .where(and(eq(reposTable.id, body.repositoryId ?? ''), eq(reposTable.workspaceId, workspaceId)))
      .limit(1)
  )[0];
  if (!repo) throw refuse(400, 'That repository is not connected to this workspace.');
  const slugMatch = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repo.url);
  const repoFullName = slugMatch ? `${slugMatch[1]}/${slugMatch[2]}` : repo.name;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) throw refuse(400, 'Could not work out the GitHub owner/name of that repository.');

  let branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  let baseBranch = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
  let pullRequestId: string | null = null;
  if (body.fromPullRequestId) {
    const pr = (
      await db
        .select({
          id: prTable.id,
          headBranch: sql<string | null>`${prTable.lastSummary} ->> 'headBranch'`,
          baseBranch: sql<string | null>`${prTable.lastSummary} ->> 'baseBranch'`,
        })
        .from(prTable)
        .where(
          and(
            eq(prTable.id, body.fromPullRequestId),
            eq(prTable.workspaceId, workspaceId),
            eq(prTable.repositoryId, repo.id),
          ),
        )
        .limit(1)
    )[0];
    if (!pr?.headBranch) throw refuse(400, 'That pull request is not in this repository, or its branch is not known yet.');
    pullRequestId = pr.id;
    branch = pr.headBranch;
    baseBranch = baseBranch || pr.baseBranch || '';
  }
  if (!baseBranch) {
    baseBranch = await reconcileDefaultBranch({
      repositoryId: repo.id,
      workspaceId,
      url: repo.url,
      stored: repo.defaultBranch,
    }).catch(() => repo.defaultBranch || 'main');
  }
  if (!isValidBranchName(baseBranch)) throw refuse(400, 'baseBranch is not a valid branch name');
  if (branch && !isValidBranchName(branch)) throw refuse(400, 'branch is not a valid branch name');

  if (body.runtime === 'local') {
    if (typeof body.deviceId !== 'string' || !body.deviceId || typeof body.localPath !== 'string' || !body.localPath) {
      throw refuse(400, 'A local session needs deviceId and localPath.');
    }
  } else {
    // A sandbox workbench needs fleet hardware, a deployed fleet, the fleet
    // audience and the subscription for ITS agent: the box's vendor is fixed
    // when it boots. The same answer GET /readiness gives, so nothing is
    // inserted that would only fail later.
    const refusal = sandboxRefusal(await workbenchReadiness(workspaceId, actor), body.agent);
    if (refusal) throw refusal;
  }

  const requestedName = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (requestedName && !NAME_PATTERN.test(requestedName)) {
    throw refuse(400, 'name must be lowercase letters, digits and hyphens.');
  }
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null;
  const firstMessage: WorkbenchQueuedMessage | null = prompt ? normaliseMessage({ text: prompt }) : null;
  const naming = typeof body.namingText === 'string' && body.namingText.trim() ? body.namingText : prompt;

  // The name is unique among live workbenches. It comes from the first
  // message when there is one, else a city. Two creates in the same moment
  // can pick the same name; the index decides, and the loser picks again.
  // Only a branch Talyn names gets the workspace's prefix; a branch the
  // person picked (a PR, "from branch") is used as it is.
  const branchPrefix = branch ? '' : await sessionBranchPrefix(workspaceId);
  // A local branch the desktop named from the prompt is Talyn's, like a
  // sandbox one: in the unique index, and renamed after the first turn. If
  // another session already holds that name, it stays a plain branch.
  let localGenerated = body.runtime === 'local' && body.branchGenerated === true && Boolean(branch) && !pullRequestId;
  const id = uuid();
  let row: WorkbenchRow | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    const taken = await liveWorkbenchNames(workspaceId);
    if (requestedName && taken.includes(requestedName)) {
      throw refuse(409, `A session named "${requestedName}" already exists.`, 'name_taken');
    }
    const name = requestedName || (naming ? workbenchNameFromTask(naming, taken) : pickWorkbenchName(taken));
    const branchBase = (naming ? workbenchBranchFromTask(naming) : null) ?? name;
    try {
      row = await insertWorkbench({
        id,
        workspaceId,
        repositoryId: repo.id,
        repoFullName,
        name,
        branch: branch || await allocateWorkbenchBranch(workspaceId, repoFullName, `${branchPrefix}${branchBase}`),
        allocatedBranch: !branch || localGenerated,
        baseBranch,
        runtime: body.runtime,
        agent: body.agent,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
        deviceId: body.runtime === 'local' ? body.deviceId : null,
        localPath: body.runtime === 'local' ? body.localPath : null,
        sandboxId: body.runtime === 'sandbox' ? sandboxIdFor(id) : null,
        sandboxState: body.runtime === 'sandbox' ? 'creating' : 'none',
        // A local worktree exists by the time the desktop asks for the row.
        status: body.runtime === 'sandbox' ? 'provisioning' : 'ready',
        statusMessage: body.runtime === 'sandbox' ? 'Creating the sandbox' : null,
        pullRequestId,
        settings: {
          ...(body.internetAccess === undefined ? {} : { internetAccess: body.internetAccess }),
          ...(body.autoCreatePr === undefined ? {} : { autoCreatePr: body.autoCreatePr }),
        },
        source: body.source ?? null,
      });
    } catch (err) {
      const constraint = uniqueViolationConstraint(err);
      if (constraint === 'uq_workbenches_allocated_branch' && localGenerated) {
        localGenerated = false;
        continue;
      }
      if (constraint !== 'uq_workbenches_allocated_branch'
        && (constraint !== 'uq_workbenches_workspace_name_live' || requestedName)) throw err;
    }
  }
  if (!row) throw refuse(409, 'Could not find a free name for the session; try again.', 'name_taken');

  // The first chat exists from the start, with the prompt waiting in its
  // queue: a sandbox workbench drains it when the box is ready, a local one
  // hands it to the desktop.
  await insertChat({
    id: uuid(),
    workbenchId: row.id,
    workspaceId,
    title: (naming ?? '').trim() ? (naming as string).trim().split('\n')[0].slice(0, 60) : 'Chat',
    agent: row.agent,
    model: row.model,
    queuedMessages: firstMessage ? [firstMessage] : [],
  });
  const data = await publicWorkbench(row);
  await emitWorkbenchUpdated(data);
  if (row.runtime === 'sandbox') scheduleProvision(row.id);
  return data;
}
