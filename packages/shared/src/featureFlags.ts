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
  /**
   * The env var that overrides PostHog entirely. Break glass + local dev.
   *
   * OPTIONAL, because a flag may deliberately have none — see `mcpServers`,
   * whose audience is PostHog's alone. Absent means there is no way to answer
   * this flag without PostHog, which is a real cost and not a simplification:
   * the override is what lets somebody run the feature locally with no PostHog
   * project, and what answers the flag when PostHog is the broken thing.
   */
  readonly envOverride?: string;
  /**
   * The answer when PostHog is not configured, is unreachable, or does not
   * know the flag. Chosen per flag: the two live flags have deliberately
   * OPPOSITE polarities, and collapsing them to one default would silently
   * flip one of them.
   */
  readonly fallback: boolean;
  /** What the flag gates, for the operator reading a log line. */
  readonly description: string;
  /**
   * Announcement policy: may the "What's new" modal talk about this feature?
   *
   * `'gated'` means every release highlight tagged with this flag is withheld
   * from EVERYONE — including the accounts the PostHog audience has switched it
   * on for. Flipping this to `'general'` (or deleting the flag outright) is what
   * announces the feature, and the withheld backlog replays at that moment. See
   * `releaseNotes.ts`.
   *
   * Deliberately NOT derived from {@link fallback}. The two agree today, but
   * `fallback` answers "what do we say when PostHog is down" — a question about
   * an outage, not about who has the feature. Deriving one from the other links
   * two policies that are only coincidentally aligned, and the day they diverge
   * the release notes change behaviour with no edit that says so.
   */
  readonly availability: 'general' | 'gated';
  /**
   * The conventional-commit scopes this flag gates, for the release-notes
   * generator. `feat(loops): …` is Loops work by definition, so it is tagged
   * mechanically rather than inferred.
   *
   * Only read for a `'gated'` flag. Not exhaustive, and cannot be: a gated
   * feature's commits do not all carry its scope (`fix(desktop): hide the Loops
   * nav item while loading` is scoped `desktop`). This is the floor — see
   * `scripts/release-notes/generate.mjs` for the second net.
   */
  readonly releaseScopes: readonly string[];
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
    availability: 'general',
    releaseScopes: ['workflows'],
  },

  /**
   * Loops — recurring prompts on a cron schedule.
   *
   * Fallback OFF, and this is the flag where that matters most. Every other
   * gate in this file decides whether a person can reach a surface; a loop
   * decides whether a MACHINE creates paid cloud tasks at 3am with nobody
   * watching. "PostHog is unreachable, so start the schedulers" is a failure
   * that spends the workspace's money and its agent subscription before anyone
   * is awake to see it, so the safe answer when we cannot ask is no.
   *
   * Note the deliberate contrast with `workflows` directly above: both features
   * act on their own, but a workflow only acts when a webhook arrives — a human
   * somewhere pushed a commit or left a review. A loop acts because time passed.
   */
  loops: {
    posthogKey: 'loops',
    envOverride: 'LOOPS_ENABLED',
    fallback: false,
    description: 'Loops — recurring prompts on a cron schedule',
    availability: 'general',
    releaseScopes: ['loops'],
  },

  /**
   * MCP servers — the servers a workspace connects and the fleet wires
   * into every run.
   *
   * Fallback OFF, matching `fleet` rather than `workflows`, and for two
   * reasons that both point the same way. It is
   * fleet-only — PostHog Code has no equivalent — so a workspace that gets it
   * without the fleet gets a page that cannot do anything. And it is the
   * surface where somebody pastes a Stripe key: failing open during a PostHog
   * outage would offer credential storage to accounts nobody decided to offer
   * it to.
   *
   * RELEASED 2026-09-20: `availability` is now 'general', and the PostHog
   * audience went from one email to everybody. The withheld backlog of `mcp`
   * highlights replays to everyone who missed it — Session 124's mechanism
   * doing its job, rather than somebody remembering which releases to
   * re-announce.
   *
   * `fallback` deliberately STAYS false. It answers a different question from
   * `availability`: not "who has this feature" but "what do we say when
   * PostHog is down", and the answer there is still no. This is the surface
   * where somebody pastes a Stripe key, and an outage must not open credential
   * storage to accounts nobody decided to offer it to. It is also still
   * fleet-only, so a workspace without the fleet would get a page that cannot
   * do anything.
   */
  mcpServers: {
    posthogKey: 'mcp-servers',
    // NO env override, deliberately, and alone among these in having none.
    // Tom's call: this flag's audience is PostHog's and nothing else's.
    //
    // The cost is real and worth stating rather than discovering. There is now
    // no way to answer this flag without PostHog — so it cannot be run locally
    // against a deployment with no PostHog project (what `LOOPS_ENABLED=true`
    // is for), and it cannot be switched off if PostHog is the broken thing.
    // The second matters less than it looks: `fallback` is already false, so an
    // outage turns this off rather than on, which is the direction you would
    // have reached for the switch to go anyway.
    fallback: false,
    description: 'MCP servers — connect MCP servers to Talyn Fleet runs',
    availability: 'general',
    releaseScopes: ['mcp'],
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
  /**
   * Review priority — the ranked ordering of the Reviews tab, and the
   * per-user model behind it.
   *
   * Fallback OFF, matching `fleet` rather than `workflows`, for a reason that
   * is about cost rather than caution. The feature's second half is a backfill
   * that spends ~10% of an hour's GitHub GraphQL point budget per viewer to
   * read their review history, and that budget is shared per rate-limit
   * ACCOUNT — an App installation pools it across every workspace on it. "We
   * could not reach PostHog, so start reading everybody's history" would take
   * points away from the poller and the merge queue, which are the things that
   * have to keep working.
   *
   * Two surfaces, one flag, three independent gates:
   *  - `GET /features` decides whether the Reviews sort control offers a third
   *    state at all. Asked about the CALLER, because it is a drawing decision.
   *  - The model endpoint answers `{ installed: false }` when refused, never a
   *    throw: it is read while painting the Reviews page, and a 500 there would
   *    blank the list rather than degrade its ordering.
   *  - The backfill and trainer ask about the workspace OWNER, because a
   *    scheduler has no caller. That is the gate that actually bounds the spend.
   *
   * Ordering itself is a pure client-side function over data already on the
   * wire, so a workspace on the wrong side of this flag pays nothing — it
   * simply keeps the newest/oldest toggle it has today.
   */
  reviewPriority: {
    posthogKey: 'review-priority',
    envOverride: 'REVIEW_PRIORITY_ENABLED',
    fallback: false,
    description: 'Review priority — ranked ordering of the Reviews tab',
    availability: 'gated',
    releaseScopes: ['reviews'],
  },

  fleet: {
    posthogKey: 'talyn-fleet',
    envOverride: 'FLEET_ALLOWED',
    fallback: false,
    description: 'Talyn Fleet — self-hosted Firecracker microVMs',
    // Released 2026-09-16. `availability` and `fallback` say different things
    // and deliberately disagree from here: the feature is announced to
    // everybody, while a PostHog outage still refuses it, because no
    // announcement changes the fact that the fleet is finite hardware running
    // on somebody's own subscription. This is the divergence the two fields
    // were kept separate for.
    availability: 'general',
    releaseScopes: ['fleet'],
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

/** The literal union of flag keys. */
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/** Every key, for iteration (evaluating the whole set, logging at boot). */
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

/** Is this a key the register knows about? Narrows an unvalidated string. */
export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, key);
}

