/**
 * Client for the Talyn Fleet API — the `selfhosted` provider's remote.
 *
 * The contract is `openapi.yaml` in Gilbert09/talyn-fleet. This is hand-written
 * rather than generated for now; the generated-client-plus-drift-check flow in
 * SPEC §16.1 replaces it once the fleet publishes a tagged artifact.
 */

import { createHash, randomBytes } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { Duplex } from 'stream';
import { createSseJsonParser } from '@talyn/shared';
import { debugBus } from '../debugBus.js';

/**
 * A sandbox's lifecycle states. Terminal = stopped | failed | cancelled.
 *
 * The fleet merged runs and sandboxes into one kind (fleet docs/MERGE.md): a
 * sandbox is the microVM, and each prompt on it is a TASK with its own
 * terminal outcome. Talyn dispatches `ephemeral: true` sandboxes, which the
 * host stops as soon as the initial task ends — the old run behaviour.
 */
export type FleetSandboxStatus =
  | 'queued'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'suspended'
  | 'stopped'
  | 'failed'
  | 'cancelled';

/** One entry in a sandbox's task history. Talyn's outcome for a dispatched
 *  task is the INITIAL entry's terminal status — an ephemeral sandbox stops
 *  right after it, so `stopped` alone says nothing about how the work went. */
export interface FleetSandboxTask {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  endedAt?: string;
  error?: string;
  prUrl?: string;
}

/** A sandbox as the fleet reports it. Field names match internal/fleet/store.go. */
export interface FleetSandbox {
  id: string;
  workspaceId?: string;
  status: FleetSandboxStatus;
  /** Keeps its run meaning while a task is live; `agent` when idle. */
  phase?: string;
  /** The prompt history — see FleetSandboxTask. Talyn's dispatch creates the
   *  initial entry; a host older than the merge may omit the field. */
  tasks?: FleetSandboxTask[];
  /** True on Talyn's dispatches: the host stops and retires the sandbox as
   *  soon as its initial task reaches a terminal state. */
  ephemeral?: boolean;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  prUrl?: string;
  branch?: string;
  costUsd?: number;
  error?: string;
  adopted?: boolean;
  /**
   * When THIS supervisor took the run over. Changes on every adoption, which is
   * what makes it usable as the key for "have we re-credentialed this run since
   * it was last adopted" — `adopted` alone is a latch and cannot distinguish a
   * second restart from the first.
   */
  adoptedAt?: string;
  /** Per-run network slot + uid offset; unique among live runs. */
  slot?: number;
  deadline?: string;
  /**
   * What the guest was BOOTED at. Under the fleet's elastic admission this is a
   * CEILING, not a cost: the balloon holds the guest well below it and lets it
   * grow only as it proves it needs to. Fifteen runs on a 4096 ceiling read as
   * 60 GiB while actually costing 23.
   */
  memMib?: number;
  /**
   * What the run is spending right now — the VMM's resident size, so guest
   * pages actually touched plus the VMM's own overhead.
   *
   * Absent on a terminal run (its VMM is gone) and on any host still running a
   * fleetd that predates the field, so treat missing as "unknown" rather than
   * as zero.
   */
  memUsedMib?: number;
  vcpuCount?: number;
  golden?: string;
  /** 'base' | 'repo' — which layer selection landed on. */
  goldenLayer?: string;
  /** Last vsock heartbeat. */
  lastHeartbeat?: string;
  /**
   * Last vsock frame of ANY kind. Load-bearing and distinct from
   * lastHeartbeat: wedge detection on heartbeats alone killed healthy runs
   * (fleet HANDOFF failure #2), so this is the number that says "stuck".
   */
  lastActivity?: string;
  /**
   * The sandbox's initial task, redacted by the fleet to the four fields it is
   * willing to fan out (`fvspTaskRedacted`) — never the prompt, which embeds
   * customer code.
   */
  task?: {
    taskType?: string;
    model?: string;
    repo?: string;
    /**
     * A guest self-test rather than an agent loop. `deploy.sh` fires one after
     * every deploy to prove the API contract, so these appear on the host with
     * no Talyn task behind them — expected, and NOT the orphan the console is
     * trying to warn about.
     */
    selfTest?: boolean;
  };
}

/**
 * The response header the sandbox gateway sets to name the host that took a
 * create. Hosts answering directly do not send it.
 *
 * Named here rather than inlined because two places have to agree on it and one
 * of them is in another repository (yas `internal/control.HostHeader`).
 */
export const FLEET_HOST_HEADER = 'X-Fleet-Host';

/**
 * One row of the GATEWAY's placement index — not a sandbox record.
 *
 * Deliberately a separate type from FleetSandbox with no optional overlap: the
 * gateway cannot answer status, phase or cost (they live on the host and change
 * every second), and a shared type would let a caller read `status` off one of
 * these and get `undefined` where it meant `stopped`.
 */
export interface GatewaySandboxRef {
  id: string;
  host: string;
  createdAt?: string;
  placed?: boolean;
  agentic?: boolean;
  templateId?: string;
}

/** fleetd's `GET /v1/capacity`. */
export interface FleetCapacity {
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  accepting: boolean;
}

/** fleetd's `GET /v1/stats` — the structured twin of /metrics. */
export interface FleetStats {
  host: {
    version?: string;
    draining: boolean;
    runsLive: number;
    runsMax: number;
    memReservedMib: number;
    memBudgetMib: number;
    diskFreeMib: number;
    maxIdleSeconds: number;
  };
  runsByStatus: Record<string, number>;
  /**
   * The fleet's own metrics snapshot, passed through whole. Deliberately
   * loose: the fleet ships on its own cadence and adding a counter there must
   * not need a release here.
   */
  metrics: Record<string, unknown>;
}

/** One baked image. `diskBytes` is reflink-aware and is the one that bills. */
export interface FleetGolden {
  key: string;
  path: string;
  contentSha: string;
  repoSlug: string;
  baseBranch: string;
  repoCommit: string;
  packageManager?: string;
  workdir?: string;
  builtAt: string;
  diskBytes: number;
  apparentBytes: number;
  inUse: boolean;
  operatorPinned: boolean;
  /** False once baked on a base image this host no longer ships. */
  selectable: boolean;
  warnings?: string[];
}

export interface FleetGoldensView {
  goldens: FleetGolden[];
  freePct: number;
  baseGolden: string;
  baseOsSha: string;
}

