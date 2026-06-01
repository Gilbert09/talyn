import type { AgentEvent } from '@fastowl/shared';

/**
 * Converts PostHog Code's ACP (Agent Client Protocol) log/stream entries
 * into FastOwl `AgentEvent`s so the existing structured-conversation
 * renderer (AgentConversation.tsx) can display them with zero UI changes.
 *
 * PostHog runs the agent on its own sandbox and ships a JSONL log over
 * S3 (`/session_logs/`) and a live Redis stream (`/stream/` SSE). Each
 * entry is a JSON-RPC notification:
 *
 *   { type: 'notification', timestamp?, notification: { method, params } }
 *
 * The two shapes we care about:
 *   - `session/update` with a `params.update.sessionUpdate` discriminator
 *     (`agent_message[_chunk]`, `agent_thought_chunk`, `tool_call`,
 *     `tool_call_update`, …)
 *   - `_posthog/*` side-channel events (`console`, `sandbox_output`,
 *     `error`, `turn_complete`, …)
 *
 * Mapping target (Claude stream-json shapes the renderer already knows):
 *   - assistant text   → `assistant` event, content `[{type:'text'}]`
 *   - assistant thinking → `assistant` event, content `[{type:'thinking'}]`
 *   - tool_call        → `assistant` event, content `[{type:'tool_use'}]`
 *   - tool_call_update → `user` event, content `[{type:'tool_result'}]`
 *   - live text deltas → `stream_event`s (message_start + text_delta) so
 *     the renderer's streaming-tail accumulator shows text as it lands
 *   - console/sandbox/error → `system` events (subtype `stderr`)
 *
 * The converter is stateful: it coalesces streaming message/thought chunks
 * into a single finalised block (flushed on a block-kind switch, a
 * tool boundary, or `flush()` at end-of-turn / end-of-stream).
 */

/** An AgentEvent before the streamer stamps its monotonic `seq`. */
export type AgentEventInput = Omit<AgentEvent, 'seq'>;

export interface AcpLogEntry {
  type?: string;
  timestamp?: string;
  notification?: {
    method?: string;
    params?: unknown;
    result?: unknown;
  };
  [k: string]: unknown;
}

/** Per-chunk text we accumulate before finalising into one block. */
type ActiveStream = { kind: 'text' | 'thinking'; id: string; text: string };

/**
 * A tool call we've seen a `tool_call` for but not yet a terminal
 * `tool_call_update`. ACP sends `rawInput` empty at call time and streams
 * it in over many intermediate updates, so we buffer until the terminal
 * update (or end-of-stream) before emitting the `tool_use`.
 */
type PendingTool = { name: string; kind: string; input: Record<string, unknown> };

const MAX_SYSTEM_TEXT = 8000;

export class AcpConverter {
  private active: ActiveStream | null = null;
  private msgCounter = 0;
  private pendingTools = new Map<string, PendingTool>();

  /** Convert one ACP entry into zero or more AgentEvents. */
  push(entry: AcpLogEntry): AgentEventInput[] {
    const method = entry?.notification?.method;
    if (!method) return [];
    const params = (entry.notification?.params ?? {}) as Record<string, unknown>;

    if (method === 'session/update') {
      return this.handleSessionUpdate(params);
    }
    if (method === '_posthog/console') {
      return this.handleConsole(params);
    }
    if (method === '_posthog/sandbox_output') {
      return this.handleSandboxOutput(params);
    }
    if (method === '_posthog/error') {
      const message = asText(params.message);
      return message ? [systemEvent(`error: ${message}`)] : [];
    }
    if (method === '_posthog/turn_complete' || method === '_posthog/task_complete') {
      return this.flush();
    }
    // session/new, session/prompt, _posthog/progress, usage_update,
    // available_commands_update, etc. — not surfaced in the conversation.
    return [];
  }

  /** Finalise any in-flight streaming text/thought block. */
  flush(): AgentEventInput[] {
    if (!this.active) return [];
    const { kind, id, text } = this.active;
    this.active = null;
    if (!text) return [];
    const block =
      kind === 'thinking'
        ? { type: 'thinking', thinking: text }
        : { type: 'text', text };
    return [
      {
        type: 'assistant',
        message: { id, role: 'assistant', content: [block] },
      },
    ];
  }

