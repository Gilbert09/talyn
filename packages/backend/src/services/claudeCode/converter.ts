import type { AgentEvent } from '@fastowl/shared';

/**
 * Converts Claude Managed Agents **session events** into FastOwl `AgentEvent`s
 * so the existing structured-conversation renderer (AgentConversation.tsx)
 * displays a Claude cloud run with zero UI changes.
 *
 * Unlike PostHog's ACP stream (live deltas that need coalescing), we *poll*
 * `GET /v1/sessions/{id}/events`, which returns **complete** events — so this
 * converter is stateless and maps one event → zero-or-more `AgentEvent`s.
 *
 * Event taxonomy (confirmed by the Phase 0 spike, see docs/CLOUD_PROVIDERS.md):
 *   - `agent.message`        `{content:[{type:'text',text}]}`        → assistant text
 *   - `agent.thinking`       `{content?}`                            → assistant thinking
 *   - `agent.tool_use`       `{name,input,id}`                       → assistant tool_use
 *   - `agent.mcp_tool_use`   `{name|tool_name|mcp_tool_name,input,id}` → assistant tool_use
 *   - `agent.tool_result`    `{content,is_error,tool_use_id|id}`     → user tool_result
 *   - `agent.mcp_tool_result` (same shape)                          → user tool_result
 *   - `user.message`         `{content}`                            → user text
 *   - `session.error`        `{error:{message,type}}`               → system (stderr)
 *   - `span.*`, `session.status_*`, `*.thread_status_*`             → ignored (lifecycle)
 *
 * Terminal detection (`session.status_idle` + `stop_reason.end_turn`) and PR-URL
 * extraction live in the poller — see `findPullRequestUrl` below, which it reuses.
 */

/** An AgentEvent before the streamer stamps its monotonic `seq`. */
export type AgentEventInput = Omit<AgentEvent, 'seq'>;

/** A single event from `GET /v1/sessions/{id}/events`. */
export interface ManagedAgentEvent {
  id?: string;
  type?: string;
  content?: unknown;
  /** tool_use: prebuilt tools use `name`; MCP tools use `tool_name`/`mcp_tool_name`. */
  name?: string;
  tool_name?: string;
  mcp_tool_name?: string;
  input?: unknown;
  /** tool_result: links back to its tool_use. */
  tool_use_id?: string;
  is_error?: boolean;
  /** session.error payload. */
  error?: { message?: unknown; type?: unknown } | null;
  /** session(.thread)?.status_idle terminal marker. */
  stop_reason?: { type?: unknown } | null;
  [k: string]: unknown;
}

const MAX_TEXT = 8000;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Map one Managed Agents event to zero-or-more `AgentEvent`s. */
export function managedAgentEventToAgentEvents(ev: ManagedAgentEvent): AgentEventInput[] {
  switch (ev.type) {
    case 'agent.message': {
      const text = extractContentText(ev.content);
      return text
        ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }]
        : [];
    }
    case 'agent.thinking': {
      // Some thinking events carry no surfaced content (just a marker) — skip those.
      const text = extractContentText(ev.content);
      return text
        ? [
            {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
            },
          ]
        : [];
    }
    case 'user.message': {
      const text = extractContentText(ev.content);
      return text
        ? [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }]
        : [];
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use': {
      const id = ev.id || `tool-${ev.tool_use_id ?? ''}`;
      return [toolUseEvent(id, toolName(ev), toolInput(ev.input))];
    }
    case 'agent.tool_result':
    case 'agent.mcp_tool_result': {
      const id = ev.tool_use_id || ev.id || '';
      return [toolResultEvent(id, extractContentText(ev.content), Boolean(ev.is_error))];
    }
    case 'session.error': {
      const message = asText(ev.error?.message);
      // The github MCP "no credential in vault" init error is non-fatal (the run
      // continues), so surface it as a system note, not a failure.
      return message ? [systemEvent(`error: ${message}`)] : [];
    }
    default:
      // span.model_request_start|end, session.status_*, *.thread_status_*,
      // user.interrupt — lifecycle/telemetry, not part of the conversation.
      return [];
  }
}

/** Convenience: map a whole page of polled events at once. */
export function managedAgentEventsToAgentEvents(events: ManagedAgentEvent[]): AgentEventInput[] {
  return events.flatMap(managedAgentEventToAgentEvents);
}

/**
 * Find the PR URL a run opened — it lands in the `create_pull_request`
 * `agent.mcp_tool_result` text (and is usually echoed in a later
 * `agent.message`). Scans the raw event JSON so it's robust to nesting.
 */
export function findPullRequestUrl(events: ManagedAgentEvent[]): string | null {
  for (const ev of events) {
    const matches = JSON.stringify(ev).match(PR_URL_RE);
    if (matches && matches[0]) return matches[0];
  }
  return null;
}

/** True once the session has finished its turn (the run is complete). */
export function isTerminalEvent(ev: ManagedAgentEvent): boolean {
  return ev.type === 'session.status_idle' && asText(ev.stop_reason?.type) === 'end_turn';
}

// ---------- helpers (mirrors posthogCode/acpConverter) ----------

function systemEvent(text: string): AgentEventInput {
  return { type: 'system', subtype: 'stderr', text: clamp(text, MAX_TEXT) };
}

function toolUseEvent(id: string, name: string, input: Record<string, unknown>): AgentEventInput {
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
      content: [{ type: 'tool_result', tool_use_id: id, content: clamp(content, MAX_TEXT), is_error: isError }],
    },
  };
}

function toolName(ev: ManagedAgentEvent): string {
  return asText(ev.name) || asText(ev.tool_name) || asText(ev.mcp_tool_name) || 'tool';
}

function toolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Managed Agents `content` is `[{type:'text', text}]`; tolerate a bare string,
 * a single block, or nested `{content}` wrappers.
 */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractContentText).join('');
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
