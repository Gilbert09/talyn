import {
  MEMORY_TYPES,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryScope,
  type MemoryType,
  type PutMemoryResult,
} from '@talyn/shared';
import { announceMemoryChange, sessionMemoryEnabled } from '../../services/workbenches/memory.js';
import { getWorkbench } from '../../services/workbenches/store.js';
import { callApi, McpApiError } from '../api.js';
import { defineTool, linesOrNone, requireId, resolveWorkspace, str, workspaceSchema } from './helpers.js';
import type { McpCallContext } from './index.js';

/**
 * Workspace memory. From a session, entries default to the session's own
 * repository; from a thread, to the thread. Every write or forget shows as a
 * card in the caller's transcript, so a person sees what the agent saved for
 * later sessions.
 */

const FEATURE = 'workbenches' as const;
const OFF_MESSAGE = 'Workspace memory is off for this workspace. A person can turn it on in the Talyn settings.';
const NOT_VISIBLE = 'Memory entry not found.';
const SESSION_REPOSITORY_ONLY =
  "From a session, an entry applies to the session's own repository or to the whole workspace.";

interface MemoryContext {
  workspaceId: string;
  /** The calling session's repository, or the repository_id a user token named. */
  repositoryId: string | null;
  /** Set when a session's own token calls. */
  workbenchId: string | null;
  /** The thread whose entries the caller sees: a thread itself, or the thread a session belongs to. */
  threadId: string | null;
  /** The caller is a thread: its writes default to thread scope. */
  isThread: boolean;
}

async function resolveContext(
  ownerId: string,
  args: Record<string, unknown>,
  ctx?: McpCallContext,
): Promise<MemoryContext> {
  let context: MemoryContext;
  if (ctx?.session) {
    const wb = await getWorkbench(ctx.session.workbenchId);
    if (!wb) throw new Error('This session no longer exists.');
    const workspaceId = str(args.workspace_id);
    if (workspaceId && workspaceId !== wb.workspaceId) {
      throw new Error("From a session, memory is the session's own workspace.");
    }
    const repositoryId = str(args.repository_id);
    if (repositoryId && repositoryId !== wb.repositoryId) throw new Error(SESSION_REPOSITORY_ONLY);
    const isThread = wb.kind === 'thread';
    context = {
      workspaceId: wb.workspaceId,
      repositoryId: wb.repositoryId,
      workbenchId: wb.id,
      threadId: isThread ? wb.id : wb.threadId,
      isThread,
    };
  } else {
    context = {
      workspaceId: await resolveWorkspace(ownerId, args),
      repositoryId: str(args.repository_id) ?? null,
      workbenchId: null,
      threadId: null,
      isThread: false,
    };
  }
  if (!(await sessionMemoryEnabled(context.workspaceId, ownerId))) throw new Error(OFF_MESSAGE);
  return context;
}

/** Whether the calling session may see this entry: the workspace's, its repository's or its own thread's. */
function visibleTo(context: MemoryContext, entry: MemoryEntrySummary): boolean {
  if (entry.workspaceId !== context.workspaceId) return false;
  if (!context.workbenchId) return true;
  if (entry.scope === 'workspace') return true;
  if (entry.scope === 'repository') return entry.repositoryId === context.repositoryId;
  return Boolean(context.threadId) && entry.threadId === context.threadId;
}

function scopeLabel(entry: MemoryEntrySummary): string {
  if (entry.scope === 'repository') return `repository ${entry.repositoryId}`;
  if (entry.scope === 'thread') return `thread ${entry.threadId}`;
  return 'workspace';
}

const entryLine = (entry: MemoryEntrySummary) =>
  `${entry.id}  ${entry.name}  (${entry.type}, ${scopeLabel(entry)})${entry.forgottenAt ? '  [forgotten]' : ''}  ${entry.description}`;

/** The list route's query for what this caller can see. */
function listQuery(context: MemoryContext, extra: Record<string, string>): string {
  const params = new URLSearchParams({ workspaceId: context.workspaceId, ...extra });
  if (context.repositoryId) params.set('repositoryId', context.repositoryId);
  if (context.threadId) params.set('threadId', context.threadId);
  return params.toString();
}

/** Thread entries first, then repository, then workspace: the most specific scope wins a name. */
const SPECIFICITY: Record<MemoryScope, number> = { thread: 2, repository: 1, workspace: 0 };

