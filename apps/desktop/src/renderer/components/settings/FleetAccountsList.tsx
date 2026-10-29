import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import type { FleetAccountView, FleetAgent } from '@talyn/shared';
import { ApiError, api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { FleetAgentMark } from '../../lib/providerMeta';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

type Account = FleetAccountView;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'multi_account_disabled') {
    return 'Adding more accounts is turned off for this workspace.';
  }
  return error instanceof Error ? error.message : 'Could not update the account';
}

export function formatResetAt(iso: string, now = new Date()): string {
  const reset = new Date(iso);
  if (Number.isNaN(reset.getTime())) return 'resets at an unknown time';

  // Always with minutes: an hour alone ("22") read as a date.
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(reset);
  const localDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAway = (localDay(reset) - localDay(now)) / 86_400_000;
  if (daysAway === 0) return `resets today at ${time}`;
  if (daysAway === 1) return `resets tomorrow at ${time}`;

  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(reset);
  if (daysAway > 1 && daysAway <= 6) return `resets ${weekday} at ${time}`;

  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(reset);
  return `resets ${weekday} ${date} at ${time}`;
}

function updatedTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function kindLabel(kind: Account['kind']): string {
  if (kind === 'claude_oauth') return 'Claude subscription';
  if (kind === 'codex_oauth') return 'ChatGPT subscription';
  return 'API key';
}

type UsageWindow = Extract<NonNullable<Account['usage']>, { windows: unknown }>['windows'][number];

function UsageWindowRow({ window, switchAtPercent }: {
  window: UsageWindow;
  switchAtPercent: number;
}) {
  const color = window.usedPercent >= switchAtPercent ? 'bg-destructive'
    : window.usedPercent >= switchAtPercent - 10 ? 'bg-warning' : 'bg-primary';
  return <div className="text-xs">
    <div className="flex justify-between gap-2">
      <span>{window.label}</span>
      <span>{window.usedPercent}%{window.resetsAt ? ` · ${formatResetAt(window.resetsAt)}` : ''}</span>
    </div>
    <div role="progressbar" aria-label={`${window.label} usage`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100} className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }} />
    </div>
  </div>;
}

function codexConfig(result: Awaited<ReturnType<typeof window.electron.codex.signIn>>) {
  return {
    codexAccessToken: result.accessToken,
    codexRefreshToken: result.refreshToken,
    ...(result.accountId ? { codexAccountId: result.accountId } : {}),
    ...(result.expiresIn ? { codexExpiresIn: String(result.expiresIn) } : {}),
  };
}

