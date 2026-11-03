import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_SESSION_STUCK_PROVISIONING_MS,
  type AdminPage,
  type AdminSessionChat,
  type AdminSessionDetail,
  type AdminSessionEventMeta,
  type AdminSessionSetup,
  type AdminSessionSummary,
  type AdminSessionTurn,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  repositorySetupSteps as setupStepsTable,
  users as usersTable,
  workbenchChats as chatsTable,
  workbenchEvents as eventsTable,
  workbenchTurnTimings as turnTimingsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { clampLimit, decodeCursor, encodeCursor, searchTerm } from './queries.js';
import { readAdminSandbox } from './fleetProxy.js';
import { adminRunFromFleet, applyClassification } from './runIndex.js';
import { classifySandbox, loadSandboxClaims } from './sandboxClaims.js';

/**
 * Sessions and threads (workbenches) across every account, for the operator
 * console. Read-only.
 *
 * Egress: `workbenches.settings`, `source` and `diff_stat` are jsonb and stay in
 * Postgres; the few keys the page shows are read out in SQL. Chats are counted
 * in SQL rather than fetched, and `workbench_chats` is never read whole: its
 * `queued_messages`, `turn_parser`, `turn_message` and `agent_backup` columns
 * hold another tenant's prompts and can be large. Transcript events are read as
 * their TYPE words only — the content is the conversation itself.
 */

export const ADMIN_SESSION_LIST_COLUMNS = {
  id: workbenchesTable.id,
  kind: workbenchesTable.kind,
  workspaceId: workbenchesTable.workspaceId,
  repoFullName: workbenchesTable.repoFullName,
  title: workbenchesTable.title,
  name: workbenchesTable.name,
  branch: workbenchesTable.branch,
  runtime: workbenchesTable.runtime,
  agent: workbenchesTable.agent,
  model: workbenchesTable.model,
  status: workbenchesTable.status,
  statusMessage: workbenchesTable.statusMessage,
  sandboxState: workbenchesTable.sandboxState,
  sandboxId: workbenchesTable.sandboxId,
  fleetHost: workbenchesTable.fleetHost,
  pullRequestId: workbenchesTable.pullRequestId,
  archivedAt: workbenchesTable.archivedAt,
  createdAt: workbenchesTable.createdAt,
  updatedAt: workbenchesTable.updatedAt,
  sandboxSize: sql<string | null>`${workbenchesTable.settings} ->> 'sandboxSize'`.as('sandbox_size'),
  source: sql<string | null>`${workbenchesTable.source} ->> 'kind'`.as('source_kind'),
  chatCount: sql<number>`(select count(*) from ${chatsTable} where ${chatsTable.workbenchId} = ${workbenchesTable.id} and ${chatsTable.closedAt} is null)`.as(
    'chat_count',
  ),
  runningChats: sql<number>`(select count(*) from ${chatsTable} where ${chatsTable.workbenchId} = ${workbenchesTable.id} and ${chatsTable.status} = 'running')`.as(
    'running_chats',
  ),
  lastChatAt: sql<string | null>`(select max(${chatsTable.updatedAt}) from ${chatsTable} where ${chatsTable.workbenchId} = ${workbenchesTable.id})`.as(
    'last_chat_at',
  ),
  workspaceName: workspacesTable.name,
  ownerEmail: usersTable.email,
} as const;

