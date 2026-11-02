import { v4 as uuid } from 'uuid';
import { and, asc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  MAX_LIVE_MEMORIES_PER_WORKSPACE,
  memoryLimitMessage,
  MAX_MEMORY_INDEX_BYTES,
  renderMemoryIndex,
  validateMemoryInput,
  validateMemoryUpdate,
  type MemoryChangeEvent,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  type PutMemoryResult,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { repositories, workbenches, workspaceMemories as table, workspaces } from '../../db/schema.js';
import { emitWorkbenchEvents } from './emit.js';
import { WorkbenchError } from './errors.js';
import { appendEvents, getWorkbench, listChats } from './store.js';

/**
 * Workspace memory entries. On the pool: the routes authorise with
 * `requireWorkspaceAccess` first, and the turn path has no request.
 */

const db = (): Database => getPoolDbClient();

/** Every column but `body`. A list ships no bodies unless it asks. */
export const SUMMARY_COLUMNS = {
  id: table.id,
  workspaceId: table.workspaceId,
  scope: table.scope,
  repositoryId: table.repositoryId,
  threadId: table.threadId,
  type: table.type,
  name: table.name,
  description: table.description,
  bytes: table.bytes,
  source: table.source,
  createdAt: table.createdAt,
  updatedAt: table.updatedAt,
  forgottenAt: table.forgottenAt,
} as const;

/** What the index shows, and the id so a caller can act on an entry. */
export const INDEX_COLUMNS = {
  id: table.id,
  scope: table.scope,
  type: table.type,
  name: table.name,
  description: table.description,
} as const;

type SummaryRow = Pick<typeof table.$inferSelect, keyof typeof SUMMARY_COLUMNS>;
type IndexRow = Pick<typeof table.$inferSelect, keyof typeof INDEX_COLUMNS>;

export interface MemoryIndexItem {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  name: string;
  description: string;
}

function toSummary(row: SummaryRow): MemoryEntrySummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope as MemoryScope,
    repositoryId: row.repositoryId,
    threadId: row.threadId,
    type: row.type as MemoryType,
    name: row.name,
    description: row.description,
    bytes: row.bytes,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    forgottenAt: row.forgottenAt ? row.forgottenAt.toISOString() : null,
  };
}

function toIndexItem(row: IndexRow): MemoryIndexItem {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    type: row.type as MemoryType,
    name: row.name,
    description: row.description,
  };
}

/** Workspace entries first, then repository, then thread; by name inside each. */
const SCOPE_ORDER = sql`case ${table.scope} when 'workspace' then 0 when 'repository' then 1 else 2 end`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Entries a session on this repository (or in this thread) can see. */
function visibleFrom(repositoryId?: string | null, threadId?: string | null): SQL {
  const parts: SQL[] = [eq(table.scope, 'workspace')];
  if (repositoryId) parts.push(and(eq(table.scope, 'repository'), eq(table.repositoryId, repositoryId))!);
  if (threadId) parts.push(and(eq(table.scope, 'thread'), eq(table.threadId, threadId))!);
  return or(...parts)!;
}

export interface ListMemoryOptions {
  scope?: MemoryScope;
  repositoryId?: string;
  threadId?: string;
  q?: string;
  includeForgotten?: boolean;
  includeBody?: boolean;
}

/**
 * The list query. With `scope`, that scope only (narrowed by `repositoryId` /
 * `threadId`). Without it, a repository or thread id means the entries visible
 * from there, and neither means every entry. The body column is selected only
 * when asked for.
 */
export function listMemoriesQuery(workspaceId: string, opts: ListMemoryOptions = {}) {
  return db()
    .select({ ...SUMMARY_COLUMNS, body: opts.includeBody ? table.body : sql<string | null>`null` })
    .from(table)
    .where(memoryListWhere(workspaceId, opts))
    .orderBy(asc(isNotNull(table.forgottenAt)), asc(SCOPE_ORDER), asc(sql`lower(${table.name})`));
}

/** The filter of a list: shared by the app's list and the public API's paged list. */
export function memoryListWhere(workspaceId: string, opts: Omit<ListMemoryOptions, 'includeBody'> = {}): SQL {
  const where: SQL[] = [eq(table.workspaceId, workspaceId)];
  if (!opts.includeForgotten) where.push(isNull(table.forgottenAt));
  if (opts.scope) {
    where.push(eq(table.scope, opts.scope));
    if (opts.repositoryId) where.push(eq(table.repositoryId, opts.repositoryId));
    if (opts.threadId) where.push(eq(table.threadId, opts.threadId));
  } else if (opts.repositoryId || opts.threadId) {
    where.push(visibleFrom(opts.repositoryId, opts.threadId));
  }
  const q = opts.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where.push(or(ilike(table.name, pattern), ilike(table.description, pattern), ilike(table.body, pattern))!);
  }
  return and(...where)!;
}

