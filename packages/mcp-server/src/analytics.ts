import { PostHog } from 'posthog-node';
import type { UserIdentity } from '@posthog/mcp';

/**
 * PostHog MCP analytics for the Talyn MCP server, via the official
 * `@posthog/mcp` SDK (`instrument(server, posthog)` in index.ts). The SDK
 * auto-captures the standardized `$mcp_*` events (tool calls, tool listings,
 * initialize, exceptions) that PostHog's MCP-analytics product reads — the
 * previous hand-rolled `mcp_tool_called` event never fed those surfaces.
 *
 * Events go to the Talyn (FastOwl) PostHog project by default (a project
 * write key is public by design — same practice as any client SDK snippet).
 * Overrides / opt-out:
 *   - TALYN_POSTHOG_KEY  (falls back to POSTHOG_API_KEY)  — different project
 *   - TALYN_POSTHOG_HOST (falls back to POSTHOG_HOST)     — different host
 *   - TALYN_ANALYTICS_DISABLED=1                          — turn it off
 *
 * Privacy note: tool ARGUMENTS are captured by the SDK's `$mcp_tool_call`
 * events; Talyn's tools take ids/prompts the user already sends to Talyn's
 * own backend, so there is no third-party data leak — but keep this in mind
 * when adding tools with sensitive inputs.
 */

// Talyn's "FastOwl" PostHog project (id 459813) — set up via
// `npx @posthog/wizard mcp-analytics --project-id=459813`.
const DEFAULT_KEY = 'phc_n7cmPaZ8BZkgnBV9seBGqaJTtcjd9NYbKTUhcLXTohwX';
const DEFAULT_HOST = 'https://us.i.posthog.com';

function disabled(): boolean {
  const flag = (process.env.TALYN_ANALYTICS_DISABLED ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

/**
 * Build the posthog-node client `instrument()` consumes, or null when
 * analytics is disabled. Fully defensive — a bad env shape degrades to off,
 * never takes the MCP server down.
 */
export function createAnalyticsClient(): PostHog | null {
  if (disabled()) return null;
  const key = (process.env.TALYN_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY ?? DEFAULT_KEY).trim();
  if (!key) return null;
  const host = (process.env.TALYN_POSTHOG_HOST ?? process.env.POSTHOG_HOST ?? DEFAULT_HOST).trim();
  try {
    // flushAt:1 sends each event promptly — this is a low-volume stdio server,
    // and prompt delivery means events survive the child process being killed
    // before the shutdown flush runs.
    return new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  } catch {
    return null;
  }
}

/**
 * Who the MCP session belongs to: the task it serves, else its workspace.
 * Static identity passed to `instrument({ identify })` — every `$mcp_*`
 * event carries this `distinct_id`.
 */
export function analyticsIdentity(): UserIdentity {
  const workspaceId = process.env.TALYN_WORKSPACE_ID;
  const taskId = process.env.TALYN_TASK_ID;
  return {
    distinctId: taskId ?? workspaceId ?? 'mcp-anonymous',
    properties: {
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    },
  };
}
