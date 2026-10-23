import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_FLEET_SWITCH_AT_PERCENT,
  FLEET_MODELS,
  normaliseFleetSwitchAtPercent,
  type FleetAgent,
} from '@talyn/shared';
import { getDbClient, getPoolDbClient, isRealPostgres } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { tryWithAdvisoryLock } from '../advisoryLock.js';
import {
  getFleetAccount,
  getFleetAccountWithCredential,
  listFleetAccounts,
  orderFleetAccounts,
  setFleetAccountUsage,
  type FleetAccount,
  type FleetAccountFilter,
  type FleetAccountUsage,
  type FleetUsageWindow,
  type StoredClaudeOAuth,
  type StoredCodexOAuth,
} from './accounts.js';
import { resolveClaudeAccessToken, type ClaudeCredentialStore } from './claudeOauth.js';
import { resolveCodexAccessToken } from './codexOauth.js';
import {
  claudeStore,
  getSelfHostedCredentials,
  type SelfHostedCredentialOptions,
} from './credentials.js';
import { isHeldBack } from './exhaustedQuota.js';
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  isOverThreshold,
  refreshOnce,
  usageIsStale,
  type UsageFetchResult,
} from './usage.js';

/**
 * Choosing WHICH of an agent's accounts a run uses.
 *
 * An account is OVER when any usage window that applies to the run is at or past
 * the workspace's threshold, when a confirmed exhaustion still holds it, or when
 * its grant needs a reconnect. The first account in priority order that is not
 * over is the one to use. Unknown usage is not over: a vendor endpoint that
 * changed shape must never park a working account.
 *
 * Every account of an agent over is NOT handled here. The caller then runs the
 * cross-vendor rules it always had (the other agent, then quotaFailover's chain).
 */

/** How old a usage snapshot may be before a dispatch, turn or hot-swap check reads it again. */
export const USAGE_MAX_AGE_MS = 2 * 60_000;

/** The fetch the usage readers use. Tests replace it. */
type FetchImpl = typeof fetch;
let usageFetch: FetchImpl | undefined;
export function setUsageFetchForTests(fn: FetchImpl | undefined): void {
  usageFetch = fn;
}

export type FleetAccountOverReason = 'usage' | 'held' | 'reauth';

export interface FleetAccountVerdict {
  reason: FleetAccountOverReason | null;
  /** For `usage`: the window that put it over (the fullest one). */
  window?: FleetUsageWindow;
}

/** The workspace's switch threshold in percent, or the default when unset or invalid. */
export async function fleetSwitchThreshold(workspaceId: string): Promise<number> {
  const [row] = await getDbClient()
    .select({ value: sql<unknown>`${workspacesTable.settings} -> 'fleetSwitchAtPercent'` })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const parsed = normaliseFleetSwitchAtPercent(row?.value);
  return parsed.ok ? parsed.value : DEFAULT_FLEET_SWITCH_AT_PERCENT;
}

/**
 * The text a model-scoped window is matched against: the id and its catalogue
 * label, so a scope named "Opus" matches `claude-opus-5-5` and "Opus 5.5".
 */
export function modelMatchText(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const label = FLEET_MODELS.find((m) => m.id === model)?.label;
  return label ? `${model} ${label}` : model;
}

/** Why an account is over for this run, or `reason: null` when it is usable. Pure. */
export function accountOverVerdict(
  account: Pick<FleetAccount, 'reauthRequiredAt' | 'quotaExhausted' | 'usage'>,
  threshold: number,
  model?: string,
  now: Date = new Date(),
): FleetAccountVerdict {
  if (account.reauthRequiredAt) return { reason: 'reauth' };
  if (account.quotaExhausted && isHeldBack(account.quotaExhausted, now)) return { reason: 'held' };
  const usage = account.usage;
  if (!usage || !('windows' in usage)) return { reason: null };
  const text = modelMatchText(model);
  let fullest: FleetUsageWindow | undefined;
  for (const w of usage.windows) {
    if (!isOverThreshold([w], threshold, text)) continue;
    if (!fullest || w.usedPercent > fullest.usedPercent) fullest = w;
  }
  return fullest ? { reason: 'usage', window: fullest } : { reason: null };
}

function readsUsage(account: FleetAccount): boolean {
  return (account.kind === 'claude_oauth' || account.kind === 'codex_oauth') && !account.reauthRequiredAt;
}

// ---------------------------------------------------------------------------
// Reading usage
// ---------------------------------------------------------------------------

