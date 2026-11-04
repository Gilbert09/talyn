import { scriptSnapshots } from '../services/workbenches/scriptStore.js';
import express, { Router, type Request, type Response } from 'express';
import { forwardRequestHeaders, isSafePreviewPath, proxyBody, proxyPortRequest } from '../services/preview/portsHttp.js';
import { PREVIEW_TICKET_RATE } from '../services/preview/previewLinks.js';
import { previewBaseDomain } from '../services/preview/previewHost.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { v4 as uuid } from 'uuid';
import {
  isValidBranchName,
  sanitizeWorkbenchTitle,
  WORKBENCH_EFFORTS,
  WORKBENCH_IMPORT_MAX_BYTES,
  WORKBENCH_KINDS,
  WORKBENCH_MANUAL_TITLE_MAX,
  type ApiResponse,
  type CreateWorkbenchChatInput,
  type ConfirmWorkbenchBranchNameInput,
  type ContinueWorkbenchAsThreadInput,
  type CreateWorkbenchInput,
  type MemoryScope,
  MEMORY_SCOPES,
  type NameWorkbenchBranchInput,
  type PutWorkbenchInstructionFileInput,
  type UpdateLocalWorkbenchChatInput,
  type UpdateWorkbenchChatInput,
  type UpdateWorkbenchInput,
  type WorkbenchAgent,
  type WorkbenchChatStatus,
  type WorkbenchEffort,
  type WorkbenchEvent,
  type WorkbenchKind,
  type WorkbenchSettings,
  boxRefusalReason,
} from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import { runWorkbenchAction } from '../services/workbenches/actions.js';
import { changesResponseEtag } from '../services/workbenches/changesStored.js';
import { importClaudeSession, importTargetChat, parseImportBody } from '../services/workbenches/claudeImport.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from '../services/workbenches/emit.js';
import { fleetErrorAsRefusal, refuseThread, WorkbenchError } from '../services/workbenches/errors.js';
import { MOVE_SETTINGS_KEYS, startStaleGoldenMove } from '../services/workbenches/move.js';
import { chooseReadSource } from '../services/workbenches/sandboxReadSource.js';
import { BOX_START_SETTINGS_KEYS } from '../services/workbenches/boxStart.js';
import { requestArchiveAfterTurn } from '../services/workbenches/autoArchive.js';
import { createWorkbench, type CreateWorkbenchServiceInput } from '../services/workbenches/create.js';
import {
  archiveWorkbench,
  deleteWorkbench,
  restoreWorkbench,
  retryWorkbench,
} from '../services/workbenches/lifecycle.js';
import {
  listInstructionFiles,
  putInstructionFile,
  removeInstructionFile,
} from '../services/workbenches/instructions.js';
import { confirmLocalBranchName, reserveLocalBranchName } from '../services/workbenches/localBranchName.js';
import { claimLocalWorkbench } from '../services/workbenches/localTakeover.js';
import { setSessionAccount } from '../services/workbenches/sandboxRuntime.js';
import type { ResizeInput, SessionResizeResult } from '../services/workbenches/resize.js';
import {
  closeChat,
  createSessionPreviewLink,
  dropQueuedMessage,
  listSessionFiles,
  patchChat,
  readSessionChanges,
  readSessionConfig,
  readSessionDiff,
  readSessionFile,
  readSessionPreviewPatch,
  requireReadySandbox,
  resizeSession,
  startSessionScript,
  stopSessionScript,
} from '../services/workbenches/sessionOps.js';
import { getWorkbenchTiming } from '../services/workbenches/turnInsights.js';
import { getSandboxStatus } from '../services/workbenches/sandboxStatus.js';
import { linkPullRequest, publicWorkbench, publicWorkbenches } from '../services/workbenches/prLink.js';
import { createWorkbenchPullRequest } from '../services/workbenches/pullRequest.js';
import { sandboxRefusal, workbenchReadiness } from '../services/workbenches/readiness.js';
import {
  fleetClientFor,
  loadWorkbenchConfig,
  resumeCredentialsFor,
  resumeOnce,
  saveDetectedConfig,
} from '../services/workbenches/sandboxRuntime.js';
import { recoverLostSandbox } from '../services/workbenches/recovery.js';
import { continueAsThread, notifyThread } from '../services/workbenches/threads.js';
import {
  getChat,
  getWorkbench,
  insertChat,
  isThread,
  listChats,
  listCheckpoints,
  listEvents,
  listOlderEvents,
  listWorkbenches,
  liveWorkbenchNames,
  rowToChat,
  setGeneratedTitle,
  storeNumberedEvents,
  threadSessions,
  updateChat,
  updateWorkbench,
  type ChatRow,
  type WorkbenchRow,
} from '../services/workbenches/store.js';
import { cancelTurn, restoreCheckpoint, sendMessage } from '../services/workbenches/turns.js';
import {
  forgetMemory,
  getMemory,
  listMemories,
  memoryWorkspaceId,
  putMemory,
  restoreMemory,
  updateMemory,
} from '../services/workbenches/memory.js';
import { assertWorkbenchBoxStart, existingBoxRefusal } from '../services/workbenches/boxGate.js';

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

