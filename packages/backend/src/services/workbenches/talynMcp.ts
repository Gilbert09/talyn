import { validateMcpServer } from '@talyn/shared';
import { mcpIntegrationSecrets } from '../mcpServers/dispatch.js';
import type { FleetMcpServerInline } from '../selfHosted/client.js';
import { ensureSessionMcpToken, readSessionMcpToken } from '../sessionMcpToken.js';

/**
 * Talyn's own MCP server, given to every SESSION sandbox as the server named
 * `talyn`, authenticated as the session's owner with a token bound to that
 * session (`sessionMcpToken.ts`).
 *
 * The same rule as a workspace's MCP servers: Talyn holds the credential, the
 * guest gets a plain proxy URL, and the host's proxy attaches the token per
 * request. So the token has to reach the fleet on all three paths — the create
 * body, the per-turn credential push, and the answer to a restarted host's pull
 * — and `workbenchIntegrationSecrets` is the one definition the last two share.
 * Cloud TASKS do not get it: only a session has a token bound to it.
 */
export const TALYN_MCP_SERVER_NAME = 'talyn';

const MCP_PATH = '/api/v1/mcp';

/**
 * The backend's public MCP endpoint, or null when this deployment cannot say.
 *
 * The backend has no general public-URL setting. `TALYN_PUBLIC_API_URL` states
 * it; otherwise it is read from the backend's own OAuth callbacks, which are
 * full public URLs under `/api/v1/` (`POSTHOG_OAUTH_REDIRECT_URI`,
 * `SLACK_OAUTH_REDIRECT_URI`). The sandbox reaches it through the fleet's
 * proxy, so it must be https on a public host — the same rules the fleet puts
 * on any MCP server, checked by the shared validator. Local development has no
 * such URL, and its sessions simply go without Talyn's tools.
 */
export function talynMcpPublicUrl(): string | null {
  const explicit = (process.env.TALYN_PUBLIC_API_URL ?? '').trim();
  const candidates = explicit
    ? [{ raw: explicit, fromCallback: false }]
    : ['POSTHOG_OAUTH_REDIRECT_URI', 'SLACK_OAUTH_REDIRECT_URI'].map((name) => ({
        raw: (process.env[name] ?? '').trim(),
        fromCallback: true,
      }));
  for (const { raw, fromCallback } of candidates) {
    if (!raw) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (fromCallback && !parsed.pathname.startsWith('/api/v1/')) continue;
    if (parsed.protocol !== 'https:') continue;
    const url = `${parsed.origin}${MCP_PATH}`;
    try {
      validateMcpServer({ name: TALYN_MCP_SERVER_NAME, url, authKind: 'bearer' });
    } catch {
      continue;
    }
    return url;
  }
  return null;
}

/**
 * What a session's box needs to reach Talyn's MCP server, or null when it
 * cannot. Only a box CREATE mints the token. A credential push or pull reads
 * it, so a box made before the session had one gets no `talyn` secret for a
 * route it does not have, and a later box (restore, move) gets both.
 */
async function talynMcpFor(
  session: { id: string; workspaceId: string },
  opts: { mint: boolean }
): Promise<{ url: string; token: string } | null> {
  const url = talynMcpPublicUrl();
  if (!url) return null;
  try {
    const token = opts.mint ? await ensureSessionMcpToken(session) : await readSessionMcpToken(session.id);
    return token ? { url, token } : null;
  } catch (err) {
    // A session without Talyn's tools is a smaller session; one that failed to
    // start because a token could not be minted is a broken one.
    console.warn(
      `[workbench] Talyn MCP token for ${session.id} unavailable:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** The `talyn` server for a session's create body. */
export async function talynMcpServerFor(session: {
  id: string;
  workspaceId: string;
}): Promise<FleetMcpServerInline | null> {
  const talyn = await talynMcpFor(session, { mint: true });
  if (!talyn) return null;
  return {
    name: TALYN_MCP_SERVER_NAME,
    url: talyn.url,
    transport: 'http',
    description:
      "Talyn, the app this session runs in: sessions (start, message, archive), the merge queue, pull requests and tasks, as the session's owner.",
    secret: talyn.token,
    inject: { kind: 'bearer' },
  };
}

/**
 * The credential half of a session box's MCP servers, keyed by name: the
 * workspace's servers plus `talyn`. When Talyn's own is given it wins a name
 * clash, so a workspace server somebody named `talyn` is left out of that
 * session (the create body drops it the same way).
 */
export async function workbenchIntegrationSecrets(session: {
  id: string;
  workspaceId: string;
}): Promise<Record<string, string>> {
  const out = { ...(await mcpIntegrationSecrets({ workspaceId: session.workspaceId, metadata: undefined })) };
  const talyn = await talynMcpFor(session, { mint: false });
  if (talyn) out[TALYN_MCP_SERVER_NAME] = talyn.token;
  return out;
}

/** Whether this session's box was given Talyn's server: the turn prompt says so only then. */
export async function sessionHasTalynMcp(session: { id: string; workspaceId: string }): Promise<boolean> {
  return (await talynMcpFor(session, { mint: false })) !== null;
}
