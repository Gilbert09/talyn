import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import {
  isValidBranchName,
  normaliseBranchPrefix,
  pickWorkbenchName,
  sanitizeWorkbenchTitle,
  workbenchNameFromTask,
  WORKBENCH_EFFORTS,
  WORKBENCH_MANUAL_TITLE_MAX,
  type ApiResponse,
  type CreateWorkbenchChatInput,
  type CreateWorkbenchInput,
  type PutWorkbenchInstructionFileInput,
  type UpdateLocalWorkbenchChatInput,
  type UpdateWorkbenchChatInput,
  type UpdateWorkbenchInput,
  type WorkbenchAgent,
  type WorkbenchChatStatus,
  type WorkbenchEffort,
  type WorkbenchEvent,
  type WorkbenchSettings,
} from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../db/client.js';
import { pullRequests as prTable, repositories as reposTable, workspaces as workspacesTable } from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { reconcileDefaultBranch } from '../services/repoDefaultBranch.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import { runWorkbenchAction } from '../services/workbenches/actions.js';
import { getChanges, getPatch, listRepoFiles, readRepoFile } from '../services/workbenches/changes.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from '../services/workbenches/emit.js';
import { fleetErrorAsRefusal, localRuntimeError, notReadyError, WorkbenchError } from '../services/workbenches/errors.js';
import {
  archiveWorkbench,
  deleteWorkbench,
  restoreWorkbench,
  retryWorkbench,
  scheduleProvision,
} from '../services/workbenches/lifecycle.js';
import {
  listInstructionFiles,
  putInstructionFile,
  removeInstructionFile,
} from '../services/workbenches/instructions.js';
import { linkPullRequest, publicWorkbench, publicWorkbenches } from '../services/workbenches/prLink.js';
import { createWorkbenchPullRequest } from '../services/workbenches/pullRequest.js';
import { sandboxRefusal, workbenchReadiness } from '../services/workbenches/readiness.js';
import { fleetClientFor, loadWorkbenchConfigWithDetection, sandboxIdFor, saveDetectedConfig } from '../services/workbenches/sandboxRuntime.js';
import { startScript, stopScript } from '../services/workbenches/scripts.js';
import {
  getChat,
  getWorkbench,
  insertChat,
  insertWorkbench,
  listCheckpoints,
  listEvents,
  listWorkbenches,
  liveWorkbenchNames,
  removeQueuedMessage,
  rowToChat,
  setGeneratedTitle,
  storeNumberedEvents,
  updateChat,
  updateWorkbench,
  type ChatRow,
  type WorkbenchRow,
} from '../services/workbenches/store.js';
import { cancelTurn, normaliseMessage, restoreCheckpoint, sendMessage } from '../services/workbenches/turns.js';

/**
 * Workbenches — a branch with an agent chat, a diff, a terminal and scripts.
 * The contract is `api.workbenches` in `@talyn/client`; every path, body and
 * response here matches it.
 *
 * Mounted BEFORE `ownerScope`, for the reason billing is: most handlers wait
 * on the fleet (an archive runs a script and a push; the port proxy can hold
 * a response open), and an owner-scoped transaction would pin a pooled
 * connection for that whole wait. So every handler authorises explicitly —
 * `requireWorkspaceAccess` on the workspace the workbench or chat resolves to
 * — and gates on the `workbenches` flag for the caller. Hiding the nav item
 * is not a gate.
 */

/** A transcript page when the caller does not say; the ceiling is one request's worth, so ask again. */
const DEFAULT_EVENT_PAGE = 500;
const MAX_EVENT_PAGE = 2000;
/** One local-events upload. The JSON body limit (2 MB) bounds it anyway; this makes the refusal say why. */
const MAX_LOCAL_EVENT_BATCH = 1000;
/** A request body forwarded to a preview port. A dev server's form post, not an upload service. */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

const CHAT_STATUSES: readonly WorkbenchChatStatus[] = ['idle', 'running', 'awaiting_input', 'error'];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ok = <T>(res: Response, data: T) => res.json({ success: true, data } as ApiResponse<T>);
const bad = (res: Response, status: number, error: string, code?: string) =>
  res.status(status).json({ success: false, error, ...(code ? { code } : {}) });