/**
 * A Claude store whose read says the token has expired, so the resolver
 * refreshes it now. For a 401 from the usage endpoint: the stored expiry said
 * the token was good and the vendor disagreed. The refresh still runs under the
 * resolver's own lock and writes through the real store.
 */
const forcedRefreshStore: ClaudeCredentialStore = {
  read: async (accountId) => {
    const stored = await claudeStore.read(accountId);
    return stored ? { ...stored, expiresAt: new Date(0).toISOString() } : stored;
  },
  patch: (accountId, next) => claudeStore.patch(accountId, next),
};

/** Read one account's usage from its vendor. Null = nothing could be asked (no token). */
async function readVendorUsage(accountId: string): Promise<FleetAccountUsage | null> {
  const account = await getFleetAccountWithCredential(accountId);
  if (!account || account.reauthRequiredAt) return null;
  const fetchImpl = usageFetch ?? fetch;
  let result: UsageFetchResult;
  try {
    if (account.kind === 'claude_oauth') {
      const stored = account.credential as StoredClaudeOAuth;
      const token = await resolveClaudeAccessToken(account.id, stored, claudeStore);
      if (!token) return null;
      result = await fetchClaudeUsage(token, fetchImpl);
      if (!result.ok && result.tokenExpired) {
        const forced = await resolveClaudeAccessToken(
          account.id,
          { ...stored, expiresAt: new Date(0).toISOString() },
          forcedRefreshStore,
        );
        if (forced) result = await fetchClaudeUsage(forced, fetchImpl);
      }
    } else if (account.kind === 'codex_oauth') {
      const stored = account.credential as StoredCodexOAuth;
      const resolved = await resolveCodexAccessToken(account.id, stored);
      if (!resolved) return null;
      result = await fetchCodexUsage(resolved.accessToken, resolved.accountId, fetchImpl);
      if (!result.ok && result.tokenExpired) {
        // The Codex resolver cannot be told to refresh early, so a retry only
        // helps when another instance has rotated the token meanwhile.
        const reread = await getFleetAccountWithCredential(account.id);
        const again = reread
          ? await resolveCodexAccessToken(account.id, reread.credential as StoredCodexOAuth)
          : null;
        if (again && again.accessToken !== resolved.accessToken) {
          result = await fetchCodexUsage(again.accessToken, again.accountId, fetchImpl);
        }
      }
    } else {
      return null;
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const fetchedAt = new Date().toISOString();
  return result.ok ? { fetchedAt, windows: result.windows } : { fetchedAt, error: result.error };
}

/**
 * Read and store one account's usage under a NON-blocking lock. Null when the
 * lock was taken by another instance or nothing could be read: the caller then
 * keeps the snapshot it has.
 */
async function refreshUsageLocked(accountId: string, maxAgeMs: number): Promise<FleetAccountUsage | null> {
  const run = async (): Promise<FleetAccountUsage | null> => {
    // Re-read inside the lock: the instance that held it may just have stored one.
    const fresh = await getFleetAccount(accountId);
    if (!fresh) return null;
    if (!usageIsStale(fresh.usage, maxAgeMs)) return fresh.usage;
    const usage = await readVendorUsage(accountId);
    if (!usage) return null;
    await setFleetAccountUsage(accountId, usage);
    return usage;
  };
  // pglite is one connection whose transaction() takes an exclusive mutex, and
  // `run` queries through it, so the lock would self-deadlock there.
  if (!isRealPostgres()) return run();
  const outcome = await tryWithAdvisoryLock(getPoolDbClient(), `fleet-usage:${accountId}`, run, {
    maxHoldMs: 60_000,
  });
  return outcome.acquired ? (outcome.result ?? null) : null;
}

/**
 * The account with a fresh usage snapshot, when its snapshot was stale and it
 * is a subscription. Never throws: a failed read keeps the snapshot it had.
 */
export async function refreshAccountUsage(
  account: FleetAccount,
  maxAgeMs: number = USAGE_MAX_AGE_MS,
): Promise<FleetAccount> {
  if (!readsUsage(account) || !usageIsStale(account.usage, maxAgeMs)) return account;
  try {
    const usage = await refreshOnce(`fleet-usage:${account.id}`, () =>
      refreshUsageLocked(account.id, maxAgeMs),
    );
    return usage ? { ...account, usage } : account;
  } catch (err) {
    console.warn(
      `[fleet] reading usage for account ${account.id.slice(0, 8)} failed:`,
      err instanceof Error ? err.message : err,
    );
    return account;
  }
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

export interface ChooseFleetAccountOptions {
  /** The run's model. Decides whether a model-scoped window applies. */
  model?: string;
  /** Accounts already tried on this run. Never chosen. */
  avoidAccountIds?: readonly string[];
  /** Tried before the others, when it is not over. */
  preferAccountId?: string;
  /** Read stale usage from the vendor first. Default true. */
  refresh?: boolean;
}

export interface FleetAccountSelection {
  /** The first account, in priority order, that is not over and not avoided. */
  account: FleetAccount | null;
  /**
   * When `account` is null: the account to run on anyway if nothing else can,
   * which is one over only by usage or only by being avoided. Never one that is
   * held or needs reauth.
   */
  fallback: FleetAccount | null;
  threshold: number;
  /** Every account of the agent, with whatever usage was just read. */
  accounts: FleetAccount[];
  verdicts: Map<string, FleetAccountVerdict>;
}

/**
 * Walk an agent's accounts in priority order and stop at the first usable one.
 * Usage is read only for the accounts walked, so a workspace whose first
 * account is fine pays for one read at most.
 */
export async function selectFleetAccount(
  workspaceId: string,
  agent: FleetAgent,
  opts: ChooseFleetAccountOptions = {},
): Promise<FleetAccountSelection> {
  const threshold = await fleetSwitchThreshold(workspaceId);
  const listed = await listFleetAccounts(workspaceId, agent);
  const ordered = orderFleetAccounts(listed, { preferId: opts.preferAccountId });
  const avoid = new Set(opts.avoidAccountIds ?? []);
  const verdicts = new Map<string, FleetAccountVerdict>();
  const accounts: FleetAccount[] = [];
  let chosen: FleetAccount | null = null;

  for (const original of ordered) {
    let account = original;
    if (!chosen && !avoid.has(account.id) && opts.refresh !== false) {
      account = await refreshAccountUsage(account);
    }
    accounts.push(account);
    const verdict = accountOverVerdict(account, threshold, opts.model);
    verdicts.set(account.id, verdict);
    if (!chosen && !avoid.has(account.id) && verdict.reason === null) chosen = account;
  }

  let fallback: FleetAccount | null = null;
  if (!chosen) {
    fallback =
      accounts.find((a) => !avoid.has(a.id) && verdicts.get(a.id)?.reason === 'usage') ??
      accounts.find((a) => {
        const reason = verdicts.get(a.id)?.reason ?? null;
        return avoid.has(a.id) && (reason === null || reason === 'usage');
      }) ??
      null;
  }
  return { account: chosen, fallback, threshold, accounts, verdicts };
}

/** The account a run of `agent` should use, or null when every one is over. */
export async function chooseFleetAccount(
  workspaceId: string,
  agent: FleetAgent,
  opts: ChooseFleetAccountOptions = {},
): Promise<FleetAccount | null> {
  return (await selectFleetAccount(workspaceId, agent, opts)).account;
}

/**
 * The options that make `getSelfHostedCredentials` resolve `accountId` for
 * `agent`, falling through only to that agent's other accounts that are not
 * over (by their stored snapshot) and not avoided. The other agent is left
 * alone: its key is suppressed on the run anyway.
 */
export function credentialOptionsFor(
  agent: FleetAgent,
  accountId: string,
  opts: { threshold: number; model?: string; avoidAccountIds?: readonly string[] },
): SelfHostedCredentialOptions {
  const avoid = new Set(opts.avoidAccountIds ?? []);
  const accountFilter: FleetAccountFilter = (a) =>
    a.agent !== agent ||
    a.id === accountId ||
    (!avoid.has(a.id) && accountOverVerdict(a, opts.threshold, opts.model).reason === null);
  return agent === 'claude'
    ? { claudeAccountId: accountId, accountFilter }
    : { codexAccountId: accountId, accountFilter };
}

/** Only this one account for `agent`. */
export function onlyAccountOptions(agent: FleetAgent, accountId: string): SelfHostedCredentialOptions {
  const accountFilter: FleetAccountFilter = (a) => a.agent !== agent || a.id === accountId;
  return agent === 'claude'
    ? { claudeAccountId: accountId, accountFilter }
    : { codexAccountId: accountId, accountFilter };
}

export interface AgentCredential {
  token: string;
  /** Absent only when the resolver named no account. */
  accountId?: string;
}

function agentCredentialFrom(
  agent: FleetAgent,
  creds: Awaited<ReturnType<typeof getSelfHostedCredentials>>,
): AgentCredential | null {
  if (!creds) return null;
  const token = agent === 'claude' ? creds.claudeToken : creds.openaiKey;
  const accountId = agent === 'claude' ? creds.claudeAccountId : creds.codexAccountId;
  if (!token) return null;
  return accountId ? { token, accountId } : { token };
}

/**
 * The credential for a RUN that is already going: its recorded account while
 * that still exists and needs no reconnect, else a fresh choice.
 *
 * `switchWhenOver` also moves off a recorded account that is over by usage or
 * held, when another account is not. That is the rule at a workbench turn start.
 * The host pull and the adoption push leave it off: they give back what the run
 * was holding, and the hot-swap check is what moves a run.
 */
export async function resolveRunCredential(
  workspaceId: string,
  agent: FleetAgent,
  opts: { recordedAccountId?: string | null; model?: string; switchWhenOver?: boolean; avoidAccountIds?: readonly string[] } = {},
): Promise<AgentCredential | null> {
  const recorded = opts.recordedAccountId ? await getFleetAccount(opts.recordedAccountId) : null;
  const recordedLive =
    recorded && recorded.workspaceId === workspaceId && recorded.agent === agent && !recorded.reauthRequiredAt
      ? recorded
      : null;

  if (recordedLive && !opts.switchWhenOver && !opts.avoidAccountIds?.includes(recordedLive.id)) {
    const own = agentCredentialFrom(
      agent,
      await getSelfHostedCredentials(workspaceId, onlyAccountOptions(agent, recordedLive.id)),
    );
    if (own) return own;
  }

  const selection = await selectFleetAccount(workspaceId, agent, {
    model: opts.model,
    avoidAccountIds: opts.avoidAccountIds,
    ...(recordedLive ? { preferAccountId: recordedLive.id } : {}),
  });
  // All over: a recorded account that is merely over stays, rather than moving
  // a running run onto an account that is just as full.
  const account = opts.avoidAccountIds?.length
    ? selection.account
    : selection.account ?? recordedLive ?? selection.fallback;
  if (account) {
    const picked = agentCredentialFrom(
      agent,
      await getSelfHostedCredentials(
        workspaceId,
        credentialOptionsFor(agent, account.id, { threshold: selection.threshold, model: opts.model, avoidAccountIds: opts.avoidAccountIds }),
      ),
    );
    if (picked) return picked;
  }
  // Nothing chosen could give a token: any account at all, the old behaviour.
  return opts.avoidAccountIds?.length
    ? null
    : agentCredentialFrom(agent, await getSelfHostedCredentials(workspaceId));
}

/** "the 5-hour limit", "the weekly (Opus) limit" — a window label inside a sentence. */
export function windowPhrase(window: Pick<FleetUsageWindow, 'label'>): string {
  const label = window.label.trim();
  const lowered = /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  return `${lowered} limit`;
}

/** Why `from` was left, for a note a person reads. */
export function switchReasonText(
  from: Pick<FleetAccount, 'label'>,
  verdict: FleetAccountVerdict,
): string {
  if (verdict.reason === 'usage' && verdict.window) {
    return `${from.label} reached ${Math.round(verdict.window.usedPercent)}% of its ${windowPhrase(verdict.window)}`;
  }
  if (verdict.reason === 'held') return `${from.label} is out of usage`;
  if (verdict.reason === 'reauth') return `${from.label} needs to be signed in again`;
  return `${from.label} is not available`;
}

/** "Switched to <to> because <from> reached 96% of its 5-hour limit." */
export function accountSwitchNote(
  from: Pick<FleetAccount, 'label'>,
  to: Pick<FleetAccount, 'label'>,
  verdict: FleetAccountVerdict,
): string {
  return `Switched to ${to.label} because ${switchReasonText(from, verdict)}.`;
}

// ---------------------------------------------------------------------------
// Failover hops
// ---------------------------------------------------------------------------

/**
 * A failover hop at one ACCOUNT: `fleet:<agent>:<accountId>`. The bare
 * `fleet:<agent>` form is older and means every account of that agent.
 */
export function fleetAccountHop(agent: FleetAgent, accountId: string): string {
  return `fleet:${agent}:${accountId}`;
}

/** The account ids named by `fleet:<agent>:<accountId>` hops. */
export function accountIdsFromHops(hops: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const hop of hops) {
    const match = /^fleet:(?:claude|codex):(.+)$/.exec(hop);
    if (match) ids.push(match[1]);
  }
  return ids;
}
