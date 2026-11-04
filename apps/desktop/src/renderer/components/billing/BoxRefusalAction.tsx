import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  type PlanTier,
} from '@talyn/shared';
import { usageReasonForCode, type BoxNotice } from '../../lib/usageBilling';
import { trackEvent } from '../../lib/analytics';
import { useBillingStore, type SessionRefusal } from '../../stores/billing';
import { Button } from '../ui/button';

/** Normalise the two spellings a refusal arrives in: a 402 code, or a deferral / chat subtype. */
export function refusalCode(codeOrReason: string | null | undefined): string | null {
  switch (codeOrReason) {
    case USAGE_EXHAUSTED_ERROR_CODE:
    case 'exhausted':
      return USAGE_EXHAUSTED_ERROR_CODE;
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
    case 'box_limit_reached':
    case 'box_limit':
      return CONCURRENT_BOX_LIMIT_ERROR_CODE;
    case SIZE_REQUIRES_PRO_ERROR_CODE:
      return SIZE_REQUIRES_PRO_ERROR_CODE;
    default:
      return null;
  }
}

/**
 * The one action a box refusal offers, or null when money does not fix it (a
 * full box cap on a paid plan: a box frees when one stops).
 */
export function refusalActionLabel(code: string | null, tier: PlanTier | null | undefined): string | null {
  if (!code) return null;
  const paid = tier === 'pro' || tier === 'legacy_pro';
  if (code === USAGE_EXHAUSTED_ERROR_CODE) return paid ? 'Add credits' : 'Upgrade';
  if (code === CONCURRENT_BOX_LIMIT_ERROR_CODE) return paid ? null : 'Upgrade';
  if (code === SIZE_REQUIRES_PRO_ERROR_CODE) return paid ? null : 'Upgrade';
  return null;
}

/** What a session says when the plan would not wake its box. */
export function sessionRefusalText(refusal: SessionRefusal): string {
  if (refusal.notice?.message) return refusal.notice.message;
  return refusal.status === 'exhausted'
    ? 'Out of box-hours: this session stays asleep until you add hours. Your messages wait in the queue.'
    : 'All your boxes are busy. This session wakes when one stops.';
}

/** A refusal's action button. Opens the upgrade modal with the refusal's reason and notice. */
export function BoxRefusalAction({
  code: codeOrReason,
  notice,
  className,
}: {
  code: string | null | undefined;
  notice?: BoxNotice | null;
  className?: string;
}) {
  const tier = useBillingStore((s) => s.status?.tier ?? notice?.tier ?? null);
  const code = refusalCode(codeOrReason ?? notice?.code);
  const label = refusalActionLabel(code, tier);
  if (!code || !label) return null;
  return (
    <Button
      variant="outline"
      className={className ?? 'h-6 px-2 text-xs'}
      onClick={() => { if (label === 'Add credits') trackEvent('add_credits_clicked', { where: 'refusal' }); useBillingStore.getState().setUpgradeModalOpen(true, usageReasonForCode(code), notice ?? null); }}
    >
      {label}
    </Button>
  );
}
