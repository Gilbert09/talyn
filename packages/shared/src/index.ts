// Core types for FastOwl

// A type-only import so `WorkspaceSettings` can name the code-review block. The
// module is re-exported below as well; this is the edge that lets the settings
// interface reference it without a value dependency.
import type { CodeReviewSettings } from './codeReview.js';

// PR mergeable helpers (shared by the desktop button + backend watcher).
export * from './prMergeable.js';

// The CI verdict — required-ness, human gates and the pill's CI status —
// derived once from per-check facts so no front end re-derives it.
export * from './checkVerdict.js';

// External merge queues (trunk.io / GitHub native) — label vocabulary shared by
// the backend pipeline and the desktop badges.
export * from './externalMergeQueue.js';

// Trunk merge-queue ETAs — the merge-eta answer and the one countdown
// formatter both front ends render it with.
export * from './trunkMergeEta.js';

// Split view — the pane rules both front ends apply to the sessions shown side by side.
export * from './splitView.js';

// Stacked-PR linking — the one definition of "B is stacked on A", shared by the
// merge queue's stack drain and both front ends' indented PR lists.
export * from './stacks.js';

// Mobile return targets — the allowlisted `returnTo` contract for GitHub
// connect and Polar checkout/portal flows opened from the mobile app.
export * from './mobileReturn.js';

// Agent skills (SKILL.md) + the run-skill-on-PR prompt builder.
export * from './skills.js';
export * from './skillPrompt.js';

// Editable prompt templates (Settings → Instructions) + the shipped defaults.
export * from './promptTemplates.js';

// Saved PR filters — the one matcher behind the PR list's named filter chips,
// shared so the desktop and web forks can't disagree about what a filter shows.
export * from './prFilters.js';
export * from './pullRequestUrl.js';

// Review priority — the ordering behind the Reviews tab's "Priority" sort.
// Shared for the same reason as prFilters, and more so: two forks disagreeing
// about a filter shows a different SET, which somebody notices; two forks
// disagreeing about a ranking shows a different ORDER, which nobody does.
export * from './prPriority.js';

// The per-user ranking model behind the Priority sort's relevance term — the
// features, the pairwise fit and the blend. Separate from prPriority.ts because
// the split is real: this file is what is LEARNED from a viewer's own history,
// that one is the deterministic rules over live state, and the two can never
// swap members. See the header of either.
export * from './reviewRank.js';
export * from './reviewRankingSnapshot.js';
export * from './reviewRankingLocalLog.js';

// Workflows — user-defined PR automation: the trigger taxonomy, the pure
// matcher the engine and both editors share, and the validator the route 400s
// with. Same argument as prFilters: two copies of the predicate would let one
// workflow claim different matches on each client.
export * from './workflows.js';
export * from './exceptionFilter.js';

// Release notes — the "What's new" feed: version ordering, the commit filter
// the CI generator runs, and the one rule for whether the modal opens.
export * from './releaseNotes.js';

// Feature flags — the register of every flag Talyn evaluates, their PostHog
// keys, their env break-glass overrides and their per-flag fallbacks, plus the
// `Features` shape `GET /features` answers. Shared so a flag key is never a
// string typed twice.
export * from './featureFlags.js';
export * from './privateRoutes.js';

// GitHub health — whether GitHub itself is up, the payload of
// `GET /system/github-health` and of the `github:health` WebSocket event.
export * from './githubHealth.js';

// Loops — recurring prompts on a cron schedule: the schedule arithmetic both
// editors preview from and the scheduler fires on, plus the validator the route
// 400s with. Same argument as workflows: a "next run" the client computes
// differently from the server is a bug nobody can see.
export * from './loops.js';

// MCP servers — the servers a workspace connects and the fleet wires into
// every run. The validator MIRRORS the fleet's own refusals, so somebody hears
// "an MCP url needs a path" while typing rather than as a dispatch that failed
// an hour later.
export * from './mcpServers.js';

// Slack sessions — the /slack routes' contract and the trigger-emoji validator
// both the route and the settings editor run.
export * from './slack.js';

// Code review — AI findings on a pull request, shown in the app rather than
// posted on the PR. The parser and the dedupe key live here because both are
// pure and both have to mean the same thing to the engine that writes findings
// and the app that renders them.
export * from './codeReview.js';

// The fix-run prompt. Beside codeReview rather than inside it because it reaches
// into prMergeable for the publishing dialect, and codeReview is deliberately
// dependency-free so the parser and the dedupe key stay trivially testable.
export * from './reviewFixPrompt.js';

// The agent picker — which agents a workspace can start a task on. One pure
// derivation, shared by the per-PR task menu and the Loop editor on both forks.
export * from './cloudAgents.js';
export * from './fleetAccounts.js';

// The operator console's contract (admin.talyn.dev ⇄ /api/v1/admin).
export * from './admin.js';
export * from './transcript.js';

// SSE framing, shared by the fleet client, the admin SSE proxy, and the
// browser that reads the proxied stream.
export * from './sse.js';

// The public API (`/v1`): token scopes and the token management shapes.
export * from './publicApi.js';

// Workbenches — a branch, an agent chat, a diff and a terminal, in a sandbox or
// a local worktree. Vocabulary, git argv + parsers, the agent CLI stream
// parsers and repository config; pure, so both runtimes share them.
export * from './workbench.js';
// Session background jobs and wake-ups.
export * from './workbenchBackground.js';

// Teams and Spaces: the multiplayer contract of `/teams` and `/spaces`.
export * from './teams.js';
// The context rail's badges: what waits on me in each workspace and space.
export * from './contextAttention.js';
// Insights: per-workspace usage analytics (compute, tokens, output, speed).
export * from './insights.js';
export * from './workbenchTitle.js';
export * from './workbenchBranchName.js';
export * from './workbenchGit.js';
export * from './agentStream.js';
export * from './workbenchConfig.js';
export * from './workbenchDetect.js';
export * from './talynBriefing.js';
export * from './previewDetect.js';
export * from './sandboxSize.js';
export * from './workbenchSandboxStatus.js';
export * from './workbenchStartProgress.js';
export * from './pricing.js';
export * from './bake.js';
export * from './turnTiming.js';
export * from './setupRecipe.js';
export * from './setupLayers.js';
export * from './workbenchPullRequest.js';
export * from './workbenchPlan.js';
export * from './workbenchInstructions.js';
export * from './workbenchMemory.js';
export * from './memoryReview.js';
export * from './workbenchThread.js';
export * from './claudeSessionImport.js';
export * from './sessionLinks.js';
export * from './mobileNotifications.js';

import type { SkillKey, SkillSource, SkillSummary, SkillUsageEntry } from './skills.js';
import type { PromptTemplateSettings } from './promptTemplates.js';
import type { PRFilterDefinition } from './prFilters.js';
import type { MemoryReviewCadence } from './memoryReview.js';
import type { GithubHealth } from './githubHealth.js';
import type {
  AutoTopupConfig,
  AutoTopupSettings,
  BillingPricing,
  ConcurrentBoxUsage,
  CreditPackId,
  CreditSummary,
  PlanTier,
  SellableTier,
  SizePrice,
  UsageResetOffer,
  UsageSummary,
} from './pricing.js';

// ============================================================================
// Workspace
// ============================================================================

/**
 * A workspace's logo. Either an auto-generated identicon (rendered
 * deterministically from `seed`) or a user-uploaded image (a downscaled
 * `data:image/...` URL).
 */
export type WorkspaceLogo =
  | { kind: 'identicon'; seed: string }
  | { kind: 'image'; dataUrl: string };

/**
 * Name given to the workspace every owner is bootstrapped with
 * (`services/workspaceBootstrap.ts`). Deliberately generic: it is minted before
 * the user has connected anything, so there is nothing to name it after yet.
 * Renaming lives in Settings.
 */
export const DEFAULT_WORKSPACE_NAME = 'My workspace';

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
  repos: Repository[];
  integrations: WorkspaceIntegrations;
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  name: string; // e.g., "posthog/posthog"
  url: string;
  defaultBranch: string;
}

export interface WorkspaceIntegrations {
  github?: GitHubIntegration;
  posthog?: PostHogIntegration;
}

export interface GitHubIntegration {
  enabled: boolean;
  accessToken?: string;
  org?: string;
  watchedRepos: string[];
}

export type GitHubOwnerCoverageState =
  | 'not_installed'
  | 'suspended'
  | 'sso_required'
  | 'not_accessible'
  | 'unknown';

export interface GitHubOwnerCoverage {
  owner: string;
  state: GitHubOwnerCoverageState;
  ssoUrl?: string | null;
}

export interface PostHogIntegration {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  host?: string;
}

/**
 * Models a workspace can run PostHog Code tasks on — the ONE list, imported by
 * the Settings picker, the per-task composer, and the backend's fallback. It
 * used to be three hand-maintained copies, which is exactly how the composer
 * ended up offering only Claude 4 models months after Claude 5 shipped.
 *
 * PostHog's run API takes `runtime_adapter` + `model` together and Talyn always
 * sends the `claude` adapter, so the ids here must be ones that adapter accepts:
 * the keys of `CLAUDE_REASONING_EFFORTS_BY_MODEL` in PostHog's
 * `products/tasks/backend/temporal/process_task/utils.py`. That is a narrower set
 * than the LLM gateway's catalog (`GET gateway.us.posthog.com/posthog_code/v1/models`,
 * which also serves `claude-haiku-4-5`, `claude-sonnet-4-5` and every `gpt-*`) —
 * offering a model from the gateway that the tasks runtime doesn't know earns a
 * 400 at dispatch, so don't populate this from there. `posthogCodeModels.test.ts`
 * pins the adapter's catalog so a bad id fails a test rather than a run.
 *
 * Current generation only, most capable first. Older Opus 4.x releases are still
 * ACCEPTED on a stored setting (see `LEGACY_POSTHOG_CODE_MODEL_IDS`) but no longer
 * offered.
 */
export const POSTHOG_CODE_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', blurb: 'Newest Opus, 1M context — the default.' },
  { id: 'claude-fable-5', label: 'Fable 5', blurb: 'Newest of the Claude 5 line.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', blurb: 'Strong and fast.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', blurb: 'The previous Opus flagship.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', blurb: 'Cheapest of the supported set.' },
] as const;

export type PostHogCodeModelId = (typeof POSTHOG_CODE_MODELS)[number]['id'];

/**
 * Model ids the tasks runtime still accepts, and that a workspace may already
 * have pinned, but which the pickers no longer offer.
 *
 * The accepted set has to stay wider than the offered set. The composer used to
 * offer Opus 4.5/4.6/4.7, and a stored value that fails validation falls back to
 * the DEFAULT — so dropping them outright would silently move anyone who pinned
 * Opus 4.5 (deliberately, for cost) onto Opus 5, which is dearer. Their choice
 * keeps working; it just isn't on the menu any more.
 */
export const LEGACY_POSTHOG_CODE_MODEL_IDS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
] as const;

export type LegacyPostHogCodeModelId = (typeof LEGACY_POSTHOG_CODE_MODEL_IDS)[number];

/** Anything valid to have stored on a workspace: offered or legacy. */
export type StoredPostHogCodeModelId = PostHogCodeModelId | LegacyPostHogCodeModelId;

/** Default model for PostHog Code runs when the workspace hasn't picked one. */
export const DEFAULT_POSTHOG_CODE_MODEL_ID: PostHogCodeModelId = 'claude-opus-5';

/**
 * Which LLM API a fleet model belongs to.
 *
 * The fleet builds a run's egress route table from this, and a run reaches
 * exactly one provider — a run dispatched at an OpenAI model has no route to
 * api.anthropic.com at all. So this is not a label: it decides what the microVM
 * can talk to, and getting it wrong is a run that cannot make a single call.
 */
export type FleetProvider = 'anthropic' | 'openai';

/**
 * Models a Talyn Fleet run may use, and which vendor each belongs to.
 *
 * NO LONGER AN ALIAS OF `POSTHOG_CODE_MODELS`, and the split is load-bearing.
 * PostHog's tasks runtime is handed `runtime_adapter: 'claude'` and 400s on a
 * `gpt-*` id, so the two catalogues stopped being the same set the moment the
 * fleet could run Codex. Sharing one list would have offered every PostHog Code
 * user a model their dispatch cannot accept.
 *
 * The Claude half must track https://platform.claude.com/docs/en/about-claude/models/overview
 * (or `GET /v1/models`, which is the same set, live). It is NOT automatically the
 * same as PostHog Code's — that list is PostHog's runtime allow-list, and only
 * PostHog can say what it accepts. Anthropic ships a new flagship faster than
 * anyone remembers to edit this file: Fable 5.1 landed 2026-09-01 and this list
 * still said Fable 5 was the newest a week later. Fable 5.2 landed 2026-11-09.
 *
 * THE CODEX HALF IS WHAT A CHATGPT SUBSCRIPTION MAY USE, which is NOT the same
 * question as what the guest's harness knows. It was built from the harness's
 * model table once, and every id in it — `gpt-5.1-codex`, `gpt-5-codex`,
 * `gpt-5.1` — was later retired from the ChatGPT sign-in path, so every Codex
 * run failed with OpenAI's `"The 'gpt-5.1-codex' model is not supported when
 * using Codex with a ChatGPT account."`. The harness still knew the id; the
 * subscription was no longer entitled to it.
 *
 * The fleet runs on the USER'S OWN ChatGPT subscription, so this list must
 * track https://learn.chatgpt.com/docs/models — specifically its "available
 * with a ChatGPT account" set, not the wider API-key one. OpenAI retires from
 * that path on its own schedule (gpt-5.4 went on 2026-08-31), so treat this
 * catalogue as perishable: see RETIRED_FLEET_MODELS for what happens to a
 * workspace still pinned to one that has gone.
 *
 * Deliberately NOT offered: `gpt-5.3-codex-spark` (Pro-only, and text-only —
 * it cannot drive a harness that has to call tools).
 *
 * Most capable first within each vendor.
 */
