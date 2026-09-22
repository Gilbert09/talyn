import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  BillingStatus,
  DebugEvent,
  Environment,
  LoopRun,
  MergeQueueBlockedEvent,
  AutoKeepNeedsHumanEvent,
  Task,
  TaskStatus,
  WorkflowRun,
  WSEvent,
} from '@talyn/shared';
import { domainEvents } from './events.js';
import { debugBus, matchesOwnerFilter, type DebugOwnerFilter } from './debugBus.js';
import { setLocalDelivery, publishBroadcast, publishToWorkspace, publishToUser } from './wsBus.js';
import { verifyTokenAndGetUser, enforceAllowList, AuthError, type AuthUser } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable, users as usersTable } from '../db/schema.js';

// Store connected clients
const clients = new Set<WebSocket>();

// Store subscriptions (client -> workspaceIds) and identities.
const subscriptions = new Map<WebSocket, Set<string>>();
const connectionUsers = new Map<WebSocket, AuthUser>();
const connectionDeadlines = new Map<WebSocket, number>();
// Per-client owner filter for the admin Debug stream. Absent = all owners.
const debugFilters = new Map<WebSocket, DebugOwnerFilter>();

export const WS_MAX_PAYLOAD = 16 * 1024;
const AUTHORIZATION_REFRESH_MS = 15_000;
const MAX_MESSAGES_PER_MINUTE = 120;
const MAX_SUBSCRIPTIONS = 64;
const MAX_CONNECTIONS_PER_OWNER = 20;
// A reconnect sends every subscription, then the debug filter and heartbeat.
const MAX_PENDING_MESSAGES = MAX_SUBSCRIPTIONS + 2;

/** The deployment has exactly one trusted proxy hop, matching HTTP's fixed trust setting. */
export function createWebSocketUpgradeGuard(): (req: IncomingMessage) => boolean {
  const buckets = new Map<string, { startedAt: number; attempts: number; active: number }>();
  let active = 0;
  let sweptAt = Date.now();
  return (req) => {
    const now = Date.now();
    if (now - sweptAt >= 60_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.active === 0 && now - bucket.startedAt >= 60_000) buckets.delete(key);
      }
      sweptAt = now;
    }
    const forwarded = req.headers['x-forwarded-for'];
    const lastHop = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined;
    const ip = lastHop && isIP(lastHop) ? lastHop : req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= 10_000) return false;
      bucket = { startedAt: now, attempts: 0, active: 0 };
      buckets.set(ip, bucket);
    }
    if (now - bucket.startedAt >= 60_000) {
      bucket.startedAt = now;
      bucket.attempts = 0;
    }
    if (bucket.attempts >= 120 || bucket.active >= 50 || active >= 1000) return false;
    bucket.attempts++;
    bucket.active++;
    active++;
    req.socket.once('close', () => {
      bucket.active--;
      active--;
    });
    return true;
  };
}

function canDeliver(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN && (connectionDeadlines.get(ws) ?? 0) > Date.now();
}

/**
 * Fan a debug event out only to ADMIN clients, and only to those whose current
 * owner filter matches — so a non-admin never receives debug data and an admin
 * watching a single user isn't fed everyone else's traffic over the wire.
 * Bypasses `broadcast()` (which would hit every client) for exactly this reason.
 */
function fanOutDebugEvent(event: DebugEvent): void {
  let message: string | null = null;
  for (const client of clients) {
    if (!canDeliver(client)) continue;
    if (!connectionUsers.get(client)?.isAdmin) continue;
    if (!matchesOwnerFilter(event.ownerId, debugFilters.get(client))) continue;
    if (message === null) {
      message = JSON.stringify({
        type: 'debug:event',
        payload: event,
        timestamp: event.timestamp,
      });
    }
    client.send(message);
  }
}