export interface FleetRebakeStatus {
  slug?: string;
  baseBranch?: string;
  actor?: string;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/**
 * The attribution envelope every mutating fleetd action shares.
 *
 * fleetd 400s a body missing either field — spec §17.3, "an unattributed
 * drain is the one that nobody can explain the next morning".
 */
export interface FleetAttribution {
  actor: string;
  reason: string;
}

/** One transcript entry. `seq` is assigned by the fleet, not the guest. */
export interface FleetEvent {
  seq: number;
  at: string;
  event: Record<string, unknown>;
}

/** The initial task on a dispatched sandbox — the old dispatch body, nested
 *  under `task`. No `harness` field: pi is the only in-guest agent loop. */
export interface CreateSandboxTaskInput {
  taskType: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  repo?: { slug: string; baseBranch: string; targetRef?: string };
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  /**
   * Which LLM API the model belongs to. Omitted means anthropic, which is what
   * every dispatch predating the field meant — but it is sent explicitly so the
   * route table the host builds is the one this dispatch chose, not a default
   * it inherited.
   */
  provider?: string;
}

export interface CreateSandboxInput {
  /** Caller-chosen and idempotent: the fleet returns the existing sandbox for
   *  a repeated id rather than booting a second microVM. */
  id: string;
  workspaceId: string;
  /**
   * Task dispatch sends `true`: the host stops the sandbox as soon as the
   * initial task ends, exactly what a run was. A workbench omits it — its box
   * must outlive every turn, and the fleet suspends it when idle instead.
   */
  ephemeral?: boolean;
  /**
   * The initial work order. Absent means a BARE sandbox: it boots, serves
   * exec and ssh, and waits. A workbench creates one of these and drives it
   * with `exec`, one agent process per turn.
   */
  task?: CreateSandboxTaskInput;
  /**
   * The LLM upstream this SANDBOX is wired to — which builds its egress route
   * table. A bare sandbox has no task to carry `task.provider`, so it goes
   * here. When both are sent the fleet refuses a disagreement, so a caller
   * sets one or the other.
   */
  provider?: 'anthropic' | 'openai';
  /**
   * `owner/name`: the repository a BARE sandbox's GitHub token is scoped to,
   * as `task.repo.slug` scopes a dispatch. The fleet proxy's verified-commit,
   * checks, review and review-thread endpoints refuse a box with no scope.
   * The fleet keeps it on the box's record, so it survives a restart and a
   * suspend. Sent beside `task.repo` it must name the same repository, so a
   * task dispatch does not send it.
   *
   * The fleet decodes a create body leniently (no unknown-field refusal), so a
   * fleet that predates the field ignores it rather than refusing the create.
   */
  repo?: string;
  /**
   * A BARE sandbox with `repo` only: the repository's default branch. The
   * fleet boots from the golden for `(repo, baseBranch)` when one exists, with
   * the repository already checked out at `/work/repo`, and queues a bake when
   * none does. A dispatch names its branch in `task.repo.baseBranch` instead.
   *
   * Lenient decode again: a fleet that predates the field ignores it and boots
   * the base image, which the workbench clone script handles as before.
   */
  baseBranch?: string;
  /** Who the box's commits are by. Written into the guest's ~/.gitconfig; not a secret. */
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  githubToken?: string;
  /**
   * The credential for THIS sandbox's provider, and only that one. The fleet
   * holds no key of its own and refuses a dispatch that arrives without the
   * one its provider needs, so an omitted key is a 400 rather than a guest
   * that boots and then fails on its first call.
   */
  anthropicKey?: string;
  openaiKey?: string;
  /**
   * The sandbox's privacy posture. Talyn sets exactly one thing on it:
   * `credentials.<the other vendor> = 'none'`.
   *
   * That is not decoration. The gateway fills an absent credential from its
   * tenant's sealed custody, and the fleet applies this policy at every door a
   * credential can enter the run's proxy — including the adoption re-pull after
   * a fleetd restart, which happens with nobody watching. Suppressing the
   * vendor this run is not using makes "spend somebody else's subscription"
   * impossible rather than merely unlikely.
   *
   * Never suppress `github`, and never suppress both LLM vendors: the fleet
   * nulls its whole refresh hook when everything is suppressed, which would
   * strip the key this dispatch supplied.
   */
  policy?: {
    credentials?: { github?: 'none'; anthropic?: 'none'; openai?: 'none' };
    /**
     * How far the box may reach. Absent means the fleet's default, `proxy`:
     * no routed network at all, everything through the credential proxy.
     *
     * `open` is routed and unbounded, and it does NOT change what the box may
     * spend — the fleet deleted the rule that coupled the two, so the proxy
     * still attaches credentials in every mode. One refusal survives and Talyn
     * satisfies it by construction: a routed run may not carry a GitHub token
     * that names no repository, and every Talyn dispatch names one.
     */
    egress?: { mode?: 'proxy' | 'filtered' | 'open' };
  };
  /**
   * The workspace's MCP servers, defined on the spot.
   *
   * Inline rather than stored on the fleet, and that is a decision with a
   * consequence. The fleet seals an inline secret on arrival and persists it
   * NOWHERE — which is exactly what we want, and which makes us the only party
   * that still holds it. So `poller.recredential` has to hand them back after a
   * fleetd restart, or an adopted box keeps its MCP routes and 401s on every
   * tool call for the rest of the run.
   *
   * The guest never sees any of this. It is configured with a plain
   * `http://<name>.<integration-domain><path>` carrying no token, and the
   * host's proxy attaches the credential per request — so an agent that reads a
   * hostile repository and decides to exfiltrate the Linear key has nothing to
   * find.
   *
   * Accepted on CREATE only. A sandbox's MCP servers are fixed when it boots,
   * because the proxy's route table, its DNS names and the guest's agent
   * configuration are all built once. That costs us nothing: every Talyn
   * dispatch creates its own ephemeral sandbox, so per-task is what this
   * already is.
   */
  mcpServers?: FleetMcpServerInline[];
}

/** One MCP server, as the fleet takes it on a create. */
export interface FleetMcpServerInline {
  /** Becomes a hostname label inside the sandbox: lowercase, digits, hyphens. */
  name: string;
  /** The endpoint, path and all. A bare host is refused — nothing to call. */
  url: string;
  transport?: 'http';
  /** Reaches the guest through the agent's own prompt, so it is worth writing. */
  description?: string;
  /** Write-only at the fleet, and never persisted there for an inline server. */
  secret?: string;
  /** How the host attaches the secret. Defaults to bearer when one is given. */
  inject?: {
    kind?: '' | 'header' | 'bearer' | 'basic' | 'query';
    header?: string;
    prefix?: string;
    user?: string;
    param?: string;
    extra?: Record<string, string>;
  };
  /**
   * An allow-list of tool names. Absent means every tool the server
   * advertises; an empty array means none, and the fleet keeps the two
   * distinct. A filtered tool is never registered with the agent at all rather
   * than refused on call, so it costs no context either.
   */
  tools?: string[];
}

/**
 * A capacity refusal from the fleet — the host is full, draining, or out of
 * disk. Distinct from a terminal error on purpose: the task is fine and should
 * be retried or failed back to another provider, not failed (spec §10.7, §11.6).
 */
export class FleetCapacityError extends Error {
  readonly isCapacity = true;
  readonly status = 503;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    /**
     * Which kind of "not now" this is.
     *
     * Both mean retry, so nothing in the dispatch path branches on it — but
     * they are different sentences to a user, and `message` cannot be shown to
     * one either way: it carries the host's private endpoint, which has no
     * business in a customer-facing banner.
     */
    readonly reason: 'no_capacity' | 'unreachable' = 'no_capacity',
  ) {
    super(message);
    this.name = 'FleetCapacityError';
  }
}

