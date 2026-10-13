/**
 * The coding-agent CLIs, as argv in and AgentEvents out.
 *
 * One process per turn, for both runtimes (see `docs/WORKBENCHES.md`, Phase 0):
 * the sandbox runs the argv through the fleet's `/exec`, the desktop through
 * `child_process.spawn`. Both feed stdout through a {@link LineBuffer} and the
 * parser here, so a transcript renders the same whichever ran it.
 *
 * Claude's `stream-json` events already ARE the `AgentEvent` shape
 * `transcript.ts` renders, so the Claude parser passes them through and only
 * derives state. Codex's `exec --json` events are a different vocabulary, and
 * the Codex parser converts them into the Claude shape — text, thinking,
 * tool_use / tool_result pairs and a final `result` — rather than teaching the
 * renderer a second dialect.
 */
import type { AgentEvent } from './index.js';
import type { WorkbenchAgent, WorkbenchContextUsage, WorkbenchEffort, WorkbenchTodo } from './workbench.js';

/** An AgentEvent before the store assigns its `seq`. */
export type AgentEventDraft = Partial<Pick<AgentEvent, 'seq'>> &
  Pick<
    AgentEvent,
    'type' | 'subtype' | 'session_id' | 'message' | 'event' | 'result' | 'total_cost_usd' | 'is_error' | 'permission_denials' | 'usage'
  > & { [k: string]: unknown };

export function withSeq(draft: AgentEventDraft, seq: number): AgentEvent {
  return { ...draft, seq } as AgentEvent;
}

// ============================================================================
// argv
// ============================================================================

/**
 * Claude Code permission modes. 2.1.x lists `acceptEdits`, `auto`,
 * `bypassPermissions`, `manual`, `dontAsk` and `plan`; `default` is the older
 * name of `manual` and is still accepted.
 */
export type ClaudePermissionMode =
  | 'plan'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'default'
  | 'manual'
  | 'auto'
  | 'dontAsk';

export interface ClaudeArgvOptions {
  prompt: string;
  model?: string;
  /** `plan` wins over `permissionMode`. */
  planMode?: boolean;
  /**
   * Default `bypassPermissions`: a `-p` run has no one to answer a prompt, so
   * any other mode denies every command that would have asked. In a sandbox
   * the microVM is the boundary. NOTE: Claude Code refuses
   * `bypassPermissions` as root unless `IS_SANDBOX=1` is set — see
   * {@link CLAUDE_SANDBOX_ENV}.
   */
  permissionMode?: ClaudePermissionMode;
  resumeSessionId?: string;
  /** Only meaningful with `resumeSessionId`: branch the session instead of continuing it. */
  forkSession?: boolean;
  appendSystemPrompt?: string;
  effort?: WorkbenchEffort;
  /** The executable, default `claude`. */
  binary?: string;
}

/** Env a sandbox exec of Claude Code needs: the guest runs as root, and bypassPermissions refuses root without it. */
export const CLAUDE_SANDBOX_ENV: Readonly<Record<string, string>> = { IS_SANDBOX: '1' };

