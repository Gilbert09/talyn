import type { FleetAgent } from '@talyn/shared';
import { listFleetAccounts, type FleetAccount } from '../selfHosted/accounts.js';
import { accountOverVerdict, fleetSwitchSettings, modelMatchText } from '../selfHosted/accountSelection.js';
import { isHeldBack } from '../selfHosted/exhaustedQuota.js';
import { isOverThreshold } from '../selfHosted/usage.js';
import { WorkbenchError } from './errors.js';

/** Use stored account state. A failed sign-in must not trigger another vendor request. */
export async function missingSessionCredential(
  workspaceId: string,
  agent: FleetAgent,
  opts: { payer?: boolean; model?: string } = {},
): Promise<WorkbenchError> {
  const [accounts, settings] = await Promise.all([listFleetAccounts(workspaceId), fleetSwitchSettings(workspaceId)]);
  return credentialFailure(accounts, agent, {
    ...opts,
    threshold: settings.useFullQuotaWhenAllOver ? 100 : settings.threshold,
  });
}

/** "Mon 18:20 UTC". A weekly limit can reset days away, so the day is kept. */
function resetText(time: number): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)).replace(',', '')} UTC`;
}

function labels(accounts: FleetAccount[]): string {
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(accounts.map((a) => a.label));
}

/** The latest known blocking reset for an account. */
export function accountReset(account: FleetAccount, threshold: number, model: string | undefined, now: Date): number | null {
  const resets: (string | null | undefined)[] = [];
  if (account.quotaExhausted && isHeldBack(account.quotaExhausted, now)) resets.push(account.quotaExhausted.resetsAt);
  if (account.usage && 'windows' in account.usage) {
    resets.push(...account.usage.windows.filter((w) => isOverThreshold([w], threshold, modelMatchText(model))).map((w) => w.resetsAt));
  }
  const times = resets.map((value) => value ? Date.parse(value) : NaN)
    .filter((time) => Number.isFinite(time) && time > now.getTime());
  return times.length ? Math.max(...times) : null;
}

export function credentialFailure(
  accounts: FleetAccount[],
  agent: FleetAgent,
  opts: { payer?: boolean; model?: string; threshold: number; now?: Date },
): WorkbenchError {
  const now = opts.now ?? new Date();
  const own = accounts.filter((a) => a.agent === agent);
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const workspace = opts.payer ? 'Your workspace' : 'This workspace';
  const reauth = own.filter((a) => a.reauthRequiredAt);
  const limited = own.filter((a) => ['usage', 'held'].includes(accountOverVerdict(a, opts.threshold, opts.model, now).reason ?? ''));
  const parts: string[] = [];
  if (!own.length) parts.push(`${workspace} has no ${name} account. Connect it in Settings → Talyn Fleet.`);
  if (reauth.length) {
    if (opts.payer) parts.push('These accounts are in your workspace.');
    parts.push(`${labels(reauth)} ${reauth.length === 1 ? 'needs' : 'need'} to be signed in again.`);
    parts.push(`Reconnect ${reauth.length === 1 ? 'it' : 'them'} in Settings → Talyn Fleet.`);
  }
  if (limited.length) {
    parts.push(`${labels(limited)} ${limited.length === 1 ? 'is' : 'are'} at ${limited.length === 1 ? 'its' : 'their'} usage limit.`);
    const resets = limited.map((a) => accountReset(a, opts.threshold, opts.model, now)).filter((time): time is number => time !== null);
    if (resets.length) parts.push(`The first known reset is at ${resetText(Math.min(...resets))}.`);
    const other = agent === 'claude' ? 'codex' : 'claude';
    if (accounts.some((a) => a.agent === other && !accountOverVerdict(a, opts.threshold, undefined, now).reason)) {
      parts.push(`Wait for usage to reset, or switch this chat to ${other === 'claude' ? 'Claude' : 'Codex'}.`);
    }
  }
  if (own.length && !reauth.length && !limited.length) parts.push(`${workspace}'s ${name} accounts are not available. Try again shortly.`);
  if (opts.payer) parts.push('Use your workspace accounts to prompt this session.');
  return new WorkbenchError(parts.join(' '), 409, 'credentials_unavailable', {
    reason: reauth.length ? 'reauth' : limited.length ? 'limited' : own.length ? 'unavailable' : 'missing',
    accountIds: (reauth.length ? reauth : limited.length ? limited : own).map((a) => a.id),
  });
}
