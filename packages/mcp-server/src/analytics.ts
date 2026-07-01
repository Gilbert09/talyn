import { PostHog } from 'posthog-node';

/**
 * PostHog product-analytics for the MCP server. We capture ONE event per tool
 * call — `mcp_tool_called` with the tool name, whether it succeeded, and how
 * long it took — so we can see which tools child Claudes actually use and how
 * often they fail.
 *
 * Config is env-driven and OPTIONAL: with no key the whole module is an inert
 * no-op, so the MCP server runs identically for anyone who hasn't opted in. The
 * target project is deliberately NOT the app's connected PostHog — set it
 * explicitly:
 *   - TALYN_POSTHOG_KEY   (falls back to POSTHOG_API_KEY) — project write key
 *   - TALYN_POSTHOG_HOST  (falls back to POSTHOG_HOST)    — defaults to US cloud
 *
 * Privacy: metadata only. We never send tool arguments, prompts, or response
 * bodies — the same discipline as the backend's debug bus. Error messages are
 * truncated defensively.
 */

const MCP_SERVER_NAME = 'talyn';
const MCP_SERVER_VERSION = '0.1.0';
const DEFAULT_HOST = 'https://us.i.posthog.com';
const MAX_ERROR_CHARS = 200;

// `undefined` = not yet resolved; `null` = resolved-but-disabled (no key). This
// three-state cache means we build the client at most once and, when unset,
// never re-read the env on every call.
let client: PostHog | null | undefined;

function resolveClient(): PostHog | null {
  if (client !== undefined) return client;
  const key = (process.env.TALYN_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY ?? '').trim();
  if (!key) {
    client = null;
    return client;
  }
  const host = (process.env.TALYN_POSTHOG_HOST ?? process.env.POSTHOG_HOST ?? DEFAULT_HOST).trim();
  try {
    // flushAt:1 sends each event promptly — this is a low-volume stdio server,
    // not a hot request path, and prompt delivery means we don't lose events if
    // the child process is killed before the shutdown flush runs.
    client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  } catch {
    // A bad key/host shape must never take the MCP server down — degrade to off.
    client = null;
  }
  return client;
}

/** The entity a tool call is attributed to — the task, else its workspace. */
function distinctId(): string {
  return (
    process.env.TALYN_TASK_ID ??
    process.env.TALYN_WORKSPACE_ID ??
    'mcp-anonymous'
  );
}

/**
 * Record one MCP tool invocation. Fire-and-forget and fully defensive: any
 * failure here is swallowed so analytics can never break a tool call.
 */
export function captureToolCall(input: {
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}): void {
  try {
    const ph = resolveClient();
    if (!ph) return;
    const workspaceId = process.env.TALYN_WORKSPACE_ID;
    const taskId = process.env.TALYN_TASK_ID;
    ph.capture({
      distinctId: distinctId(),
      event: 'mcp_tool_called',
      properties: {
        tool: input.tool,
        ok: input.ok,
        duration_ms: input.durationMs,
        ...(input.error ? { error: input.error.slice(0, MAX_ERROR_CHARS) } : {}),
        workspace_id: workspaceId,
        task_id: taskId,
        mcp_server: MCP_SERVER_NAME,
        mcp_server_version: MCP_SERVER_VERSION,
      },
    });
  } catch {
    // never throw from analytics
  }
}

/** Flush and close the client on shutdown so buffered events aren't lost. */
export async function shutdownAnalytics(): Promise<void> {
  const ph = client;
  client = undefined;
  if (ph) await ph.shutdown().catch(() => undefined);
}

/** Test helper — drop the cached client so env changes take effect. */
export function _resetAnalytics(): void {
  client = undefined;
}