export type FleetModelTier = 'flagship' | 'strong' | 'fast' | 'economy';

/**
 * One model in the catalogue. `tier` is a plain string on the wire so that a
 * newer backend can add a tier that an older app does not know: the app then
 * shows the model and only skips it when it maps a tier across agents.
 */
export interface FleetModel {
  id: string;
  label: string;
  provider: FleetProvider;
  tier: FleetModelTier | (string & {});
  blurb: string;
}

/**
 * The catalogue this build ships with. The backend serves it from
 * `GET /models`, and the apps replace their copy with that answer (see
 * `setFleetModelCatalog`). So a new model needs only a backend deploy: the
 * desktop and mobile apps show it without a new release. The apps keep this
 * copy as the fallback before the first answer and when the backend is down.
 */
export const BUNDLED_FLEET_MODELS = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', provider: 'anthropic', tier: 'flagship', blurb: 'Most capable — demanding reasoning.' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', tier: 'flagship', blurb: 'Newest Opus.' },
  { id: 'claude-opus-5', label: 'Opus 5', provider: 'anthropic', tier: 'strong', blurb: 'The previous Opus — 1M context.' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', provider: 'anthropic', tier: 'strong', blurb: 'The previous Fable.' },
  { id: 'claude-fable-5', label: 'Fable 5', provider: 'anthropic', tier: 'strong', blurb: 'An older Fable.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', provider: 'anthropic', tier: 'fast', blurb: 'Strong and fast — the default.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic', tier: 'fast', blurb: 'The previous Sonnet.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic', tier: 'strong', blurb: 'The previous Opus flagship.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', provider: 'anthropic', tier: 'economy', blurb: 'Cheapest of the Claude set.' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', tier: 'flagship', blurb: 'Most capable: the hardest reasoning and coding.' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', tier: 'strong', blurb: 'Near-Astra on complex work, for less.' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', provider: 'openai', tier: 'fast', blurb: 'Fast and efficient: the Codex default.' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', tier: 'economy', blurb: 'Cheapest, for focused high-volume work.' },
] as const satisfies readonly FleetModel[];

/** An id from the bundled catalogue. Use it for constants that the compiler must check. */
export type BundledFleetModelId = (typeof BUNDLED_FLEET_MODELS)[number]['id'];

/**
 * Any fleet model id. Wider than the bundled ids because the live catalogue
 * can hold models that this build has never seen.
 */
export type FleetModelId = BundledFleetModelId | (string & {});

/**
 * Default model for a fleet run on a CLAUDE credential.
 *
 * SONNET, not Opus, and the difference is not small. Fleet runs were served by
 * Opus 5 on every turn and cost $348 in 18.5 hours — about $15.85 a run — on
 * work that is mostly mechanical: rebase, resolve conflicts, re-run CI, answer
 * review threads. Opus earns its price on the investigative runs (see the
 * merge-queue `queue_failure` kind), and a workspace that wants it back can
 * pick it in Settings → Talyn Fleet.
 */
export const DEFAULT_FLEET_MODEL_ID: BundledFleetModelId = 'claude-sonnet-5-5';

/**
 * Default model for a fleet run on a CODEX credential.
 *
 * A workspace that connected only Codex has no Claude token, so the Claude
 * default above would be refused at dispatch for a credential it was never
 * asked for. The dispatch ladder picks between the two by which credential the
 * workspace actually holds.
 */
export const DEFAULT_FLEET_CODEX_MODEL_ID: BundledFleetModelId = 'gpt-6.1-terra';

/**
 * Codex ids that OpenAI has withdrawn from the ChatGPT sign-in path, and what
 * to run instead.
 *
 * NOT the same idea as LEGACY_POSTHOG_CODE_MODEL_IDS, and the difference is
 * the whole reason this exists. Those ids still WORK — they are merely off the
 * menu, so a workspace that pinned one deliberately (for cost) keeps it. These
 * ids are DEAD: every dispatch at one is a 400 from OpenAI and a failed run.
 * Preserving that choice preserves a broken product, so a retired pin is
 * migrated forward instead. This is also what OpenAI's own retirement notice
 * tells you to do ("replace gpt-5.4 with gpt-5.6-terra").
 */
export const BUNDLED_RETIRED_FLEET_MODELS = {
  'gpt-5.1-codex': 'gpt-6.1-terra',
  'gpt-5-codex': 'gpt-6.1-terra',
  'gpt-5.1': 'gpt-6.1-terra',
  'gpt-5.5': 'gpt-6.1-sol',
  'gpt-5.6-sol': 'gpt-6.1-sol',
  'gpt-5.6-terra': 'gpt-6.1-terra',
  'gpt-5.6-luna': 'gpt-6-luna',
} as const satisfies Record<string, BundledFleetModelId>;

export type RetiredFleetModelId = keyof typeof BUNDLED_RETIRED_FLEET_MODELS | (string & {});

/** The catalogue as `GET /models` serves it. */
export interface FleetModelCatalog {
  /** Most capable first within each provider. */
  models: FleetModel[];
  /** The model each agent runs when the workspace has chosen nothing. */
  defaults: Record<FleetAgent, string>;
  /** Withdrawn ids, and the model to run in place of each one. */
  retired: Record<string, string>;
}

export function bundledFleetModelCatalog(): FleetModelCatalog {
  return {
    models: BUNDLED_FLEET_MODELS.map((model) => ({ ...model })),
    defaults: { claude: DEFAULT_FLEET_MODEL_ID, codex: DEFAULT_FLEET_CODEX_MODEL_ID },
    retired: { ...BUNDLED_RETIRED_FLEET_MODELS },
  };
}

/**
 * The live catalogue. Every helper below reads these, so a catalogue from the
 * backend reaches every call site at once.
 *
 * `FLEET_MODELS` and `RETIRED_FLEET_MODELS` are changed IN PLACE, never
 * replaced. Code that imported them keeps the same object, whatever the
 * bundler does with module bindings. On the backend nothing calls
 * `setFleetModelCatalog`, so they always hold the bundled values.
 */
export const FLEET_MODELS: readonly FleetModel[] = BUNDLED_FLEET_MODELS.map((model) => ({ ...model }));
export const RETIRED_FLEET_MODELS: Readonly<Record<string, string>> = { ...BUNDLED_RETIRED_FLEET_MODELS };
const fleetModelDefaults: Record<FleetAgent, string> = {
  claude: DEFAULT_FLEET_MODEL_ID,
  codex: DEFAULT_FLEET_CODEX_MODEL_ID,
};
let fleetModelCatalogSnapshot: FleetModelCatalog = bundledFleetModelCatalog();
const fleetModelCatalogListeners = new Set<() => void>();

const FLEET_PROVIDERS: readonly FleetProvider[] = ['anthropic', 'openai'];
const FLEET_AGENT_PROVIDER: Record<FleetAgent, FleetProvider> = { claude: 'anthropic', codex: 'openai' };

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Check a catalogue from the network. Bad entries are dropped one by one, so a
 * newer backend that adds a provider this build cannot route only hides those
 * models. Returns null when nothing usable is left; keep the current catalogue
 * then.
 */
export function parseFleetModelCatalog(value: unknown): FleetModelCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { models?: unknown; defaults?: unknown; retired?: unknown };
  if (!Array.isArray(raw.models)) return null;

  const models: FleetModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.models) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, label, provider, tier, blurb } = entry as Record<string, unknown>;
    if (!nonEmptyString(id) || !nonEmptyString(label) || !nonEmptyString(tier)) continue;
    if (!FLEET_PROVIDERS.includes(provider as FleetProvider) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label, provider: provider as FleetProvider, tier, blurb: typeof blurb === 'string' ? blurb : '' });
  }
  if (models.length === 0) return null;

  // A default must be a listed model of that agent's vendor. Otherwise use the
  // bundled default if the list still has it, then the vendor's first model.
  const rawDefaults = (raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}) as Record<string, unknown>;
  const runsOn = (id: unknown, agent: FleetAgent) =>
    models.some((model) => model.id === id && model.provider === FLEET_AGENT_PROVIDER[agent]);
  const defaultFor = (agent: FleetAgent, bundled: string): string => {
    const sent = rawDefaults[agent];
    if (runsOn(sent, agent)) return sent as string;
    if (runsOn(bundled, agent)) return bundled;
    return models.find((model) => model.provider === FLEET_AGENT_PROVIDER[agent])?.id ?? bundled;
  };

  const retired: Record<string, string> = {};
  if (raw.retired && typeof raw.retired === 'object') {
    for (const [from, to] of Object.entries(raw.retired as Record<string, unknown>)) {
      if (nonEmptyString(from) && !seen.has(from) && typeof to === 'string' && seen.has(to)) retired[from] = to;
    }
  }

  return {
    models,
    defaults: {
      claude: defaultFor('claude', DEFAULT_FLEET_MODEL_ID),
      codex: defaultFor('codex', DEFAULT_FLEET_CODEX_MODEL_ID),
    },
    retired,
  };
}

/** The live catalogue. The same object until the catalogue changes, so React can compare it. */
export function getFleetModelCatalog(): FleetModelCatalog {
  return fleetModelCatalogSnapshot;
}

/**
 * Replace the live catalogue. Pass the backend's answer as it arrived: it is
 * checked here. Returns whether anything changed. An equal catalogue changes
 * nothing and notifies nobody.
 */
export function setFleetModelCatalog(value: unknown): boolean {
  const next = parseFleetModelCatalog(value);
  if (!next || JSON.stringify(next) === JSON.stringify(fleetModelCatalogSnapshot)) return false;

  (FLEET_MODELS as FleetModel[]).splice(0, FLEET_MODELS.length, ...next.models.map((model) => ({ ...model })));
  const retired = RETIRED_FLEET_MODELS as Record<string, string>;
  for (const id of Object.keys(retired)) delete retired[id];
  Object.assign(retired, next.retired);
  Object.assign(fleetModelDefaults, next.defaults);
  rebuildFleetModelProviders();
  fleetModelCatalogSnapshot = next;
  for (const listener of [...fleetModelCatalogListeners]) listener();
  return true;
}

/** Call `listener` after each change to the live catalogue. Returns the unsubscribe. */
export function subscribeFleetModelCatalog(listener: () => void): () => void {
  fleetModelCatalogListeners.add(listener);
  return () => {
    fleetModelCatalogListeners.delete(listener);
  };
}

/**
 * The model a dispatch should actually ask for, given whatever is stored.
 *
 * Call this at the point the model is CHOSEN, not at the point it is read: the
 * pin can arrive from the task, the workspace, or the environment, and all
 * three needed the same treatment.
 */
export function resolveFleetModel(modelId: string): string;
export function resolveFleetModel(modelId: string | undefined): string | undefined;
export function resolveFleetModel(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  return Object.prototype.hasOwnProperty.call(RETIRED_FLEET_MODELS, modelId)
    ? RETIRED_FLEET_MODELS[modelId]
    : modelId;
}

/**
 * Derived from the catalogue rather than hand-maintained beside it. The two
 * used to be separate and the map was empty, so every model — including one
 * added as OpenAI's — answered 'anthropic' and would have been dispatched with
 * no route to its own API. Rebuilt on each catalogue change.
 */
const FLEET_MODEL_PROVIDERS: Record<string, FleetProvider> = {};

function rebuildFleetModelProviders(): void {
  for (const id of Object.keys(FLEET_MODEL_PROVIDERS)) delete FLEET_MODEL_PROVIDERS[id];
  for (const model of FLEET_MODELS) FLEET_MODEL_PROVIDERS[model.id] = model.provider;
  // A retired id keeps answering its replacement's vendor. The fallback below
  // is 'anthropic', so a workspace still pinned to gpt-5.1-codex would
  // otherwise have its Codex run routed at Anthropic — refused for a Claude
  // credential it never connected, on a model it never picked.
  for (const [id, replacement] of Object.entries(RETIRED_FLEET_MODELS)) {
    const provider = FLEET_MODEL_PROVIDERS[replacement];
    if (provider && !(id in FLEET_MODEL_PROVIDERS)) FLEET_MODEL_PROVIDERS[id] = provider;
  }
}
rebuildFleetModelProviders();