/** How long a freshly-upgraded socket has to send its `auth` frame before we
 *  close it. Generous so a backend under DB-connection pressure (the webhook
 *  worker once starved WS auth) doesn't drop legitimate clients mid-handshake.
 *  Injectable so tests can use a short window instead of waiting the full 10s. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export function setupWebSocket(
  wss: WebSocketServer,
  handshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  authorizationRefreshMs: number = AUTHORIZATION_REFRESH_MS
): void {
  // Wire the debug bus to the live client fan-out + connection count. Kept
  // here (not in debugBus) so debugBus stays dependency-free.
  debugBus.setClientCounter(() => clients.size);
  debugBus.setLiveSink(fanOutDebugEvent);

  // Let wsBus deliver events that arrive from OTHER replicas to our local
  // clients. We hand it the local-only delivery functions (not the public
  // broadcasters) so a remote event isn't re-published into a loop.
  setLocalDelivery({
    all: deliverBroadcastLocal,
    workspace: deliverToWorkspaceLocal,
    user: deliverToUserLocal,
  });

  wss.on('connection', (ws: WebSocket) => {
    // Accept the upgrade anonymously. The client must send an
    // `{type:'auth', token}` message within the handshake window
    // or the socket is closed. Keeping the token out of the URL
    // stops it leaking into access logs, Railway edge logs, and
    // monitoring tool URL captures.
    let authenticated = false;
    let authPending = false;
    let closed = false;
    let refreshTimer: NodeJS.Timeout | undefined;
    let accessTimer: NodeJS.Timeout | undefined;
    let messageWindow = Date.now();
    let messageCount = 0;
    let pendingMessages = 0;
    let messageChain = Promise.resolve();
    const handshakeDeadline = Date.now() + handshakeTimeoutMs;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      clearTimeout(refreshTimer);
      clearTimeout(accessTimer);
      const wasConnected = clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
      connectionDeadlines.delete(ws);
      debugFilters.delete(ws);
      if (wasConnected) {
        debugBus.recordWs({
          action: 'disconnect',
          summary: `client disconnected (${clients.size} left)`,
        });
      }
    };
    const close = (code: number, reason: string) => {
      cleanup();
      const timer = setTimeout(() => ws.terminate(), 1000).unref();
      ws.once('close', () => clearTimeout(timer));
      ws.close(code, reason);
    };
    const authorizeUntil = (user: AuthUser, checkedAt: number) => {
      // Stop delivery at the lease deadline even if a database check stalls.
      const deadline = Math.min(user.expiresAt!, checkedAt + authorizationRefreshMs * 2);
      connectionUsers.set(ws, user);
      connectionDeadlines.set(ws, deadline);
      clearTimeout(accessTimer);
      accessTimer = setTimeout(() => close(4401, 'authorization expired'), Math.max(0, deadline - Date.now()));
    };
    const refreshAuthorization = async () => {
      const user = connectionUsers.get(ws);
      if (closed || !user) return;
      const checkedAt = Date.now();
      try {
        const [row] = await getDbClient()
          .select({ email: usersTable.email, isAdmin: usersTable.isAdmin })
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .limit(1);
        if (closed) return;
        if (!canDeliver(ws) || !row) {
          close(4401, 'authorization expired');
          return;
        }
        enforceAllowList(row.email);
        authorizeUntil({ ...user, ...row }, checkedAt);
        if (!row.isAdmin) debugFilters.delete(ws);
        refreshTimer = setTimeout(() => { void refreshAuthorization(); }, authorizationRefreshMs);
      } catch (err) {
        if (!closed) close(err instanceof AuthError ? 4401 : 1013, 'authorization unavailable');
      }
    };
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        close(4401, 'auth timeout');
      }
    }, handshakeTimeoutMs);

    ws.on('message', async (data: Buffer) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - messageWindow >= 60_000) {
        messageWindow = Date.now();
        messageCount = 0;
      }
      if (++messageCount > MAX_MESSAGES_PER_MINUTE || data.length > WS_MAX_PAYLOAD) {
        close(1008, 'message limit');
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString());
      } catch {
        close(1008, 'invalid message');
        return;
      }
      if (!message || Array.isArray(message) || typeof message.type !== 'string' || message.type.length > 32) {
        close(1008, 'invalid message');
        return;
      }

      if (!authenticated) {
        const m = message as { type?: unknown; token?: unknown };
        if (authPending || m.type !== 'auth' || typeof m.token !== 'string') {
          close(4401, 'expected one auth frame');
          return;
        }
        authPending = true;
        const checkedAt = Date.now();
        let user: AuthUser | null = null;
        let unavailable = false;
        try {
          user = await verifyTokenAndGetUser(m.token);
        } catch (err) {
          // 'unavailable' = we couldn't CHECK the token (Supabase/JWKS down),
          // not that it's bad — close with 1013 (try again later) so the
          // client's backoff loop retries instead of reading it as an auth
          // rejection. Everything else stays 4401.
          unavailable = err instanceof AuthError && err.code === 'unavailable';
          if (unavailable) console.error('WebSocket auth check unavailable:', err);
        }
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        if (
          !user || !Number.isFinite(user.expiresAt) || user.expiresAt! <= Date.now() ||
          Date.now() >= handshakeDeadline || checkedAt + authorizationRefreshMs * 2 <= Date.now()
        ) {
          close(unavailable ? 1013 : 4401, unavailable ? 'auth unavailable' : 'invalid token');
          return;
        }
        let ownerConnections = 0;
        for (const connectedUser of connectionUsers.values()) {
          if (connectedUser.id === user.id) ownerConnections++;
        }
        if (ownerConnections >= MAX_CONNECTIONS_PER_OWNER) {
          close(1013, 'owner connection limit');
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        clients.add(ws);
        subscriptions.set(ws, new Set());
        authorizeUntil(user, checkedAt);
        refreshTimer = setTimeout(() => { void refreshAuthorization(); }, authorizationRefreshMs);
        debugBus.recordWs({
          action: 'connect',
          summary: `client connected (${clients.size} total)`,
          meta: { userId: user.id, clients: clients.size },
        });
        console.log(`WebSocket client connected (user=${user.id})`);
        sendToClient(ws, {
          type: 'connection:status',
          payload: { connected: true },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!canDeliver(ws)) {
        close(4401, 'authorization expired');
        return;
      }
      if (pendingMessages >= MAX_PENDING_MESSAGES) {
        close(1008, 'too many pending messages');
        return;
      }
      pendingMessages++;
      messageChain = messageChain.then(async () => {
        if (!closed && canDeliver(ws)) await handleMessage(ws, message, close);
      }).catch(() => {
        if (!closed) close(1013, 'message handling failed');
      }).finally(() => { pendingMessages--; });
    });

    ws.on('close', cleanup);

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      cleanup();
      ws.terminate();
    });
  });
}

async function handleMessage(
  ws: WebSocket,
  message: Record<string, unknown>,
  close: (code: number, reason: string) => void
): Promise<void> {
  if (message.type === 'subscribe' || message.type === 'unsubscribe') {
    if (typeof message.workspaceId !== 'string' || !message.workspaceId || message.workspaceId.length > 128) {
      close(1008, 'invalid workspace');
      return;
    }
  }
  // Inbound message trace. Skip `ping` — it fires every 25s per client and
  // would drown out the signal.
  if (message?.type && message.type !== 'ping') {
    debugBus.recordWs({
      action: 'recv',
      summary: `recv ${message.type}${message.workspaceId ? ` ${String(message.workspaceId).slice(0, 8)}` : ''}`,
      meta: { type: message.type },
    });
  }
  switch (message.type) {
    case 'subscribe': {
      // Only allow subscribing to a workspace the connected user owns.
      const workspaceId = message.workspaceId as string;
      const current = subscriptions.get(ws);
      if (!current || current.has(workspaceId)) break;
      if (current.size >= MAX_SUBSCRIPTIONS) {
        close(1008, 'subscription limit');
        break;
      }
      const user = connectionUsers.get(ws);
      if (!user) break;
      const allowed = await userOwnsWorkspace(user.id, workspaceId);
      if (allowed && canDeliver(ws)) {
        subscriptions.get(ws)?.add(workspaceId);
      }
      break;
    }

    case 'unsubscribe':
      if (message.workspaceId) {
        subscriptions.get(ws)?.delete(message.workspaceId as string);
      }
      break;

    case 'debug:filter': {
      // Admin-only: set which owner's debug events this client receives live.
      // `owner` is an account id, 'system', 'all', or null. Non-admins are
      // ignored (they never receive debug events regardless).
      if (!connectionUsers.get(ws)?.isAdmin) break;
      const owner = message.owner;
      if (typeof owner === 'string' && owner.length > 128) {
        close(1008, 'invalid owner');
        break;
      }
      debugFilters.set(ws, typeof owner === 'string' ? owner : undefined);
      break;
    }

    case 'ping':
      sendToClient(ws, {
        type: 'connection:status',
        payload: { pong: true },
        timestamp: new Date().toISOString(),
      });
      break;

    default:
      close(1008, 'unknown message type');
  }
}

async function userOwnsWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const db = getDbClient();
  const rows = await db
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId === userId;
}

function sendToClient(ws: WebSocket, event: WSEvent): void {
  if (canDeliver(ws)) {
    ws.send(JSON.stringify(event));
  }
}

// Deliver to this replica's local clients only. Shared by the public
// broadcasters and by wsBus when re-delivering an event from another replica.
function deliverBroadcastLocal(event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const client of clients) {
    if (canDeliver(client)) {
      client.send(message);
      sent++;
    }
  }
  // CRITICAL loop-guard: recording a debug:event broadcast would feed the
  // live sink, which broadcasts another debug:event → infinite recursion.
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → ${sent} client${sent === 1 ? '' : 's'}`,
      meta: { type: event.type, recipients: sent },
    });
  }
}

function deliverToWorkspaceLocal(workspaceId: string, event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const [client, workspaces] of subscriptions) {
    if (workspaces.has(workspaceId) && canDeliver(client)) {
      client.send(message);
      sent++;
    }
  }
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → ws:${workspaceId.slice(0, 8)} (${sent})`,
      meta: { type: event.type, workspaceId, recipients: sent },
    });
  }
}

function deliverToUserLocal(userId: string, event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const [client, user] of connectionUsers) {
    if (user.id === userId && canDeliver(client)) {
      client.send(message);
      sent++;
    }
  }
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → user:${userId.slice(0, 8)} (${sent})`,
      meta: { type: event.type, userId, recipients: sent },
    });
  }
}

// Broadcast to all clients — local, then fan out to the other replicas.
export function broadcast(event: WSEvent): void {
  deliverBroadcastLocal(event);
  publishBroadcast(event);
}

// Broadcast to clients subscribed to a specific workspace — local, then fan out.
export function broadcastToWorkspace(workspaceId: string, event: WSEvent): void {
  deliverToWorkspaceLocal(workspaceId, event);
  publishToWorkspace(workspaceId, event);
}

// Broadcast to every connection authenticated as `userId` — local, then fan
// out. For owner-level (not workspace-level) resources like environment
// markers, where a global broadcast would leak rows across tenants.
export function broadcastToUser(userId: string, event: WSEvent): void {
  deliverToUserLocal(userId, event);
  publishToUser(userId, event);
}

// Helper functions for common events
export function emitTaskStatus(workspaceId: string, taskId: string, status: string, result?: unknown): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:status',
    payload: { taskId, status, result },
    timestamp: new Date().toISOString(),
  });
  domainEvents.emit('task:status', {
    workspaceId,
    taskId,
    status: status as TaskStatus,
  });
}

export function emitTaskUpdate(
  workspaceId: string,
  taskId: string,
  updates: Partial<Task>
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:update',
    payload: { taskId, updates },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskDeleted(workspaceId: string, taskId: string): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:deleted',
    payload: { taskId },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired when a task is created. The desktop adds it to the task list live
 * (deduped by id), so backend-created tasks — merge-queue / auto-keep fix runs
 * — show up in the Tasks screen and the PR task badge resolves to a real task.
 */