/**
 * The host is reachable and says the sandbox does not exist.
 *
 * Unlike every other fleet error, this one is TERMINAL: capacity, throttle and
 * unreachable all mean "ask again later, the work is still going on the metal",
 * but a healthy host is authoritative about its own sandboxes. One disappears
 * when fleetd restarts without adopting it, or the microVM is reclaimed — and
 * the task can never progress again, so retrying is a loop with no exit. Two of
 * them ran for 21 hours on 2026-08-06, reconciling every tick and failing
 * identically.
 *
 * A 409 `sandbox_not_live` is authoritative. Older hosts can answer with a
 * missing-box message or a 404 instead.
 *
 * The name keeps "run" because the id this matches on is still the run id of
 * the credential wire (`talyn-<taskId>`), and every caller branches on the
 * class rather than the noun.
 */
export class FleetRunNotFoundError extends Error {
  readonly isRunNotFound = true;
  constructor(message: string) {
    super(message);
    this.name = 'FleetRunNotFoundError';
  }
}

/** Whether a fleet error means "no such sandbox". Check the 409 code first;
 * older hosts can send the same meaning as text. */
export function isRunNotFoundResponse(status: number, message: string, code?: string): boolean {
  return (
    (status === 409 && (code === 'sandbox_not_live' || /not running on this host/i.test(message))) ||
    status === 404 ||
    /no such run|run not found|unknown run|no such sandbox|sandbox not found|unknown sandbox/i.test(
      message,
    )
  );
}

/**
 * The control plane lost the host's answer to a dispatch (504
 * `dispatch_uncertain`). The sandbox MAY exist: the caller must retry with the
 * SAME id — the create is idempotent on it — and never fail back to another
 * provider, which could run the task twice.
 */
export class FleetDispatchUncertainError extends Error {
  readonly isDispatchUncertain = true;
  readonly status = 504;
  constructor(message: string) {
    super(message);
    this.name = 'FleetDispatchUncertainError';
  }
}

/** A rate-limit response. Shaped for the generic poller's ThrottleBackoff,
 *  which duck-types on `status === 429` and an optional `retryAfterMs`. */
/**
 * Any other non-2xx answer. A plain Error with the status on it, so a caller
 * that must branch on "the fleet refused this body" (400) can do so without
 * matching the message.
 */
export class FleetHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The fleet's machine code (`error` in its JSON body), when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FleetHttpError';
  }
}

export class FleetThrottleError extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FleetThrottleError';
  }
}


/**
 * The dispatcher fleet requests go out through.
 *
 * A fleet host binds loopback and is reachable only over the deployment's
 * private link (a tailnet). On a PaaS the backend joins that tailnet in
 * userspace mode — there is no NET_ADMIN and therefore no TUN device — so the
 * route is not transparent: traffic has to be dialled through the local HTTP
 * proxy tailscaled exposes.
 *
 * Scoped to THIS client on purpose. A global proxy agent would send GitHub,
 * Supabase and Anthropic through the tailnet daemon too, which is both slower
 * and a much larger blast radius for a component whose only job is reaching one
 * private host.
 *
 * Unset means direct, which is what a deployment with no self-hosted fleet — or
 * one whose backend shares a network with its hosts — should do.
 */
let cachedProxy: { url: string; dispatcher: unknown } | null = null;

/** Exported for tests: proving this CONSTRUCTS is the only check that catches
 *  a missing `undici` before production does. */
export function fleetDispatcher(target?: string): unknown | undefined {
  const url = process.env.FLEET_HTTP_PROXY ?? '';
  if (!url) return undefined;
  // FLEET_HTTP_PROXY reaches the TAILNET. A fleet host is a tailnet name with no
  // route from here, which is the whole reason it exists — but the sandbox
  // GATEWAY is on the public internet, and sending its requests into a tailscale
  // SOCKS proxy is a guaranteed timeout.
  //
  // That took Talyn's dispatch down on 2026-08-18: every task queued behind
  // "Fleet unreachable at https://yasctl-...: The operation was aborted due to
  // timeout", while the same URL answered in half a second from a shell. The
  // proxy was applied to every fleet request unconditionally, and nothing about
  // a public URL made it opt out.
  if (target && targetBypassesProxy(target)) return undefined;
  if (cachedProxy?.url === url) return cachedProxy.dispatcher;
  // `undici` is a DECLARED DEPENDENCY of this package, not something Node
  // provides. Node bundles undici to implement global `fetch`, but only as an
  // internal module — `require('undici')` resolves nothing unless the package
  // is installed. This comment used to claim the opposite, and the belief cost
  // a production deploy: the dev tree happened to have it transitively, the
  // runtime image prunes dev dependencies, and the miss was invisible locally
  // because FLEET_HTTP_PROXY is unset there so this line never ran.
  //
  // Still required lazily rather than imported at module scope: a deployment
  // with no private link never needs a proxy agent, and this file is imported
  // by the provider registry that every workspace touches.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ProxyAgent } = require('undici') as { ProxyAgent: new (u: string) => unknown };
  cachedProxy = { url, dispatcher: new ProxyAgent(url) };
  return cachedProxy.dispatcher;
}

