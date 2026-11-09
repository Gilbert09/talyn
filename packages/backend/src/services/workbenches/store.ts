import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, isNotNull, or, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import type {
  AgentEvent,
  AgentStreamSnapshot,
  Workbench,
  WorkbenchAgent,
  WorkbenchChat,
  WorkbenchChatStatus,
  WorkbenchCheckpoint,
  WorkbenchEffort,
  WorkbenchEvent,
  WorkbenchImportedFrom,
  WorkbenchKind,
  WorkbenchQueuedMessage,
  WorkbenchRuntimeKind,
  WorkbenchSandboxState,
  WorkbenchStatus,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import {
  workbenchChats as chatsTable,
  workbenchCheckpoints as checkpointsTable,
  workbenchEvents as eventsTable,
  workbenches as workbenchesTable,
  workbenchTurnTimings,
} from '../../db/schema.js';
import { TURN_OWNER, isWorkbenchDraining } from './ownership.js';
import { emitWorkbenchChat, emitWorkbenchEvents } from './emit.js';
import { isRestoring } from './restorePhase.js';
import { cleanJsonbString, stringifyJsonbSafe, toJsonbSafe } from './jsonSafe.js';
import { BOX_START_SETTINGS_KEYS } from './boxStart.js';
import { publicStartProgress } from './startProgress.js';
import { bootSampleFromMetric, storeBootSamples } from '../insights/bootSamples.js';

/**
 * Reads and writes for the four workbench tables.
 *
 * # Every query runs on the POOL
 *
 * Routes authorise first (`requireWorkspaceAccess`), then call here. The pool
 * rather than the request's owner-scoped transaction, for one reason that
 * matters: almost every write here is followed by background work (a
 * provision, a turn) that reads the row back on the pool. A row written inside
 * the request transaction is invisible to that work until the response has
 * gone and the transaction committed — a race the background job loses on a
 * fast path. Writing on the pool commits before the job starts.
 *
 * # Egress
 *
 * Explicit projections throughout. Transcript pages and the thread wake guard
 * read `workbench_events.event`; workbench and chat lists do not.
 */

const db = (): Database => getPoolDbClient();

/** Every workbench column. Explicit, so a column added later is opted in on purpose. */
export const WORKBENCH_COLUMNS = {
  id: workbenchesTable.id,
  workspaceId: workbenchesTable.workspaceId,
  repositoryId: workbenchesTable.repositoryId,
  repoFullName: workbenchesTable.repoFullName,
  kind: workbenchesTable.kind,
  threadId: workbenchesTable.threadId,
  name: workbenchesTable.name,
  title: workbenchesTable.title,
  branch: workbenchesTable.branch,
  baseBranch: workbenchesTable.baseBranch,
  runtime: workbenchesTable.runtime,
  agent: workbenchesTable.agent,
  model: workbenchesTable.model,
  deviceId: workbenchesTable.deviceId,
  localPath: workbenchesTable.localPath,
  sandboxId: workbenchesTable.sandboxId,
  sandboxGeneration: workbenchesTable.sandboxGeneration,
  sandboxState: workbenchesTable.sandboxState,
  memoryRestorePending: workbenchesTable.memoryRestorePending,
  archivePendingAt: workbenchesTable.archivePendingAt,
  archiveRetryAt: workbenchesTable.archiveRetryAt,
  restoreRequestedAt: workbenchesTable.restoreRequestedAt,
  archiveLeaseUntil: workbenchesTable.archiveLeaseUntil,
  archiveFailures: workbenchesTable.archiveFailures,
  fleetHost: workbenchesTable.fleetHost,
  status: workbenchesTable.status,
  statusMessage: workbenchesTable.statusMessage,
  startProgress: workbenchesTable.startProgress,
  pullRequestId: workbenchesTable.pullRequestId,
  pullRequestLinkedAt: workbenchesTable.pullRequestLinkedAt,
  pushedHeadShas: workbenchesTable.pushedHeadShas,
  allocatedBranch: workbenchesTable.allocatedBranch,
  settings: workbenchesTable.settings,
  source: workbenchesTable.source,
  diffStat: workbenchesTable.diffStat,
  workCheckpointSha: workbenchesTable.workCheckpointSha,
  workCheckpointAt: workbenchesTable.workCheckpointAt,
  workCheckpointBytes: workbenchesTable.workCheckpointBytes,
  workCheckedAt: workbenchesTable.workCheckedAt,
  workUnpushedCommits: workbenchesTable.workUnpushedCommits,
  workSaveFailures: workbenchesTable.workSaveFailures,
  workSaveFailedAt: workbenchesTable.workSaveFailedAt,
  workSaveError: workbenchesTable.workSaveError,
  changesAt: workbenchesTable.changesAt,
  changesEtag: workbenchesTable.changesEtag,
  spaceId: workbenchesTable.spaceId,
  archivedAt: workbenchesTable.archivedAt,
  createdAt: workbenchesTable.createdAt,
  updatedAt: workbenchesTable.updatedAt,
} as const;

export type WorkbenchRow = Pick<typeof workbenchesTable.$inferSelect, keyof typeof WORKBENCH_COLUMNS>;

/** Every chat column. `queued_messages` is bounded by what a person typed during one turn. */
export const CHAT_COLUMNS = {
  id: chatsTable.id,
  workbenchId: chatsTable.workbenchId,
  workspaceId: chatsTable.workspaceId,
  title: chatsTable.title,
  agent: chatsTable.agent,
  model: chatsTable.model,
  effort: chatsTable.effort,
  planMode: chatsTable.planMode,
  agentSessionId: chatsTable.agentSessionId,
  status: chatsTable.status,
  resumeAt: chatsTable.resumeAt,
  resumeReason: chatsTable.resumeReason,
  limitCount: chatsTable.limitCount,
  resumeVersion: chatsTable.resumeVersion,
  statusMessage: chatsTable.statusMessage,
  queuedMessages: chatsTable.queuedMessages,
  turnCount: chatsTable.turnCount,
  payerUserId: chatsTable.payerUserId,
  payerWorkspaceId: chatsTable.payerWorkspaceId,
  importedFrom: chatsTable.importedFrom,
  closedAt: chatsTable.closedAt,
  createdAt: chatsTable.createdAt,
  updatedAt: chatsTable.updatedAt,
} as const;

export type ChatRow = Pick<typeof chatsTable.$inferSelect, keyof typeof CHAT_COLUMNS>;

/** The start timeline and the last wake are for the Sandbox panel only: they stay out of every list and broadcast. */
function publicSettings(settings: WorkbenchRow['settings'] | null): Workbench['settings'] {
  if (!settings) return {};
  if (!BOX_START_SETTINGS_KEYS.some((key) => key in settings)) return settings;
  const out = { ...settings } as Record<string, unknown>;
  for (const key of BOX_START_SETTINGS_KEYS) delete out[key];
  return out as Workbench['settings'];
}

export function rowToWorkbench(row: WorkbenchRow): Workbench {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind === 'thread' ? 'thread' : 'session',
    threadId: row.threadId ?? null,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    name: row.name,
    title: row.title ?? null,
    branch: row.branch,
    baseBranch: row.baseBranch,
    runtime: row.runtime as WorkbenchRuntimeKind,
    agent: row.agent as WorkbenchAgent,
    deviceId: row.deviceId,
    localPath: row.localPath,
    sandboxId: row.sandboxId,
    sandboxState: row.sandboxState as WorkbenchSandboxState,
    status: row.status === 'archiveError' ? 'archiveError' : row.archivedAt ? 'archived' : row.status as WorkbenchStatus,
    statusMessage: row.statusMessage,
    startProgress: publicStartProgress(row),
    pullRequestId: row.pullRequestId,
    settings: publicSettings(row.settings),
    source: row.source ?? null,
    diffStat: row.diffStat ? { added: row.diffStat.added, removed: row.diffStat.removed, files: row.diffStat.files } : null,
    uncommittedStats: row.diffStat?.uncommittedStats ?? null,
    committedStats: row.diffStat?.committedStats ?? null,
    changesAt: row.changesAt ? row.changesAt.toISOString() : null,
    changesEtag: row.changesEtag ?? null,
    spaceId: row.spaceId ?? null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A payer's own workspace id stays on the backend. */
function publicQueuedMessage(message: WorkbenchQueuedMessage): WorkbenchQueuedMessage {
  if (!message.payer?.workspaceId) return message;
  const { workspaceId: _workspaceId, ...payer } = message.payer;
  return { ...message, payer };
}

export function rowToChat(row: ChatRow): WorkbenchChat {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    title: row.title,
    agent: row.agent as WorkbenchAgent,
    model: row.model,
    effort: (row.effort as WorkbenchEffort | null) ?? null,
    planMode: row.planMode,
    agentSessionId: row.agentSessionId,
    resumeAt: row.resumeAt?.toISOString() ?? null,
    resumeReason: row.resumeReason,
    status: row.status as WorkbenchChatStatus,
    queuedMessages: (row.queuedMessages ?? []).map(publicQueuedMessage),
    importedFrom: row.importedFrom ?? null,
    phase: row.status === 'running' && isRestoring(row.id) ? 'restoring' : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================================
// Workbenches
// ============================================================================

export type NewWorkbench = typeof workbenchesTable.$inferInsert;

export async function insertWorkbench(values: NewWorkbench): Promise<WorkbenchRow> {
  const [row] = await db().insert(workbenchesTable).values(values).returning(WORKBENCH_COLUMNS);
  return row;
}

/** A thread: a workbench with no repository that starts sessions. */
export function isThread(row: Pick<WorkbenchRow, 'kind'>): boolean {
  return row.kind === 'thread';
}

/**
 * The list query, exposed so a test can prove it never reads a transcript.
 * `kinds` defaults to sessions only: a client that does not ask for threads
 * does not know what one is.
 */
export function listWorkbenchesQuery(
  workspaceId: string,
  includeArchived: boolean,
  kinds: readonly WorkbenchKind[] = ['session'],
) {
  const where = and(
    eq(workbenchesTable.workspaceId, workspaceId),
    includeArchived ? undefined : isNull(workbenchesTable.archivedAt),
    inArray(workbenchesTable.kind, [...kinds]),
  );
  return db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(where)
    .orderBy(desc(workbenchesTable.createdAt));
}

export async function listWorkbenches(
  workspaceId: string,
  includeArchived = false,
  kinds: readonly WorkbenchKind[] = ['session'],
): Promise<WorkbenchRow[]> {
  return listWorkbenchesQuery(workspaceId, includeArchived, kinds);
}

/** The sessions in a thread, newest first. Archived ones too: the thread reports on them. */
export async function threadSessions(threadId: string): Promise<WorkbenchRow[]> {
  return db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(eq(workbenchesTable.threadId, threadId))
    .orderBy(desc(workbenchesTable.createdAt));
}

export function getWorkbenchQuery(id: string) {
  return db().select(WORKBENCH_COLUMNS).from(workbenchesTable).where(eq(workbenchesTable.id, id)).limit(1);
}

export async function getWorkbench(id: string): Promise<WorkbenchRow | null> {
  return (await getWorkbenchQuery(id))[0] ?? null;
}

/** The session whose box this is. `idx_workbenches_sandbox` answers it. */
export async function getWorkbenchBySandboxId(sandboxId: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(eq(workbenchesTable.sandboxId, sandboxId))
    .limit(1);
  return row ?? null;
}

export async function updateWorkbench(
  id: string,
  patch: Partial<Omit<NewWorkbench, 'id' | 'workspaceId' | 'createdAt'>>,
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workbenchesTable.id, id))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Record a stored work checkpoint, only while the row still names the box it
 * was taken on: a late answer from a lost box must not overwrite a newer one.
 * `updated_at` is left alone, because nothing a person sees changed.
 */
export async function recordWorkCheckpoint(id: string, sandboxId: string, sha: string, at: Date, bytes: number): Promise<boolean> {
  const rows = await db()
    .update(workbenchesTable)
    .set({ workCheckpointSha: sha, workCheckpointAt: at, workCheckpointBytes: bytes })
    .where(and(eq(workbenchesTable.id, id), eq(workbenchesTable.sandboxId, sandboxId)))
    .returning({ id: workbenchesTable.id });
  return rows.length > 0;
}

/** The work is all on GitHub, or an archive superseded the checkpoint: there is none to restore. */
export async function clearWorkCheckpoint(id: string, sandboxId?: string): Promise<void> {
  await db()
    .update(workbenchesTable)
    .set({ workCheckpointSha: null, workCheckpointAt: null, workCheckpointBytes: null })
    .where(sandboxId ? and(eq(workbenchesTable.id, id), eq(workbenchesTable.sandboxId, sandboxId)) : eq(workbenchesTable.id, id));
}

/** The longest save error kept on the row. The panel shows it on one line. */
const WORK_SAVE_ERROR_MAX_CHARS = 500;

/**
 * A save worked: a new checkpoint, a check that found nothing new, or nothing
 * to save. Only while the row still names the box. True when it ends a run of
 * failures, so the caller can say that the work is saved again.
 */
export async function recordWorkSaveSuccess(
  id: string,
  sandboxId: string,
  at: Date,
  unpushed: number | null,
): Promise<boolean> {
  const onBox = and(eq(workbenchesTable.id, id), eq(workbenchesTable.sandboxId, sandboxId));
  const set = { workCheckedAt: at, ...(unpushed === null ? {} : { workUnpushedCommits: unpushed }) };
  const ended = await db()
    .update(workbenchesTable)
    .set({ ...set, workSaveFailures: 0, workSaveFailedAt: null, workSaveError: null })
    .where(and(onBox, gt(workbenchesTable.workSaveFailures, 0)))
    .returning({ id: workbenchesTable.id });
  if (ended.length > 0) return true;
  await db().update(workbenchesTable).set(set).where(onBox);
  return false;
}

/** A save failed. Returns the failures in a row, or null when the row names another box now. */
export async function recordWorkSaveFailure(id: string, sandboxId: string, at: Date, error: string): Promise<number | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      workSaveFailures: sql`${workbenchesTable.workSaveFailures} + 1`,
      workSaveFailedAt: at,
      workSaveError: error.slice(0, WORK_SAVE_ERROR_MAX_CHARS),
    })
    .where(and(eq(workbenchesTable.id, id), eq(workbenchesTable.sandboxId, sandboxId)))
    .returning({ failures: workbenchesTable.workSaveFailures });
  return row?.failures ?? null;
}

