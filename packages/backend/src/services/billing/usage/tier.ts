import type { PlanTier } from '@talyn/shared';
import { deriveTier, entitlementQuery, tierFromEntitlementRow, type EntitlementRow } from '../entitlements.js';

/**
 * The plan tier the ledger meters an owner against, and the anchor of their
 * usage period.
 *
 * This is the ONE place the usage package reads the tier. The resolver is
 * `deriveTier` in entitlements.ts: the user's override, then their own
 * subscription (Pro product → Pro, else Legacy Pro), then a paid team seat
 * (the team's tier), then free. It does not look at `billingEnabled()`.
 *
 * `periodAnchor` is the subscription's `current_period_end` for an owner who
 * pays personally, else null (the calendar month in UTC; see `usagePeriodFor`).
 */
export interface UsageTier {
  tier: PlanTier;
  periodAnchor: Date | null;
}

/** The query behind {@link resolveUsageTier}. Exported unexecuted for the egress test. */
export function usageTierQuery(ownerId: string) {
  return entitlementQuery(ownerId);
}

/** Pure: the tier and anchor for one row of {@link usageTierQuery}. */
export function deriveUsageTier(row: EntitlementRow | undefined): UsageTier {
  const { tier, periodAnchor } = tierFromEntitlementRow(row);
  return { tier, periodAnchor };
}

export async function resolveUsageTier(ownerId: string): Promise<UsageTier> {
  const { tier, periodAnchor } = await deriveTier(ownerId);
  return { tier, periodAnchor };
}