/**
 * Whether this target must NOT go through FLEET_HTTP_PROXY.
 *
 * Decided by comparing hosts with the configured pin rather than by guessing
 * from the shape of the name: "is it a tailnet address" is a heuristic that
 * would be wrong the first time a host is reached some other way, and this is
 * the one decision that silently converts into a total dispatch outage.
 */
export function targetBypassesProxy(target: string): boolean {
  const pinned = (process.env.FLEET_PINNED_ENDPOINT ?? '').trim();
  if (!pinned) return false;
  try {
    return new URL(target).host === new URL(pinned).host;
  } catch {
    return false;
  }
}

/**
 * Unwrap an Error's cause chain into something loggable.
 *
 * undici reports the interesting part here — ECONNREFUSED, EAI_AGAIN, a TLS
 * failure, a proxy refusal — while the outer message stays generic. Dropping it
 * is what made an unreachable gateway indistinguishable from a slow one.
 */
export function describeCause(err: unknown, depth = 0): string | undefined {
  if (depth > 4 || !(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    const inner = describeCause(cause, depth + 1);
    return `${cause.name}${code ? `(${code})` : ''}: ${cause.message}${inner ? ` <- ${inner}` : ''}`;
  }
  return String(cause);
}

/** Exposed for tests, which change the env between cases. */
export function resetFleetDispatcherCache(): void {
  cachedProxy = null;
}

/**
 * The default request timeout.
 *
 * Right for dispatch and the poller, which can afford to wait on a busy host.
 * The admin surface overrides it — a console page fanning out over hosts
 * cannot hang 20s on one dead box, and a golden GC genuinely takes longer than
 * either.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
/** How long a resume may take. The fleet itself allows two hours; ten minutes covers a multi-gigabyte pull. */
const RESUME_TIMEOUT_MS = 10 * 60_000;

export class FleetClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(path: string): string {
    return `${this.endpoint.replace(/\/+$/, '')}${path}`;
  }

  /**
   * The ordinary call: the decoded body and nothing else.
   *
   * Almost everything wants this. `requestWithMeta` exists for the one caller
   * that needs a response HEADER — see `createSandbox` and FLEET_HOST_HEADER —
   * and routing every other method through a two-field object to serve it would
   * put an unwrap at forty call sites to inform one.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return (await this.requestWithMeta<T>(path, init, opts)).data;
  }

  private async requestWithMeta<T>(
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<{ data: T; host?: string }> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const started = Date.now();
    const method = init.method ?? 'GET';
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      });
    } catch (err) {
      this.recordHttp(method, path, 0, started, false, err);
      // Network-level failure. Treated as capacity rather than terminal: an
      // unreachable host is an availability problem, and failing the user's
      // task because one box is down is exactly what fail-back exists to avoid.
      //
      // Logged with the CAUSE and the elapsed time, because the message alone
      // is not diagnosable. "The operation was aborted due to timeout" is what
      // AbortSignal says about any request that ran out of time, and it names
      // neither what failed nor how long it really took — so a DNS failure, a
      // refused connection, a proxy that cannot route, and a server that is
      // simply slow all read identically. That ambiguity cost a whole afternoon
      // on 2026-08-18: the same URL answered in 0.2s from a shell in the same
      // container while every dispatch reported it unreachable.
      const tookMs = Date.now() - started;
      console.warn(
        `[fleet] ${method} ${path} failed after ${tookMs}ms:`,
        JSON.stringify({
          url: this.url(path),
          timeoutMs,
          proxied: fleetDispatcher(this.endpoint) !== undefined,
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          cause: describeCause(err),
        }),
      );
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'unreachable',
      );
    }

    this.recordHttp(method, path, resp.status, started, resp.ok);

    if (resp.status === 503) {
      throw new FleetCapacityError(
        await errorMessage(resp, 'the fleet has no capacity'),
        parseRetryAfterMs(resp),
      );
    }
    if (resp.status === 429) {
      throw new FleetThrottleError(await errorMessage(resp, 'rate limited'), parseRetryAfterMs(resp));
    }
    if (resp.status === 504) {
      // The control plane started the create and never heard how it ended.
      // Retry the SAME id (idempotent), never another provider.
      throw new FleetDispatchUncertainError(
        await errorMessage(resp, 'the fleet lost the answer to this request'),
      );
    }
    if (!resp.ok) {
      const { message, code } = await errorBody(resp, `fleet returned ${resp.status}`);
      // Terminal, not retryable — see FleetRunNotFoundError.
      if (isRunNotFoundResponse(resp.status, message, code)) {
        throw new FleetRunNotFoundError(message);
      }
      throw new FleetHttpError(message, resp.status, code);
    }
    // The gateway names the host that took a create, because Talyn has to bound
    // a later credential pull BY HOST and cannot read that off a registry it no
    // longer consults. A host answering directly does not send it, and its
    // absence is not an error — the registry supplied the name on that path.
    const host = resp.headers.get(FLEET_HOST_HEADER) ?? undefined;
    if (resp.status === 204) return { data: undefined as T, host };
    return { data: (await resp.json()) as T, host };
  }

  /**
   * Feed the debug bus, per CLAUDE.md's rule that every outbound HTTP funnel
   * records here.
   *
   * This client recorded nothing until the operator console started making
   * fleet calls per pageview — a pre-existing gap that only became visible
   * once there was traffic worth watching. The URL is the PATH, already free
   * of query strings and of the host's tailnet address; recording the full URL
   * would put a private endpoint in a panel that is screenshared.
   */
  private recordHttp(
    method: string,
    path: string,
    status: number,
    started: number,
    ok: boolean,
    err?: unknown,
  ): void {
    if (!debugBus.isRecording()) return;
    debugBus.recordHttp({
      service: 'fleet',
      method,
      url: path.split('?')[0] ?? path,
      status,
      durationMs: Date.now() - started,
      ok,
      // The error itself, not its message: describeError walks the cause chain,
      // which is where undici puts ECONNREFUSED and the like.
      error: err,
    });
  }

  /** Liveness + version. Used by validateCredentials and testConnection. */
  async ping(): Promise<{ status: string; version: string }> {
    return this.request('/healthz');
  }

  // --------------------------------------------------------------------
  // Operator surface
  //
  // Read-side methods the admin console proxies. One method per fleetd
  // route, no reshaping — the console's own view types live in
  // @talyn/shared and the mapping happens in services/admin/fleetProxy.ts,
  // so this file stays a faithful description of the fleet's API.
  // --------------------------------------------------------------------

  async capacity(): Promise<FleetCapacity> {
    return this.request('/v1/capacity');
  }

  async stats(): Promise<FleetStats> {
    return this.request('/v1/stats');
  }

  /**
   * The Prometheus scrape, as text.
   *
   * Not routed through `request()`, which parses JSON. Size-capped because
   * this is proxied straight to a browser and a runaway registry should not
   * be able to hand the console a hundred megabytes.
   */
  async metricsText(maxBytes = 1_048_576): Promise<string> {
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(this.url('/metrics'), {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/plain' },
        signal: AbortSignal.timeout(this.timeoutMs),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      });
    } catch (err) {
      this.recordHttp('GET', '/metrics', 0, started, false, err);
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.recordHttp('GET', '/metrics', resp.status, started, resp.ok);
    if (!resp.ok) throw new Error(`fleet returned ${resp.status} for /metrics`);
    const text = await resp.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  async listSandboxes(): Promise<{ sandboxes: FleetSandbox[] }> {
    return this.request('/v1/sandboxes');
  }

  /**
   * The same path against the GATEWAY, which answers a different thing.
   *
   * A host serves its own full records here. The gateway serves its placement
   * INDEX — id, host, and little else — because it holds no live state and a
   * list that fanned out to every host would go blank whenever one was down.
   * So the two share a route and not a shape, and giving them one method would
   * hand the console `status: undefined` for every row and call it live data.
   *
   * The ids come back live-only (the gateway drops rows it has marked gone), so
   * a caller wanting real status hydrates each one with `getSandbox`.
   */
  async listGatewaySandboxes(): Promise<{ sandboxes: GatewaySandboxRef[] }> {
    return this.request('/v1/sandboxes');
  }

  async listGoldens(): Promise<FleetGoldensView> {
    return this.request('/v1/goldens');
  }

  async getRebake(): Promise<FleetRebakeStatus> {
    return this.request('/v1/goldens/rebake');
  }

  // --------------------------------------------------------------------
  // Mutations
  //
  // Every one takes the actor/reason envelope. fleetd 400s a body missing
  // either, so the types make them non-optional rather than letting a call
  // site discover it at runtime.
  // --------------------------------------------------------------------

  async setDrain(input: FleetAttribution & { draining: boolean }): Promise<void> {
    await this.request('/v1/drain', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensGc(
    input: FleetAttribution & { force?: boolean; dryRun?: boolean; minAge?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/gc', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensPin(
    input: FleetAttribution & { path: string; pinned: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/pin', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensDelete(
    input: FleetAttribution & { path: string },
  ): Promise<{ path: string; key: string; freedBytes: number }> {
    return this.request('/v1/goldens/delete', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensRebake(
    input: FleetAttribution & { repo: string; baseBranch?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/rebake', { method: 'POST', body: JSON.stringify(input) });
  }

  /**
   * Dispatch: 202 with the sandbox record, idempotent on `input.id`.
   *
   * Returns the host alongside it when the endpoint named one. Through the
   * gateway that is the only way to learn it — the record in the body is
   * fleetd's and says nothing about which fleetd wrote it — and it is not
   * cosmetic: `resolveRunCredentials` answers a host's credential pull only for
   * a run dispatched to THAT host, and a dispatch that recorded no host refuses
   * every pull. Dialling a host directly the answer is already known, so `host`
   * is absent there and the caller keeps what the registry told it.
   */
  async createSandbox(
    input: CreateSandboxInput,
  ): Promise<{ sandbox: FleetSandbox; host?: string }> {
    const { data, host } = await this.requestWithMeta<FleetSandbox>('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { sandbox: data, host };
  }

  /**
   * One sandbox. A terminal one keeps answering from a tombstone with
   * `retired: true` rather than 404ing straight away.
   */
  async getSandbox(
    id: string,
  ): Promise<{ sandbox: FleetSandbox; terminal: boolean; retired?: boolean }> {
    return this.request(`/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  async getEvents(
    id: string,
    after: number,
    limit?: number,
  ): Promise<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const suffix = limit ? `&limit=${limit}` : '';
    return this.request(`/v1/sandboxes/${encodeURIComponent(id)}/events?after=${after}${suffix}`);
  }

  /**
   * Follow a sandbox's transcript as server-sent events.
   *
   * The cursor poll above is correct but its latency is the caller's poll
   * interval — 10s here, which is what an agent's output arriving in
   * ten-second bursts looks like to somebody watching a task. The fleet's
   * follow endpoint pushes instead, and each frame carries the identical
   * {events, cursor, terminal} object `getEvents` returns, so this and the
   * poll share one shape and a dropped stream resumes from the same cursor.
   *
   * Yields frames until the sandbox is terminal, the caller aborts, or the
   * stream breaks. A broken stream is NOT an error worth surfacing: the poll is
   * still running underneath and will finish the job a little less promptly.
   */
  async *followEvents(
    id: string,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const resp = await fetch(
      this.url(`/v1/sandboxes/${encodeURIComponent(id)}/events?follow=1&after=${after}`),
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        signal,
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      },
    );
    if (!resp.ok || !resp.body) {
      throw new Error(`follow ${id}: ${resp.status} ${resp.statusText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    // Framing lives in @talyn/shared so this, the admin SSE proxy, and the
    // browser that reads the proxied stream cannot disagree about what a frame
    // is — a disagreement there shows up as "the transcript stops halfway",
    // not as an exception.
    const parser = createSseJsonParser<{
      events: FleetEvent[];
      cursor: number;
      terminal: boolean;
    }>();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          yield frame;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Cancel the running task. On Talyn's ephemeral sandboxes the host then
   *  stops the sandbox too. */
  async cancelSandbox(id: string): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  /**
   * Hand a sandbox's credentials back after the fleet restarted under it.
   *
   * The fleet never writes credentials to disk, so a `fleetd` restart loses
   * them and the surviving microVM cannot authenticate anything — its next call
   * returns `502 no Anthropic credential was supplied`, and it then burns the
   * rest of its deadline before being reported as "deadline exceeded".
   *
   * We are the only party that still has them. Re-supplying is what makes a
   * fleet deploy survivable for a task that is already running, which is what
   * lets deploys happen at all rather than waiting for an idle host.
   */
  async setSandboxCredentials(
    id: string,
    creds: {
      githubToken: string;
      anthropicKey?: string;
      openaiKey?: string;
      repo?: string;
      /**
       * One credential per integration, keyed by NAME — which for us means one
       * per MCP server. The fleet spells this `integrations` here and
       * `integrationSecrets` on a create; it is the same map.
       *
       * REPLACES the whole set rather than merging into it, because installing
       * credentials replaces the running proxy's entire struct. A name omitted
       * here is a credential the box loses.
       */
      integrations?: Record<string, string>;
    },
  ): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/credentials`, {
      method: 'POST',
      body: JSON.stringify(creds),
    });
  }

  // --------------------------------------------------------------------
  // Exec, ssh and the long-lived sandbox lifecycle (workbenches)
  // --------------------------------------------------------------------

  /** Wait mode: the command runs to its end, then its frames come back in one answer. */
  async exec(id: string, req: FleetExecRequest): Promise<FleetExecFrame> {
    return this.request<FleetExecFrame>(
      sandboxPath(id, '/exec'),
      { method: 'POST', body: JSON.stringify(req) },
      { timeoutMs: execWaitMs(req) },
    );
  }

  /**
   * Follow mode: the command's frames as server-sent events, the same
   * `{events, cursor, terminal}` object each time. Ends after the frame with
   * `terminal: true`, when the caller aborts, or when the stream breaks.
   *
   * The command does NOT stop when this stream does: the fleet runs it
   * detached from the request, so a dropped connection loses the view, not
   * the work.
   */
  async *execFollow(
    id: string,
    req: FleetExecRequest,
    signal: AbortSignal,
  ): AsyncGenerator<FleetExecFrame> {
    const path = sandboxPath(id, '/exec?follow=1');
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
        method: 'POST',
        body: JSON.stringify(req),
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        signal,
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      });
    } catch (err) {
      this.recordHttp('POST', path, 0, started, false, err);
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'unreachable',
      );
    }
    this.recordHttp('POST', path, resp.status, started, resp.ok);
    if (!resp.ok || !resp.body) {
      const { message, code } = await errorBody(resp, `exec ${id}: ${resp.status} ${resp.statusText}`);
      if (resp.status === 503) throw new FleetCapacityError(message, parseRetryAfterMs(resp));
      if (isRunNotFoundResponse(resp.status, message, code)) throw new FleetRunNotFoundError(message);
      throw new FleetHttpError(message, resp.status, code);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseJsonParser<FleetExecFrame>();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          yield frame;
          if (frame.terminal) return;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * A command whose output should NOT land in the sandbox's events ring — a
   * diff, a file read — tried as a quiet exec first.
   *
   * Learned once per endpoint: an answer with `events` in it means the fleet
   * ignored the field, and every later call skips straight to a plain exec. A
   * 400 or 404 to the quiet body is retried once as a plain exec, and only a
   * plain exec that then works marks the feature absent — a 404 that repeats
   * is the sandbox being gone, and the retry reports that.
   */
  async quietExec(id: string, req: FleetExecRequest): Promise<FleetExecOutcome> {
    const key = `${this.endpoint}|quiet-exec`;
    const plain = async (): Promise<FleetExecOutcome> => ({
      kind: 'events',
      frame: await this.exec(id, req),
    });
    if (optionalSupport.get(key) === false) return plain();

    let body: unknown;
    try {
      body = await this.request<unknown>(
        sandboxPath(id, `/exec?${QUIET_EXEC.query}`),
        { method: 'POST', body: JSON.stringify(req) },
        { timeoutMs: execWaitMs(req) },
      );
    } catch (err) {
      const status =
        err instanceof FleetHttpError ? err.status : err instanceof FleetRunNotFoundError ? 404 : 0;
      if (status !== 400 && status !== 404) throw err;
      const outcome = await plain();
      optionalSupport.set(key, false);
      return outcome;
    }
    const quiet = QUIET_EXEC.parse(body);
    if (quiet) {
      optionalSupport.set(key, true);
      return { kind: 'quiet', result: quiet };
    }
    const frame = body as Partial<FleetExecFrame>;
    if (Array.isArray(frame.events)) {
      optionalSupport.set(key, false);
      return {
        kind: 'events',
        frame: { events: frame.events, cursor: frame.cursor ?? 0, terminal: frame.terminal ?? true },
      };
    }
    throw new Error(`exec ${id}: the fleet answered with neither output nor events`);
  }

  /**
   * Replace the sandbox's authorized SSH keys. The list is the COMPLETE set —
   * an empty one revokes everything — and the fleet offers no way to read the
   * current one back, so whoever calls this owns the whole set.
   */
  async setSshKeys(id: string, publicKeys: string[]): Promise<FleetSshAccess> {
    return this.request<FleetSshAccess>(sandboxPath(id, '/ssh'), {
      method: 'POST',
      body: JSON.stringify({ publicKeys }),
    });
  }

  /**
   * `GET /v1/sandboxes/{id}/ssh-stream`: one HTTP/1.1 upgrade spliced onto the
   * guest's sshd. Raw SSH bytes both ways after the 101.
   */
  openSshStream(id: string, opts: { timeoutMs?: number } = {}): Promise<Duplex> {
    return this.upgrade(sandboxPath(id, '/ssh-stream'), opts.timeoutMs);
  }

  /**
   * `GET /v1/sandboxes/{id}/pty`: a shell on a pseudo-terminal, framed as
   * `[type:1][len:uint32 BE][payload]` (see PTY_FRAME). `session` runs the
   * shell inside `tmux new-session -A`, so a reconnect lands back in it.
   * An older guest answers 409 `pty_unsupported`, thrown as
   * FleetPtyUnsupportedError so the caller can fall back to ssh.
   */
  async openPty(
    id: string,
    opts: { cols: number; rows: number; session?: string; cwd?: string; timeoutMs?: number },
  ): Promise<Duplex> {
    const qs = new URLSearchParams({ cols: String(opts.cols), rows: String(opts.rows) });
    if (opts.session) qs.set('session', opts.session);
    if (opts.cwd) qs.set('cwd', opts.cwd);
    try {
      return await this.upgrade(sandboxPath(id, `/pty?${qs.toString()}`), opts.timeoutMs);
    } catch (err) {
      if (err instanceof FleetHttpError && (err.code === 'pty_unsupported' || err.status === 405)) {
        throw new FleetPtyUnsupportedError(err.message);
      }
      // A fleet with no /pty route at all answers Go's plain-text 404.
      if (err instanceof FleetHttpError && err.status === 404 && !err.code) {
        throw new FleetPtyUnsupportedError(err.message);
      }
      throw err;
    }
  }

  /**
   * One HTTP/1.1 upgrade, websocket-SHAPED for the middleboxes (`Upgrade:
   * websocket` and a Sec-WebSocket-Key, answered with 101 and the RFC 6455
   * digest) and not websocket after it. Built on node's http client because
   * fetch cannot hand back an upgraded socket.
   *
   * Not routed through FLEET_HTTP_PROXY: the normal path is the gateway, which
   * is public. A deployment that reaches hosts only over the tailnet proxy has
   * no terminal until this learns to CONNECT through it.
   */
  private upgrade(path: string, timeoutMs = 20_000): Promise<Duplex> {
    const target = new URL(this.url(path));
    const key = randomBytes(16).toString('base64');
    const started = Date.now();
    return new Promise<Duplex>((resolve, reject) => {
      const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = doRequest(target, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        timeout: timeoutMs,
      });
      req.on('upgrade', (res, socket, head) => {
        this.recordHttp('GET', path, res.statusCode ?? 101, started, true);
        const expected = createHash('sha1').update(key + WS_ACCEPT_MAGIC).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          reject(new Error('the fleet answered the upgrade with the wrong Sec-WebSocket-Accept; refusing the stream'));
          return;
        }
        socket.setTimeout(0);
        // Bytes the guest sent right behind the 101 headers.
        if (head && head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          if (chunks.length < 16) chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          const status = res.statusCode ?? 0;
          this.recordHttp('GET', path, status, started, false, new Error(text));
          let message = text;
          let code: string | undefined;
          try {
            const parsed = JSON.parse(text) as { message?: string; error?: string };
            message = parsed.message || parsed.error || text;
            code = parsed.error;
          } catch {
            /* plain text */
          }
          if (status === 503) reject(new FleetCapacityError(message));
          else if (isRunNotFoundResponse(status, message, code)) {
            reject(new FleetRunNotFoundError(message));
          } else reject(new FleetHttpError(`${path.split('?')[0]}: ${status} ${message}`, status, code));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${path.split('?')[0]}: timed out after ${timeoutMs}ms`)));
      req.on('error', (err) => {
        this.recordHttp('GET', path, 0, started, false, err);
        reject(err);
      });
      req.end();
    });
  }

  /**
   * `ANY /v1/sandboxes/{id}/ports/{port}/{path...}` — the preview proxy. The
   * raw Response is handed back for the caller to stream; status codes from
   * the guest's server are its answer, not errors.
   */
  async proxyPort(
    id: string,
    port: number,
    pathAndQuery: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal },
  ): Promise<Response> {
    const path = sandboxPath(id, `/ports/${port}/${pathAndQuery.replace(/^\/+/, '')}`);
    const started = Date.now();
    try {
      const resp = await fetch(this.url(path), {
        method: init.method,
        headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
        ...(init.body && init.body.length > 0 ? { body: init.body } : {}),
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(120_000),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      });
      this.recordHttp(init.method, path, resp.status, started, resp.status < 500);
      return resp;
    } catch (err) {
      this.recordHttp(init.method, path, 0, started, false, err);
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'unreachable',
      );
    }
  }

  async suspendSandbox(id: string): Promise<void> {
    await this.request(sandboxPath(id, '/suspend'), { method: 'POST', body: '{}' });
  }

  async resumeSandbox(id: string): Promise<void> {
    // A hibernated box pulls its image back from object storage first, which
    // the fleet allows minutes for. Sixty seconds gave up on a resume that works.
    await this.request(sandboxPath(id, '/resume'), { method: 'POST', body: '{}' }, { timeoutMs: RESUME_TIMEOUT_MS });
  }

  /** Delete a sandbox. Already gone counts as done: the caller wanted it gone. */
  async deleteSandbox(id: string): Promise<void> {
    try {
      await this.request(sandboxPath(id), { method: 'DELETE' }, { timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof FleetRunNotFoundError) return;
      throw err;
    }
  }

  async getDiff(
    id: string,
    query: { base: string; path?: string; patch?: boolean; cwd?: string },
  ): Promise<FleetOptionalResult<FleetDiffResult>> {
    const qs = new URLSearchParams({ base: query.base });
    if (query.path) qs.set('path', query.path);
    if (query.patch) qs.set('patch', '1');
    if (query.cwd) qs.set('cwd', query.cwd);
    return this.optionalGet<FleetDiffResult>('diff', sandboxPath(id, `/diff?${qs.toString()}`));
  }

  async listFiles(id: string, opts: { cwd?: string } = {}): Promise<FleetOptionalResult<FleetFilesResult>> {
    const qs = opts.cwd ? `?${new URLSearchParams({ cwd: opts.cwd }).toString()}` : '';
    return this.optionalGet<FleetFilesResult>('files', sandboxPath(id, `/files${qs}`));
  }

  async readFile(
    id: string,
    filePath: string,
    opts: { cwd?: string } = {},
  ): Promise<FleetOptionalResult<FleetFileResult>> {
    const qs = new URLSearchParams({ path: filePath });
    if (opts.cwd) qs.set('cwd', opts.cwd);
    return this.optionalGet<FleetFileResult>('file', sandboxPath(id, `/file?${qs.toString()}`));
  }

  /**
   * A GET against a route only newer fleets serve. Unsupported is an ANSWER,
   * not an error: a 404 whose body is not the fleet's own JSON error (Go's mux
   * says "404 page not found"), a 405 or a 501 means the route is not there.
   * Learned once per endpoint and feature.
   */
  private async optionalGet<T>(feature: string, path: string): Promise<FleetOptionalResult<T>> {
    const key = `${this.endpoint}|${feature}`;
    if (optionalSupport.get(key) === false) return { supported: false };
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      });
    } catch (err) {
      this.recordHttp('GET', path, 0, started, false, err);
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'unreachable',
      );
    }
    this.recordHttp('GET', path, resp.status, started, resp.ok);
    if (resp.ok) {
      optionalSupport.set(key, true);
      return { supported: true, data: (await resp.json()) as T };
    }
    const text = await resp.text().catch(() => '');
    let fleetError: { message?: string; error?: string } | null = null;
    try {
      fleetError = JSON.parse(text) as { message?: string; error?: string };
    } catch {
      fleetError = null;
    }
    const routeMissing =
      resp.status === 405 || resp.status === 501 || (resp.status === 404 && !fleetError);
    if (routeMissing) {
      optionalSupport.set(key, false);
      return { supported: false };
    }
    const message = fleetError?.message || fleetError?.error || `fleet returned ${resp.status}`;
    if (resp.status === 503) throw new FleetCapacityError(message, parseRetryAfterMs(resp));
    // A 404 about the THING asked for (a missing file) is not a missing sandbox.
    if (resp.status === 404 && fleetError?.error === 'no_such_file') throw new FleetHttpError(message, 404, 'no_such_file');
    if (isRunNotFoundResponse(resp.status, message, fleetError?.error)) throw new FleetRunNotFoundError(message);
    throw new FleetHttpError(message, resp.status, fleetError?.error);
  }
}

// ------------------------------------------------------------------------
// Exec, ssh and the long-lived sandbox lifecycle (workbenches)
// ------------------------------------------------------------------------

/** One command for `POST /v1/sandboxes/{id}/exec`. argv, never a shell string. */
export interface FleetExecRequest {
  cmd: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /** Bounds the command in the guest. Zero or absent is no bound. */
  timeoutMs?: number;
}

/**
 * What exec answers in wait mode, and what each SSE frame carries in follow
 * mode: the sandbox's events after the cursor the exec started at.
 *
 * NOT only this command's output. The ring is per SANDBOX, so a command that
 * runs while another is running sees the other's frames too — callers that
 * need their own output must frame it (see `services/workbenches/execFraming`).
 * `terminal` is per command: THIS exec has finished.
 */
export interface FleetExecFrame {
  events: FleetEvent[];
  cursor: number;
  terminal: boolean;
}

/** A quiet exec's answer: the command's own output, never written to the ring. */
export interface FleetQuietExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  timedOut?: boolean;
  /** The fleet caps a quiet answer (4 MiB) and says so rather than cutting silently. */
  truncated?: boolean;
}

