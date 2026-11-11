import { and, eq, inArray, isNull, ne, notExists, notInArray, sql } from 'drizzle-orm';
import {
  ACTIVE_TASK_STATUSES as SHARED_ACTIVE_TASK_STATUSES,
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  AUTO_REVIEW_ERROR_CODE,
  AUTO_TOPUP_DEFAULTS,
  CODE_REVIEW_ACTIVE_PHASES,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  BOX_HOUR_PRICE_MICROS,
  SANDBOX_SIZES,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  UNATTENDED_SANDBOX_SIZE,
  USAGE_EXHAUSTED_ERROR_CODE,
  autoTopupMonthKey,
  boxHoursToWeightedSeconds,
  creditBalanceMicros,
  expiringSoonMicros,
  formatBoxHoursLabel,
  isCreditPackId,
  planTierFromOverride,
  sizeAllowedOnTier,
  sizePriceTable,
  teamSeatTier,
  usagePercent,
  type AutoTopupSettings,
  type BillingPricing,
  type BillingStatus,
  type BillingTeamMembership,
  type CreditSummary,
  type PlanTier,
  type SandboxSize,
  type UsageBillingErrorCode,
  type UsageSummary,
} from '@talyn/shared';
import {
  getDbClient,
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
  runInScopedDb,
  runWithoutScope,
  type Database,
} from '../../db/client.js';
import {
  autoTopupSettings as autoTopupSettingsTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
  teamAdmins as teamAdminsTable,
  teamSeats as teamSeatsTable,
  teams as teamsTable,
  usageIntervals as usageIntervalsTable,
  users as usersTable,
  loops as loopsTable,
  prCodeReviews as prCodeReviewsTable,
  workflows as workflowsTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { advisoryLockKey } from '../advisoryLock.js';
import { readBudget, type UsageBudget } from './usage/charge.js';
import { liveLots } from './usage/credits.js';
import { getBudget } from './usage/index.js';
import { countUsageResets, usageResetAvailability } from './usage/resets.js';

/**
 * Plan entitlements: the provider-agnostic seam every plan check goes through.
 * Nothing in here knows about Polar beyond "webhooks maintain `users.plan` and
 * `users.polar_product_id`"; the Polar client and webhook live alongside in
 * services/billing/ and can change without touching enforcement.
 *
 * Usage billing replaced the old free/unlimited model and its count caps
 * (active tasks, merge-queue PRs, workflows, loops, review cycles). What is
 * left is one gate, {@link withBoxGate}, that every new box goes through, and
 * two feature gates (auto-keep default, auto-review). Enforcement applies only
 * when the POLAR_* env group is set ({@link billingEnabled}).
 */

/**
 * Statuses of a task that occupies a box, or is about to boot one.
 *
 * Re-exported from the shared partition rather than restated: a new task
 * status lands on the right side of this gate by construction. Kept as a
 * named export because callers across routes and admin import it from here.
 */
export const ACTIVE_TASK_STATUSES = SHARED_ACTIVE_TASK_STATUSES;

/**
 * Active tasks that will take a box. A `waiting_ci` task is active but its box
 * is asleep: it holds no box until a wake, and the wake goes through the gate.
 */
export const BOX_PENDING_TASK_STATUSES = ACTIVE_TASK_STATUSES.filter((s) => s !== 'waiting_ci');

/**
 * Whether billing is configured at all. When the Polar env group is absent
 * (local dev, CI, self-hosted) no plan limit is enforced: a paywall with no
 * way to pay would brick every box with zero recourse. Partial config is a
 * boot error (validateEnv), so checking one var here is enough; this also
 * doubles as a production kill switch.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.POLAR_ACCESS_TOKEN);
}

// ---------------------------------------------------------------------------
// Tier derivation
// ---------------------------------------------------------------------------

export type EntitlementSource = 'default' | 'subscription' | 'override' | 'team' | 'billing_disabled';

export interface Entitlement {
  tier: PlanTier;
  source: EntitlementSource;
}

/** An entitlement plus the anchor of the owner's usage period. */
export interface TierResolution extends Entitlement {
  /** `current_period_end` of a subscription the owner pays personally, else null (calendar month, UTC). */
  periodAnchor: Date | null;
}

/**
 * The Polar product ids that decide a personal subscription's tier.
 *
 * `pro` comes from the env vars WP6 adds for the new Pro product. `legacy`
 * is the old Unlimited product (the vars that sold it). A product in neither
 * list reads as Legacy Pro too: somebody pays us, and before the Pro product
 * exists every paying subscriber holds the old one.
 */
export interface TierProductIds {
  pro: readonly string[];
  /** Absent in older tests and callers: no Max product is known. */
  max?: readonly string[];
  legacy: readonly string[];
}

export const PRO_PRODUCT_ENV_VARS = ['POLAR_PRODUCT_ID_PRO_MONTHLY', 'POLAR_PRODUCT_ID_PRO_ANNUAL'] as const;
/** Max is sold monthly only. */
export const MAX_PRODUCT_ENV_VARS = ['POLAR_PRODUCT_ID_MAX_MONTHLY'] as const;
export const LEGACY_PRODUCT_ENV_VARS = ['POLAR_PRODUCT_ID_MONTHLY', 'POLAR_PRODUCT_ID_ANNUAL'] as const;

const PERIOD_PRODUCT_ENV_VARS: Record<'personal' | 'team', Record<'monthly' | 'annual', readonly string[]>> = {
  personal: {
    monthly: ['POLAR_PRODUCT_ID_PRO_MONTHLY', 'POLAR_PRODUCT_ID_MAX_MONTHLY', 'POLAR_PRODUCT_ID_MONTHLY'],
    annual: ['POLAR_PRODUCT_ID_PRO_ANNUAL', 'POLAR_PRODUCT_ID_ANNUAL'],
  },
  team: {
    monthly: ['POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY', 'POLAR_PRODUCT_ID_TEAM_MONTHLY'],
    annual: ['POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL', 'POLAR_PRODUCT_ID_TEAM_ANNUAL'],
  },
};

/**
 * The billing period a stored subscription product id sells, or null for no
 * product or one this deployment does not know. Read from env at call time.
 */
export function subscriptionPeriod(
  polarProductId: string | null | undefined,
  kind: 'personal' | 'team' = 'personal'
): 'monthly' | 'annual' | null {
  if (!polarProductId) return null;
  const table = PERIOD_PRODUCT_ENV_VARS[kind];
  for (const period of ['monthly', 'annual'] as const) {
    if (productIdsFromEnv(table[period]).includes(polarProductId)) return period;
  }
  return null;
}

function productIdsFromEnv(names: readonly string[]): string[] {
  return names.map((name) => process.env[name]?.trim()).filter((id): id is string => Boolean(id));
}

/** The Max product is set, so this deployment can sell Max. */
export function maxProductsConfigured(): boolean {
  return productIdsFromEnv(MAX_PRODUCT_ENV_VARS).length === MAX_PRODUCT_ENV_VARS.length;
}

/**
 * Whether this deployment sells Max: billing on and the Max product set.
 * Holding Max never depends on this.
 */
export function maxPlanOffered(): boolean {
  return billingEnabled() && maxProductsConfigured();
}

/** Read at call time, so a test or a redeploy with new env takes effect at once. */
export function tierProductIds(): TierProductIds {
  return {
    pro: productIdsFromEnv(PRO_PRODUCT_ENV_VARS),
    max: productIdsFromEnv(MAX_PRODUCT_ENV_VARS),
    legacy: productIdsFromEnv(LEGACY_PRODUCT_ENV_VARS),
  };
}

/**
 * `users.plan` values that mean "a personal subscription grants a paid tier".
 * The webhook writes `unlimited` today; the usage-billing webhook may write the
 * tier itself. `free` and anything unknown grant nothing.
 */
const GRANTING_PLANS: ReadonlySet<string> = new Set(['unlimited', 'pro', 'legacy_pro']);

export function hasGrantingSubscription(plan: string | null | undefined): boolean {
  return typeof plan === 'string' && GRANTING_PLANS.has(plan);
}

/** The tier a granting personal subscription gives: Pro or Max for their products, else Legacy Pro. */
export function subscriptionTier(
  polarProductId: string | null | undefined,
  ids: TierProductIds = tierProductIds()
): Exclude<PlanTier, 'free'> {
  if (!polarProductId) return 'legacy_pro';
  if (ids.pro.includes(polarProductId)) return 'pro';
  if (ids.max?.includes(polarProductId)) return 'max';
  return 'legacy_pro';
}

/** The billing columns of the team whose seat a user holds. */
export interface TeamBillingRow {
  plan: string;
  planOverride: string | null;
  /** `teams.tier`. Absent or unknown reads as Legacy Pro (see `teamSeatTier`). */
  tier?: string | null;
  /** `teams.polar_product_id`; names the team's billing period. */
  polarProductId?: string | null;
}

/**
 * Whether a team currently pays for its seats. The operator override wins in
 * both directions, exactly as a user's does; otherwise the webhook-driven plan.
 */
export function teamGrantsSeats(team: TeamBillingRow | null | undefined): boolean {
  if (!team) return false;
  if (team.planOverride === 'team') return true;
  if (team.planOverride === 'none') return false;
  return team.plan === 'team';
}

export interface UserBillingRow {
  plan: string;
  planOverride: string | null;
  polarProductId?: string | null;
  currentPeriodEnd?: Date | null;
}

/**
 * Pure tier derivation from a users-row billing projection and, when the user
 * holds a seat, that seat's team.
 *
 * Order:
 * 1. `plan_override` (`unlimited` and `pro` → pro, `max` → max,
 *    `legacy_pro` → legacy_pro, `free` → free). A personal `free` beats everything below on purpose: it
 *    is how an operator blocks one account, and a team must not undo that.
 * 2. The user's own granting subscription: a Pro product → pro; a Max
 *    product → max; an old
 *    Unlimited product, no stored product, or an unknown one → legacy_pro.
 * 3. A paid team seat → the team's tier.
 * 4. Free.
 */
export function deriveTierResolution(
  row: UserBillingRow | undefined,
  team?: TeamBillingRow | null,
  ids: TierProductIds = tierProductIds()
): TierResolution {
  if (!row) return { tier: 'free', source: 'default', periodAnchor: null };
  const paysPersonally = hasGrantingSubscription(row.plan);
  const anchor = paysPersonally ? (row.currentPeriodEnd ?? null) : null;
  const override = planTierFromOverride(row.planOverride);
  if (override) {
    return { tier: override, source: 'override', periodAnchor: override === 'free' ? null : anchor };
  }
  if (paysPersonally) {
    return { tier: subscriptionTier(row.polarProductId, ids), source: 'subscription', periodAnchor: anchor };
  }
  if (teamGrantsSeats(team)) {
    return { tier: teamSeatTier(team?.tier), source: 'team', periodAnchor: null };
  }
  return { tier: 'free', source: 'default', periodAnchor: null };
}

/** {@link deriveTierResolution} without the period anchor. */
export function deriveEntitlement(
  row: UserBillingRow | undefined,
  team?: TeamBillingRow | null,
  ids?: TierProductIds
): Entitlement {
  const { tier, source } = deriveTierResolution(row, team, ids);
  return { tier, source };
}

/**
 * The query behind {@link deriveTier}: the user's billing columns and, through
 * the seat bound to their GitHub id, that seat's team. Exported unexecuted for
 * the egress test.
 *
 * Read on the POOL even from an owner-scoped request: the team tables are
 * backend-only (RLS on, no policy), and "does this owner hold a seat" is a
 * server-side fact about the owner, not data the caller is reading.
 */
export function entitlementQuery(ownerId: string) {
  return getPoolDbClient()
    .select({
      plan: usersTable.plan,
      planOverride: usersTable.planOverride,
      polarProductId: usersTable.polarProductId,
      currentPeriodEnd: usersTable.currentPeriodEnd,
      teamPlan: teamsTable.plan,
      teamPlanOverride: teamsTable.planOverride,
      teamTier: teamsTable.tier,
    })
    .from(usersTable)
    .leftJoin(teamSeatsTable, eq(teamSeatsTable.githubUserId, usersTable.githubUserId))
    .leftJoin(teamsTable, eq(teamsTable.id, teamSeatsTable.teamId))
    .where(eq(usersTable.id, ownerId))
    .limit(1);
}

export type EntitlementRow = Awaited<ReturnType<typeof entitlementQuery>>[number];

/** Pure: the resolution for one row of {@link entitlementQuery}. */
export function tierFromEntitlementRow(row: EntitlementRow | undefined, ids?: TierProductIds): TierResolution {
  if (!row) return deriveTierResolution(undefined);
  const team = row.teamPlan === null ? null : { plan: row.teamPlan, planOverride: row.teamPlanOverride, tier: row.teamTier };
  return deriveTierResolution(row, team, ids);
}

/**
 * The owner's usage tier, its source and their usage-period anchor. Does NOT
 * look at {@link billingEnabled}: the ledger meters every owner against their
 * real tier, and each gate decides whether to enforce.
 */
export async function deriveTier(ownerId: string): Promise<TierResolution> {
  const [row] = await entitlementQuery(ownerId);
  return tierFromEntitlementRow(row);
}

/**
 * The tier a gate enforces. With billing unconfigured nothing is limited, so
 * this answers Pro (every feature, every size) with source `billing_disabled`.
 */
export async function resolveEntitlement(ownerId: string): Promise<Entitlement> {
  if (!billingEnabled()) return { tier: 'pro', source: 'billing_disabled' };
  const { tier, source } = await deriveTier(ownerId);
  return { tier, source };
}

/** Whether the owner may use the auto-keep default and auto-review. */
export async function ownerHasAutoFeatures(ownerId: string): Promise<boolean> {
  const { tier } = await resolveEntitlement(ownerId);
  return PLAN_LIMITS[tier].autoFeatures;
}

// ---------------------------------------------------------------------------
// The box gate
// ---------------------------------------------------------------------------

/**
 * What a refused box start tells its caller. Routes send `message` with the
 * 402; unattended callers (loops, merge-queue fixes, auto-keep, workflows,
 * reviews) record it as a visible deferral notice.
 */
export interface BoxGateNotice {
  code: UsageBillingErrorCode;
  /** User-facing. */
  message: string;
  tier: PlanTier;
  workspaceId?: string;
  /** concurrent_box_limit_reached: the cap and the boxes in use. */
  limit?: number;
  active?: number;
  /** size_requires_pro: the refused size and the sizes the tier may start. */
  size?: SandboxSize;
  allowedSizes?: SandboxSize[];
  /** usage_exhausted: when the included hours reset (ISO). */
  periodEnd?: string;
  /** usage_exhausted: whether the tier may buy credits (else the way out is Pro). */
  creditsAllowed?: boolean;
  /**
   * When the refusal clears with no action (ISO): the period reset for
   * usage_exhausted. Absent when it clears on an event instead (a box stops)
   * or never (a size the tier cannot start).
   */
  retryAt?: string;
}

/** A refusal from {@link withBoxGate}. Routes map every subclass to a 402 with its code. */
export abstract class BoxGateError extends Error {
  abstract readonly code: UsageBillingErrorCode;
  constructor(readonly notice: BoxGateNotice) {
    super(notice.message);
  }
}

export function isBoxGateError(err: unknown): err is BoxGateError {
  return err instanceof BoxGateError;
}

function sizeName(size: SandboxSize): string {
  return SANDBOX_SIZES[size].label.split(' · ')[0] ?? size;
}

/** The period's included box-hours and the credits are both spent, and auto top-up cannot cover it. */
export class UsageExhaustedError extends BoxGateError {
  readonly code = USAGE_EXHAUSTED_ERROR_CODE;
  constructor(input: { tier: PlanTier; periodEnd: Date; workspaceId?: string }) {
    const limits = PLAN_LIMITS[input.tier];
    const reset = input.periodEnd.toISOString().slice(0, 10);
    const message = limits.creditsAllowed
      ? `You have used your included box-hours and your credits for this period. ` +
        `Add credits or turn on auto top-up to start new boxes. Included hours reset on ${reset}.`
      : `You have used all ${formatBoxHoursLabel(boxHoursToWeightedSeconds(limits.includedBoxHours))} of this period. ` +
        `New boxes can start again on ${reset}. Upgrade to Pro for ` +
        `${formatBoxHoursLabel(boxHoursToWeightedSeconds(PLAN_LIMITS.pro.includedBoxHours))} a month.`;
    super({
      code: USAGE_EXHAUSTED_ERROR_CODE,
      message,
      tier: input.tier,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      periodEnd: input.periodEnd.toISOString(),
      creditsAllowed: limits.creditsAllowed,
      retryAt: input.periodEnd.toISOString(),
    });
    this.name = 'UsageExhaustedError';
  }
}

/** The tier may not start this size (Free: small and standard). */
export class SizeRequiresProError extends BoxGateError {
  readonly code = SIZE_REQUIRES_PRO_ERROR_CODE;
  constructor(input: { tier: PlanTier; size: SandboxSize; workspaceId?: string }) {
    const allowed = [...PLAN_LIMITS[input.tier].sizes];
    super({
      code: SIZE_REQUIRES_PRO_ERROR_CODE,
      message:
        `${sizeName(input.size)} boxes need the Pro plan. The ${PLAN_TIER_LABELS[input.tier]} plan can start ` +
        `${allowed.map(sizeName).join(' and ')} boxes.`,
      tier: input.tier,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      size: input.size,
      allowedSizes: allowed,
    });
    this.name = 'SizeRequiresProError';
  }
}

/** The owner already runs as many boxes as the tier allows at once. */
export class ConcurrentBoxLimitError extends BoxGateError {
  readonly code = CONCURRENT_BOX_LIMIT_ERROR_CODE;
  readonly limit: number;
  readonly active: number;
  constructor(limit: number, active: number, tier: PlanTier = 'free', workspaceId?: string) {
    const upgrade =
      PLAN_LIMITS.pro.concurrentBoxes > limit ? ` Upgrade to Pro to run ${PLAN_LIMITS.pro.concurrentBoxes}.` : '';
    super({
      code: CONCURRENT_BOX_LIMIT_ERROR_CODE,
      message:
        `The ${PLAN_TIER_LABELS[tier]} plan runs ${limit} boxes at the same time (${active} in use). ` +
        `A new box can start when one stops.${upgrade}`,
      tier,
      ...(workspaceId ? { workspaceId } : {}),
      limit,
      active,
    });
    this.limit = limit;
    this.active = active;
    this.name = 'ConcurrentBoxLimitError';
  }
}

export interface BoxGateOptions {
  /** The size the caller wants to start. */
  size: SandboxSize;
  /**
   * No person waits on this start (loops, merge-queue fixes, auto-keep,
   * workflows, reviews). A size the tier may not start runs at `small`
   * instead of being refused, so a free user's loop still runs.
   */
  unattended?: boolean;
  /** Carried onto a refusal's notice. */
  workspaceId?: string;
  /** A task being re-activated rather than created: not counted against itself. */
  excludeTaskId?: string;
  /**
   * The box replaces one the owner already runs (resize, move): only the size
   * is checked. A replacement is not an extra box and needs no new budget.
   */
  replacesBox?: boolean;
  /**
   * The box already exists at its size (a session's box): a new turn or a
   * wake needs budget, but the size is not checked again. `awake` means the
   * box has an open usage interval and is counted already, so the
   * concurrency cap is not checked either. `asleep` means waking it adds a box.
   */
  existingBox?: 'awake' | 'asleep';
  /**
   * The run starts no metered box (a PostHog Code task): it costs no
   * box-hours, so neither size nor budget is checked. It still counts
   * against the concurrency cap, like the old active-task cap counted it.
   */
  unmetered?: boolean;
}

export interface BoxGateDecision {
  /** False when billing is not configured: nothing was checked. */
  enforced: boolean;
  /** The tier checked against; null when not enforced. */
  tier: PlanTier | null;
  /** The size to start: the requested one, or `small` for a downgraded unattended run. */
  size: SandboxSize;
  downgraded: boolean;
}

/**
 * Pure: the size a tier starts for a request, or the refusal.
 */
export function decideBoxSize(
  tier: PlanTier,
  size: SandboxSize,
  unattended: boolean
): { size: SandboxSize; downgraded: boolean } | 'refuse' {
  if (sizeAllowedOnTier(tier, size)) return { size, downgraded: false };
  if (unattended && sizeAllowedOnTier(tier, UNATTENDED_SANDBOX_SIZE)) {
    return { size: UNATTENDED_SANDBOX_SIZE, downgraded: true };
  }
  return 'refuse';
}

/** Pure: out of budget. `getBudget().exhausted` already folds auto top-up in. */
export function budgetAllowsNewBox(budget: Pick<UsageBudget, 'includedLeftWsec' | 'creditMicros' | 'autoTopupPossible'>): boolean {
  return budget.includedLeftWsec > 0 || budget.creditMicros > 0 || budget.autoTopupPossible;
}

/**
 * Active tasks with no open usage interval: queued or booting tasks that will
 * take a box. A task whose box already runs is counted once, by its interval.
 *
 * On the POOL: `usage_intervals` is backend-only (RLS on, no policy), so the
 * NOT EXISTS would see nothing through an owner-scoped client and count every
 * running task twice. Exported unexecuted for the egress test.
 */
export function countPendingTaskBoxesQuery(ownerId: string, excludeTaskId?: string, db: Database = getPoolDbClient()) {
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    inArray(tasksTable.status, [...BOX_PENDING_TASK_STATUSES]),
    notExists(
      db
        .select({ one: sql`1` })
        .from(usageIntervalsTable)
        .where(
          and(
            isNull(usageIntervalsTable.endedAt),
            eq(usageIntervalsTable.subjectKind, 'task'),
            eq(usageIntervalsTable.subjectId, tasksTable.id)
          )
        )
    ),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));
  return db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** Boxes with an open usage interval. Exported unexecuted for the egress test. */