/**
 * The newest turn start and turn end of a session, and whether a turn runs
 * now. A lost box's note reads them to say whether the agent ran after the
 * last save. A turn ends when its time report is written, so a turn cut by
 * the loss has a start and no end.
 */
export async function lastTurnActivity(
  workbenchId: string,
): Promise<{ lastStartedAt: Date | null; lastEndedAt: Date | null; running: boolean }> {
  const [chats] = await db()
    .select({
      lastStartedAt: sql<Date | string | null>`max(${chatsTable.turnStartedAt})`,
      running: sql<boolean>`coalesce(bool_or(${chatsTable.status} = 'running'), false)`,
    })
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId));
  const [ends] = await db()
    .select({ lastEndedAt: sql<Date | string | null>`max(${workbenchTurnTimings.createdAt})` })
    .from(workbenchTurnTimings)
    .where(eq(workbenchTurnTimings.workbenchId, workbenchId));
  const date = (raw: Date | string | null | undefined) => (raw === null || raw === undefined ? null : new Date(raw));
  return { lastStartedAt: date(chats?.lastStartedAt), lastEndedAt: date(ends?.lastEndedAt), running: Boolean(chats?.running) };
}

/** `settings` with `ids` added to `keptSandboxIds`. */
function withKeptSandboxIds(ids: string[]) {
  const settings = workbenchesTable.settings;
  return sql`COALESCE(${settings}, '{}'::jsonb) || jsonb_build_object('keptSandboxIds',
    COALESCE(${settings} -> 'keptSandboxIds', '[]'::jsonb) || ${JSON.stringify(ids)}::jsonb)`;
}

/** Mark old boxes of a workbench as kept, so the reaper does not delete them. */
export async function keepSandboxes(id: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db().update(workbenchesTable).set({ settings: withKeptSandboxIds(ids) }).where(eq(workbenchesTable.id, id));
}

/**
 * Claim a lost box once. The old sandbox id keeps late calls from replacing its
 * new box. `keepSandboxIds` go on `settings.keptSandboxIds`, so the reaper
 * does not delete those boxes.
 */
export async function claimLostWorkbench(
  id: string,
  sandboxId: string,
  replacementId: string,
  message: string,
  opts: { keepSandboxIds?: string[] } = {},
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      ...(opts.keepSandboxIds?.length ? { settings: withKeptSandboxIds(opts.keepSandboxIds) } : {}),
      status: 'provisioning',
      statusMessage: message,
      sandboxState: 'lost',
      memoryRestorePending: 'lost',
      sandboxId: replacementId,
      sandboxGeneration: null,
      fleetHost: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.sandboxId, sandboxId),
      eq(workbenchesTable.status, 'ready'),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Claim a move to a new box: `ready` → `moving`, in one statement, only while
 * the row still names `sandboxId`. The target id goes on the row, so no later
 * box reuses its generation, and so do the lease's first heartbeat and nothing
 * else. Null when the workbench is not ready or another move or recovery got
 * there first.
 */
export async function claimMove(
  id: string,
  sandboxId: string,
  targetSandboxId: string,
  message: string,
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      status: 'moving',
      statusMessage: message,
      settings: sql`(COALESCE(${workbenchesTable.settings}, '{}'::jsonb) - 'moveTargetHost' - 'moveFleetSandboxId')
        || jsonb_build_object('moveSandboxId', ${targetSandboxId}::text, 'moveHeartbeatAt', now())`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.sandboxId, sandboxId),
      eq(workbenchesTable.status, 'ready'),
      eq(workbenchesTable.runtime, 'sandbox'),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** The move this row is in: `moving`, off `fromSandboxId`, to `targetSandboxId`. */
function isMove(id: string, fromSandboxId: string, targetSandboxId: string) {
  return and(
    eq(workbenchesTable.id, id),
    eq(workbenchesTable.sandboxId, fromSandboxId),
    eq(workbenchesTable.status, 'moving'),
    sql`${workbenchesTable.settings} ->> 'moveSandboxId' = ${targetSandboxId}`,
  );
}

/** Renew a move's lease. False when the row is no longer in this move. */
export async function heartbeatMove(id: string, fromSandboxId: string, targetSandboxId: string): Promise<boolean> {
  const rows = await db()
    .update(workbenchesTable)
    .set({ settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || jsonb_build_object('moveHeartbeatAt', now())` })
    .where(isMove(id, fromSandboxId, targetSandboxId))
    .returning({ archivedAt: workbenchesTable.archivedAt });
  return rows.length > 0 && rows[0].archivedAt === null;
}

/** Record where the new box was made, so a sweep can delete it on the right host. */
export async function setMoveTargetHost(
  id: string,
  fromSandboxId: string,
  targetSandboxId: string,
  host: string | null,
  fleetSandboxId: string | null = null,
): Promise<void> {
  if (!host) return;
  await db()
    .update(workbenchesTable)
    .set({ settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb)
      || jsonb_build_object('moveTargetHost', ${host}::text, 'moveFleetSandboxId', ${fleetSandboxId}::text)` })
    .where(isMove(id, fromSandboxId, targetSandboxId));
}

/** Running chats of a workbench other than `exceptChatId`. Read after `claimMove` commits. */
export async function otherRunningChats(workbenchId: string, exceptChatId?: string): Promise<number> {
  const rows = await db()
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(and(
      eq(chatsTable.workbenchId, workbenchId),
      eq(chatsTable.status, 'running'),
      ...(exceptChatId ? [ne(chatsTable.id, exceptChatId)] : []),
    ));
  return rows.length;
}

const LEASE_KEYS = sql.raw(`'moveHeartbeatAt' - 'moveTargetHost' - 'moveFleetSandboxId'`);

/**
 * Undo a claim: back to `ready` on the old box. Only for THIS move (the target
 * must match), and with `staleAfterSeconds` only when its lease has lapsed, so
 * a sweep never undoes a move that is still running elsewhere.
 */
export async function releaseMove(
  id: string,
  fromSandboxId: string,
  targetSandboxId: string,
  statusMessage: string | null,
  opts: { staleAfterSeconds?: number } = {},
): Promise<WorkbenchRow | null> {
  const stale =
    opts.staleAfterSeconds === undefined
      ? sql`TRUE`
      : sql`(${workbenchesTable.settings} ->> 'moveHeartbeatAt' IS NULL
          OR (${workbenchesTable.settings} ->> 'moveHeartbeatAt')::timestamptz < now() - make_interval(secs => ${opts.staleAfterSeconds}::int))`;
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      status: sql`CASE WHEN ${workbenchesTable.archivedAt} IS NULL THEN 'ready' ELSE 'archived' END`,
      statusMessage,
      settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) - ${LEASE_KEYS}`,
      updatedAt: new Date(),
    })
    .where(and(isMove(id, fromSandboxId, targetSandboxId), stale))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Finish a move: the row names the new box and is `ready` again. Only while
 * it is still in THIS move and not archived, so a workbench deleted, archived
 * or swept meanwhile is left alone and the caller cleans up. Clears the
 * lease and the failure backoff; `settings` adds keys.
 */
export async function commitMove(
  id: string,
  fromSandboxId: string,
  to: {
    sandboxId: string;
    fleetHost: string | null;
    fleetSandboxId: string | null;
    statusMessage: string | null;
    settings?: Record<string, string>;
    /** The size the new box got. A resize waiting for exactly this size is done. */
    size?: string;
    /** The restart request the move saw at its claim. The new box answers it, so it is done. */
    restartRequestedAt?: string | null;
  },
): Promise<WorkbenchRow | null> {
  const added = { ...(to.fleetSandboxId ? { fleetSandboxId: to.fleetSandboxId } : {}), ...(to.settings ?? {}) };
  const current = sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb)`;
  // Read in the same statement, so a resize or a restart asked for during the move stays.
  const resized = sql`CASE WHEN ${current} ->> 'resizeTo' = ${to.size ?? null}::text
    THEN ${current} - 'resizeTo' - 'resizeReason' ELSE ${current} END`;
  const base = sql`CASE WHEN ${current} ->> 'restartRequestedAt' = ${to.restartRequestedAt ?? null}::text
    THEN (${resized}) - 'restartRequestedAt' - 'restartReason' ELSE (${resized}) END`;
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      status: 'ready',
      statusMessage: to.statusMessage,
      sandboxId: to.sandboxId,
      sandboxGeneration: to.sandboxId,
      sandboxState: 'running',
      fleetHost: to.fleetHost,
      settings: sql`((${base}) - 'fleetSandboxId' - ${LEASE_KEYS}
        - 'moveFailedAt' - 'moveFailures') || ${JSON.stringify(added)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(isMove(id, fromSandboxId, to.sandboxId), isNull(workbenchesTable.archivedAt)))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Moving rows whose lease has lapsed: their move's process is gone. */
export async function staleMovingWorkbenches(staleAfterSeconds: number): Promise<WorkbenchRow[]> {
  return db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(and(
      eq(workbenchesTable.status, 'moving'),
      eq(workbenchesTable.runtime, 'sandbox'),
      sql`(${workbenchesTable.settings} ->> 'moveHeartbeatAt' IS NULL
        OR (${workbenchesTable.settings} ->> 'moveHeartbeatAt')::timestamptz < now() - make_interval(secs => ${staleAfterSeconds}::int))`,
    ));
}

/** Count a failed or refused move on the row, so the backoff survives a deploy. */
export async function recordMoveFailure(id: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || jsonb_build_object(
        'moveFailedAt', now(),
        'moveFailures', COALESCE((${workbenchesTable.settings} ->> 'moveFailures')::int, 0) + 1)`,
    })
    .where(eq(workbenchesTable.id, id))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Merge server-owned keys into a workbench's settings, leaving the rest alone. */