/**
 * Which vendor a fleet model belongs to.
 *
 * An unknown id answers 'anthropic'. That is the back-compat answer, not a
 * guess: every model that existed before this field did was Anthropic's, and a
 * workspace may still have one of them pinned. Guessing 'openai' would turn a
 * stale pin into a 400 at dispatch.
 */
export function fleetProviderForModel(modelId: string | undefined): FleetProvider {
  if (!modelId) return 'anthropic';
  return FLEET_MODEL_PROVIDERS[modelId] ?? 'anthropic';
}

/**
 * The strongest model available for the vendor a given model belongs to.
 *
 * `FLEET_MODELS` is ordered most-capable-first within each provider — the first
 * Anthropic entry is labelled "Most capable", and so is the first OpenAI one
 * — so the top tier is the first entry matching the provider.
 * Stated here rather than assumed at a call site, because the ordering is the
 * whole contract: reordering that list for display would silently change which
 * model a review escalates to.
 *
 * Used by code review, where "how deeply to review" cannot mean reasoning effort
 * — the fleet's create body has no such field — so it means model tier instead.
 * Falls back to the model it was given when the id is unknown (a retired or
 * pinned model), which keeps a run working rather than refusing it.
 */
export function topFleetModelForModel(modelId: string | undefined): string {
  if (!modelId) return modelId ?? '';
  // Looked up DIRECTLY rather than through `fleetProviderForModel`, which
  // defaults an unrecognised id to 'anthropic'. That default is right for
  // deciding which credential to send; it is dangerous here. A retired OpenAI
  // id is unrecognised, so going through it would escalate a Codex run to a
  // Claude model — and the fleet builds the microVM's egress table from the
  // model, so that run would have no route to its own vendor at all.
  //
  // An id we cannot place is therefore returned UNCHANGED. Escalation is an
  // improvement, never a precondition: a pinned or retired model keeps working.
  const provider = FLEET_MODEL_PROVIDERS[modelId];
  if (!provider) return modelId;
  const top = FLEET_MODELS.find((m) => m.provider === provider);
  return top?.id ?? modelId;
}

/** Which agent vendor a workspace connected, as the UI and the wire name it. */
export type FleetAgent = 'claude' | 'codex';

/** The vendor label a fleet model runs under, for a per-task agent picker. */
export function fleetAgentForModel(modelId: string | undefined): FleetAgent {
  return fleetProviderForModel(modelId) === 'openai' ? 'codex' : 'claude';
}

/** That agent's default from the live catalogue — the floor when a workspace has chosen nothing. */
export function defaultFleetModelForAgent(agent: FleetAgent): FleetModelId {
  return fleetModelDefaults[agent === 'codex' ? 'codex' : 'claude'];
}

/** Keep the model's capability tier when a chat moves to the other agent. */
export function fleetModelForAgentSwitch(modelId: string, agent: FleetAgent): FleetModelId {
  const current = FLEET_MODELS.find((model) => model.id === resolveFleetModel(modelId));
  if (!current) return defaultFleetModelForAgent(agent);
  const provider = FLEET_AGENT_PROVIDER[agent];
  return FLEET_MODELS.find((model) => model.provider === provider && model.tier === current.tier)?.id
    ?? defaultFleetModelForAgent(agent);
}

/**
 * What this workspace chose for `agent`, or undefined if it never chose.
 *
 * Deliberately does NOT apply the shipped default: the backend's dispatch
 * ladder has more rungs below the workspace (the environment's model), and a
 * function that always answered would swallow them.
 *
 * Two sources, in order — the per-agent map, then the legacy single
 * `fleetModel`. **Both are vendor-checked.** `fleetModel` holds one model for
 * one vendor, so returning it for the other agent would answer "your Codex
 * model is claude-sonnet-5" — which is not a preference, it is a dispatch that
 * fails for a credential the workspace may not even hold.
 */
export function storedFleetModelForAgent(
  settings: WorkspaceSettings | null | undefined,
  agent: FleetAgent,
): StoredFleetModelId | undefined {
  const belongsToAgent = (value: unknown): value is StoredFleetModelId =>
    isStoredFleetModelId(value) && fleetAgentForModel(value) === agent;

  const chosen = settings?.fleetModels?.[agent];
  if (belongsToAgent(chosen)) return chosen;
  if (belongsToAgent(settings?.fleetModel)) return settings.fleetModel;
  return undefined;
}

/** The model to actually run for `agent` — the workspace's choice, or the default. */
export function fleetModelForAgent(
  settings: WorkspaceSettings | null | undefined,
  agent: FleetAgent,
): string {
  return resolveFleetModel(
    storedFleetModelForAgent(settings, agent) ?? defaultFleetModelForAgent(agent),
  );
}

/** Type guard for a value being a model the pickers currently OFFER. */
export function isPostHogCodeModelId(value: unknown): value is PostHogCodeModelId {
  return typeof value === 'string' && POSTHOG_CODE_MODELS.some((m) => m.id === value);
}

/**
 * Type guard for a value being one the runtime accepts — offered or legacy. Use
 * this when reading a STORED setting; use `isPostHogCodeModelId` when validating
 * something a picker should have produced.
 */
export function isStoredPostHogCodeModelId(
  value: unknown
): value is StoredPostHogCodeModelId {
  return (
    isPostHogCodeModelId(value) ||
    (typeof value === 'string' &&
      (LEGACY_POSTHOG_CODE_MODEL_IDS as readonly string[]).includes(value))
  );
}

/**
 * Type guard for a stored fleet model setting.
 *
 * WIDER than the PostHog guard in both directions, and it has to be. It accepts
 * the Codex ids, which PostHog's `claude` runtime adapter would 400 on — and it
 * still accepts the LEGACY Claude ids, because a stored value that fails
 * validation falls back to the DEFAULT, so narrowing it would silently move a
 * workspace that pinned Opus 4.5 (deliberately, for cost) onto a dearer model.
 *
 * The two guards must not be collapsed into one: `isStoredPostHogCodeModelId`
 * staying Claude-only is what stops a `gpt-*` fleet setting leaking into a
 * PostHog Code dispatch.
 */
export type StoredFleetModelId = FleetModelId | LegacyPostHogCodeModelId | RetiredFleetModelId;

export function isStoredFleetModelId(value: unknown): value is StoredFleetModelId {
  return (
    (typeof value === 'string' && FLEET_MODELS.some((m) => m.id === value)) ||
    // A retired id still VALIDATES so the stored setting is read rather than
    // discarded — `resolveFleetModel` then moves it to a model that can run.
    // Rejecting it here would drop it to the next source in the ladder, which
    // for a Codex-only workspace is the Claude default.
    (typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_FLEET_MODELS, value)) ||
    isStoredPostHogCodeModelId(value)
  );
}

export const DEFAULT_FLEET_SWITCH_AT_PERCENT = 100;
export const MIN_FLEET_SWITCH_AT_PERCENT = 50;

/**
 * Check a `fleetSwitchAtPercent` value from a client. Whole numbers from
 * MIN_FLEET_SWITCH_AT_PERCENT to 100 only.
 */
export function normaliseFleetSwitchAtPercent(
  value: unknown
): { ok: true; value: number } | { ok: false; error: string } {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_FLEET_SWITCH_AT_PERCENT ||
    value > 100
  ) {
    return {
      ok: false,
      error: `settings.fleetSwitchAtPercent must be a whole number from ${MIN_FLEET_SWITCH_AT_PERCENT} to 100`,
    };
  }
  return { ok: true, value };
}

export const DEFAULT_AUTO_ARCHIVE_IDLE_DAYS = 7;
export const MAX_AUTO_ARCHIVE_IDLE_DAYS = 365;

/**
 * Check an `autoArchiveIdleDays` value from a client: a whole number of days
 * from 1 to MAX_AUTO_ARCHIVE_IDLE_DAYS, or 0 or null to turn the archive off.
 * The cap is one year: a longer window is the same as off for a session
 * that keeps a sandbox.
 */
export function normaliseAutoArchiveIdleDays(
  value: unknown
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === 0) return { ok: true, value: null };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_AUTO_ARCHIVE_IDLE_DAYS
  ) {
    return {
      ok: false,
      error: `settings.autoArchiveIdleDays must be a whole number from 1 to ${MAX_AUTO_ARCHIVE_IDLE_DAYS}, or 0 or null to turn it off`,
    };
  }
  return { ok: true, value };
}

export interface WorkspaceSettings {
  /**
   * Days of no activity after which a session is archived on its own.
   * Unset means DEFAULT_AUTO_ARCHIVE_IDLE_DAYS. 0 or null turns it off.
   */
  autoArchiveIdleDays?: number | null;
  /** Unset means sessions archive when their pull request merges. */
  autoArchiveOnMerge?: boolean;
  autoResumeOnLimit?: boolean;
  /** Whether Claude adds its co-author trailer to commits. Unset means true. */
  claudeCoAuthoredBy?: boolean;
  continuousBuild?: ContinuousBuildSettings;
  /**
   * The usage level, in percent, at which a fleet account counts as spent and
   * the next account of the same agent takes over. Unset means
   * DEFAULT_FLEET_SWITCH_AT_PERCENT (100).
   */
  fleetSwitchAtPercent?: number;
  /**
   * When every account is over `fleetSwitchAtPercent`, keep using the selected
   * agent while an account remains below 100%. Unset means false.
   */
  fleetUseFullQuotaWhenAllOver?: boolean;
  /**
   * Which model Talyn Fleet runs use.
   *
   * Unset means the default for whichever agent the workspace connected —
   * Sonnet 5 on Claude, GPT-5.1 Codex on Codex — resolved at dispatch, because
   * only the dispatch knows which credential is actually there. See the note on
   * DEFAULT_FLEET_MODEL_ID for why the Claude default is not Opus.
   *
   * The MODEL carries the vendor: `fleetProviderForModel` reads it, and the
   * fleet builds the microVM's egress route table from that. So this one
   * setting picks both which agent runs and what it can reach.
   */
  fleetModel?: StoredFleetModelId;
  /**
   * The model this workspace picked FOR EACH AGENT, so a choice survives
   * switching away from its vendor and back.
   *
   * `fleetModel` above is still "the default a workspace run uses", and its
   * vendor is still what picks the default agent — that part is unchanged. What
   * it cannot do is remember TWO choices at once, and there are two agents. So
   * picking Codex per task, or flipping the workspace default to Claude and
   * back, fell through to the shipped default and silently discarded whatever
   * had been chosen for the other vendor.
   *
   * Read it through `storedFleetModelForAgent`, never directly: an entry filed
   * under the wrong vendor (hand-edited settings, or a model that later changed
   * hands) must not be handed to an agent that cannot run it.
   */
  fleetModels?: Partial<Record<FleetAgent, StoredFleetModelId>>;
  /** Prefix for every new session branch Talyn names (e.g. `tom/`). Empty or unset: none. */
  sessionBranchPrefix?: string;
  /**
   * Whether session sandboxes get Talyn's built-in skills (`TALYN_SKILL_PACK`),
   * written into the agent's skills directory before each turn. Unset or
   * `true`: on. `false` removes them from the box on the next turn.
   */
  sessionSkillPack?: boolean;
  /**
   * Whether sessions use workspace memory (`workbenchMemory.ts`): the index in
   * the box and the `talyn_memory_*` tools. Unset or `true`: on. `false`: the
   * tools refuse. People can still edit entries in the app.
   */
  sessionMemory?: boolean;
  /**
   * How often Talyn starts a memory review thread that merges overlapping
   * entries and settles contradicting ones (`memoryReview.ts`). Unset: off.
   */
  memoryReview?: MemoryReviewCadence;
  /**
   * Which cloud provider new tasks dispatch to when more than one is connected.
   * A specific provider pins it; `'ask'` makes the desktop prompt per task (and
   * backend auto-fixes fall back to a deterministic order); unset = auto
   * (prefer Talyn Fleet, else PostHog Code — see CLOUD_PROVIDER_ORDER).
   */
  defaultCloudProvider?: CloudProviderType | 'ask';
  /** Which model PostHog Code runs use. Unset = {@link DEFAULT_POSTHOG_CODE_MODEL_ID}. */
  posthogCodeModel?: PostHogCodeModelId;
  /**
   * When on, a newly-tracked open PR the viewer AUTHORED gets "auto-keep
   * mergeable" armed automatically (the watcher fires cloud fix runs to keep it
   * mergeable until it merges). Scoped to authored PRs on purpose — arming it
   * pushes commits, so it must never auto-fire on someone else's
   * review-requested PR. Individual PRs can still be toggled by hand. Unset = off.
   *
   * **An Unlimited feature.** Turning it ON requires a paid plan
   * ({@link AUTO_KEEP_DEFAULT_ERROR_CODE}), because it commits the account to an
   * open-ended stream of cloud runs — one per PR opened, indefinitely. The gate
   * is on the OFF→ON transition only, so a free workspace that already has it on
   * keeps working; turning it off gives up the grandfathered state, and turning
   * it back on then needs the upgrade. Nothing reads the plan when APPLYING the
   * setting — only when changing it.
   */
  defaultAutoKeepMergeable?: boolean;
  /** GitHub labels the watcher adds (never removes) to every open PR it watches. Empty = off. */
  autoKeepMergeableLabels?: string[];
  /**
   * Whether a fix run may reply to, resolve, or push code for review threads
   * opened by HUMAN reviewers. Absent or `true` is today's behaviour, where
   * human feedback takes priority over a bot's.
   *
   * Set `false` and human threads become read-only context: the agent may read
   * them to understand the PR and does nothing else with them. Asked for by
   * reviewers on PostHog/posthog — an agent replying on their review threads is
   * noise on a conversation between people, and resolving one closes a thread
   * its author had not finished with. Bot threads are unaffected either way;
   * they are the ones nobody wants to triage by hand.
   */
  respondToHumanComments?: boolean;
  /**
   * Code review's posture for this workspace: the depth preset, whether new PRs
   * are reviewed automatically, and the two GitHub writes it is allowed.
   *
   * Workspace-level rather than per-user, and deliberately: two of the four are
   * writes into repositories the workspace owns, one spends the owner's agent
   * subscription and is plan-gated on the owner, and two members must not be
   * able to give one repository two comment policies. Absent means the defaults
   * in `resolveCodeReviewSettings`, which post nothing.
   *
   * Merged by the workspaces PATCH as a DEEP merge, unlike most of this object:
   * the route's jsonb `||` is top-level, so sending one of these four keys would
   * otherwise silently drop the other three. Same treatment `prompts` gets.
   */
  codeReview?: CodeReviewSettings;
  /**
   * How the merge queue drains a (repo, base) group:
   * - `'ordered'` (default): FIFO — one merge in flight per group, each PR
   *   waits its turn. Conservative: same-base merges invalidate the CI of the
   *   PRs behind them, so serializing avoids wasted runs.
   * - `'eager'`: every queued PR is its own head — clean PRs merge (or arm
   *   auto-merge) the moment they're ready, blocked PRs get fix runs
   *   concurrently, nothing waits behind a sibling. Faster, at the cost of
   *   sibling CI churn after each merge.
   */
  mergeQueueMode?: MergeQueueMode;
  /**
   * Workspace overrides for the prompts Talyn hands to cloud agents, keyed by
   * prompt kind (Settings → Instructions). Absent kind = the shipped default.
   */
  prompts?: PromptTemplateSettings;
  /**
   * The user's own named filters over the PR list (My PRs / Reviews), shown as
   * toggle chips on the filter bar's second row. Workspace-scoped so the same
   * views follow the user between the desktop and the web app. Absent = none;
   * the PR pages then show only the "New filter" button.
   */
  prFilters?: PRFilterDefinition[];
  /**
   * PostHog Visual Review — the screenshot-regression gate on posthog/posthog.
   * Absent = off, and off is the only safe default: finalizing REWRITES the
   * committed baseline and greens the gate, so turning it on delegates a
   * human review decision to the queue. See {@link VisualReviewSettings}.
   */
  visualReview?: VisualReviewSettings;
}

