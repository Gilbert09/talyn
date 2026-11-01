import { eq } from 'drizzle-orm';
import { planTierFromOverride, teamSeatTier, type PlanTier } from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { teamSeats, teams, users } from '../../../db/schema.js';
import { teamGrantsSeats } from '../entitlements.js';

/**
 * The plan tier the ledger meters an owner against, and the anchor of their
 * usage period.
 *
 * This is the ONE place the usage package reads the tier. WP3 owns the real
 * resolver (`deriveTier` in entitlements.ts, which also reads the Polar product
 * id); when it lands, swap this body for a call to it and keep the signature.
 *
 * Until then: the user's override, then their own subscription (Legacy Pro: no
 * Pro product exists before release), then a paid team seat (the team's tier),
 * then free.
 *
 * `periodAnchor` is the subscription's `current_period_end` for an owner who
 * pays personally, else null (the calendar month in UTC; see `usagePeriodFor`).
 */
export interface UsageTier {
  tier: PlanTier;
  periodAnchor: Date | null;
}

export function usageTierQuery(ownerId: string) {
  return getPoolDbClient()
    .select({
      plan: users.plan,
      planOverride: users.planOverride,
      currentPeriodEnd: users.currentPeriodEnd,
      teamPlan: teams.plan,
      teamPlanOverride: teams.planOverride,
      teamTier: teams.tier,
    })
    .from(users)
    .leftJoin(teamSeats, eq(teamSeats.githubUserId, users.githubUserId))
    .leftJoin(teams, eq(teams.id, teamSeats.teamId))
    .where(eq(users.id, ownerId))
    .limit(1);
}

type TierRow = Awaited<ReturnType<typeof usageTierQuery>>[number];

/** Pure: the tier and anchor for one row of {@link usageTierQuery}. */
export function deriveUsageTier(row: TierRow | undefined): UsageTier {
  if (!row) return { tier: 'free', periodAnchor: null };
  const paysPersonally = row.plan === 'unlimited';
  const anchor = paysPersonally ? row.currentPeriodEnd : null;
  const override = planTierFromOverride(row.planOverride);
  if (override) return { tier: override, periodAnchor: override === 'free' ? null : anchor };
  if (paysPersonally) return { tier: 'legacy_pro', periodAnchor: anchor };
  if (row.teamPlan !== null && teamGrantsSeats({ plan: row.teamPlan, planOverride: row.teamPlanOverride })) {
    return { tier: teamSeatTier(row.teamTier), periodAnchor: null };
  }
  return { tier: 'free', periodAnchor: null };
}

export async function resolveUsageTier(ownerId: string): Promise<UsageTier> {
  const [row] = await usageTierQuery(ownerId);
  return deriveUsageTier(row);
}