export async function mergeWorkbenchSettings(id: string, values: Record<string, string>): Promise<void> {
  await db()
    .update(workbenchesTable)
    .set({ settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || ${JSON.stringify(values)}::jsonb` })
    .where(eq(workbenchesTable.id, id));
}

/** Ask for a resize at the next move. `reason` null removes an old reason. */
export async function setPendingResize(id: string, size: string, reason: string | null): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      settings: sql`(COALESCE(${workbenchesTable.settings}, '{}'::jsonb) - 'resizeReason')
        || ${JSON.stringify({ resizeTo: size, ...(reason ? { resizeReason: reason } : {}) })}::jsonb`,
    })
    .where(eq(workbenchesTable.id, id))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Forget a waiting resize, only while it still asks for `size`: a newer request stays. */
export async function clearPendingResize(id: string, size: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ settings: sql`${workbenchesTable.settings} - 'resizeTo' - 'resizeReason'` })
    .where(and(eq(workbenchesTable.id, id), sql`${workbenchesTable.settings} ->> 'resizeTo' = ${size}::text`))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Ask for a restart on a fresh box at the next move. `reason` null removes an old reason. */
export async function setPendingRestart(id: string, requestedAt: string, reason: string | null): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      settings: sql`(COALESCE(${workbenchesTable.settings}, '{}'::jsonb) - 'restartReason')
        || ${JSON.stringify({ restartRequestedAt: requestedAt, ...(reason ? { restartReason: reason } : {}) })}::jsonb`,
    })
    .where(eq(workbenchesTable.id, id))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Forget a waiting restart, only while it is still the request made at `requestedAt`: a newer one stays. */
export async function clearPendingRestart(id: string, requestedAt: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ settings: sql`${workbenchesTable.settings} - 'restartRequestedAt' - 'restartReason'` })
    .where(and(eq(workbenchesTable.id, id), sql`${workbenchesTable.settings} ->> 'restartRequestedAt' = ${requestedAt}::text`))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Stop an automatic loop when a second box is lost inside the retry window. */
export async function failLostWorkbench(id: string, sandboxId: string, message: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ status: 'error', statusMessage: message, sandboxState: 'error', updatedAt: new Date() })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.sandboxId, sandboxId),
      eq(workbenchesTable.status, 'ready'),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * The rows a provision may still write: provisioning, live, and on the sandbox
 * id the run used. A Retry or a restore moves the row to a new id, and an
 * archive changes its status, so a stale run's write matches nothing.
 */
function ownedByProvision(id: string, sandboxId: string | null) {
  return and(
    eq(workbenchesTable.id, id),
    eq(workbenchesTable.status, 'provisioning'),
    isNull(workbenchesTable.archivedAt),
    sandboxId === null ? isNull(workbenchesTable.sandboxId) : eq(workbenchesTable.sandboxId, sandboxId),
  );
}

/** Whether the row is still this provision's: the same test its writes make, and no write. */
export async function isProvisionOwned(id: string, sandboxId: string | null): Promise<boolean> {
  const rows = await db()
    .select({ id: workbenchesTable.id })
    .from(workbenchesTable)
    .where(ownedByProvision(id, sandboxId))
    .limit(1);
  return rows.length > 0;
}

/** A provision's write. Null when the row is no longer this provision's. */
export async function updateProvisioningWorkbench(
  id: string,
  sandboxId: string | null,
  patch: Pick<Partial<NewWorkbench>, 'status' | 'statusMessage' | 'sandboxState' | 'memoryRestorePending' | 'startProgress'>,
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(ownedByProvision(id, sandboxId))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Record the box a provision created. Only the keys this step owns change in
 * `settings`, read in the statement: a stale copy of the row must not undo a
 * resize request or a kept sandbox id written since.
 */
export async function recordProvisionedSandbox(
  id: string,
  expectedSandboxId: string | null,
  box: {
    sandboxId: string;
    sandboxState: WorkbenchSandboxState;
    fleetHost: string | null;
    fleetSandboxId: string | null;
    size: string;
    statusMessage: string;
    startProgress: NewWorkbench['startProgress'];
  },
): Promise<WorkbenchRow | null> {
  const s = workbenchesTable.settings;
  const base = sql`(COALESCE(${s}, '{}'::jsonb) - 'fleetSandboxId')`;
  // `boxSize` is the size this box was created at: the usage meter's weight.
  const resized = sql`(CASE WHEN ${s} ->> 'resizeTo' = ${box.size}::text
    THEN (${base} - 'resizeTo' - 'resizeReason') || jsonb_build_object('sandboxSize', ${box.size}::text)
    ELSE ${base} END) || jsonb_build_object('boxSize', ${box.size}::text)`;
  const settings = box.fleetSandboxId
    ? sql`${resized} || jsonb_build_object('fleetSandboxId', ${box.fleetSandboxId}::text)`
    : resized;
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      sandboxId: box.sandboxId,
      sandboxState: box.sandboxState,
      ...(box.fleetHost ? { fleetHost: box.fleetHost } : {}),
      settings,
      statusMessage: box.statusMessage,
      startProgress: box.startProgress,
      updatedAt: new Date(),
    })
    .where(ownedByProvision(id, expectedSandboxId))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Move a provision to a new sandbox id before its box exists: the fleet lost a
 * queued box, and its id answers from a failed record. Null when the row is no
 * longer this provision's.
 */
export async function moveProvisionToSandboxId(
  id: string,
  expectedSandboxId: string | null,
  sandboxId: string,
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ sandboxId, updatedAt: new Date() })
    .where(ownedByProvision(id, expectedSandboxId))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** A provision failed. Null when the row is no longer this provision's. */
export async function failProvisioningWorkbench(id: string, sandboxId: string | null, message: string): Promise<WorkbenchRow | null> {
  return updateProvisioningWorkbench(id, sandboxId, { status: 'error', statusMessage: message, sandboxState: 'error', startProgress: null });
}

/**
 * Set a generated title, but only while the workbench has none. One
 * statement, so a title a person sets at the same moment always wins.
 * Null when nothing changed.
 */
export async function setGeneratedTitle(id: string, title: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(workbenchesTable.id, id), isNull(workbenchesTable.title), isNull(workbenchesTable.archivedAt)))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Claim the one branch-naming attempt (see `branchName.ts`). One statement,
 * so two replicas cannot both claim it. False when it was already decided.
 */
export async function claimBranchNaming(id: string): Promise<boolean> {
  const rows = await db()
    .update(workbenchesTable)
    .set({ branchNamedAt: new Date() })
    .where(and(eq(workbenchesTable.id, id), isNull(workbenchesTable.branchNamedAt)))
    .returning({ id: workbenchesTable.id });
  return rows.length > 0;
}

/** Give the claim back, so a later turn end tries again. */
export async function releaseBranchNaming(id: string): Promise<void> {
  await db().update(workbenchesTable).set({ branchNamedAt: null }).where(eq(workbenchesTable.id, id));
}

export async function branchNamingDecided(id: string): Promise<boolean> {
  const [row] = await db()
    .select({ at: workbenchesTable.branchNamedAt })
    .from(workbenchesTable)
    .where(eq(workbenchesTable.id, id))
    .limit(1);
  return !row || row.at !== null;
}

/** Turns started across every chat of the workbench. */
export async function sessionTurnCount(workbenchId: string): Promise<number> {
  const [row] = await db()
    .select({ turns: sql<number>`COALESCE(SUM(${chatsTable.turnCount}), 0)::int` })
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId));
  return Number(row?.turns ?? 0);
}

/** Check session history before skipping the first checkpoint. */
export async function isFreshSessionTurn(workbenchId: string): Promise<boolean> {
  const [row] = await db()
    .select({ fresh: sql<boolean>`${workbenchesTable.lastActivityAt} IS NULL AND (
      SELECT COALESCE(SUM(${chatsTable.turnCount}), 0) FROM ${chatsTable}
      WHERE ${chatsTable.workbenchId} = ${workbenchId}
    ) = 1` })
    .from(workbenchesTable)
    .where(eq(workbenchesTable.id, workbenchId))
    .limit(1);
  return row?.fresh === true;
}

/**
 * Move a Talyn-named branch from `from` to `to`, but only while the row still
 * says `from` and has no PR. Null when nothing matched. A clash on
 * `uq_workbenches_allocated_branch` throws.
 */
export async function renameAllocatedBranch(id: string, from: string, to: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ branch: to, updatedAt: new Date() })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.branch, from),
      eq(workbenchesTable.allocatedBranch, true),
      isNull(workbenchesTable.pullRequestId),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Turns across every chat of a LOCAL workbench. The desktop runs those turns,
 * so `turn_count` stays 0; the turn of each chat's newest uploaded event is
 * the count. One index lookup per chat.
 */
export async function localSessionTurnCount(workbenchId: string): Promise<number> {
  const [row] = await db()
    .select({
      turns: sql<number>`COALESCE(SUM((
        SELECT ${eventsTable.turn} FROM ${eventsTable}
        WHERE ${eventsTable.chatId} = ${chatsTable.id}
        ORDER BY ${eventsTable.seq} DESC LIMIT 1
      )), 0)::int`,
    })
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId));
  return Number(row?.turns ?? 0);
}

/**
 * The row follows a branch a person (or the agent, at a person's request)
 * renamed: `from` becomes `to`, and the name is no longer Talyn's to move.
 * `allocated_branch` goes false, so the unique index never applies to it, and
 * the one naming attempt counts as decided. Null when the row no longer says
 * `from`, or is archived.
 */
export async function followChosenBranch(id: string, from: string, to: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      branch: to,
      allocatedBranch: false,
      branchNamedAt: sql`COALESCE(${workbenchesTable.branchNamedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(workbenchesTable.id, id), eq(workbenchesTable.branch, from), isNull(workbenchesTable.archivedAt)))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

export async function deleteWorkbenchRow(id: string): Promise<void> {
  await db().delete(workbenchesTable).where(eq(workbenchesTable.id, id));
}

/** Names in use by LIVE workbenches of this workspace — the city picker's input. */
export async function liveWorkbenchNames(workspaceId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: workbenchesTable.name })
    .from(workbenchesTable)
    .where(and(eq(workbenchesTable.workspaceId, workspaceId), isNull(workbenchesTable.archivedAt)));
  return rows.map((r) => r.name);
}

/** Live sandbox workbenches a dead process left mid-provision. */
export async function provisioningWorkbenchIds(): Promise<string[]> {
  const rows = await db()
    .select({ id: workbenchesTable.id })
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.status, 'provisioning'),
        eq(workbenchesTable.runtime, 'sandbox'),
        isNull(workbenchesTable.archivedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Forget every chat's CLI session — after a restore onto a new box, where the session files are gone. */
export async function clearAgentSessions(workbenchId: string): Promise<ChatRow[]> {
  return db()
    .update(chatsTable)
    .set({ agentSessionId: null, updatedAt: new Date() })
    .where(and(eq(chatsTable.workbenchId, workbenchId), sql`${chatsTable.agentSessionId} IS NOT NULL`))
    .returning(CHAT_COLUMNS);
}

/** A fleet sandbox id back to its workbench — the credential pull's lookup. */
export async function workbenchBySandboxId(sandboxId: string): Promise<WorkbenchRow | null> {
  const rows = await db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(eq(workbenchesTable.sandboxId, sandboxId))
    .limit(1);
  return rows[0] ?? null;
}

/** Record the host that holds the session's box now: the fleet moved it. */
export async function recordWorkbenchFleetHost(id: string, sandboxId: string, fleetHost: string): Promise<void> {
  await db()
    .update(workbenchesTable)
    .set({ fleetHost, updatedAt: new Date() })
    .where(and(eq(workbenchesTable.id, id), eq(workbenchesTable.sandboxId, sandboxId)));
}

/** Match only recorded IDs. A move target belongs to the session only during that move. */
export async function workbenchForCredentials(sandboxId: string): Promise<WorkbenchRow | null> {
  const [row] = await db().select(WORKBENCH_COLUMNS).from(workbenchesTable).where(and(
    eq(workbenchesTable.runtime, 'sandbox'),
    or(
      eq(workbenchesTable.sandboxId, sandboxId),
      and(isNotNull(workbenchesTable.sandboxId),
        eq(workbenchesTable.sandboxId, sandboxId.replace(/--[0-9a-f]{6}$/, '')),
        sql`${workbenchesTable.settings} ->> 'fleetSandboxId' = ${sandboxId}`),
      and(eq(workbenchesTable.status, 'moving'), or(
        sql`${workbenchesTable.settings} ->> 'moveSandboxId' = ${sandboxId}`,
        and(sql`${workbenchesTable.settings} ->> 'moveSandboxId' = ${sandboxId.replace(/--[0-9a-f]{6}$/, '')}`,
          sql`${workbenchesTable.settings} ->> 'moveFleetSandboxId' = ${sandboxId}`),
      )),
    ),
  )).limit(1);
  return row ?? null;
}

// ============================================================================
// Chats
// ============================================================================

export type NewChat = typeof chatsTable.$inferInsert;

export async function insertChat(values: NewChat): Promise<ChatRow> {
  const [row] = await db().insert(chatsTable).values(values).returning(CHAT_COLUMNS);
  return row;
}

export function getChatQuery(id: string) {
  return db().select(CHAT_COLUMNS).from(chatsTable).where(eq(chatsTable.id, id)).limit(1);
}

export async function getChat(id: string): Promise<ChatRow | null> {
  return (await getChatQuery(id))[0] ?? null;
}

/** Every chat of a workbench, closed ones included, oldest first. */
export async function listChats(workbenchId: string): Promise<ChatRow[]> {
  return db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId))
    .orderBy(asc(chatsTable.createdAt));
}