/**
 * Visual Review is a HUMAN-DECISION gate: CI diffs screenshots against
 * committed baselines and stays red until a person approves each change. No
 * code an agent can write will ever green it, which is why the queue used to
 * loop — 11 runs on PostHog/posthog#83850 over two days, every one carrying
 * the same 4 unapproved diffs, each fix run pushing a commit that triggered
 * the next run (2026-08-19).
 *
 * With `autoApprove` on, the queue finalizes the run itself (approve-all +
 * commit baseline) rather than dispatching a run that cannot help.
 *
 * Understand what that trades away. Approving is the review — an UNINTENDED
 * regression is baselined and shipped exactly as readily as an intended
 * change, because nothing here can tell them apart. Leave it off and the queue
 * still stops looping; it parks the PR and names the run for a human instead.
 */
export interface VisualReviewSettings {
  /**
   * Finalize the PR's visual review run instead of parking it for a human.
   * Absent/false = park and surface (the safe default).
   *
   * Note the object's PRESENCE is itself the switch for looking at all: with no
   * `visualReview` settings the queue never asks PostHog about a PR, so a
   * workspace whose repos have no visual review pays nothing. Set
   * `{ autoApprove: false }` to get the recognise-and-park behaviour without
   * the queue approving anything.
   */
  autoApprove?: boolean;
  /**
   * PostHog project id owning the visual reviews. Unset = the project on the
   * workspace's PostHog Code integration, which is the same project in every
   * setup seen so far.
   */
  projectId?: string;
}

export type MergeQueueMode = 'ordered' | 'eager';

/**
 * What a NEW workspace's queue does, and only a new one.
 *
 * 'eager' — every queued pull request merges the moment it is clean — is the
 * better default: waiting your turn behind a sibling is the conservative choice
 * and costs the thing people came for. The trade is that each merge invalidates
 * the CI of the entries behind it, which is a re-run rather than a wrong result.
 *
 * Written into `settings` AT CREATION rather than applied as the resolver's
 * fall-back, because those are different claims. A workspace with no
 * `mergeQueueMode` key is not a workspace that wants the new default — it is
 * one that has been draining in order, possibly for months, with entries queued
 * right now. Changing the resolver would reorder those live queues on deploy,
 * having asked nobody.
 */
export const DEFAULT_MERGE_QUEUE_MODE: MergeQueueMode = 'eager';

export interface ContinuousBuildSettings {
  enabled: boolean;
  /** How many code_writing tasks can be in-flight at once. */
  maxConcurrent: number;
  /** If true, wait for user to approve a task before spawning the next. */
  requireApproval: boolean;
}

// ============================================================================
// Environment
// ============================================================================

/**
 * Environment type. Post cloud-only refactor an environment is a
 * secret-free delegation marker — a task assigned to it is handed to the
 * matching cloud provider, which runs the whole agent loop on its own
 * sandbox and opens a PR. Credentials live on the workspace's
 * `integrations` row, not on the env.
 *
 * STALE UNION: rows are actually created with `CloudProviderType` values
 * (see services/cloudProviders/environment.ts — `selfhosted` exists in
 * the DB but not here), and `local`/`remote` are dead daemon-era members
 * nothing creates anymore. Cleanup candidate: collapse this onto
 * `CloudProviderType`.
 */
export type EnvironmentType = 'local' | 'remote' | 'posthog_code';

export type EnvironmentStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  status: EnvironmentStatus;
  config: EnvironmentConfig;
  lastConnected?: string;
  error?: string;
  /**
   * When true, autonomous Claude tasks on this env bypass every
   * permission prompt (bash / edits / MCP trust). Appropriate for
   * throwaway daemon VMs; dangerous for `local`. Defaults to false;
   * toggle from Settings → Environments. See
   * `services/agent.ts` for how this gates the --permission-mode flag.
   */
  autonomousBypassPermissions: boolean;
  /**
   * How tasks on this env are driven + rendered:
   *  - `pty`         (default) spawns the `claude` CLI in an interactive
   *                  PTY. Raw bytes flow through XTerm. Works for every
   *                  env type.
   *  - `structured`  spawns `claude -p --output-format stream-json` and
   *                  consumes JSONL events. Desktop renders a structured
   *                  conversation (markdown text, collapsible tool calls,
   *                  per-tool permission prompts). Slice 1 supports
   *                  `local` envs only.
   */
  renderer: EnvironmentRenderer;
  /**
   * Tool names pre-approved on this env — the structured renderer's
   * PreToolUse hook skips the permission prompt when the requested
   * tool is in this list. Populated by the "Allow always" button in
   * the Approve/Deny UI. Scoped per-env (not per-task) so approvals
   * stick across every task on that machine.
   */
  toolAllowlist: string[];
  /**
   * Version string reported by the daemon on its most recent hello,
   * shape `<pkgVersion>+<shortSha>` (e.g. `0.1.0+a1b2c3d`). Undefined
   * for envs that have never successfully paired. Compared against
   * the backend's own build SHA to surface "stale daemon" warnings.
   */
  daemonVersion?: string;
  /**
   * Opt-in auto-update: when true, the backend triggers this env's
   * daemon self-update on reconnect (and on a periodic scheduler
   * tick) whenever it sees a stale version. Off by default.
   */
  autoUpdateDaemon: boolean;
}

export type EnvironmentRenderer = 'pty' | 'structured';

export type EnvironmentConfig =
  | LocalEnvironmentConfig
  | RemoteEnvironmentConfig
  | PostHogCodeEnvironmentConfig;

export interface LocalEnvironmentConfig {
  type: 'local';
  /** Where the daemon runs — usually the user's hostname, for display. */
  hostname?: string;
  workingDirectory?: string;
}

export interface RemoteEnvironmentConfig {
  type: 'remote';
  /** Where the daemon runs, for UI display. */
  hostname?: string;
  workingDirectory?: string;
}

/**
 * PostHog Code (cloud) env config. Deliberately a marker with no
 * secrets — the personal API key + project id live on the task's
 * workspace `PostHogIntegration` so one set of credentials is shared
 * by every cloud task in the workspace. `projectId`/`host` here are
 * optional display hints only.
 */
export interface PostHogCodeEnvironmentConfig {
  type: 'posthog_code';
  /** Display-only, for parity with the other configs. Unused for cloud. */
  hostname?: string;
  workingDirectory?: string;
  /** Default agent runtime for tasks on this env. */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  /** Default agent model for tasks on this env. */
  model?: string;
}

export type PostHogCodeRuntimeAdapter = 'claude' | 'codex';

// ============================================================================
// Task
// ============================================================================

export type TaskType =
  | 'code_writing'
  | 'pr_response'
  | 'pr_review'
  | 'manual';

/** Types FastOwl delegates to a cloud agent (everything except `manual`). */
export const AGENT_TASK_TYPES: readonly TaskType[] = [
  'code_writing',
  'pr_response',
  'pr_review',
];

/** True if FastOwl dispatches this task to a cloud agent. */
export function isAgentTask(type: TaskType): boolean {
  return type !== 'manual';
}

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  /**
   * The run stopped on purpose because only a person can carry the work
   * forward — a merge gate that repo policy says a human must approve, a
   * credential the sandbox does not hold, a product decision.
   *
   * NOT a failure, and the distinction is expensive to get wrong. Talyn used
   * to record these as `failed`, which is indistinguishable from a crash, so
   * the auto-keep watcher retried: one Visual-Review-gated PR took four runs
   * of ~14 minutes each, and by run two the agent was saying in its own words
   * that it had already asked twice. A refusal is information, and a loop that
   * cannot read it just pays for the same answer again.
   *
   * Entered ONLY on an explicit sentinel from the agent (see
   * `parseNeedsHumanSentinel`) — never inferred from prose, never a default.
   */
  | 'needs_human'
  /**
   * A fleet fix run published and stopped to wait for CI. Its sandbox is
   * suspended, so it bills nothing, and Talyn resumes the same conversation
   * when the PR's checks settle (`services/ciPark.ts`). Active, not terminal:
   * the run is not over, and nothing may reuse or re-dispatch the row.
   * Entered only behind the `ci-park` flag.
   */
  | 'waiting_ci'
  | 'cancelled';

/**
 * Whether a status means the task has stopped for good.
 *
 * THE POINT OF THE `Record` IS THE COMPILER. Adding a member to `TaskStatus`
 * fails to typecheck here until it is classified, and every list below is
 * derived from this one — so a new status cannot silently land on the wrong
 * side of a gate. Before this existed there were six hand-written copies of
 * "which statuses are active" scattered across billing, admin, the PR-fix
 * guard, fleet credentials, the reuse path and the merge-queue triggers, plus
 * two more in the front-end stores. Every one of them was a `string[]` that a
 * new member would have slipped past in silence.
 *
 * "Terminal" here means *this run is over*, not *the work is done*. A terminal
 * task can still be re-dispatched (that is what `redispatchCloudTask` does);
 * what it may no longer do is occupy a plan slot, hold credentials, or keep a
 * watcher waiting on it.
 */
export const TASK_STATUS_TERMINAL: Record<TaskStatus, boolean> = {
  pending: false,
  queued: false,
  in_progress: false,
  completed: true,
  failed: true,
  // Terminal: this RUN is over. The work is not done and a person owes it an
  // answer, but the task is finished with its plan slot, its credentials and
  // its watcher. Recovery is a fresh dispatch, exactly as for `failed`.
  needs_human: true,
  // Active: the run is paused, not over. Its plan slot and its PR stay held.
  waiting_ci: false,
  cancelled: true,
};

const ALL_TASK_STATUSES = Object.keys(TASK_STATUS_TERMINAL) as TaskStatus[];

/**
 * A later fact about a `needs_human` task: what it asked a person for is no
 * longer needed, because the work moved on without it (the merge queue saw the
 * PR approved and green and submitted it, or the PR merged). Stored on
 * `metadata.needsHumanResolved`, NOT as a new `TaskStatus`: the run's own
 * outcome stays as it was, and the status vocabulary stays closed.
 */