export type FleetExecOutcome =
  | { kind: 'quiet'; result: FleetQuietExecResult }
  | { kind: 'events'; frame: FleetExecFrame };

/**
 * The quiet-exec contract, in ONE place: `POST /exec?quiet=1`, answered in wait
 * mode with `{stdout, stderr, exit:{exitCode, signal?, timedOut?}, truncated}`.
 * The output skips the sandbox's events ring.
 *
 * An older fleet ignores the unknown query parameter and runs an ordinary
 * exec, so its answer has `events` instead — which is how the probe learns
 * the feature is absent without a 404 to read.
 */
export const QUIET_EXEC = {
  query: 'quiet=1',
  parse(body: unknown): FleetQuietExecResult | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (typeof b.stdout !== 'string') return null;
    const exit = (b.exit && typeof b.exit === 'object' ? b.exit : {}) as Record<string, unknown>;
    const exitCode =
      typeof exit.exitCode === 'number' ? exit.exitCode : typeof b.exitCode === 'number' ? b.exitCode : null;
    if (exitCode === null) return null;
    return {
      stdout: b.stdout,
      stderr: typeof b.stderr === 'string' ? b.stderr : '',
      exitCode,
      ...(typeof exit.signal === 'string' && exit.signal ? { signal: exit.signal } : {}),
      ...(exit.timedOut === true ? { timedOut: true } : {}),
      ...(b.truncated === true ? { truncated: true } : {}),
    };
  },
};