/**
 * Mark a chat that has never run a turn as busy with an import, in one
 * statement. A message sent meanwhile queues behind it, and a second import
 * finds the chat taken. Null when the chat has turns, is running or is closed.
 */
export async function claimChatForImport(chatId: string, message: string): Promise<ChatRow | null> {
  const [row] = await db()
    .update(chatsTable)
    .set({ status: 'running', statusMessage: message, updatedAt: new Date() })
    .where(
      and(
        eq(chatsTable.id, chatId),
        eq(chatsTable.turnCount, 0),
        ne(chatsTable.status, 'running'),
        isNull(chatsTable.closedAt),
      ),
    )
    .returning(CHAT_COLUMNS);
  return row ?? null;
}

/** The open chats of several workbenches, oldest first — embedded in the list response in one query. */
export function openChatsQuery(workbenchIds: string[]) {
  return db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(and(inArray(chatsTable.workbenchId, workbenchIds), isNull(chatsTable.closedAt)))
    .orderBy(asc(chatsTable.createdAt));
}

export async function openChatsByWorkbench(workbenchIds: string[]): Promise<Map<string, ChatRow[]>> {
  const out = new Map<string, ChatRow[]>();
  if (workbenchIds.length === 0) return out;
  for (const row of await openChatsQuery(workbenchIds)) {
    const list = out.get(row.workbenchId) ?? [];
    list.push(row);
    out.set(row.workbenchId, list);
  }
  return out;
}

/**
 * Drop one queued message by its id, in one statement so a turn ending at the
 * same moment cannot pop it after we decided it was still there. Null when
 * the chat does not exist.
 */
export async function removeQueuedMessage(chatId: string, messageId: string): Promise<ChatRow | null> {
  const result = await db().execute(sql`
    UPDATE workbench_chats c SET
      queued_messages = COALESCE((
        SELECT jsonb_agg(e.value ORDER BY e.ord)
        FROM jsonb_array_elements(c.queued_messages) WITH ORDINALITY AS e(value, ord)
        WHERE e.value ->> 'id' IS DISTINCT FROM ${messageId}
      ), '[]'::jsonb),
      updated_at = now()
    WHERE c.id = ${chatId}
    RETURNING ${RETURNING_CHAT}
  `);
  const row = rowsOf<RawChatRow>(result)[0];
  return row ? rawToChatRow(row) : null;
}