export interface NeedsHumanResolution {
  /** ISO time of the resolution. */
  at: string;
  by: 'merge_queue';
  /** Why, for a tooltip. */
  note: string;
}

/**
 * Does this task still need a person? False for every status except
 * `needs_human`, and false for a `needs_human` task whose request was resolved
 * AFTER the run ended. The time check matters: a terminal task row is reused
 * by the next dispatch, so a resolution written for an earlier run must not
 * hide a later run's real request.
 */
export function taskNeedsHumanOpen(
  task: Pick<Task, 'status' | 'metadata' | 'completedAt'>
): boolean {
  if (task.status !== 'needs_human') return false;
  const resolved = task.metadata?.needsHumanResolved as Partial<NeedsHumanResolution> | undefined;
  if (!resolved?.at) return true;
  const resolvedAt = Date.parse(resolved.at);
  if (Number.isNaN(resolvedAt)) return true;
  if (!task.completedAt) return false;
  const completedAt = Date.parse(task.completedAt);
  return Number.isNaN(completedAt) ? false : resolvedAt < completedAt;
}

/** Every task status, for runtime validation of untrusted input. */
export const TASK_STATUSES: readonly TaskStatus[] = ALL_TASK_STATUSES;

/**
 * Statuses that mean a run has stopped. A task in one of these is finished
 * with its slot, its credentials and its watcher.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] =
  ALL_TASK_STATUSES.filter((s) => TASK_STATUS_TERMINAL[s]);

/**
 * Statuses that mean a run is still in flight. Occupies a free-plan slot, may
 * still fetch secrets, and tells "is anything already working this PR?" yes.
 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] =
  ALL_TASK_STATUSES.filter((s) => !TASK_STATUS_TERMINAL[s]);

/** True when `value` is a status this build knows about. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && value in TASK_STATUS_TERMINAL;
}

/**
 * What asked for a run.
 *
 * Persisted to `metadata.source` and stamped on every terminal task event. It
 * exists because "how long do the CI-fix runs take" had no answer: the events
 * carried a task TYPE, and `pr_response` covers the auto-keep watcher, the
 * merge queue, the panel's Fix button and a workflow action alike. Answering
 * it meant matching on the task TITLE in SQL — a display string, overridable
 * per workspace through the prompt templates, and wrong the day one is renamed.
 *
 * Deliberately about the CALLER, not the work. Two sources can build the same
 * prompt — `auto_keep` and `merge_queue` both run `buildMergeablePrompt` — and
 * telling those apart is the whole point: their retry budgets, their costs and
 * their failure modes are separate, and the pair has produced a runaway before.
 *
 * Derived from the array rather than declared beside it, so the union and the
 * runtime list cannot drift apart.
 */
export const TASK_SOURCES = [
  /** A person pressed something. */
  'user',
  /** The auto-keep-mergeable watcher. */
  'auto_keep',
  /** The merge queue's fix run. */
  'merge_queue',
  /** An auto-fix for code review findings. */
  'code_review',
  /** A loop firing on its schedule. */
  'loop',
  /** A workflow action. */
  'workflow',
] as const;

export type TaskSource = (typeof TASK_SOURCES)[number];

/**
 * True when `value` is a source this build knows about.
 *
 * Guards the analytics property: `metadata` is a jsonb blob written by
 * whichever backend version was running, so it can name a source added after
 * this build — which should be dropped rather than sent on as a value no
 * breakdown can explain.
 */
export function isTaskSource(value: unknown): value is TaskSource {
  return typeof value === 'string' && (TASK_SOURCES as readonly string[]).includes(value);
}

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  workspaceId: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  title: string;
  description: string;
  prompt?: string; // Prompt for Claude agent
  repositoryId?: string; // Repository to run the task in
  branch?: string; // Git branch for this task (auto-created for code tasks)
  assignedEnvironmentId?: string;
  result?: TaskResult;
  metadata?: Record<string, unknown>;
  /** The space this task is in. Null or absent: Personal. */
  spaceId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * Structured JSONL event log for tasks driven by the `structured`
   * renderer. One entry per event emitted by the CLI's stream-json
   * output (assistant/tool_use/tool_result/result/etc). Null for
   * PTY-rendered tasks.
   */
  transcript?: AgentEvent[];
}

export interface TaskResult {
  success: boolean;
  summary?: string;
  output?: string;
  error?: string;
  /**
   * Set exactly when the task ended `needs_human`: what the agent needs, in
   * its own words.
   *
   * Deliberately NOT written to `error`. That field is what the admin console
   * renders in its red failure banner, and a correct refusal shown as an error
   * is the bug this whole state exists to fix. An object rather than a bare
   * string so a future `gate` discriminator does not need another shape change.
   */
  needsHuman?: { reason: string };
}

// ============================================================================
// Structured agent events (stream-json renderer)
// ============================================================================

/**
 * A single event from the `claude -p --output-format stream-json --verbose`
 * pipeline. We store these verbatim — shape matches the CLI's output —
 * plus a monotonically-increasing `seq` so reconnecting clients can ask
 * for "everything after N".
 *
 * Deliberately permissive typing: the CLI's stream is still evolving, and
 * we don't want a schema mismatch to drop events we could otherwise
 * render. Renderer should switch on `type` + `subtype` and ignore things
 * it doesn't recognize.
 */
export interface AgentEvent {
  /** Monotonic per-task sequence number, assigned backend-side. */
  seq: number;
  /** The CLI event type: `system` | `assistant` | `user` | `stream_event` | `result` | `rate_limit_event` | ... */
  type: string;
  /** The CLI event subtype (e.g. `init`, `status`, `success`). Not all events have one. */
  subtype?: string;
  /** Session id the CLI assigned to this run. Lets us `--resume` later. */
  session_id?: string;
  /** For assistant/user events — the message content blocks. */
  message?: {
    role?: string;
    content?: unknown;
    [k: string]: unknown;
  };
  /** For `stream_event` — the partial API delta. */
  event?: unknown;
  /** For `result` — final summary. */
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  permission_denials?: Array<{ tool_name: string; tool_use_id?: string; tool_input?: unknown }>;
  usage?: unknown;
  /** Anything else the CLI emits. */
  [k: string]: unknown;
}

// ============================================================================
// WebSocket Events
// ============================================================================

export type WSClientMessage =
  | import('./teams.js').SpaceClientMessage
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; workspaceId: string; capabilities?: string[] }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'debug:filter'; owner: string | null }
  | { type: 'ping' };

export type WSEventType =
  | 'space:presence'
  | 'task:status'
  | 'task:event'
  | 'task:created'
  | 'task:update'
  | 'task:deleted'
  | 'task:files_changed'
  | 'pull_request:updated'
  | 'merge_queue:blocked'
  // One gentle reminder that a queued PR has waited a long time for a
  // required review. Not an alarm: nothing failed and nothing was given up on.
  | 'merge_queue:review_wait'
  | 'auto_keep:needs_human'
  | 'environment:status'
  | 'environment:created'
  | 'connection:status'
  // Per-user billing fact (broadcastToUser) — fired by the Polar webhook
  // handler after a plan change; payload is the fresh BillingStatus.
  | 'subscription:updated'
  // Usage billing, per user (broadcastToUser). One alert per threshold
  // (50/80/100% of included box-hours) per period; payload `UsageAlertEvent`.
  | 'billing:usage_alert'
  // Included hours and credits ran out; new boxes are refused and idle
  // workbench boxes suspend. Payload `UsageExhaustedEvent`.
  | 'billing:exhausted'
  // One workflow evaluated one PR and finished acting. Carries the whole
  // WorkflowRun row, which is what makes the Workflows page's history and its
  // derived stats live rather than poll-shaped.
  | 'workflow:run'
  // One loop firing reached a terminal state. Carries the whole LoopRun row, so
  // the Loops page's history and its derived stats are live rather than
  // poll-shaped — the same reason 'workflow:run' exists.
  | 'loop:run'
  // Workbenches: the row, its deletion, a chat row, a batch of transcript
  // events, and script output. Payload shapes are `WorkbenchWsPayloads`.
  | 'workbench:updated'
  | 'workbench:deleted'
  | 'workbench:chat'
  | 'workbench:event'
  | 'workbench:script'
  | 'workbench:background'
  // GitHub's own health changed (state, or the set of incidents on its status
  // page). Broadcast to all clients; payload is the whole GithubHealth. It
  // holds no tenant data.
  | 'github:health'
  // A Slack trigger needs the user (pick a repository) or could not start a
  // session. Per user (broadcastToUser), fired once per occurrence; payload
  // is `SlackNoticeEvent`.
  | 'slack:notice'
  // Developer debug stream — one event per observed internal activity
  // (HTTP request, poll tick, WS broadcast, …). Broadcast to all clients;
  // the desktop Debug panel tails it. See DebugEvent below.
  | 'debug:event';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: string;
}

// ============================================================================
// Debug Tooling
// ============================================================================

/**
 * Buckets a {@link DebugEvent} into one of the app's internal activity
 * channels. Drives the filter chips in the desktop Debug panel.
 */
export type DebugCategory =
  | 'http' // outbound request to an external service (GitHub, PostHog Code)
  | 'db' // a Postgres query and the (estimated) bytes its result pulled back
  | 'polling' // a poll loop tick
  | 'websocket' // client connect/disconnect, inbound message, outbound broadcast
  | 'event' // in-process domain event (e.g. task:status)
  | 'webhook' // an inbound GitHub webhook delivery (receipt → enqueue → process)
  | 'error'; // an unexpected failure worth surfacing on its own

/**
 * A single observed internal activity. Metadata only — never request/response
 * bodies, auth headers, or tokens (URLs are stripped of their query string at
 * the recording site). Safe to surface in the UI and leave recording on.
 */
export interface DebugEvent {
  /** Monotonic per-process id; also used as a stable React key. */
  id: number;
  timestamp: string;
  category: DebugCategory;
  /** Originating subsystem, e.g. 'github', 'posthog_code', 'pr_monitor', 'ws'. */
  service: string;
  /** What happened, e.g. 'request', 'tick', 'connect', 'broadcast'. */
  action: string;
  /** Whether the activity succeeded (false for a failed request / errored tick). */
  ok: boolean;
  /** Human-readable one-liner for the stream row. */
  summary: string;
  durationMs?: number;
  /** Extra redacted context shown when a row is expanded. */
  meta?: Record<string, unknown>;
  /**
   * The FastOwl account this activity belongs to, when it can be attributed to
   * one (e.g. a GitHub call for a workspace that account owns). null for
   * backend-internal activity not tied to a single account. Used by the
   * admin-only Debug panel to filter by user.
   */
  ownerId?: string | null;
  /** Display label for {@link ownerId} (email or GitHub username). */
  ownerLabel?: string | null;
}

/** A FastOwl account that has debug activity attributed to it. */
export interface DebugOwner {
  ownerId: string;
  label: string;
}