export function FleetAccountRow({
  account, active, switchAtPercent, index, ids, workspaceId, onChanged,
}: {
  account: Account;
  active: boolean;
  switchAtPercent: number;
  index: number;
  ids: string[];
  workspaceId: string;
  onChanged: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeStep, setCodeStep] = useState(false);
  const [code, setCode] = useState('');
  const [usageExpanded, setUsageExpanded] = useState(false);
  const windows = account.usage && 'windows' in account.usage ? account.usage.windows : [];
  const summaryWindow = windows.find((window) => window.key === 'weekly_all')
    ?? windows.find((window) => window.label.toLowerCase() === 'weekly' && !window.key.includes('scoped') && !window.key.includes(':'))
    ?? windows.reduce<UsageWindow | null>((highest, window) => !highest || window.usedPercent > highest.usedPercent ? window : highest, null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const move = (direction: -1 | 1) => {
    const next = [...ids];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void run(() => api.cloudProviders.fleetAccounts.reorder(workspaceId, account.agent, next));
  };

  const saveLabel = () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Enter an account name.');
      return;
    }
    if (trimmed === account.label) {
      setRenaming(false);
      return;
    }
    void run(async () => {
      await api.cloudProviders.fleetAccounts.rename(account.id, trimmed);
      setRenaming(false);
    });
  };

  const reconnect = async () => {
    if (account.kind === 'claude_oauth') {
      await run(async () => {
        const { url } = await api.cloudProviders.startClaudeSignIn(workspaceId, { accountId: account.id });
        await openExternal(url);
        setCodeStep(true);
      });
    } else if (account.kind === 'codex_oauth') {
      await run(async () => {
        const result = await window.electron.codex.signIn();
        await api.cloudProviders.saveConfig('selfhosted', workspaceId, codexConfig(result), { codexFleetAccountId: account.id });
      });
    }
  };

  return (
    <div className="rounded-md border px-2 py-1.5 space-y-1" data-testid={`fleet-account-${account.id}`}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
        {renaming ? (
          <Input
            className="h-6 min-w-0"
            aria-label={`Name for ${account.label}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel();
              if (e.key === 'Escape') { setRenaming(false); setLabel(account.label); }
            }}
            disabled={busy}
          />
        ) : (
          <button type="button" className="truncate text-xs font-medium hover:underline" onClick={() => setRenaming(true)}>
            {account.label}
          </button>
        )}
        {account.label.toLowerCase() !== kindLabel(account.kind).toLowerCase() && <span className="text-xs text-muted-foreground">{kindLabel(account.kind)}</span>}
        {active && <Badge variant="secondary">Active</Badge>}
        {account.needsReauth ? <Badge variant="destructive">Reconnect needed</Badge>
          : account.held ? <Badge variant="secondary">Limit reached{account.held.until ? `, ${formatResetAt(account.held.until)}` : ''}</Badge>
            : account.over ? <Badge variant="destructive">{switchAtPercent === 100 ? 'Limit reached' : `Over ${switchAtPercent}%`}</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {account.needsReauth && (account.kind === 'claude_oauth' || account.kind === 'codex_oauth') && <Button size="sm" variant="outline" className="h-6" disabled={busy} onClick={() => void reconnect()}>Reconnect</Button>}
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Refresh usage" aria-label={`Refresh ${account.label} usage`} disabled={busy} onClick={() => void run(() => api.cloudProviders.fleetAccounts.refreshUsage(account.id))}><RefreshCw className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Move up" aria-label={`Move ${account.label} up`} disabled={busy || index === 0} onClick={() => move(-1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Move down" aria-label={`Move ${account.label} down`} disabled={busy || index === ids.length - 1} onClick={() => move(1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Remove" aria-label={`Remove ${account.label}`} disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {account.kind === 'anthropic_key' || account.kind === 'openai_key' ? 'No usage data for API keys'
            : summaryWindow ? `${summaryWindow.label} ${summaryWindow.usedPercent}%${summaryWindow.resetsAt ? ` · ${formatResetAt(summaryWindow.resetsAt)}` : ''}`
              : account.usage && 'error' in account.usage ? `Usage unavailable: ${account.usage.error}` : 'Usage not checked yet'}
          {' · Updated '}{account.usage ? updatedTime(account.usage.fetchedAt) : 'never'}
        </span>
        {windows.length > 0 && <Button size="sm" variant="ghost" aria-expanded={usageExpanded} onClick={() => setUsageExpanded((expanded) => !expanded)} className="h-5 shrink-0 gap-0.5 px-1 text-xs">
          {usageExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Usage
        </Button>}
      </div>
      {usageExpanded && <div className="space-y-2 pt-1">{windows.map((window) => <UsageWindowRow key={window.key} window={window} switchAtPercent={switchAtPercent} />)}</div>}
      {codeStep && <div className="flex gap-2">
        <Input aria-label={`Code for ${account.label}`} value={code} onChange={(e) => setCode(e.target.value)} />
        <Button size="sm" disabled={busy || !code.trim()} onClick={() => void run(async () => { await api.cloudProviders.completeClaudeSignIn(workspaceId, code, { accountId: account.id }); setCodeStep(false); setCode(''); })}>Finish sign-in</Button>
      </div>}
      {confirmRemove && <div className="flex items-center gap-2 text-xs">
        <span>Remove {account.label}?</span>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => api.cloudProviders.fleetAccounts.remove(account.id))}>Remove</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function FleetAccountsList({ agent, workspaceId, accounts, activeId, switchAtPercent, onChanged }: {
  agent: FleetAgent;
  workspaceId: string;
  accounts: Account[];
  activeId: string | null;
  switchAtPercent: number;
  onChanged: () => Promise<void>;
}) {
  const ordered = [...accounts].sort((a, b) => a.priority - b.priority);
  const ids = ordered.map((account) => account.id);
  const agentLabel = agent === 'claude' ? 'Claude' : 'Codex';
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState<'sign_in' | 'key' | null>(null);
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  const [codeStep, setCodeStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenLabel = label.trim();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    await onChanged();
    setAdding(false);
    setMethod(null);
    setKey('');
    setCode('');
    setCodeStep(false);
  };

  const startSignIn = () => {
    setMethod('sign_in');
    void run(async () => {
      try {
        if (agent === 'claude') {
          const { url } = await api.cloudProviders.startClaudeSignIn(workspaceId, { label: chosenLabel });
          await openExternal(url);
          setCodeStep(true);
        } else {
          const result = await window.electron.codex.signIn();
          await api.cloudProviders.saveConfig('selfhosted', workspaceId, codexConfig(result), { codexLabel: chosenLabel });
          await done();
        }
      } catch (e) {
        setMethod(null);
        throw e;
      }
    });
  };

  return <div className="space-y-2">
    <div className="flex items-center gap-2"><FleetAgentMark agent={agent} className="h-4 w-4 rounded-[3px]" /><span className="text-[13px] font-medium">{agentLabel}</span></div>
    {ordered.map((account, index) => <FleetAccountRow key={account.id} account={account} active={activeId === account.id} switchAtPercent={switchAtPercent} index={index} ids={ids} workspaceId={workspaceId} onChanged={onChanged} />)}
    {ordered.length === 0 && <p className="text-xs text-muted-foreground">Not connected</p>}
    {!adding ? <Button size="sm" variant="outline" onClick={() => { setLabel(`${agentLabel} ${accounts.length + 1}`); setAdding(true); }}>{ordered.length === 0 ? `Connect ${agentLabel}` : `Add another ${agentLabel} account`}</Button> : (
      <div className="rounded-md border p-2.5 space-y-2">
        <Input label="Account name" aria-label="Account name" value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
        {!method && <div className="flex gap-2">
          <Button size="sm" disabled={busy || !chosenLabel} onClick={startSignIn}>Sign in</Button>
          <Button size="sm" variant="outline" disabled={busy || !chosenLabel} onClick={() => setMethod('key')}>Paste an API key</Button>
        </div>}
        {method === 'key' && <div className="space-y-2">
          <Input label={`${agentLabel} API key`} aria-label={`${agentLabel} API key`} type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} />
          <Button size="sm" disabled={busy || !chosenLabel || !key.trim()} onClick={() => void run(async () => { await api.cloudProviders.fleetAccounts.add(workspaceId, agent, agent === 'claude' ? 'anthropic_key' : 'openai_key', key.trim(), chosenLabel); await done(); })}>Add account</Button>
        </div>}
        {method === 'sign_in' && agent === 'claude' && codeStep && <div className="space-y-2">
          <Input label="Code from Anthropic" aria-label="Code from Anthropic" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
          <Button size="sm" disabled={busy || !code.trim()} onClick={() => void run(async () => { await api.cloudProviders.completeClaudeSignIn(workspaceId, code, { label: chosenLabel }); await done(); })}>Finish sign-in</Button>
        </div>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setMethod(null); setCodeStep(false); setError(null); }}>Cancel</Button>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    )}
  </div>;
}