/** What `POST /v1/sandboxes/{id}/ssh` answers: who to log in as and the key to pin. */
export interface FleetSshAccess {
  user: string;
  /** `ssh-ed25519 AAAA…` — the guest's own host key, for pinning. */
  hostPublicKey: string;
  fingerprint?: string;
  knownHosts?: string;
  host?: string;
}

/** `GET /v1/sandboxes/{id}/diff?base=&path=&patch=1&cwd=`. 409 `not_a_repository`/`no_commits`, 400 `bad_ref`. */
export interface FleetDiffResult {
  base: string;
  baseSha?: string;
  mergeBase: string;
  headSha: string;
  files: Array<{
    path: string;
    oldPath?: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    added: number;
    removed: number;
    binary: boolean;
  }>;
  truncated?: boolean;
  patch?: string;
  patchTruncated?: boolean;
}

/** `GET /v1/sandboxes/{id}/files?cwd=`. */
export interface FleetFilesResult {
  paths: string[];
  truncated?: boolean;
}

/** `GET /v1/sandboxes/{id}/file?path=&cwd=`. */
export interface FleetFileResult {
  path: string;
  size: number;
  binary: boolean;
  encoding: 'utf8' | 'base64';
  content: string;
  tooLarge?: boolean;
}

/** Frame types of the `/pty` stream: `[type:1][len:uint32 BE][payload]`. */
export const PTY_FRAME = { DATA: 0x00, RESIZE: 0x01, EXIT: 0x02 } as const;