/**
 * The register shape the announcement helpers read.
 *
 * They take one as a PARAMETER rather than closing over {@link FEATURE_FLAGS},
 * and the reason is a gap that opens the moment the last gated flag ships.
 * These helpers decide whether a release highlight is withheld — and the tests
 * covering that used a real flag as their exemplar of "still gated", which had
 * to be re-pointed every time one was released: `workflows` → `loops` →
 * `fleet`. Releasing `fleet` empties the set entirely, so every one of those
 * assertions goes vacuous and the withholding path is untested precisely when
 * nothing exercises it in production either — which is the worst moment for it
 * to quietly break, because the next gated feature is what depends on it.
 *
 * A synthetic register fixes that without mocking a module: the mechanism is
 * tested against flags invented for the test, while the live register is
 * checked separately and by DERIVATION, never by naming a flag.
 */
export type FeatureFlagRegister = Readonly<Record<string, FeatureFlagDefinition>>;

/** The keys in `register` whose highlights are still withheld. */
export function gatedKeysOf(register: FeatureFlagRegister): string[] {
  return Object.keys(register).filter((key) => register[key].availability === 'gated');
}

/**
 * The flags whose features the "What's new" modal must not talk about yet.
 *
 * Computed, never hand-maintained: the previous version of this list lived in
 * `releaseNotes.ts` as a literal array of commit scopes and drifted the first
 * time a gated feature shipped — Loops was announced to every user who could
 * not open it, because nobody remembered to add the scope.
 *
 * **It is legitimately EMPTY when every feature is released.** Nothing should
 * read emptiness as a misconfiguration; it means there is nothing to withhold.
 */
