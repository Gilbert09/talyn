import { resolveSandboxCredentials } from '../selfHosted/sandboxRun.js';

/** Quota holds expire. A box needs routes for every agent with a valid account. */
export function resolveBoxCredentials(workspaceId: string) {
  return resolveSandboxCredentials(workspaceId, {
    accountFilter: (account) => !account.reauthRequiredAt,
  });
}