export function countOpenBoxesForGateQuery(ownerId: string, db: Database = getPoolDbClient()) {
  return db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(usageIntervalsTable)
    .where(and(eq(usageIntervalsTable.ownerId, ownerId), isNull(usageIntervalsTable.endedAt)));
}

/**
 * Boxes the owner uses now, against the concurrent-box cap: every open usage
 * interval (task, review unit, workbench) plus active tasks that have not
 * opened one yet. Without the second half a free user could queue any number
 * of tasks at once and every one would boot.
 *
 * A task on a provider that runs no box (PostHog Code) has no interval and
 * counts while active, like the old active-task cap counted it.
 */
export async function countBoxesInUse(
  ownerId: string,
  excludeTaskId?: string,
  db: Database = getPoolDbClient()
): Promise<number> {
  const [[open], [pending]] = await Promise.all([
    countOpenBoxesForGateQuery(ownerId, db),
    countPendingTaskBoxesQuery(ownerId, excludeTaskId, db),
  ]);
  return Number(open?.count ?? 0) + Number(pending?.count ?? 0);
}

/**
 * Check a box start without running anything. Throws a {@link BoxGateError}
 * on refusal. Takes no lock, so two concurrent starts can both pass the
 * concurrency check; use {@link withBoxGate} around the insert that creates
 * the box's row.
 */
