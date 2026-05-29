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

const MAX_SYSTEM_TEXT = 8000;

export class AcpConverter {
  private active: ActiveStream | null = null;
  private msgCounter = 0;

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

  /** Finalise any in-flight streaming block. Call at end-of-stream. */
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
        const out = this.flush();
        const id = asText(update.toolCallId) || `tool-${this.msgCounter++}`;
        const name = asText(update.title) || asText(update.kind) || 'tool';
        out.push({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id, name, input: update.rawInput ?? {} }],
          },
        });
        return out;
      }
      case 'tool_call_update': {
        const status = asText(update.status);
        // Only the terminal update carries output worth rendering;
        // intermediate "in_progress" updates are noise.
        if (status && status !== 'completed' && status !== 'failed' && status !== 'error') {
          return [];
        }
        const id = asText(update.toolCallId);
        if (!id) return [];
        const content = stringifyToolOutput(update.rawOutput ?? update.content);
        return [
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content,
                  is_error: status === 'failed' || status === 'error',
                },
              ],
            },
          },
        ];
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

/** Coerce an unknown to a string, treating null/undefined/objects safely. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * ACP `content` is usually `{type:'text', text}`, but tolerate a bare
 * string or an array of content parts.
 */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractContentText).join('');
  }
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function stringifyToolOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return clamp(value, MAX_SYSTEM_TEXT);
  const text = extractContentText(value);
  if (text) return clamp(text, MAX_SYSTEM_TEXT);
  try {
    return clamp(JSON.stringify(value), MAX_SYSTEM_TEXT);
  } catch {
    return '';
  }
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