export async function listMemories(
  workspaceId: string,
  opts: ListMemoryOptions = {},
): Promise<Array<MemoryEntrySummary | MemoryEntry>> {
  const rows = await listMemoriesQuery(workspaceId, opts);
  return rows.map(({ body, ...row }) => (opts.includeBody ? { ...toSummary(row), body: body ?? '' } : toSummary(row)));
}

/** One entry with its body, forgotten or not. */
export async function getMemory(id: string): Promise<MemoryEntry | null> {
  const [row] = await db()
    .select({ ...SUMMARY_COLUMNS, body: table.body })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return row ? { ...toSummary(row), body: row.body } : null;
}

/** The workspace an entry belongs to, for the route's access check. One column. */
export async function memoryWorkspaceId(id: string): Promise<string | null> {
  const [row] = await db().select({ workspaceId: table.workspaceId }).from(table).where(eq(table.id, id)).limit(1);
  return row?.workspaceId ?? null;
}

async function requireTargetInWorkspace(
  workspaceId: string,
  repositoryId: string | null,
  threadId: string | null,
): Promise<void> {
  if (repositoryId) {
    const [repo] = await db()
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)))
      .limit(1);
    if (!repo) throw new WorkbenchError('Repository not found in this workspace', 404, 'repository_not_found');
  }
  if (threadId) {
    const [thread] = await db()
      .select({ id: workbenches.id })
      .from(workbenches)
      .where(and(eq(workbenches.id, threadId), eq(workbenches.workspaceId, workspaceId)))
      .limit(1);
    if (!thread) throw new WorkbenchError('Thread not found in this workspace', 404, 'thread_not_found');
  }
}

/** A session source must name a session of the same workspace. Default: the user. */
async function validateSource(workspaceId: string, source: unknown): Promise<MemorySource> {
  if (source === undefined || source === null) return { kind: 'user' };
  const raw = source as Partial<{ kind: string; workbenchId: unknown; chatId: unknown; turn: unknown }>;
  if (typeof source !== 'object' || (raw.kind !== 'user' && raw.kind !== 'session')) {
    throw new WorkbenchError('source.kind must be "user" or "session"', 400, 'bad_memory');
  }
  if (raw.kind === 'user') return { kind: 'user' };
  if (typeof raw.workbenchId !== 'string' || !raw.workbenchId) {
    throw new WorkbenchError('A session source needs a workbenchId', 400, 'bad_memory');
  }
  const wb = await getWorkbench(raw.workbenchId);
  if (!wb || wb.workspaceId !== workspaceId) {
    throw new WorkbenchError('The source session is not in this workspace', 400, 'bad_memory');
  }
  return {
    kind: 'session',
    workbenchId: raw.workbenchId,
    ...(typeof raw.chatId === 'string' && raw.chatId ? { chatId: raw.chatId } : {}),
    ...(typeof raw.turn === 'number' && Number.isInteger(raw.turn) ? { turn: raw.turn } : {}),
  };
}

function refuse(result: { error: string; code: string; status: number }): never {
  throw new WorkbenchError(result.error, result.status, result.code);
}

/** The live entry with this scope target and name (case-insensitive), if any. */
function sameKey(
  workspaceId: string,
  scope: MemoryScope,
  repositoryId: string | null,
  threadId: string | null,
  name: string,
): SQL {
  return and(
    eq(table.workspaceId, workspaceId),
    eq(table.scope, scope),
    sql`coalesce(${table.repositoryId}, '') = ${repositoryId ?? ''}`,
    sql`coalesce(${table.threadId}, '') = ${threadId ?? ''}`,
    sql`lower(${table.name}) = lower(${name})`,
    isNull(table.forgottenAt),
  )!;
}