const CHAT_STATUSES: readonly WorkbenchChatStatus[] = ['idle', 'running', 'awaiting_input', 'error'];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * `?kinds=session,thread`. Absent: sessions only, because a client that does
 * not ask for threads does not know how to show one. Null when a kind is unknown.
 */
function parseKinds(raw: unknown): WorkbenchKind[] | null {
  if (raw === undefined) return ['session'];
  if (typeof raw !== 'string') return null;
  const kinds = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
  if (kinds.length === 0 || kinds.some((k) => !WORKBENCH_KINDS.includes(k as WorkbenchKind))) return null;
  return kinds as WorkbenchKind[];
}

const ok = <T>(res: Response, data: T) => res.json({ success: true, data } as ApiResponse<T>);
/** A request header that asks a box read not to wake a sleeping box. Never forwarded to the box. */
const NO_WAKE_HEADER = 'x-talyn-no-wake';

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
    // `wake`: the box sleeps and nothing is stored; a read with `live=1` wakes it.
    if (refusal.code === 'snapshot_unavailable') {
      res.status(refusal.status).json({ success: false, error: refusal.message, code: refusal.code, wake: true });
      return;
    }
    bad(res, refusal.status, refusal.message, refusal.code);
    return;
  }
  throw err;
}

/** `?live=1` or `?live=true`: read the box now, and wake it if it sleeps. Only a person's refresh sends it. */
const wantsLive = (req: Request) => req.query.live === '1' || req.query.live === 'true';

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
    ok(res, rowToChat(await patchChat(found.chat, patch)));
  });

  /** Close a chat tab. A running turn is stopped first; the transcript stays. */
  router.delete('/chats/:chatId', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    await closeChat(found.chat, found.workbench);
    ok(res, null);
  });

  router.delete('/chats/:chatId/queue/:messageId', async (req, res) => {
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    const row = await dropQueuedMessage(found.chat.id, req.params.messageId);
    if (!row) return bad(res, 404, 'Chat not found');
    ok(res, rowToChat(row));
  });

  router.post('/chats/:chatId/messages', async (req, res) => {
    const sentAt = new Date().toISOString();
    const found = await gatedChat(req, res, req.params.chatId);
    if (!found) return;
    try {
      if (found.chat.closedAt) throw new WorkbenchError('This chat is closed.', 409, 'chat_closed');
      ok(res, await sendMessage(found.chat.id, req.body ?? {}, { sentAt }));
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
    // Backward mode: `before=latest` is the newest page, `before=<seq>` the page older than that seq.
    const rawBefore = req.query.before;
    if (rawBefore !== undefined) {
      if (req.query.after !== undefined) return bad(res, 400, 'Pass after or before, not both.');
      const before = rawBefore === 'latest' ? null : Number(rawBefore);
      if (before !== null && !(Number.isInteger(before) && before > 0)) {
        return bad(res, 400, 'before must be "latest" or a positive integer');
      }
      // The ceiling that bounds a turn-aligned page is the forward page's own cap.
      return ok(res, await listOlderEvents(found.chat.id, before, limit, MAX_EVENT_PAGE));
    }
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
    // A local session in a thread: its turns run on the desktop, so the change of status is the turn's end.
    if (found.workbench.threadId && found.chat.status === 'running' && body.status !== 'running') {
      await notifyThread(found.workbench, body.status === 'awaiting_input' ? 'needs_input' : 'session_finished', { status: body.status });
    }
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

  // ---- Workspace memory: notes sessions and people save for later sessions ----
  // Declared before `/:id` so `/memory` is not read as a workbench id.

  /** Null means the request is answered: no entry, or the caller may not see its workspace. */
  async function gatedMemory(req: Request, res: Response, id: string): Promise<string | null> {
    const workspaceId = await memoryWorkspaceId(id);
    if (!workspaceId) {
      bad(res, 404, 'Memory entry not found', 'memory_not_found');
      return null;
    }
    return (await gate(req, res, workspaceId)) ? workspaceId : null;
  }

  router.get('/memory', async (req, res) => {
    const query = (key: string) => (typeof req.query[key] === 'string' ? (req.query[key] as string) : undefined);
    const workspaceId = query('workspaceId') ?? '';
    const scope = query('scope');
    if (scope !== undefined && !MEMORY_SCOPES.includes(scope as MemoryScope)) {
      return bad(res, 400, `scope must be one of: ${MEMORY_SCOPES.join(', ')}`, 'bad_memory');
    }
    if (!(await gate(req, res, workspaceId))) return;
    ok(res, await listMemories(workspaceId, {
      scope: scope as MemoryScope | undefined,
      repositoryId: query('repositoryId'),
      threadId: query('threadId'),
      q: query('q'),
      name: query('name'),
      includeForgotten: query('includeForgotten') === 'true',
      includeBody: query('includeBody') === 'true',
    }));
  });

  /** Create, or update the live entry with the same scope target and name. */
  router.post('/memory', async (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: unknown };
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    try {
      ok(res, await putMemory(assertUser(req).id, body));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/memory/:memoryId', async (req, res) => {
    if (!(await gatedMemory(req, res, req.params.memoryId))) return;
    ok(res, await getMemory(req.params.memoryId));
  });

  router.put('/memory/:memoryId', async (req, res) => {
    if (!(await gatedMemory(req, res, req.params.memoryId))) return;
    try {
      ok(res, await updateMemory(req.params.memoryId, req.body));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Forget: a soft delete that `restore` undoes. */
  router.delete('/memory/:memoryId', async (req, res) => {
    if (!(await gatedMemory(req, res, req.params.memoryId))) return;
    const forgotten = await forgetMemory(req.params.memoryId);
    if (!forgotten) return bad(res, 404, 'Memory entry not found, or already forgotten', 'memory_not_found');
    ok(res, forgotten);
  });

  router.post('/memory/:memoryId/restore', async (req, res) => {
    if (!(await gatedMemory(req, res, req.params.memoryId))) return;
    try {
      ok(res, await restoreMemory(req.params.memoryId));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/', async (req, res) => {
    const workspaceId = (req.query.workspaceId as string) ?? '';
    const kinds = parseKinds(req.query.kinds);
    if (!kinds) return bad(res, 400, `kinds must be a comma-separated list of: ${WORKBENCH_KINDS.join(', ')}`, 'bad_kinds');
    if (!(await gate(req, res, workspaceId))) return;
    const rows = await listWorkbenches(workspaceId, req.query.includeArchived === 'true', kinds);
    ok(res, await publicWorkbenches(rows));
  });

  router.get('/:id', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    // A PR opened since the last look — by the agent's own `gh pr create`.
    ok(res, await publicWorkbench(await linkPullRequest(row)));
  });

  router.post('/', async (req, res) => {
    const sentAt = new Date().toISOString();
    const body = (req.body ?? {}) as CreateWorkbenchInput;
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (!(await gate(req, res, workspaceId))) return;
    const user = assertUser(req);
    try {
      // `source` and `namingText` are the service's own inputs, never a client's.
      const input: CreateWorkbenchServiceInput = { ...body, workspaceId };
      delete input.source;
      delete input.namingText;
      ok(res, await createWorkbench(input, { id: user.id, email: user.email }, sentAt));
    } catch (err) {
      fail(res, err);
    }
  });

  /** A thread's sessions, newest first, archived ones too. */
  router.get('/:id/sessions', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    if (!isThread(row)) return bad(res, 409, 'This is a session, not a thread.', 'not_thread');
    ok(res, await publicWorkbenches(await threadSessions(row.id)));
  });

  /** Continue a session as a thread: the session joins the new thread, which starts with a recap of its chat. */
  router.post('/:id/thread', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const user = assertUser(req);
    try {
      ok(res, await continueAsThread(row, (req.body ?? {}) as ContinueWorkbenchAsThreadInput, { id: user.id, email: user.email }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/:id/account', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const accountId = (req.body as { accountId?: unknown } | undefined)?.accountId;
    if (typeof accountId !== 'string' || !accountId) return bad(res, 400, 'accountId is required.');
    try {
      await setSessionAccount(row, accountId);
    } catch (err) {
      return fail(res, err);
    }
    const data = await publicWorkbench((await getWorkbench(row.id)) ?? row);
    await emitWorkbenchUpdated(data);
    ok(res, data);
  });

  /**
   * Move the session to a sandbox of another size, after the running turn.
   * `continueWith` goes to the session's chat as a Talyn message, so the next
   * turn starts on the new box; the turn start applies the resize first.
   */
  router.put('/:id/sandbox-size', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const body = (req.body ?? {}) as ResizeInput & { continueWith?: unknown };
    if (body.continueWith !== undefined && body.continueWith !== null && typeof body.continueWith !== 'string') {
      return bad(res, 400, 'continueWith must be a string.');
    }
    const continueWith = typeof body.continueWith === 'string' ? body.continueWith.trim() : '';
    try {
      const data: SessionResizeResult = await resizeSession(row, body, continueWith);
      ok(res, data);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/:id', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const body = (req.body ?? {}) as UpdateWorkbenchInput;
    const patch: Parameters<typeof updateWorkbench>[1] = {};
    const takeover = body.deviceId !== undefined || body.localPath !== undefined;
    if (takeover) {
      if (row.runtime !== 'local') return bad(res, 409, 'Only a local session can move computers.');
      if (typeof body.deviceId !== 'string' || !body.deviceId.trim()
        || typeof body.localPath !== 'string' || !body.localPath.startsWith('/')) {
        return bad(res, 400, 'A device id and an absolute local path are required.');
      }
    }
    if (body.branch !== undefined) {
      if (row.runtime !== 'local') return bad(res, 409, 'Only a local session can report its branch.');
      if (typeof body.branch !== 'string' || !isValidBranchName(body.branch)) {
        return bad(res, 400, 'branch is not a valid branch name.');
      }
      patch.branch = body.branch;
      // A branch the desktop checked out (a PR's, a person's) is not Talyn's to rename.
      if (body.branch !== row.branch) patch.allocatedBranch = false;
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
        ...(row.settings?.fleetAccountId ? { fleetAccountId: row.settings.fleetAccountId } : {}),
        // Also server-only: the id the fleet gave the box, which its credential pull carries.
        ...(row.settings?.fleetSandboxId ? { fleetSandboxId: row.settings.fleetSandboxId } : {}),
        ...((row.settings as Record<string, unknown> | null)?.archiveCredentialsRearmed ? { archiveCredentialsRearmed: true } : {}),
        // Server-only: old boxes the reaper must keep.
        ...(row.settings?.keptSandboxIds ? { keptSandboxIds: row.settings.keptSandboxIds } : {}),
        // Server-only: the box's start times and last wake, for the Sandbox panel.
        ...Object.fromEntries(
          BOX_START_SETTINGS_KEYS.flatMap((key) => {
            const value = (row.settings as Record<string, unknown> | null)?.[key];
            return value === undefined ? [] : [[key, value]];
          }),
        ),
        // A move's target, lease and backoff: server-only, and a later box must not reuse the target's generation.
        ...Object.fromEntries(
          MOVE_SETTINGS_KEYS.flatMap((key) => {
            const value = (row.settings as Record<string, unknown> | null)?.[key];
            return value === undefined ? [] : [[key, value]];
          }),
        ),
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
    if (takeover) updated = await claimLocalWorkbench(updated, body.deviceId!, body.localPath!);
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
      // `afterTurn`: archive once no chat is running. A session's own agent
      // asks this way, so its archive does not cancel the reply that asked.
      if (req.body?.afterTurn === true && !row.archivedAt) {
        await requestArchiveAfterTurn(row.id);
        ok(res, await publicWorkbench((await getWorkbench(row.id)) ?? row));
        return;
      }
      ok(res, await publicWorkbench(await archiveWorkbench(row.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Provision again after a failed or stuck start. Refused, unchanged, while the fleet still cannot run it. */
  router.post('/:id/retry', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      if (row.runtime === 'sandbox' && (row.status === 'error' || row.status === 'provisioning') && !row.archivedAt) {
        const user = assertUser(req);
        const refusal = sandboxRefusal(
          await workbenchReadiness(row.workspaceId, { id: user.id, email: user.email }),
          row.agent as WorkbenchAgent,
        );
        if (refusal) throw refusal;
        // A retry boots a fresh box: the plan's budget, box cap and size.
        await assertWorkbenchBoxStart(row);
      }
      ok(res, await publicWorkbench(await retryWorkbench(row.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  // The UI calls this on mount and on the first keystroke; 30 s collapses those into one fleet read.
  const WAKE_DEDUPE_MS = 30_000;
  const lastWake = new Map<string, { at: number; status: string }>();

  /** Where the session's turns spent their time. Read from stored turn reports, never the transcript. */
  router.get('/:id/timing', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await getWorkbenchTiming(row.id));
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * The Sandbox panel: the box's state, what runs on it, and whether its work
   * is saved. Read-only; a fleet that does not answer degrades the fleet part
   * to unknown and never fails the request.
   */
  router.get('/:id/sandbox-status', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await getSandboxStatus(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/wake', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    if (row.runtime !== 'sandbox' || row.status !== 'ready' || !row.sandboxId || row.archivedAt) {
      ok(res, { status: 'skipped' });
      return;
    }
    const recent = lastWake.get(row.id);
    if (recent && Date.now() - recent.at < WAKE_DEDUPE_MS) {
      const settled = recent.status === 'awake' || recent.status === 'exhausted' || recent.status === 'box_limit';
      res.status(settled ? 200 : 202).json({ success: true, data: { status: recent.status } });
      return;
    }
    try {
      let status: 'moving' | 'resuming' | 'awake' = 'awake';
      if (await startStaleGoldenMove(row)) {
        status = 'moving';
      } else {
        const client = await fleetClientFor(row.workspaceId, row.fleetHost);
        const { sandbox } = await client.getSandbox(row.sandboxId);
        if (sandbox.status === 'suspended') {
          // Waking adds a box and starts its meter. Out of budget, or at the
          // box cap, the box stays asleep and the answer says why: 200, not a
          // 402, because the client calls this on mount, not on a person's
          // request to spend. The notice lets it show the prompt.
          const refusal = await existingBoxRefusal(row);
          if (refusal) {
            const refused = boxRefusalReason(refusal.code) === 'usage_exhausted' ? 'exhausted' : 'box_limit';
            lastWake.set(row.id, { at: Date.now(), status: refused });
            ok(res, { status: refused, code: refusal.code, notice: refusal.notice });
            return;
          }
          status = 'resuming';
          // The fleet may answer that the box is lost, e.g. its hibernated copy cannot be restored.
          const inStorage = Boolean(sandbox.suspendUploaded) && !sandbox.suspendDir;
          resumeOnce(client, row.sandboxId, inStorage ? 'storage' : 'host', () => resumeCredentialsFor(row))
            .catch((err: unknown) => recoverLostSandbox(row, err))
            .catch(() => undefined);
        }
      }
      lastWake.set(row.id, { at: Date.now(), status });
      res.status(status === 'awake' ? 200 : 202).json({ success: true, data: { status } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/restore', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      // A restore boots (or wakes) the session's box: the plan first.
      if (row.archivedAt) await assertWorkbenchBoxStart(row);
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

  /**
   * Continue a local Claude Code conversation in this fresh sandbox session.
   * The body framing is in `claudeSessionImport.ts` (shared). The checks that
   * need no body run before the body is read.
   */
  router.post('/:id/import', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      refuseThread(row);
      await requireReadySandbox(row);
      if (row.agent !== 'claude') {
        throw new WorkbenchError('Only a Claude session can continue a Claude Code conversation.', 409, 'wrong_agent');
      }
      const target = importTargetChat(await listChats(row.id));
      const body = await readImportBody(req);
      if (body === 'too_large') {
        return bad(res, 413, `The conversation and your changes are larger than ${IMPORT_LIMIT_MB} MB, the most one import can take.`, 'import_too_large');
      }
      if (!body) return bad(res, 415, 'Send the import as application/octet-stream.', 'bad_import');
      ok(res, await importClaudeSession(row, target, parseImportBody(body)));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Files and diff (sandbox only: a local workbench's desktop reads its own disk) ----

  router.get('/:id/changes', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      // Only `?live=1` (a person's refresh) wakes a sleeping box, with or without a stored list.
      const changes = await readSessionChanges(row, { live: wantsLive(req), wakeWithoutSnapshot: false });
      const etag = changesResponseEtag(changes);
      if (etag) {
        res.setHeader('ETag', etag);
        const match = req.headers['if-none-match'];
        if (typeof match === 'string' && match.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
          res.status(304).end();
          return;
        }
      }
      ok(res, changes);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/diff', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    if (isThread(row)) return ok(res, { patch: '' });
    try {
      const scope = req.query.scope;
      if (scope !== undefined && scope !== 'combined' && scope !== 'uncommitted' && scope !== 'committed') {
        await requireReadySandbox(row);
        return bad(res, 400, 'Invalid diff scope.', 'bad_scope');
      }
      ok(res, await readSessionDiff(row, typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined, scope, { live: wantsLive(req) }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/file', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      if (typeof req.query.path !== 'string' || !req.query.path) {
        await requireReadySandbox(row);
        return bad(res, 400, 'path is required');
      }
      ok(res, await readSessionFile(row, req.query.path, { live: wantsLive(req) }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/files', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await listSessionFiles(row, { live: wantsLive(req) }));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Scripts (output arrives as `workbench:script` WS frames) ----

  router.get('/:id/config', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    if (isThread(row)) return ok(res, await loadWorkbenchConfig(row));
    try {
      ok(res, await readSessionConfig(row, { live: wantsLive(req) }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/config/detected', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      refuseThread(row);
      await requireReadySandbox(row);
      await saveDetectedConfig(row);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/scripts/output', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try { ok(res, await scriptSnapshots(row.id)); } catch (err) { fail(res, err); }
  });

  router.post('/:id/scripts/:name', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      await startSessionScript(row, req.params.name);
      ok(res, null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/scripts/:name/stop', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      await stopSessionScript(row, req.params.name);
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
      refuseThread(row);
      ok(res, await createWorkbenchPullRequest(row, req.body ?? {}));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/actions/:action', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      refuseThread(row);
      const chatId = (req.body as { chatId?: unknown } | undefined)?.chatId;
      ok(res, await runWorkbenchAction(row, req.params.action, typeof chatId === 'string' ? chatId : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- A local session's branch name after its first turn: reserve, rename on the desktop, confirm ----

  router.post('/:id/branch-name', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      refuseThread(row);
      ok(res, await reserveLocalBranchName(row, (req.body ?? {}) as NameWorkbenchBranchInput));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/branch-name/confirm', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await confirmLocalBranchName(row, (req.body ?? {}) as ConfirmWorkbenchBranchNameInput));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/patch', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await readSessionPreviewPatch(row, { live: wantsLive(req) }));
    } catch (err) { fail(res, err); }
  });

  // ---- Preview: a port a script listens on in the sandbox, behind the same gate ----

  // A one-time sign-in link to the port on its own preview host. Declared
  // before the proxy route, which would otherwise read `ticket` as a path.
  const ticketLimit = rateLimit({
    ...PREVIEW_TICKET_RATE,
    keyFn: (req) => req.user?.id ?? req.ip ?? 'unknown',
    message: 'Too many preview links. Wait a minute, then try again.',
  });
  router.post('/:id/ports/:port/ticket', ticketLimit, async (req, res) => {
    const domain = previewBaseDomain();
    if (!domain) return bad(res, 404, 'Hosted previews are not set up on this deployment.', 'preview_links_unavailable');
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return bad(res, 400, 'port must be 1024-65535');
    try {
      ok(res, await createSessionPreviewLink(row, port, assertUser(req).id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.all('/:id/ports/:port/*', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return bad(res, 400, 'port must be 1024-65535');
    try {
      // The app's check of a preview port, sent with no user action: a sleeping box stays asleep.
      if (req.headers[NO_WAKE_HEADER] === '1' && !(await chooseReadSource(row)).live) {
        return bad(res, 409, 'The sandbox is asleep. Talyn does not wake it to check a preview port.', 'sandbox_asleep');
      }
      await requireReadySandbox(row);
      const body = await proxyBody(req);
      if (body === 'too_large') return bad(res, 413, 'That request body is too large to forward.');
      const rest = (req.params as Record<string, string>)[0] ?? '';
      if (!isSafePreviewPath(rest)) return bad(res, 400, 'That preview path is not allowed.');
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      await proxyPortRequest(
        req,
        res,
        { workspaceId: row.workspaceId, fleetHost: row.fleetHost, sandboxId: row.sandboxId!, port },
        `${rest}${query}`,
        { headers: forwardRequestHeaders(req), body },
      );
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

const IMPORT_LIMIT_MB = WORKBENCH_IMPORT_MAX_BYTES / (1024 * 1024);
const importBodyParser = express.raw({ type: 'application/octet-stream', limit: WORKBENCH_IMPORT_MAX_BYTES });

/** An import body, read only after the gate. Null when it is not octet-stream. */
function readImportBody(req: Request): Promise<Buffer | null | 'too_large'> {
  return new Promise((resolve, reject) => {
    importBodyParser(req, {} as Response, (err?: unknown) => {
      if ((err as { type?: string } | undefined)?.type === 'entity.too.large') return resolve('too_large');
      if (err) return reject(err);
      resolve(Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null);
    });
  });
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
    for (const key of ['create_pr', 'fix_checks', 'resolve_conflicts', 'address_review', 'rename_branch'] as const) {
      const v = p[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') return `settings.prompts.${key} must be a string`;
      prompts[key] = v;
    }
    out.prompts = prompts;
  }
  return out;
}
