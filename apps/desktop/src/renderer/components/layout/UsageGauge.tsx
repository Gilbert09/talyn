import { AlertTriangle } from 'lucide-react';
import {
  PLAN_TIER_LABELS,
  cloudProviderStatus,
  fleetAgentLabel,
  formatBoxHoursUsage,
  formatUsd,
  type FleetAgent,
} from '@talyn/shared';
import type { CloudProviderInfo } from '@talyn/client';
import { cn } from '../../lib/utils';
import {
  GAUGE_ACTION_LABELS,
  GAUGE_BAR_CLASS,
  GAUGE_TEXT_CLASS,
  formatShortDate,
  gaugeAction,
  gaugeTone,
  hasUsageBilling,
  type GaugeTone,
  type UsageBillingStatus,
} from '../../lib/usageBilling';
import { useBillingStore } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { CloudProviderStatus } from './CloudProviderStatus';

/**
 * The sidebar's bottom-left box. With usage billing it is the compute usage
 * gauge; on a backend without it (the production backend until release) it is
 * the old Agents box, unchanged.
 */
export function SidebarAccountStatus({ collapsed }: { collapsed: boolean }) {
  const status = useBillingStore((s) => s.status);
  if (!hasUsageBilling(status)) return <CloudProviderStatus collapsed={collapsed} />;
  return <UsageGauge status={status} collapsed={collapsed} />;
}

/**
 * Agents that need a person: one line per agent that needs reconnecting, or a
 * single line when no agent is connected at all. A provider the user never
 * connected is not a problem while another one works, so it is not listed;
 * healthy agents are not listed either.
 */
export function agentWarnings(providers: CloudProviderInfo[] | null | undefined, posthogNeedsReauth = false): string[] {
  if (!providers || providers.length === 0) return [];
  const lines: string[] = [];
  let anyConnected = false;
  for (const p of providers) {
    const summary = cloudProviderStatus(
      p.type === 'posthog_code' ? { ...p, needsReconnect: p.needsReconnect || posthogNeedsReauth } : p,
    );
    if (summary.tone !== 'disconnected') anyConnected = true;
    if (summary.tone !== 'reauth') continue;
    const agents = p.reauthAgents ?? [];
    if (agents.length === 0) lines.push(`${p.displayName} needs reconnecting`);
    else for (const agent of agents) lines.push(`${fleetAgentLabel(agent as FleetAgent)} needs reconnecting`);
  }
  if (!anyConnected) lines.push('No agent is connected');
  return lines;
}

function UsageGauge({ status, collapsed }: { status: UsageBillingStatus; collapsed: boolean }) {
  const providers = useWorkspaceStore((s) => s.cloudProviders);
  const posthogNeedsReauth = useWorkspaceStore((s) => s.posthogStatus?.needsReauth === true);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);

  const { usage, tier } = status;
  const tone = gaugeTone(usage);
  const action = gaugeAction(status);
  const exhausted = usage.exhausted;
  const usageText = formatBoxHoursUsage(usage.usedWsec, usage.includedWsec);
  const reset = formatShortDate(usage.periodEnd);
  const balance = status.credits?.balanceMicros ?? 0;
  const warnings = agentWarnings(providers, posthogNeedsReauth);
  const tierLabel = PLAN_TIER_LABELS[tier];

  const openPlan = () => openSettings('billing');
  const runAction = () => {
    if (action === 'upgrade') setUpgradeModalOpen(true, exhausted ? 'usage_exhausted' : null);
    else openSettings('billing');
  };

  const summary = [
    `${tierLabel} plan`,
    exhausted ? 'Out of hours: new boxes paused' : usageText,
    `Resets ${reset}`,
    ...(balance > 0 ? [`Credits ${formatUsd(balance)}`] : []),
    ...warnings,
  ].join('. ');

  if (collapsed) {
    return (
      <div className="-mx-2 mb-2 flex flex-col items-center border-b px-2 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={openPlan}
              aria-label={summary}
              data-attr="usage-gauge-collapsed"
              className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
            >
              <UsageRing percent={exhausted ? 100 : usage.percent} tone={tone} />
              {warnings.length > 0 && (
                <span aria-hidden className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-card" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[16rem] space-y-0.5">
            <p className="font-medium">{tierLabel} plan</p>
            <p>{exhausted ? 'Out of hours: new boxes paused' : usageText}</p>
            <p className="text-muted-foreground">Resets {reset}</p>
            {balance > 0 && <p className="text-muted-foreground">Credits {formatUsd(balance)}</p>}
            {warnings.map((w) => (
              <p key={w} className="text-amber-600 dark:text-amber-400">
                {w}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="-mx-2 mb-2 border-b px-2 pb-2" data-attr="usage-gauge">
      <div className="space-y-1.5 px-2">
        <button
          type="button"
          onClick={openPlan}
          className="block w-full rounded-md text-left transition-colors hover:bg-accent/50"
          aria-label={`Plan and usage: ${summary}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {tierLabel}
            </span>
            <span className="text-[10px] text-muted-foreground">Resets {reset}</span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Box-hours used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={exhausted ? 100 : usage.percent}
          >
            <div
              className={cn('h-full rounded-full transition-all', GAUGE_BAR_CLASS[tone])}
              style={{ width: `${exhausted ? 100 : usage.percent}%` }}
            />
          </div>
          {exhausted ? (
            <p className="mt-1 text-xs font-medium text-destructive">Out of hours: new boxes paused</p>
          ) : (
            <p className={cn('mt-1 text-xs', tone === 'ok' ? 'text-foreground' : GAUGE_TEXT_CLASS[tone])}>
              {usageText}
            </p>
          )}
          {balance > 0 && <p className="text-[11px] text-muted-foreground">Credits {formatUsd(balance)}</p>}
        </button>
        <button
          type="button"
          onClick={runAction}
          data-attr={`usage-gauge-${action}`}
          className={cn(
            'w-full rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            exhausted || tone === 'warning'
              ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
              : 'hover:bg-accent',
          )}
        >
          {GAUGE_ACTION_LABELS[action]}
        </button>
        {warnings.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => openSettings('integrations')}
            className="flex w-full items-center gap-1.5 rounded-md text-left text-[11px] text-amber-600 hover:underline dark:text-amber-400"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{w}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const RING_STROKE: Record<GaugeTone, string> = {
  ok: 'stroke-primary',
  notice: 'stroke-amber-500',
  warning: 'stroke-orange-500',
  danger: 'stroke-destructive',
};

function UsageRing({ percent, tone }: { percent: number; tone: GaugeTone }) {
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * RING_CIRCUMFERENCE;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className={RING_STROKE[tone]}
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
      />
    </svg>
  );
}