export async function checkBoxGate(ownerId: string, options: BoxGateOptions): Promise<BoxGateDecision> {
  const pre = await precheckBoxGate(ownerId, options);
  if (!pre.enforced || skipsConcurrency(options)) return pre;
  await assertConcurrency(ownerId, pre.tier!, options);
  return pre;
}

/**
 * Run `fn` (which creates or re-activates one box's worth of work) unless the
 * owner's plan refuses it. When billing is enabled, refuses in this order:
 *
 * 1. {@link SizeRequiresProError}: the tier may not start `size` (unattended
 *    callers get `small` instead, reported on the decision).
 * 2. {@link UsageExhaustedError}: no included hours, no credits, and auto
 *    top-up cannot buy more.
 * 3. {@link ConcurrentBoxLimitError}: boxes in use ≥ the tier's cap.
 *
 * `fn` receives the decision, whose `size` is the one to start.
 *
 * Race safety: only the concurrency check needs it, and only on Free (a cap of
 * 2, where losing a race doubles the allowance). That check runs under a
 * per-owner transaction-scoped advisory lock, held until `fn`'s insert
 * commits (route path) or inside one pool transaction that also runs the count
 * and `fn` (watcher path, no second connection); pglite skips
 * it. Paid tiers (a cap of 100) skip the lock: a lost race costs one box.
 * Size and budget are read before the lock, so the lock is never held across
 * the budget's charge step.
 */
