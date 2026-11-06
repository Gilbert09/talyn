import { sql } from 'drizzle-orm';
import type { AgentEvent } from '@talyn/shared';
import {
  repositories as reposTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { cursorTimeColumn } from './cursor.js';

/**
 * The ONLY way a row leaves `/v1`. Each resource has an explicit column list
 * (what is read) and a mapper (what is sent), both snake_case on the way out.
 *
 * Two guards in one:
 *  - Leaks. A session row holds `device_id`, `local_path`, `sandbox_id`, the
 *    fleet host and fleet keys in `settings`. None of them is selected, so no
 *    mapper can send one by mistake.
 *  - Egress. jsonb columns are read as the one value the API needs, computed
 *    in SQL (`settings ->> 'internetAccess'`, `jsonb_array_length(queued_messages)`),
 *    never as the whole blob. The `.toSQL()` tests in `publicProjections.test.ts`
 *    hold this.
 */

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const PUBLIC_WORKSPACE_COLUMNS = {
  id: workspacesTable.id,
  name: workspacesTable.name,
  createdAt: workspacesTable.createdAt,
  updatedAt: workspacesTable.updatedAt,
  cursorTime: cursorTimeColumn(workspacesTable.createdAt),
} as const;

export interface PublicWorkspaceRow {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicWorkspace(row: PublicWorkspaceRow) {
  return {
    object: 'workspace' as const,
    id: row.id,
    name: row.name,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const PUBLIC_REPOSITORY_COLUMNS = {
  id: reposTable.id,
  workspaceId: reposTable.workspaceId,
  name: reposTable.name,
  url: reposTable.url,
  defaultBranch: reposTable.defaultBranch,
  createdAt: reposTable.createdAt,
  cursorTime: cursorTimeColumn(reposTable.createdAt),
} as const;

export interface PublicRepositoryRow {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  defaultBranch: string;
  createdAt: Date;
}

/** `owner/name` from the GitHub URL, else the stored name. */
export function repositoryFullName(url: string, name: string): string {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : name;
}

export function toPublicRepository(row: PublicRepositoryRow) {
  return {
    object: 'repository' as const,
    id: row.id,
    workspace_id: row.workspaceId,
    full_name: repositoryFullName(row.url, row.name),
    url: row.url,
    default_branch: row.defaultBranch,
    created_at: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const PUBLIC_SESSION_COLUMNS = {
  id: workbenchesTable.id,
  workspaceId: workbenchesTable.workspaceId,
  kind: workbenchesTable.kind,
  threadId: workbenchesTable.threadId,
  repositoryId: workbenchesTable.repositoryId,
  repoFullName: workbenchesTable.repoFullName,
  name: workbenchesTable.name,
  title: workbenchesTable.title,
  branch: workbenchesTable.branch,
  baseBranch: workbenchesTable.baseBranch,
  runtime: workbenchesTable.runtime,
  agent: workbenchesTable.agent,
  model: workbenchesTable.model,
  status: workbenchesTable.status,
  statusMessage: workbenchesTable.statusMessage,
  pullRequestId: workbenchesTable.pullRequestId,
  internetAccess: sql<boolean | null>`(${workbenchesTable.settings} ->> 'internetAccess')::boolean`,
  autoCreatePr: sql<boolean | null>`(${workbenchesTable.settings} ->> 'autoCreatePr')::boolean`,
  diffAdded: sql<number | null>`(${workbenchesTable.diffStat} ->> 'added')::int`,
  diffRemoved: sql<number | null>`(${workbenchesTable.diffStat} ->> 'removed')::int`,
  diffFiles: sql<number | null>`(${workbenchesTable.diffStat} ->> 'files')::int`,
  archivedAt: workbenchesTable.archivedAt,
  createdAt: workbenchesTable.createdAt,
  updatedAt: workbenchesTable.updatedAt,
  cursorTime: cursorTimeColumn(workbenchesTable.createdAt),
} as const;

export interface PublicSessionRow {
  id: string;
  workspaceId: string;
  kind: string;
  threadId: string | null;
  repositoryId: string | null;
  repoFullName: string;
  name: string;
  title: string | null;
  branch: string;
  baseBranch: string;
  runtime: string;
  agent: string;
  model: string | null;
  status: string;
  statusMessage: string | null;
  pullRequestId: string | null;
  internetAccess: boolean | null;
  autoCreatePr: boolean | null;
  diffAdded: number | null;
  diffRemoved: number | null;
  diffFiles: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicSessionStatus = 'provisioning' | 'ready' | 'moving' | 'error' | 'archived' | 'archive_error';

/** The status a person sees, as `rowToWorkbench` computes it, in snake_case. */
export function publicSessionStatus(row: Pick<PublicSessionRow, 'status' | 'archivedAt'>): PublicSessionStatus {
  if (row.status === 'archiveError') return 'archive_error';
  if (row.archivedAt) return 'archived';
  switch (row.status) {
    case 'provisioning':
    case 'ready':
    case 'moving':
    case 'error':
      return row.status;
    default:
      return 'error';
  }
}

export function toPublicSession(row: PublicSessionRow, chats?: PublicChatRow[]) {
  const diffKnown = row.diffAdded !== null || row.diffRemoved !== null || row.diffFiles !== null;
  return {
    object: 'session' as const,
    id: row.id,
    workspace_id: row.workspaceId,
    kind: row.kind === 'thread' ? ('thread' as const) : ('session' as const),
    thread_id: row.threadId ?? null,
    repository_id: row.repositoryId ?? null,
    repository_full_name: row.repoFullName || null,
    name: row.name,
    title: row.title ?? null,
    branch: row.branch || null,
    base_branch: row.baseBranch || null,
    runtime: row.runtime === 'local' ? ('local' as const) : ('sandbox' as const),
    agent: row.agent === 'codex' ? ('codex' as const) : ('claude' as const),
    model: row.model ?? null,
    status: publicSessionStatus(row),
    status_message: row.statusMessage ?? null,
    pull_request_id: row.pullRequestId ?? null,
    internet_access: row.internetAccess ?? null,
    auto_create_pr: row.autoCreatePr ?? null,
    diff_stat: diffKnown ? { added: row.diffAdded ?? 0, removed: row.diffRemoved ?? 0, files: row.diffFiles ?? 0 } : null,
    archived_at: row.archivedAt ? row.archivedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(chats ? { chats: chats.map(toPublicChat) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/**
 * `queued_messages` holds what a person typed during a turn, attachments
 * included (base64). The API sends how many there are, read in SQL.
 */
export const PUBLIC_CHAT_COLUMNS = {
  id: chatsTable.id,
  workbenchId: chatsTable.workbenchId,
  workspaceId: chatsTable.workspaceId,
  title: chatsTable.title,
  agent: chatsTable.agent,
  model: chatsTable.model,
  effort: chatsTable.effort,
  planMode: chatsTable.planMode,
  status: chatsTable.status,
  resumeAt: chatsTable.resumeAt,
  statusMessage: chatsTable.statusMessage,
  turnCount: chatsTable.turnCount,
  queuedMessageCount: sql<number>`jsonb_array_length(${chatsTable.queuedMessages})`.mapWith(Number),
  closedAt: chatsTable.closedAt,
  createdAt: chatsTable.createdAt,
  updatedAt: chatsTable.updatedAt,
} as const;

export interface PublicChatRow {
  resumeAt?: Date | null;
  id: string;
  workbenchId: string;
  workspaceId: string;
  title: string;
  agent: string;
  model: string | null;
  effort: string | null;
  planMode: boolean;
  status: string;
  statusMessage: string | null;
  turnCount: number;
  queuedMessageCount: number;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CHAT_STATUSES = new Set(['idle', 'running', 'awaiting_input', 'error']);

export function toPublicChat(row: PublicChatRow) {
  return {
    object: 'chat' as const,
    id: row.id,
    session_id: row.workbenchId,
    title: row.title,
    agent: row.agent === 'codex' ? ('codex' as const) : ('claude' as const),
    model: row.model ?? null,
    effort: row.effort ?? null,
    plan_mode: row.planMode,
    status: (CHAT_STATUSES.has(row.status) ? row.status : 'error') as 'idle' | 'running' | 'awaiting_input' | 'error',
    resume_at: row.resumeAt?.toISOString() ?? null,
    status_message: row.statusMessage ?? null,
    turn_count: row.turnCount,
    queued_message_count: row.queuedMessageCount,
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function toPublicEvent(chatId: string, e: { seq: number; turn: number; event: AgentEvent | Record<string, unknown> }) {
  const data: Record<string, unknown> = { ...(e.event as Record<string, unknown>), seq: e.seq };
  return {
    object: 'event' as const,
    chat_id: chatId,
    seq: e.seq,
    turn: e.turn,
    type: typeof data.type === 'string' ? data.type : 'unknown',
    data,
  };
}

export type PublicWorkspace = ReturnType<typeof toPublicWorkspace>;
export type PublicRepository = ReturnType<typeof toPublicRepository>;
export type PublicSession = ReturnType<typeof toPublicSession>;
export type PublicChat = ReturnType<typeof toPublicChat>;
export type PublicEvent = ReturnType<typeof toPublicEvent>;
