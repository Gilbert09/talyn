import { guardCrossReplica } from '../advisoryLock.js';
import {
  getFleetAccountWithCredential,
  setFleetAccountUsage,
  type FleetAccount,
  type FleetAccountUsage,
  type StoredClaudeOAuth,
  type StoredCodexOAuth,
} from './accounts.js';
import { resolveClaudeAccessToken } from './claudeOauth.js';
import { resolveCodexAccessToken } from './codexOauth.js';
import { claudeStore } from './credentials.js';
import { fetchClaudeUsage, fetchCodexUsage, refreshOnce, usageIsStale } from './usage.js';

/** Refresh one OAuth account. A contended lock leaves its current snapshot in place. */
export async function refreshFleetAccountUsage(
  account: FleetAccount,
  maxAgeMs = 60_000,
  force = false,
): Promise<FleetAccountUsage | null> {
  if (account.kind !== 'claude_oauth' && account.kind !== 'codex_oauth') return account.usage;
  if (!force && !usageIsStale(account.usage, maxAgeMs)) return account.usage;

  return refreshOnce(`fleet-usage:${account.id}`, async () => {
    const outcome = await guardCrossReplica(`fleet-usage:${account.id}`, async () => {
      const current = await getFleetAccountWithCredential(account.id);
      if (!current) return null;
      if (!force && !usageIsStale(current.usage, maxAgeMs)) return current.usage;
      const fetchedAt = new Date().toISOString();
      let result;
      try {
        if (current.kind === 'claude_oauth') {
          const stored = current.credential as StoredClaudeOAuth;
          const token = await resolveClaudeAccessToken(
            current.id,
            { ...stored, ...(current.reauthRequiredAt ? { reauthRequiredAt: current.reauthRequiredAt } : {}) },
            claudeStore,
          );
          result = token ? await fetchClaudeUsage(token) : { ok: false as const, error: 'reconnect required' };
        } else {
          const stored = current.credential as StoredCodexOAuth;
          const token = await resolveCodexAccessToken(current.id, {
            ...stored,
            ...(current.reauthRequiredAt ? { reauthRequiredAt: current.reauthRequiredAt } : {}),
          });
          result = token
            ? await fetchCodexUsage(token.accessToken, token.accountId)
            : { ok: false as const, error: 'reconnect required' };
        }
      } catch {
        result = { ok: false as const, error: 'usage is unavailable' };
      }
      const usage: FleetAccountUsage = result.ok
        ? { fetchedAt, windows: result.windows }
        : { fetchedAt, error: result.error };
      await setFleetAccountUsage(current.id, usage);
      return usage;
    }, { maxHoldMs: 15_000 });
    return outcome.acquired ? (outcome.result ?? null) : account.usage;
  });
}
