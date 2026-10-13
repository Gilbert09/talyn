import { githubService } from '../github.js';
import { mcpIntegrationSecrets } from '../mcpServers/dispatch.js';
import { getSelfHostedCredentials } from '../selfHosted/credentials.js';
import type { RunCredentialsResult } from '../selfHosted/runCredentials.js';
import { providerForAgent } from './sandboxRuntime.js';
import { workbenchBySandboxId } from './store.js';

/** Every workbench sandbox id starts with this (`sandboxIdFor`). */
export const WORKBENCH_SANDBOX_PREFIX = 'talyn-wb-';

/**
 * A restarted fleet host asking for a WORKBENCH box's credentials back.
 *
 * The task path's rules, unchanged: only for a box this backend created, only
 * to the host it was created on, only while it is still in use, and only the
 * key for the vendor the box is wired to. No credential is a refusal, never an
 * answer with the key left out — the gateway would fill the gap from its own
 * custody.
 */
export async function resolveWorkbenchRunCredentials(host: string, sandboxId: string): Promise<RunCredentialsResult> {
  const row = await workbenchBySandboxId(sandboxId);
  if (!row) return { ok: false, reason: 'unknown_run' };
  if (!row.fleetHost || row.fleetHost !== host) return { ok: false, reason: 'wrong_host' };
  if (row.archivedAt || row.sandboxState === 'deleted') return { ok: false, reason: 'run_not_live' };

  const githubToken = await githubService.getVerifiedAccessToken(row.workspaceId);
  if (!githubToken) return { ok: false, reason: 'credentials_unavailable' };
  const creds = await getSelfHostedCredentials(row.workspaceId);
  const openai = providerForAgent(row.agent) === 'openai';
  const agentKey = openai ? creds?.openaiKey : creds?.claudeToken;
  if (!agentKey) return { ok: false, reason: 'credentials_unavailable' };
  const integrations = await mcpIntegrationSecrets({ workspaceId: row.workspaceId, metadata: undefined });
  return {
    ok: true,
    credentials: {
      githubToken,
      ...(openai ? { openaiKey: agentKey } : { anthropicKey: agentKey }),
      repo: row.repoFullName,
      ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
    },
  };
}
