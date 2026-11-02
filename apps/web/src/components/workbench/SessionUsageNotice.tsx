import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { PLAN_LIMITS, USAGE_EXHAUSTED_ERROR_CODE as USAGE_EXHAUSTED_CODE } from '@talyn/shared';
import { useBillingStore } from '../../stores/billing';
import { useWakeRefusalStore } from '../../lib/wakeWorkbench';
import {
  refusalSentence,
  refusalTitle,
  upgradeReasonForCode,
  usageBillingOf,
  type BoxRefusalNotice,
} from '../../lib/usageBilling';

/**
 * Above the composer: why the plan will not start or wake this session's box,
 * and the one action that fixes it. Nothing on a backend without usage
 * billing, and nothing while the plan has room.
 */
export function SessionUsageNotice({ workbenchId }: { workbenchId: string }) {
  const status = useBillingStore((s) => s.status);
  const view = useMemo(() => usageBillingOf(status), [status]);
  const wakeRefusal = useWakeRefusalStore((s) => s.refusals[workbenchId] ?? null);
  const openUpgrade = useBillingStore((s) => s.setUpgradeModalOpen);

  if (!view) return null;
  // The status is fresher than a wake answer about the budget: credits bought
  // since then clear an "out of hours" refusal without another wake.
  const staleExhausted = wakeRefusal?.code === USAGE_EXHAUSTED_CODE && !view.usage.exhausted;
  const notice: BoxRefusalNotice | null =
    wakeRefusal && !staleExhausted
      ? wakeRefusal
      : view.usage.exhausted
        ? {
            code: USAGE_EXHAUSTED_CODE,
            message: '',
            creditsAllowed: PLAN_LIMITS[view.tier].creditsAllowed,
            periodEnd: view.usage.periodEnd,
          }
        : null;
  if (!notice) return null;

  const credits = PLAN_LIMITS[view.tier].creditsAllowed;
  const actionLabel =
    notice.code === USAGE_EXHAUSTED_CODE ? (credits ? 'Add credits' : 'Upgrade') : view.tier === 'free' ? 'Upgrade' : null;

  return (
    <div
      role="status"
      data-attr="session-usage-notice"
      className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {notice.code === USAGE_EXHAUSTED_CODE ? 'Out of hours: new boxes paused' : refusalTitle(notice.code)}
        </p>
        <p className="text-muted-foreground">{refusalSentence(notice)}</p>
      </div>
      {actionLabel && (
        <button
          type="button"
          onClick={() => openUpgrade(true, upgradeReasonForCode(notice.code), notice)}
          className="shrink-0 rounded px-2 py-0.5 font-medium text-primary hover:bg-primary/10"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