/** Live state of one poll loop, surfaced in the Debug panel snapshot bar. */
export interface DebugPollerState {
  name: string;
  /** Human-readable explanation of what this loop does (shown as a tooltip). */
  description: string;
  /** Current cadence — the live interval, which may be stretched from the base. */
  intervalMs: number;
  /**
   * The un-throttled base cadence. Equals {@link intervalMs} unless the adaptive
   * rate-budget governor has slowed the loop to protect the GitHub budget — then
   * `intervalMs > baseIntervalMs` and the panel flags it as throttled.
   */
  baseIntervalMs: number;
  tickCount: number;
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

/**
 * GitHub GraphQL points budget for one rate-limit account, read off the free
 * `rateLimit { … }` field on our batched queries. GraphQL is a per-account
 * point bucket (≈5,000/hr, scaling to 12,500 / 15,000 on Enterprise Cloud);
 * this surfaces how close an account is to empty and whether non-urgent loops
 * are deferring to protect the reserve.
 */
export interface DebugGraphqlBudget {
  /** Rate-limit account key, e.g. `inst:140694558` (App installation) or a login. */
  accountKey: string;
  /** Max GraphQL points per hour for this account. */
  limit: number;
  /** Points remaining in the current window (optimistically `limit` once it resets). */
  remaining: number;
  /** ISO timestamp when the points window resets to `limit`. */
  resetAt: string;
  /** Point cost of the most recently observed query. */
  lastCost: number;
  /** When this budget was last observed (ISO). */
  observedAt: string;
  /** True while non-urgent loops are deferring work for this account (budget in reserve). */
  deferring: boolean;
}

/**
 * Deferred `mergeable: UNKNOWN` settles since boot.
 *
 * GitHub computes mergeability lazily, so the webhook refresh path (which does
 * not block on it) writes UNKNOWN — a verdict that belongs to no list bucket
 * and hides the merge button. A short-delay re-ask settles it instead of
 * leaving the row for the 5-6 min reconcile sweep. `observed` is how often the
 * hot path lands there; `deferred` + `failed` are the cases that fall back to
 * the sweep exactly as before.
 */
export interface DebugMergeableSettle {
  /** Rows the hot path left on `mergeable: UNKNOWN` (counts repeats). */
  observed: number;
  /** Settles that ran to completion. */
  settled: number;
  /** Skipped — the account's GraphQL points are in the reserve. */
  deferred: number;
  /** The re-ask threw (gated, revoked token, network). */
  failed: number;
  /** PRs queued for a settle right now. */
  pending: number;
  /** Mean wall-clock of a settle, ms. Dominated by GitHub's own compute time. */
  avgSettleMs: number;
}

/** Point-in-time view of the backend's internals for the Debug panel. */
export interface DebugSnapshot {
  pollers: DebugPollerState[];
  /** Lifetime event counts keyed by {@link DebugCategory}. */
  counters: Record<string, number>;
  /** Current number of buffered events. */
  bufferSize: number;
  /** Currently-connected WebSocket clients. */
  wsClients: number;
  /** GitHub GraphQL points budget per account, with deferral status. */
  graphqlBudgets: DebugGraphqlBudget[];
  /** Deferred `mergeable: UNKNOWN` re-asks — see {@link DebugMergeableSettle}. */
  mergeableSettle: DebugMergeableSettle;
  /** Accounts with attributed debug activity, for the per-user filter. */
  owners: DebugOwner[];
  /** Cumulative Postgres query stats since the last clear. */
  dbStats: DebugDbStats;
  /**
   * Webhook consumer lag (enqueue→pickup) over recent processed deliveries —
   * dominated by the fast check_run/check_suite firehose.
   */
  webhookLag: DebugWebhookLag;
  /**
   * Lag of the SLOW lane only: pull_request/review/comment deliveries, which run
   * a bounded-concurrency `refreshPr`. Surfaces a backed-up refresh pool even
   * when the firehose (`webhookLag`) is at zero.
   */
  webhookLagSlow: DebugWebhookLag;
  /**
   * What this replica currently says about GitHub's own health. Null when the
   * monitor is not wired (tests). Optional so an older backend's snapshot
   * still reads.
   */
  githubHealth?: GithubHealth | null;
}

/**
 * How far behind real-time the webhook worker is: the enqueue→pickup latency of
 * recently processed deliveries. A healthy worker sits near zero; a rising
 * `maxMs` means the consumer can't keep up with the ingest stream.
 */
export interface DebugWebhookLag {
  /** Most recent processed delivery's enqueue→pickup lag, ms. */
  lastMs: number;
  /** Median lag across the recent sample window, ms. */
  medianMs: number;
  /** Worst lag in the recent sample window, ms. */
  maxMs: number;
  /** Number of samples behind the figures (0 = nothing processed yet). */
  samples: number;
  /** ISO time of the most recent processed delivery, or null if none yet. */
  observedAt: string | null;
}

/**
 * Running totals for Postgres traffic, surfaced as tiles on the Debug panel.
 * `egressBytes` is an estimate — the serialized size of each query's result
 * rows, not exact wire bytes — but directionally accurate for spotting which
 * queries dominate database egress.
 */
export interface DebugDbStats {
  /** Total queries issued since the last clear. */
  requests: number;
  /** Estimated total bytes returned by those queries since the last clear. */
  egressBytes: number;
}

// ----------------------------------------------------------------------------
// Developer surface (Settings → Developer)
//
// The account's OWN internals. Everything here is scoped to the authenticated
// caller by the backend (`routes/developer.ts`). The cross-account view stays
// on the operator console.
// ----------------------------------------------------------------------------

/** The debug categories a user may read about their own account. */
export type DeveloperActivityCategory = Extract<
  DebugCategory,
  'http' | 'webhook' | 'event' | 'error'
>;

/**
 * The single list of {@link DeveloperActivityCategory} values. The backend
 * allowlist and both front ends read it, so they cannot disagree.
 */
export const DEVELOPER_ACTIVITY_CATEGORIES: readonly DeveloperActivityCategory[] = [
  'http',
  'webhook',
  'event',
  'error',
];

/** One GitHub rate-limit bucket of the workspace's own token. */
export interface DeveloperRateLimitBucket {
  /** GitHub's resource name: `core`, `search`, `graphql`, `code_search`. */
  resource: string;
  limit: number;
  remaining: number;
  used: number;
  /** ISO instant the bucket refills. */
  resetAt: string;
}

/** Talyn's own tracked GraphQL points budget for the workspace's account. */
export interface DeveloperGraphqlBudget {
  limit: number;
  remaining: number;
  /** ISO instant the points window resets. */
  resetAt: string;
  /** Point cost of the most recently observed query. */
  lastCost: number;
  /** ISO instant Talyn last observed this budget. */
  observedAt: string;
  /** True while Talyn defers background refreshes to protect this budget. */
  deferring: boolean;
}

export interface DeveloperRateLimits {
  connected: boolean;
  /** GitHub login of the connected account, when the backend has it cached. */
  login: string | null;
  /** OAuth scopes of the stored token. Empty when not connected. */
  scopes: string[];
  /** Live buckets from GitHub, in display order. Empty when not connected. */
  github: DeveloperRateLimitBucket[];
  graphqlBudget: DeveloperGraphqlBudget | null;
  /**
   * Talyn holds requests back after GitHub rate-limits the account. Each field
   * is the ISO instant that API is gated until, or null when it flows.
   */
  secondaryGate: { restUntil: string | null; graphqlUntil: string | null };
  /** ISO instant the GitHub answer was fetched (it is cached for a few seconds). */
  fetchedAt: string | null;
}

/**
 * A {@link DebugEvent} as its own account may read it. No owner fields, and
 * `meta` holds an explicit allowlist of keys.
 */
export interface DeveloperActivityEvent {
  id: number;
  timestamp: string;
  category: DeveloperActivityCategory;
  service: string;
  action: string;
  ok: boolean;
  summary: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface DeveloperActivity {
  /** The caller's events, newest first. */
  events: DeveloperActivityEvent[];
  /** Computed from `events`, so they always agree with the list. */
  counts: { total: number; failed: number; byService: Record<string, number> };
  /**
   * The backend keeps one rolling buffer for all accounts. These two values
   * say how far back that buffer reaches right now.
   */
  buffer: { capacity: number; oldestAt: string | null };
}

export type DeveloperAgentState = 'ready' | 'reauth' | 'held';

export interface DeveloperAgent {
  agent: FleetAgent;
  state: DeveloperAgentState;
  /** Present when `state` is `held`: a usage limit keeps the agent out of use. */
  hold?: {
    /** ISO instant the limit was observed. */
    heldSince: string;
    /** ISO instant Talyn tries the agent again. */
    retryAfter: string;
    /** The vendor's own sentence about the caller's subscription. */
    detail: string | null;
  };
}

export interface DeveloperAgents {
  agents: DeveloperAgent[];
}

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  result?: TaskResult;
  /**
   * When the run completed, for `completed`; null for every other status.
   * A finished task is reused for the next run at its PR, so without this a
   * client kept the first run's completion time on the second ("Created 33m
   * ago, Completed 3h ago"). Absent from older backends: leave the field as is.
   */
  completedAt?: string | null;
}

export interface TaskUpdateEvent {
  taskId: string;
  updates: Partial<Task>;
}

export interface TaskDeletedEvent {
  taskId: string;
}

/**
 * Fired when a task is created on the BACKEND (merge-queue / auto-keep-mergeable
 * fix runs, or any non-desktop creator). Lets the desktop add it to the task
 * list live, so backend-created tasks show up in the Tasks screen and the PR's
 * task badge deep-links to a real, present task. The desktop dedupes by id, so
 * it's harmless when the creating client already added it optimistically.
 */
export interface TaskCreatedEvent {
  task: Task;
}

/**
 * Fired once when a PR in the FastOwl merge queue exhausts its auto-fix retry
 * budget and transitions into `blocked` — the queue has given up and the PR
 * now needs a human. The desktop turns this into an OS notification + in-app
 * toast. Distinct from the idempotent `pull_request:updated` (which is replayed
 * on reconnect/backfill) so the notification fires exactly once.
 */
export interface MergeQueueBlockedEvent {
  pullRequestId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Short human reason, e.g. "merge conflicts with the base branch". */
  reason: string;
  /** How many fix runs were attempted before giving up. */
  attempts: number;
}

/**
 * Fired once when the auto-keep watcher stands down on a PR because the run it
 * fired reported that only a person can carry it forward.
 *
 * Deliberately NOT the same event as {@link MergeQueueBlockedEvent}, which
 * means "we tried our budget of fixes and gave up". This one means "we tried
 * once, and the answer was a question for you" — no attempts were spent, and
 * the watcher will pick the PR back up on its own the moment the blockers
 * change. Saying "gave up" there would misdescribe both what happened and what
 * happens next.
 *
 * Fires exactly once per stand-down: it is emitted from the accounting branch
 * that runs only while the last run is still unaccounted.
 */
export interface AutoKeepNeedsHumanEvent {
  pullRequestId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** What the agent said it needs, in its own words. */
  reason: string;
  /** The run that reported it, so the client can deep-link to the transcript. */
  taskId: string;
}

/**
 * Fired ONCE per wait when a merge-queue PR has waited a long time (24 hours)
 * for a required review. Worded as a reminder, deliberately not as
 * {@link MergeQueueBlockedEvent}: the queue is not stuck, it is waiting for a
 * person, and it carries on by itself when an approving review lands.
 */
export interface MergeQueueReviewWaitEvent {
  pullRequestId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** When the wait started (ISO). */
  waitingSince: string;
  /** Ready-to-show sentence, e.g. "#126933 is still waiting for a review". */
  message: string;
}

export interface EnvironmentStatusEvent {
  environmentId: string;
  status: EnvironmentStatus;
  error?: string;
}

export interface EnvironmentCreatedEvent {
  environment: Environment;
}

export interface TaskEventBroadcast {
  taskId: string;
  event: AgentEvent;
}

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Machine-readable error discriminator for failures the client must branch
   * on (e.g. TASK_LIMIT_ERROR_CODE → upgrade modal). `error` stays the
   * human-readable message.
   */
  code?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============================================================================
// Billing
// ============================================================================

/**
 * The plan a billing status reports: a usage-billing tier, or `'unlimited'`.
 *
 * `'unlimited'` stays in the union on purpose. Branch builds of the apps talk
 * to the production backend, which still sends the old `'free' | 'unlimited'`
 * model until usage billing ships, and a client must read that without a type
 * error. A backend on usage billing never sends it; it maps old Unlimited
 * subscribers to `legacy_pro` and old comps to `pro`.
 */
export type Plan = PlanTier | 'unlimited';

/*
 * The old free-plan count caps. Usage billing removed them: the backend no
 * longer enforces any of these, and the concurrent-box cap in
 * `PLAN_LIMITS[tier].concurrentBoxes` replaced the active-task cap. The
 * merge-queue (3) and review-cycle (1) constants are deleted. The three below
 * stay ONLY because branch builds of the desktop and web apps talk to the
 * production backend, which still enforces them until usage billing ships
 * (their UpgradeModal and PR-row copy quote them). Delete them, and the
 * matching *_LIMIT_ERROR_CODE constants, once the apps stop reading them.
 */

/** @deprecated Old free-plan active-task cap (3). Read only by the apps' old paywall copy. */
export const FREE_PLAN_ACTIVE_TASK_LIMIT = 3;

/** @deprecated Old free-plan workflow cap (3). Read only by the apps' old paywall copy. */
export const FREE_PLAN_WORKFLOW_LIMIT = 3;

/** @deprecated Old free-plan loop cap (3). Read only by the apps' old paywall copy. */
export const FREE_PLAN_LOOP_LIMIT = 3;

/* MCP servers are deliberately UNCAPPED, on every plan.
 *
 * They were capped at 3 like the old count caps, and that turned out to be the
 * wrong shape for what they are. A task, a queued PR, a workflow and a loop all
 * SPEND something when they exist — agent time, a merge, a firing. A connected
 * MCP server spends nothing until a run uses it, and what a run costs is
 * already bounded by the box it runs in. Charging for the connection was charging
 * twice for one thing.
 *
 * It is also the third time a round number here took away a capability somebody
 * connected on purpose: the fleet's server and tool counts went for the same
 * reason, and its 8KB schema cap after them. */

/** ApiResponse.code when task creation/activation is rejected by the free limit. */
/**
 * Why a queued task has not started yet.
 *
 * Written by the task queue onto `metadata.lastScheduleError`. `capacity` is
 * the field that matters to the UI: a provider being BUSY is not a failure —
 * the task is fine, still queued, and will be retried automatically — and
 * rendering it as one is why "waiting for a runner" looked like something had
 * gone wrong.
 */
export interface TaskScheduleError {
  at: string;
  /** User-facing. Must not carry internal endpoints or stack detail. */
  reason: string;
  attempts: number;
  /** True when the provider was busy or unreachable rather than refusing. */
  capacity?: boolean;
  /** When the queue will try again. Absent once the attempt budget is spent. */
  retryAt?: string;
  /** The attempt budget, so the UI can say "3 of 40" rather than just "3". */
  maxAttempts?: number;
}

/** @deprecated The old active-task cap's 402 code. The production backend still sends it until usage billing ships. */
export const TASK_LIMIT_ERROR_CODE = 'task_limit_reached';

/** @deprecated The old merge-queue cap's 402 code. The production backend still sends it until usage billing ships. */
export const MERGE_QUEUE_LIMIT_ERROR_CODE = 'merge_queue_limit_reached';

/** @deprecated The old workflow cap's 402 code. The production backend still sends it until usage billing ships. */
export const WORKFLOW_LIMIT_ERROR_CODE = 'workflow_limit_reached';

/** @deprecated The old loop cap's 402 code. The production backend still sends it until usage billing ships. */
export const LOOP_LIMIT_ERROR_CODE = 'loop_limit_reached';

/**
 * ApiResponse.code when a tier without auto features (Free) tries to turn ON
 * the workspace default "auto-keep new PRs mergeable". A FEATURE gate, not a
 * usage cap: there is no count to wait out, so the client pitches Pro.
 */
export const AUTO_KEEP_DEFAULT_ERROR_CODE = 'auto_keep_default_requires_unlimited';

/** @deprecated The old review-cycle cap's 402 code. The production backend still sends it until usage billing ships. */
export const REVIEW_CYCLE_LIMIT_ERROR_CODE = 'code_review_limit_reached';

/**
 * ApiResponse.code when a tier without auto features (Free) tries to turn ON
 * "review my new pull requests automatically". A FEATURE gate like
 * AUTO_KEEP_DEFAULT_ERROR_CODE.
 */
export const AUTO_REVIEW_ERROR_CODE = 'auto_review_requires_unlimited';

/**
 * ApiResponse.code (402) when a box cannot start because the period's
 * included box-hours and the credit balance are both spent. A running turn
 * finishes; only NEW boxes are refused. Unattended runs defer instead.
 */
export const USAGE_EXHAUSTED_ERROR_CODE = 'usage_exhausted';

/**
 * ApiResponse.code (402) when the plan may not start the requested sandbox
 * size (Free: small and standard only). A feature gate: the client pitches Pro.
 * Unattended callers get `small` instead of this error.
 */
export const SIZE_REQUIRES_PRO_ERROR_CODE = 'size_requires_pro';

/**
 * ApiResponse.code (402) when the owner already runs as many boxes as the
 * plan allows at once. A usage cap: a slot frees when a box stops.
 */
export const CONCURRENT_BOX_LIMIT_ERROR_CODE = 'concurrent_box_limit_reached';

/** The usage-billing 402 codes, for clients that route them to the upgrade or credits flow. */
export const USAGE_BILLING_ERROR_CODES = [
  USAGE_EXHAUSTED_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
] as const;
export type UsageBillingErrorCode = (typeof USAGE_BILLING_ERROR_CODES)[number];

/**
 * Why an unattended run (a loop firing, a merge-queue or auto-keep fix, a
 * workflow action, an automatic review) did not start a box. Recorded on the
 * run's own history as a visible deferral, never as a failure:
 *
 * - `usage_exhausted`: no included box-hours, no credits, no auto top-up. The
 *   run waits for the period reset or for credits.
 * - `box_limit_reached`: the plan's concurrent-box cap is full. The run waits
 *   for a box to stop.
 * - `size_requires_pro`: the plan cannot start the size. Unattended runs are
 *   downsized instead, so this is not expected; it is not retried.
 */
export type BoxRefusalReason = 'usage_exhausted' | 'box_limit_reached' | 'size_requires_pro';

export const BOX_REFUSAL_REASONS: readonly BoxRefusalReason[] = ['usage_exhausted', 'box_limit_reached', 'size_requires_pro'];

/** The deferral reason for a box gate's 402 code. */
export function boxRefusalReason(code: UsageBillingErrorCode): BoxRefusalReason {
  switch (code) {
    case USAGE_EXHAUSTED_ERROR_CODE:
      return 'usage_exhausted';
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
      return 'box_limit_reached';
    case SIZE_REQUIRES_PRO_ERROR_CODE:
      return 'size_requires_pro';
  }
}

export const BOX_REFUSAL_LABELS: Record<BoxRefusalReason, string> = {
  usage_exhausted: 'Waiting for box-hours or credits',
  box_limit_reached: 'Waiting for a free box',
  size_requires_pro: 'The plan cannot start this box size',
};

/** ApiResponse.code when a team admin assigns more seats than the team pays for. */
export const TEAM_SEATS_FULL_ERROR_CODE = 'team_seats_full';

/**
 * ApiResponse.code when a seat change would leave more people seated than the
 * team pays for, or when the team is already in that state (a seat count
 * lowered in the billing portal). Nobody is un-seated silently; the admin
 * removes seats until the numbers agree.
 */
export const TEAM_OVER_ALLOCATED_ERROR_CODE = 'team_over_allocated';

/**
 * The smallest team a checkout will sell. One is allowed (Tom's call): a
 * company may buy a single seat to get a company invoice, at the same price.
 */
export const TEAM_MIN_SEATS = 1;

/**
 * The user's billing state as served by `GET /billing/status` and pushed on
 * the `subscription:updated` WS event.
 */
export interface BillingStatus {
  /** False when the backend has no Polar env configured — limits are off. */
  billingEnabled: boolean;
  plan: Plan;
  /**
   * 'override' = manually comped (plan_override); 'team' = a team seat pays;
   * 'billing_disabled' when unconfigured.
   */
  planSource: 'default' | 'subscription' | 'override' | 'team' | 'billing_disabled';
  /** The team this user holds a seat on or administers, if any. */
  team?: BillingTeamMembership;
  /** Raw provider subscription status, when a subscription exists. */
  subscriptionStatus?: 'active' | 'past_due' | 'canceled' | 'revoked' | string;
  cancelAtPeriodEnd: boolean;
  /** ISO date the current billing period ends (renewal or expiry). */
  currentPeriodEnd?: string;
  /**
   * The billing period of the subscription that grants the plan: a personal
   * one, or the team's when a seat does. Null for free, a comp or an unknown
   * product; absent on a backend that predates it.
   */
  period?: 'monthly' | 'annual' | null;
  activeTasks: number;
  /** null = unlimited. */
  activeTaskLimit: number | null;
  /** PRs currently in the merge queue, across all the user's workspaces. */
  queuedPrs: number;
  /** null = unlimited. */
  mergeQueueLimit: number | null;
  /** Workflow definitions the user owns, across all their workspaces. */
  workflows: number;
  /** null = unlimited. */
  workflowLimit: number | null;
  /** Loop definitions the user owns, across all their workspaces. */
  loops: number;
  /** null = unlimited. */
  loopLimit: number | null;
  /** Code-review cycles in flight for this owner, across their workspaces. */
  activeReviews: number;
  /** null = unlimited. */
  activeReviewLimit: number | null;

