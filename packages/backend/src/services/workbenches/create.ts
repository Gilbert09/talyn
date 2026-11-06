import { validateAgentModel } from './credentialPolicy.js';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import {
  isValidBranchName,
  pickWorkbenchName,
  WORKBENCH_KINDS,
  workbenchBranchFromTask,
  workbenchNameFromTask,
  type CreateWorkbenchInput,
  type Workbench,
  type WorkbenchQueuedMessage,
  type WorkbenchSource,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { billingEnabled, resolveEntitlement } from '../billing/entitlements.js';
import { pullRequests as prTable, repositories as reposTable } from '../../db/schema.js';
import { reconcileDefaultBranch } from '../repoDefaultBranch.js';
import { allocateWorkbenchBranch, sessionBranchPrefix, uniqueViolationConstraint } from './branchAllocation.js';
import { emitWorkbenchUpdated } from './emit.js';
import { WorkbenchError } from './errors.js';
import { assertNewWorkbenchBox } from './boxGate.js';
import { scheduleProvision, THREAD_SANDBOX_SIZE } from './lifecycle.js';
import { sizeForSession } from './sandboxSize.js';
import { publicWorkbench } from './prLink.js';
import { sandboxRefusal, workbenchReadiness, type ReadinessUser } from './readiness.js';
import { sandboxIdFor } from './sandboxRuntime.js';
import { sendWebhookSignal } from '../apiWebhooks/signals.js';
import { conversationRecap } from './agentRecap.js';
import { notifyTodiex } from '../todiex.js';
import { describeWorkspace, ownerLine, workspaceLabel, workspaceMetadata } from '../todiexContext.js';
import {
  getWorkbench,
  insertChat,
  insertWorkbench,
  isThread,
  latestChat,
  liveWorkbenchNames,
  updateWorkbench,
  type WorkbenchRow,
} from './store.js';
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

/**
 * The plan gate for a new sandbox box: a session or a thread. Every creator
 * passes here (the apps' route, the MCP server through that route, Slack and
 * the public API), so a cap added here holds for all of them. A refusal is a
 * plan-limit error the routes turn into a 402.
 *
 * TODO(usage billing): there is no session cap on this branch yet, so this
 * allows every create. The usage-based billing work (`assertNewWorkbenchBox`
 * in `boxGate.ts` on tom/workbenches) is the gate that goes here.
 */
export async function assertSessionPlanAllows(ownerId: string): Promise<void> {
  if (!billingEnabled()) return;
  await resolveEntitlement(ownerId);
}

const refuse = (status: number, message: string, code = ''): WorkbenchError => new WorkbenchError(message, status, code);

export interface CreateWorkbenchServiceInput extends CreateWorkbenchInput {
  /**
   * Continue this session as the new thread: the session joins the thread, and
   * the thread's first message is a recap of the session's chat. Thread only.
   */
  fromSessionId?: string;
  /** Where the session came from, when not the app. Stored once on the row. */
  source?: WorkbenchSource | null;
  /**
   * The text the session's name and branch are made from, when it differs
   * from the prompt. A Slack prompt starts with Talyn's own framing, which
   * would name every branch the same.
   */
  namingText?: string;
}

export async function createWorkbench(body: CreateWorkbenchServiceInput, actor: ReadinessUser, sentAt = new Date().toISOString()): Promise<Workbench> {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (body.runtime !== 'sandbox' && body.runtime !== 'local') throw refuse(400, 'runtime must be "sandbox" or "local"');
  if (body.agent !== 'claude' && body.agent !== 'codex') throw refuse(400, 'agent must be "claude" or "codex"');
  validateAgentModel(body.agent, body.model);
  if (body.internetAccess !== undefined && typeof body.internetAccess !== 'boolean') {
    throw refuse(400, 'internetAccess must be a boolean');
  }
  if (body.autoCreatePr !== undefined && typeof body.autoCreatePr !== 'boolean') {
    throw refuse(400, 'autoCreatePr must be a boolean');
  }
  if (body.kind !== undefined && !WORKBENCH_KINDS.includes(body.kind)) {
    throw refuse(400, `kind must be one of: ${WORKBENCH_KINDS.join(', ')}`);
  }
  if (body.kind === 'thread') return createThread(body, workspaceId, actor, sentAt);
  if (body.fromSessionId !== undefined) throw refuse(400, 'fromSessionId is only for a thread.');
  const threadId = body.threadId === undefined ? null : await requireThread(body.threadId, workspaceId);

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
    // A new session needs the subscription for the agent it starts with. The
    // box carries both keys, but the first chat runs this agent.
    const refusal = sandboxRefusal(await workbenchReadiness(workspaceId, actor), body.agent);
    if (refusal) throw refusal;
    // The plan: budget, the concurrent-box cap and the box's size. A refusal
    // is a BoxGateError, a 402 with its notice, and nothing is inserted.
    await assertNewWorkbenchBox(workspaceId, () => sizeForSession({ repositoryId: repo.id, workspaceId }));
  }

  const requestedName = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (requestedName && !NAME_PATTERN.test(requestedName)) {
    throw refuse(400, 'name must be lowercase letters, digits and hyphens.');
  }
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null;
  const firstMessage: WorkbenchQueuedMessage | null = prompt ? { ...normaliseMessage({ text: prompt }), queuedAt: sentAt } : null;
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
        threadId,
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
  sendWebhookSignal({ kind: 'session_created', workspaceId, sessionId: row.id });
  await emitWorkbenchUpdated(data);
  if (row.runtime === 'sandbox') scheduleProvision(row.id);
  // Sent on every session; the dedupe key keeps only the workspace's first.
  // A local session counts too: a desktop user may never start a sandbox.
  const local = row.runtime === 'local';
  notifyTodiex(async () => {
    const ws = await describeWorkspace(workspaceId);
    return {
      kind: 'workspace.first_session',
      level: 'success',
      title: `${workspaceLabel(ws)} started its first Talyn session`,
      message: [`${local ? 'Local session' : 'Session'} started for ${repoFullName}.`, ownerLine(ws)].filter(Boolean).join(' '),
      metadata: {
        repository: repoFullName,
        repository_id: repo.id,
        ...workspaceMetadata(ws),
        session_id: row.id,
        runtime: row.runtime,
      },
      dedupeKey: `workspace:${workspaceId}:first_session`,
    };
  });
  return data;
}