/** The chat most recently used — where an action lands when none is named. */
export async function latestChat(workbenchId: string): Promise<ChatRow | null> {
  const rows = await db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId))
    .orderBy(desc(chatsTable.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateChat(
  id: string,
  patch: Partial<Omit<NewChat, 'id' | 'workbenchId' | 'workspaceId' | 'createdAt'>>,
): Promise<ChatRow | null> {
  const [row] = await db()
    .update(chatsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chatsTable.id, id))
    .returning(CHAT_COLUMNS);
  return row ?? null;
}

/**
 * Change the provider only while no turn runs. The status condition closes
 * the gap where a queued message could start on the old provider.
 */
export async function switchChatAgentIfIdle(
  id: string,
  agent: WorkbenchAgent,
  model: string | null,
  resumeVersion?: number,
): Promise<ChatRow | null> {
  const queuedModel = model
    ? sql`jsonb_build_object('model', ${model}::text)`
    : sql`'{}'::jsonb`;
  const queuedMessages = sql<WorkbenchQueuedMessage[]>`COALESCE((
    SELECT jsonb_agg((item.value - 'model') || ${queuedModel} ORDER BY item.ordinal)
    FROM jsonb_array_elements(${chatsTable.queuedMessages}) WITH ORDINALITY AS item(value, ordinal)
  ), '[]'::jsonb)`;
  const [row] = await db()
    .update(chatsTable)
    .set({
      resumeAt: resumeVersion === undefined ? null : sql`${chatsTable.resumeAt}`,
      resumeReason: resumeVersion === undefined ? '' : sql`${chatsTable.resumeReason}`,
      resumeVersion: resumeVersion === undefined ? sql`${chatsTable.resumeVersion} + 1` : resumeVersion,
      agent,
      model,
      agentSessionId: null,
      recapPending: sql`${chatsTable.recapPending} OR ${chatsTable.turnCount} > 0`,
      agentBackup: null,
      agentBackupPending: false,
      backupLeaseUntil: null,
      backupRetryAt: null,
      backupFailures: 0,
      backupToken: null,
      status: resumeVersion === undefined ? 'idle' : 'error',
      statusMessage: null,
      queuedMessages,
      updatedAt: new Date(),
    })
    .where(and(eq(chatsTable.id, id), ne(chatsTable.status, 'running'),
      resumeVersion === undefined ? undefined : eq(chatsTable.resumeVersion, resumeVersion)))
    .returning(CHAT_COLUMNS);
  return row ?? null;
}

/** Every chat a dead process left `running`. Reads the partial index only. */
export async function runningChats(): Promise<Array<{ id: string; workbenchId: string; workspaceId: string }>> {
  return db()
    .select({ id: chatsTable.id, workbenchId: chatsTable.workbenchId, workspaceId: chatsTable.workspaceId })
    .from(chatsTable)
    .where(eq(chatsTable.status, 'running'));
}

/**
 * Raw-row reads from a `sql` statement come back snake_case. One mapper for
 * the statements below, so a column rename has one place to update.
 */
interface RawChatRow {
  id: string;
  workbench_id: string;
  workspace_id: string;
  title: string;
  agent: string;
  model: string | null;
  effort: string | null;
  plan_mode: boolean;
  agent_session_id: string | null;
  status: string;
  resume_at: Date | string | null;
  resume_reason: string | null;
  limit_count: number;
  resume_version: number;
  status_message: string | null;
  queued_messages: WorkbenchQueuedMessage[] | string;
  turn_count: number;
  payer_user_id: string | null;
  payer_workspace_id: string | null;
  imported_from: WorkbenchImportedFrom | string | null;
  closed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rawToChatRow(r: RawChatRow): ChatRow {
  const date = (v: Date | string) => (v instanceof Date ? v : new Date(v));
  const queue = typeof r.queued_messages === 'string' ? JSON.parse(r.queued_messages) : r.queued_messages;
  return {
    id: r.id,
    workbenchId: r.workbench_id,
    workspaceId: r.workspace_id,
    title: r.title,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    planMode: r.plan_mode,
    agentSessionId: r.agent_session_id,
    status: r.status,
    resumeAt: r.resume_at ? date(r.resume_at) : null,
    resumeReason: r.resume_reason,
    limitCount: r.limit_count,
    resumeVersion: r.resume_version,
    statusMessage: r.status_message,
    queuedMessages: queue ?? [],
    turnCount: Number(r.turn_count),
    payerUserId: r.payer_user_id ?? null,
    payerWorkspaceId: r.payer_workspace_id ?? null,
    importedFrom: (typeof r.imported_from === 'string' ? JSON.parse(r.imported_from) : r.imported_from) ?? null,
    closedAt: r.closed_at ? date(r.closed_at) : null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function rowsOf<T>(result: unknown): T[] {
  // postgres-js returns the rows array itself; pglite wraps them in `{ rows }`.
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const RETURNING_CHAT = sql.raw(
  `c.id, c.workbench_id, c.workspace_id, c.title, c.agent, c.model, c.effort, c.plan_mode,
   c.resume_at, c.resume_reason, c.limit_count, c.resume_version, c.agent_session_id, c.status, c.status_message, c.queued_messages, c.turn_count,
   c.payer_user_id, c.payer_workspace_id, c.imported_from, c.closed_at, c.created_at, c.updated_at`,
);

/**
 * A CTE named `wb_state`: the chat's workbench status, read under a share lock.
 * The lock orders a turn start against a move's claim, which updates that row:
 * whichever commits first, the other sees it. The move then reads the running
 * chats only after its claim has committed (see move.ts).
 */
function workbenchState(chatId: string) {
  return sql`wb_state AS (
      SELECT w.status, w.archived_at, w.settings ->> 'archiveOnIdle' AS archive_on_idle,
        w.settings ->> 'archiveAfterTurn' AS archive_after_turn FROM workbenches w
      WHERE w.id = (SELECT workbench_id FROM workbench_chats WHERE id = ${chatId})
      FOR SHARE
    )`;
}

/**
 * The head of the queue waits for a free sandbox and its next try is not due
 * yet. No turn starts then: the retry timer or the turn sweep comes back at
 * `retryAt`, so the backoff holds across sends, instances and deploys.
 */
const headWaitsForSandbox = (queue: SQL) =>
  sql`COALESCE((${queue} -> 0 -> 'capacityWait' ->> 'retryAt')::timestamptz > now(), false)`;

const WORKBENCH_UNAVAILABLE = sql.raw(`EXISTS (SELECT 1 FROM wb_state WHERE status <> 'ready' OR archived_at IS NOT NULL OR archive_on_idle IS NOT NULL OR archive_after_turn IS NOT NULL)`);

export interface ClaimResult {
  chat: ChatRow;
  /** The message that starts a turn now, with that turn's number; null when it queued. */
  started: { message: WorkbenchQueuedMessage; turn: number } | null;
  /** The head could start, but another chat of the box runs a turn paid by someone else. */
  payerBlocked?: boolean;
}

/**
 * One payer per box (Teams and Spaces). The head of `queue` may not start
 * while another chat of the same workbench runs a turn paid by somebody else:
 * credentials belong to the whole box. A null payer is the session's owner.
 * The blocked chat is marked `drain_pending`, so the turn sweep, or the end of
 * the other turn, starts it later.
 */
function payerBusy(chatId: string, queue: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM workbench_chats o
    WHERE o.workbench_id = (SELECT workbench_id FROM workbench_chats WHERE id = ${chatId})
      AND o.id <> ${chatId} AND o.status = 'running'
      AND o.payer_user_id IS DISTINCT FROM (${queue} -> 0 -> 'payer' ->> 'userId'))`;
}

/** A turn start records its payer. The columns stay after the turn, so the box's last payer is known. */
const PAYER_ON_START = sql.raw(`payer_user_id = CASE WHEN merged.go THEN merged.mq -> 0 -> 'payer' ->> 'userId' ELSE c.payer_user_id END,
      payer_workspace_id = CASE WHEN merged.go THEN merged.mq -> 0 -> 'payer' ->> 'workspaceId' ELSE c.payer_workspace_id END`);

/**
 * Add `message` to the chat's queue and, when no turn is running and
 * `canStart` (the workbench is ready), take the HEAD of the queue as the next
 * turn — in ONE statement.
 *
 * One statement is the concurrency design. The row lock the CTE takes orders
 * every send against every other send and against the end of a turn, so a
 * message can neither start a second concurrent turn nor be queued in the gap
 * after a turn has already looked at an empty queue. No advisory lock.
 *
 * Enqueue-then-pop rather than "start this one": a queue left behind by a
 * cancel drains in the order it was typed, before the new message.
 */
export async function claimOrEnqueue(
  chatId: string,
  message: WorkbenchQueuedMessage | null,
  canStart: boolean,
  resumeVersion?: number,
): Promise<ClaimResult | null> {
  const deferred = canStart && isWorkbenchDraining();
  canStart = canStart && !isWorkbenchDraining();
  const add = stringifyJsonbSafe(message ? [message] : []);
  const result = await db().execute(sql`
    WITH ${workbenchState(chatId)}, old AS (
      SELECT status, queued_messages FROM workbench_chats WHERE id = ${chatId} FOR UPDATE
    ), pre AS (
      SELECT status AS prev_status, queued_messages || ${add}::jsonb AS mq,
        (status <> 'running' AND ${canStart} AND NOT ${WORKBENCH_UNAVAILABLE}
          AND jsonb_array_length(queued_messages || ${add}::jsonb) > 0
          AND NOT ${headWaitsForSandbox(sql`(queued_messages || ${add}::jsonb)`)}) AS ready
      FROM old
    ), merged AS (
      SELECT prev_status, mq, ready AND NOT ${payerBusy(chatId, sql`mq`)} AS go,
        ready AND ${payerBusy(chatId, sql`mq`)} AS payer_blocked
      FROM pre
    )
    UPDATE workbench_chats c SET
      resume_reason = CASE WHEN ${message !== null && resumeVersion === undefined} THEN '' ELSE c.resume_reason END,
      resume_at = CASE WHEN ${message !== null} THEN NULL ELSE c.resume_at END,
      resume_version = c.resume_version + CASE WHEN ${message !== null && resumeVersion === undefined} THEN 1 ELSE 0 END,
      limit_count = CASE WHEN ${message !== null && message.origin !== 'talyn'} THEN 0 ELSE c.limit_count END,
      queued_messages = CASE WHEN merged.go THEN merged.mq - 0 ELSE merged.mq END,
      status = CASE WHEN merged.go THEN 'running' ELSE c.status END,
      status_message = CASE WHEN merged.go THEN NULL ELSE c.status_message END,
      turn_count = CASE WHEN merged.go THEN c.turn_count + 1 ELSE c.turn_count END,
      turn_owner = CASE WHEN merged.go THEN ${TURN_OWNER} ELSE c.turn_owner END,
      turn_heartbeat_at = CASE WHEN merged.go THEN date_trunc('milliseconds', now()) ELSE c.turn_heartbeat_at END,
      turn_started_at = CASE WHEN merged.go THEN now() ELSE c.turn_started_at END,
      turn_parser = CASE WHEN merged.go THEN NULL ELSE c.turn_parser END,
      turn_offset = CASE WHEN merged.go THEN 0 ELSE c.turn_offset END,
      turn_attempt = CASE WHEN merged.go THEN 0 ELSE c.turn_attempt END,
      turn_message = CASE WHEN merged.go THEN merged.mq -> 0 ELSE c.turn_message END,
      ${PAYER_ON_START},
      drain_pending = CASE WHEN merged.go THEN false ELSE c.drain_pending OR merged.payer_blocked OR
        (${deferred} AND c.status <> 'running' AND NOT ${WORKBENCH_UNAVAILABLE} AND jsonb_array_length(merged.mq) > 0) END,
      updated_at = now()
    FROM merged
    WHERE c.id = ${chatId}
      AND (${resumeVersion ?? null}::int IS NULL OR (c.resume_version = ${resumeVersion ?? null}
        AND c.status <> 'running' AND jsonb_array_length(c.queued_messages) = 0))
      AND (merged.go OR ${message !== null} OR ${deferred})
    RETURNING ${RETURNING_CHAT}, merged.go AS started, merged.payer_blocked AS payer_blocked,
      CASE WHEN merged.go THEN merged.mq -> 0 END AS started_message
  `);
  const row = rowsOf<RawChatRow & { started: boolean; payer_blocked: boolean; started_message: unknown }>(result)[0];
  if (!row) {
    const current = await getChat(chatId);
    return current ? { chat: current, started: null } : null;
  }
  const chat = rawToChatRow(row);
  if (!row.started) return { chat, started: null, ...(row.payer_blocked ? { payerBlocked: true } : {}) };
  const startedMessage =
    typeof row.started_message === 'string' ? JSON.parse(row.started_message) : row.started_message;
  return { chat, started: { message: startedMessage as WorkbenchQueuedMessage, turn: chat.turnCount } };
}

/**
 * End the running turn: take the next queued message as the next turn when
 * `drain` allows it, else settle on `finalStatus`. One statement, for the
 * reason `claimOrEnqueue` is one.
 */
export async function finishTurn(
  chatId: string,
  opts: { finalStatus: WorkbenchChatStatus; statusMessage: string | null; drain: boolean; owner?: string; turn?: number },
): Promise<ClaimResult | null> {
  const result = await db().execute(sql`
    WITH ${workbenchState(chatId)}, old AS (
      SELECT queued_messages FROM workbench_chats WHERE id = ${chatId} FOR UPDATE
    ), pre AS (
      SELECT queued_messages AS mq,
        (${opts.drain && !isWorkbenchDraining()} AND NOT ${WORKBENCH_UNAVAILABLE} AND jsonb_array_length(queued_messages) > 0
          AND NOT ${headWaitsForSandbox(sql`queued_messages`)}) AS ready
      FROM old
    ), merged AS (
      SELECT mq, ready AND NOT ${payerBusy(chatId, sql`mq`)} AS go, ready AND ${payerBusy(chatId, sql`mq`)} AS payer_blocked
      FROM pre
    )
    UPDATE workbench_chats c SET
      limit_count = CASE WHEN ${opts.finalStatus === 'idle' && !opts.statusMessage} THEN 0 ELSE c.limit_count END,
      resume_at = NULL,
      resume_reason = NULL,
      agent_backup_pending = true,
      queued_messages = CASE WHEN merged.go THEN merged.mq - 0 ELSE merged.mq END,
      status = CASE WHEN merged.go THEN 'running' ELSE ${opts.finalStatus} END,
      status_message = CASE WHEN merged.go THEN NULL ELSE ${opts.statusMessage} END,
      turn_count = CASE WHEN merged.go THEN c.turn_count + 1 ELSE c.turn_count END,
      turn_owner = CASE WHEN merged.go THEN ${TURN_OWNER} ELSE c.turn_owner END,
      turn_heartbeat_at = CASE WHEN merged.go THEN date_trunc('milliseconds', now()) ELSE c.turn_heartbeat_at END,
      turn_started_at = CASE WHEN merged.go THEN now() ELSE c.turn_started_at END,
      turn_parser = CASE WHEN merged.go THEN NULL ELSE c.turn_parser END,
      turn_offset = CASE WHEN merged.go THEN 0 ELSE c.turn_offset END,
      turn_attempt = CASE WHEN merged.go THEN 0 ELSE c.turn_attempt END,
      turn_message = CASE WHEN merged.go THEN merged.mq -> 0 ELSE NULL END,
      ${PAYER_ON_START},
      drain_pending = merged.payer_blocked OR (${opts.drain && isWorkbenchDraining()} AND NOT ${WORKBENCH_UNAVAILABLE}
        AND jsonb_array_length(merged.mq) > 0),
      updated_at = now()
    FROM merged
    WHERE c.id = ${chatId}
      AND (${opts.owner ?? null}::text IS NULL OR c.turn_owner = ${opts.owner ?? null})
      AND (${opts.turn ?? null}::int IS NULL OR c.turn_count = ${opts.turn ?? null})
      -- A turn can end while the chat waits for the user; the owner and turn checks stop a stale instance.
      AND c.status IN ('running', 'awaiting_input')
    RETURNING ${RETURNING_CHAT}, merged.go AS started, CASE WHEN merged.go THEN merged.mq -> 0 END AS started_message
  `);
  const row = rowsOf<RawChatRow & { started: boolean; started_message: unknown }>(result)[0];
  if (!row) return null;
  const chat = rawToChatRow(row);
  if (!row.started) return { chat, started: null };
  const startedMessage =
    typeof row.started_message === 'string' ? JSON.parse(row.started_message) : row.started_message;
  return { chat, started: { message: startedMessage as WorkbenchQueuedMessage, turn: chat.turnCount } };
}

/**
 * Give a turn back to the queue before it ran anything: its message goes to
 * the head of the queue, the turn number is returned, and the chat is idle.
 * For a turn that found its workbench moving, and for a turn that waits for a
 * free sandbox (the message then carries `capacityWait`). Null when the chat
 * was not running.
 */
export async function requeueTurn(chatId: string, message: WorkbenchQueuedMessage, turn?: number): Promise<ChatRow | null> {
  const result = await db().execute(sql`
    UPDATE workbench_chats c SET
      queued_messages = ${stringifyJsonbSafe([message])}::jsonb || c.queued_messages,
      status = 'idle',
      turn_message = NULL,
      drain_pending = true,
      status_message = NULL,
      turn_count = GREATEST(c.turn_count - 1, 0),
      updated_at = now()
    WHERE c.id = ${chatId} AND c.status = 'running' AND c.turn_owner = ${TURN_OWNER}
      AND (${turn ?? null}::int IS NULL OR c.turn_count = ${turn ?? null})
    RETURNING ${RETURNING_CHAT}
  `);
  const row = rowsOf<RawChatRow>(result)[0];
  return row ? rawToChatRow(row) : null;
}

/**
 * End the wait of the message at the head of the queue that waits for a free
 * sandbox: take it out of the queue and give it back its turn. The transcript
 * already shows its user message in that turn, so the next message must not
 * take the same number. Nothing drains after it, as after a cancel.
 * `messageId` limits this to that message. Null when no message waits.
 */
export async function abandonCapacityWait(chatId: string, messageId?: string): Promise<ChatRow | null> {
  const result = await db().execute(sql`
    UPDATE workbench_chats c SET
      queued_messages = c.queued_messages - 0,
      turn_count = (c.queued_messages -> 0 -> 'capacityWait' ->> 'turn')::int,
      drain_pending = false,
      updated_at = now()
    WHERE c.id = ${chatId} AND c.status <> 'running'
      AND c.queued_messages -> 0 -> 'capacityWait' IS NOT NULL
      AND (${messageId ?? null}::text IS NULL OR c.queued_messages -> 0 ->> 'id' = ${messageId ?? null})
    RETURNING ${RETURNING_CHAT}
  `);
  const row = rowsOf<RawChatRow>(result)[0];
  return row ? rawToChatRow(row) : null;
}

/**
 * A workbench failed to start: every open chat that is not running goes to
 * `error`, and its transcript says why. Its queued messages STAY queued, and
 * the composer shows them as queued, not sent. No turn starts while the
 * workbench is not ready, and a retry that comes up sends them. Dropping them
 * made a retry open an empty session, because the first prompt was gone.
 */
export async function failQueued(workbenchId: string, reason: string): Promise<ChatRow[]> {
  const result = await db().execute(sql`
    WITH old AS (
      SELECT id, queued_messages AS kept FROM workbench_chats
      WHERE workbench_id = ${workbenchId} AND closed_at IS NULL AND status <> 'running'
      FOR UPDATE
    )
    UPDATE workbench_chats c SET
      status = 'error',
      status_message = ${reason},
      updated_at = now()
    FROM old
    WHERE c.id = old.id
    RETURNING ${RETURNING_CHAT}, old.kept AS kept
  `);
  const out: ChatRow[] = [];
  for (const raw of rowsOf<RawChatRow & { kept: WorkbenchQueuedMessage[] | string | null }>(result)) {
    const chat = rawToChatRow(raw);
    const kept: WorkbenchQueuedMessage[] = (typeof raw.kept === 'string' ? JSON.parse(raw.kept) : raw.kept) ?? [];
    const notSent =
      kept.length === 0
        ? ''
        : kept.length === 1
          ? ' Your message is still queued. Retry sends it.'
          : ` ${kept.length} messages are still queued. Retry sends them.`;
    const stored = await appendEvents(chat.id, [
      {
        turn: chat.turnCount,
        event: {
          type: 'system',
          subtype: 'workbench_failed',
          text: `This session failed to start: ${reason}${notSent}`,
          queuedMessages: kept.map((m) => ({ id: m.id, text: m.text })),
        },
      },
    ]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
    emitWorkbenchChat(chat.workspaceId, rowToChat(chat));
    out.push(chat);
  }
  return out;
}

/** After a retry: chats a failed start left in `error` go back to `idle`. */
/**
 * Before 2026-11-01 a failed start DROPPED the queue and kept only each
 * message's text in the failure event (`droppedMessages`). Put that text back
 * in an empty queue, so a retry of an older failed session still sends its
 * first prompt. Attachments were never stored there, so they cannot return.
 */
export async function requeueDroppedMessages(workbenchId: string): Promise<void> {
  const chats = await db()
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(and(
      eq(chatsTable.workbenchId, workbenchId), eq(chatsTable.status, 'error'), isNull(chatsTable.closedAt),
      sql`jsonb_array_length(${chatsTable.queuedMessages}) = 0`,
    ));
  for (const chat of chats) {
    const [last] = await db()
      .select({ event: eventsTable.event })
      .from(eventsTable)
      .where(and(eq(eventsTable.chatId, chat.id), sql`${eventsTable.event} ->> 'subtype' = 'workbench_failed'`))
      .orderBy(desc(eventsTable.seq))
      .limit(1);
    const dropped = (last?.event as { droppedMessages?: Array<{ id?: string; text?: string }> } | undefined)?.droppedMessages ?? [];
    const queue: WorkbenchQueuedMessage[] = dropped
      .filter((m) => typeof m.text === 'string' && m.text.trim() !== '')
      .map((m) => ({ id: m.id ?? randomUUID(), text: m.text!, queuedAt: new Date().toISOString() }));
    if (queue.length === 0) continue;
    await db().update(chatsTable).set({ queuedMessages: queue })
      .where(and(eq(chatsTable.id, chat.id), sql`jsonb_array_length(${chatsTable.queuedMessages}) = 0`));
  }
}

export async function resetFailedChats(workbenchId: string): Promise<ChatRow[]> {
  const rows = await db()
    .update(chatsTable)
    .set({ status: 'idle', statusMessage: null, updatedAt: new Date() })
    .where(and(eq(chatsTable.workbenchId, workbenchId), eq(chatsTable.status, 'error'), isNull(chatsTable.closedAt)))
    .returning(CHAT_COLUMNS);
  for (const row of rows) emitWorkbenchChat(row.workspaceId, rowToChat(row));
  return rows;
}

// ============================================================================
// Events
// ============================================================================

/** Read the last automatic wake and later person or pause events. */
export async function threadAutoWakeState(threadId: string): Promise<{
  fingerprint: string | null;
  userSinceWake: boolean;
  paused: boolean;
}> {
  const result = await db().execute(sql`
    WITH thread_events AS (
      SELECT e.created_at, e.chat_id, e.seq, e.event
      FROM workbench_events e JOIN workbench_chats c ON c.id = e.chat_id
      WHERE c.workbench_id = ${threadId}
        AND (e.event ->> 'wakeFingerprint' IS NOT NULL
          OR (e.event ->> 'type' = 'user' AND e.event -> 'talyn' ->> 'kind' = 'user_message'
            AND e.event -> 'talyn' ->> 'origin' IS DISTINCT FROM 'talyn')
          OR (e.event ->> 'type' = 'talyn_thread' AND e.event ->> 'action' = 'paused'))
    ), last_wake AS (
      SELECT * FROM thread_events WHERE event ->> 'wakeFingerprint' IS NOT NULL
      ORDER BY created_at DESC, chat_id DESC, seq DESC LIMIT 1
    ), last_user AS (
      SELECT * FROM thread_events WHERE event ->> 'type' = 'user'
      ORDER BY created_at DESC, chat_id DESC, seq DESC LIMIT 1
    ), last_paused AS (
      SELECT * FROM thread_events WHERE event ->> 'action' = 'paused'
      ORDER BY created_at DESC, chat_id DESC, seq DESC LIMIT 1
    )
    SELECT
      (SELECT event ->> 'wakeFingerprint' FROM last_wake) AS fingerprint,
      (SELECT created_at FROM last_wake) AS wake_at,
      (SELECT chat_id FROM last_wake) AS wake_chat,
      (SELECT seq FROM last_wake) AS wake_seq,
      (SELECT created_at FROM last_user) AS user_at,
      (SELECT chat_id FROM last_user) AS user_chat,
      (SELECT seq FROM last_user) AS user_seq,
      (SELECT created_at FROM last_paused) AS paused_at,
      (SELECT chat_id FROM last_paused) AS paused_chat,
      (SELECT seq FROM last_paused) AS paused_seq
  `);
  type Position = { at: Date | string | null; chat: string | null; seq: number | string | null };
  const [row] = rowsOf<{
    fingerprint: string | null;
    wake_at: Date | string | null; wake_chat: string | null; wake_seq: number | string | null;
    user_at: Date | string | null; user_chat: string | null; user_seq: number | string | null;
    paused_at: Date | string | null; paused_chat: string | null; paused_seq: number | string | null;
  }>(result);
  const wake: Position = { at: row?.wake_at ?? null, chat: row?.wake_chat ?? null, seq: row?.wake_seq ?? null };
  const user: Position = { at: row?.user_at ?? null, chat: row?.user_chat ?? null, seq: row?.user_seq ?? null };
  const paused: Position = { at: row?.paused_at ?? null, chat: row?.paused_chat ?? null, seq: row?.paused_seq ?? null };
  const later = (left: Position, right: Position): boolean => {
    if (!left.at) return false;
    if (!right.at) return true;
    const times = new Date(left.at).getTime() - new Date(right.at).getTime();
    if (times) return times > 0;
    if (left.chat !== right.chat) return (left.chat ?? '') > (right.chat ?? '');
    return Number(left.seq) > Number(right.seq);
  };
  return {
    fingerprint: row?.fingerprint ?? null,
    userSinceWake: later(user, wake),
    paused: later(paused, wake) && later(paused, user),
  };
}

export interface EventDraftInput {
  turn: number;
  event: Record<string, unknown>;
}

/** Store a small session metric in its first chat. The transcript hides this system subtype. */
export async function recordBootMetric(workbenchId: string, metric: string, fields: Record<string, unknown> = {}): Promise<void> {
  const [chat] = await db().select({ id: chatsTable.id, turn: chatsTable.turnCount, workspaceId: chatsTable.workspaceId })
    .from(chatsTable).where(eq(chatsTable.workbenchId, workbenchId))
    .orderBy(asc(chatsTable.createdAt), asc(chatsTable.id)).limit(1);
  if (!chat) return;
  const [stored] = await appendEvents(chat.id, [{ turn: chat.turn, event: { type: 'system', subtype: 'boot_metric', metric, at: new Date().toISOString(), ...fields } }]);
  // Insights reads box starts and wakes from a small table, not the transcript.
  const sample = bootSampleFromMetric(metric, fields);
  if (sample && stored) {
    await storeBootSamples([{ ...sample, chatId: chat.id, seq: stored.seq, workspaceId: chat.workspaceId, workbenchId, at: new Date() }])
      .catch((err) => console.warn(`[workbench] recording the ${metric} sample of ${workbenchId} failed:`, err));
  }
}

export async function recordSandboxBootMetric(sandboxId: string, metric: string, fields: Record<string, unknown> = {}): Promise<void> {
  const [row] = await db().select({ id: workbenchesTable.id }).from(workbenchesTable)
    .where(eq(workbenchesTable.sandboxId, sandboxId)).limit(1);
  if (row) await recordBootMetric(row.id, metric, { sandboxId, ...fields });
}

/**
 * Append events to a chat's transcript, assigning their `seq`.
 *
 * ONE statement: the chat's `next_seq` is bumped by the batch size and the rows
 * are inserted from the bumped value. The bump's row lock serialises
 * concurrent appenders until commit, so seqs are gap-free per statement and a
 * reader paging by `seq` never sees a later one before an earlier one. No
 * advisory lock and no read-then-write.
 */
export async function appendEvents(
  chatId: string, items: EventDraftInput[],
  progress?: {
    owner: string; turn: number; offset?: number; previousOffset?: number; parser?: AgentStreamSnapshot;
    /** The agent session to resume next turn. Not the parser's: a session that never answered may not resume. */
    sessionId?: string | null;
  },
): Promise<WorkbenchEvent[]> {
  if (items.length === 0 && !progress) return [];
  const payload = stringifyJsonbSafe(items.map((i) => ({ turn: i.turn, event: i.event })));
  const result = await db().execute(sql`
    WITH alloc AS (
      UPDATE workbench_chats SET next_seq = next_seq + ${items.length}, updated_at = now(),
        turn_offset = COALESCE(${progress?.offset ?? null}::bigint, turn_offset),
        turn_parser = COALESCE(${progress?.parser ? stringifyJsonbSafe(progress.parser) : null}::jsonb, turn_parser),
        agent_session_id = COALESCE(${progress?.sessionId ? cleanJsonbString(progress.sessionId) : null}::text, agent_session_id)
      WHERE id = ${chatId}
        AND (${progress?.owner ?? null}::text IS NULL OR
          (turn_owner = ${progress?.owner ?? null} AND turn_count = ${progress?.turn ?? null}
           AND (${progress?.previousOffset ?? null}::bigint IS NULL OR turn_offset = ${progress?.previousOffset ?? null}) AND status = 'running'))
      RETURNING next_seq - ${items.length} AS base
    )
    INSERT INTO workbench_events (chat_id, seq, turn, event)
    SELECT ${chatId}, alloc.base + e.ord, (e.value ->> 'turn')::int, e.value -> 'event'
    FROM alloc, jsonb_array_elements(${payload}::jsonb) WITH ORDINALITY AS e(value, ord)
    RETURNING seq, turn, event, created_at
  `);
  const rows = rowsOf<{ seq: number | string; turn: number; event: unknown; created_at: Date | string | null }>(result);
  return rows
    .map((r) => {
      const seq = Number(r.seq);
      const event = (typeof r.event === 'string' ? JSON.parse(r.event) : r.event) as Record<string, unknown>;
      const createdAt = r.created_at ? new Date(r.created_at).toISOString() : undefined;
      return { chatId, seq, turn: Number(r.turn), event: { ...event, seq } as AgentEvent, ...(createdAt ? { createdAt } : {}) };
    })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Store events a LOCAL runtime already numbered. Idempotent on `(chat, seq)`,
 * so a desktop that retries an upload stores nothing twice, and the allocator
 * is moved past the highest seq so a later server-side append cannot collide.
 */
export async function storeNumberedEvents(chatId: string, events: WorkbenchEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const inserted = await db()
    .insert(eventsTable)
    // A tool result can carry U+0000 or a lone surrogate, which jsonb refuses for the whole batch.
    .values(events.map((e) => ({ chatId, seq: e.seq, turn: e.turn, event: toJsonbSafe(e.event) as Record<string, unknown> })))
    .onConflictDoNothing()
    .returning({ seq: eventsTable.seq });
  const maxSeq = Math.max(...events.map((e) => e.seq));
  await db()
    .update(chatsTable)
    .set({ nextSeq: sql`GREATEST(${chatsTable.nextSeq}, ${maxSeq})`, updatedAt: new Date() })
    .where(eq(chatsTable.id, chatId));
  return inserted.length;
}

/** The forward transcript page. */
export function listEventsQuery(chatId: string, after: number, limit: number) {
  return db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn, event: eventsTable.event, createdAt: eventsTable.createdAt })
    .from(eventsTable)
    .where(and(eq(eventsTable.chatId, chatId), gt(eventsTable.seq, after)))
    .orderBy(asc(eventsTable.seq))
    .limit(limit);
}

export async function listEvents(
  chatId: string,
  after: number,
  limit: number,
): Promise<{ events: WorkbenchEvent[]; cursor: number }> {
  const rows = await listEventsQuery(chatId, after, limit);
  const events = rows.map((r) => ({
    chatId,
    seq: r.seq,
    turn: r.turn,
    event: { ...r.event, seq: r.seq } as AgentEvent,
    createdAt: r.createdAt.toISOString(),
  }));
  return { events, cursor: events.length > 0 ? events[events.length - 1].seq : after };
}

/** The backward mode's page body: `seq` in `[from, to]`, oldest first. With `listEventsQuery`, the only reads of `event`. */
export function listEventRangeQuery(chatId: string, from: number, to: number, limit: number) {
  return db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn, event: eventsTable.event, createdAt: eventsTable.createdAt })
    .from(eventsTable)
    .where(and(eq(eventsTable.chatId, chatId), gte(eventsTable.seq, from), lte(eventsTable.seq, to)))
    .orderBy(asc(eventsTable.seq))
    .limit(limit);
}

export interface OlderEventsPage {
  events: WorkbenchEvent[];
  /** The newest seq returned, as in the forward mode; 0 for an empty page. */
  cursor: number;
  /** The oldest seq returned. Pass it back as `before` for the next older page. */
  oldestSeq: number | null;
  hasOlder: boolean;
}

/**
 * The newest page of events with `seq < before` (`null` = from the newest),
 * returned oldest first and aligned to whole turns: the window of the newest
 * `limit` events is extended down to the first event of its oldest turn, so a
 * tool_result never arrives without its tool_use.
 *
 * `ceiling` bounds that extension. A single turn with more events than that
 * is cut at the ceiling instead, and its first events arrive with the next
 * older page. One response never holds more than `ceiling` events.
 *
 * Every step but the page body reads `seq` and `turn` only, walking the
 * `(chat_id, seq)` primary key backwards.
 */
export async function listOlderEvents(
  chatId: string,
  before: number | null,
  limit: number,
  ceiling: number,
): Promise<OlderEventsPage> {
  const below =
    before === null ? eq(eventsTable.chatId, chatId) : and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, before));
  const [newest] = await db()
    .select({ seq: eventsTable.seq })
    .from(eventsTable)
    .where(below)
    .orderBy(desc(eventsTable.seq))
    .limit(1);
  if (!newest) return { events: [], cursor: 0, oldestSeq: null, hasOlder: false };

  // The oldest event of the plain window. None means the window reaches the start of the chat.
  const [edge] = await db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn })
    .from(eventsTable)
    .where(below)
    .orderBy(desc(eventsTable.seq))
    .offset(limit - 1)
    .limit(1);

  let from = 0;
  if (edge) {
    // Seqs are unique, so [edge - budget, edge) holds at most `budget` events.
    const floor = edge.seq - Math.max(0, ceiling - limit);
    const [prevTurn] = await db()
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, edge.seq), gte(eventsTable.seq, floor), ne(eventsTable.turn, edge.turn)),
      )
      .orderBy(desc(eventsTable.seq))
      .limit(1);
    // No other turn inside the budget: either the chat starts there, or the turn is cut at the floor.
    from = prevTurn ? prevTurn.seq + 1 : floor;
  }

  const rows = await listEventRangeQuery(chatId, from, newest.seq, ceiling);
  const events = rows.map((r) => ({
    chatId,
    seq: r.seq,
    turn: r.turn,
    event: { ...r.event, seq: r.seq } as AgentEvent,
    createdAt: r.createdAt.toISOString(),
  }));
  const oldestSeq = events.length ? events[0].seq : null;
  let hasOlder = false;
  if (oldestSeq !== null) {
    const [older] = await db()
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, oldestSeq)))
      .limit(1);
    hasOlder = Boolean(older);
  }
  return { events, cursor: events.length ? events[events.length - 1].seq : 0, oldestSeq, hasOlder };
}

// ============================================================================
// Checkpoints
// ============================================================================

export async function upsertCheckpoint(input: { chatId: string; turn: number; ref: string; sha: string }): Promise<void> {
  await db()
    .insert(checkpointsTable)
    .values(input)
    .onConflictDoUpdate({
      target: [checkpointsTable.chatId, checkpointsTable.turn],
      set: { ref: input.ref, sha: input.sha, createdAt: new Date() },
    });
}

export async function listCheckpoints(chatId: string): Promise<WorkbenchCheckpoint[]> {
  const rows = await db()
    .select({
      chatId: checkpointsTable.chatId,
      turn: checkpointsTable.turn,
      ref: checkpointsTable.ref,
      sha: checkpointsTable.sha,
      createdAt: checkpointsTable.createdAt,
    })
    .from(checkpointsTable)
    .where(eq(checkpointsTable.chatId, chatId))
    .orderBy(asc(checkpointsTable.turn));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function getCheckpoint(chatId: string, turn: number): Promise<WorkbenchCheckpoint | null> {
  const rows = await db()
    .select({
      chatId: checkpointsTable.chatId,
      turn: checkpointsTable.turn,
      ref: checkpointsTable.ref,
      sha: checkpointsTable.sha,
      createdAt: checkpointsTable.createdAt,
    })
    .from(checkpointsTable)
    .where(and(eq(checkpointsTable.chatId, chatId), eq(checkpointsTable.turn, turn)))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}

/** Chat ids of a workbench — for clearing sessions after a restore. */
export async function chatIdsOf(workbenchIds: string[]): Promise<string[]> {
  if (workbenchIds.length === 0) return [];
  const rows = await db()
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(inArray(chatsTable.workbenchId, workbenchIds));
  return rows.map((r) => r.id);
}

/** Mark the archive before any sandbox work starts. Preserve an active move's lease. */
/** An archive by the idle sweep: the guard is re-checked inside the claiming UPDATE. */
export interface IdleArchiveClaim {
  guard: SQL;
  days: number;
  /** The box sleeps: the archive is the stored checkpoint, and the box is not woken. */
  fromSaved?: boolean;
}

/** The box of an archive a person or a merge asked for sleeps: what the archive does about it. */
export type SleepingArchive = 'from_saved' | 'wake';

const SLEEPING_ARCHIVE_NOTE: Record<SleepingArchive, string> = {
  from_saved: 'The sandbox was asleep, so Talyn archived the last saved copy and did not run the archive script.',
  wake: 'The sandbox was asleep and Talyn had no save newer than its last activity, so Talyn woke it to save the work.',
};

export async function markArchive(
  id: string, autoForMergedPr = false, idle?: IdleArchiveClaim, sleeping?: SleepingArchive,
): Promise<WorkbenchRow | null> {
  const noRunningChat = sql`NOT EXISTS (SELECT 1 FROM workbench_chats c
    WHERE c.workbench_id = ${workbenchesTable.id} AND c.status = 'running')`;
  const auto = autoForMergedPr || Boolean(idle);
  const fromSaved = idle ? Boolean(idle.fromSaved) : sleeping === 'from_saved';
  const row = await db().transaction(async (tx) => {
    const [archived] = await tx.update(workbenchesTable).set({
      archivedAt: new Date(),
      archivePendingAt: new Date(),
      archiveFailures: 0, archiveRetryAt: null, restoreRequestedAt: null,
      status: sql`CASE WHEN ${workbenchesTable.status} = 'moving' THEN 'moving' ELSE 'archived' END`,
      statusMessage: null,
      // An archive also ends a request to archive after the turn, so a restore does not archive again.
      // The reason of an earlier idle archive goes too, so a later manual one does not wear it.
      settings: sql`((CASE WHEN ${workbenchesTable.settings} ->> 'archiveOnIdle' IS NULL
        THEN ${workbenchesTable.settings}
        ELSE (${workbenchesTable.settings} - 'archiveOnIdle') || jsonb_build_object('autoArchivedForPr',
          COALESCE(${workbenchesTable.settings} -> 'autoArchivedForPr', '[]'::jsonb)
          || jsonb_build_array(${workbenchesTable.settings} ->> 'archiveOnIdle')) END) - 'archiveAfterTurn'
          - 'autoArchivedReason' - 'archiveFromSaved')${fromSaved ? sql` || jsonb_build_object('archiveFromSaved', true)` : sql``}${idle ? sql` || jsonb_build_object('autoArchivedReason', 'idle')` : sql``}`,
      updatedAt: new Date(),
    }).where(and(
      eq(workbenchesTable.id, id), isNull(workbenchesTable.restoreRequestedAt),
      idle ? and(isNull(workbenchesTable.archivedAt), noRunningChat, idle.guard)
        : autoForMergedPr ? and(
          isNull(workbenchesTable.archivedAt),
          sql`${workbenchesTable.settings} ->> 'archiveOnIdle' IS NOT NULL`,
          noRunningChat,
        ) : or(isNull(workbenchesTable.archivedAt), eq(workbenchesTable.status, 'archiveError')),
    )).returning(WORKBENCH_COLUMNS);
    if (archived && (auto || sleeping)) {
      const sleepNote = !idle && sleeping ? ` ${SLEEPING_ARCHIVE_NOTE[sleeping]}` : '';
      const text = idle
        ? `Archived after ${idle.days} ${idle.days === 1 ? 'day' : 'days'} with no activity.${idle.fromSaved
          ? ' The sandbox was asleep, so Talyn used the last saved copy and did not run the archive script.' : ''}`
        : autoForMergedPr ? `The pull request was merged, so Talyn archived this session.${sleepNote}` : sleepNote.trim();
      await tx.execute(sql`
        WITH first_chat AS (
          SELECT id FROM workbench_chats WHERE workbench_id = ${id} ORDER BY created_at, id LIMIT 1
        ), alloc AS (
          UPDATE workbench_chats SET next_seq = next_seq + 1
          WHERE id = (SELECT id FROM first_chat) RETURNING id, next_seq, turn_count
        )
        INSERT INTO workbench_events (chat_id, seq, turn, event)
        SELECT id, next_seq, turn_count, ${JSON.stringify({
          type: 'system', subtype: idle ? 'idle_archive' : autoForMergedPr ? 'pr_merged_archive' : 'sleeping_archive', text,
        })}::jsonb FROM alloc
      `);
    }
    return archived;
  });
  return row ?? (auto ? null : getWorkbench(id));
}

const ACTIVITY_WRITE_EVERY_MS = 5 * 60_000;
const lastActivityWrite = new Map<string, number>();

/**
 * Record activity the chat tables do not show (terminal input, a script start).
 * A burst of typing is one write per five minutes per session and process;
 * never throws, never waits.
 */
export function touchWorkbenchActivity(id: string, force = false): void {
  const now = Date.now();
  if (!force && now - (lastActivityWrite.get(id) ?? 0) < ACTIVITY_WRITE_EVERY_MS) return;
  lastActivityWrite.set(id, now);
  if (lastActivityWrite.size > 5000) lastActivityWrite.clear();
  void db().update(workbenchesTable).set({ lastActivityAt: new Date(now) })
    .where(eq(workbenchesTable.id, id))
    .catch((err) => console.warn(`[workbench] noting activity on ${id} failed:`, err));
}

const archiveAvailable = () => or(isNull(workbenchesTable.archiveLeaseUntil), lt(workbenchesTable.archiveLeaseUntil, new Date()));

export async function pendingArchives(): Promise<Array<{ id: string }>> {
  return db().select({ id: workbenchesTable.id }).from(workbenchesTable).where(and(
    lt(workbenchesTable.archivePendingAt, new Date(Date.now() - 120_000)),
    ne(workbenchesTable.status, 'moving'), archiveAvailable(), isNull(workbenchesTable.restoreRequestedAt),
    or(isNull(workbenchesTable.archiveRetryAt), lte(workbenchesTable.archiveRetryAt, new Date())),
  )).limit(100);
}

/** The timestamp comparison elects one worker across backend instances. */
export async function claimArchive(row: WorkbenchRow): Promise<WorkbenchRow | null> {
  if (!row.archivePendingAt) return null;
  const [claimed] = await db().update(workbenchesTable).set({
    archivePendingAt: new Date(Math.max(Date.now(), row.archivePendingAt.getTime() + 1)),
    archiveLeaseUntil: new Date(Date.now() + 120_000),
  }).where(and(
    eq(workbenchesTable.id, row.id), eq(workbenchesTable.archivePendingAt, row.archivePendingAt),
    isNotNull(workbenchesTable.archivedAt), ne(workbenchesTable.status, 'moving'), archiveAvailable(), isNull(workbenchesTable.restoreRequestedAt),
    or(isNull(workbenchesTable.archiveRetryAt), lte(workbenchesTable.archiveRetryAt, new Date())),
  )).returning(WORKBENCH_COLUMNS);
  return claimed ?? null;
}

export async function renewArchive(row: WorkbenchRow): Promise<boolean> {
  const rows = await db().update(workbenchesTable).set({ archiveLeaseUntil: new Date(Date.now() + 120_000) })
    .where(and(eq(workbenchesTable.id, row.id), eq(workbenchesTable.archivePendingAt, row.archivePendingAt!),
      isNull(workbenchesTable.restoreRequestedAt), gt(workbenchesTable.archiveLeaseUntil, new Date())))
    .returning({ id: workbenchesTable.id });
  return rows.length > 0;
}

export async function finishArchive(row: WorkbenchRow, error?: string): Promise<WorkbenchRow | null> {
  const failures = row.archiveFailures + 1;
  const exhausted = failures >= 8 && !isArchiveCredentialFailure(error);
  const [updated] = await db().update(workbenchesTable).set(error ? {
    archiveLeaseUntil: null,
    archiveRetryAt: exhausted ? null : new Date(Date.now() + Math.min(15 * 60_000 * 2 ** (failures - 1), 6 * 3_600_000)),
    archivePendingAt: exhausted ? null : row.archivePendingAt,
    status: exhausted ? 'archiveError' : 'archived',
    archiveFailures: failures, statusMessage: error,
  } : {
    archivePendingAt: null, archiveLeaseUntil: null, archiveRetryAt: null, archiveFailures: 0,
    status: 'archived', sandboxState: row.runtime === 'sandbox' ? 'deleted' : 'none', statusMessage: null,
  }).where(and(eq(workbenchesTable.id, row.id), eq(workbenchesTable.archivePendingAt, row.archivePendingAt!)))
    .returning(WORKBENCH_COLUMNS);
  return updated ?? null;
}

const ARCHIVE_CREDENTIAL_ERROR = 'could not read Username';

function isArchiveCredentialFailure(error?: string): boolean {
  return error?.toLowerCase().includes(ARCHIVE_CREDENTIAL_ERROR.toLowerCase()) ?? false;
}

/** Repair each affected archive once. The update also excludes concurrent restores and active archives. */
export async function backfillCredentialArchives(): Promise<number> {
  const rows = await db().update(workbenchesTable).set({
    archivePendingAt: new Date(), archiveLeaseUntil: null, archiveRetryAt: null, archiveFailures: 0,
    status: 'archived', updatedAt: new Date(),
    settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || '{"archiveCredentialsRearmed":true}'::jsonb`,
  }).where(and(
    eq(workbenchesTable.runtime, 'sandbox'), isNotNull(workbenchesTable.archivedAt),
    isNotNull(workbenchesTable.sandboxId), inArray(workbenchesTable.sandboxState, ['running', 'suspended']),
    inArray(workbenchesTable.status, ['archived', 'archiveError']),
    isNull(workbenchesTable.archivePendingAt), archiveAvailable(), isNull(workbenchesTable.restoreRequestedAt),
    sql`${workbenchesTable.statusMessage} ILIKE ${`%${ARCHIVE_CREDENTIAL_ERROR}%`}`,
    sql`NOT (COALESCE(${workbenchesTable.settings}, '{}'::jsonb) ? 'archiveCredentialsRearmed')`,
  )).returning({ id: workbenchesTable.id });
  return rows.length;
}

export const TURN_COLUMNS = {
  id: chatsTable.id, workbenchId: chatsTable.workbenchId, workspaceId: chatsTable.workspaceId,
  owner: chatsTable.turnOwner, heartbeat: chatsTable.turnHeartbeatAt, startedAt: chatsTable.turnStartedAt,
  offset: chatsTable.turnOffset, attempt: chatsTable.turnAttempt, message: chatsTable.turnMessage,
  turn: chatsTable.turnCount, updatedAt: chatsTable.updatedAt, parser: chatsTable.turnParser,
} as const;
export type TurnLease = {
  id: string; workbenchId: string; workspaceId: string; owner: string | null;
  heartbeat: Date | null; startedAt: Date | null; offset: number; attempt: number;
  message: WorkbenchQueuedMessage | null; turn: number; updatedAt: Date; parser: AgentStreamSnapshot | null;
};
export async function getTurnLease(id: string): Promise<TurnLease | null> {
  const [row] = await db().select(TURN_COLUMNS).from(chatsTable).where(eq(chatsTable.id, id));
  return row ?? null;
}
export async function turnLeases(): Promise<Array<Omit<TurnLease, 'message' | 'parser'>>> {
  const { message: _message, parser: _parser, ...columns } = TURN_COLUMNS;
  return db().select(columns).from(chatsTable).where(eq(chatsTable.status, 'running'));
}
export async function renewTurnLease(id: string, turn: number, owner = TURN_OWNER): Promise<boolean> {
  const rows = await db().update(chatsTable).set({ turnHeartbeatAt: new Date() })
    .where(and(eq(chatsTable.id, id), eq(chatsTable.turnOwner, owner), eq(chatsTable.turnCount, turn), eq(chatsTable.status, 'running')))
    .returning({ id: chatsTable.id });
  return rows.length === 1;
}
export async function claimTurnLease(seen: Pick<TurnLease, 'id' | 'owner' | 'heartbeat' | 'turn'>, owner = TURN_OWNER): Promise<boolean> {
  const rows = await db().update(chatsTable).set({ turnOwner: owner, turnHeartbeatAt: new Date() })
    .where(and(eq(chatsTable.id, seen.id), eq(chatsTable.status, 'running'), eq(chatsTable.turnCount, seen.turn),
      seen.owner === null ? isNull(chatsTable.turnOwner) : eq(chatsTable.turnOwner, seen.owner),
      seen.heartbeat === null ? isNull(chatsTable.turnHeartbeatAt) : eq(chatsTable.turnHeartbeatAt, seen.heartbeat)))
    .returning({ id: chatsTable.id });
  return rows.length === 1;
}
export async function setTurnAttempt(id: string, turn: number, attempt: number): Promise<boolean> {
  const rows = await db().update(chatsTable).set({ turnAttempt: attempt, turnOffset: 0, turnParser: null })
    .where(and(eq(chatsTable.id, id), eq(chatsTable.turnOwner, TURN_OWNER), eq(chatsTable.turnCount, turn)))
    .returning({ id: chatsTable.id });
  return rows.length === 1;
}
export async function queuedIdleChats(): Promise<Array<{ id: string }>> {
  return db().select({ id: chatsTable.id }).from(chatsTable).where(and(
    eq(chatsTable.drainPending, true), ne(chatsTable.status, 'running'), isNull(chatsTable.closedAt),
    sql`jsonb_array_length(${chatsTable.queuedMessages}) > 0`,
    sql`NOT ${headWaitsForSandbox(sql`${chatsTable.queuedMessages}`)}`,
  ));
}

/** A teammate who pays for turns in a session, as the backend keeps it. */
export interface TurnPayerRef {
  userId: string;
  workspaceId: string;
}

/**
 * Whose credentials the box carries: the payer of the running turn, else of
 * the latest turn. Null is the session's owner. A host pull between turns and
 * the meter read this.
 */
export async function currentBoxPayer(workbenchId: string): Promise<TurnPayerRef | null> {
  const [row] = await db()
    .select({ userId: chatsTable.payerUserId, workspaceId: chatsTable.payerWorkspaceId })
    .from(chatsTable)
    .where(and(eq(chatsTable.workbenchId, workbenchId), isNotNull(chatsTable.turnStartedAt)))
    .orderBy(sql`(${chatsTable.status} = 'running') DESC`, desc(chatsTable.turnStartedAt), asc(chatsTable.id))
    .limit(1);
  return row?.userId && row.workspaceId ? { userId: row.userId, workspaceId: row.workspaceId } : null;
}

/** The teammate who pays for a turn running on the box now, or null (none runs, or the owner's does). */
export async function runningBoxPayer(workbenchId: string): Promise<TurnPayerRef | null> {
  const [row] = await db()
    .select({ userId: chatsTable.payerUserId, workspaceId: chatsTable.payerWorkspaceId })
    .from(chatsTable)
    .where(and(eq(chatsTable.workbenchId, workbenchId), eq(chatsTable.status, 'running'), isNotNull(chatsTable.payerUserId)))
    .orderBy(asc(chatsTable.turnStartedAt), asc(chatsTable.id))
    .limit(1);
  return row?.userId && row.workspaceId ? { userId: row.userId, workspaceId: row.workspaceId } : null;
}

/**
 * A running turn on another chat of the box, paid by somebody else, that
 * started before this chat's turn. Two claims at the same moment cannot see
 * each other's start, so the later one gives way after the fact.
 */
export async function earlierOtherPayerTurn(chatId: string): Promise<boolean> {
  const result = await db().execute(sql`
    SELECT 1 AS one FROM workbench_chats o JOIN workbench_chats me ON me.id = ${chatId}
    WHERE o.workbench_id = me.workbench_id AND o.id <> me.id AND o.status = 'running'
      AND o.payer_user_id IS DISTINCT FROM me.payer_user_id
      AND (o.turn_started_at, o.id) < (me.turn_started_at, me.id)
    LIMIT 1
  `);
  return rowsOf<{ one: number }>(result).length > 0;
}

/**
 * The GitHub login of whoever pays for a turn running on another chat of the
 * box, when that is not `payerUserId` (null is the owner). For "Waiting for
 * <login>'s turn to finish."
 */
export async function busyPayerLogin(chatId: string, payerUserId: string | null): Promise<string | null> {
  const result = await db().execute(sql`
    SELECT COALESCE(pu.github_username, ou.github_username) AS login
    FROM workbench_chats o
    JOIN workbench_chats me ON me.id = ${chatId}
    JOIN workspaces w ON w.id = o.workspace_id
    LEFT JOIN users pu ON pu.id = o.payer_user_id
    LEFT JOIN users ou ON ou.id = w.owner_id
    WHERE o.workbench_id = me.workbench_id AND o.id <> me.id AND o.status = 'running'
      AND o.payer_user_id IS DISTINCT FROM ${payerUserId}::text
    LIMIT 1
  `);
  return rowsOf<{ login: string | null }>(result)[0]?.login ?? null;
}

/** Chats of the workbench held back by one payer per box, to start when a turn ends. */
export async function payerBlockedSiblings(workbenchId: string, exceptChatId: string): Promise<Array<{ id: string }>> {
  return db().select({ id: chatsTable.id }).from(chatsTable).where(and(
    eq(chatsTable.workbenchId, workbenchId), ne(chatsTable.id, exceptChatId),
    eq(chatsTable.drainPending, true), ne(chatsTable.status, 'running'), isNull(chatsTable.closedAt),
    sql`jsonb_array_length(${chatsTable.queuedMessages}) > 0`,
  ));
}

export async function hasTurnEvent(chatId: string, turn: number, type: string, onlyErrors = false): Promise<boolean> {
  const rows = await db().select({ seq: eventsTable.seq }).from(eventsTable)
    .where(and(eq(eventsTable.chatId, chatId), eq(eventsTable.turn, turn), type === 'user_message' ? sql`${eventsTable.event}->'talyn'->>'kind' = ${type}` : sql`${eventsTable.event}->>'type' = ${type}`,
      onlyErrors ? sql`${eventsTable.event}->>'is_error' = 'true'` : undefined)).limit(1);
  return rows.length > 0;
}

export async function saveOwnedSessionId(chatId: string, turn: number, sessionId: string): Promise<ChatRow | null> {
  const [row] = await db().update(chatsTable).set({ agentSessionId: sessionId, updatedAt: new Date() })
    .where(and(eq(chatsTable.id, chatId), eq(chatsTable.turnOwner, TURN_OWNER),
      eq(chatsTable.turnCount, turn), eq(chatsTable.status, 'running'),
      sql`${chatsTable.agentSessionId} IS DISTINCT FROM ${sessionId}`)).returning(CHAT_COLUMNS);
  return row ?? null;
}

export async function releaseTurnLease(id: string, turn: number): Promise<void> {
  await db().update(chatsTable).set({ turnHeartbeatAt: new Date(0) }).where(and(
    eq(chatsTable.id, id), eq(chatsTable.turnOwner, TURN_OWNER), eq(chatsTable.turnCount, turn), eq(chatsTable.status, 'running'),
  ));
}

export async function releaseOwnedTurnLeases(): Promise<void> {
  await db().update(chatsTable).set({ turnHeartbeatAt: new Date(0) })
    .where(and(eq(chatsTable.turnOwner, TURN_OWNER), eq(chatsTable.status, 'running')));
}

export async function markDrainPending(id: string): Promise<void> {
  await db().update(chatsTable).set({ drainPending: true }).where(and(eq(chatsTable.id, id),
    ne(chatsTable.status, 'running'), eq(chatsTable.drainPending, false), sql`jsonb_array_length(${chatsTable.queuedMessages}) > 0`));
}

export async function ensureSandboxGeneration(id: string): Promise<WorkbenchRow | null> {
  const [row] = await db().update(workbenchesTable).set({ sandboxGeneration: randomUUID() })
    .where(and(eq(workbenchesTable.id, id), isNull(workbenchesTable.sandboxGeneration))).returning(WORKBENCH_COLUMNS);
  return row ?? getWorkbench(id);
}

export async function requestArchiveRestore(id: string): Promise<WorkbenchRow | null> {
  const [row] = await db().update(workbenchesTable).set({ restoreRequestedAt: new Date() })
    .where(and(eq(workbenchesTable.id, id), isNotNull(workbenchesTable.archivedAt))).returning(WORKBENCH_COLUMNS);
  return row ?? getWorkbench(id);
}

export async function cancelPendingArchive(id: string): Promise<WorkbenchRow | null> {
  const [row] = await db().update(workbenchesTable).set({
    archivePendingAt: null, archiveLeaseUntil: null, archiveRetryAt: null, archiveFailures: 0,
  }).where(and(eq(workbenchesTable.id, id), isNotNull(workbenchesTable.restoreRequestedAt))).returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

export async function releaseArchive(row: WorkbenchRow): Promise<void> {
  await db().update(workbenchesTable).set({ archiveLeaseUntil: null }).where(and(
    eq(workbenchesTable.id, row.id), eq(workbenchesTable.archivePendingAt, row.archivePendingAt!),
  ));
}