export function emitTaskCreated(workspaceId: string, task: Task): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:created',
    payload: { task },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskEvent(
  workspaceId: string,
  taskId: string,
  event: AgentEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:event',
    payload: { taskId, event },
    timestamp: new Date().toISOString(),
  });
}

export interface ChangedFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  added: number;
  removed: number;
  binary: boolean;
}

export function emitTaskFilesChanged(
  workspaceId: string,
  taskId: string,
  files: ChangedFileEntry[]
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:files_changed',
    payload: { taskId, files },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired after every prCache upsert. The payload carries enough for the
 * GitHub page table + the task screen pill to patch in place without a
 * round-trip:
 *
 *   - id (pull_requests.id)
 *   - taskId (nullable)
 *   - the full lastSummary jsonb shape
 *   - state (open/closed/merged)
 *
 * Recent reviews/comments arrays are NOT included — those are
 * delta-detection inputs and the detail panel paginates on demand.
 */
export function emitPullRequestUpdated(
  workspaceId: string,
  payload: {
    id: string;
    taskId: string | null;
    repositoryId: string;
    owner: string;
    repo: string;
    number: number;
    state: string;
    lastSummary: Record<string, unknown>;
    // Relationship flags — present so the GitHub page can re-bucket a row
    // (Mine / Review) live, e.g. when a PR drops off Review after the user
    // reviews it. Optional: emitters that don't change them omit them.
    reviewRequested?: boolean;
    authored?: boolean;
    // When the PR entered the review-requested cohort. Emitted with the flag
    // transition that set it, so the Reviews tab's age term is right the
    // moment the row appears rather than at the next full refresh — which
    // matters because a freshly-requested PR is exactly the case the term
    // exists to get right. Optional and `??`-preserved on the client, like the
    // flags above: every other emitter omits it.
    reviewRequestedFirstSeenAt?: string | null;
    // Manual-watch flag. Optional for the SAME reason as the two above, but the
    // consequence is sharper: prCache's upsert and the monitor's flag reconcile
    // both emit this event and neither knows about `watching`, so a REQUIRED
    // field would cost a read-back on the hottest write path. Only the two
    // /watch routes ever set it — every other emitter omits it, and the client
    // preserves its current value with `??` (never `||`: the un-watch emit
    // sends `false` and it must not be swallowed).
    watching?: boolean;
    // The Reviews-tab hide, as an ISO instant or null. Optional and
    // `??`-preserved on the client like the flags above — only the hide route
    // emits it, and `null` is a real value here (an unhide), so the client must
    // distinguish "absent" from "null" rather than treating both as visible.
    reviewHiddenAt?: string | null;
    // Auto-keep-mergeable watcher state, so the toggle + row badge update live.
    // Optional: emitters that don't change them omit them.
    autoKeepMergeable?: boolean;
    autoMergeState?: { attempts: number; paused: boolean } | null;
    // Merge queue state, so the queue toggle + row badge update live.
    // Optional: emitters that don't change them omit them.
    mergeQueued?: boolean;
    // The merge queue's payload — full status vocabulary, per-head budgets and
    // auto-merge state (services/mergeQueue/legacy.ts toPublicMergeQueue). Was
    // emitted alongside a four-status `mergeQueueState` for builds predating
    // it; that shim was retired on 2026-09-01.
    mergeQueue?: Record<string, unknown> | null;
  }
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'pull_request:updated',
    payload,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired once when a merge-queue PR transitions into `blocked` (gave up after
 * its retry budget). The desktop surfaces it as an OS notification + toast.
 */
/**
 * Fired once when the auto-keep watcher stands down on a PR because the run
 * reported it needs a person. Distinct from `merge_queue:blocked`: nothing was
 * given up on, and the watcher re-arms itself when the blockers change.
 */
export function emitAutoKeepNeedsHuman(
  workspaceId: string,
  payload: AutoKeepNeedsHumanEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'auto_keep:needs_human',
    payload,
    timestamp: new Date().toISOString(),
  });
}