  /**
   * Finalise everything at end-of-stream: any in-flight text block plus
   * any tool calls that never received a terminal update (e.g. a run still
   * in progress, or interrupted). Emits the buffered `tool_use`s so they
   * still render, just without a result. Call once when the stream ends.
   */
  end(): AgentEventInput[] {
    const out = this.flush();
    for (const [id, tool] of this.pendingTools) {
      out.push(toolUseEvent(id, tool.name, tool.input));
    }
    this.pendingTools.clear();
    return out;
  }

  private handleSessionUpdate(params: Record<string, unknown>): AgentEventInput[] {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = asText(update.sessionUpdate);

    switch (kind) {
      case 'agent_message': {
        // A full (non-chunk) message — the shape S3 backfill returns
        // (chunks are filtered out of the durable log). It's already
        // complete, so finalise any in-flight stream and emit it directly.
        const text = extractContentText(update.content);
        if (!text) return [];
        const out = this.flush();
        out.push({
          type: 'assistant',
          message: {
            id: `acp-text-${this.msgCounter++}`,
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        });
        return out;
      }
      case 'agent_message_chunk': {
        // A streaming delta (live SSE) — accumulate and emit live deltas.
        const text = extractContentText(update.content);
        if (!text) return [];
        return this.appendStream('text', text);
      }
      case 'user_message':
      case 'user_message_chunk': {
        const text = extractContentText(update.content);
        if (!text) return [];
        // User turns are short and already known to the operator; emit
        // them as a discrete user text block, flushing agent text first.
        const out = this.flush();
        out.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        });
        return out;
      }
      case 'agent_thought_chunk':
      case 'agent_thought': {
        const text = extractContentText(update.content);
        if (!text) return [];
        return this.appendStream('thinking', text);
      }
      case 'tool_call': {
        const id = asText(update.toolCallId) || `tool-${this.msgCounter++}`;
        // Buffer the call: `rawInput` is empty here and streams in over the
        // intermediate updates, so we defer the `tool_use` until the
        // terminal update (or end-of-stream) when the command is complete.
        this.pendingTools.set(id, {
          name: toolName(update) || 'tool',
          kind: asText(update.kind),
          input: toolInput(update),
        });
        // Close any in-flight text block so ordering stays correct.
        return this.flush();
      }
      case 'tool_call_update': {
        const id = asText(update.toolCallId);
        if (!id) return [];
        const prev = this.pendingTools.get(id);
        // Merge the latest known name/input as it streams in.
        const merged: PendingTool = {
          name: toolName(update) || prev?.name || 'tool',
          kind: asText(update.kind) || prev?.kind || '',
          input: toolInput(update, prev?.input),
        };
        this.pendingTools.set(id, merged);

        const status = asText(update.status);
        // Intermediate updates (no status, or a non-terminal one) just carry
        // streaming input — accumulate and emit nothing. Only the terminal
        // update finalises the call into a tool_use + result pair.
        if (status !== 'completed' && status !== 'failed' && status !== 'error') {
          return [];
        }
        this.pendingTools.delete(id);
        const out = this.flush();
        out.push(toolUseEvent(id, merged.name, merged.input));
        out.push(
          toolResultEvent(id, toolOutput(update), status === 'failed' || status === 'error'),
        );
        return out;
      }
      default:
        return [];
    }
  }

  private handleConsole(params: Record<string, unknown>): AgentEventInput[] {
    const level = asText(params.level).toLowerCase();
    // info/debug console chatter is noise in a conversation view; only
    // surface warnings and errors.
    if (level !== 'warn' && level !== 'error') return [];
    const message = asText(params.message);
    if (!message) return [];
    return [systemEvent(`${level}: ${message}`)];
  }

  private handleSandboxOutput(params: Record<string, unknown>): AgentEventInput[] {
    const out: AgentEventInput[] = [];
    const stdout = asText(params.stdout);
    const stderr = asText(params.stderr);
    if (stdout) out.push(systemEvent(stdout));
    if (stderr) out.push(systemEvent(stderr));
    return out;
  }

  /**
   * Append a chunk to the active streaming block. Switching block kind
   * (text↔thinking) finalises the previous block first. For text we also
   * emit `stream_event`s so the renderer shows the response building live;
   * thinking has no live-delta path in the renderer, so it only surfaces
   * on flush.
   */
  private appendStream(kind: 'text' | 'thinking', text: string): AgentEventInput[] {
    const out: AgentEventInput[] = [];
    if (this.active && this.active.kind !== kind) {
      out.push(...this.flush());
    }
    if (!this.active) {
      const id = `acp-${kind}-${this.msgCounter++}`;
      this.active = { kind, id, text: '' };
      if (kind === 'text') {
        out.push({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
      }
    }
    this.active.text += text;
    if (kind === 'text') {
      out.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });
    }
    return out;
  }
}