/** Refuse a new live entry when the workspace is at the cap. */
async function requireRoomFor(workspaceId: string, exclude?: SQL): Promise<void> {
  const [row] = await db()
    .select({
      live: sql<number>`count(*)::int`,
      existing: exclude ? sql<boolean>`coalesce(bool_or(${exclude}), false)` : sql<boolean>`false`,
    })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), isNull(table.forgottenAt)));
  // An update of a live entry adds no row.
  if (row?.existing) return;
  if ((row?.live ?? 0) >= MAX_LIVE_MEMORIES_PER_WORKSPACE) {
    throw new WorkbenchError(memoryLimitMessage(), 409, 'memory_limit_reached');
  }
}

/**
 * Create an entry, or update the live entry with the same scope target and
 * name. The cap check runs first, so two racing creates can pass it together
 * and go one row over; the cap is about clutter, not safety.
 */
export async function putMemory(ownerId: string, input: unknown): Promise<PutMemoryResult> {
  const workspaceId = (input as { workspaceId?: unknown } | null)?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw new WorkbenchError('workspaceId is required', 400, 'bad_memory');
  }
  const checked = validateMemoryInput(input);
  if (!checked.ok) refuse(checked);
  const value = checked.value;
  await requireTargetInWorkspace(workspaceId, value.repositoryId, value.threadId);
  const source = await validateSource(workspaceId, (input as { source?: unknown }).source);
  await requireRoomFor(
    workspaceId,
    sameKey(workspaceId, value.scope, value.repositoryId, value.threadId, value.name),
  );

  const result = await db().execute(sql`
    INSERT INTO workspace_memories
      (id, workspace_id, owner_id, scope, repository_id, thread_id, type, name, description, body, bytes, source)
    VALUES (${uuid()}, ${workspaceId}, ${ownerId}, ${value.scope}, ${value.repositoryId}, ${value.threadId},
      ${value.type}, ${value.name}, ${value.description}, ${value.body}, ${value.bytes}, ${JSON.stringify(source)}::jsonb)
    ON CONFLICT (workspace_id, scope, coalesce(repository_id, ''), coalesce(thread_id, ''), lower(name))
      WHERE forgotten_at IS NULL
    DO UPDATE SET type = excluded.type, name = excluded.name, description = excluded.description,
      body = excluded.body, bytes = excluded.bytes, source = excluded.source, updated_at = now()
    RETURNING id, (xmax = 0) AS inserted
  `);
  const [row] = rowsOf<{ id: string; inserted: boolean }>(result);
  const entry = await getMemory(row.id);
  if (!entry) throw new Error(`memory ${row.id} vanished after its upsert`);
  return { entry, outcome: row.inserted ? 'created' : 'updated' };
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

const nameTaken = () =>
  new WorkbenchError('Another entry in this scope has that name. Choose another name.', 409, 'memory_name_taken');

/** Change a live entry's type, name, description or body. The scope stays. */
export async function updateMemory(id: string, input: unknown): Promise<MemoryEntry> {
  const checked = validateMemoryUpdate(input);
  if (!checked.ok) refuse(checked);
  const current = await getMemory(id);
  if (!current) throw new WorkbenchError('Memory entry not found', 404, 'memory_not_found');
  if (current.forgottenAt) throw new WorkbenchError('Restore the entry before you edit it.', 409, 'memory_forgotten');
  try {
    await db()
      .update(table)
      .set({ ...checked.value, updatedAt: new Date() })
      .where(and(eq(table.id, id), isNull(table.forgottenAt)));
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
  const entry = await getMemory(id);
  if (!entry) throw new WorkbenchError('Memory entry not found', 404, 'memory_not_found');
  return entry;
}

/** Soft delete. Null when there is no live entry with this id. */
export async function forgetMemory(id: string): Promise<MemoryEntrySummary | null> {
  const [row] = await db()
    .update(table)
    .set({ forgottenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.forgottenAt)))
    .returning(SUMMARY_COLUMNS);
  return row ? toSummary(row) : null;
}

