import type { CloudProviderInfo } from '@talyn/client/native';
import type { FleetAccountsResponse, FleetAccountView, FleetAgent } from '@talyn/shared';

import type { Tone } from '../../../components/UI';

export const FLEET_AGENTS: readonly FleetAgent[] = ['claude', 'codex'];
export const AGENT_SHORT: Record<FleetAgent, string> = { claude: 'Claude', codex: 'Codex' };
/** The subscription each agent runs on, by the name people pay for it under. */
export const SUBSCRIPTION: Record<FleetAgent, string> = { claude: 'Claude', codex: 'ChatGPT' };

/** Where the Codex sign-in is finished. It needs `codex login` on a computer. */
export const CODEX_SETTINGS_PATH = '/settings/integrations';
export const CODEX_STEPS: readonly string[] = [
  'Run codex login in a terminal.',
  'Open Talyn, then Settings, Integrations, Talyn Fleet.',
  'Paste the contents of ~/.codex/auth.json under Codex and save.',
];

/** Web's sentences for a saved sign-in the vendor no longer accepts. */
export const REAUTH_DETAIL: Record<FleetAgent, string> = {
  claude: 'Anthropic no longer accepts the saved sign-in, so tasks on Claude cannot run. This happens when the sign-in is revoked or expires, or when the account has no Claude subscription. Sign in to Claude again.',
  codex: 'OpenAI no longer accepts the saved sign-in, so tasks on Codex cannot run. This happens when the sign-in is revoked or expires. Sign in to ChatGPT again.',
};

/**
 * Whether copied text looks like the `code#state` Anthropic's page shows.
 * Only then does the paste field fill itself: anything else on the clipboard
 * is somebody else's, and must not appear in a field they will submit.
 */
export function looksLikeClaudeCode(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^[A-Za-z0-9._~-]{16,}#[A-Za-z0-9._~-]{16,}$/.test(text.trim());
}

export type ApiKeyKind = 'anthropic_key' | 'openai_key';
export const API_KEY_KIND: Record<FleetAgent, ApiKeyKind> = { claude: 'anthropic_key', codex: 'openai_key' };
export const API_KEY_LABEL: Record<FleetAgent, string> = { claude: 'Anthropic API key', codex: 'OpenAI API key' };
export const API_KEY_PLACEHOLDER: Record<FleetAgent, string> = { claude: 'sk-ant-…', codex: 'sk-…' };

/** Why a pasted key is refused, or null. Mirrors the server's `fleetApiKeyError`, so the user hears it before sending. */
export function apiKeyError(agent: FleetAgent, key: string): string | null {
  const value = key.trim();
  if (!value) return 'Paste a key.';
  if (agent === 'claude' && !/^sk-ant-\S+$/.test(value)) {
    return 'That does not look like a Claude credential. Expected an OAuth token (sk-ant-oat…) from a Claude subscription, or a Console API key (sk-ant-api…).';
  }
  if (agent === 'codex' && !/^sk-\S+$/.test(value)) return 'That does not look like an OpenAI platform key. Expected sk-….';
  return null;
}

/** Which account a sign-in writes: an existing one to reconnect, a new one by name, or the older single sign-in. */
export type ConnectTarget = { accountId: string } | { label: string } | undefined;

/** Accounts of one agent, in their failover order. */
export function agentAccounts(accounts: readonly FleetAccountView[], agent: FleetAgent): FleetAccountView[] {
  return accounts.filter((account) => account.agent === agent).sort((a, b) => a.priority - b.priority);
}

/** "Claude 2" for a second Claude account, like web's default name. */
export function nextAccountLabel(accounts: readonly FleetAccountView[], agent: FleetAgent): string {
  return `${AGENT_SHORT[agent]} ${agentAccounts(accounts, agent).length + 1}`;
}

const OAUTH_KIND: Record<FleetAgent, FleetAccountView['kind']> = { claude: 'claude_oauth', codex: 'codex_oauth' };

/**
 * The target of a sign-in. A named account wins. Otherwise a subscription
 * that needs a reconnect is reconnected, unless `add` asks for a new one.
 * An older backend with no account list (null) gets the single sign-in.
 */
export function connectTarget(response: FleetAccountsResponse | null | undefined, agent: FleetAgent,
  options: { accountId?: string; add?: boolean } = {}): ConnectTarget {
  if (options.accountId) return { accountId: options.accountId };
  if (!response) return undefined;
  if (!options.add) {
    const stale = agentAccounts(response.accounts, agent).find((account) => account.needsReauth && account.kind === OAUTH_KIND[agent]);
    if (stale) return { accountId: stale.id };
  }
  return { label: nextAccountLabel(response.accounts, agent) };
}

/** The label for the API key path, which always adds an account. */
export function apiKeyLabel(response: FleetAccountsResponse | null | undefined, agent: FleetAgent): string | undefined {
  return response ? nextAccountLabel(response.accounts, agent) : undefined;
}

export interface AgentState { label: string; tone: Tone; connected: boolean; reauth: boolean }

/**
 * One agent's state. The account list says it when there is one; an older
 * backend falls back to the provider's connected and reconnect lists.
 */
export function agentState(agent: FleetAgent, response: FleetAccountsResponse | null | undefined,
  fleet: Pick<CloudProviderInfo, 'connectedAgents' | 'reauthAgents'> | undefined): AgentState {
  const list = response ? agentAccounts(response.accounts, agent) : null;
  const connected = list ? list.length > 0 : (fleet?.connectedAgents ?? []).includes(agent);
  const reauth = list ? list.length > 0 && list.every((account) => account.needsReauth)
    : (fleet?.reauthAgents ?? []).includes(agent);
  if (reauth) return { label: 'Reconnect needed', tone: 'destructive', connected, reauth };
  if (connected) return { label: 'Connected', tone: 'success', connected, reauth };
  return { label: 'Not connected', tone: 'muted', connected, reauth };
}

export type AccountAction = 'reconnect' | 'refresh' | 'up' | 'down' | 'rename' | 'remove';

/** The actions an account row offers, like web `FleetAccountRow`. An API key has no usage to refresh. */
export function accountActions(account: Pick<FleetAccountView, 'kind' | 'needsReauth'>, index: number, count: number): AccountAction[] {
  const oauth = account.kind === 'claude_oauth' || account.kind === 'codex_oauth';
  return [
    ...(account.needsReauth && oauth ? ['reconnect' as const] : []),
    ...(oauth ? ['refresh' as const] : []),
    ...(index > 0 ? ['up' as const] : []),
    ...(index < count - 1 ? ['down' as const] : []),
    'rename', 'remove',
  ];
}

/** The account order after moving one account up (-1) or down (1). */
export function movedOrder(ids: readonly string[], index: number, direction: -1 | 1): string[] {
  const next = [...ids];
  const other = index + direction;
  if (index < 0 || index >= next.length || other < 0 || other >= next.length) return next;
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

/** The server's sentence for a failed account change, with web's words for a turned-off second account. */
export function accountErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'multi_account_disabled') return 'Adding more accounts is turned off for this workspace.';
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