export async function withBoxGate<T>(
  ownerId: string,
  options: BoxGateOptions,
  fn: (decision: BoxGateDecision) => Promise<T>
): Promise<T> {
  const pre = await precheckBoxGate(ownerId, options);
  if (!pre.enforced || skipsConcurrency(options)) return fn(pre);
  const tier = pre.tier!;
  const assertWithinCap = (db?: Database) => assertConcurrency(ownerId, tier, options, db);
  if (PLAN_LIMITS[tier].concurrentBoxes > SERIALIZE_AT_OR_BELOW) {
    await assertWithinCap();
    return fn(pre);
  }
  return withOwnerSerialized(`boxGate:${ownerId}`, assertWithinCap, () => fn(pre));
}

/** Caps at or below this serialize per owner; see {@link withBoxGate}. */
const SERIALIZE_AT_OR_BELOW = 2;

/** A replacement, or a box already counted, adds nothing to the concurrency count. */
function skipsConcurrency(options: BoxGateOptions): boolean {
  return options.replacesBox === true || options.existingBox === 'awake';
}

async function precheckBoxGate(ownerId: string, options: BoxGateOptions): Promise<BoxGateDecision> {
  if (!billingEnabled()) {
    return { enforced: false, tier: null, size: options.size, downgraded: false };
  }
  const { tier } = await deriveTier(ownerId);
  if (options.unmetered) return { enforced: true, tier, size: options.size, downgraded: false };
  const sized = options.existingBox
    ? { size: options.size, downgraded: false }
    : decideBoxSize(tier, options.size, options.unattended ?? false);
  if (sized === 'refuse') {
    throw new SizeRequiresProError({ tier, size: options.size, workspaceId: options.workspaceId });
  }
  const decision: BoxGateDecision = { enforced: true, tier, ...sized };
  if (options.replacesBox) return decision;

  const budget = await getBudget(ownerId);
  if (!budgetAllowsNewBox(budget) || budget.exhausted) {
    throw new UsageExhaustedError({ tier: budget.tier, periodEnd: budget.period.end, workspaceId: options.workspaceId });
  }
  return decision;
}