export function emitMergeQueueBlocked(
  workspaceId: string,
  payload: MergeQueueBlockedEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'merge_queue:blocked',
    payload,
    timestamp: new Date().toISOString(),
  });
}

/**
 * One workflow finished acting on one PR.
 *
 * Carries the whole settled run so the Workflows page can prepend it to the
 * history and re-derive its stat counters without a refetch. Workspace-scoped:
 * a workflow belongs to a workspace, and a broadcast() here would ship one
 * tenant's automation history to every open socket.
 */
export function emitWorkflowRun(workspaceId: string, run: WorkflowRun): void {
  broadcastToWorkspace(workspaceId, {
    type: 'workflow:run',
    payload: run,
    timestamp: new Date().toISOString(),
  });
}

/**
 * One loop firing reached a new state.
 *
 * Carries the whole run so the Loops page can prepend it to the history and
 * re-derive its counters without a refetch — the `emitWorkflowRun` argument.
 * Fired on every transition, not only the terminal one, because the states a
 * loop run passes through are exactly what somebody watching wants to see:
 * queued, running, and whether it got a task slot at all.
 */
export function emitLoopRun(workspaceId: string, run: LoopRun): void {
  broadcastToWorkspace(workspaceId, {
    type: 'loop:run',
    payload: run,
    timestamp: new Date().toISOString(),
  });
}

// Environments are owner-level rows, so these emits are scoped to the owning
// user — a global broadcast() here sent user A's environment rows to user B.
export function emitEnvironmentStatus(
  ownerId: string,
  environmentId: string,
  status: string,
  error?: string
): void {
  broadcastToUser(ownerId, {
    type: 'environment:status',
    payload: { environmentId, status, error },
    timestamp: new Date().toISOString(),
  });
}

export function emitEnvironmentCreated(ownerId: string, environment: Environment): void {
  broadcastToUser(ownerId, {
    type: 'environment:created',
    payload: { environment },
    timestamp: new Date().toISOString(),
  });
}

// Billing is a per-user fact — fired by the Polar webhook handler after a
// plan change so every open desktop updates without polling.
export function emitSubscriptionUpdated(ownerId: string, status: BillingStatus): void {
  broadcastToUser(ownerId, {
    type: 'subscription:updated',
    payload: status,
    timestamp: new Date().toISOString(),
  });
}
