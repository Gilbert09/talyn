import { cloudProviderStatus, defaultFleetModelForAgent, fleetAgentForModel, isStoredFleetModelId, storedFleetModelForAgent,
  type FleetAccountView, type FleetAgent, type WorkspaceSettings } from '@talyn/shared';
import type { CloudProviderInfo } from '@talyn/client/native';

import type { Tone } from '../../components/UI';
import { modelLabel } from '../../lib/models';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;

export interface Badge { label: string; tone: Tone }

const pad = (value: number) => String(value).padStart(2, '0');

/** "resets today at 14:05", "can retry Thu at 09:00", "resets Mon 3 Nov at 09:00". Mirrors web `formatTimeAt`. */
export function formatTimeAt(iso: string, action: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return `${action} at an unknown time`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const away = Math.round((day(at) - day(now)) / DAY);
  if (away === 0) return `${action} today at ${time}`;
  if (away === 1) return `${action} tomorrow at ${time}`;
  const weekday = WEEKDAYS[at.getDay()];
  if (away > 1 && away <= 6) return `${action} ${weekday} at ${time}`;
  return `${action} ${weekday} ${at.getDate()} ${MONTHS[at.getMonth()]} at ${time}`;
}

/** The account's one state badge, in web's order: reconnect, held, over the switch point, else connected. */
export function accountBadge(account: Pick<FleetAccountView, 'needsReauth' | 'held' | 'over'>, switchAtPercent: number, now = new Date()): Badge {
  if (account.needsReauth) return { label: 'Reconnect needed', tone: 'destructive' };
  if (account.held) return { label: account.held.until ? `Limit reached, ${formatTimeAt(account.held.until, 'can retry', now)}` : 'Limit reached', tone: 'warning' };
  if (account.over) return { label: switchAtPercent === 100 ? 'Limit reached' : `Over ${switchAtPercent}%`, tone: 'destructive' };
  return { label: 'Connected', tone: 'success' };
}

export function accountKindLabel(kind: FleetAccountView['kind']): string {
  if (kind === 'claude_oauth') return 'Claude subscription';
  if (kind === 'codex_oauth') return 'ChatGPT subscription';
  return 'API key';
}

type UsageWindow = Extract<NonNullable<FleetAccountView['usage']>, { windows: unknown }>['windows'][number];

/** The window web summarises: the weekly all-models one, else a plain weekly one, else the fullest. */
export function summaryWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find((window) => window.key === 'weekly_all')
    ?? windows.find((window) => window.label.toLowerCase() === 'weekly' && !window.key.includes('scoped') && !window.key.includes(':'))
    ?? windows.reduce<UsageWindow | null>((top, window) => !top || window.usedPercent > top.usedPercent ? window : top, null);
}

/** The usage line under an account, like web's. */
export function accountUsageText(account: Pick<FleetAccountView, 'kind' | 'usage'>, now = new Date()): string {
  if (account.kind === 'anthropic_key' || account.kind === 'openai_key') return 'No usage data for API keys';
  const usage = account.usage;
  if (!usage) return 'Usage not checked yet';
  if ('error' in usage) return `Usage unavailable: ${usage.error}`;
  const window = summaryWindow(usage.windows);
  if (!window) return 'Usage not checked yet';
  return `${window.label} ${window.usedPercent}%${window.resetsAt ? ` · ${formatTimeAt(window.resetsAt, 'resets', now)}` : ''}`;
}

export interface ProviderRow { type: string; name: string; detail: string; tone: Tone; agents: string[] }

/** One row per provider. A PostHog Code reconnect folds in, as web does. */
export function providerRows(providers: readonly CloudProviderInfo[], posthogNeedsReauth = false): ProviderRow[] {
  return providers.map((provider) => {
    const status = cloudProviderStatus(provider.type === 'posthog_code'
      ? { ...provider, needsReconnect: provider.needsReconnect || posthogNeedsReauth } : provider);
    return {
      type: provider.type, name: provider.displayName, detail: status.detail, agents: status.agents,
      tone: status.tone === 'connected' ? 'success' : status.tone === 'reauth' ? 'warning' : 'muted',
    };
  });
}

/** Which provider new work goes to, in words. */
export function defaultProviderLabel(settings: Pick<WorkspaceSettings, 'defaultCloudProvider'> | null | undefined,
  providers: readonly Pick<CloudProviderInfo, 'type' | 'displayName'>[]): string {
  const value = settings?.defaultCloudProvider;
  if (value === 'ask') return 'Ask every time';
  if (!value) return 'Automatic';
  return providers.find((provider) => provider.type === value)?.displayName ?? value;
}

/** The model fleet runs use by default, by name. Empty when none is stored. */
export function defaultFleetModel(settings: Pick<WorkspaceSettings, 'fleetModel'> | null | undefined): string {
  return settings?.fleetModel ? modelLabel(settings.fleetModel) : '';
}

/** Accounts of one agent, in their failover order. */
export function accountsFor(accounts: readonly FleetAccountView[], agent: string): FleetAccountView[] {
  return accounts.filter((account) => account.agent === agent).sort((a, b) => a.priority - b.priority);
}

export interface DefaultOption { value: string; label: string }

/**
 * Where new work can go, like web `CloudProviderDefaultSelector`: automatic,
 * one entry per connected agent of Talyn Fleet, every other connected
 * provider, and "Ask every time".
 */
export function defaultOptions(providers: readonly Pick<CloudProviderInfo, 'type' | 'displayName' | 'connected' | 'connectedAgents'>[]): DefaultOption[] {
  const connected = providers.filter((provider) => provider.connected).flatMap((provider): DefaultOption[] => {
    if (provider.type !== 'selfhosted') return [{ value: provider.type, label: provider.displayName }];
    return (provider.connectedAgents ?? []).filter((agent): agent is FleetAgent => agent === 'claude' || agent === 'codex')
      .map((agent) => ({ value: `selfhosted:${agent}`, label: `${provider.displayName} · ${agent === 'codex' ? 'Codex' : 'Claude'}` }));
  });
  return [{ value: '', label: 'Automatic' }, ...connected, { value: 'ask', label: 'Ask every time' }];
}

/** The stored default as an option value. A fleet default reads back as the agent its model belongs to. */
export function defaultValue(settings: Pick<WorkspaceSettings, 'defaultCloudProvider' | 'fleetModel'> | null | undefined): string {
  const provider = settings?.defaultCloudProvider ?? '';
  return provider === 'selfhosted' ? `selfhosted:${fleetAgentForModel(settings?.fleetModel)}` : provider;
}

/**
 * The settings change for a new default, like web. The model changes only
 * when the choice crosses vendors, and the model being left is remembered.
 * Automatic is sent as null, because the server merges and an absent key
 * would leave the old default in place.
 */
export function defaultPatch(value: string, settings: Pick<WorkspaceSettings, 'fleetModel' | 'fleetModels'> | null | undefined): Record<string, unknown> {
  const [type, agent] = value.split(':') as [string, FleetAgent | undefined];
  const patch: Record<string, unknown> = { defaultCloudProvider: type || null };
  if (agent !== 'claude' && agent !== 'codex') return patch;
  const leaving = fleetAgentForModel(settings?.fleetModel);
  if (leaving === agent) return patch;
  patch.fleetModels = { ...(settings?.fleetModels ?? {}), ...(isStoredFleetModelId(settings?.fleetModel) ? { [leaving]: settings?.fleetModel } : {}) };
  patch.fleetModel = storedFleetModelForAgent(settings as WorkspaceSettings, agent) ?? defaultFleetModelForAgent(agent);
  return patch;
}