/**
 * Refusals the services throw become their status and code, and so do fleet
 * faults (a 503 with words a person can read). Anything else is a real fault.
 */
function fail(res: Response, err: unknown): void {
  const refusal = fleetErrorAsRefusal(err);
  if (refusal) {
    if (!(err instanceof WorkbenchError)) console.warn('[workbench] fleet request failed:', err);
    bad(res, refusal.status, refusal.message, refusal.code);
    return;
  }
  throw err;
}

export function workbenchRoutes(): Router {
  const router = Router();

  /** Authorise the workspace, then the flag. False means the request is already answered. */
  async function gate(req: Request, res: Response, workspaceId: string): Promise<boolean> {
    if (!workspaceId) {
      bad(res, 400, 'workspaceId is required');
      return false;
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return false;
    }
    const user = assertUser(req);
    if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
      bad(res, 403, `Sessions are not available: ${workbenchesRefusalReason()}.`, 'workbenches_unavailable');
      return false;
    }
    return true;
  }

  /** The workbench, once the caller is allowed to see it. Null means the request is answered. */
  async function gatedWorkbench(req: Request, res: Response, id: string): Promise<WorkbenchRow | null> {
    const row = await getWorkbench(id);
    if (!row) {
      bad(res, 404, 'Session not found');
      return null;
    }
    return (await gate(req, res, row.workspaceId)) ? row : null;
  }

  async function gatedChat(
    req: Request,
    res: Response,
    chatId: string,
  ): Promise<{ chat: ChatRow; workbench: WorkbenchRow } | null> {
    const chat = await getChat(chatId);
    const workbench = chat ? await getWorkbench(chat.workbenchId) : null;
    if (!chat || !workbench) {
      bad(res, 404, 'Chat not found');
      return null;
    }
    return (await gate(req, res, workbench.workspaceId)) ? { chat, workbench } : null;
  }

  /** A sandbox workbench that can run a command right now, or the refusal that says why not. */
  function requireReadySandbox(row: WorkbenchRow): void {
    if (row.runtime === 'local') throw localRuntimeError();
    if (row.archivedAt) throw notReadyError('archived');
    if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);
  }

  // ==========================================================================
  // Chats — declared first so `/chats/...` is never read as a workbench id.
  // ==========================================================================

  router.patch('/chats/:chatId', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    const body = (req.body ?? {}) as UpdateWorkbenchChatInput;
    const patch: Parameters<typeof updateChat>[1] = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) return bad(res, 400, 'title must be a non-empty string');
      patch.title = body.title.trim().slice(0, 200);
    }
    if (body.model !== undefined) {
      if (body.model !== null && typeof body.model !== 'string') return bad(res, 400, 'model must be a string or null');
      patch.model = body.model?.trim() || null;
    }
    if (body.effort !== undefined) {
      if (body.effort !== null && !WORKBENCH_EFFORTS.includes(body.effort)) return bad(res, 400, 'unknown effort');
      patch.effort = body.effort;
    }
    if (body.planMode !== undefined) {
      if (typeof body.planMode !== 'boolean') return bad(res, 400, 'planMode must be a boolean');
      patch.planMode = body.planMode;
    }
    const row = (await updateChat(found.chat.id, patch)) ?? found.chat;
    emitWorkbenchChat(row.workspaceId, rowToChat(row));
    ok(res, rowToChat(row));
  });

  /** Close a chat tab. A running turn is stopped first; the transcript stays. */
  router.delete('/chats/:chatId', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    if (found.workbench.runtime === 'sandbox' && found.chat.status === 'running') {
      await cancelTurn(found.chat.id).catch((err) => console.warn('[workbench] cancel on close failed:', err));
    }
    await updateChat(found.chat.id, { closedAt: new Date(), queuedMessages: [] });
    // The embedded list is how a client learns a chat is gone.
    const workbench = await getWorkbench(found.workbench.id);
    if (workbench) await emitWorkbenchUpdated(await publicWorkbench(workbench));
    ok(res, null);
  });

  router.delete('/chats/:chatId/queue/:messageId', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    const row = await removeQueuedMessage(found.chat.id, req.params.messageId);
    if (!row) return bad(res, 404, 'Chat not found');
    emitWorkbenchChat(row.workspaceId, rowToChat(row));
    ok(res, rowToChat(row));
  });

  router.post('/chats/:chatId/messages', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    try {
      if (found.chat.closedAt) throw new WorkbenchError('This chat is closed.', 409, 'chat_closed');
      ok(res, await sendMessage(found.chat.id, req.body ?? {}));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/chats/:chatId/cancel', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    try {
      await cancelTurn(found.chat.id);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/chats/:chatId/events', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    const after = Number(req.query.after ?? 0);
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_EVENT_PAGE) : DEFAULT_EVENT_PAGE;
    ok(res, await listEvents(found.chat.id, Number.isFinite(after) && after > 0 ? Math.floor(after) : 0, limit));
  });

  router.get('/chats/:chatId/checkpoints', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    ok(res, await listCheckpoints(found.chat.id));
  });

  router.post('/chats/:chatId/checkpoints/:turn/restore', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    const turn = Number(req.params.turn);
    if (!Number.isInteger(turn) || turn < 0) return bad(res, 400, 'turn must be a non-negative integer');
    try {
      await restoreCheckpoint(found.chat.id, turn);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Local runtime reporting: the desktop owns the process, the backend owns the rows ----

  router.post('/chats/:chatId/local-events', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    if (found.workbench.runtime !== 'local') {
      return bad(res, 409, 'Only a local session uploads its own events.', 'sandbox_runtime');
    }
    const raw = (req.body as { events?: unknown } | undefined)?.events;
    if (!Array.isArray(raw)) return bad(res, 400, 'events must be an array');
    if (raw.length > MAX_LOCAL_EVENT_BATCH) {
      return bad(res, 413, `Send at most ${MAX_LOCAL_EVENT_BATCH} events per request.`);
    }
    const events: WorkbenchEvent[] = [];
    for (const item of raw as Array<Partial<WorkbenchEvent>>) {
      const event = item?.event as unknown;
      if (
        !Number.isInteger(item?.seq) || (item.seq as number) < 1 ||
        !Number.isInteger(item?.turn) || (item.turn as number) < 0 ||
        !event || typeof event !== 'object' || Array.isArray(event) ||
        typeof (event as { type?: unknown }).type !== 'string'
      ) {
        return bad(res, 400, 'each event needs an integer seq >= 1, an integer turn >= 0 and an event object with a type');
      }
      events.push({ chatId: found.chat.id, seq: item.seq as number, turn: item.turn as number, event: item.event! });
    }
    const stored = await storeNumberedEvents(found.chat.id, events);
    // Other clients (a second window, the web app) follow a local turn through this.
    emitWorkbenchEvents(found.chat.workspaceId, found.chat.id, events);
    ok(res, { stored });
  });

  router.patch('/chats/:chatId/local', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    if (found.workbench.runtime !== 'local') {
      return bad(res, 409, 'Only a local session reports its own chat state.', 'sandbox_runtime');
    }
    const body = (req.body ?? {}) as UpdateLocalWorkbenchChatInput;
    if (!CHAT_STATUSES.includes(body.status)) return bad(res, 400, 'unknown status');
    if (body.agentSessionId !== undefined && body.agentSessionId !== null && typeof body.agentSessionId !== 'string') {
      return bad(res, 400, 'agentSessionId must be a string or null');
    }
    const row =
      (await updateChat(found.chat.id, {
        status: body.status,
        ...(body.agentSessionId !== undefined ? { agentSessionId: body.agentSessionId } : {}),
      })) ?? found.chat;
    emitWorkbenchChat(row.workspaceId, rowToChat(row));
    ok(res, rowToChat(row));
  });

  // ==========================================================================
  // Workbenches
  // ==========================================================================

  /**
   * What this backend can run for the workspace. Workspace access only, not
   * the flag gate: a flag that is off is one of the answers (`flag_off`).
   * Declared before `/:id` so the path is not read as a workbench id.
   */
  router.get('/readiness', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) return bad(res, 400, 'workspaceId is required');
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const user = assertUser(req);
    ok(res, await workbenchReadiness(workspaceId, { id: user.id, email: user.email }));
  });

  // ---- Instruction files: the user's own CLAUDE.md, rules and AGENTS.md, for sandbox sessions ----

  /** Every stored file for the workspace, without its content. */
  router.get('/instructions', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    ok(res, await listInstructionFiles(workspaceId));
  });

  router.put('/instructions', async (req, res) => {
    const body = (req.body ?? {}) as Partial<PutWorkbenchInstructionFileInput>;
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    try {
      ok(res, await putInstructionFile(workspaceId, body.file));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/instructions/:key', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    if (!(await removeInstructionFile(workspaceId, req.params.key))) return bad(res, 404, 'Instruction file not found');
    ok(res, null);
  });

  router.get('/', async (req, res) => {
    const workspaceId = (req.query.workspaceId as string) ?? '';
    if (!(await gate(req, res, workspaceId))) return;
    const rows = await listWorkbenches(workspaceId, req.query.includeArchived === 'true');
    ok(res, await publicWorkbenches(rows));
  });

  router.get('/:id', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    // A PR opened since the last look — by the agent's own `gh pr create`.
    ok(res, await publicWorkbench(await linkPullRequest(row)));
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as CreateWorkbenchInput;
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    if (body.runtime !== 'sandbox' && body.runtime !== 'local') return bad(res, 400, 'runtime must be "sandbox" or "local"');
    if (body.agent !== 'claude' && body.agent !== 'codex') return bad(res, 400, 'agent must be "claude" or "codex"');
    if (body.internetAccess !== undefined && typeof body.internetAccess !== 'boolean') {
      return bad(res, 400, 'internetAccess must be a boolean');
    }
    if (body.autoCreatePr !== undefined && typeof body.autoCreatePr !== 'boolean') {
      return bad(res, 400, 'autoCreatePr must be a boolean');
    }

    const db = getPoolDbClient();
    const repo = (
      await db
        .select({ id: reposTable.id, url: reposTable.url, name: reposTable.name, defaultBranch: reposTable.defaultBranch })
        .from(reposTable)
        .where(and(eq(reposTable.id, body.repositoryId ?? ''), eq(reposTable.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    if (!repo) return bad(res, 400, 'That repository is not connected to this workspace.');
    const slugMatch = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repo.url);
    const repoFullName = slugMatch ? `${slugMatch[1]}/${slugMatch[2]}` : repo.name;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) return bad(res, 400, 'Could not work out the GitHub owner/name of that repository.');

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
      if (!pr?.headBranch) return bad(res, 400, 'That pull request is not in this repository, or its branch is not known yet.');
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
    if (!isValidBranchName(baseBranch)) return bad(res, 400, 'baseBranch is not a valid branch name');
    if (branch && !isValidBranchName(branch)) return bad(res, 400, 'branch is not a valid branch name');

    if (body.runtime === 'local') {
      if (typeof body.deviceId !== 'string' || !body.deviceId || typeof body.localPath !== 'string' || !body.localPath) {
        return bad(res, 400, 'A local session needs deviceId and localPath.');
      }
    } else {
      // A sandbox workbench needs fleet hardware, a deployed fleet, the fleet
      // audience and the subscription for ITS agent: the box's vendor is fixed
      // when it boots. The same answer GET /readiness gives, so nothing is
      // inserted that would only fail later.
      const user = assertUser(req);
      const refusal = sandboxRefusal(await workbenchReadiness(workspaceId, { id: user.id, email: user.email }), body.agent);
      if (refusal) return fail(res, refusal);
    }

    const requestedName = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    if (requestedName && !NAME_PATTERN.test(requestedName)) {
      return bad(res, 400, 'name must be lowercase letters, digits and hyphens.');
    }
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null;
    let firstMessage = null;
    try {
      firstMessage = prompt ? normaliseMessage({ text: prompt }) : null;
    } catch (err) {
      return fail(res, err);
    }

    // The name is unique among live workbenches. It comes from the first
    // message when there is one, else a city. Two creates in the same moment
    // can pick the same name; the index decides, and the loser picks again.
    // Only a branch Talyn names gets the workspace's prefix; a branch the
    // person picked (a PR, "from branch") is used as it is.
    let branchPrefix = '';
    if (!branch) {
      const stored = (
        await db
          .select({ prefix: sql<string | null>`${workspacesTable.settings} ->> 'sessionBranchPrefix'` })
          .from(workspacesTable)
          .where(eq(workspacesTable.id, workspaceId))
          .limit(1)
      )[0]?.prefix;
      const checked = normaliseBranchPrefix(stored ?? '');
      if (checked.ok) branchPrefix = checked.value;
    }
    const id = uuid();
    let row: WorkbenchRow | null = null;
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      const taken = await liveWorkbenchNames(workspaceId);
      if (requestedName && taken.includes(requestedName)) {
        return bad(res, 409, `A session named "${requestedName}" already exists.`, 'name_taken');
      }
      const name = requestedName || (prompt ? workbenchNameFromTask(prompt, taken) : pickWorkbenchName(taken));
      try {
        row = await insertWorkbench({
          id,
          workspaceId,
          repositoryId: repo.id,
          repoFullName,
          name,
          branch: branch || `${branchPrefix}${name}`,
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
        });
      } catch (err) {
        if (!/uq_workbenches_workspace_name_live|duplicate key/i.test(String((err as Error)?.message ?? err)) || requestedName) {
          throw err;
        }
      }
    }
    if (!row) return bad(res, 409, 'Could not find a free name for the session; try again.', 'name_taken');

    // The first chat exists from the start, with the prompt waiting in its
    // queue: a sandbox workbench drains it when the box is ready, a local one
    // hands it to the desktop.
    await insertChat({
      id: uuid(),
      workbenchId: row.id,
      workspaceId,
      title: prompt ? prompt.trim().split('\n')[0].slice(0, 60) : 'Chat',
      agent: row.agent,
      model: row.model,
      queuedMessages: firstMessage ? [firstMessage] : [],
    });
    const data = await publicWorkbench(row);
    await emitWorkbenchUpdated(data);
    if (row.runtime === 'sandbox') scheduleProvision(row.id);
    ok(res, data);
  });

  router.patch('/:id', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const body = (req.body ?? {}) as UpdateWorkbenchInput;
    const patch: Parameters<typeof updateWorkbench>[1] = {};
    if (body.branch !== undefined) {
      if (row.runtime !== 'local') return bad(res, 409, 'Only a local session can report its branch.');
      if (typeof body.branch !== 'string' || !isValidBranchName(body.branch)) {
        return bad(res, 400, 'branch is not a valid branch name.');
      }
      patch.branch = body.branch;
    }
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      if (!NAME_PATTERN.test(name)) return bad(res, 400, 'name must be lowercase letters, digits and hyphens.');
      if (name !== row.name && !row.archivedAt && (await liveWorkbenchNames(row.workspaceId)).includes(name)) {
        return bad(res, 409, `A session named "${name}" already exists.`, 'name_taken');
      }
      patch.name = name;
      // A rename is a person's choice of what to show, so it is the title too.
      // A title set means a generated one can never replace it.
      patch.title = name;
    }
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') return bad(res, 400, 'title must be a string or null.');
      const title = (body.title ?? '').replace(/\s+/g, ' ').trim();
      if (title.length > WORKBENCH_MANUAL_TITLE_MAX) {
        return bad(res, 400, `title must be at most ${WORKBENCH_MANUAL_TITLE_MAX} characters.`);
      }
      patch.title = title || null;
    }
    if (body.settings !== undefined) {
      const settings = validateSettings(body.settings);
      if (typeof settings === 'string') return bad(res, 400, settings);
      patch.settings = {
        ...settings,
        ...(row.settings?.prUnlinked !== undefined ? { prUnlinked: row.settings.prUnlinked } : {}),
        // Written by the server only (the box's current fleet account); a client never sends it.
        ...(typeof (row.settings as Record<string, unknown> | null)?.fleetAccountId === 'string'
          ? { fleetAccountId: (row.settings as Record<string, unknown>).fleetAccountId }
          : {}),
        // Also server-only: the id the fleet gave the box, which its credential pull carries.
        ...(row.settings?.fleetSandboxId ? { fleetSandboxId: row.settings.fleetSandboxId } : {}),
        ...(settings.internetAccess === undefined && row.settings?.internetAccess !== undefined
          ? { internetAccess: row.settings.internetAccess }
          : {}),
        ...(settings.autoCreatePr === undefined && row.settings?.autoCreatePr !== undefined
          ? { autoCreatePr: row.settings.autoCreatePr }
          : {}),
      };
    }
    const onlyGenerated = body.generatedTitle !== undefined && Object.keys(patch).length === 0;
    let updated = onlyGenerated ? row : ((await updateWorkbench(row.id, patch)) ?? row);
    if (body.generatedTitle !== undefined) {
      // The local runtime's model-written title. Applied only while there is no
      // title; junk is ignored, not refused, since the caller cannot do better.
      const title = sanitizeWorkbenchTitle(typeof body.generatedTitle === 'string' ? body.generatedTitle : null);
      if (title) updated = (await setGeneratedTitle(row.id, title)) ?? updated;
    }
    const data = await publicWorkbench(updated);
    await emitWorkbenchUpdated(data);
    ok(res, data);
  });

  router.post('/:id/archive', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await publicWorkbench(await archiveWorkbench(row.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Provision again after a failed start. Refused, unchanged, while the fleet still cannot run it. */
  router.post('/:id/retry', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      if (row.runtime === 'sandbox' && row.status === 'error' && !row.archivedAt) {
        const user = assertUser(req);
        const refusal = sandboxRefusal(
          await workbenchReadiness(row.workspaceId, { id: user.id, email: user.email }),
          row.agent as WorkbenchAgent,
        );
        if (refusal) throw refusal;
      }
      ok(res, await publicWorkbench(await retryWorkbench(row.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/restore', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await publicWorkbench(await restoreWorkbench(row.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    await deleteWorkbench(row.id);
    ok(res, null);
  });

  router.post('/:id/chats', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    if (row.archivedAt) return bad(res, 409, 'This session is archived. Restore it first.', 'archived');
    const body = (req.body ?? {}) as CreateWorkbenchChatInput;
    if (body.effort !== undefined && !WORKBENCH_EFFORTS.includes(body.effort)) return bad(res, 400, 'unknown effort');
    const chat = await insertChat({
      id: uuid(),
      workbenchId: row.id,
      workspaceId: row.workspaceId,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Chat',
      // A sandbox's vendor is fixed at boot, so its chats are the workbench's agent.
      agent: row.agent,
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : row.model,
      effort: (body.effort as WorkbenchEffort | undefined) ?? null,
      planMode: body.planMode === true,
    });
    emitWorkbenchChat(row.workspaceId, rowToChat(chat));
    ok(res, rowToChat(chat));
  });

  // ---- Files and diff (sandbox only: a local workbench's desktop reads its own disk) ----

  router.get('/:id/changes', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      ok(res, await getChanges(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/diff', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      ok(res, await getPatch(row, typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/file', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      if (typeof req.query.path !== 'string' || !req.query.path) return bad(res, 400, 'path is required');
      ok(res, await readRepoFile(row, req.query.path));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/files', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      ok(res, await listRepoFiles(row));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Scripts (output arrives as `workbench:script` WS frames) ----

  router.get('/:id/config', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      ok(res, await loadWorkbenchConfigWithDetection(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/config/detected', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      await saveDetectedConfig(row);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/scripts/:name', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      // Detached from the request: the script outlives it, and its follower
      // must not inherit anything request-scoped.
      await runWithoutScope(() => startScript(row, req.params.name));
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/scripts/:name/stop', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      requireReadySandbox(row);
      await stopScript(row, req.params.name);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Create PR: the agent writes the words in a chat turn; Talyn commits, pushes and opens it ----

  router.post('/:id/pull-request', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await createWorkbenchPullRequest(row, req.body ?? {}));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/actions/:action', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      const chatId = (req.body as { chatId?: unknown } | undefined)?.chatId;
      ok(res, await runWorkbenchAction(row, req.params.action, typeof chatId === 'string' ? chatId : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Preview: a port a script listens on in the sandbox, behind the same gate ----

  router.all('/:id/ports/:port/*', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return bad(res, 400, 'port must be 1-65535');
    try {
      requireReadySandbox(row);
      const body = await proxyBody(req);
      if (body === 'too_large') return bad(res, 413, 'That request body is too large to forward.');
      const rest = (req.params as Record<string, string>)[0] ?? '';
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const upstream = await client.proxyPort(row.sandboxId!, port, `${rest}${query}`, {
        method: req.method,
        headers: forwardRequestHeaders(req),
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
      });
      if (!upstream.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
        .on('error', () => res.end())
        .pipe(res);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      fail(res, err);
    }
  });

  return router;
}

/**
 * Headers not passed back from a preview. Hop-by-hop ones belong to the
 * fleet's connection, not ours; `content-encoding` and `content-length`
 * describe bytes fetch has already decoded; and the app's own cookies and
 * CORS headers must not be set on the API's origin.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'x-fleet-host',
]);

/** What a preview request carries on. Never the caller's Authorization — that is Talyn's, not the dev server's. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'range', 'if-none-match', 'if-modified-since'];

function forwardRequestHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/** The body to forward: what `express.json` already parsed, or the raw stream it left alone. */
async function proxyBody(req: Request): Promise<Buffer | null | 'too_large'> {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.is('application/json') && req.body !== undefined) return Buffer.from(JSON.stringify(req.body));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PROXY_BODY_BYTES) return 'too_large';
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

/** A settings patch, checked for shape. Returns the cleaned value, or a message. */
function validateSettings(input: unknown): WorkbenchSettings | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'settings must be an object';
  const raw = input as WorkbenchSettings;
  const out: WorkbenchSettings = {};
  if (raw.internetAccess !== undefined) {
    if (typeof raw.internetAccess !== 'boolean') return 'settings.internetAccess must be a boolean';
    out.internetAccess = raw.internetAccess;
  }
  if (raw.autoCreatePr !== undefined) {
    if (typeof raw.autoCreatePr !== 'boolean') return 'settings.autoCreatePr must be a boolean';
    out.autoCreatePr = raw.autoCreatePr;
  }
  if (raw.scripts !== undefined) {
    const s = raw.scripts;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'settings.scripts must be an object';
    const scripts: NonNullable<WorkbenchSettings['scripts']> = {};
    for (const key of ['setup', 'archive'] as const) {
      const v = s[key];
      if (v === undefined) continue;
      if (v !== null && typeof v !== 'string') return `settings.scripts.${key} must be a string or null`;
      scripts[key] = v;
    }
    if (s.run !== undefined) {
      if (s.run === null || typeof s.run === 'string') scripts.run = s.run;
      else if (
        Array.isArray(s.run) &&
        s.run.every((r) => r && typeof r.name === 'string' && r.name.trim() && typeof r.command === 'string')
      ) {
        scripts.run = s.run.map((r) => ({ name: r.name.trim(), command: r.command, default: r.default === true }));
      } else return 'settings.scripts.run must be a string, null, or a list of { name, command, default }';
    }
    if (s.runMode !== undefined) {
      if (s.runMode !== 'concurrent' && s.runMode !== 'nonconcurrent') return 'settings.scripts.runMode is unknown';
      scripts.runMode = s.runMode;
    }
    out.scripts = scripts;
  }
  if (raw.prompts !== undefined) {
    const p = raw.prompts;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'settings.prompts must be an object';
    const prompts: NonNullable<WorkbenchSettings['prompts']> = {};
    for (const key of ['create_pr', 'fix_checks', 'resolve_conflicts', 'rename_branch'] as const) {
      const v = p[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') return `settings.prompts.${key} must be a string`;
      prompts[key] = v;
    }
    out.prompts = prompts;
  }
  return out;
}
