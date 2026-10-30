import { eq, sql } from 'drizzle-orm';
import {
  applyWorkbenchScriptOverrides,
  detectWorkbenchScripts,
  detectedScriptsToToml,
  resolveWorkbenchConfig,
  shellQuote,
  toShellScript,
  workbenchEnv,
  type FleetAgent,
  type GitStep,
  type WorkbenchConfig,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  users as usersTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { githubService } from '../github.js';
import { getFleetHost } from '../fleetHosts.js';
import {
  FleetCapacityError,
  FleetClient,
  FleetHttpError,
  FleetRunNotFoundError,
  type FleetExecFrame,
  type FleetExecRequest,
} from '../selfHosted/client.js';
import {
  fleetApiToken,
  FleetNotDeployedError,
  fleetPinnedEndpoint,
  getSelfHostedClient,
  getSelfHostedCredentials,
  resolveFleetTarget,
} from '../selfHosted/credentials.js';
import { resolveSandboxCredentials } from '../selfHosted/sandboxRun.js';
import { resolveRunCredential } from '../selfHosted/accountSelection.js';
import {
  describeAccountSwitch,
  findHotSwap,
  HOT_SWAP_CHECK_INTERVAL_MS,
  recordHotSwap,
} from '../selfHosted/hotSwap.js';
import { workbenchIntegrationSecrets } from './talynMcp.js';
import {
  aliveMarkerScript,
  frameCommand,
  FrameDemux,
  killMarkerScript,
  parseSections,
  sectionsScript,
} from './execFraming.js';
import {
  GUEST_RETRY_DELAYS_MS,
  isDiskFullError,
  isDiskFullText,
  isGuestUnreachableBeforeStart,
} from './execFailures.js';
import { WorkbenchError } from './errors.js';
import { recoverLostSandbox, withLostRecovery } from './recovery.js';
import type { WorkbenchRow } from './store.js';

/**
 * The sandbox runtime's plumbing: which fleet client, which sandbox, which
 * directory, and how to run a command in it and read back only its own output.
 *
 * Everything that executes goes through `frameCommand` (see execFraming.ts):
 * the fleet's events ring is per sandbox, so without framing a diff run during
 * a turn would read the turn's output as its own.
 */

/** The repository is cloned under here, one directory per repository. */
export const SANDBOX_WORK_ROOT = '/work';

/**
 * TALYN_PORT in a sandbox. Fixed rather than allocated: each workbench has a
 * microVM of its own, so there is nothing to collide with — allocating ports
 * is a local-runtime problem, where worktrees share a machine.
 */
export const SANDBOX_PORT_BASE = 3000;

/**
 * The fleet sandbox id for a workbench. Deterministic, because the fleet's
 * create is idempotent on the id: a provision that lost its answer re-sends
 * the same id and gets the same box. A restore after archive needs a NEW box —
 * the old id answers from its tombstone — so it moves to the next generation.
 */
export function sandboxIdFor(workbenchId: string, generation = 0): string {
  // The fleet refuses box names over 40 characters, and a full uuid makes 45
  // before the generation suffix. 24 hex digits (96 bits) of the uuid keep
  // ids unique; credential pulls look the box up by this stored id, never by
  // parsing it.
  const short = workbenchId.replace(/-/g, '').slice(0, 24);
  const id = generation > 0 ? `talyn-wb-${short}-r${generation}` : `talyn-wb-${short}`;
  if (id.length > FLEET_SANDBOX_ID_MAX) {
    throw new Error(`sandbox id ${id} is longer than the fleet's ${FLEET_SANDBOX_ID_MAX}-character limit`);
  }
  return id;
}

/** The fleet's limit on a box name. */
export const FLEET_SANDBOX_ID_MAX = 40;

/** The generation an existing sandbox id is on, so a restore can take the next. */
export function sandboxGeneration(sandboxId: string | null): number {
  if (!sandboxId) return -1;
  const match = /-r(\d+)$/.exec(sandboxId);
  return match ? Number(match[1]) : 0;
}

/**
 * The id of the workbench's next box. Above both the current box and the last
 * box a move tried (`settings.moveSandboxId`): a deleted id answers from its
 * tombstone, so a generation a failed move used is never reused.
 */
export function nextSandboxId(row: Pick<WorkbenchRow, 'id' | 'sandboxId' | 'settings'>): string {
  const moved = (row.settings as Record<string, unknown> | null | undefined)?.moveSandboxId;
  const highest = Math.max(sandboxGeneration(row.sandboxId), typeof moved === 'string' ? sandboxGeneration(moved) : -1);
  return sandboxIdFor(row.id, highest + 1);
}

/** `owner/name` → the clone directory, `/work/name`. */
export function repoDirFor(row: Pick<WorkbenchRow, 'repoFullName'>): string {
  const name = row.repoFullName.split('/').pop() || 'repo';
  return `${SANDBOX_WORK_ROOT}/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function providerForAgent(agent: string): 'anthropic' | 'openai' {
  return agent === 'codex' ? 'openai' : 'anthropic';
}

/** The variables every script and turn in this workbench gets. */
export function sandboxScriptEnv(row: WorkbenchRow): Record<string, string> {
  const dir = repoDirFor(row);
  return {
    ...workbenchEnv({
      workbenchPath: dir,
      rootPath: dir,
      name: row.name,
      port: SANDBOX_PORT_BASE,
      defaultBranch: row.baseBranch,
    }),
    // The id Talyn's MCP tools take. The skill pack tells the agent to read it
    // here rather than search `talyn_list_sessions` for its own branch.
    TALYN_SESSION_ID: row.id,
  };
}

// ============================================================================
// The fleet client
// ============================================================================

/**
 * A client per workspace, cached briefly. Resolving one reads the workspace's
 * credential row (and may refresh an OAuth token); a diff panel polling every
 * few seconds must not do that per request. A minute is short enough that a
 * reconnected subscription or a moved gateway is picked up promptly.
 */
const CLIENT_TTL_MS = 60_000;
const clientCache = new Map<string, { client: FleetClient; expiresAt: number }>();

/** Tests swap the client; production never calls this. */
let clientOverride: ((workspaceId: string) => Promise<FleetClient | null>) | null = null;
export function setWorkbenchFleetClientForTests(fn: ((workspaceId: string) => Promise<FleetClient | null>) | null): void {
  clientOverride = fn;
  clientCache.clear();
}

/**
 * The client for a workbench's fleet. Pass the row's `fleetHost` when there is
 * one: without a gateway, an existing box lives on the host that created it,
 * and the registry's least-loaded pick is usually a different machine.
 */
export async function fleetClientFor(workspaceId: string, fleetHost?: string | null): Promise<FleetClient> {
  if (clientOverride) {
    const client = await clientOverride(workspaceId);
    if (!client) throw new WorkbenchError('Talyn Fleet is not configured for this workspace.', 409, 'fleet_unconfigured');
    return withWake(client);
  }
  const pinnedHost = fleetHost && !fleetPinnedEndpoint() ? fleetHost : null;
  const key = pinnedHost ? `${workspaceId}@${pinnedHost}` : workspaceId;
  const hit = clientCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.client;
  const client = pinnedHost ? await hostClientFor(workspaceId, pinnedHost) : await getSelfHostedClient(workspaceId);
  if (!client) {
    throw new WorkbenchError('Talyn Fleet is not configured for this workspace.', 409, 'fleet_unconfigured');
  }
  const waking = withWake(client);
  clientCache.set(key, { client: waking, expiresAt: Date.now() + CLIENT_TTL_MS });
  return waking;
}

// ============================================================================
// Waking a hibernated sandbox
// ============================================================================

/**
 * The fleet's answer for a box whose only copy is in object storage. A plain
 * suspend wakes on the next exec; a hibernated box does not, because pulling
 * the image back takes minutes, and only POST /resume may wait that long.
 */
export function isRemoteResumeRequired(err: unknown): boolean {
  return err instanceof FleetHttpError && err.code === 'remote_resume_required';
}

/** Resumes in flight, per sandbox, so a burst of calls waits on one resume. */
const resuming = new Map<string, Promise<void>>();

function resumeOnce(client: FleetClient, sandboxId: string): Promise<void> {
  let pending = resuming.get(sandboxId);
  if (!pending) {
    console.log(`[workbench] resuming hibernated sandbox ${sandboxId}`);
    pending = client.resumeSandbox(sandboxId).finally(() => resuming.delete(sandboxId));
    resuming.set(sandboxId, pending);
  }
  return pending;
}

/** Calls that manage the box itself, and must never resume it as a side effect. */
const NO_WAKE = new Set<PropertyKey>(['createSandbox', 'getSandbox', 'resumeSandbox', 'suspendSandbox', 'deleteSandbox']);

/**
 * The client, but a call refused with `remote_resume_required` resumes the box
 * and is sent once more. Every sandbox call takes the sandbox id first, and
 * only a sandbox route answers with that code, so `args[0]` is the box to wake.
 * Methods run on the real client, so its own internal calls skip this layer.
 */
function withWake(client: FleetClient): FleetClient {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (NO_WAKE.has(prop)) return method.bind(target);
      if (prop === 'execFollow') {
        return (...args: Parameters<FleetClient['execFollow']>) => followWithWake(target, args);
      }
      return (...args: unknown[]) => {
        const sandboxId = args[0];
        const once = (): unknown => {
          const result = method.apply(target, args);
          if (!(result instanceof Promise) || typeof sandboxId !== 'string') return result;
          return result.catch(async (err: unknown) => {
            if (!isRemoteResumeRequired(err)) throw err;
            await resumeOnce(target, sandboxId);
            return method.apply(target, args);
          });
        };
        return RETRY_UNSTARTED.has(prop) ? retryUnstarted(once as () => Promise<unknown>) : once();
      };
    },
  });
}

/** Exec calls retried when the fleet could not reach the guest before the command started. */
const RETRY_UNSTARTED = new Set<PropertyKey>(['exec', 'quietExec']);

let guestRetryDelays: readonly number[] = GUEST_RETRY_DELAYS_MS;

/** Tests shorten the waits. */
export function setGuestRetryDelaysForTests(delays: readonly number[] | null): void {
  guestRetryDelays = delays ?? GUEST_RETRY_DELAYS_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send an exec again when the error proves the guest never started it: safe
 * for any command, idempotent or not. Up to three more tries, then the error.
 */
async function retryUnstarted<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const delay = guestRetryDelays[attempt];
      if (delay === undefined || !isGuestUnreachableBeforeStart(err)) throw err;
      console.warn(`[workbench] the guest was not reached; exec retry ${attempt + 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * The fleet refuses a follow before its first frame, so a retry repeats
 * nothing: a hibernated box is resumed once, and a guest that was not reached
 * is tried again as `retryUnstarted` does. Never after a frame has arrived.
 */
async function* followWithWake(
  client: FleetClient,
  args: Parameters<FleetClient['execFollow']>,
): AsyncGenerator<FleetExecFrame> {
  let resumed = false;
  let unreached = 0;
  for (;;) {
    let started = false;
    try {
      for await (const frame of client.execFollow(...args)) {
        started = true;
        yield frame;
      }
      return;
    } catch (err) {
      if (started) throw err;
      if (isRemoteResumeRequired(err) && !resumed) {
        resumed = true;
        await resumeOnce(client, args[0]);
        continue;
      }
      const delay = guestRetryDelays[unreached];
      if (delay === undefined || args[2].aborted || !isGuestUnreachableBeforeStart(err)) throw err;
      unreached++;
      console.warn(`[workbench] the guest was not reached; follow retry ${unreached} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/** A client for one named host. Null when the workspace has no fleet credential. */
async function hostClientFor(workspaceId: string, hostName: string): Promise<FleetClient | null> {
  if (!(await getSelfHostedCredentials(workspaceId))) return null;
  const token = fleetApiToken();
  if (!token) throw new FleetNotDeployedError();
  const host = await getFleetHost(hostName);
  if (!host?.apiEndpoint) {
    throw new FleetCapacityError(`fleet host ${hostName} is not registered or has no endpoint`, undefined, 'unreachable');
  }
  return new FleetClient(host.apiEndpoint, token);
}

/**
 * Where a NEW sandbox goes, and which host the registry chose when it chose
 * one. Through the gateway the host comes back on the create's answer instead.
 */
export async function fleetCreateTarget(workspaceId: string): Promise<{ client: FleetClient; host?: string }> {
  if (clientOverride) return { client: await fleetClientFor(workspaceId) };
  const target = await resolveFleetTarget(workspaceId);
  if (!target) {
    throw new WorkbenchError('Talyn Fleet is not configured for this workspace.', 409, 'fleet_unconfigured');
  }
  return { client: new FleetClient(target.endpoint, target.token), ...(target.host ? { host: target.host } : {}) };
}

function requireSandbox(row: WorkbenchRow): string {
  if (row.runtime !== 'sandbox') {
    throw new WorkbenchError('This session runs on your machine.', 409, 'local_runtime');
  }
  if (!row.sandboxId) throw new WorkbenchError('This session has no sandbox yet.', 409, 'not_ready');
  return row.sandboxId;
}

// ============================================================================
// Running commands
// ============================================================================

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Bounds the command in the guest. Absent is no bound. */
  timeoutMs?: number;
  /** A process-group marker, so the command can be stopped by name. */
  marker?: string;
  /**
   * Try the fleet's quiet exec (output kept out of the events ring). For
   * reads — a diff, a file — that happen often and must not crowd the ring.
   */
  quiet?: boolean;
  /** Follow large captures so the event ring cannot discard their first frames. */
  follow?: boolean;
  /**
   * Opt in for an IDEMPOTENT script only: on a full-disk failure, grow the
   * disk and run once more on the same box. When the fleet cannot grow it, a
   * move starts in the background and this call is not run again: a retry on
   * a different box would repeat it against other state.
   */
  diskRecovery?: boolean;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The raw stdout bytes — for file contents that may not be UTF-8. */
  stdoutBytes: Buffer;
  /** The fleet cut a quiet answer at its cap, so stdout is incomplete. */
  truncated?: boolean;
}

/** How many events one page of a wait-mode exec returns (the fleet's own cap). */
const EVENTS_PAGE = 1000;

/**
 * Run `script` to its end and return its output, framed so another command
 * running at the same time cannot leak into it.
 *
 * With `diskRecovery`, a failure that says the disk is full grows the disk
 * and runs once more on the same box (see move.ts).
 */
export async function runCapture(
  row: WorkbenchRow,
  script: string,
  opts: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  let result: SandboxExecResult;
  try {
    result = await runCaptureOnce(row, script, opts);
  } catch (err) {
    if (opts.diskRecovery !== true || !isDiskFullError(err)) throw err;
    if (!(await grownAfterDiskFull(row))) throw err;
    return runCaptureOnce(row, script, opts);
  }
  if (result.exitCode !== 0 && opts.diskRecovery === true && isDiskFullText(result.stderr)) {
    if (await grownAfterDiskFull(row)) return runCaptureOnce(row, script, opts);
  }
  return result;
}

/** True when the same box now has room. Otherwise a move may have started; it does not concern this call. */
async function grownAfterDiskFull(row: WorkbenchRow): Promise<boolean> {
  const { growForDiskFull } = await import('./move.js');
  return growForDiskFull(row).catch((err) => {
    console.warn(`[workbench] making room on ${row.id} failed:`, err);
    return false;
  });
}

async function runCaptureOnce(
  row: WorkbenchRow,
  script: string,
  opts: SandboxExecOptions,
): Promise<SandboxExecResult> {
  return withLostRecovery(row, async () => {
    const sandboxId = requireSandbox(row);
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    const framed = frameCommand(script, { mode: 'capture', marker: opts.marker, env: opts.env });
    const req: FleetExecRequest = {
      cmd: framed.cmd,
      env: framed.env,
      cwd: opts.cwd ?? repoDirFor(row),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const demux = new FrameDemux(framed.nonce);
    if (opts.follow) {
      for await (const frame of client.execFollow(sandboxId, req, AbortSignal.timeout((opts.timeoutMs ?? 60_000) + 5_000))) {
        demux.pushEvents(frame.events);
        if (frame.terminal) break;
      }
      if (!demux.done) throw new Error('The sandbox capture is incomplete.');
      return resultOf(demux, null);
    }
    let frame: FleetExecFrame;
    if (opts.quiet) {
      const outcome = await client.quietExec(sandboxId, req);
      if (outcome.kind === 'quiet') {
        demux.pushText(outcome.result.stdout);
        demux.pushText(outcome.result.stderr);
        const result = resultOf(demux, outcome.result.exitCode);
        // The wrapper's own failure is not framed. A full disk is worth reading from it.
        if (!demux.done && isDiskFullText(outcome.result.stderr)) result.stderr = outcome.result.stderr.slice(-2000);
        return outcome.result.truncated ? { ...result, truncated: true } : result;
      }
      frame = outcome.frame;
    } else {
      frame = await client.exec(sandboxId, req);
    }
    demux.pushEvents(frame.events);
    // A wait-mode answer is capped at one page. Our trailer is the last thing we
    // print, so until it is in hand there is more to read.
    let cursor = frame.cursor;
    let events = frame.events.length;
    while (!demux.done && events >= EVENTS_PAGE) {
      const page = await client.getEvents(sandboxId, cursor, EVENTS_PAGE);
      if (page.events.length === 0) break;
      demux.pushEvents(page.events);
      cursor = page.cursor;
      events = page.events.length;
    }
    return resultOf(demux, lastExitCode(frame));
  });
}

function resultOf(demux: FrameDemux, fallbackExit: number | null): SandboxExecResult {
  const r = demux.result();
  return {
    exitCode: r.exitCode ?? fallbackExit ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    stdoutBytes: demux.stdoutBytes(),
  };
}

/**
 * The exit code the fleet reported, used only when our own trailer is missing
 * (the wrapper was killed). Ambiguous when several commands ended in the same
 * window, which is why it is the fallback and not the answer.
 */
function lastExitCode(frame: FleetExecFrame): number | null {
  for (let i = frame.events.length - 1; i >= 0; i--) {
    const e = frame.events[i].event as { type?: string; raw?: { exitCode?: unknown } };
    if (e?.type === 'exec_exit' && typeof e.raw?.exitCode === 'number') return e.raw.exitCode;
  }
  return null;
}

/** Run git steps (see `workbenchGit.ts`) as one script in the repository. */
export async function runGitSteps(
  row: WorkbenchRow,
  steps: GitStep[],
  opts: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  return runCapture(row, toShellScript(steps), opts);
}

export interface StreamOutcome {
  /** From our own trailer; null when the process died without printing one. */
  exitCode: number | null;
  /** The last stderr lines, for an error message. */
  stderrTail: string;
}

/** How often a lost stream is replaced by polling, and how often liveness is checked. */
const RECOVERY_POLL_MS = 2_000;
const RECOVERY_ALIVE_CHECK_MS = 30_000;

/**
 * Run `script` and hand each stdout line to `onStdoutLine` as it arrives.
 *
 * The exec is followed over SSE. If that stream breaks before the command
 * ends — a gateway restart, a dropped connection — the command keeps running
 * in the sandbox, so this falls back to polling the events ring from the last
 * cursor until our trailer appears, checking every half minute that the
 * process is still alive so a process that died silently cannot hang it.
 */
export async function runStream(
  row: WorkbenchRow,
  script: string,
  opts: SandboxExecOptions & {
    marker: string;
    onStdoutLine: (line: string) => void;
    onStderrLine?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<StreamOutcome> {
  const sandboxId = requireSandbox(row);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const framed = frameCommand(script, { mode: 'stream', marker: opts.marker, env: opts.env });
  const demux = new FrameDemux(framed.nonce, opts.onStdoutLine, opts.onStderrLine);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  if (opts.signal?.aborted) controller.abort();
  let cursor = 0;
  let terminal = false;
  try {
    for await (const frame of client.execFollow(
      sandboxId,
      {
        cmd: framed.cmd,
        env: framed.env,
        cwd: opts.cwd ?? repoDirFor(row),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
      controller.signal,
    )) {
      cursor = frame.cursor;
      demux.pushEvents(frame.events);
      if (frame.terminal) {
        terminal = true;
        break;
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return outcomeOf(demux);
    if (err instanceof FleetRunNotFoundError) {
      await recoverLostSandbox(row, err).catch(() => undefined);
      throw err;
    }
    // Before the first frame nothing is known to have started; that is a
    // failure to run, not a stream to recover.
    if (cursor === 0) throw err;
    console.warn(`[workbench] exec stream for ${opts.marker} broke; polling instead:`, err);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (!terminal && !opts.signal?.aborted && !demux.done) {
    await recoverStream(row, client, sandboxId, cursor, demux, opts.marker, opts.signal);
  }
  return outcomeOf(demux);
}

function outcomeOf(demux: FrameDemux): StreamOutcome {
  const r = demux.result();
  return { exitCode: r.exitCode, stderrTail: r.stderr.split('\n').slice(-20).join('\n') };
}

async function recoverStream(
  row: WorkbenchRow,
  client: FleetClient,
  sandboxId: string,
  from: number,
  demux: FrameDemux,
  marker: string,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = from;
  let lastAliveCheck = Date.now();
  let deadSeen = false;
  while (!demux.done && !signal?.aborted) {
    const page = await client.getEvents(sandboxId, cursor, EVENTS_PAGE).catch(async (err: unknown) => {
      if (err instanceof FleetRunNotFoundError) {
        await recoverLostSandbox(row, err).catch(() => undefined);
        throw err;
      }
      return null;
    });
    if (page && page.events.length > 0) {
      demux.pushEvents(page.events);
      cursor = page.cursor;
      continue;
    }
    if (deadSeen) return;
    if (Date.now() - lastAliveCheck >= RECOVERY_ALIVE_CHECK_MS) {
      lastAliveCheck = Date.now();
      // Dead once, then one more read: the process may have exited between
      // our last page and the check, with its trailer not yet read.
      if (!(await isMarkerAlive(row, marker).catch(() => true))) deadSeen = true;
    }
    await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS));
  }
}

/** Stop everything a marker names: INT, then TERM, then KILL to its process group. */
export async function killMarker(row: WorkbenchRow, marker: string): Promise<void> {
  const { script, env } = killMarkerScript(marker);
  await runCapture(row, script, { cwd: '/', env, timeoutMs: 20_000, quiet: true });
}

export async function isMarkerAlive(row: WorkbenchRow, marker: string): Promise<boolean> {
  const { script, env } = aliveMarkerScript(marker);
  const r = await runCapture(row, script, { cwd: '/', env, timeoutMs: 10_000, quiet: true });
  return r.exitCode === 0;
}

// ============================================================================
// Clone, config, credentials
// ============================================================================

/** Where a golden-booted box already has the repository checked out. */
export const GOLDEN_REPO_DIR = `${SANDBOX_WORK_ROOT}/repo`;

/** `git fetch --deepen` steps tried for a merge base in a shallow clone before `--unshallow`. */
export const MERGE_BASE_DEEPEN_TRIES = 4;
export const MERGE_BASE_DEEPEN_BY = 500;

/**
 * Clone the repository (once) and put the workbench's branch in place.
 *
 * Three cases, in this order, so the same script serves a fresh workbench, a
 * re-provision of a box that already has the clone, and a restore onto a new
 * box:
 *   1. the branch exists LOCALLY — check it out, keeping any unpushed work;
 *   2. it exists on origin (pushed before, or a PR's head) — track it;
 *   3. neither — create it from `origin/<base>`.
 *
 * A box booted from the repository's golden already holds a shallow,
 * single-branch checkout at `/work/repo` with dependencies installed. That is
 * LINKED into place rather than moved, because installs and venv shebangs
 * hold its absolute path. Only when its origin is this repository: anything
 * else clones as before.
 *
 * The fetch names its two branches explicitly, so a shallow golden never pulls
 * the whole repository's pack. A shallow clone then deepens in steps until
 * `origin/<base>` and HEAD share a merge base, which the diff needs.
 *
 * `git` reaches GitHub through the guest's proxy rewrite, which attaches the
 * credential host-side; the token never enters the box. The fallback clone is
 * blobless, so a large repository is usable in seconds and blobs arrive as read.
 */
export function cloneScript(row: Pick<WorkbenchRow, 'repoFullName' | 'branch' | 'baseBranch'>): string {
  const dir = shellQuote(repoDirFor(row));
  const golden = shellQuote(GOLDEN_REPO_DIR);
  const url = shellQuote(`https://github.com/${row.repoFullName}.git`);
  const slug = shellQuote(row.repoFullName.toLowerCase());
  const branch = shellQuote(row.branch);
  const remoteBranch = shellQuote(`origin/${row.branch}`);
  const remoteBase = shellQuote(`origin/${row.baseBranch}`);
  const localRef = shellQuote(`refs/heads/${row.branch}`);
  const baseSpec = shellQuote(`+refs/heads/${row.baseBranch}:refs/remotes/origin/${row.baseBranch}`);
  const branchSpec = shellQuote(`+refs/heads/${row.branch}:refs/remotes/origin/${row.branch}`);
  return [
    'set -e',
    `mkdir -p ${SANDBOX_WORK_ROOT}`,
    `if [ ! -d ${dir}/.git ]; then`,
    `  origin_url=$(git -C ${golden} remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)`,
    '  golden_match=',
    '  case "$origin_url" in',
    `    */${slug}|*/${slug}.git|*:${slug}|*:${slug}.git) golden_match=1 ;;`,
    '  esac',
    `  if [ -n "$golden_match" ] && [ -d ${golden}/.git ] && [ ! -e ${dir} ]; then`,
    `    ln -s ${golden} ${dir}`,
    '  else',
    `    git clone --filter=blob:none ${url} ${dir}`,
    '  fi',
    'fi',
    `cd ${dir}`,
    // A single-branch clone only tracks what its fetch refspecs name, and
    // `--track` refuses a remote branch no refspec covers. Add exactly these
    // two, never the wildcard, so a later plain `git fetch` stays this small.
    'ensure_refspec() {',
    `  git config --get-all remote.origin.fetch | grep -qxF -e ${shellQuote('+refs/heads/*:refs/remotes/origin/*')} -e "$1" ||`,
    '    git config --add remote.origin.fetch "$1"',
    '}',
    `ensure_refspec ${baseSpec}`,
    `set -- ${baseSpec}`,
    'remote_branch=',
    `if git ls-remote --exit-code --heads origin ${branch} >/dev/null 2>&1; then`,
    '  remote_branch=1',
    `  ensure_refspec ${branchSpec}`,
    `  set -- "$@" ${branchSpec}`,
    'fi',
    'shallow=',
    'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then shallow=1; fi',
    `if [ -n "$shallow" ]; then git fetch --depth=200 origin "$@"; else git fetch origin "$@"; fi`,
    `if git show-ref --verify --quiet ${localRef}; then`,
    `  git checkout ${branch}`,
    'elif [ -n "$remote_branch" ]; then',
    `  git checkout -b ${branch} --track ${remoteBranch}`,
    'else',
    `  git checkout --no-track -b ${branch} ${remoteBase}`,
    'fi',
    // The diff is against the merge base, and a shallow history may not reach
    // it. Deepen in bounded steps, then unshallow as the last resort.
    // A history that became complete stops the loop: no merge base there means
    // unrelated histories, and `--unshallow` on a complete repo is an error.
    'tries=0',
    `while [ "$(git rev-parse --is-shallow-repository)" = true ] && ! git merge-base HEAD ${remoteBase} >/dev/null 2>&1; do`,
    `  if [ "$tries" -ge ${MERGE_BASE_DEEPEN_TRIES} ]; then git fetch --unshallow origin "$@"; break; fi`,
    `  git fetch --deepen=${MERGE_BASE_DEEPEN_BY} origin "$@"`,
    '  tries=$((tries + 1))',
    'done',
    'git rev-parse HEAD',
  ].join('\n');
}

/**
 * The repository's workbench config, read in one exec: the three files the
 * shared resolver understands, first found wins, then the workbench's own
 * overrides on top.
 */
export async function loadWorkbenchConfig(row: WorkbenchRow): Promise<WorkbenchConfig> {
  const r = await runCapture(
    row,
    sectionsScript([
      { label: 'TALYN', command: 'cat .talyn/settings.toml' },
      { label: 'CJSON', command: 'cat conductor.json' },
      { label: 'CTOML', command: 'cat .conductor/settings.toml' },
    ]),
    // Reads only, so it may run again after a grow.
    { quiet: true, timeoutMs: 30_000, diskRecovery: true },
  );
  const files = parseSections(r.stdout);
  const config = resolveWorkbenchConfig({
    talynToml: files.TALYN || null,
    conductorJson: files.CJSON || null,
    conductorToml: files.CTOML || null,
  });
  return applyWorkbenchScriptOverrides(config, row.settings);
}

const configAbsentScript = [
  'for file in .talyn/settings.toml conductor.json .conductor/settings.toml; do',
  '  if [ -e "$file" ] || [ -L "$file" ]; then exit 3; fi',
  'done',
].join('\n');

function checkConfigResult(result: SandboxExecResult): void {
  if (result.exitCode === 3) {
    throw new WorkbenchError(
      'A repository config file already exists. Edit that file to change its scripts.',
      409,
      'config_exists',
    );
  }
  if (result.exitCode !== 0) {
    throw new WorkbenchError('Could not read or save the repository config.', 500, 'config_failed');
  }
}

async function detectScripts(row: WorkbenchRow, requireAbsent = false) {
  const result = await runCapture(
    row,
    `${requireAbsent ? `${configAbsentScript}\n` : ''}${sectionsScript([
      { label: 'FILES', command: 'ls -A' },
      { label: 'PACKAGE', command: 'cat package.json' },
    ])}`,
    { quiet: true, timeoutMs: 30_000 },
  );
  checkConfigResult(result);
  const sections = parseSections(result.stdout);
  return detectWorkbenchScripts({
    files: (sections.FILES ?? '').split('\n'),
    packageJson: sections.PACKAGE || null,
  });
}

export async function loadWorkbenchConfigWithDetection(row: WorkbenchRow): Promise<WorkbenchConfig> {
  const config = await loadWorkbenchConfig(row);
  if (config.source === 'none') config.detected = await detectScripts(row);
  return config;
}

export async function saveDetectedConfig(row: WorkbenchRow): Promise<void> {
  const detected = await detectScripts(row, true);
  if (!detected.setup && !detected.run) {
    throw new WorkbenchError('No setup or run command was detected.', 409, 'no_detected_scripts');
  }
  const content = Buffer.from(detectedScriptsToToml(detected)).toString('base64');
  const result = await runCapture(
    row,
    [
      configAbsentScript,
      'mkdir -p .talyn || exit 4',
      ` (set -C; printf '%s' '${content}' | base64 -d > .talyn/settings.toml) || exit 4`,
    ].join('\n'),
    { quiet: true, timeoutMs: 30_000 },
  );
  checkConfigResult(result);
}

/**
 * Who a workbench's commits are by: the workspace owner's GitHub identity, as
 * GitHub's no-reply address, so a commit links to the account without
 * publishing an email. Undefined when the owner has no GitHub identity on
 * record — the guest's default author is then used.
 */
export async function gitAuthorFor(workspaceId: string): Promise<{ name: string; email: string } | undefined> {
  const rows = await getPoolDbClient()
    .select({ login: usersTable.githubUsername, githubId: usersTable.githubUserId })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const r = rows[0];
  if (!r?.login || !r.githubId) return undefined;
  return { name: r.login, email: `${r.githubId}+${r.login}@users.noreply.github.com` };
}

// ============================================================================
// Which fleet account a session is on
// ============================================================================

/**
 * The fleet account a session's box is on now, kept as `settings.fleetAccountId`
 * on the workbench row: no migration, and the row is what every credential path
 * already reads. A settings PATCH that drops the key costs nothing but a fresh
 * choice at the next turn.
 */
export function workbenchFleetAccountId(row: Pick<WorkbenchRow, 'settings'>): string | undefined {
  const value = (row.settings as Record<string, unknown> | null | undefined)?.fleetAccountId;
  return typeof value === 'string' && value ? value : undefined;
}

/** Write only that key, so a settings edit made at the same moment is kept. */
export async function setWorkbenchFleetAccount(
  row: Pick<WorkbenchRow, 'id' | 'settings'>,
  accountId: string,
): Promise<void> {
  await getPoolDbClient()
    .update(workbenchesTable)
    .set({
      settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || jsonb_build_object('fleetAccountId', ${accountId}::text)`,
    })
    .where(eq(workbenchesTable.id, row.id));
  // The caller's copy too: a turn keeps using its row while it runs.
  row.settings = { ...(row.settings ?? {}), fleetAccountId: accountId } as WorkbenchRow['settings'];
}

function agentOf(row: Pick<WorkbenchRow, 'agent'>): FleetAgent {
  return providerForAgent(row.agent) === 'openai' ? 'codex' : 'claude';
}

/**
 * Hand the sandbox fresh credentials before a turn.
 *
 * A workbench's box lives for days, and the credentials it was created with do
 * not: a Claude OAuth token lasts hours and a GitHub App token one. Pushing
 * fresh ones per turn is what keeps an idle-then-resumed box working. Same
 * rules as every dispatch: the key for THIS box's vendor and only that one,
 * and no credential is a refusal, never a blank — the gateway would fill a
 * blank from somebody else's custody. MCP secrets ride along because the push
 * REPLACES the set.
 *
 * The key is from the session's current ACCOUNT while it is under the
 * workspace's threshold, else from the next account of the same agent. Returns
 * the account used, and the note to show when that is a switch.
 */
export async function refreshSandboxCredentials(
  row: WorkbenchRow,
  opts: { model?: string; avoidAccountIds?: readonly string[] } = {},
): Promise<{ accountId: string | null; note: string | null }> {
  const sandboxId = requireSandbox(row);
  const resolved = await resolveSandboxCredentials(row.workspaceId);
  if (!resolved.ok) throw new WorkbenchError(resolved.error, 409, 'credentials_unavailable');
  const provider = providerForAgent(row.agent);
  const agent = agentOf(row);
  const model = opts.model ?? row.model ?? undefined;
  const recorded = workbenchFleetAccountId(row);
  const credential = await resolveRunCredential(row.workspaceId, agent, {
    recordedAccountId: recorded,
    model,
    switchWhenOver: true,
    avoidAccountIds: opts.avoidAccountIds,
  });
  const key = credential?.token;
  if (!key) {
    const label = provider === 'openai' ? 'Codex (ChatGPT)' : 'Claude';
    throw new WorkbenchError(
      `This session runs ${label}, and the workspace has no ${label} subscription connected. Connect it in Settings → Talyn Fleet.`,
      409,
      'credentials_unavailable',
    );
  }
  const integrations = await workbenchIntegrationSecrets(row);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  await withLostRecovery(row, () => client.setSandboxCredentials(sandboxId, {
    githubToken: resolved.githubToken,
    ...(provider === 'openai' ? { openaiKey: key } : { anthropicKey: key }),
    repo: row.repoFullName,
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
  }));

  let note: string | null = null;
  if (credential.accountId && credential.accountId !== recorded) {
    await setWorkbenchFleetAccount(row, credential.accountId).catch((err) =>
      console.warn(`[workbench] recording the fleet account for ${row.id} failed:`, err),
    );
    if (recorded) {
      note = await describeAccountSwitch(row.workspaceId, recorded, credential.accountId, model).catch(
        () => null,
      );
      if (note) {
        recordWorkbenchEvent(row, 'account_switch', note);
      }
    }
  }
  return { accountId: credential.accountId ?? null, note };
}

/**
 * Move a session's box to the next account of the same agent when its account
 * has crossed the threshold mid-turn. The push carries the whole set, as the
 * per-turn refresh does. Returns the note to show, or null when nothing moved.
 */
export async function checkSandboxHotSwap(row: WorkbenchRow, model?: string): Promise<string | null> {
  if (row.runtime !== 'sandbox' || !row.sandboxId) return null;
  const agent = agentOf(row);
  const decision = await findHotSwap({
    key: `wb:${row.id}`,
    workspaceId: row.workspaceId,
    agent,
    model: model ?? row.model ?? undefined,
    currentAccountId: workbenchFleetAccountId(row),
  });
  if (!decision) return null;
  const githubToken = await githubService.getVerifiedAccessToken(row.workspaceId);
  if (!githubToken) return null;
  const integrations = await workbenchIntegrationSecrets(row);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  await withLostRecovery(row, () => client.setSandboxCredentials(row.sandboxId!, {
    githubToken,
    ...(agent === 'codex' ? { openaiKey: decision.token } : { anthropicKey: decision.token }),
    repo: row.repoFullName,
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
  }));
  await setWorkbenchFleetAccount(row, decision.to.id);
  recordHotSwap(row.workspaceId, `workbench ${row.id.slice(0, 8)}`, decision);
  return decision.note;
}

/**
 * Check the session's account once a minute while a turn runs. The check
 * itself is rate limited and reads usage only when it is stale. Returns stop.
 */
export function startAccountWatch(
  row: WorkbenchRow,
  model: string | undefined,
  onSwitch: (note: string) => void,
): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void checkSandboxHotSwap(row, model)
      .then((note) => {
        if (note && !stopped) onSwitch(note);
      })
      .catch((err) =>
        console.warn(
          `[workbench] account check for ${row.id} failed:`,
          err instanceof Error ? err.message : err,
        ),
      )
      .finally(() => {
        running = false;
      });
  }, HOT_SWAP_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** One line on the debug bus for a workbench lifecycle step. */
export function recordWorkbenchEvent(
  row: Pick<WorkbenchRow, 'id' | 'workspaceId'>,
  action: string,
  summary: string,
  ok = true,
  error?: unknown,
): void {
  if (!debugBus.isRecording()) return;
  debugBus.recordEvent({
    service: 'workbenches',
    action,
    summary: `${row.id.slice(0, 8)}: ${summary}`,
    ok,
    workspaceId: row.workspaceId,
    ...(error !== undefined ? { error } : {}),
  });
}
