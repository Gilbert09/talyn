import { githubService } from '../github.js';
import { mcpIntegrationSecrets } from '../mcpServers/dispatch.js';
import { resolveRunCredential } from '../selfHosted/accountSelection.js';
import type { RunCredentialsResult } from '../selfHosted/runCredentials.js';
import { providerForAgent, setWorkbenchFleetAccount, workbenchFleetAccountId } from './sandboxRuntime.js';
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
 * custody. The key is the session's CURRENT account's (`settings.fleetAccountId`),
 * chosen again only when that account was deleted or needs a reconnect.
 */
export async function resolveWorkbenchRunCredentials(host: string, sandboxId: string): Promise<RunCredentialsResult> {
  let row = await workbenchBySandboxId(sandboxId);
  if (!row) {
    const derived = /^(talyn-wb-[a-z0-9-]+?)--[0-9a-f]{6}$/.exec(sandboxId);
    if (derived) {
      const candidate = await workbenchBySandboxId(derived[1]);
      // The gateway derives bare box IDs per tenant, so require the exact recorded ID.
      if (candidate?.settings?.fleetSandboxId === sandboxId) row = candidate;
    }
  }
  if (!row) return { ok: false, reason: 'unknown_run' };
  if (!row.fleetHost || row.fleetHost !== host) return { ok: false, reason: 'wrong_host' };
  if (row.archivedAt || row.sandboxState === 'deleted') return { ok: false, reason: 'run_not_live' };

  const githubToken = await githubService.getVerifiedAccessToken(row.workspaceId);
  if (!githubToken) return { ok: false, reason: 'credentials_unavailable' };
  const openai = providerForAgent(row.agent) === 'openai';
  const recorded = workbenchFleetAccountId(row);
  const credential = await resolveRunCredential(row.workspaceId, openai ? 'codex' : 'claude', {
    recordedAccountId: recorded,
    model: row.model ?? undefined,
  });
  const agentKey = credential?.token;
  if (!agentKey) return { ok: false, reason: 'credentials_unavailable' };
  if (credential.accountId && credential.accountId !== recorded) {
    await setWorkbenchFleetAccount(row, credential.accountId).catch(() => undefined);
  }
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