function systemEvent(text: string): AgentEventInput {
  return { type: 'system', subtype: 'stderr', text: clamp(text, MAX_SYSTEM_TEXT) };
}

function toolUseEvent(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AgentEventInput {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResultEvent(id: string, content: string, isError: boolean): AgentEventInput {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  };
}

/** PostHog Code stashes the real tool name + bash command under `_meta`. */
function claudeMeta(update: Record<string, unknown>): {
  toolName?: unknown;
  bashCommand?: unknown;
} {
  const meta = update._meta as { claudeCode?: Record<string, unknown> } | undefined;
  return (meta?.claudeCode ?? {}) as { toolName?: unknown; bashCommand?: unknown };
}

/**
 * Resolve a tool name from an update, or '' if it carries none. ACP's
 * `title`/`kind` are generic ("Execute command" / "execute"); the actual
 * Claude tool name ("Bash", "Read", "Edit", …) lives in
 * `_meta.claudeCode.toolName`. Returns '' (not a fallback) so a later
 * nameless streaming update never clobbers an earlier real name.
 */
function toolName(update: Record<string, unknown>): string {
  return asText(claudeMeta(update).toolName) || asText(update.title) || asText(update.kind);
}

/**
 * Build the tool input. `rawInput` is `{}` at call time and fills in over
 * streaming updates, so prefer a non-empty `rawInput`, else keep what we
 * already accumulated. Bash commands also surface via
 * `_meta.claudeCode.bashCommand` even when `rawInput` stays sparse.
 */
function toolInput(
  update: Record<string, unknown>,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  const raw = update.rawInput;
  const base: Record<string, unknown> =
    raw && typeof raw === 'object' && Object.keys(raw).length > 0
      ? { ...(raw as Record<string, unknown>) }
      : { ...(prev ?? {}) };
  // `bashCommand` is the authoritative full command (the terminal update
  // carries it even when `rawInput` is sparse / mid-stream), so it wins.
  const cmd = claudeMeta(update).bashCommand;
  if (typeof cmd === 'string' && cmd) {
    base.command = cmd;
  }
  return base;
}

/**
 * Extract a tool's output text. The terminal update carries a structured
 * `rawOutput` ({stdout, stderr, …}); fall back to ACP `content` blocks.
 */
function toolOutput(update: Record<string, unknown>): string {
  const raw = update.rawOutput;
  if (raw && typeof raw === 'object') {
    const o = raw as { stdout?: unknown; stderr?: unknown };
    const combined = [asText(o.stdout), asText(o.stderr)].filter(Boolean).join('\n');
    if (combined) return clamp(combined, MAX_SYSTEM_TEXT);
  }
  const text = extractContentText(update.content);
  if (text) return clamp(text, MAX_SYSTEM_TEXT);
  if (typeof raw === 'string') return clamp(raw, MAX_SYSTEM_TEXT);
  if (raw && typeof raw === 'object') {
    try {
      return clamp(JSON.stringify(raw), MAX_SYSTEM_TEXT);
    } catch {
      return '';
    }
  }
  return '';
}

/** Coerce an unknown to a string, treating null/undefined/objects safely. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * ACP `content` is usually `{type:'text', text}`, but tolerate a bare
 * string, an array of content parts, or a wrapper `{content: {...}}`
 * (tool_call_update content blocks nest a `{type:'content', content}`).
 */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractContentText).join('');
  }
  if (content && typeof content === 'object') {
    const o = content as { text?: unknown; content?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (o.content != null) return extractContentText(o.content);
  }
  return '';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
