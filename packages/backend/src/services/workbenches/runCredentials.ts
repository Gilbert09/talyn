import { githubService } from '../github.js';
import { resolveRunCredential } from '../selfHosted/accountSelection.js';
import { fleetPinnedEndpoint } from '../selfHosted/credentials.js';
import type { RunCredentialsResult } from '../selfHosted/runCredentials.js';
import { fleetClientFor, providerForAgent, setWorkbenchFleetAccount, workbenchFleetAccountId } from './sandboxRuntime.js';
import { recordWorkbenchFleetHost, workbenchForCredentials, type WorkbenchRow } from './store.js';
import { workbenchIntegrationSecrets } from './talynMcp.js';

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
  const row = await workbenchForCredentials(sandboxId);
  if (!row) return { ok: false, reason: 'unknown_run' };
  const moving = row.status === 'moving';
  const settings = row.settings as Record<string, unknown>;
  const target = moving && (settings.moveSandboxId === sandboxId || settings.moveFleetSandboxId === sandboxId);
  const expectedHost = target ? settings.moveTargetHost : row.fleetHost;
  if (!expectedHost || expectedHost !== host) {
    if (target || !(await gatewayPlacesBoxOn(row, sandboxId, host))) return { ok: false, reason: 'wrong_host' };
    await recordWorkbenchFleetHost(row.id, row.sandboxId!, host);
  }
  // Archive saves and live restores still need the current box's credential proxy.
  if ((!target && row.sandboxState === 'deleted')
    || (row.archivedAt && !row.archivePendingAt && !moving && !row.restoreRequestedAt)) {
    return { ok: false, reason: 'run_not_live' };
  }

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
  const integrations = await workbenchIntegrationSecrets(row);
  return {
    ok: true,
    credentials: {
      githubToken,
      ...(openai ? { openaiKey: agentKey } : { anthropicKey: agentKey }),
      // A thread names no repository.
      ...(row.repoFullName ? { repo: row.repoFullName } : {}),
      ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
    },
  };
}

/**
 * Whether the gateway places this box on `host` now.
 *
 * The fleet moves a sleeping box to another host when its own host is too full
 * to wake it, and the new host asks for credentials while it wakes the box,
 * before any answer reaches us. The gateway's index is the authority on where
 * a box lives, so the bound becomes "the host the gateway names" rather than
 * "the host we recorded". Only through a gateway: a host answering directly
 * names no host, and nothing moves a box without one.
 */
async function gatewayPlacesBoxOn(row: WorkbenchRow, sandboxId: string, host: string): Promise<boolean> {
  if (!fleetPinnedEndpoint() || !row.sandboxId) return false;
  try {
    const client = await fleetClientFor(row.workspaceId);
    return (await client.sandboxHost(sandboxId)) === host;
  } catch {
    return false;
  }
}