export const ADMIN_SESSION_DETAIL_COLUMNS = {
  ...ADMIN_SESSION_LIST_COLUMNS,
  baseBranch: workbenchesTable.baseBranch,
  threadId: workbenchesTable.threadId,
  repositoryId: workbenchesTable.repositoryId,
  sandboxGeneration: workbenchesTable.sandboxGeneration,
  archivePendingAt: workbenchesTable.archivePendingAt,
  archiveFailures: workbenchesTable.archiveFailures,
  restoreRequestedAt: workbenchesTable.restoreRequestedAt,
  memoryRestorePending: workbenchesTable.memoryRestorePending,
  workCheckpointSha: workbenchesTable.workCheckpointSha,
  workCheckpointAt: workbenchesTable.workCheckpointAt,
  workCheckpointBytes: workbenchesTable.workCheckpointBytes,
  fleetSandboxId: sql<string | null>`${workbenchesTable.settings} ->> 'fleetSandboxId'`.as('fleet_sandbox_id'),
  moveSandboxId: sql<string | null>`${workbenchesTable.settings} ->> 'moveSandboxId'`.as('move_sandbox_id'),
  keptSandboxIds: sql<unknown>`${workbenchesTable.settings} -> 'keptSandboxIds'`.as('kept_sandbox_ids'),
  internetAccess: sql<string | null>`${workbenchesTable.settings} ->> 'internetAccess'`.as('internet_access'),
  slackPermalink: sql<string | null>`${workbenchesTable.source} ->> 'permalink'`.as('slack_permalink'),
} as const;

/** The chat columns the detail shows. Never the prompt-bearing jsonb columns. */
export const ADMIN_SESSION_CHAT_COLUMNS = {
  id: chatsTable.id,
  title: chatsTable.title,
  agent: chatsTable.agent,
  model: chatsTable.model,
  status: chatsTable.status,
  statusMessage: chatsTable.statusMessage,
  turnCount: chatsTable.turnCount,
  turnStartedAt: chatsTable.turnStartedAt,
  turnHeartbeatAt: chatsTable.turnHeartbeatAt,
  closedAt: chatsTable.closedAt,
  createdAt: chatsTable.createdAt,
  updatedAt: chatsTable.updatedAt,
  queuedCount: sql<number>`jsonb_array_length(coalesce(${chatsTable.queuedMessages}, '[]'::jsonb))`.as('queued_count'),
} as const;

/** Event metadata only. `event` itself never leaves Postgres. */
export const ADMIN_SESSION_EVENT_COLUMNS = {
  chatId: eventsTable.chatId,
  seq: eventsTable.seq,
  turn: eventsTable.turn,
  createdAt: eventsTable.createdAt,
  type: sql<string | null>`${eventsTable.event} ->> 'type'`.as('event_type'),
  subtype: sql<string | null>`${eventsTable.event} ->> 'subtype'`.as('event_subtype'),
} as const;

export const ADMIN_SESSION_TURN_COLUMNS = {
  chatId: turnTimingsTable.chatId,
  turn: turnTimingsTable.turn,
  wallMs: turnTimingsTable.wallMs,
  toolMs: turnTimingsTable.toolMs,
  modelMs: turnTimingsTable.modelMs,
  calls: turnTimingsTable.calls,
  createdAt: turnTimingsTable.createdAt,
} as const;

export const ADMIN_SETUP_STEP_COLUMNS = {
  id: setupStepsTable.id,
  kind: setupStepsTable.kind,
  phase: setupStepsTable.phase,
  command: sql<string>`left(${setupStepsTable.command}, 200)`.as('command_head'),
  sessionCount: setupStepsTable.sessionCount,
  confirmedAt: setupStepsTable.confirmedAt,
  disabledAt: setupStepsTable.disabledAt,
  boxFailureCount: setupStepsTable.boxFailureCount,
  boxDisabledAt: setupStepsTable.boxDisabledAt,
  boxLastFailure: sql<string | null>`left(${setupStepsTable.boxLastFailure}, 300)`.as('box_last_failure_head'),
  typicalDurationMs: setupStepsTable.typicalDurationMs,
  ordinal: setupStepsTable.ordinal,
} as const;

export type AdminSessionState = 'live' | 'archived' | 'all' | 'stuck' | 'failing' | 'asleep';