/** The id of a live thread in this workspace, or a 400. */
async function requireThread(threadId: unknown, workspaceId: string): Promise<string> {
  const thread = typeof threadId === 'string' && threadId ? await getWorkbench(threadId) : null;
  if (!thread || thread.workspaceId !== workspaceId || !isThread(thread) || thread.archivedAt) {
    throw refuse(400, 'That thread is not a live thread in this workspace.');
  }
  return thread.id;
}

/**
 * A thread: a sandbox with no repository, no branch and no pull request. It
 * plans work and starts sessions on repositories. With `fromSessionId`, the
 * session joins the thread and the first message recaps the session's chat.
 */
async function createThread(body: CreateWorkbenchServiceInput, workspaceId: string, actor: ReadinessUser, sentAt: string): Promise<Workbench> {
  if (body.repositoryId !== undefined) throw refuse(400, 'A thread takes no repository.');
  if (body.branch !== undefined || body.baseBranch !== undefined || body.fromPullRequestId !== undefined) {
    throw refuse(400, 'A thread takes no branch or pull request.');
  }
  if (body.threadId !== undefined) throw refuse(400, 'A thread cannot be in another thread.');
  if (body.runtime !== 'sandbox') throw refuse(400, 'A thread runs in a sandbox.');
  const refusal = sandboxRefusal(await workbenchReadiness(workspaceId, actor), body.agent);
  if (refusal) throw refusal;
  await assertNewWorkbenchBox(workspaceId, THREAD_SANDBOX_SIZE);

  const requestedName = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (requestedName && !NAME_PATTERN.test(requestedName)) {
    throw refuse(400, 'name must be lowercase letters, digits and hyphens.');
  }
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null;
  let naming = typeof body.namingText === 'string' && body.namingText.trim() ? body.namingText : prompt;
  let firstMessage: WorkbenchQueuedMessage | null = prompt ? { ...normaliseMessage({ text: prompt }), queuedAt: sentAt } : null;
  let fromSession: WorkbenchRow | null = null;
  if (body.fromSessionId !== undefined) {
    fromSession = typeof body.fromSessionId === 'string' && body.fromSessionId ? await getWorkbench(body.fromSessionId) : null;
    if (!fromSession || fromSession.workspaceId !== workspaceId || isThread(fromSession)) {
      throw refuse(400, 'That session is not in this workspace.');
    }
    const recap = await sessionRecap(fromSession);
    firstMessage = {
      ...normaliseMessage({ text: continueAsThreadMessage(fromSession, recap, prompt) }),
      queuedAt: sentAt,
      origin: 'talyn',
    };
    naming = fromSession.title || fromSession.name;
  }

  const id = uuid();
  let row: WorkbenchRow | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    const taken = await liveWorkbenchNames(workspaceId);
    if (requestedName && taken.includes(requestedName)) {
      throw refuse(409, `A session named "${requestedName}" already exists.`, 'name_taken');
    }
    const name = requestedName || (naming ? workbenchNameFromTask(naming, taken) : pickWorkbenchName(taken));
    try {
      row = await insertWorkbench({
        id,
        workspaceId,
        kind: 'thread',
        repositoryId: null,
        repoFullName: '',
        name,
        branch: '',
        allocatedBranch: false,
        baseBranch: '',
        runtime: 'sandbox',
        agent: body.agent,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
        sandboxId: sandboxIdFor(id),
        sandboxState: 'creating',
        status: 'provisioning',
        statusMessage: 'Creating the sandbox',
        settings: body.internetAccess === undefined ? {} : { internetAccess: body.internetAccess },
        source: body.source ?? null,
      });
    } catch (err) {
      if (uniqueViolationConstraint(err) !== 'uq_workbenches_workspace_name_live' || requestedName) throw err;
    }
  }
  if (!row) throw refuse(409, 'Could not find a free name for the thread; try again.', 'name_taken');

  await insertChat({
    id: uuid(),
    workbenchId: row.id,
    workspaceId,
    title: (naming ?? '').trim() ? (naming as string).trim().split('\n')[0].slice(0, 60) : 'Thread',
    agent: row.agent,
    model: row.model,
    queuedMessages: firstMessage ? [firstMessage] : [],
  });
  if (fromSession) {
    const linked = await updateWorkbench(fromSession.id, { threadId: row.id });
    if (linked) await emitWorkbenchUpdated(await publicWorkbench(linked));
  }
  const data = await publicWorkbench(row);
  sendWebhookSignal({ kind: 'session_created', workspaceId, sessionId: row.id });
  await emitWorkbenchUpdated(data);
  scheduleProvision(row.id);
  return data;
}

/** The session's newest open chat as text, for a thread that continues it. Empty when it has none. */
async function sessionRecap(session: WorkbenchRow): Promise<string> {
  const chat = await latestChat(session.id);
  if (!chat) return '';
  return (await conversationRecap(chat.id, chat.turnCount + 1)) ?? '';
}

/** The first message of a thread that continues a session. */
export function continueAsThreadMessage(session: Pick<WorkbenchRow, 'id' | 'name' | 'title' | 'repoFullName' | 'branch'>, recap: string, prompt: string | null): string {
  return [
    `This thread continues the session "${session.title || session.name}" (session id ${session.id}) ` +
      `on ${session.repoFullName}, branch ${session.branch}. The session is now part of this thread.`,
    recap ? `The conversation in that session so far:\n\n${recap}` : 'That session has no conversation yet.',
    prompt
      ? `The person asks:\n\n${prompt}`
      : 'Read the conversation. Say in a few lines what the work is and what is left, then wait for the person.',
  ].join('\n\n');
}