/** The guest refuses a pty frame above this. */
export const PTY_MAX_FRAME_PAYLOAD = 1 << 20;

/** An older guest answers `/pty` with 409 `pty_unsupported`; the caller falls back to ssh. */
export class FleetPtyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetPtyUnsupportedError';
  }
}

/**
 * Which optional routes a fleet endpoint serves, learned once per process.
 *
 * Keyed by endpoint AND feature: the gateway and a host directly can differ,
 * and a host mid-rollout answers for itself. `undefined` means not yet asked.
 */
const optionalSupport = new Map<string, boolean>();

/** Exposed for tests, which point several fake fleets at one process. */
export function resetFleetOptionalSupport(): void {
  optionalSupport.clear();
}

/** How long a wait-mode exec may take when the command itself is unbounded. */
const DEFAULT_EXEC_WAIT_MS = 15 * 60_000;

/** RFC 6455's fixed GUID for the accept digest. */
const WS_ACCEPT_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FleetOptionalResult<T> {
  supported: boolean;
  data?: T;
}

const sandboxPath = (id: string, rest = ''): string => `/v1/sandboxes/${encodeURIComponent(id)}${rest}`;

function execWaitMs(req: FleetExecRequest): number {
  return req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs + 30_000 : DEFAULT_EXEC_WAIT_MS;
}

async function errorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

/** The fleet's error text and its machine code (`error` in its JSON body), when it sent one. */
async function errorBody(resp: Response, fallback: string): Promise<{ message: string; code?: string }> {
  try {
    const body = (await resp.json()) as { message?: string; error?: string };
    return { message: body.message || body.error || fallback, ...(body.error ? { code: body.error } : {}) };
  } catch {
    return { message: fallback };
  }
}

function parseRetryAfterMs(resp: Response): number | undefined {
  const header = resp.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
