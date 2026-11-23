import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cloudProviderStatus } from '@talyn/shared';
import type { CloudProviderInfo } from '../../lib/api';
import { cn } from '../../lib/utils';
import { trackEvent } from '../../lib/analytics';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import {
  CREDIT_BAR_CLASS,
  CREDIT_TEXT_CLASS,
  GAUGE_BAR_CLASS,
  GAUGE_TEXT_CLASS,
  gaugeAction,
  gaugeActionLabel,
  gaugeSummary,
  creditDrawTone,
  gaugeTone,
  leftPercent,
  usageBillingOf,
  type UsageBillingView,
} from '../../lib/usageBilling';
import { CloudProviderStatus } from './CloudProviderStatus';

/**
 * The sidebar's bottom-left slot: the compute usage gauge when the backend
 * serves usage data, else the old Agents box exactly as before.
 */
export function SidebarUsageSlot({ collapsed }: { collapsed: boolean }) {
  const status = useBillingStore((s) => s.status);
  const view = useMemo(() => usageBillingOf(status), [status]);
  if (!view) return <CloudProviderStatus collapsed={collapsed} />;
  return <UsageGauge view={view} collapsed={collapsed} />;
}

type ProviderRow = Pick<
  CloudProviderInfo,
  'type' | 'displayName' | 'connected' | 'needsReconnect' | 'connectedAgents' | 'reauthAgents'
>;

/**
 * The agent problems the gauge must not lose. A provider that needs
 * reconnecting is always a problem. A provider that is not connected is only
 * one when no provider is connected at all: the fall-back provider sits
 * unconnected for most people, and a permanent warning about it is noise.
 */
export function agentWarnings(providers: readonly ProviderRow[] | null | undefined, posthogNeedsReauth = false): string[] {
  if (!providers || providers.length === 0) return [];
  const warnings: string[] = [];
  let anyConnected = false;
  for (const p of providers) {
    const status = cloudProviderStatus(
      p.type === 'posthog_code' ? { ...p, needsReconnect: p.needsReconnect || posthogNeedsReauth } : p
    );
    if (status.tone !== 'disconnected') anyConnected = true;
    if (status.tone !== 'reauth') continue;
    const reauth = p.reauthAgents ?? [];
    if (reauth.length > 0) {
      warnings.push(`${status.detail.replace(/^Reconnect needed: /, '')} needs reconnecting`);
    } else {
      warnings.push(`${p.displayName} needs reconnecting`);
    }
  }
  if (!anyConnected) warnings.push('No agent is connected');
  return warnings;
}

export function UsageGauge({ view, collapsed }: { view: UsageBillingView; collapsed: boolean }) {
  const providers = useWorkspaceStore((s) => s.cloudProviders);
  const posthogNeedsReauth = useWorkspaceStore((s) => s.posthogStatus?.needsReauth === true);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const openUpgrade = useBillingStore((s) => s.setUpgradeModalOpen);

  const tone = gaugeTone(view.usage);
  const summary = gaugeSummary(view);
  const action = gaugeAction(view);
  const warnings = agentWarnings(providers, posthogNeedsReauth);
  const credit = summary.credit;
  const left = credit ? credit.leftPercent : leftPercent(view.usage.percent, view.usage.exhausted);
  const creditTone = credit ? creditDrawTone(credit) : null;
  const barClass = creditTone ? CREDIT_BAR_CLASS[creditTone] : GAUGE_BAR_CLASS[tone];
  const textClass = creditTone ? CREDIT_TEXT_CLASS[creditTone] : GAUGE_TEXT_CLASS[tone];

  const tooltip = [
    `${summary.tierLabel} plan`,
    summary.exhaustedText,
    summary.usageText,
    summary.resetText,
    summary.creditsText,
    ...warnings,
  ]
    .filter(Boolean)
    .join('\n');

  if (collapsed) {
    return (
      <div className="-mx-2 mb-2 flex flex-col items-center border-b px-2 pb-2">
        <button
          type="button"
          data-attr="usage-gauge"
          onClick={() => openSettings('billing')}
          title={tooltip}
          aria-label={tooltip}
          className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
        >
          <UsageRing percent={left} className={textClass} />
          {warnings.length > 0 && (
            <span
              aria-hidden
              className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-card"
            />
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="-mx-2 mb-2 border-b px-2 pb-2" data-attr="usage-gauge">
      <div className="px-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openSettings('billing')}
            className="min-w-0 flex-1 truncate text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
            title="Open plan and usage"
          >
            {summary.tierLabel} plan
          </button>
          {action !== null && (
            <button
              type="button"
              data-attr="usage-gauge-action"
              onClick={() => { if (action === 'add_credits') trackEvent('add_credits_clicked', { where: 'sidebar' }); openUpgrade(true, action); }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              {gaugeActionLabel(action)}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => openSettings('billing')}
          className="mt-1 block w-full rounded text-left"
          aria-label={`${summary.usageText}. ${summary.resetText}. Open plan and usage.`}
        >
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={credit ? 'Credit left' : 'Box-hours left'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={left}
          >
            <div className={cn('h-full rounded-full transition-all', barClass)} style={{ width: `${left}%` }} />
          </div>
          {summary.exhaustedText ? (
            <p className="mt-1 text-xs font-medium text-destructive">{summary.exhaustedText}</p>
          ) : (
            <p className={cn('mt-1 text-xs', credit ? cn('font-medium', textClass) : 'text-foreground')}>{summary.leftText}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {summary.resetText}
            {summary.creditsText ? ` · ${summary.creditsText}` : ''}
          </p>
        </button>
        {warnings.map((warning) => (
          <button
            key={warning}
            type="button"
            onClick={() => openSettings('integrations')}
            className="mt-1 flex w-full items-center gap-1.5 rounded text-left text-[11px] text-warning hover:underline"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{warning}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A small ring that shows the share of included hours left. */
function UsageRing({ percent, className }: { percent: number; className?: string }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 18 18" className={cn('h-[18px] w-[18px] -rotate-90', className)} aria-hidden>
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2.5" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  );
}