async function assertConcurrency(
  ownerId: string,
  tier: PlanTier,
  options: BoxGateOptions,
  db?: Database
): Promise<void> {
  const limit = PLAN_LIMITS[tier].concurrentBoxes;
  const active = await countBoxesInUse(ownerId, options.excludeTaskId, db);
  if (active >= limit) throw new ConcurrentBoxLimitError(limit, active, tier, options.workspaceId);
}

/** The count-then-act choreography for a small cap. */
async function withOwnerSerialized<T>(
  lockName: string,
  assertWithinLimit: (db?: Database) => Promise<void>,
  fn: () => Promise<T>
): Promise<T> {
  if (!isRealPostgres()) {
    await assertWithinLimit();
    return fn();
  }

  const scoped = getScopedDb();
  if (scoped) {
    // Route path: piggyback on the request's ownerScope transaction so the
    // lock outlives the check AND the insert, releasing only at commit.
    const key = advisoryLockKey(lockName).toString();
    await scoped.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    await assertWithinLimit();
    return fn();
  }

  // Watcher path: ONE pool transaction does the lock, the count and `fn`'s
  // writes (installed as the scoped handle). A WAITER holds nothing: it tries
  // the lock, and on a miss ends its transaction (freeing the connection) and
  // sleeps outside it before retrying. A blocking wait held one pooled
  // connection per waiter, so a burst could starve the holder of the second
  // connection a gated callback may still take (2026-09-30). Commit releases
  // the lock, so the next caller's count sees this caller's row.
  const key = advisoryLockKey(lockName).toString();
  const deadline = Date.now() + BOX_GATE_MAX_WAIT_MS;
  for (;;) {
    const outcome = await getPoolDbClient().transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const res = await txDb.execute(sql`select pg_try_advisory_xact_lock(${key}::bigint) as acquired`);
      const row = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] })?.rows?.[0]) as
        | { acquired?: unknown }
        | undefined;
      if (!row?.acquired) return { acquired: false as const };
      const result = await runInScopedDb(txDb, async () => {
        await assertWithinLimit(txDb);
        return fn();
      });
      return { acquired: true as const, result };
    });
    if (outcome.acquired) return outcome.result;
    if (Date.now() >= deadline) throw new BoxGateBusyError(lockName);
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 175));
  }
}

