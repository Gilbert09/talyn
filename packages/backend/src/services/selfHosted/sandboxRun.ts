import { and, eq } from 'drizzle-orm';
import {
  fleetProviderForModel,
  resolveFleetModel,
  topFleetModelForModel,
  fleetAgentForModel,
  type FleetAgent,
} from '@talyn/shared';
import { workspaceAgentModel, workspaceFleetModel } from './fleetModel.js';
import { reconcileDefaultBranch } from '../repoDefaultBranch.js';
import { getDbClient } from '../../db/client.js';
import { repositories as repositoriesTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import {
  FleetCapacityError,
  FleetClient,
  FleetDispatchUncertainError,
  type CreateSandboxInput,
  type FleetMcpServerInline,
  type FleetSandbox,
} from './client.js';
import { workspaceMayUseMcpServers } from '../mcpServersAccess.js';
import { mcpServersForDispatch, type McpServerWithSecret } from '../mcpServers/store.js';
import { getSelfHostedCredentials, resolveFleetTarget } from './credentials.js';
import { heldBackAgents, heldBackReason } from './exhaustedQuota.js';
import { isWithdrawnModel, replacementFor } from './withdrawnModels.js';

/**
 * Booting one fleet microVM, for callers that are not a `tasks` row.
 *
 * # Why this exists
 *
 * `dispatchTaskToFleet` grew into the only place that knows how to start a
 * fleet run, and almost none of what it knows is about tasks. It resolves the
 * workspace's credential and refuses rather than sending a blank one; it walks a
 * four-rung model ladder and repairs a model the vendor has withdrawn; it swaps
 * agents when one subscription is spent and reports capacity when neither can
 * run; it suppresses the other vendor's credential at every door the fleet
 * offers; it re-sends the same id when the control plane loses an answer. Every
 * one of those is a paid-for lesson, and a second copy would silently lose
 * exactly one of them.
 *
 * The code-review pipeline needs to boot sandboxes and cannot be a task: three
 * separate guards (`activePrTaskId`, `findReusableTask`, `withTaskLimitGate`)
 * make several concurrent runs on one pull request impossible by design, which
 * is right for tasks and fatal for a review that fans out across lenses. So the
 * vendor knowledge moves here, behind an explicit spec, and the task path
 * becomes a thin adapter over it.
 *
 * # What stayed behind
 *
 * Everything that is about a task row: the `cloudTask.remoteTaskId` idempotence
 * guard, the run-id derivation, the metadata patch, the status write and the
 * websocket emissions. This function touches no table but `repositories`, and it
 * reads that one to answer "what is this repo called and what is its default
 * branch".
 */

export interface SandboxRunSpec {
  /**
   * The sandbox id, chosen by the caller and idempotent at the fleet: a repeated
   * id returns the existing sandbox rather than booting a second microVM. It
   * must therefore be unique per run the caller actually wants, and derived
   * rather than random — a random id cannot be re-sent after an uncertain
   * dispatch, which is the one recovery that is always safe.
   */
  runId: string;
  workspaceId: string;
  repositoryId: string;
  /** The fleet's own task-type vocabulary, passed through untouched. */
  taskType: string;
  prompt: string;
  systemPrompt: string;
  /**
   * An explicit model pin. Wins over everything, and is never rewritten on the
   * caller's behalf except when the vendor has withdrawn it: if the pin names a
   * vendor this workspace has not connected, that is a refusal naming the
   * vendor, not a silent swap onto a model nobody picked.
   */
  model?: string;
  /**
   * 'top' swaps the resolved model for the strongest of the SAME vendor.
   *
   * This is what review depth means in practice. Kept as a tier rather than a
   * model id so the caller does not have to know which vendor the workspace
   * connected — that is decided by the ladder below, after this struct is built.
   */
  modelTier?: 'default' | 'top';
  /**
   * A lower-priority suggestion, tried after the workspace's own setting and
   * before the credential-aware default. This is the rung the task path fills
   * from its environment row; a caller with no such notion omits it.
   */
  modelFallback?: string;
  /**
   * Fleet agents the caller knows are limited right now, although no workspace
   * hold says so. A rate limit writes no hold, so a review whose first unit
   * was just refused has no other way to keep its remaining units off that
   * agent.
   *
   * Treated as a hold with one difference. With no other usable agent a HELD
   * agent is refused as capacity, and an AVOIDED one is dispatched anyway: the
   * caller's knowledge is minutes old and the limit may have cleared.
   */
  avoidAgents?: FleetAgent[];
  /**
   * A ref to check out instead of the repository's default branch — how a review
   * run reads the pull request rather than trunk.
   *
   * Unset by every task dispatch, deliberately. A golden image's identity is
   * `(repo, baseBranch)`, so asking for a different ref may change which layer
   * the host selects; the task path already tells its agent to check the branch
   * out itself and must not have that behaviour changed underneath it.
   */
  targetRef?: string;
  /**
   * Whether the box may reach the routed internet. Absent and `false` both mean
   * the fleet's default — no routed network, everything through the credential
   * proxy — which is what all but explicitly internet-enabled work sends.
   */
  internetAccess?: boolean;
  /**
   * Which of the workspace's MCP servers to attach. Tri-state and none of the
   * three may be collapsed: `null` or omitted means every enabled server, `[]`
   * means none, and a list means exactly those.
   */
  mcpServerIds?: string[] | null;
  /**
   * Caps the fleet enforces host-side. Talyn sent none of these for its whole
   * history, so an omitted field is the historical behaviour and adding one is
   * always a tightening. Only send a number you can justify: a cap guessed too
   * low truncates good work and saves nothing on the bad.
   */
  budget?: { maxTurns?: number; maxBudgetUsd?: number; timeoutSec?: number };
}

export interface SandboxRunHandle {
  /** The fleet's own record of the box, as returned by the create. */
  sandbox: FleetSandbox;
  /** Which LLM API this run is spending, which decides its egress route table. */
  provider: 'anthropic' | 'openai';
  /** The model actually dispatched, after the ladder, the catalogue and any swap. */
  model: string;
  endpoint: string;
  /**
   * Which box took it, when anybody knows. An authorization input rather than a
   * label: after that host's fleetd restarts it asks us for this run's
   * credentials back, and the answer is only given to the host the run was
   * dispatched to.
   */
  host?: string;
  repoSlug: string;
  baseBranch: string;
  /**
   * Set when a held-back subscription moved this run onto the other agent, so
   * the caller can record the explanation wherever it keeps run history.
   */
  quotaSwap: { from: FleetAgent; to: FleetAgent } | null;
}

export type SandboxRunResult =
  | { ok: true; handle: SandboxRunHandle }
  | { ok: false; error: string; capacity?: boolean };

/**
 * How many times a dispatch that got 504 `dispatch_uncertain` is re-sent.
 *
 * The control plane lost the host's answer; the sandbox MAY exist. The only
 * safe move is the SAME id again — the create is idempotent on it — and never
 * another provider, which could run the work twice. Bounded so a gateway that
 * is genuinely down does not hold the caller's tick hostage.
 */
const DISPATCH_UNCERTAIN_RETRIES = 2;
const DISPATCH_UNCERTAIN_DELAY_MS = 2_000;

/**
 * Why a dispatch was refused for want of a credential, said so the reader knows
 * which of the two things to do about it.
 *
 * Two fixes are always available and the message names both, because the
 * cheaper one is usually the one the user wants: connect the vendor this model
 * needs, or run the work on the vendor already connected. A bare "no credential"
 * sends people to the settings screen when switching models would have done.
 */
function missingCredentialError(
  provider: 'anthropic' | 'openai',
  model: string,
  creds: { claudeToken?: string; openaiKey?: string },
): string {
  const needed = provider === 'openai' ? 'Codex (ChatGPT) subscription' : 'Claude subscription';
  const other = provider === 'openai' ? 'Claude' : 'Codex';
  const otherConnected = provider === 'openai' ? Boolean(creds.claudeToken) : Boolean(creds.openaiKey);
  return (
    `Talyn Fleet needs your ${needed} to run ${model}, and this workspace has not connected one. ` +
    (otherConnected
      ? `Connect it in Settings → Talyn Fleet, or run this task on ${other} instead.`
      : 'Connect it in Settings → Talyn Fleet.')
  );
}

/**
 * Boot one ephemeral fleet sandbox and hand back what it is.
 *
 * Every refusal is a returned value, never a throw, and `capacity: true` marks
 * the ones that mean "nothing is wrong with this work, try elsewhere" — a busy
 * or unreachable fleet, and a spent subscription with no other agent to use.
 * That discriminator is what lets a caller fall through to another provider
 * without a microVM ever being booted.
 */
export async function dispatchSandboxRun(spec: SandboxRunSpec): Promise<SandboxRunResult> {
  const creds = await getSelfHostedCredentials(spec.workspaceId);
  if (!creds) {
    return {
      ok: false,
      error:
        'Talyn Fleet is not configured for this workspace — add your Claude OAuth token in workspace settings.',
    };
  }

  // Fetched fresh each dispatch so a re-connected or rotated token is current.
  // It goes backend -> fleetd only; the fleet's credential proxy injects it
  // host-side and it never enters the microVM (fleet spec §8).
  const githubToken = await githubService.getVerifiedAccessToken(spec.workspaceId);
  if (!githubToken) {
    return {
      ok: false,
      error: 'Connect GitHub for this workspace — the fleet uses it to clone the repo and open the PR.',
    };
  }

  const repo = await resolveRepository(spec.repositoryId, spec.workspaceId);
  if (!repo) {
    return { ok: false, error: 'Could not resolve a GitHub owner/repo for this task’s repository.' };
  }

  try {
    // The TARGET, not just a client: the run's record says which box took it,
    // and "which box" is the registry's answer rather than a string the
    // workspace stored. Reading it off the resolved target is the only way that
    // stays true — a remembered endpoint would name the host that was picked
    // the day the credential was saved.
    const target = await resolveFleetTarget(spec.workspaceId);
    if (!target) return { ok: false, error: 'Talyn Fleet is not configured for this workspace.' };
    const client = new FleetClient(target.endpoint, target.token);

    // The caller's pin, then the workspace's Settings → Talyn Fleet choice, then
    // the caller's fallback, then the default. Explicit rather than letting the
    // SDK decide: an unset model was served by Opus 5 on every turn, which is
    // how fleet runs came to cost ~$15.85 each.
    // The last rung is CREDENTIAL-AWARE. A Codex-only workspace that has never
    // picked a model would otherwise land on Sonnet and be refused below for a
    // Claude key it was never asked for — a dead end reached by doing nothing
    // wrong. An EXPLICIT choice is never rewritten this way.
    // resolveFleetModel wraps the whole ladder, not one rung: a retired Codex id
    // can be pinned at any of them, and all produced the same dead run. OpenAI
    // withdraws models from the ChatGPT sign-in path on its own schedule, so a
    // pin that worked when it was made stops working without anything here
    // changing.
    const resolvedModel = resolveFleetModel(
      spec.model ??
        (await workspaceFleetModel(spec.workspaceId)) ??
        spec.modelFallback ??
        (await workspaceAgentModel(spec.workspaceId, creds.claudeToken ? 'claude' : 'codex')),
    );

    // "Deeper" means a STRONGER MODEL, because there is nothing else it can mean:
    // the create body has no reasoning-effort field and the catalogue has no
    // effort variants. Applied AFTER the ladder rather than by pinning a model at
    // the call site, so the credential-aware rung above still decides the VENDOR
    // — escalating before it would send a Codex-only workspace at a Claude model
    // and get it refused for a key it was never asked for.
    const tiered =
      spec.modelTier === 'top' ? topFleetModelForModel(resolvedModel) : resolvedModel;

    // A model the vendor has been OBSERVED to withdraw (withdrawnModels.ts).
    // The settings migration on the failure path covers the workspace's stored
    // choice; this covers the places a caller can pin one that the migration
    // cannot reach.
    const catalogued = isWithdrawnModel(tiered) ? replacementFor(tiered) : tiered;

    // An agent whose subscription a vendor has already told us is spent
    // (exhaustedQuota.ts). Without this check every run re-discovers the same
    // exhaustion the expensive way: boot a microVM, make one API call, be
    // refused, fail over. The hold is DURABLE, so it survives the deploy that
    // an in-memory one would not.
    //
    // Two outcomes, and the second is why this sits at dispatch rather than in
    // the failure path. If the OTHER fleet agent is connected and not itself
    // held, swap onto it — the model is what carries the vendor, so a swap is a
    // model change. If it is not, refuse as CAPACITY, which is how a caller is
    // told "nothing is wrong with this work, try the next provider" without a
    // sandbox ever being booted.
    const held: Awaited<ReturnType<typeof heldBackAgents>> = await heldBackAgents(
      spec.workspaceId,
    ).catch(() => ({}));
    const wanted = fleetAgentForModel(catalogued);
    let quotaSwap: { from: FleetAgent; to: FleetAgent } | null = null;
    let model = catalogued;
    const avoided = new Set<FleetAgent>(spec.avoidAgents ?? []);
    if (held[wanted] || avoided.has(wanted)) {
      const other: FleetAgent = wanted === 'claude' ? 'codex' : 'claude';
      // The RESOLVED credential, not merely "is one configured". `creds` has
      // already refreshed what it could, so this asks the question that
      // matters — can we actually run on the other agent right now — and a
      // token whose refresh failed falls through to the capacity refusal
      // instead of being swapped onto and then refused for a missing key,
      // which is a hard failure a chain does not route around.
      const otherToken = other === 'codex' ? creds.openaiKey : creds.claudeToken;
      const otherUsable = !held[other] && !avoided.has(other) && Boolean(otherToken);
      if (!otherUsable && held[wanted]) {
        return { ok: false, capacity: true, error: heldBackReason(wanted, held[wanted]!) };
      }
      if (otherUsable) {
        // The workspace's OWN choice for that agent, not the shipped default.
        // A swap is a vendor change, not a licence to ignore the setting: this
        // sent `defaultFleetModelForAgent` and so ran gpt-5.6-terra on a
        // workspace whose Codex model was gpt-5.6-sol, every task, all day
        // (observed 2026-09-21). `workspaceAgentModel` still ends at the shipped
        // default, so a workspace that has chosen nothing is unaffected.
        //
        // The tier is applied again, because the swap replaced the model the
        // tier was applied to. Without it a judging unit that moved would run
        // below the tier its kind asks for.
        const swapped = await workspaceAgentModel(spec.workspaceId, other);
        model = spec.modelTier === 'top' ? topFleetModelForModel(swapped) : swapped;
        quotaSwap = { from: wanted, to: other };
        console.warn(
          `[fleet] run ${spec.runId}: ${wanted} usage is held back or limited, so it dispatches at ${other}`,
        );
      }
    }

    // The model decides the provider, and the provider decides what the microVM
    // can reach: the host builds the sandbox's egress route table from it, so a
    // dispatch at an OpenAI model has no route to Anthropic's API at all.
    // Sent explicitly rather than left to the host's default — the route table
    // should be the one this dispatch chose.
    const provider = fleetProviderForModel(model);

    // THE KEY FOR THIS DISPATCH'S VENDOR, OR NOTHING HAPPENS.
    //
    // This used to send `creds.openaiKey ?? ''`, and the empty string is the
    // whole problem. The sandbox gateway fills an ABSENT OR BLANK credential
    // from its own tenant's sealed custody — so a workspace with no Codex
    // credential would not fail, it would quietly run on whatever key the
    // Talyn tenant holds, billing one account's subscription for another's
    // work. (Custody is only ever populated for GitHub-born tenants and ours is
    // operator-minted, so there is nothing behind that door today. The fix is
    // not about today: it is one settings change away from being live, and the
    // failure is silent when it arrives.)
    //
    // Refusing is also the more useful answer. "Connect Codex" is something the
    // user can act on; a run that silently spends somebody else's subscription
    // is something nobody finds out about.
    const agentKey = provider === 'openai' ? creds.openaiKey : creds.claudeToken;
    if (!agentKey) {
      return { ok: false, error: missingCredentialError(provider, model, creds) };
    }

    // Resolved before the create rather than inside it, so a workspace whose
    // credentials will not open costs a log line here instead of an exception
    // halfway through building a request body.
    const mcpServers = await mcpServersFor(spec.workspaceId, spec.mcpServerIds ?? null);

    const { sandbox, host } = await createSandboxRetryingUncertain(client, {
      id: spec.runId,
      workspaceId: spec.workspaceId,
      // Ephemeral is what a run was: the host stops and retires the sandbox
      // the moment its initial task reaches a terminal state.
      ephemeral: true,
      task: {
        taskType: spec.taskType,
        prompt: spec.prompt,
        systemPrompt: spec.systemPrompt,
        model,
        provider,
        repo: {
          slug: repo.slug,
          baseBranch: repo.defaultBranch,
          ...(spec.targetRef ? { targetRef: spec.targetRef } : {}),
        },
        ...(spec.budget?.maxTurns !== undefined ? { maxTurns: spec.budget.maxTurns } : {}),
        ...(spec.budget?.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: spec.budget.maxBudgetUsd }
          : {}),
        ...(spec.budget?.timeoutSec !== undefined ? { timeoutSec: spec.budget.timeoutSec } : {}),
      },
      githubToken,
      // The credential for this dispatch's vendor, and only that one.
      ...(provider === 'openai' ? { openaiKey: agentKey } : { anthropicKey: agentKey }),
      // SUPPRESS THE OTHER VENDOR, which is what makes the custody door
      // structurally shut rather than shut by our remembering to fill a field.
      //
      // The fleet applies `policy.credentials` at EVERY door a credential can
      // enter a run's proxy — the create body, the /credentials push, the
      // refresh hook, and the adoption re-pull (`internal/fleet/policy.go`
      // `filterCredentials`) — so a suppressed vendor cannot be filled from
      // custody on any of them, including the one that runs when nobody is
      // looking (a fleetd restart).
      //
      // ONE vendor, never both, and never `github`: suppressing everything
      // nulls the refresh hook outright (`allCredentialsSuppressed`), which
      // would strip the key we just sent.
      policy: {
        credentials: provider === 'openai' ? { anthropic: 'none' } : { openai: 'none' },
        // Only when the caller asked for it. Absent means the fleet's default —
        // no routed network — and absent is what all but internet-enabled work
        // sends.
        ...(spec.internetAccess === true ? { egress: { mode: 'open' as const } } : {}),
      },
      // The workspace's MCP servers, with their credentials, defined on the
      // spot. Omitted entirely when there are none, so a workspace that has
      // connected nothing sends the body it always sent.
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    });

    // WHICH BOX IS RUNNING THIS, from whichever party actually knows.
    //
    // Dialling a host directly, the registry chose it and `target.host` says so.
    // Through the gateway the registry chose nothing — the gateway placed it —
    // so the name arrives on the create's response and `host` carries it.
    const fleetHost = target.host ?? host;
    if (!fleetHost) {
      // Not fatal — the run is dispatched and will do its work. Said out loud
      // because the consequence surfaces much later and somewhere else: the
      // credential pull after a fleetd restart, refused, with nothing at the
      // refusal naming this moment.
      console.warn(
        `[fleet] dispatch of ${spec.runId} recorded no host (endpoint ${target.endpoint}); ` +
          'a credential pull after a host restart will be refused. ' +
          'The gateway names the host in X-Fleet-Host — is it too old to send one?',
      );
    }

    return {
      ok: true,
      handle: {
        sandbox,
        provider,
        model,
        endpoint: target.endpoint,
        ...(fleetHost ? { host: fleetHost } : {}),
        repoSlug: repo.slug,
        baseBranch: repo.defaultBranch,
        quotaSwap,
      },
    };
  } catch (err) {
    if (err instanceof FleetCapacityError) {
      // Availability, not failure: the work is fine and another provider can
      // run it. `capacity` is what a caller routes on (§10.7, §11.6).
      //
      // The message is written FOR A USER and deliberately does not include
      // err.message, which carries the host's private endpoint — a tailnet
      // address has no business in a customer-facing banner. The detail is
      // already in the log line and on the debug bus for whoever is debugging.
      console.warn(`[fleet] capacity refusal dispatching ${spec.runId}: ${err.message}`);
      return {
        ok: false,
        error:
          err.reason === 'unreachable'
            ? 'The self-hosted runners are not reachable right now.'
            : 'All self-hosted runners are busy.',
        capacity: true,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The repo to run against, with its default branch CHECKED rather than trusted.
 *
 * `repositories.default_branch` is hardcoded to 'main' by addWatchedRepo and
 * was never corrected, so a master-defaulted repo carried a branch that does
 * not exist. That is survivable for a run — the agent clones and works it out —
 * and fatal for a golden, whose identity is `(repo, baseBranch)`: the bake
 * cloned `--branch main`, git said "Remote branch main not found", and
 * PostHog/posthog silently never got an image, on every single dispatch.
 *
 * Reconciling here rather than only at add-time is deliberate: every row that
 * already exists is wrong, and a migration cannot ask GitHub. The first
 * dispatch after this ships repairs the row.
 */
async function resolveRepository(
  repositoryId: string,
  workspaceId: string,
): Promise<{ slug: string; defaultBranch: string } | null> {
  const rows = await getDbClient()
    .select({
      url: repositoriesTable.url,
      name: repositoriesTable.name,
      defaultBranch: repositoriesTable.defaultBranch,
    })
    .from(repositoriesTable)
    .where(and(eq(repositoriesTable.id, repositoryId), eq(repositoriesTable.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const slug = parseGitHubSlug(row.url) ?? sanitizeSlug(row.name);
  if (!slug) return null;

  const defaultBranch = await reconcileDefaultBranch({
    repositoryId,
    workspaceId,
    url: row.url,
    stored: row.defaultBranch,
  });
  return { slug, defaultBranch };
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

/**
 * POST the create, re-sending the SAME id on 504 `dispatch_uncertain`.
 *
 * That status means the control plane lost the host's answer: the sandbox may
 * or may not exist, and the create is idempotent on the id, so re-asking is
 * always safe and anything else is not — failing back to another provider here
 * could run the work twice. If the retries run out the error propagates as a
 * plain (non-capacity) failure, which is the honest answer: nobody knows
 * whether the work started, so nothing may re-dispatch it elsewhere.
 */
async function createSandboxRetryingUncertain(
  client: FleetClient,
  input: CreateSandboxInput,
): Promise<{ sandbox: FleetSandbox; host?: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.createSandbox(input);
    } catch (err) {
      if (!(err instanceof FleetDispatchUncertainError) || attempt >= DISPATCH_UNCERTAIN_RETRIES) {
        throw err;
      }
      console.warn(
        `[fleet] dispatch of ${input.id} uncertain (attempt ${attempt + 1}): ${err.message} — retrying the same id`,
      );
      await new Promise((r) => setTimeout(r, DISPATCH_UNCERTAIN_DELAY_MS));
    }
  }
}

/**
 * The workspace's MCP servers, shaped for the fleet's create body.
 *
 * Returns an empty array when the workspace is not in the feature's audience,
 * and that is the right degradation rather than a refusal: the work is still
 * worth doing. A run without its MCP servers is a smaller run; a run that
 * failed because a flag audience changed is a broken one.
 *
 * No count limit and no truncation. The fleet's own caps were removed rather
 * than worked around, so every enabled server is sent.
 */
async function mcpServersFor(
  workspaceId: string,
  ids: string[] | null,
): Promise<FleetMcpServerInline[]> {
  if (!(await workspaceMayUseMcpServers(workspaceId))) return [];
  const servers = await mcpServersForDispatch(workspaceId, ids);
  return servers.map((s) => ({
    name: s.name,
    url: s.url,
    transport: 'http' as const,
    ...(s.description ? { description: s.description } : {}),
    ...(s.secret ? { secret: s.secret } : {}),
    // `none` is sent explicitly rather than omitted: the fleet defaults an
    // absent recipe to bearer whenever a secret is present, which is right for
    // nearly every vendor and wrong for the one server that wants no
    // credential at all.
    inject: injectionFor(s),
    // Absent when unrestricted, so the fleet can tell "every tool" from "no
    // tools". Sending `[]` for a server nobody restricted would silently give
    // the agent nothing.
    ...(s.tools === null ? {} : { tools: s.tools }),
  }));
}

function injectionFor(s: McpServerWithSecret): FleetMcpServerInline['inject'] {
  switch (s.authKind) {
    case 'bearer':
      return { kind: 'bearer', ...(s.inject?.extra ? { extra: s.inject.extra } : {}) };
    case 'header':
      return {
        kind: 'header',
        header: s.inject?.header ?? '',
        ...(s.inject?.prefix ? { prefix: s.inject.prefix } : {}),
        ...(s.inject?.extra ? { extra: s.inject.extra } : {}),
      };
    case 'basic':
      return {
        kind: 'basic',
        user: s.inject?.user ?? '',
        ...(s.inject?.extra ? { extra: s.inject.extra } : {}),
      };
    case 'query':
      return {
        kind: 'query',
        param: s.inject?.param ?? '',
        ...(s.inject?.extra ? { extra: s.inject.extra } : {}),
      };
    case 'none':
    default:
      return { kind: '', ...(s.inject?.extra ? { extra: s.inject.extra } : {}) };
  }
}
