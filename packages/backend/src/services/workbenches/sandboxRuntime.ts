import { isHeldBack } from '../selfHosted/exhaustedQuota.js';
import { eq, sql } from 'drizzle-orm';
import {
  applyWorkbenchScriptOverrides,
  BOX_LAYER_FILE,
  detectWorkbenchScripts,
  hasPrebakedCheckout,
  parseBoxLayerContext,
  type BoxLayerContext,
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
  type FleetSandboxCredentials,
} from '../selfHosted/client.js';
import {
  fleetApiToken,
  FleetNotDeployedError,
  fleetPinnedEndpoint,
  getSelfHostedClient,
  getSelfHostedCredentials,
  resolveFleetTarget,
} from '../selfHosted/credentials.js';
import { getFleetAccount, listFleetAccounts } from '../selfHosted/accounts.js';
import { resolveRunCredential } from '../selfHosted/accountSelection.js';
import {
  describeAccountSwitch,
  findHotSwap,
  HOT_SWAP_CHECK_INTERVAL_MS,
  recordHotSwap,
} from '../selfHosted/hotSwap.js';
import { payerIntegrationSecrets, workbenchIntegrationSecrets } from './talynMcp.js';
import {
  aliveMarkerScript,
  frameCommand,
  FrameDemux,
  killMarkerScript,
  newNonce,
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
import { assertSandboxAgent } from './credentialPolicy.js';
import { recoverLostSandbox, withLostRecovery } from './recovery.js';
import { meterWorkbenchAwakeBySandboxId } from './usageMeter.js';
import { noteRepoSetupRead, withBoxSetup } from './setupLayers.js';
import { recordSandboxWake } from './boxStart.js';
import {
  currentBoxPayer, getWorkbenchBySandboxId, recordSandboxBootMetric, runningBoxPayer, type TurnPayerRef, type WorkbenchRow,
} from './store.js';

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

/** `owner/name` → the clone directory, `/work/name`. A thread has no clone: `/work`. */
export function repoDirFor(row: Pick<WorkbenchRow, 'repoFullName'> & { kind?: string | null }): string {
  if (row.kind === 'thread' || !row.repoFullName) return SANDBOX_WORK_ROOT;
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

/** Whether Talyn is resuming this box now. */
export function isResuming(sandboxId: string): boolean {
  return resuming.has(sandboxId);
}

/** Where a resume's credentials come from. Null means "send none; the fleet fetches". */
export type ResumeCredentialSource = () => Promise<FleetSandboxCredentials | null>;

/**
 * A resume waits this long for its credentials, then goes without them. The
 * fleet's own fetch took 3.6-4.3 s, so a slower answer here would only make
 * the wake slower than it was.
 */
const RESUME_CREDENTIALS_TIMEOUT_MS = 3_000;
let resumeCredentialsTimeoutMs = RESUME_CREDENTIALS_TIMEOUT_MS;

/** Tests shorten the wait. */
export function setResumeCredentialsTimeoutForTests(ms: number | null): void {
  resumeCredentialsTimeoutMs = ms ?? RESUME_CREDENTIALS_TIMEOUT_MS;
}

/** The default source: the session that owns the box, looked up by its sandbox id. */
async function credentialsForSandbox(sandboxId: string): Promise<FleetSandboxCredentials | null> {
  const row = await getWorkbenchBySandboxId(sandboxId);
  return row ? resumeCredentialsFor(row) : null;
}

/** The source's answer, or null when it fails or is too slow. Never throws. */
async function resumeCredentials(source: ResumeCredentialSource): Promise<FleetSandboxCredentials | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), resumeCredentialsTimeoutMs);
  });
  try {
    return await Promise.race([source().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resume a suspended box once, however many callers wait. `from` says where
 * the box sleeps: `storage` for a hibernated box (the fleet refused an exec
 * with `remote_resume_required`), `host` for a box on its host's disk. The
 * wake and its time go on the session for the Sandbox panel.
 *
 * The resume carries the box's credentials, so the fleet boots with them
 * instead of fetching them first. `credentials` names where they come from;
 * by default the session that owns the box. A fleet that predates the field
 * ignores it and fetches, as before.
 */
export function resumeOnce(
  client: FleetClient,
  sandboxId: string,
  from: 'host' | 'storage' = 'storage',
  credentials: ResumeCredentialSource = () => credentialsForSandbox(sandboxId),
): Promise<void> {
  let pending = resuming.get(sandboxId);
  if (!pending) {
    console.log(`[workbench] resuming ${from === 'storage' ? 'hibernated' : 'suspended'} sandbox ${sandboxId}`);
    const startedAt = Date.now();
    const started = recordSandboxBootMetric(sandboxId, 'wake_start', { at: new Date(startedAt).toISOString(), from })
      .catch((err) => console.warn(`[workbench] recording the wake start of ${sandboxId} failed:`, err));
    const note = async (ok: boolean, ms: number) => {
      await started;
      await recordSandboxWake({ sandboxId, at: new Date(startedAt).toISOString(), ms, from, ok });
    };
    pending = resumeCredentials(credentials)
      .then((creds) => client.resumeSandbox(sandboxId, creds ? { credentials: creds } : {}))
      .then(
        async () => {
          const ms = Date.now() - startedAt;
          console.log(`[workbench] resumed sandbox ${sandboxId} in ${ms} ms`);
          debugBus.recordEvent({ service: 'workbench', action: 'sandbox_resumed', summary: `Resumed sandbox ${sandboxId} in ${ms} ms.`, meta: { sandboxId, durationMs: ms, from } });
          await note(true, ms);
          await meterWorkbenchAwakeBySandboxId(sandboxId);
        },
        async (error: unknown) => {
          const ms = Date.now() - startedAt;
          console.warn(`[workbench] resuming sandbox ${sandboxId} failed after ${ms} ms:`, error);
          debugBus.recordEvent({ service: 'workbench', action: 'sandbox_resume_failed', summary: `Resuming sandbox ${sandboxId} failed after ${ms} ms.`, ok: false, error, meta: { sandboxId, durationMs: ms, from } });
          await note(false, ms);
          throw error;
        },
      )
      .finally(() => resuming.delete(sandboxId));
    resuming.set(sandboxId, pending);
  }
  return pending;
}

/**
 * Before a turn's first exec: a box asleep on its host's disk is resumed WITH
 * its credentials. Without this the exec wakes it, and the fleet fetches the
 * credentials before the boot, which was 3.6-4.3 s of a 5.4 s wake. A box in
 * object storage is left to `withWake`, whose resume carries them too.
 *
 * Never throws: on any failure the exec that follows wakes the box the old
 * way, and reports a lost box as it always did.
 */
export async function wakeWithCredentials(row: WorkbenchRow): Promise<void> {
  if (!row.sandboxId) return;
  try {
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    const { sandbox } = await client.getSandbox(row.sandboxId);
    if (sandbox?.status !== 'suspended') return;
    if (sandbox.suspendUploaded && !sandbox.suspendDir) return;
    await resumeOnce(client, row.sandboxId, 'host', () => resumeCredentialsFor(row));
  } catch (err) {
    console.warn(`[workbench] waking ${row.sandboxId} with its credentials failed; the next exec wakes it:`, err);
  }
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
  /**
   * Stream the command and hand each stderr line here as it arrives, for
   * progress. The result is then line based: the lines of each stream joined
   * with `\n`. Not with `quiet`, `follow` or `diskRecovery`.
   */
  onStderrLine?: (line: string) => void;
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
  if (opts.onStderrLine) return runCaptureStreamed(row, script, opts.onStderrLine, opts);
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

async function runCaptureStreamed(
  row: WorkbenchRow,
  script: string,
  onStderrLine: (line: string) => void,
  opts: SandboxExecOptions,
): Promise<SandboxExecResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outcome = await runStream(row, script, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    marker: opts.marker ?? `capture-${newNonce()}`,
    onStdoutLine: (line) => { stdout.push(line); },
    onStderrLine: (line) => {
      stderr.push(line);
      try {
        onStderrLine(line);
      } catch (err) {
        console.warn('[workbench] a stderr line handler failed:', err);
      }
    },
  });
  const out = stdout.join('\n');
  return { exitCode: outcome.exitCode ?? -1, stdout: out, stderr: stderr.join('\n'), stdoutBytes: Buffer.from(out, 'utf8') };
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

/**
 * True when the marker's process group is alive, false when it is gone. Throws
 * when the box did not say: a check that timed out comes back as -1, and that
 * is not evidence of a dead process. Reading it as one ended live turns' output.
 */
export async function isMarkerAlive(row: WorkbenchRow, marker: string): Promise<boolean> {
  const { script, env } = aliveMarkerScript(marker);
  const r = await runCapture(row, script, { cwd: '/', env, timeoutMs: 10_000, quiet: true });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new Error(`The liveness check of ${marker} did not finish (exit ${r.exitCode}).`);
}

// ============================================================================
// Clone, config, credentials
// ============================================================================

/** Where a golden-booted box already has the repository checked out. */
export const GOLDEN_REPO_DIR = `${SANDBOX_WORK_ROOT}/repo`;

/** The clone script's lock. In the work root, never in a repository's tree. */
export const CLONE_LOCK_FILE = `${SANDBOX_WORK_ROOT}/.talyn-clone.lock`;

/**
 * Shell functions for `cloneScript({ progress: true })`. `git_progress CMD...`
 * runs CMD with its stdout untouched and its stderr through `cr_lines`, which
 * turns git's `\r` updates into lines. It runs in a subshell with `pipefail`,
 * so its status is CMD's (tr exits 0), the script's other pipelines keep their
 * old status rules, and `set -e` stops the script on a failed clone or fetch
 * exactly as it did. A pipeline, not `2> >(...)`: bash does not wait for a
 * process substitution, so a capture could end before the last error line.
 * `stdbuf -o0` stops tr holding updates in a 4 KiB buffer; without it the
 * lines still arrive, later.
 */
export const GIT_PROGRESS_FUNCTIONS = [
  "cr_lines() { if command -v stdbuf >/dev/null 2>&1; then stdbuf -o0 tr '\\r' '\\n'; else tr '\\r' '\\n'; fi; }",
  'git_progress() (',
  '  set -o pipefail',
  '  { "$@" 2>&1 1>&3 3>&- | cr_lines >&2 3>&-; } 3>&1',
  ')',
];

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
 * A new allocated branch fetches only the base, from the image commit's date.
 * Other branches use explicit refspecs and deepen until the diff has a merge base.
 *
 * `git` reaches GitHub through the guest's proxy rewrite, which attaches the
 * credential host-side; the token never enters the box. The fallback clone is
 * blobless, so a large repository is usable in seconds and blobs arrive as read.
 *
 * With `progress`, every clone and fetch prints git's progress, one update per
 * stderr line: git separates its updates with `\r`, and the guest splits
 * output on `\n` only. Each command keeps its own exit status (see
 * {@link GIT_PROGRESS_FUNCTIONS}).
 */
export function cloneScript(
  row: Pick<WorkbenchRow, 'repoFullName' | 'branch' | 'baseBranch'>
    & Partial<Pick<WorkbenchRow, 'allocatedBranch' | 'pushedHeadShas'>>,
  opts: { boxLayer?: BoxLayerContext; prebakedCheckout?: boolean; firstBox?: boolean; warm?: boolean; progress?: boolean } = {},
): string {
  const prebaked = opts.boxLayer ? hasPrebakedCheckout(opts.boxLayer, opts.prebakedCheckout) : false;
  const depth = prebaked ? 50 : 200;
  const repoCommit = opts.boxLayer?.repoCommit;
  const newBranch = prebaked && opts.firstBox === true && row.allocatedBranch === true && row.pushedHeadShas?.length === 0
    && row.branch !== row.baseBranch && repoCommit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(repoCommit);
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
  const run = opts.progress ? 'git_progress ' : '';
  const progress = opts.progress ? ' --progress' : '';
  const fetch = `${run}git fetch --no-tags${progress}`;
  return [
    'set -e',
    ...(opts.progress ? GIT_PROGRESS_FUNCTIONS : []),
    `mkdir -p ${SANDBOX_WORK_ROOT}`,
    // Two provisions of one session can run this at once. The second waits,
    // then finds the clone and takes the existing-clone path. Outside the work tree.
    `exec 9>${shellQuote(CLONE_LOCK_FILE)}`,
    'if command -v flock >/dev/null 2>&1; then flock 9; fi',
    `if [ ! -d ${dir}/.git ]; then`,
    `  origin_url=$(git -C ${golden} remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)`,
    '  golden_match=',
    '  case "$origin_url" in',
    `    */${slug}|*/${slug}.git|*:${slug}|*:${slug}.git) golden_match=1 ;;`,
    '  esac',
    `  if [ -n "$golden_match" ] && [ -d ${golden}/.git ] && [ ! -e ${dir} ]; then`,
    `    ln -s ${golden} ${dir}`,
    '  else',
    `    ${run}git clone --filter=blob:none${progress} ${url} ${dir}`,
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
    'shallow_since=',
    ...(newBranch ? [
      // Keep local work on retries. Missing image objects use the existing path.
      `if ! git show-ref --verify --quiet ${localRef}; then`,
      `  image_date=$(git show -s --format=%ct ${shellQuote(repoCommit)} -- 2>/dev/null || true)`,
      '  case "$image_date" in',
      "    ''|*[!0-9]*) ;;",
      // Include the image commit, even if Git excludes the date boundary.
      '    *) shallow_since="@$((image_date - 1))" ;;',
      '  esac',
      'fi',
    ] : []),
    'remote_branch=',
    // A warm box (`warmPool.ts`) has no branch of its own: it waits on the base,
    // detached, so a session's branch never finds a stale local copy of it.
    ...(opts.warm ? [] : [
      'if [ -z "$shallow_since" ]; then',
      `  if git ls-remote --exit-code --heads origin ${branch} >/dev/null; then`,
      '    remote_branch=1',
      `    ensure_refspec ${branchSpec}`,
      `    set -- "$@" ${branchSpec}`,
      '  else',
      // Only status 2 means the branch is absent. A failed probe must stop checkout.
      '    remote_status=$?',
      '    if [ "$remote_status" -ne 2 ]; then exit "$remote_status"; fi',
      '  fi',
      'fi',
    ]),
    'shallow=',
    'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then shallow=1; fi',
    'if [ -n "$shallow" ]; then',
    // A rewritten base can predate the image. Retry without the date limit.
    '  if [ -n "$shallow_since" ]; then',
    `    ${fetch} --shallow-since="$shallow_since" origin "$@" || ${fetch} --depth=${depth} origin "$@"`,
    '  else',
    `    ${fetch} --depth=${depth} origin "$@"`,
    '  fi',
    'else',
    `  ${fetch} origin "$@"`,
    'fi',
    ...(opts.warm ? [`git checkout --detach ${remoteBase}`] : [
      `if git show-ref --verify --quiet ${localRef}; then`,
      `  git checkout ${branch}`,
      'elif [ -n "$remote_branch" ]; then',
      `  git checkout -b ${branch} --track ${remoteBranch}`,
      'else',
      `  git checkout --no-track -b ${branch} ${remoteBase}`,
      'fi',
    ]),
    // The diff is against the merge base, and a shallow history may not reach
    // it. Deepen in bounded steps, then unshallow as the last resort.
    // A history that became complete stops the loop: no merge base there means
    // unrelated histories, and `--unshallow` on a complete repo is an error.
    'tries=0',
    `while [ "$(git rev-parse --is-shallow-repository)" = true ] && ! git merge-base HEAD ${remoteBase} >/dev/null 2>&1; do`,
    `  if [ "$tries" -ge ${MERGE_BASE_DEEPEN_TRIES} ]; then ${fetch} --unshallow origin "$@"; break; fi`,
    `  ${fetch} --deepen=${MERGE_BASE_DEEPEN_BY} origin "$@"`,
    '  tries=$((tries + 1))',
    'done',
    // What the box knows about its image, for the box setup (`BOX_LAYER_FILE`).
    // Outside the work tree; the checkout commit is HEAD now.
    ...(opts.boxLayer ? boxLayerFileLines(opts.boxLayer) : []),
    'git rev-parse HEAD',
  ].join('\n');
}

function boxLayerFileLines(ctx: BoxLayerContext): string[] {
  const { checkoutCommit: _ignored, ...rest } = ctx;
  void _ignored;
  const head = JSON.stringify(rest).replace(/\}$/, '');
  return [
    `printf '%s' ${shellQuote(head)} > ${shellQuote(BOX_LAYER_FILE)} || true`,
    `printf ',"checkoutCommit":"%s"}' "$(git rev-parse HEAD)" >> ${shellQuote(BOX_LAYER_FILE)} || true`,
  ];
}

/**
 * The repository's workbench config, read in one exec: the three files the
 * shared resolver understands, first found wins, then the workbench's own
 * overrides on top.
 */
export async function loadWorkbenchConfig(row: WorkbenchRow): Promise<WorkbenchConfig> {
  // A thread has no repository, so no config file and no scripts.
  if (row.kind === 'thread') {
    return applyWorkbenchScriptOverrides(resolveWorkbenchConfig({ talynToml: null, conductorJson: null, conductorToml: null }), {});
  }
  const r = await runCapture(
    row,
    sectionsScript([
      { label: 'TALYN', command: 'cat .talyn/settings.toml' },
      { label: 'CJSON', command: 'cat conductor.json' },
      { label: 'CTOML', command: 'cat .conductor/settings.toml' },
      { label: 'LAYER', command: `cat ${shellQuote(BOX_LAYER_FILE)}` },
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
  // Row 0 of the Setup list: what this box read of the repository's own setup.
  if (row.repositoryId) {
    void noteRepoSetupRead(row.repositoryId, config).catch((error) => debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'repo_setup_note_failed',
      summary: "Could not keep the repository's own setup command for the Setup list.",
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId, workbenchId: row.id },
    }));
  }
  // The Setup list runs after the repository's own setup, never instead of it.
  return withBoxSetup(row, applyWorkbenchScriptOverrides(config, row.settings), parseBoxLayerContext(files.LAYER));
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

export function detectWorkbenchScriptsInBox(row: WorkbenchRow) {
  return detectScripts(row);
}

export async function loadWorkbenchConfigWithDetection(row: WorkbenchRow): Promise<WorkbenchConfig> {
  const config = await loadWorkbenchConfig(row);
  if (config.source === 'none' && row.kind !== 'thread') config.detected = await detectScripts(row);
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
 * Keep the original account field for the session agent. Store the other agent's account separately.
 * A teammate who pays for turns has their own record under `payerFleetAccounts`, so their account
 * never replaces the owner's.
 */
export function workbenchFleetAccountId(
  row: Pick<WorkbenchRow, 'settings'> & { agent?: string },
  agent?: FleetAgent,
  payerUserId?: string | null,
): string | undefined {
  const settings = row.settings as Record<string, unknown> | null | undefined;
  if (payerUserId) {
    const byPayer = settings?.payerFleetAccounts as Record<string, Record<string, unknown> | undefined> | undefined;
    const value = byPayer?.[payerUserId]?.[agent ?? (row.agent === 'codex' ? 'codex' : 'claude')];
    return typeof value === 'string' && value ? value : undefined;
  }
  const value = agent && agent !== row.agent ? settings?.[`${agent}FleetAccountId`] : settings?.fleetAccountId;
  return typeof value === 'string' && value ? value : undefined;
}

/** Write only that key, so a settings edit made at the same moment is kept. */
export async function setWorkbenchFleetAccount(
  row: Pick<WorkbenchRow, 'id' | 'settings'> & { agent?: string },
  accountId: string,
  agent?: FleetAgent,
  payerUserId?: string | null,
): Promise<void> {
  if (payerUserId) {
    const vendor = agent ?? (row.agent === 'codex' ? 'codex' : 'claude');
    const current = workbenchSettings(row).payerFleetAccounts as Record<string, Record<string, string>> | undefined;
    await getPoolDbClient()
      .update(workbenchesTable)
      .set({
        settings: sql`jsonb_set(COALESCE(${workbenchesTable.settings}, '{}'::jsonb), '{payerFleetAccounts}',
          COALESCE(${workbenchesTable.settings} -> 'payerFleetAccounts', '{}'::jsonb) || jsonb_build_object(${payerUserId}::text,
            COALESCE(${workbenchesTable.settings} -> 'payerFleetAccounts' -> ${payerUserId}::text, '{}'::jsonb)
              || jsonb_build_object(${vendor}::text, ${accountId}::text)))`,
      })
      .where(eq(workbenchesTable.id, row.id));
    row.settings = {
      ...(row.settings ?? {}),
      payerFleetAccounts: { ...(current ?? {}), [payerUserId]: { ...(current?.[payerUserId] ?? {}), [vendor]: accountId } },
    } as WorkbenchRow['settings'];
    return;
  }
  const key = agent && agent !== row.agent ? `${agent}FleetAccountId` : 'fleetAccountId';
  await getPoolDbClient()
    .update(workbenchesTable)
    .set({
      settings: sql`COALESCE(${workbenchesTable.settings}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${accountId}::text)`,
    })
    .where(eq(workbenchesTable.id, row.id));
  // The caller's copy too: a turn keeps using its row while it runs.
  row.settings = { ...(row.settings ?? {}), [key]: accountId } as WorkbenchRow['settings'];
}

/**
 * Choose the account a session's NEXT turn tries first. It is recorded as the
 * session's account and nothing else changes: a running turn keeps the account
 * it has, and the turn start still leaves it when it is limited or over.
 */
export async function setSessionAccount(row: WorkbenchRow, accountId: string): Promise<void> {
  if (row.runtime !== 'sandbox') throw new WorkbenchError('Only a sandbox session runs on a fleet account.', 409, 'local_runtime');
  const account = await getFleetAccount(accountId);
  if (!account || account.workspaceId !== row.workspaceId) {
    throw new WorkbenchError('That account is not in this workspace.', 404, 'account_not_found');
  }
  if (account.agent !== agentOf(row)) {
    throw new WorkbenchError(
      `This session runs ${agentOf(row) === 'codex' ? 'Codex' : 'Claude'}; "${account.label}" is a ${account.agent === 'codex' ? 'Codex' : 'Claude'} account.`,
      400,
      'account_wrong_agent',
    );
  }
  if (account.reauthRequiredAt) {
    throw new WorkbenchError(`"${account.label}" needs to be signed in again before a session can use it.`, 409, 'account_needs_reauth');
  }
  await setWorkbenchFleetAccount(row, accountId);
}

function workbenchSettings(row: Pick<WorkbenchRow, 'settings'>): Record<string, unknown> {
  return (row.settings ?? {}) as Record<string, unknown>;
}

/** The options every credential resolution takes. `payer`: null is the owner; absent reads the box's current payer. */
export interface SessionCredentialOptions {
  agent?: FleetAgent;
  model?: string;
  avoidAccountIds?: readonly string[];
  payer?: TurnPayerRef | null;
}

/** The payer to use: the one given, else whoever pays for the box's latest turn. */
async function resolvePayer(row: Pick<WorkbenchRow, 'id'>, payer: TurnPayerRef | null | undefined): Promise<TurnPayerRef | null> {
  return payer !== undefined ? payer : currentBoxPayer(row.id);
}

function agentOf(row: Pick<WorkbenchRow, 'agent'>): FleetAgent {
  return providerForAgent(row.agent) === 'openai' ? 'codex' : 'claude';
}

/**
 * Refresh both vendor keys. Refuse if the turn's agent has no usable key.
 * `payer` absent means the owner: only a teammate's own turn names a payer, so
 * an owner or Talyn action never runs on a teammate's credentials.
 */
export async function refreshSandboxCredentials(
  row: WorkbenchRow,
  opts: SessionCredentialOptions = {},
): Promise<{ accountId: string | null; note: string | null }> {
  const sandboxId = requireSandbox(row);
  const agent = opts.agent ?? agentOf(row);
  assertSandboxAgent(row, agent);
  const { creds, credentials, model, payer } = await sandboxCredentialSet(row, { ...opts, payer: opts.payer ?? null });
  const credential = credentials[agent];
  if (!credential?.token) throw missingSessionCredential(agent, payer);
  const recorded = workbenchFleetAccountId(row, agent, payer?.userId);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  await withLostRecovery(row, () => client.setSandboxCredentials(sandboxId, creds));

  let note: string | null = null;
  if (credential.accountId && credential.accountId !== recorded) {
    await setWorkbenchFleetAccount(row, credential.accountId, agent, payer?.userId).catch((err) =>
      console.warn(`[workbench] recording the fleet account for ${row.id} failed:`, err),
    );
    if (recorded) {
      note = await describeAccountSwitch(payer?.workspaceId ?? row.workspaceId, recorded, credential.accountId, model).catch(
        () => null,
      );
      if (note) {
        recordWorkbenchEvent(row, 'account_switch', note);
      }
    }
  }
  return { accountId: credential.accountId ?? null, note };
}

/** Resolve both vendors with the same account rules used for a turn. */
export async function workbenchAgentCredentials(
  row: WorkbenchRow,
  opts: SessionCredentialOptions = {},
) {
  const selectedAgent = opts.agent ?? agentOf(row);
  // A teammate's turn takes both vendors from the teammate's workspace only.
  const payer = opts.payer ?? null;
  const workspaceId = payer?.workspaceId ?? row.workspaceId;
  const accounts = await listFleetAccounts(workspaceId);
  const unavailable = accounts.filter((account) => account.reauthRequiredAt
    || (account.quotaExhausted && isHeldBack(account.quotaExhausted))).map((account) => account.id);
  const resolve = (agent: FleetAgent) => resolveRunCredential(workspaceId, agent, {
    recordedAccountId: workbenchFleetAccountId(row, agent, payer?.userId),
    model: agent === selectedAgent ? opts.model ?? (agent === row.agent ? row.model ?? undefined : undefined) : undefined,
    switchWhenOver: true,
    avoidAccountIds: [...unavailable, ...(agent === selectedAgent ? opts.avoidAccountIds ?? [] : [])],
  });
  const [claude, codex] = await Promise.all([resolve('claude'), resolve('codex')]);
  if (!claude?.token && !codex?.token) throw missingSessionCredential(undefined, payer);
  return { claude, codex };
}

function missingSessionCredential(agent?: FleetAgent, payer?: TurnPayerRef | null): WorkbenchError {
  const label = agent === 'codex' ? 'Codex (ChatGPT)' : agent === 'claude' ? 'Claude' : 'Claude or Codex';
  return new WorkbenchError(
    payer
      ? `Your workspace has no usable ${label} subscription. Connect it in Settings → Talyn Fleet to prompt this session.`
      : `This workspace has no usable ${label} subscription. Connect it in Settings → Talyn Fleet.`,
    409,
    'credentials_unavailable',
  );
}

/**
 * A push replaces the full set, including the other vendor and MCP secrets.
 *
 * During a teammate's turn every part comes from the payer's workspace: the
 * GitHub token, both agent keys and the MCP secrets. None of the owner's is in
 * the set, and the owner's session token for Talyn's own server is replaced by
 * one that opens nothing. `payer` absent reads the box's current payer, so a
 * host pull between turns answers with the latest turn's set.
 */
export async function sandboxCredentialSet(
  row: WorkbenchRow,
  opts: SessionCredentialOptions = {},
): Promise<{
  creds: FleetSandboxCredentials;
  credentials: Awaited<ReturnType<typeof workbenchAgentCredentials>>;
  model: string | undefined;
  payer: TurnPayerRef | null;
}> {
  const payer = await resolvePayer(row, opts.payer);
  const githubToken = await githubService.getVerifiedAccessToken(payer?.workspaceId ?? row.workspaceId);
  if (!githubToken) {
    throw new WorkbenchError(
      payer ? 'Connect GitHub in your workspace to prompt this session.' : 'Connect GitHub for this workspace.',
      409,
      'credentials_unavailable',
    );
  }
  const credentials = await workbenchAgentCredentials(row, { ...opts, payer });
  const integrations = payer
    ? await payerIntegrationSecrets(payer.workspaceId, row.kind === 'thread' ? null : row.repositoryId)
    : await workbenchIntegrationSecrets(row);
  const creds: FleetSandboxCredentials = {
    githubToken,
    ...(credentials.claude?.token ? { anthropicKey: credentials.claude.token } : {}),
    ...(credentials.codex?.token ? { openaiKey: credentials.codex.token } : {}),
    ...(row.repoFullName ? { repo: row.repoFullName } : {}),
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
  };
  return { creds, credentials, model: opts.model ?? row.model ?? undefined, payer };
}

export async function pushSessionCredentials(row: WorkbenchRow, sandboxId: string, client: FleetClient): Promise<void> {
  const { creds, credentials, payer } = await sandboxCredentialSet(row);
  await client.setSandboxCredentials(sandboxId, creds);
  for (const agent of ['claude', 'codex'] as const) {
    const credential = credentials[agent];
    if (credential?.accountId && credential.accountId !== workbenchFleetAccountId(row, agent, payer?.userId)) {
      await setWorkbenchFleetAccount(row, credential.accountId, agent, payer?.userId);
    }
  }
}

/**
 * Run an owner or Talyn git action on the box (Talyn's PR step, "Create PR")
 * as the owner: push the owner's set first, so the push and the GitHub API
 * call are one identity. Commits use the box's git config, which is the
 * owner's. A teammate turn still running on the box gets its own set back
 * after; otherwise the next teammate turn pushes its set as usual.
 */
export async function withOwnerCredentials<T>(row: WorkbenchRow, fn: () => Promise<T>): Promise<T> {
  await refreshSandboxCredentials(row, { payer: null });
  try {
    return await fn();
  } finally {
    try {
      const running = await runningBoxPayer(row.id);
      if (running && row.sandboxId) {
        const { creds } = await sandboxCredentialSet(row, { payer: running });
        const client = await fleetClientFor(row.workspaceId, row.fleetHost);
        await client.setSandboxCredentials(row.sandboxId, creds);
      }
    } catch (err) {
      console.warn(`[workbench] giving ${row.id} back to the running turn's payer failed:`, err);
    }
  }
}

/**
 * The credentials to send WITH a resume, so the fleet does not fetch them
 * before the boot (3.6-4.3 s of a 5.4 s local wake, 2026-11-04). Null when
 * they cannot be resolved: the resume then goes without, and the fleet
 * fetches as it always did. The turn's own push after the wake still runs,
 * and is what records an account switch.
 */
export async function resumeCredentialsFor(row: WorkbenchRow, payer?: TurnPayerRef | null): Promise<FleetSandboxCredentials | null> {
  try {
    return (await sandboxCredentialSet(row, { payer })).creds;
  } catch (err) {
    console.warn(`[workbench] resuming ${row.sandboxId} without credentials; the fleet fetches them:`, err);
    return null;
  }
}

/**
 * Move a session's box to the next account of the same agent when its account
 * has crossed the threshold mid-turn. The push carries the whole set, as the
 * per-turn refresh does. Returns the note to show, or null when nothing moved.
 */
export async function checkSandboxHotSwap(
  row: WorkbenchRow,
  model?: string,
  agent: FleetAgent = agentOf(row),
  payerArg?: TurnPayerRef | null,
): Promise<string | null> {
  if (row.runtime !== 'sandbox' || !row.sandboxId) return null;
  // A teammate's turn swaps among the teammate's own accounts.
  const payer = await resolvePayer(row, payerArg);
  const workspaceId = payer?.workspaceId ?? row.workspaceId;
  const decision = await findHotSwap({
    key: payer ? `wb:${row.id}:${agent}:${payer.userId}` : `wb:${row.id}:${agent}`,
    workspaceId,
    agent,
    model: model ?? row.model ?? undefined,
    currentAccountId: workbenchFleetAccountId(row, agent, payer?.userId),
  });
  if (!decision) return null;
  assertSandboxAgent(row, agent);
  const { creds } = await sandboxCredentialSet(row, { agent, model, payer });
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  await withLostRecovery(row, () => client.setSandboxCredentials(row.sandboxId!, {
    ...creds,
    ...(agent === 'codex' ? { openaiKey: decision.token } : { anthropicKey: decision.token }),
  }));
  await setWorkbenchFleetAccount(row, decision.to.id, agent, payer?.userId);
  recordHotSwap(workspaceId, `workbench ${row.id.slice(0, 8)}`, decision);
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
  agent: FleetAgent = agentOf(row),
  payer: TurnPayerRef | null = null,
): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void checkSandboxHotSwap(row, model, agent, payer)
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