/** How long a gate caller waits for the per-owner lock before giving up. */
const BOX_GATE_MAX_WAIT_MS = 10_000;

/**
 * The per-owner gate lock stayed busy for the whole wait. Transient: not a
 * plan refusal (so no 402), and the unattended callers' ordinary retry
 * (due-scan, watcher tick) picks the start up again.
 */
export class BoxGateBusyError extends Error {
  constructor(readonly lockName: string) {
    super(`The box gate for ${lockName} is busy; try again shortly.`);
    this.name = 'BoxGateBusyError';
  }
}

/**
 * Gate for re-activating an existing task (retry / start / PATCH to an active
 * status). Counts every box except the task itself. `options` carries the
 * run's real size and whether it is metered (see `taskBoxGateOptions` in
 * `taskCreate.ts`); without it the task is checked as a standard box.
 */
export async function assertCanActivateTask(
  ownerId: string,
  taskId: string,
  options: Omit<BoxGateOptions, 'excludeTaskId'> = { size: 'standard' }
): Promise<void> {
  await withBoxGate(ownerId, { ...options, excludeTaskId: taskId }, async () => undefined);
}

// ---------------------------------------------------------------------------
// Feature gates
// ---------------------------------------------------------------------------

/**
 * Thrown when a tier without auto features tries to turn ON the workspace
 * default "auto-keep new PRs mergeable".
 *
 * A FEATURE gate rather than a usage cap: there is no free version of this,
 * so the 402 carries its own code and the client pitches Pro instead of
 * quoting a limit the user is not at.
 */
export class AutoKeepDefaultPlanError extends Error {
  readonly code = AUTO_KEEP_DEFAULT_ERROR_CODE;
  constructor() {
    super(
      'Auto-keeping every new PR mergeable is a Pro feature. ' +
        'Upgrade to turn it on, or arm individual PRs by hand.'
    );
    this.name = 'AutoKeepDefaultPlanError';
  }
}

/**
 * Thrown when a tier without auto features tries to turn ON "review my new
 * pull requests automatically". A FEATURE gate, like AutoKeepDefaultPlanError.
 */
export class AutoReviewPlanError extends Error {
  readonly code = AUTO_REVIEW_ERROR_CODE;
  constructor() {
    super(
      'Reviewing every new pull request automatically is a Pro feature. ' +
        'Upgrade to turn it on, or review pull requests one at a time.'
    );
    this.name = 'AutoReviewPlanError';
  }
}

/**
 * Gate for turning ON the workspace default "auto-keep new PRs mergeable".
 * Pro and Legacy Pro may; Free may not.
 *
 * Callers MUST only invoke this on an OFF→ON transition. A workspace that
 * already has the setting on predates the gate and keeps it. Turning it off
 * is always allowed, and gives that grandfathered state up.
 */
export async function assertCanEnableAutoKeepDefault(ownerId: string): Promise<void> {
  if (!(await ownerHasAutoFeatures(ownerId))) throw new AutoKeepDefaultPlanError();
}

/**
 * Gate for turning ON automatic review of every new pull request. Pro and
 * Legacy Pro may; Free may not. Asserted on the OFF→ON transition only.
 */
export async function assertCanEnableAutoReview(ownerId: string): Promise<void> {
  if (!(await ownerHasAutoFeatures(ownerId))) throw new AutoReviewPlanError();
}

// ---------------------------------------------------------------------------
// Billing status
// ---------------------------------------------------------------------------

/**
 * The team a user holds a seat on, or else the one they administer. At most
 * one of each exists: a GitHub id is unique across `team_seats`, and team
 * creation refuses a second team to somebody who already administers one.
 * Read on the pool, like {@link entitlementQuery}.
 */
async function loadBillingTeam(ownerId: string): Promise<{
  seatTeam: TeamBillingRow | null;
  membership: Omit<BillingTeamMembership, 'paidPersonallyToo'>;
} | null> {
  const db = getPoolDbClient();
  const [seat] = await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      plan: teamsTable.plan,
      planOverride: teamsTable.planOverride,
      tier: teamsTable.tier,
      polarProductId: teamsTable.polarProductId,
      source: teamSeatsTable.source,
    })
    .from(usersTable)
    .innerJoin(teamSeatsTable, eq(teamSeatsTable.githubUserId, usersTable.githubUserId))
    .innerJoin(teamsTable, eq(teamsTable.id, teamSeatsTable.teamId))
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const adminRows = await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      plan: teamsTable.plan,
      planOverride: teamsTable.planOverride,
      polarProductId: teamsTable.polarProductId,
    })
    .from(teamAdminsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamAdminsTable.teamId))
    .where(eq(teamAdminsTable.userId, ownerId));

  // Whether this user is the ONLY admin of a team: they cannot leave it, or
  // give up the role, until somebody else holds it.
  const isSoleAdminOf = async (teamId: string): Promise<boolean> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(teamAdminsTable)
      .where(eq(teamAdminsTable.teamId, teamId));
    return Number(row?.n ?? 0) === 1;
  };

  if (seat) {
    const isAdmin = adminRows.some((a) => a.id === seat.id);
    return {
      seatTeam: seat,
      membership: {
        id: seat.id,
        name: seat.name,
        isAdmin,
        hasSeat: true,
        soleAdmin: isAdmin && (await isSoleAdminOf(seat.id)),
        seatSource: seat.source === 'org' ? 'org' : 'named',
        active: teamGrantsSeats(seat),
      },
    };
  }
  const admin = adminRows[0];
  if (!admin) return null;
  return {
    seatTeam: null,
    membership: {
      id: admin.id,
      name: admin.name,
      isAdmin: true,
      hasSeat: false,
      soleAdmin: await isSoleAdminOf(admin.id),
      active: teamGrantsSeats(admin),
    },
  };
}