/** Bring a forgotten entry back. Refused when a live entry took its name, or at the cap. */
export async function restoreMemory(id: string): Promise<MemoryEntry> {
  const current = await getMemory(id);
  if (!current) throw new WorkbenchError('Memory entry not found', 404, 'memory_not_found');
  if (!current.forgottenAt) return current;
  await requireRoomFor(current.workspaceId);
  try {
    await db()
      .update(table)
      .set({ forgottenAt: null, updatedAt: new Date() })
      .where(eq(table.id, id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new WorkbenchError(
        'A live entry in this scope has the same name. Forget or rename it first.',
        409,
        'memory_name_taken',
      );
    }
    throw err;
  }
  return (await getMemory(id))!;
}

/**
 * The live entries a session sees: the workspace's, its repository's and its
 * thread's. Index columns only, never a body.
 */
export async function memoryIndexFor(opts: {
  workspaceId: string;
  repositoryId?: string | null;
  threadId?: string | null;
}): Promise<MemoryIndexItem[]> {
  const rows = await db()
    .select(INDEX_COLUMNS)
    .from(table)
    .where(
      and(
        eq(table.workspaceId, opts.workspaceId),
        isNull(table.forgottenAt),
        visibleFrom(opts.repositoryId, opts.threadId),
      ),
    )
    .orderBy(asc(SCOPE_ORDER), asc(sql`lower(${table.name})`));
  return rows.map(toIndexItem);
}

/**
 * `settings.sessionMemory`: on unless set to false. Reads one key, never the
 * settings blob. With `ownerId`, another owner's workspace reads as on, so the
 * answer tells that caller nothing; the route then refuses the request.
 */
export async function sessionMemoryEnabled(workspaceId: string, ownerId?: string): Promise<boolean> {
  const [row] = await db()
    .select({ value: sql<string | null>`${workspaces.settings} ->> 'sessionMemory'` })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), ownerId ? eq(workspaces.ownerId, ownerId) : undefined))
    .limit(1);
  return row?.value !== 'false';
}

/**
 * The index a session turn gets, as Markdown. `used` is false when the
 * workspace never stored an entry (forgotten entries count), so the turn can
 * skip the instruction sync. `index` is null when memory is off or no entry is
 * visible, which tells the sync to remove the index from the box.
 */
export async function memoryIndexForTurn(opts: {
  workspaceId: string;
  repositoryId?: string | null;
  threadId?: string | null;
}): Promise<{ used: boolean; index: string | null }> {
  const [any] = await db().select({ id: table.id }).from(table).where(eq(table.workspaceId, opts.workspaceId)).limit(1);
  if (!any) return { used: false, index: null };
  if (!(await sessionMemoryEnabled(opts.workspaceId))) return { used: true, index: null };
  return { used: true, index: renderMemoryIndex(await memoryIndexFor(opts)) || null };
}

/**
 * The read-only index for a task or a review run, to append to its system
 * prompt: the workspace's entries and the repository's. Empty when memory is
 * off, when no entry is visible, or when the read fails: memory must never
 * stop a dispatch.
 */
export async function memoryIndexForRun(opts: { workspaceId: string; repositoryId: string | null }): Promise<string> {
  try {
    if (!(await sessionMemoryEnabled(opts.workspaceId))) return '';
    const entries = await memoryIndexFor({ workspaceId: opts.workspaceId, repositoryId: opts.repositoryId });
    return renderMemoryIndex(entries, MAX_MEMORY_INDEX_BYTES, { readOnly: true });
  } catch (err) {
    console.warn(`[memory] reading the index for a run in workspace ${opts.workspaceId} failed:`, err);
    return '';
  }
}

/**
 * `systemPrompt` with the run's memory index, when there is one. After it by
 * default; `before` keeps a prompt whose last part must stay last, such as a
 * review's output contract.
 */
export async function withMemoryIndex(
  systemPrompt: string,
  opts: { workspaceId: string; repositoryId: string | null; placement?: 'after' | 'before' },
): Promise<string> {
  const index = (await memoryIndexForRun(opts)).replace(/\n+$/, '');
  if (!index) return systemPrompt;
  return opts.placement === 'before' ? `${index}\n\n${systemPrompt}` : `${systemPrompt}\n\n${index}`;
}

/**
 * Put a memory change in the session's transcript: its running chat, else its
 * most recent open chat. Best effort; the entry is already saved.
 */
export async function announceMemoryChange(workbenchId: string, change: MemoryChangeEvent): Promise<void> {
  try {
    const wb = await getWorkbench(workbenchId);
    if (!wb) return;
    const open = (await listChats(workbenchId)).filter((chat) => !chat.closedAt);
    const chat =
      open.find((c) => c.status === 'running') ??
      [...open].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    if (!chat) return;
    const events = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'talyn_memory', ...change } }]);
    emitWorkbenchEvents(wb.workspaceId, chat.id, events);
  } catch (err) {
    console.warn('[memory] could not add the change to the transcript:', err);
  }
}

function rowsOf<T>(result: unknown): T[] {
  // postgres-js returns the rows array itself; pglite wraps them in `{ rows }`.
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
