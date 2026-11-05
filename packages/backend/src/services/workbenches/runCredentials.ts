import { WorkbenchError } from './errors.js';
import { fleetPinnedEndpoint } from '../selfHosted/credentials.js';
import type { RunCredentialsResult } from '../selfHosted/runCredentials.js';
import { fleetClientFor, sandboxCredentialSet, setWorkbenchFleetAccount, workbenchFleetAccountId } from './sandboxRuntime.js';
import { recordWorkbenchFleetHost, workbenchForCredentials, type WorkbenchRow } from './store.js';

/** Every workbench sandbox id starts with this (`sandboxIdFor`). */
export const WORKBENCH_SANDBOX_PREFIX = 'talyn-wb-';

/** Return both usable vendor keys only to the host that owns this live session box. */
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

  try {
    const { creds, credentials } = await sandboxCredentialSet(row);
    for (const agent of ['claude', 'codex'] as const) {
      const credential = credentials[agent];
      if (credential?.accountId && credential.accountId !== workbenchFleetAccountId(row, agent)) {
        await setWorkbenchFleetAccount(row, credential.accountId, agent).catch(() => undefined);
      }
    }
    return { ok: true, credentials: creds };
  } catch (error) {
    if (error instanceof WorkbenchError && error.code === 'credentials_unavailable') {
      return { ok: false, reason: 'credentials_unavailable' };
    }
    throw error;
  }
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
