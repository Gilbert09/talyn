import type { FleetAgent } from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { getFleetAccount, type FleetAccount } from './accounts.js';
import {
  accountOverVerdict,
  accountSwitchNote,
  chooseFleetAccount,
  fleetSwitchThreshold,
  onlyAccountOptions,
  refreshAccountUsage,
  type FleetAccountVerdict,
} from './accountSelection.js';
import { getSelfHostedCredentials } from './credentials.js';

/**
 * Moving a RUNNING run to another account of the same agent, as soon as its
 * account crosses the workspace's threshold.
 *
 * Never across vendors: the model decides the vendor, and the box's egress
 * routes were built for it. With no other account free nothing happens, and
 * the exhaustion path handles a run that then hits 100%.
 *
 * The caller pushes the new credential (the fleet REPLACES the whole set, so it
 * must send everything it sends on a re-credential) and records the new account.
 */

/** How often one run is checked, at most. */
export const HOT_SWAP_CHECK_INTERVAL_MS = 60_000;

/** run key → when it was last checked. In memory: a lost entry costs one early check. */
const lastChecked = new Map<string, number>();

export function resetHotSwapChecksForTests(): void {
  lastChecked.clear();
}

/** Forget a run that has ended. */
export function forgetHotSwapRun(key: string): void {
  lastChecked.delete(key);
}

export interface HotSwapTarget {
  /** Rate-limit key: the task id or the workbench id. */
  key: string;
  workspaceId: string;
  agent: FleetAgent;
  model?: string;
  /** The account the run is on now. A run with none recorded is never swapped. */
  currentAccountId: string | null | undefined;
}

export interface HotSwapDecision {
  from: FleetAccount;
  to: FleetAccount;
  /** The new account's token for the run's vendor, already refreshed. */
  token: string;
  verdict: FleetAccountVerdict;
  /** "Switched to <to> because <from> reached N% of its <window> limit." */
  note: string;
}

/**
 * Whether this run should move now, and to which account. Null for "no":
 * checked too recently, not over, nothing to move to, or no token for it.
 */
export async function findHotSwap(
  target: HotSwapTarget,
  now: number = Date.now(),
): Promise<HotSwapDecision | null> {
  if (!target.currentAccountId) return null;
  const last = lastChecked.get(target.key);
  if (last !== undefined && now - last < HOT_SWAP_CHECK_INTERVAL_MS) return null;
  lastChecked.set(target.key, now);

  const stored = await getFleetAccount(target.currentAccountId);
  // A deleted account is the re-credential path's business, not this one's.
  if (!stored || stored.workspaceId !== target.workspaceId || stored.agent !== target.agent) {
    return null;
  }
  const current = await refreshAccountUsage(stored);
  const threshold = await fleetSwitchThreshold(target.workspaceId);
  const verdict = accountOverVerdict(current, threshold, target.model);
  if (verdict.reason === null) return null;

  const next = await chooseFleetAccount(target.workspaceId, target.agent, {
    model: target.model,
    avoidAccountIds: [current.id],
  });
  if (!next) return null;

  const creds = await getSelfHostedCredentials(
    target.workspaceId,
    onlyAccountOptions(target.agent, next.id),
  ).catch(() => null);
  const token = target.agent === 'claude' ? creds?.claudeToken : creds?.openaiKey;
  const resolvedId = target.agent === 'claude' ? creds?.claudeAccountId : creds?.codexAccountId;
  if (!token || resolvedId !== next.id) return null;

  return { from: current, to: next, token, verdict, note: accountSwitchNote(current, next, verdict) };
}

/** The debug-bus line for a swap that happened. */
export function recordHotSwap(
  workspaceId: string,
  subject: string,
  decision: Pick<HotSwapDecision, 'from' | 'to' | 'note'>,
): void {
  debugBus.recordEvent({
    service: 'fleet',
    action: 'account_hot_swap',
    summary: `${subject}: ${decision.note}`,
    workspaceId,
    meta: { fromAccountId: decision.from.id, toAccountId: decision.to.id },
  });
}

/**
 * The note for a switch that already happened somewhere else (a workbench turn
 * start): why `fromId` was left for `toId`. Null when `toId` is gone.
 */
export async function describeAccountSwitch(
  workspaceId: string,
  fromId: string,
  toId: string,
  model?: string,
): Promise<string | null> {
  const [from, to] = await Promise.all([getFleetAccount(fromId), getFleetAccount(toId)]);
  if (!to) return null;
  if (!from) return `Switched to ${to.label} because the previous account was removed.`;
  const threshold = await fleetSwitchThreshold(workspaceId);
  return accountSwitchNote(from, to, accountOverVerdict(from, threshold, model));
}