  // Usage billing. Every field below is OPTIONAL and stays so: the production
  // backend does not send them before usage billing ships, and a client reads
  // their ABSENCE as "draw the old view". Money is micro-dollars (see pricing.ts).

  /** The usage-billing tier. Absent on a backend without usage billing. */
  tier?: PlanTier;
  /** The current period's box-hours. */
  usage?: UsageSummary;
  /** Credit balance and live lots. Absent when the tier cannot hold credits. */
  credits?: CreditSummary;
  /** Absent when the tier cannot use auto top-up. */
  autoTopup?: AutoTopupSettings;
  /** Every size with its weight, hourly price and whether this tier may start it. */
  sizePrices?: SizePrice[];
  /** Boxes running now against the tier's concurrency cap. */
  concurrentBoxes?: ConcurrentBoxUsage;
  /** List prices, so no client hard-codes a dollar amount. */
  pricing?: BillingPricing;
  /**
   * A usage reset this account can buy now: the tier's monthly price for a
   * fresh allowance in the current period. Absent when billing is off, the
   * tier is free, the tier's reset product is not set, or nothing is used yet.
   */
  usageReset?: UsageResetOffer;
}

export interface CreateCheckoutRequest {
  period: 'monthly' | 'annual';
  /** The product to buy. Absent means the backend's default (Pro on usage billing). */
  plan?: SellableTier;
  /** The mobile app's URL base (`talyn-mobile://`). Absent: return to the web app. */
  returnTo?: string;
}

/** `POST /billing/credits/checkout`. */
export interface CreditCheckoutRequest {
  pack: CreditPackId;
  /** The mobile app's URL base (`talyn-mobile://`). Absent: return to the web app. */
  returnTo?: string;
}

/** `POST /billing/usage-reset/checkout`. The backend picks the reset for the caller's tier. */
export interface UsageResetCheckoutRequest {
  /** The mobile app's URL base (`talyn-mobile://`). Absent: return to the web app. */
  returnTo?: string;
}

/** `POST /billing/change-plan`: move a Legacy Pro subscription to Pro. */
export interface ChangePlanRequest {
  /** An upgrade only. A move to a smaller plan goes through the billing portal. */
  to: SellableTier;
  period: 'monthly' | 'annual';
}

/** `PUT /billing/auto-topup`. Validate with `validateAutoTopupConfig`. */
export type UpdateAutoTopupRequest = AutoTopupConfig;

// ---------- Team plan ----------
//
// A team is consolidated billing and nothing else: it pays for seats, and a
// seat gives one GitHub account the Unlimited plan on that person's own
// account. No workspace is ever shared. A seat binds to the numeric GitHub
// user id (a login can be renamed), so it can be assigned before the person
// has signed up and becomes live the first time they sign in.

export type TeamSeatSource = 'named' | 'org';

/** What a user's billing status says about their team. */
export interface BillingTeamMembership {
  id: string;
  name: string;
  isAdmin: boolean;
  /** False for an admin who pays but does not hold a seat. */
  hasSeat: boolean;
  /**
   * The user is the team's only admin. A team always keeps one, so this user
   * cannot leave or give up the admin role until somebody else has it.
   */
  soleAdmin: boolean;
  seatSource?: TeamSeatSource;
  /** Whether the team's plan is live — a lapsed team still shows, unpaid. */
  active: boolean;
  /**
   * The user also pays for a personal subscription. The app warns; it never
   * cancels someone's payment for them.
   */
  paidPersonallyToo: boolean;
}

export interface TeamSeat {
  id: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  source: TeamSeatSource;
  /** Whether that GitHub account has signed in to Talyn yet. */
  signedUp: boolean;
  /** Whether the holder is also an admin. Only a signed-up account can be. */
  isAdmin: boolean;
  createdAt: string;
}

export interface TeamAdmin {
  userId: string;
  githubUsername: string | null;
  email: string;
  /** False for an admin who pays but does not hold a seat. */
  hasSeat: boolean;
}

/** The admin's view of a team, served by `GET /billing/team/:id`. */
export interface TeamDetail {
  id: string;
  name: string;
  /** Whether the team currently grants its seats Unlimited. */
  active: boolean;
  /** What each seat grants. Teams bought before usage billing are Legacy Pro. */
  tier: 'pro' | 'legacy_pro';
  planSource: 'none' | 'subscription' | 'override';
  seatsPurchased: number;
  seatsUsed: number;
  /** More people seated than paid for — assignment is refused until fixed. */
  overAllocated: boolean;
  subscriptionStatus?: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: string;
  seats: TeamSeat[];
  admins: TeamAdmin[];
}

export interface CreateTeamRequest {
  name: string;
}

export interface TeamCheckoutRequest {
  period: 'monthly' | 'annual';
  seats: number;
}

export interface TeamChangePlanRequest {
  period: 'monthly' | 'annual';
}

/** A GitHub account suggested by the seat picker, `GET /billing/team/:id/github-users`. */
export interface GitHubAccountSuggestion {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface AssignTeamSeatsRequest {
  /** GitHub logins. Resolved to numeric ids server-side. */
  logins: string[];
}

export interface AssignTeamSeatsResponse {
  assigned: TeamSeat[];
  failed: Array<{ login: string; reason: string }>;
}

export interface TeamSeatTier {
  minSeats: number;
  maxSeats: number | null;
  /** Price per seat in the smallest currency unit (cents). */
  pricePerSeat: number;
}

export interface TeamPriceTiers {
  currency: string;
  /** 'volume': every seat costs the tier price. 'graduated': each band is priced separately. */
  tierType: 'volume' | 'graduated';
  minimumSeats: number;
  maximumSeats: number | null;
  tiers: TeamSeatTier[];
}

/** Served by `GET /billing/team/pricing`. Null when that period is not sold. */
export interface TeamPricing {
  monthly: TeamPriceTiers | null;
  annual: TeamPriceTiers | null;
}

/**
 * What `seats` seats cost per period under `tiers`, in cents. Null when the
 * count is outside what the product sells.
 *
 * 'volume': one tier — the one the count falls in — prices every seat.
 * 'graduated': each tier prices only the seats inside its own band, so the
 * first tier covers seats 1..its max whatever its stated minimum.
 */
export function teamPriceFor(tiers: TeamPriceTiers, seats: number): number | null {
  if (!Number.isInteger(seats) || seats < tiers.minimumSeats) return null;
  if (tiers.maximumSeats !== null && seats > tiers.maximumSeats) return null;
  const sorted = [...tiers.tiers].sort((a, b) => a.minSeats - b.minSeats);
  if (tiers.tierType === 'volume') {
    const tier = sorted.find(
      (t) => seats >= t.minSeats && (t.maxSeats === null || seats <= t.maxSeats)
    );
    return tier ? tier.pricePerSeat * seats : null;
  }
  let total = 0;
  let covered = 0;
  for (const tier of sorted) {
    if (covered >= seats) break;
    const upper = tier.maxSeats === null ? seats : Math.min(seats, tier.maxSeats);
    if (upper > covered) total += (upper - covered) * tier.pricePerSeat;
    covered = Math.max(covered, upper);
  }
  return covered >= seats ? total : null;
}

export interface CheckoutSessionResponse {
  url: string;
}

/** One past order, served by `GET /billing/orders` (newest first). */
export interface BillingOrder {
  id: string;
  createdAt: string; // ISO
  /** Total in the smallest currency unit (cents). */
  amount: number;
  currency: string;
  /** Provider order status: 'paid' | 'pending' | 'refunded' | 'partially_refunded' | … */
  status: string;
  paid: boolean;
  productName: string | null;
  /** Assigned once the order is finalized; shown as the invoice reference. */
  invoiceNumber: string | null;
}

// ============================================================================
// MCP tokens
// ============================================================================

/**
 * A long-lived personal access token for the hosted MCP endpoint, as shown
 * in the desktop "MCP server" settings list. Never carries the secret — only
 * the human-readable prefix. The plaintext token is returned exactly once at
 * creation (see {@link CreateMcpTokenResponse}).
 */
export interface McpToken {
  id: string;
  name: string;
  /** Human-readable head, e.g. `talyn_mcp_ab12cd` — for disambiguation only. */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreateMcpTokenRequest {
  /** Optional label so the user can tell tokens apart. */
  name?: string;
  /** Days until expiry. Defaults to 90; null/0 means non-expiring. */
  expiresInDays?: number | null;
}

/** Returned once on creation — `token` is never retrievable again. */
export interface CreateMcpTokenResponse {
  /** The full plaintext token. Show once, then discard server-side. */
  token: string;
  token_meta: McpToken;
}

// Workspace API
export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  logo?: WorkspaceLogo;
  settings?: Partial<WorkspaceSettings>;
}

// Task API
export interface CreateTaskRequest {
  workspaceId: string;
  type: TaskType;
  title: string;
  description: string;
  prompt?: string;
  priority?: TaskPriority;
  repositoryId?: string;
  assignedEnvironmentId?: string;
  /**
   * Associate the new task with an existing pull_requests row (its `id`).
   * Set when the task is started from a PR row ("Get PR mergeable" /
   * "Address PR") so the GitHub screen can show a live in-progress
   * indicator on that row and deep-link back to the task. Best-effort:
   * an unknown / cross-workspace id is silently ignored.
   */
  pullRequestId?: string;
  /**
   * Cloud (PostHog Code) overrides. Only meaningful when the task is
   * assigned to a `posthog_code` env; ignored otherwise. `runtimeAdapter`
   * falls back to the env's default, then `claude`. `model` falls back to
   * the env's default, then the backend default — the PostHog Code API
   * requires a concrete model on every run, so it's always resolved server-side.
   */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  model?: string;
  /**
   * Set when the task runs an agent skill. The skill's content is already
   * inlined into `prompt` by the caller (see buildSkillPrompt); this small
   * descriptor is persisted to `metadata.skill` for display and bumps the
   * workspace's skill-usage stats. Content is deliberately NOT stored here.
   */
  skill?: TaskSkillInfo;
}

/** Which skill a task ran — stored on `task.metadata.skill`. */
export interface TaskSkillInfo {
  key: SkillKey;
  name: string;
  source: SkillSource;
  /** repo skills — the repository the skill came from. */
  repositoryId?: string;
  /** platform skills — the `skills` row id. */
  platformSkillId?: string;
}

// Skills API
export interface ListSkillsResponse {
  /** Workspace (Talyn) skills — no content (fetch via GET /skills/:id). */
  platform: SkillSummary[];
  /** Skills discovered in the requested repo — empty when no repositoryId given. */
  repo: SkillSummary[];
  /** 'none' = repo has no .claude/skills dir; 'error' = GitHub fetch failed. */
  repoStatus: 'ok' | 'none' | 'error';
  /**
   * Why discovery failed, on `repoStatus: 'error'` — GitHub's own message
   * (a rate-limit backoff reads very differently from a permission problem,
   * and "Couldn't load this repo's skills" alone can't tell them apart).
   */
  repoError?: string;
  /** Usage stats for every skill key the workspace has ever run. */
  usage: Record<SkillKey, SkillUsageEntry>;
}

export interface PlatformSkill extends SkillSummary {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlatformSkillRequest {
  workspaceId: string;
  name: string;
  description?: string;
  content: string;
  /** Where the skill was imported from, if not written in-app. */
  sourceInfo?: { importedFrom: SkillSource; originPath?: string };
}

export interface UpdatePlatformSkillRequest {
  name?: string;
  description?: string;
  content?: string;
}

/**
 * Fields FastOwl writes onto `task.metadata` for a cloud (PostHog Code)
 * run. Stored loosely (metadata is `Record<string, unknown>`); this
 * interface documents the shape the poller + UI rely on.
 */
export interface PostHogCodeTaskMetadata {
  /** Remote PostHog task id. */
  posthogTaskId: string;
  /** Remote run id (the `run/` response). */
  posthogRunId?: string;
  /** PostHog project (team) id the task was created under. */
  posthogProjectId: string;
  /** PostHog host the task lives on, e.g. https://us.posthog.com. */
  posthogHost: string;
  /** Deep link to the run's log/console in the PostHog UI. */
  posthogLogUrl?: string;
  /** PR URL once the cloud run opens one. */
  posthogPrUrl?: string;
  /** Last remote run status we observed. */
  posthogStatus?: string;
}

/**
 * Cloud task providers FastOwl can delegate a task to. A provider runs the
 * whole agent loop on its own sandbox and opens a PR; FastOwl kicks off the
 * run and reconciles status/transcript back. `selfhosted` (Talyn Fleet) and
 * `posthog_code` are live; `codex_cloud` is deferred — OpenAI exposes no
 * server-to-server cloud-task API (see docs/CLOUD_PROVIDERS.md).
 *
 * `claude_code` (Anthropic Managed Agents) was removed: it billed metered API
 * credits with no subscription option, which is the opposite of what the fleet
 * offers, and every workspace on it is better served by the fleet's own Claude.
 */
export type CloudProviderType = 'posthog_code' | 'codex_cloud' | 'selfhosted';

/**
 * Talyn's preference between cloud providers — best first.
 *
 * ONE definition, read by two things that must not disagree: the backend
 * resolver that picks a provider when nobody pinned one
 * (`resolveCloudEnvChain`), and every list the user is shown — the Settings
 * cards, the "Default for new tasks" menu, the per-task agent picker. Before
 * this, the resolver had its own constant while the lists followed whatever
 * order the providers happened to REGISTER in at boot. Those pointed opposite
 * ways: the resolver preferred the fleet, and PostHog Code registered first, so
 * the app recommended one thing by picking it and another by listing it.
 *
 * The fleet leads because it is the better place for the work — a real microVM,
 * the workspace's own Claude or Codex subscription rather than metered credits,
 * and a credential proxy that keeps every token out of the guest. PostHog Code
 * stays second rather than being dropped: it is what a fleet at capacity falls
 * back to, and what a workspace with the fleet switched off runs on.
 *
 * A type not listed here sorts last rather than being hidden — `codex_cloud` is
 * deferred, not forbidden, and a provider that appears in a list it was left
 * out of is a much smaller problem than one that silently vanishes.
 */
export const CLOUD_PROVIDER_ORDER: readonly CloudProviderType[] = [
  'selfhosted',
  'posthog_code',
];

/** Sort key for {@link CLOUD_PROVIDER_ORDER}; unlisted types sort last. */
export function cloudProviderRank(type: string): number {
  const i = (CLOUD_PROVIDER_ORDER as readonly string[]).indexOf(type);
  return i === -1 ? CLOUD_PROVIDER_ORDER.length : i;
}

/**
 * A provider id as it may actually arrive at runtime — including one this build
 * has never heard of.
 *
 * `CloudProviderType` is the closed set of providers *this* build knows how to
 * register, and it should stay closed: a `Record<CloudProviderType, ...>` that
 * stops compiling when a provider is added is a useful reminder to add its
 * label and logo. But the desktop app is a released Electron binary, so users
 * run old versions against a newer backend indefinitely. Anything that *reads*
 * a provider id off the wire — task metadata, an environment row, an API
 * response — must therefore accept a string it does not recognise and degrade,
 * rather than treat it as absent.
 *
 * The `(string & {})` intersection is the standard trick for "any string, but
 * keep autocompleting the known ones".
 */
export type AnyCloudProviderType = CloudProviderType | (string & {});

/**
 * Neutral, provider-agnostic cloud-run metadata stored on
 * `task.metadata.cloudTask`. Supersedes the legacy `posthog*` fields; a
 * read-through helper ({@link readCloudTaskMeta}) maps old tasks forward.
 */
export interface CloudTaskMetadata {
  /**
   * Which provider owns this task. Deliberately the permissive type: this is
   * deserialised from a JSON blob written by whichever backend version was
   * running at the time, so it may name a provider this build does not know.
   */
  provider: AnyCloudProviderType;
  /** Remote task id on the provider. */
  remoteTaskId: string;
  /** Remote run id, once a run has started. */
  remoteRunId?: string;
  /** Last remote status observed. */
  status?: string;
  /** Deep link to the run's log/console in the provider's UI. */
  logUrl?: string;
  /** PR URL once the run opens one. */
  prUrl?: string;
  /** Provider-specific extras. */
  extra?: Record<string, unknown>;
}

/**
 * Resolve which cloud provider owns a task from its `provider` column
 * (preferred) or its metadata, falling back to the legacy `posthog*`
 * fields. Returns null for a task with no cloud association.
 */
export function readCloudTaskProvider(task: {
  provider?: string;
  metadata?: Record<string, unknown> | null;
}): AnyCloudProviderType | null {
  // Any non-empty string is a provider id. This used to filter through a
  // hand-maintained allowlist, which meant a provider added to the union but
  // not to that array — or, worse, a provider from a newer backend arriving at
  // an older client — silently resolved to null, and the task then rendered as
  // if it had no cloud run at all. Null must mean "no cloud run", not "a cloud
  // run I have not been taught about".
  if (typeof task.provider === 'string' && task.provider.trim()) {
    return task.provider;
  }
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (typeof cloud?.provider === 'string' && cloud.provider.trim()) {
    return cloud.provider;
  }
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return 'posthog_code';
  }
  return null;
}

/**
 * Read the neutral cloud metadata for a task, mapping legacy `posthog*`
 * fields forward when `metadata.cloudTask` isn't present. Returns null if
 * the task carries no cloud run.
 */
export function readCloudTaskMeta(task: {
  metadata?: Record<string, unknown> | null;
}): CloudTaskMetadata | null {
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (cloud && cloud.remoteTaskId) return cloud;
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return {
      provider: 'posthog_code',
      remoteTaskId: meta.posthogTaskId,
      remoteRunId: meta.posthogRunId as string | undefined,
      status: meta.posthogStatus as string | undefined,
      logUrl: meta.posthogLogUrl as string | undefined,
      prUrl: meta.posthogPrUrl as string | undefined,
    };
  }
  return null;
}

// Never `metadata.model`: that is the pin the task was created with, and a fleet pin that fails over to PostHog Code runs on a different model.
export function readDispatchedModel(
  task: { metadata?: Record<string, unknown> | null },
  provider: AnyCloudProviderType | null | undefined,
): string | null {
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  const recorded =
    provider === 'posthog_code'
      ? meta.posthogModel
      : cloud?.provider === provider
        ? cloud?.extra?.model
        : undefined;
  return typeof recorded === 'string' && recorded.trim() ? recorded : null;
}

export function cloudModelLabel(modelId: string): string {
  const known = [...FLEET_MODELS, ...POSTHOG_CODE_MODELS].find((m) => m.id === modelId);
  return known?.label ?? modelId;
}

export interface GenerateTaskMetadataRequest {
  prompt: string;
  /** Optional env hint for resolving the cloud provider. */
  assignedEnvironmentId?: string;
}

export interface GenerateTaskMetadataResponse {
  title: string;
  description: string;
  suggestedPriority: TaskPriority;
}

export * from './reviewRankingPreference.js';
export * from './reviewRankingModel.js';
