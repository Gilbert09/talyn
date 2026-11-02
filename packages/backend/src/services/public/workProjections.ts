import { sql } from 'drizzle-orm';
import type {
  RepositoryInstructions,
  RepositoryPreviewResponse,
  RepositorySandboxSizeResponse,
  SetupRecipe,
  WorkbenchChangedFile,
  WorkbenchChanges,
  WorkbenchCheckpoint,
  WorkbenchConfig,
  WorkbenchPreviewLink,
  WorkbenchReadiness,
  WorkbenchTiming,
} from '@talyn/shared';
import { workspaceMemories as memoriesTable } from '../../db/schema.js';
import { cursorTimeColumn } from './cursor.js';

/**
 * The public shapes of phase 2 part 1: the work inside a session, the chat
 * extras, memory and repository settings. Same rules as `projections.ts`:
 * built field by field, snake_case, and nothing a caller should not see.
 */

const iso = (value: string | Date | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.toISOString();

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function toPublicChangedFile(file: WorkbenchChangedFile) {
  return {
    path: file.path,
    old_path: file.oldPath ?? null,
    status: file.status,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
  };
}

export function toPublicChanges(sessionId: string, changes: WorkbenchChanges) {
  const zero = { added: 0, removed: 0, files: 0 };
  const stat = (s: WorkbenchChanges['uncommittedStats']) => (s ? { added: s.added, removed: s.removed, files: s.files } : zero);
  return {
    object: 'session_changes' as const,
    session_id: sessionId,
    files: changes.files.map(toPublicChangedFile),
    uncommitted: (changes.uncommitted ?? []).map(toPublicChangedFile),
    committed: (changes.committed ?? []).map(toPublicChangedFile),
    uncommitted_stat: stat(changes.uncommittedStats),
    committed_stat: stat(changes.committedStats),
    base_sha: changes.base || null,
    head_sha: changes.headSha || null,
    snapshot_at: changes.snapshotAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export interface ScriptRunRow {
  name: string;
  running: boolean;
  exitCode: number | null;
}

type ScriptKind = 'setup' | 'run' | 'archive';

const kindOf = (name: string): ScriptKind => (name === 'setup' || name === 'archive' ? name : 'run');

function scriptStatus(run: ScriptRunRow | undefined): 'running' | 'exited' | 'not_started' {
  if (!run) return 'not_started';
  return run.running ? 'running' : 'exited';
}

export function toPublicScript(
  sessionId: string,
  name: string,
  run: ScriptRunRow | undefined,
  defined?: { kind: ScriptKind; command: string; default: boolean | null },
) {
  return {
    object: 'script' as const,
    session_id: sessionId,
    name,
    kind: defined?.kind ?? kindOf(name),
    command: defined?.command ?? null,
    default: defined?.default ?? null,
    status: scriptStatus(run),
    exit_code: run && !run.running ? run.exitCode : null,
  };
}

/**
 * Every script a session has: the ones its config defines (when read) in
 * config order, then any other script that has run.
 */
export function toPublicScripts(sessionId: string, runs: ScriptRunRow[], config: WorkbenchConfig | null) {
  const byName = new Map(runs.map((r) => [r.name, r]));
  const out: ReturnType<typeof toPublicScript>[] = [];
  const seen = new Set<string>();
  const add = (name: string, defined?: { kind: ScriptKind; command: string; default: boolean | null }) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(toPublicScript(sessionId, name, byName.get(name), defined));
  };
  if (config) {
    if (config.setup) add('setup', { kind: 'setup', command: config.setup.command, default: null });
    for (const run of config.run) add(run.name, { kind: 'run', command: run.command, default: run.default === true });
    if (config.archive) add('archive', { kind: 'archive', command: config.archive.command, default: null });
  }
  for (const run of [...runs].sort((a, b) => a.name.localeCompare(b.name))) add(run.name);
  return out;
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export function toPublicPreview(
  sessionId: string,
  port: { port: number; label?: string; primary?: boolean },
  origin: string | null,
) {
  return {
    object: 'preview' as const,
    session_id: sessionId,
    port: port.port,
    label: port.label ?? null,
    primary: port.primary === true,
    origin,
  };
}

export function toPublicPreviewLink(sessionId: string, link: WorkbenchPreviewLink) {
  return {
    object: 'preview_link' as const,
    session_id: sessionId,
    port: link.port,
    url: link.url,
    origin: link.origin,
    expires_at: link.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Timing and readiness
// ---------------------------------------------------------------------------

export function toPublicTiming(sessionId: string, timing: WorkbenchTiming) {
  const categories: Record<string, { ms: number; count: number }> = {};
  for (const [key, bucket] of Object.entries(timing.categories)) {
    if (bucket) categories[key] = { ms: bucket.ms, count: bucket.count };
  }
  return {
    object: 'session_timing' as const,
    session_id: sessionId,
    turns: timing.turns,
    wall_ms: timing.wallMs,
    tool_ms: timing.toolMs,
    model_ms: timing.modelMs,
    calls: timing.calls,
    categories,
    slowest: timing.slowest.map((c) => ({
      category: c.category,
      name: c.name,
      command: c.command ?? null,
      ms: c.ms,
      is_error: c.isError === true,
    })),
    recent_turns: timing.recentTurns.map((t) => ({
      chat_id: t.chatId,
      turn: t.turn,
      wall_ms: t.wallMs,
      tool_ms: t.toolMs,
      model_ms: t.modelMs,
      calls: t.calls,
      at: t.at,
    })),
  };
}

export function toPublicReadiness(workspaceId: string, readiness: WorkbenchReadiness) {
  const reason = (r: { code: string; message: string } | undefined) => (r ? { code: r.code, message: r.message } : null);
  const agent = (a: WorkbenchReadiness['sandbox']['agents']['claude']) => ({ ok: a.ok, reason: reason(a.reason) });
  return {
    object: 'session_readiness' as const,
    workspace_id: workspaceId,
    ok: readiness.sandbox.ok,
    reasons: readiness.sandbox.reasons.map((r) => ({ code: r.code, message: r.message })),
    agents: { claude: agent(readiness.sandbox.agents.claude), codex: agent(readiness.sandbox.agents.codex) },
  };
}

// ---------------------------------------------------------------------------
// Chats: queue and checkpoints
// ---------------------------------------------------------------------------

/**
 * One queued message as SQL hands it over: attachments are counted in SQL and
 * never read, because they are base64 images.
 */
export interface QueuedMessageRow {
  id: string;
  text: string;
  model?: string | null;
  effort?: string | null;
  planMode?: boolean | null;
  origin?: string | null;
  queuedAt: string;
  attachmentCount: number;
}

export function toPublicQueuedMessage(chatId: string, m: QueuedMessageRow) {
  return {
    object: 'queued_message' as const,
    id: m.id,
    chat_id: chatId,
    text: m.text,
    model: m.model ?? null,
    effort: m.effort ?? null,
    plan_mode: typeof m.planMode === 'boolean' ? m.planMode : null,
    attachment_count: Number(m.attachmentCount) || 0,
    origin: m.origin === 'talyn' ? ('talyn' as const) : ('user' as const),
    queued_at: m.queuedAt,
  };
}

export function toPublicCheckpoint(c: WorkbenchCheckpoint) {
  return { object: 'checkpoint' as const, chat_id: c.chatId, turn: c.turn, sha: c.sha, created_at: c.createdAt };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** `source` is read as its two public keys, never as the blob. */
export const PUBLIC_MEMORY_COLUMNS = {
  id: memoriesTable.id,
  workspaceId: memoriesTable.workspaceId,
  scope: memoriesTable.scope,
  repositoryId: memoriesTable.repositoryId,
  threadId: memoriesTable.threadId,
  type: memoriesTable.type,
  name: memoriesTable.name,
  description: memoriesTable.description,
  bytes: memoriesTable.bytes,
  sourceKind: sql<string | null>`${memoriesTable.source} ->> 'kind'`,
  sourceSessionId: sql<string | null>`${memoriesTable.source} ->> 'workbenchId'`,
  createdAt: memoriesTable.createdAt,
  updatedAt: memoriesTable.updatedAt,
  forgottenAt: memoriesTable.forgottenAt,
  cursorTime: cursorTimeColumn(memoriesTable.createdAt),
} as const;

export interface PublicMemoryRow {
  id: string;
  workspaceId: string;
  scope: string;
  repositoryId: string | null;
  threadId: string | null;
  type: string;
  name: string;
  description: string;
  bytes: number;
  sourceKind: string | null;
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  forgottenAt: Date | null;
  body?: string | null;
}

export function toPublicMemory(row: PublicMemoryRow) {
  const kind = row.sourceKind === 'session' || row.sourceKind === 'auto' ? row.sourceKind : 'user';
  return {
    object: 'memory' as const,
    id: row.id,
    workspace_id: row.workspaceId,
    scope: row.scope,
    repository_id: row.repositoryId ?? null,
    thread_id: row.threadId ?? null,
    type: row.type,
    name: row.name,
    description: row.description,
    ...(typeof row.body === 'string' ? { body: row.body } : {}),
    bytes: row.bytes,
    source: { kind, session_id: kind === 'session' ? (row.sourceSessionId ?? null) : null },
    forgotten_at: iso(row.forgottenAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Repository settings
// ---------------------------------------------------------------------------

function toPublicPreviewPort(p: { port: number; label?: string; primary?: boolean }) {
  return { port: p.port, label: p.label ?? null, primary: p.primary === true };
}

export function toPublicRepositorySettings(
  repositoryId: string,
  size: RepositorySandboxSizeResponse,
  preview: RepositoryPreviewResponse,
  learningDisabled: boolean,
) {
  const coder = preview.user.coder;
  return {
    object: 'repository_settings' as const,
    repository_id: repositoryId,
    sandbox_size: {
      setting: size.setting,
      detected: size.detected?.size ?? null,
      detected_reason: size.detected?.reason ?? null,
      effective: size.effective,
    },
    preview: {
      target: preview.user.target ?? 'auto',
      ports: preview.user.ports ? preview.user.ports.map(toPublicPreviewPort) : null,
      coder: coder
        ? {
            ...(coder.url !== undefined ? { url: coder.url } : {}),
            ...(coder.workspace !== undefined ? { workspace: coder.workspace } : {}),
            ...(coder.checkout !== undefined ? { checkout: coder.checkout } : {}),
            ...(coder.run !== undefined ? { run: coder.run } : {}),
          }
        : null,
      effective: {
        target: preview.target,
        ports: preview.ports.map(toPublicPreviewPort),
        source: preview.source,
      },
    },
    setup_learning: !learningDisabled,
  };
}

export function toPublicRepositoryInstructions(i: RepositoryInstructions) {
  return {
    object: 'repository_instructions' as const,
    repository_id: i.repositoryId,
    agents: i.agents,
    body: i.body,
    bytes: i.bytes,
    updated_at: i.updatedAt,
  };
}

export function toPublicSetupRecipe(recipe: SetupRecipe) {
  return {
    object: 'setup_recipe' as const,
    repository_id: recipe.repositoryId,
    learning: !recipe.learningDisabled,
    max_steps: recipe.maxSteps,
    steps: recipe.steps.map((s) => ({
      id: s.id,
      command: s.command,
      kind: s.kind,
      phase: s.phase,
      why: s.why,
      source: s.source,
      source_session_id: s.sourceWorkbenchId,
      seen_count: s.seenCount,
      first_seen_at: s.firstSeenAt,
      last_seen_at: s.lastSeenAt,
      applied_at: s.appliedAt,
      reverted_at: s.disabledAt,
      reverted_reason: s.disabledReason,
    })),
  };
}