/** The entry with this id, when one exists. A 404 is null; another failure throws. */
async function entryById(ownerId: string, id: string): Promise<MemoryEntry | null> {
  try {
    return await callApi<MemoryEntry | null>(ownerId, 'GET', `/workbenches/memory/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof McpApiError && err.status === 404) return null;
    throw err;
  }
}

/** The live entries with this name that the caller can see, the most specific scope first. */
async function entriesByName(ownerId: string, context: MemoryContext, name: string): Promise<MemoryEntrySummary[]> {
  const rows = await callApi<MemoryEntrySummary[]>(
    ownerId,
    'GET',
    `/workbenches/memory?${listQuery(context, { name })}`,
  );
  return rows
    .filter((row) => !row.forgottenAt && visibleTo(context, row))
    .sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope]);
}

const matchLines = (rows: MemoryEntrySummary[]) => rows.map((row) => `  ${entryLine(row)}`).join('\n');

/**
 * An entry by its id or by its name, as the memory index shows it. An id is
 * tried first. A name matches live entries only, in the scopes the caller can
 * see. With `unique`, a name that matches more than one entry is refused;
 * without it, the most specific scope wins, and a tie there is refused.
 */
async function resolveEntry(
  ownerId: string,
  context: MemoryContext,
  ref: string,
  opts: { unique: boolean },
): Promise<{ entry: MemoryEntrySummary; others: MemoryEntrySummary[] }> {
  const byId = await entryById(ownerId, ref);
  if (byId) {
    if (!visibleTo(context, byId)) throw new Error(NOT_VISIBLE);
    return { entry: byId, others: [] };
  }
  const matches = await entriesByName(ownerId, context, ref);
  if (matches.length === 0) {
    throw new Error(
      `${NOT_VISIBLE} No entry you can see has the id or name "${ref}". Find it with talyn_memory_search or talyn_memory_list.`,
    );
  }
  const tied = matches.filter((row) => row.scope === matches[0].scope);
  if (tied.length > 1 || (opts.unique && matches.length > 1)) {
    throw new Error(
      `More than one memory entry is named "${ref}". Send the id of the one you mean:\n${matchLines(matches)}`,
    );
  }
  return { entry: matches[0], others: matches.slice(1) };
}

function readScope(args: Record<string, unknown>, context: MemoryContext): MemoryScope {
  const scope = str(args.scope);
  if (scope === undefined) return context.isThread ? 'thread' : context.repositoryId ? 'repository' : 'workspace';
  if (scope !== 'workspace' && scope !== 'repository' && scope !== 'thread') {
    throw new Error('scope must be "workspace", "repository" or "thread"');
  }
  if (scope === 'repository' && !context.repositoryId) {
    throw new Error(context.isThread ? 'A thread has no repository. Use scope "thread" or "workspace".' : 'A repository entry needs repository_id');
  }
  if (scope === 'thread' && !context.threadId) throw new Error('A thread entry can only be written from a thread or one of its sessions.');
  return scope;
}

const memoryIdSchema = {
  memory_id: {
    type: 'string',
    description: 'The entry id, or its name as the memory index shows it. From talyn_memory_list or talyn_memory_search.',
  },
};
const repositorySchema = {
  repository_id: {
    type: 'string',
    description: "A user token: the repository to use. A session always uses its own repository.",
  },
};

export const MEMORY = [
  defineTool(
    'memory_write',
    "Save a short note that later sessions in this workspace can read. Writing the same name again in the same scope updates that entry. From a session, the entry applies to the session's repository unless scope is \"workspace\". From a thread, it applies to the thread unless scope is \"workspace\".",
    {
      ...workspaceSchema,
      ...repositorySchema,
      name: { type: 'string', description: 'A short label, at most 64 characters. Unique in its scope.' },
      description: {
        type: 'string',
        description: 'One line, at most 200 characters. Sessions see this in the memory index.',
      },
      body: { type: 'string', description: 'The note itself, at most 8 KB.' },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description:
          'user: about the person. feedback: how they want work done. project: facts about the work. reference: where to find things.',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'repository', 'thread'],
        description:
          'Default: the thread (from a thread), the repository (from a session, or with repository_id), else the workspace. ' +
          'thread: from a thread or one of its sessions only.',
      },
    },
    ['name', 'description', 'body', 'type'],
    {},
    async (ownerId, args, ctx) => {
      const context = await resolveContext(ownerId, args, ctx);
      const scope = readScope(args, context);
      const type = str(args.type);
      if (!MEMORY_TYPES.includes(type as MemoryType)) throw new Error(`type must be one of: ${MEMORY_TYPES.join(', ')}`);
      const result = await callApi<PutMemoryResult>(ownerId, 'POST', '/workbenches/memory', {
        workspaceId: context.workspaceId,
        scope,
        repositoryId: scope === 'repository' ? context.repositoryId : null,
        threadId: scope === 'thread' ? context.threadId : null,
        type,
        name: args.name,
        description: args.description,
        body: args.body,
        ...(context.workbenchId ? { source: { kind: 'session', workbenchId: context.workbenchId } } : {}),
      });
      const { entry, outcome } = result;
      if (context.workbenchId) {
        await announceMemoryChange(context.workbenchId, {
          action: outcome,
          memoryId: entry.id,
          name: entry.name,
          memoryType: entry.type,
          scope: entry.scope,
        });
      }
      return `${outcome === 'created' ? 'Saved' : 'Updated'} memory entry:\n${entryLine(entry)}`;
    },
    FEATURE,
  ),
  defineTool(
    'memory_search',
    'Search the memory entries you can see, by text in the name, description or body. Returns ids and descriptions; read a body with talyn_memory_read.',
    { ...workspaceSchema, ...repositorySchema, query: { type: 'string', description: 'Text to find. Not case-sensitive.' } },
    ['query'],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const query = requireId(args, 'query');
      const context = await resolveContext(ownerId, args, ctx);
      const rows = await callApi<MemoryEntrySummary[]>(
        ownerId,
        'GET',
        `/workbenches/memory?${listQuery(context, { q: query })}`,
      );
      return linesOrNone(rows, entryLine);
    },
    FEATURE,
  ),
  defineTool(
    'memory_read',
    'Read one memory entry with its body, by id or by name. Read an entry before you rely on it.',
    { ...workspaceSchema, ...repositorySchema, ...memoryIdSchema },
    ['memory_id'],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const ref = requireId(args, 'memory_id');
      const context = await resolveContext(ownerId, args, ctx);
      const { entry: found, others } = await resolveEntry(ownerId, context, ref, { unique: false });
      const entry = 'body' in found ? (found as MemoryEntry) : await entryById(ownerId, found.id);
      if (!entry || !visibleTo(context, entry)) throw new Error(NOT_VISIBLE);
      const lines = [entryLine(entry), `updated: ${entry.updatedAt}`];
      if (others.length > 0) lines.push(`Other entries with this name, in wider scopes:\n${matchLines(others)}`);
      return [...lines, '', entry.body].join('\n');
    },
    FEATURE,
  ),
  defineTool(
    'memory_forget',
    'Forget a memory entry that is wrong or out of date, by id or by name. A name that more than one entry has is refused. A person can restore an entry in the app.',
    { ...workspaceSchema, ...repositorySchema, ...memoryIdSchema },
    ['memory_id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args, ctx) => {
      const ref = requireId(args, 'memory_id');
      const context = await resolveContext(ownerId, args, ctx);
      const { entry } = await resolveEntry(ownerId, context, ref, { unique: true });
      if (entry.forgottenAt) return `Already forgotten:\n${entryLine(entry)}`;
      const forgotten = await callApi<MemoryEntrySummary>(
        ownerId,
        'DELETE',
        `/workbenches/memory/${encodeURIComponent(entry.id)}`,
      );
      if (context.workbenchId) {
        await announceMemoryChange(context.workbenchId, {
          action: 'forgotten',
          memoryId: forgotten.id,
          name: forgotten.name,
          memoryType: forgotten.type,
          scope: forgotten.scope,
        });
      }
      return `Forgot memory entry:\n${entryLine(forgotten)}`;
    },
    FEATURE,
  ),
  defineTool(
    'memory_list',
    'List the memory entries you can see: the workspace entries and, from a session, its repository and thread entries. No bodies; read one with talyn_memory_read.',
    {
      ...workspaceSchema,
      ...repositorySchema,
      scope: { type: 'string', enum: ['workspace', 'repository', 'thread'], description: 'Only this scope. Default: all you can see.' },
    },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const context = await resolveContext(ownerId, args, ctx);
      const scope = str(args.scope);
      if (scope !== undefined && scope !== 'workspace' && scope !== 'repository' && scope !== 'thread') {
        throw new Error('scope must be "workspace", "repository" or "thread"');
      }
      const rows = await callApi<MemoryEntrySummary[]>(ownerId, 'GET', `/workbenches/memory?${listQuery(context, {})}`);
      return linesOrNone(scope ? rows.filter((row) => row.scope === scope) : rows, entryLine);
    },
    FEATURE,
  ),
];