/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages …`.
 *
 * The prompt goes LAST, after `--`: a prompt that starts with `-` ("- fix the
 * tests") would otherwise be parsed as an option.
 */
export function buildClaudeArgv(opts: ClaudeArgvOptions): string[] {
  const argv = [
    opts.binary ?? 'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (opts.model) argv.push('--model', opts.model);
  argv.push('--permission-mode', opts.planMode ? 'plan' : (opts.permissionMode ?? 'bypassPermissions'));
  if (opts.resumeSessionId) {
    argv.push('--resume', opts.resumeSessionId);
    if (opts.forkSession) argv.push('--fork-session');
  }
  if (opts.appendSystemPrompt) argv.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.effort) argv.push('--effort', opts.effort);
  argv.push('--', opts.prompt);
  return argv;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexArgvOptions {
  prompt: string;
  model?: string;
  effort?: WorkbenchEffort;
  /** Plan mode runs Codex read-only: it can look, not touch. */
  planMode?: boolean;
  /** A follow-up turn: `codex exec resume <id>`. */
  resumeSessionId?: string;
  /**
   * Override the sandbox policy. Default `workspace-write`, or `read-only` in
   * plan mode. Codex's own sandbox (Landlock/seccomp on Linux) may not be
   * available inside a microVM; a runtime that finds so can pass
   * `danger-full-access`, which disables Codex's sandbox but NOT its approval
   * policy — unlike `--dangerously-bypass-approvals-and-sandbox`, never used.
   */
  sandboxMode?: CodexSandboxMode;
  /** Image files to attach (`-i`). */
  images?: string[];
  binary?: string;
}

/** Codex's `model_reasoning_effort` has no `max`; its top level is `xhigh`. */
export function codexReasoningEffort(effort: WorkbenchEffort): string {
  return effort === 'max' ? 'xhigh' : effort;
}

/**
 * `codex exec --json …`, or `codex exec resume … <id>` for a follow-up.
 *
 * Checked against codex-cli 0.159: there is no `--full-auto` any more, and
 * `exec resume` accepts no `--sandbox` flag. So the sandbox and the approval
 * policy go through `-c` overrides, which both subcommands accept, and the
 * argv is the same shape for a first turn and a follow-up.
 *
 * Network: `workspace-write` blocks it by default, and the agent needs it to
 * `git push` and `gh pr create` — so it is enabled outside plan mode.
 */
export function buildCodexArgv(opts: CodexArgvOptions): string[] {
  const sandbox: CodexSandboxMode = opts.sandboxMode ?? (opts.planMode ? 'read-only' : 'workspace-write');
  const argv = [opts.binary ?? 'codex', 'exec'];
  if (opts.resumeSessionId) argv.push('resume');
  argv.push('--json', '--skip-git-repo-check');
  if (opts.model) argv.push('-m', opts.model);
  if (opts.effort) argv.push('-c', `model_reasoning_effort="${codexReasoningEffort(opts.effort)}"`);
  argv.push('-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
  if (sandbox === 'workspace-write') argv.push('-c', 'sandbox_workspace_write.network_access=true');
  for (const image of opts.images ?? []) argv.push('-i', image);
  argv.push('--');
  if (opts.resumeSessionId) argv.push(opts.resumeSessionId);
  argv.push(opts.prompt);
  return argv;
}

// ============================================================================
// Line buffering
// ============================================================================

/**
 * Exec output arrives in arbitrary chunks — a JSON line can be split across
 * two frames, and one frame can hold several lines. Push chunks in, take
 * complete lines out; `flush()` returns the unterminated tail at the end.
 */
export class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** The remainder, as zero or one line. Empties the buffer. */
  flush(): string[] {
    const rest = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    this.pending = '';
    return rest ? [rest] : [];
  }
}

// ============================================================================
// Parsers
// ============================================================================

export interface AgentStreamResult {
  isError: boolean;
  subtype: string;
  /** The final message, or the error text. */
  text: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface AgentStreamParser {
  readonly agent: WorkbenchAgent;
  /** One line of stdout in, zero or more events out. Blank lines yield nothing. */
  push(line: string): AgentEventDraft[];
  readonly sessionId: string | null;
  /** Set once the run's final `result` arrives. */
  readonly result: AgentStreamResult | null;
  /** The agent's latest to-do list, or null if it never wrote one. */
  readonly todos: WorkbenchTodo[] | null;
  readonly contextUsage: WorkbenchContextUsage | null;
  /** Lines that were not a JSON object — CLI warnings, a crash trace. Counted, not emitted. */
  readonly nonJsonLines: number;
}

export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
/** GPT-5-class models accept ~272k input tokens. */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function contextUsageOf(usedTokens: number, contextWindow: number): WorkbenchContextUsage {
  const fraction = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
  return { usedTokens, contextWindow, fraction };
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function normaliseTodos(raw: unknown): WorkbenchTodo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WorkbenchTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== 'string') continue;
    const status = typeof t.status === 'string' && TODO_STATUSES.has(t.status) ? t.status : 'pending';
    const todo: WorkbenchTodo = { content: t.content, status: status as WorkbenchTodo['status'] };
    if (typeof t.activeForm === 'string') todo.activeForm = t.activeForm;
    out.push(todo);
  }
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The context window a Claude model id implies when the stream has not said. */
function claudeWindowForModel(model: string | null): number {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : CLAUDE_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Claude Code `stream-json`: passthrough plus derived state.
 *
 * - Session id: `system/init`, or any event's `session_id`.
 * - To-dos: the input of the latest `TodoWrite` tool call.
 * - Context usage: the last top-level assistant message's input tokens
 *   (fresh + cache read + cache creation) — that sum is the prompt size, i.e.
 *   how full the window is. A subagent's messages (`parent_tool_use_id` set)
 *   run in their own context and are ignored.
 * - Context window: `result.modelUsage[model].contextWindow` once the result
 *   arrives, else 1M for a `[1m]` model, else 200k.
 */
export function createClaudeStreamParser(): AgentStreamParser {
  let sessionId: string | null = null;
  let result: AgentStreamResult | null = null;
  let todos: WorkbenchTodo[] | null = null;
  let usedTokens: number | null = null;
  let model: string | null = null;
  let contextWindow: number | null = null;
  let nonJsonLines = 0;

  return {
    agent: 'claude',
    push(line: string): AgentEventDraft[] {
      if (!line.trim()) return [];
      const obj = parseJsonObject(line);
      if (!obj || typeof obj.type !== 'string') {
        nonJsonLines++;
        return [];
      }
      if (typeof obj.session_id === 'string' && obj.session_id) sessionId = obj.session_id;

      if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.model === 'string') {
        model = obj.model;
      }

      if (obj.type === 'assistant') {
        const message = (obj.message ?? {}) as { content?: unknown; usage?: unknown; model?: unknown };
        if (!obj.parent_tool_use_id) {
          if (typeof message.model === 'string' && !model) model = message.model;
          if (message.usage && typeof message.usage === 'object') {
            const u = message.usage as Record<string, unknown>;
            usedTokens =
              num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
          }
        }
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as { type?: unknown; name?: unknown; input?: unknown };
            if (b?.type === 'tool_use' && b.name === 'TodoWrite') {
              const next = normaliseTodos((b.input as { todos?: unknown } | undefined)?.todos);
              if (next) todos = next;
            }
          }
        }
      }

      if (obj.type === 'result') {
        result = {
          isError: Boolean(obj.is_error) || (typeof obj.subtype === 'string' && obj.subtype !== 'success'),
          subtype: typeof obj.subtype === 'string' ? obj.subtype : 'success',
          text: typeof obj.result === 'string' ? obj.result : '',
          costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
          durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
          numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        };
        const modelUsage = obj.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
        if (modelUsage && typeof modelUsage === 'object') {
          const own = model ? modelUsage[model]?.contextWindow : undefined;
          const windows = Object.values(modelUsage)
            .map((m) => m?.contextWindow)
            .filter((w): w is number => typeof w === 'number' && w > 0);
          if (typeof own === 'number' && own > 0) contextWindow = own;
          else if (windows.length > 0) contextWindow = Math.max(...windows);
        }
      }

      return [obj as AgentEventDraft];
    },
    get sessionId() {
      return sessionId;
    },
    get result() {
      return result;
    },
    get todos() {
      return todos;
    },
    get contextUsage() {
      if (usedTokens === null) return null;
      return contextUsageOf(usedTokens, contextWindow ?? claudeWindowForModel(model));
    },
    get nonJsonLines() {
      return nonJsonLines;
    },
  };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
  message?: string;
}

/**
 * Codex `exec --json` → Claude-shaped AgentEvents.
 *
 * | Codex | Emitted |
 * |---|---|
 * | `thread.started {thread_id}` | `system/init` (thread_id is the session id) |
 * | `agent_message` updated | `stream_event` text deltas (the live tail) |
 * | `agent_message` completed | assistant `text` |
 * | `reasoning` completed | assistant `thinking` |
 * | `command_execution` | assistant `tool_use` Bash on start, user `tool_result` on completion |
 * | `file_change` | `tool_use` Edit + `tool_result` listing the changes |
 * | `mcp_tool_call` | `tool_use mcp__<server>__<tool>` + `tool_result` |
 * | `web_search` | `tool_use` WebSearch + `tool_result` |
 * | `todo_list` | `tool_use` TodoWrite (Claude's shape) + `tool_result`, on each change |
 * | `error` item / top-level `error` | `system/stderr` (top-level errors include retry notices, so not fatal) |
 * | `turn.completed {usage}` | `result/success` with the last agent message |
 * | `turn.failed {error}` | `result/error_during_execution` |
 *
 * The tool_use id is the item id, so a result always pairs with its call.
 * Context usage is approximate: Codex reports the turn's summed input tokens,
 * not the last prompt's size, so it reads as an upper bound.
 */
export function createCodexStreamParser(opts: { contextWindow?: number } = {}): AgentStreamParser {
  let sessionId: string | null = null;
  let result: AgentStreamResult | null = null;
  let todos: WorkbenchTodo[] | null = null;
  let usedTokens: number | null = null;
  let nonJsonLines = 0;
  let lastAgentMessage = '';
  let todoRevision = 0;
  let lastTodoSignature = '';
  const toolUseEmitted = new Set<string>();
  const toolResultEmitted = new Set<string>();
  const streamedText = new Map<string, string>();

  const base = (): { session_id?: string } => (sessionId ? { session_id: sessionId } : {});
  const assistant = (id: string | undefined, content: unknown[]): AgentEventDraft => ({
    type: 'assistant',
    ...base(),
    message: { id, role: 'assistant', content },
  });
  const toolResult = (toolUseId: string, content: unknown, isError: boolean): AgentEventDraft => ({
    type: 'user',
    ...base(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  });

  function toolCall(item: CodexItem): { name: string; input: unknown } | null {
    switch (item.type) {
      case 'command_execution':
        return { name: 'Bash', input: { command: item.command ?? '' } };
      case 'mcp_tool_call':
        return { name: `mcp__${item.server ?? 'server'}__${item.tool ?? 'tool'}`, input: item.arguments ?? {} };
      case 'web_search':
        return { name: 'WebSearch', input: { query: item.query ?? '' } };
      case 'file_change': {
        const changes = (item.changes ?? []).map((c) => ({ path: c.path ?? '', kind: c.kind ?? 'update' }));
        return { name: 'Edit', input: { file_path: changes.map((c) => c.path).join(', '), changes } };
      }
      default:
        return null;
    }
  }

  function emitToolUse(item: CodexItem, out: AgentEventDraft[]): void {
    const id = item.id ?? '';
    if (!id || toolUseEmitted.has(id)) return;
    const call = toolCall(item);
    if (!call) return;
    toolUseEmitted.add(id);
    out.push(assistant(id, [{ type: 'tool_use', id, name: call.name, input: call.input }]));
  }

  function toolOutput(item: CodexItem): { content: unknown; isError: boolean } {
    switch (item.type) {
      case 'command_execution': {
        const failed =
          item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
        return { content: item.aggregated_output ?? '', isError: failed };
      }
      case 'mcp_tool_call': {
        if (item.error?.message) return { content: item.error.message, isError: true };
        return { content: item.result?.content ?? item.result?.structured_content ?? '', isError: item.status === 'failed' };
      }
      case 'file_change': {
        const letter = (kind?: string) => (kind === 'add' ? 'A' : kind === 'delete' ? 'D' : 'M');
        const lines = (item.changes ?? []).map((c) => `${letter(c.kind)} ${c.path ?? ''}`);
        return { content: lines.join('\n'), isError: item.status === 'failed' };
      }
      default:
        return { content: '', isError: item.status === 'failed' };
    }
  }

  function handleTodos(item: CodexItem, out: AgentEventDraft[]): void {
    const next: WorkbenchTodo[] = (item.items ?? []).map((t) => ({
      content: t.text ?? '',
      status: t.completed ? 'completed' : 'pending',
    }));
    // Codex marks only done/not done; the first open item is the one in hand.
    const firstOpen = next.find((t) => t.status === 'pending');
    if (firstOpen) firstOpen.status = 'in_progress';
    todos = next;
    const signature = JSON.stringify(next);
    if (signature === lastTodoSignature) return;
    lastTodoSignature = signature;
    const id = `${item.id ?? 'todo'}:${++todoRevision}`;
    out.push(assistant(id, [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: next } }]));
    out.push(toolResult(id, 'Todos updated', false));
  }

  function handleItem(phase: 'started' | 'updated' | 'completed', item: CodexItem, out: AgentEventDraft[]): void {
    const id = item.id ?? '';
    switch (item.type) {
      case 'agent_message':
      case 'assistant_message': {
        const text = item.text ?? '';
        if (phase !== 'completed') {
          const seen = streamedText.get(id) ?? '';
          if (text.length > seen.length && text.startsWith(seen)) {
            out.push({
              type: 'stream_event',
              ...base(),
              event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(seen.length) } },
            });
            streamedText.set(id, text);
          }
          return;
        }
        streamedText.delete(id);
        if (text) {
          lastAgentMessage = text;
          out.push(assistant(id, [{ type: 'text', text }]));
        }
        return;
      }
      case 'reasoning':
        if (phase === 'completed' && item.text) out.push(assistant(id, [{ type: 'thinking', thinking: item.text }]));
        return;
      case 'todo_list':
        handleTodos(item, out);
        return;
      case 'error':
        if (phase === 'completed' || phase === 'started') {
          out.push({ type: 'system', subtype: 'stderr', ...base(), text: item.message ?? 'error' });
        }
        return;
      case 'command_execution':
      case 'mcp_tool_call':
      case 'web_search':
      case 'file_change':
        emitToolUse(item, out);
        if (phase === 'completed' && id && !toolResultEmitted.has(id)) {
          toolResultEmitted.add(id);
          const { content, isError } = toolOutput(item);
          out.push(toolResult(id, content, isError));
        }
        return;
      default:
        return;
    }
  }

  return {
    agent: 'codex',
    push(line: string): AgentEventDraft[] {
      if (!line.trim()) return [];
      const obj = parseJsonObject(line);
      if (!obj || typeof obj.type !== 'string') {
        nonJsonLines++;
        return [];
      }
      const out: AgentEventDraft[] = [];
      switch (obj.type) {
        case 'thread.started':
          if (typeof obj.thread_id === 'string' && obj.thread_id) sessionId = obj.thread_id;
          out.push({ type: 'system', subtype: 'init', ...base(), agent: 'codex' });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (obj.item && typeof obj.item === 'object') {
            handleItem(obj.type.slice('item.'.length) as 'started' | 'updated' | 'completed', obj.item as CodexItem, out);
          }
          break;
        case 'turn.completed': {
          const u = (obj.usage ?? {}) as Record<string, unknown>;
          usedTokens = num(u.input_tokens);
          result = { isError: false, subtype: 'success', text: lastAgentMessage };
          out.push({
            type: 'result',
            subtype: 'success',
            ...base(),
            is_error: false,
            result: lastAgentMessage,
            usage: {
              input_tokens: num(u.input_tokens),
              cache_read_input_tokens: num(u.cached_input_tokens),
              output_tokens: num(u.output_tokens),
            },
          });
          break;
        }
        case 'turn.failed': {
          const message = String((obj.error as { message?: unknown } | undefined)?.message ?? 'Turn failed');
          result = { isError: true, subtype: 'error_during_execution', text: message };
          out.push({ type: 'result', subtype: 'error_during_execution', ...base(), is_error: true, result: message });
          break;
        }
        case 'error':
          out.push({ type: 'system', subtype: 'stderr', ...base(), text: String(obj.message ?? 'error') });
          break;
        default:
          // turn.started and anything newer: nothing to render.
          break;
      }
      return out;
    },
    get sessionId() {
      return sessionId;
    },
    get result() {
      return result;
    },
    get todos() {
      return todos;
    },
    get contextUsage() {
      if (usedTokens === null) return null;
      return contextUsageOf(usedTokens, opts.contextWindow ?? CODEX_DEFAULT_CONTEXT_WINDOW);
    },
    get nonJsonLines() {
      return nonJsonLines;
    },
  };
}

export function createAgentStreamParser(agent: WorkbenchAgent): AgentStreamParser {
  return agent === 'codex' ? createCodexStreamParser() : createClaudeStreamParser();
}

/**
 * One line through a parser. The `agent` argument is a guard: handing a Codex
 * line to the Claude parser would pass it through as an unrenderable event,
 * which is the kind of mistake that shows as a silently empty transcript.
 */
export function parseAgentLine(agent: WorkbenchAgent, parser: AgentStreamParser, line: string): AgentEventDraft[] {
  if (parser.agent !== agent) {
    throw new Error(`parseAgentLine: a ${parser.agent} parser cannot read ${agent} output`);
  }
  return parser.push(line);
}