/** List prices the clients draw. Max is added per account by {@link billingPricingFor}. */
export const BILLING_PRICING: BillingPricing = {
  proMonthlyMicros: PLAN_PRICES.pro.monthlyMicros,
  proAnnualMicros: PLAN_PRICES.pro.annualMicros ?? 0,
  legacyProMonthlyMicros: PLAN_PRICES.legacy_pro.monthlyMicros,
  boxHourMicros: BOX_HOUR_PRICE_MICROS,
};

/**
 * The prices one account sees. Max's price is sent when this deployment sells
 * Max or the account already holds it, so a client offers Max exactly when it
 * is there.
 */
export function billingPricingFor(input: { tier: PlanTier; maxOffered: boolean }): BillingPricing {
  if (!input.maxOffered && input.tier !== 'max') return BILLING_PRICING;
  return {
    ...BILLING_PRICING,
    maxMonthlyMicros: PLAN_PRICES.max.monthlyMicros,
  };
}

/** Pure: the period's usage as `BillingStatus.usage` shows it. */
export function usageSummaryFromBudget(budget: UsageBudget, resets = 0): UsageSummary {
  return {
    periodStart: budget.period.start.toISOString(),
    periodEnd: budget.period.end.toISOString(),
    includedWsec: budget.includedWsec,
    usedWsec: budget.usedWsec,
    percent: usagePercent(budget.usedWsec, budget.includedWsec),
    exhausted: budget.exhausted,
    resets,
  };
}

/** The owner's auto top-up settings and this month's state. Defaults when they never saved any. */
export async function readAutoTopupSettings(ownerId: string, now = new Date()): Promise<AutoTopupSettings> {
  const [row] = await getPoolDbClient()
    .select({
      enabled: autoTopupSettingsTable.enabled,
      triggerMicros: autoTopupSettingsTable.triggerMicros,
      pack: autoTopupSettingsTable.pack,
      monthlyLimitMicros: autoTopupSettingsTable.monthlyLimitMicros,
      monthKey: autoTopupSettingsTable.monthKey,
      monthSpentMicros: autoTopupSettingsTable.monthSpentMicros,
      lastFailure: autoTopupSettingsTable.lastFailure,
      lastFailureAt: autoTopupSettingsTable.lastFailureAt,
    })
    .from(autoTopupSettingsTable)
    .where(eq(autoTopupSettingsTable.ownerId, ownerId))
    .limit(1);
  if (!row) return { ...AUTO_TOPUP_DEFAULTS, monthSpentMicros: 0, lastFailure: null, lastFailureAt: null };
  return {
    enabled: row.enabled,
    triggerMicros: Number(row.triggerMicros),
    pack: isCreditPackId(row.pack) ? row.pack : AUTO_TOPUP_DEFAULTS.pack,
    monthlyLimitMicros: Number(row.monthlyLimitMicros),
    monthSpentMicros: row.monthKey === autoTopupMonthKey(now) ? Number(row.monthSpentMicros) : 0,
    lastFailure: row.lastFailure,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
  };
}

async function readCreditSummary(ownerId: string, now: Date): Promise<CreditSummary> {
  const lots = await liveLots(ownerId, now);
  return {
    balanceMicros: creditBalanceMicros(lots, now),
    expiringSoonMicros: expiringSoonMicros(lots, now),
    lots,
  };
}

/**
 * The period of the subscription that grants the tier: the user's own
 * product, or the team's when a seat grants it. Null for free, a comp
 * override or an unknown product.
 */
export function billingPeriodOf(
  source: TierResolution['source'],
  userProductId: string | null | undefined,
  teamProductId: string | null | undefined
): 'monthly' | 'annual' | null {
  if (source === 'subscription') return subscriptionPeriod(userProductId, 'personal');
  if (source === 'team') return subscriptionPeriod(teamProductId, 'team');
  return null;
}

/**
 * The full billing snapshot served by `GET /billing/status` and pushed on
 * the `subscription:updated` WS event.
 *
 * The old fields stay so released clients keep working: `plan` is the tier
 * (old Unlimited subscribers read `legacy_pro`, old comps `pro`),
 * `activeTasks`/`activeTaskLimit` are the boxes in use against the concurrent
 * cap, and the removed count caps report `null` (unlimited). The usage fields
 * are sent only when billing is configured; a client reads their absence as
 * "draw the old view".
 *
 * Reads the budget WITHOUT charging: the charge step itself calls this to
 * push a fresh snapshot, and the meter charges every minute.
 */
