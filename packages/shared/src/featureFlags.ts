/**
 * The one register of Talyn's feature flags.
 *
 * # Why PostHog owns the answer now
 *
 * Every gate in this codebase used to be an environment variable — a kill
 * switch (`WORKFLOWS_ENABLED`) or a comma-separated allow-list of emails
 * (`FLEET_ALLOWED_EMAILS`). Three things were wrong with that:
 *
 *  - **Changing who gets a feature is a deploy.** Adding one email to the fleet
 *    allow-list restarts the backend, and a restart is the one moment the
 *    advisory locks in `services/advisoryLock.ts` exist to survive. A rollout
 *    should not cost a production release.
 *  - **There is no percentage, no cohort, and no audience.** An allow-list can
 *    say "these five people". It cannot say "10% of workspaces", "everyone who
 *    has connected GitHub", or "everyone except this one account that is
 *    melting the fleet" — which is what a rollout actually needs.
 *  - **Nothing records the decision.** PostHog already holds the events; a flag
 *    evaluated in PostHog joins the funnel it is supposed to move, so
 *    "did shipping this help" is a question the same tool can answer.
 *
 * So a flag's audience lives in PostHog, and this file is the contract that
 * stops the key from being a string typed twice.
 *
 * # The env var did not go away, and it must not
 *
 * Each flag keeps an `envOverride`, and the override WINS over PostHog. That is
 * deliberate, for two cases that a remote flag service cannot serve:
 *
 *  - **Break glass.** Workflows comment on, label and merge other people's pull
 *    requests. When that goes wrong the person stopping it may be the person
 *    who cannot reach the PostHog UI, and "the flag service is down" must never
 *    be the reason a runaway feature stays on. One env var, one restart, off.
 *  - **Local development and CI.** Neither has a PostHog project key, and a
 *    developer should not have to acquire one to see a page that exists. With
 *    no key configured the backend answers each flag's `fallback`.
 *
 * # Adding a flag — the norm, in four steps
 *
 *  1. Add an entry here. `fallback` is the answer when PostHog cannot be
 *     reached, so pick it by asking "if this service is down, what is the safe
 *     answer?" — `false` for anything that spends money, touches other
 *     people's repositories, or runs on hardware we own; `true` for a released
 *     feature whose flag is only a kill switch.
 *  2. Create the flag in PostHog with the same `posthogKey`.
 *  3. Read it through `services/featureFlags.ts` — never `process.env` at the
 *     call site, or the override precedence gets reimplemented per gate.
 *  4. If a client needs to DRAW something from it, add the key to
 *     `ACCOUNT_FEATURE_FLAGS` so `GET /features` answers it. Drawing is all
 *     that buys: every gated surface is enforced server-side as well, because
 *     a hidden nav item is a decoration that the CLI, the MCP server and plain
 *     `curl` all walk straight past.
 *
 * # Clients read `GET /features`, NOT posthog-js
 *
 * All three front ends already run posthog-js, so `posthog.isFeatureEnabled()`
 * is sitting right there — and it is the wrong call. It evaluates against
 * whatever distinct id the browser happens to hold, with whatever person
 * properties PostHog has ingested, and none of that is guaranteed to match what
 * the backend decided. The visible failure is the worst kind: the nav item
 * renders and the route 403s, or the nav item hides on a feature the user
 * demonstrably has. One evaluation, server-side, answered over `/features`.
 */

/** What a flag declares. */
export interface FeatureFlagDefinition {
  /** The flag key in PostHog. Kebab-case, matching PostHog's own convention. */
  readonly posthogKey: string;
  /** The env var that overrides PostHog entirely. Break glass + local dev. */
  readonly envOverride: string;
  /**
   * The answer when PostHog is not configured, is unreachable, or does not
   * know the flag. Chosen per flag: the two live flags have deliberately
   * OPPOSITE polarities, and collapsing them to one default would silently
   * flip one of them.
   */
  readonly fallback: boolean;
  /** What the flag gates, for the operator reading a log line. */
  readonly description: string;
}

/**
 * Every flag Talyn evaluates.
 *
 * `satisfies` rather than a type annotation, so `FeatureFlagKey` stays the
 * literal union of the keys below instead of widening to `string`.
 */
export const FEATURE_FLAGS = {
  /**
   * Workflows — user-defined PR automation.
   *
   * Released to everybody, so the fallback is ON: an unconfigured deployment
   * and a PostHog outage both keep a shipped feature working. PostHog is what
   * lets it be taken away from one account without taking it from all of them,
   * which the old global boolean could not express.
   */
  workflows: {
    posthogKey: 'workflows',
    envOverride: 'WORKFLOWS_ENABLED',
    fallback: true,
    description: 'Workflows — user-defined PR automation',
  },

  /**
   * Talyn Fleet — the self-hosted Firecracker microVMs.
   *
   * Fallback OFF, and that is the whole point of the gate. The fleet is one
   * box with a memory budget that fits a couple of concurrent runs, and it
   * spends the workspace's own Claude or Codex subscription. "PostHog is
   * unreachable, so let everybody onto the hardware" is the failure this
   * codebase already paid for once with the billing `clientGate`.
   *
   * Separate from `FLEET_ENABLED`, which stays an env var: that one says
   * whether this DEPLOYMENT has fleet hardware and gateway tokens to talk to.
   * No flag can conjure a machine, and a boot-time provider registration
   * should not depend on a network call.
   */
  fleet: {
    posthogKey: 'talyn-fleet',
    envOverride: 'FLEET_ALLOWED',
    fallback: false,
    description: 'Talyn Fleet — self-hosted Firecracker microVMs',
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

/** The literal union of flag keys. */
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/** Every key, for iteration (evaluating the whole set, logging at boot). */
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

/**
 * The flags whose subject is the CALLING USER, and therefore the ones
 * `GET /features` can answer.
 *
 * `fleet` is deliberately absent: it is keyed on the workspace OWNER, who is
 * not always the caller, so an account-scoped answer would be wrong for every
 * member of somebody else's workspace. The cloud-provider routes answer that
 * one per workspace instead.
 */
export const ACCOUNT_FEATURE_FLAGS = ['workflows'] as const satisfies readonly FeatureFlagKey[];

export type AccountFeatureFlagKey = (typeof ACCOUNT_FEATURE_FLAGS)[number];

/**
 * Which features this account may see — the answer to `GET /api/v1/features`.
 *
 * A capability answer, not a settings object: it is evaluated per request from
 * the caller's identity, so a client cannot set it and there is nothing here to
 * persist.
 */
export type Features = Record<AccountFeatureFlagKey, boolean>;

/**
 * Read one flag's env override.
 *
 * Returns `undefined` when the var is unset or blank, which is the normal case
 * and means "ask PostHog". Anything else is parsed generously:
 * `false`/`0`/`off`/`no` are off and EVERYTHING ELSE IS ON.
 *
 * That asymmetry is on purpose. These overrides exist to stop a feature in a
 * hurry, and the two failure modes are not equal: a typo that turns a feature
 * on is noticed in seconds, while a typo that turns one off looks exactly like
 * the outage you were already debugging.
 */
export function readFlagOverride(
  flag: FeatureFlagKey,
  env: Record<string, string | undefined>
): boolean | undefined {
  const raw = (env[FEATURE_FLAGS[flag].envOverride] ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}