export const GATED_FEATURE_KEYS: FeatureFlagKey[] = gatedKeysOf(
  FEATURE_FLAGS,
) as FeatureFlagKey[];

/** {@link isGatedFeature} against an arbitrary register. */
export function isGatedFeatureIn(
  register: FeatureFlagRegister,
  key: string | null | undefined,
): boolean {
  if (!key) return false;
  return register[key]?.availability === 'gated';
}

/**
 * Is a release highlight tagged with `key` still withheld?
 *
 * An UNKNOWN key is not gated, and that is the point rather than an oversight.
 * A highlight published months ago under a flag that has since been deleted
 * from the register describes a feature everybody now has, so it becomes
 * visible — which is exactly the replay the modal relies on. Deleting the flag
 * and flipping `availability` are two ways to say the same thing.
 */
export function isGatedFeature(key: string | null | undefined): boolean {
  return isGatedFeatureIn(FEATURE_FLAGS, key);
}

/** {@link gateForScope} against an arbitrary register. */
export function gateForScopeIn(
  register: FeatureFlagRegister,
  scope: string | null | undefined,
): string | null {
  if (!scope) return null;
  const needle = scope.trim().toLowerCase();
  for (const key of gatedKeysOf(register)) {
    const scopes = register[key].releaseScopes as readonly string[];
    if (scopes.includes(needle)) return key;
  }
  return null;
}

/**
 * The gate a commit scope implies, or `null` for an ungated scope.
 *
 * Only gated flags can match: once a feature is general its scope must stop
 * tagging, or the release that announces it would tag itself as withheld.
 */
export function gateForScope(scope: string | null | undefined): FeatureFlagKey | null {
  // The cast is sound because the keys come from FEATURE_FLAGS itself.
  return gateForScopeIn(FEATURE_FLAGS, scope) as FeatureFlagKey | null;
}

/**
 * The flags whose subject is the CALLING USER, and therefore the ones
 * `GET /features` can answer.
 *
 * `fleet` is deliberately absent: it is keyed on the workspace OWNER, who is
 * not always the caller, so an account-scoped answer would be wrong for every
 * member of somebody else's workspace. The cloud-provider routes answer that
 * one per workspace instead.
 *
 * `mcpServers` IS here, and the distinction is worth keeping straight: this
 * answer decides what to DRAW, which is a question about the person looking at
 * the screen. Every route gates again on the workspace owner, the way the
 * workflows and loops routes do, so a caller who can see the nav item still
 * cannot act on a workspace the gate refuses.
 */
export const ACCOUNT_FEATURE_FLAGS = [
  'workflows',
  'loops',
  'mcpServers',
  'reviewPriority',
] as const satisfies readonly FeatureFlagKey[];

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
  // A flag with no override can never be answered from the environment, so
  // every caller falls straight through to PostHog and then to `fallback`.
  //
  // Widened through the interface on purpose: `as const satisfies` narrows each
  // entry to its own literal type, and the one without an `envOverride` has no
  // such property to read off the union at all.
  const def: FeatureFlagDefinition = FEATURE_FLAGS[flag];
  const name = def.envOverride;
  if (!name) return undefined;
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}