export interface AdminSessionFilters {
  q?: unknown;
  kind?: unknown;
  status?: unknown;
  state?: unknown;
  host?: unknown;
  owner?: unknown;
  runtime?: unknown;
  limit?: unknown;
  before?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The WHERE clause for a session list. Exported so the egress test can render it. */
export function sessionListWhere(filters: AdminSessionFilters, now: number = Date.now()): SQL | undefined {
  const where: (SQL | undefined)[] = [];
  const cursor = decodeCursor(str(filters.before) || undefined);
  if (cursor) {
    where.push(
      or(
        lt(workbenchesTable.createdAt, cursor.createdAt),
        and(eq(workbenchesTable.createdAt, cursor.createdAt), lt(workbenchesTable.id, cursor.id)),
      ),
    );
  }
  const kind = str(filters.kind);
  if (kind === 'session' || kind === 'thread') where.push(eq(workbenchesTable.kind, kind));
  const status = str(filters.status);
  if (status) where.push(eq(workbenchesTable.status, status));
  const host = str(filters.host);
  if (host) where.push(eq(workbenchesTable.fleetHost, host));
  const runtime = str(filters.runtime);
  if (runtime === 'sandbox' || runtime === 'local') where.push(eq(workbenchesTable.runtime, runtime));
  const owner = searchTerm(filters.owner);
  if (owner) where.push(ilike(usersTable.email, owner));
  const q = searchTerm(filters.q);
  if (q) {
    where.push(
      or(
        ilike(workbenchesTable.title, q),
        ilike(workbenchesTable.name, q),
        ilike(workbenchesTable.repoFullName, q),
        ilike(workbenchesTable.branch, q),
      ),
    );
  }

  const state = (str(filters.state) || 'live') as AdminSessionState;
  switch (state) {
    case 'all':
      break;
    case 'archived':
      where.push(isNotNull(workbenchesTable.archivedAt));
      break;
    case 'stuck':
      // No change for the stuck window while provisioning. `updated_at` and
      // not `created_at`, so a restore of an old session is judged by its own
      // start and not by the session's age.
      where.push(isNull(workbenchesTable.archivedAt));
      where.push(eq(workbenchesTable.status, 'provisioning'));
      where.push(lt(workbenchesTable.updatedAt, new Date(now - ADMIN_SESSION_STUCK_PROVISIONING_MS)));
      break;
    case 'failing':
      where.push(inArray(workbenchesTable.status, ['error', 'archiveError']));
      break;
    case 'asleep':
      where.push(isNull(workbenchesTable.archivedAt));
      where.push(eq(workbenchesTable.sandboxState, 'suspended'));
      break;
    default:
      where.push(isNull(workbenchesTable.archivedAt));
  }
  return and(...where.filter(Boolean));
}

/** The list query, exported so the egress test can render it with `.toSQL()`. */
export function sessionListQuery(filters: AdminSessionFilters, limit: number, now: number = Date.now()) {
  return getPoolDbClient()
    .select(ADMIN_SESSION_LIST_COLUMNS)
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workbenchesTable.workspaceId, workspacesTable.id))
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(sessionListWhere(filters, now))
    .orderBy(desc(workbenchesTable.createdAt), desc(workbenchesTable.id))
    .limit(limit + 1);
}

type SessionListRow = Awaited<ReturnType<typeof sessionListQuery>>[number];

function isoOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toSessionSummary(row: SessionListRow, now: number = Date.now()): AdminSessionSummary {
  const updatedAt = isoOf(row.updatedAt) ?? new Date(0).toISOString();
  const lastChat = isoOf(row.lastChatAt);
  return {
    id: row.id,
    kind: row.kind === 'thread' ? 'thread' : 'session',
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName ?? null,
    ownerEmail: row.ownerEmail ?? null,
    repoFullName: row.repoFullName,
    title: row.title || row.name,
    name: row.name,
    branch: row.branch,
    runtime: row.runtime,
    agent: row.agent,
    model: row.model ?? null,
    status: row.status,
    statusMessage: row.statusMessage ?? null,
    sandboxState: row.sandboxState,
    sandboxId: row.sandboxId ?? null,
    fleetHost: row.fleetHost ?? null,
    sandboxSize: row.sandboxSize ?? null,
    source: row.source ?? null,
    pullRequestId: row.pullRequestId ?? null,
    chatCount: Number(row.chatCount ?? 0),
    runningChats: Number(row.runningChats ?? 0),
    lastActivityAt: lastChat && lastChat > updatedAt ? lastChat : updatedAt,
    stuckProvisioning:
      !row.archivedAt &&
      row.status === 'provisioning' &&
      now - Date.parse(updatedAt) >= ADMIN_SESSION_STUCK_PROVISIONING_MS,
    archivedAt: isoOf(row.archivedAt),
    createdAt: isoOf(row.createdAt) ?? updatedAt,
    updatedAt,
  };
}