export async function buildBillingStatus(ownerId: string): Promise<BillingStatus> {
  const [boxesInUse, queuedPrs, workflows, loops, activeReviews] = await Promise.all([
    countBoxesInUse(ownerId),
    countQueuedPrs(ownerId),
    countOwnerWorkflows(ownerId),
    countOwnerLoops(ownerId),
    countActiveReviewCycles(ownerId),
  ]);
  const uncapped = {
    queuedPrs,
    mergeQueueLimit: null,
    workflows,
    workflowLimit: null,
    loops,
    loopLimit: null,
    activeReviews,
    activeReviewLimit: null,
  };
  if (!billingEnabled()) {
    return {
      billingEnabled: false,
      plan: 'pro',
      planSource: 'billing_disabled',
      cancelAtPeriodEnd: false,
      activeTasks: boxesInUse,
      activeTaskLimit: null,
      ...uncapped,
    };
  }

  const rows = await getDbClient()
    .select({
      plan: usersTable.plan,
      planOverride: usersTable.planOverride,
      polarProductId: usersTable.polarProductId,
      subscriptionStatus: usersTable.subscriptionStatus,
      currentPeriodEnd: usersTable.currentPeriodEnd,
      cancelAtPeriodEnd: usersTable.cancelAtPeriodEnd,
    })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const row = rows[0];
  const teamContext = await loadBillingTeam(ownerId);
  const resolution = deriveTierResolution(row, teamContext?.seatTeam ?? null);
  const { tier } = resolution;
  const limits = PLAN_LIMITS[tier];
  const team = teamContext
    ? {
        ...teamContext.membership,
        paidPersonallyToo: teamContext.membership.hasSeat && hasGrantingSubscription(row?.plan),
      }
    : undefined;

  const now = new Date();
  const [budget, credits, autoTopup] = await runWithoutScope(() =>
    Promise.all([
      readBudget(ownerId, now, { tier, periodAnchor: resolution.periodAnchor }),
      limits.creditsAllowed ? readCreditSummary(ownerId, now) : Promise.resolve(undefined),
      limits.creditsAllowed ? readAutoTopupSettings(ownerId, now) : Promise.resolve(undefined),
    ])
  );
  const resets = await runWithoutScope(() => countUsageResets(ownerId, budget.period.start));
  const reset = usageResetAvailability({ tier, usedWsec: budget.usedWsec });

  return {
    billingEnabled: true,
    plan: tier,
    planSource: resolution.source,
    ...(team ? { team } : {}),
    ...(row?.subscriptionStatus ? { subscriptionStatus: row.subscriptionStatus } : {}),
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    ...(row?.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd.toISOString() } : {}),
    period: billingPeriodOf(resolution.source, row?.polarProductId, teamContext?.seatTeam?.polarProductId),
    activeTasks: boxesInUse,
    activeTaskLimit: limits.concurrentBoxes,
    ...uncapped,
    tier,
    usage: usageSummaryFromBudget(budget, resets),
    ...(credits ? { credits } : {}),
    ...(autoTopup ? { autoTopup } : {}),
    sizePrices: sizePriceTable(tier),
    concurrentBoxes: { used: boxesInUse, limit: limits.concurrentBoxes },
    pricing: billingPricingFor({ tier, maxOffered: maxPlanOffered() }),
    ...(reset.ok ? { usageReset: reset.offer } : {}),
  };
}

// ---------------------------------------------------------------------------
// Counts (still reported on the billing status; none of them is capped)
// ---------------------------------------------------------------------------

/**
 * Active tasks across the owner's workspaces. Exported unexecuted so the
 * egress test can `.toSQL()` it: a pure count that must never ship task
 * columns (transcript!) to the backend.
 */
export function countActiveTasksQuery(ownerId: string, excludeTaskId?: string) {
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    inArray(tasksTable.status, [...ACTIVE_TASK_STATUSES]),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** How many active tasks the owner has right now, across all their workspaces. */
export async function countActiveTasks(ownerId: string, excludeTaskId?: string): Promise<number> {
  const rows = await countActiveTasksQuery(ownerId, excludeTaskId);
  return rows[0]?.count ?? 0;
}

/**
 * The owner's queued PRs, exported unexecuted for the egress test: must
 * never ship pull_requests columns (lastSummary!). The `state = 'open'`
 * guard is belt-and-braces: merge/close clears mergeQueued.
 */
export function countQueuedPrsQuery(ownerId: string, excludePrIds?: string | string[]) {
  const exclude =
    excludePrIds === undefined ? [] : Array.isArray(excludePrIds) ? excludePrIds : [excludePrIds];
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    eq(pullRequestsTable.mergeQueued, true),
    eq(pullRequestsTable.state, 'open'),
  ];
  if (exclude.length === 1) conditions.push(ne(pullRequestsTable.id, exclude[0]!));
  else if (exclude.length > 1) conditions.push(notInArray(pullRequestsTable.id, exclude));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(pullRequestsTable)
    .innerJoin(workspacesTable, eq(pullRequestsTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** How many PRs the owner has in the merge queue, across all their workspaces. */
export async function countQueuedPrs(ownerId: string, excludePrIds?: string | string[]): Promise<number> {
  const rows = await countQueuedPrsQuery(ownerId, excludePrIds);
  return rows[0]?.count ?? 0;
}

/**
 * Workflow definitions across the owner's workspaces. Exported unexecuted for
 * the egress test: the row's three jsonb columns must not ship to count.
 */
export function countOwnerWorkflowsQuery(ownerId: string) {
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(workflowsTable)
    .innerJoin(workspacesTable, eq(workflowsTable.workspaceId, workspacesTable.id))
    .where(eq(workspacesTable.ownerId, ownerId));
}

export async function countOwnerWorkflows(ownerId: string): Promise<number> {
  const rows = await countOwnerWorkflowsQuery(ownerId);
  return rows[0]?.count ?? 0;
}

/**
 * Loop definitions across the owner's workspaces. Exported unexecuted for the
 * egress test: a loop's prompt can be thousands of characters.
 */
export function countOwnerLoopsQuery(ownerId: string) {
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(loopsTable)
    .innerJoin(workspacesTable, eq(loopsTable.workspaceId, workspacesTable.id))
    .where(eq(workspacesTable.ownerId, ownerId));
}

export async function countOwnerLoops(ownerId: string): Promise<number> {
  const rows = await countOwnerLoopsQuery(ownerId);
  return rows[0]?.count ?? 0;
}

/**
 * Code-review cycles in flight (phase not at rest) across the owner's
 * workspaces. Exported unexecuted for the egress test.
 */
export function countActiveReviewCyclesQuery(ownerId: string, excludeReviewId?: string) {
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    inArray(prCodeReviewsTable.phase, CODE_REVIEW_ACTIVE_PHASES),
  ];
  if (excludeReviewId) conditions.push(ne(prCodeReviewsTable.id, excludeReviewId));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(prCodeReviewsTable)
    .innerJoin(workspacesTable, eq(prCodeReviewsTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

export async function countActiveReviewCycles(ownerId: string, excludeReviewId?: string): Promise<number> {
  const rows = await countActiveReviewCyclesQuery(ownerId, excludeReviewId);
  return rows[0]?.count ?? 0;
}
