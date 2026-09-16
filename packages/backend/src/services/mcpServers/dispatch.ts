import type { Task } from '@talyn/shared';
import { workspaceMayUseMcpServers } from '../mcpServersAccess.js';
import { mcpServersForDispatch } from './store.js';

/**
 * The tool-server half of a run's credentials, keyed by server name.
 *
 * # Why this exists as a shared function
 *
 * Three paths have to agree about what a run may spend, or an adopted box
 * quietly loses capabilities: the executor's create body, the poller's
 * `recredential` push, and `runCredentials`' answer to a host's pull. The LLM
 * key already had that problem once — `recredential` sent the Claude key
 * unconditionally and re-credentialed Codex runs with a credential their route
 * table could not reach — so the tool servers get one definition rather than
 * three.
 *
 * The map's KEY is the server's name, because that is what the fleet's proxy
 * indexes an integration by. The executor's create body uses the same name for
 * the same server, which is what makes a push line up with what is already
 * there.
 */
export async function mcpIntegrationSecrets(task: {
  workspaceId: string;
  metadata: Task['metadata'];
}): Promise<Record<string, string>> {
  if (!(await workspaceMayUseMcpServers(task.workspaceId))) return {};
  const pinned = mcpServerIdsFromMetadata(task.metadata);
  const servers = await mcpServersForDispatch(task.workspaceId, pinned);
  const out: Record<string, string> = {};
  for (const s of servers) {
    // A server with NO credential contributes no entry. It still has a route
    // and still works — several MCP servers need no key at all — and an empty
    // string here would be a credential the proxy attaches.
    if (s.secret) out[s.name] = s.secret;
  }
  return out;
}

/**
 * Which tool servers a task pinned, or null to inherit the workspace's set.
 *
 * Absent means inherit — what every task written before the field said. An
 * empty array means this run wants none, which is a choice and not the same
 * statement. Anything that is not an array of strings reads as absent rather
 * than being trusted: the value comes out of a jsonb column, and an older shape
 * left there must not decide what a run can reach.
 */
export function mcpServerIdsFromMetadata(metadata: Task['metadata']): string[] | null {
  const v = (metadata as Record<string, unknown> | null)?.mcpServerIds;
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}