export async function listAdminSessions(filters: AdminSessionFilters): Promise<AdminPage<AdminSessionSummary>> {
  const limit = clampLimit(filters.limit);
  const now = Date.now();
  const rows = await sessionListQuery(filters, limit, now);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toSessionSummary(row, now)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: new Date(last.createdAt), id: last.id }) : null,
  };
}

/** Recent transcript events per chat, newest first. Uses the (chat_id, seq) key. */
const EVENTS_PER_CHAT = 15;
const EVENTS_SHOWN = 30;
const TURNS_SHOWN = 20;

export async function getAdminSession(
  id: string,
  opts: { live?: boolean } = {},
): Promise<AdminSessionDetail | null> {
  const db = getPoolDbClient();
  const now = Date.now();
  const rows = await db
    .select(ADMIN_SESSION_DETAIL_COLUMNS)
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workbenchesTable.workspaceId, workspacesTable.id))
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(eq(workbenchesTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const chatRows = await db
    .select(ADMIN_SESSION_CHAT_COLUMNS)
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, id))
    .orderBy(chatsTable.createdAt);

  const [turnRows, eventRows, pr, setup, live] = await Promise.all([
    db
      .select(ADMIN_SESSION_TURN_COLUMNS)
      .from(turnTimingsTable)
      .where(eq(turnTimingsTable.workbenchId, id))
      .orderBy(desc(turnTimingsTable.createdAt))
      .limit(TURNS_SHOWN),
    Promise.all(
      chatRows.slice(-10).map((chat) =>
        db
          .select(ADMIN_SESSION_EVENT_COLUMNS)
          .from(eventsTable)
          .where(eq(eventsTable.chatId, chat.id))
          .orderBy(desc(eventsTable.seq))
          .limit(EVENTS_PER_CHAT),
      ),
    ).then((lists) => lists.flat()),
    row.pullRequestId
      ? db
          .select({
            number: pullRequestsTable.number,
            owner: pullRequestsTable.owner,
            repo: pullRequestsTable.repo,
            state: pullRequestsTable.state,
          })
          .from(pullRequestsTable)
          .where(eq(pullRequestsTable.id, row.pullRequestId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    row.repositoryId ? loadSetup(row.repositoryId, id) : Promise.resolve(null),
    opts.live !== false && row.runtime === 'sandbox' && row.sandboxId
      ? readLiveSandbox(row.fleetSandboxId || row.sandboxId, row.fleetHost)
      : Promise.resolve({ sandbox: null, error: null }),
  ]);

  const chats: AdminSessionChat[] = chatRows.map((chat) => ({
    id: chat.id,
    title: chat.title,
    agent: chat.agent,
    model: chat.model ?? null,
    status: chat.status,
    statusMessage: chat.statusMessage ?? null,
    turnCount: chat.turnCount,
    queuedCount: Number(chat.queuedCount ?? 0),
    turnStartedAt: isoOf(chat.turnStartedAt),
    turnHeartbeatAt: isoOf(chat.turnHeartbeatAt),
    closedAt: isoOf(chat.closedAt),
    updatedAt: isoOf(chat.updatedAt) ?? '',
  }));
  const turns: AdminSessionTurn[] = turnRows.map((t) => ({
    chatId: t.chatId,
    turn: t.turn,
    wallMs: Number(t.wallMs),
    toolMs: Number(t.toolMs),
    modelMs: Number(t.modelMs),
    calls: t.calls,
    at: isoOf(t.createdAt) ?? '',
  }));
  const events: AdminSessionEventMeta[] = eventRows
    .map((e) => ({
      chatId: e.chatId,
      seq: Number(e.seq),
      turn: e.turn,
      type: e.type ?? null,
      subtype: e.subtype ?? null,
      at: isoOf(e.createdAt) ?? '',
    }))
    .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : b.seq - a.seq))
    .slice(0, EVENTS_SHOWN);

  return {
    ...toSessionSummary(row, now),
    baseBranch: row.baseBranch,
    threadId: row.threadId ?? null,
    sandboxGeneration: row.sandboxGeneration ?? null,
    fleetSandboxId: row.fleetSandboxId ?? null,
    moveSandboxId: row.moveSandboxId ?? null,
    keptSandboxIds: stringArray(row.keptSandboxIds),
    internetAccess: row.internetAccess !== 'false',
    archivePendingAt: isoOf(row.archivePendingAt),
    archiveFailures: row.archiveFailures,
    restoreRequestedAt: isoOf(row.restoreRequestedAt),
    memoryRestorePending: row.memoryRestorePending ?? null,
    workCheckpoint: row.workCheckpointSha
      ? { sha: row.workCheckpointSha, at: isoOf(row.workCheckpointAt), bytes: row.workCheckpointBytes ?? null }
      : null,
    pullRequest: pr
      ? { ...pr, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` }
      : null,
    slackPermalink: row.slackPermalink ?? null,
    chats,
    turns,
    events,
    setup,
    sandbox: live.sandbox,
    sandboxError: live.error,
  };
}

async function loadSetup(repositoryId: string, workbenchId: string): Promise<AdminSessionSetup> {
  const db = getPoolDbClient();
  const [timingRows, steps] = await Promise.all([
    db
      .select({ timing: sql<unknown>`${repositoriesTable.settings} -> 'setupTiming'`.as('setup_timing') })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, repositoryId))
      .limit(1),
    db
      .select(ADMIN_SETUP_STEP_COLUMNS)
      .from(setupStepsTable)
      .where(eq(setupStepsTable.repositoryId, repositoryId))
      .orderBy(setupStepsTable.ordinal),
  ]);
  const raw = timingRows[0]?.timing;
  const timing = (typeof raw === 'string' ? safeParse(raw) : raw) as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    timing:
      timing && num(timing.totalMs) != null
        ? {
            totalMs: num(timing.totalMs)!,
            repositoryMs: num(timing.repositoryMs),
            learnedMs: num(timing.learnedMs) ?? 0,
            measuredAt: typeof timing.measuredAt === 'string' ? timing.measuredAt : '',
            thisSession: timing.workbenchId === workbenchId,
          }
        : null,
    steps: steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      phase: s.phase,
      command: s.command,
      sessionCount: s.sessionCount,
      live: s.confirmedAt != null && s.disabledAt == null && s.boxDisabledAt == null,
      disabled: s.disabledAt != null,
      boxFailureCount: s.boxFailureCount,
      boxDisabled: s.boxDisabledAt != null,
      boxLastFailure: s.boxLastFailure ?? null,
      typicalDurationMs: s.typicalDurationMs ?? null,
    })),
  };
}

/** The session's box as the Runs page shows it. Never throws: a dead fleet is a reason, not a 500. */
async function readLiveSandbox(
  sandboxId: string,
  recordedHost: string | null,
): Promise<{ sandbox: AdminSessionDetail['sandbox']; error: string | null }> {
  try {
    const { sandbox, host } = await readAdminSandbox(sandboxId, recordedHost ?? '-');
    const claims = await loadSandboxClaims([sandbox.id]);
    return {
      sandbox: applyClassification(
        adminRunFromFleet(sandbox, host ?? recordedHost),
        classifySandbox(sandbox.id, claims),
      ),
      error: null,
    };
  } catch (err) {
    return { sandbox: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function stringArray(raw: unknown): string[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
