import {
  FleetCapacityError,
  FleetDispatchUncertainError,
  FleetHttpError,
  FleetThrottleError,
  type FleetClient,
  type FleetSandbox,
} from './client.js';

/**
 * How a fleet create waits for a free sandbox, for a session's box and for a
 * code-review unit's box alike.
 *
 * When the host is out of memory, the create asks the fleet to queue the box
 * (`queueWhenFull`), and Talyn polls the queued box. Every other refusal is a
 * 503 (or a 429), and Talyn tries again with backoff on the SAME sandbox id:
 * the fleet's create is idempotent on the id. ONE bound covers both kinds of
 * wait. It matches the fleet's own queue limit (`MaxQueueWait`, 30 minutes).
 * A field, not a constant, so tests can shorten it.
 */
export const FLEET_CAPACITY_WAIT = {
  maxMs: 30 * 60_000,
  firstDelayMs: 10_000,
  maxDelayMs: 60_000,
  /** How often a sleep checks for a drain or a lost claim. */
  checkMs: 1_000,
  /** How often a wait reads a box that the fleet queued. */
  queuePollMs: 5_000,
};

/**
 * The start of the fleet's error on a queued box that a fleetd restart lost.
 * Nothing ran. The id answers from the failed record, so a new create needs a
 * new id. The second form is the fleet's queue pump finding the same loss.
 */
const QUEUE_LOST_ERRORS = ['lost while queued', 'queued run did not survive'];
/** The start of the fleet's error on a queued box that reached the fleet's own queue limit. */
const QUEUE_TIMEOUT_ERROR = 'waited';
/** The states of a box that has booted. The synchronous create answers `idle`. */
export const BOOTED_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'suspended']);

/** What the wait reads on a fleet record. */
export type QueueRecord = Pick<FleetSandbox, 'status' | 'phase' | 'error'>;

/** The fleet queued the box, or the queue already failed it. */
export function isQueueRecord(record: QueueRecord): boolean {
  return record.status === 'queued' || (record.status === 'failed' && record.phase === 'queued');
}

/** The pause before the next try: doubling, capped, with jitter. The fleet's Retry-After wins when it is longer. */
export function capacityWaitDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number {
  const { firstDelayMs, maxDelayMs } = FLEET_CAPACITY_WAIT;
  const doubled = Math.min(maxDelayMs, firstDelayMs * 2 ** Math.min(attempt, 30));
  const base = Math.min(maxDelayMs, Math.max(doubled, retryAfterMs ?? 0));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** No sandbox became free inside the bound, or the fleet's own queue limit ended the wait. */
export class NoFreeSandboxError extends Error {
  constructor(readonly waitedMs: number) {
    super(`No sandbox became free in ${Math.round(waitedMs / 60_000)} minutes`);
    this.name = 'NoFreeSandboxError';
  }
}

/** The default refusals a wait sits out: the fleet is full (503), or it throttles this tenant (429). */
export function isCapacityRefusal(err: unknown): err is FleetCapacityError | FleetThrottleError {
  return err instanceof FleetCapacityError || err instanceof FleetThrottleError;
}

/** Who owns the wait, and how the wait stops when that changes. */
export interface CapacityWaitControl {
  /** A drain: the wait ends quietly (null). Checked often, so it must be cheap. */
  draining(): boolean;
  /** The caller's claim lapsed. Checked often, so it must be cheap. */
  lost(): boolean;
  /** Whether the work still names this wait's box. Read after each pause. A caller can also renew a heartbeat here. */
  owned(): Promise<boolean>;
  /** The error that ends a wait that is no longer the caller's. */
  superseded(cause: 'lost' | 'moved'): Error;
  isSuperseded(err: unknown): boolean;
}

export interface CapacityWaitOptions<A> {
  /** Who waits, for logs and the warm-pool yield: `session 1a2b3c4d`. */
  label: string;
  sandboxId: string;
  /** When an earlier run of this wait started (ms epoch). A resumed wait keeps one bound. */
  startedAt?: number | null;
  /** One create on `sandboxId` that asks the fleet to queue the box when it is full. Throws the fleet's refusals. */
  create(sandboxId: string): Promise<A>;
  /** The client to poll and the record of an answer. Null: the answer is final as it is. */
  queueOf(answer: A): { client: FleetClient; record: QueueRecord } | null;
  /** The answer with a newer record from a poll. */
  withRecord(answer: A, record: FleetSandbox): A;
  /** Refusals that wait. Default {@link isCapacityRefusal}. */
  waitsOn?(err: unknown): boolean;
  /** Whether a record that left the queue is a box to hand back. Default {@link BOOTED_STATUSES}. */
  booted?(record: QueueRecord): boolean;
  /** A boot that failed is tried again on a new id, at most `retries.max` times. Absent: a boot failure is not handled here. */
  bootFailure?: {
    retries: { max: number };
    reason(answer: A | null, err: unknown): string | null;
  };
  control: CapacityWaitControl;
  /** The first wait of either kind. Called once. */
  onWait(why: string): Promise<void>;
  /** Nothing runs on `fromId`: give the next id, and move the caller's record to it. */
  nextId(fromId: string, cause: 'queue_lost' | 'boot_failed', detail: string): Promise<string>;
  /** After a wait that called `onWait`, however it ended. */
  onEnd?(waitMs: number, sandboxId: string): Promise<void>;
}

/** `waitMs`: how long the create waited for a free sandbox. 0: no wait. */
export type CapacityWaitResult<A> =
  | { kind: 'created'; answer: A; sandboxId: string; waitMs: number }
  | { kind: 'boot_failed'; reason: string; sandboxId: string; waitMs: number };

/** The queued box's record. Null when the fleet cannot answer now: the next poll asks again. */
async function readQueuedBox(client: FleetClient, sandboxId: string): Promise<FleetSandbox | null> {
  try {
    return (await client.getSandbox(sandboxId)).sandbox;
  } catch (err) {
    if (err instanceof FleetCapacityError || err instanceof FleetThrottleError || err instanceof FleetDispatchUncertainError) {
      console.warn(`[fleet] reading queued sandbox ${sandboxId} failed; polling again:`, err.message);
      return null;
    }
    throw err;
  }
}

/** A refusal in the fleet's own words, for the log. */
function refusalWhy(err: FleetCapacityError | FleetThrottleError): string {
  return err instanceof FleetThrottleError ? 'throttled' : err.reason;
}

/**
 * Create a box, and wait while the fleet has no room. A 503 or 429 is tried
 * again with the same sandbox id. A queued box is polled until it boots. A
 * queued box that a fleetd restart lost is created again on the next id (from
 * `nextId`), so the caller takes `sandboxId` from the answer.
 *
 * The wait ends quietly (null) at a drain. The fleet keeps a queued box, and a
 * later create with the same id finds it and waits again. The wait ends with
 * the caller's superseded error when the claim or the work moves on. A queued
 * box is deleted then, unless the work still names it: a new owner waits on
 * the same box. After the bound the wait throws {@link NoFreeSandboxError}.
 */
export async function waitForFleetCapacity<A>(opts: CapacityWaitOptions<A>): Promise<CapacityWaitResult<A> | null> {
  const { control } = opts;
  const waitsOn = opts.waitsOn ?? isCapacityRefusal;
  const booted = opts.booted ?? ((record: QueueRecord) => Boolean(record.status && BOOTED_STATUSES.has(record.status)));
  let sandboxId = opts.sandboxId;
  let startedAt: number | null = opts.startedAt ?? null;
  let noted = false;
  const timeLeft = () => {
    startedAt ??= Date.now();
    return FLEET_CAPACITY_WAIT.maxMs - (Date.now() - startedAt);
  };
  const waited = () => (startedAt === null ? 0 : Date.now() - startedAt);
  const noRoom = () => new NoFreeSandboxError(Math.max(waited(), FLEET_CAPACITY_WAIT.maxMs));
  const assertOwned = () => {
    if (control.lost()) throw control.superseded('lost');
  };
  /** Sleep in short steps. False at a drain. A lost claim ends the sleep early, and the caller reads `lost()`. */
  const pause = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(FLEET_CAPACITY_WAIT.checkMs, until - Date.now())));
      if (control.draining()) return false;
      if (control.lost()) return true;
    }
    return true;
  };
  /** The first wait of either kind: the caller's note, then the warm pool goes back to the fleet. */
  const noteWait = async (why: string) => {
    if (noted) return;
    noted = true;
    await opts.onWait(why);
    // Late import: the warm pool's module graph reaches back into the session lifecycle.
    const { yieldWarmPool } = await import('../workbenches/warmPool.js');
    // Real work outranks the warm pool: its boxes go back to the fleet.
    await yieldWarmPool(`${opts.label} is waiting for room (${why})`);
  };
  let bootFailures = 0;

  try {
    for (let attempt = 0; ;) {
      let answer: A | null = null;
      let createError: unknown = null;
      try {
        answer = await opts.create(sandboxId);
      } catch (err) {
        createError = err;
      }
      const bootFailed = opts.bootFailure ? opts.bootFailure.reason(answer, createError) : null;
      if (opts.bootFailure && bootFailed !== null) {
        // An answer, not a throw: the work may be on a new id now, and the caller fails the id this returns.
        if (bootFailures++ >= opts.bootFailure.retries.max) {
          return { kind: 'boot_failed', reason: bootFailed, sandboxId, waitMs: waited() };
        }
        if (control.draining()) return null;
        assertOwned();
        // A short pause: the host that failed the boot was busy a moment ago.
        if (!(await pause(FLEET_CAPACITY_WAIT.firstDelayMs))) return null;
        if (!(await control.owned())) throw control.superseded('moved');
        const failedId = sandboxId;
        sandboxId = await opts.nextId(failedId, 'boot_failed', bootFailed);
        continue;
      }
      if (createError !== null || answer === null) {
        const err = createError;
        // A 429 waits too: the fleet's per-tenant queue cap (queue_depth) and its
        // rate limit both clear with time, and the same bound applies.
        if (!isCapacityRefusal(err) || !waitsOn(err)) throw err;
        const left = timeLeft();
        if (left <= 0) throw noRoom();
        if (control.draining()) return null;
        assertOwned();
        await noteWait(refusalWhy(err));
        if (!(await pause(Math.min(capacityWaitDelayMs(attempt++, err.retryAfterMs), left)))) return null;
        assertOwned();
        if (!(await control.owned())) throw control.superseded('moved');
        continue;
      }
      const queue = opts.queueOf(answer);
      if (!queue || !isQueueRecord(queue.record)) return { kind: 'created', answer, sandboxId, waitMs: waited() };

      const { client } = queue;
      const queuedId = sandboxId;
      const dropQueuedBox = async () => {
        await client.deleteSandbox(queuedId).catch((err) =>
          console.warn(`[fleet] deleting queued sandbox ${queuedId} failed:`, err),
        );
      };
      /** The wait is no longer this run's. The queued box goes, unless the work still names it. */
      const stopWaiting = async () => {
        if (!(await control.owned())) await dropQueuedBox();
        return control.superseded('moved');
      };
      let current: A = answer;
      let record: QueueRecord = queue.record;
      for (;;) {
        if (record.status === 'failed' && record.phase === 'queued') {
          const error = record.error ?? '';
          if (QUEUE_LOST_ERRORS.some((prefix) => error.startsWith(prefix))) break;
          if (error.startsWith(QUEUE_TIMEOUT_ERROR)) throw noRoom();
          throw new Error(`The sandbox failed while it waited for room: ${error || 'the fleet gave no reason'}`);
        }
        if (record.status !== 'queued' && booted(record)) return { kind: 'created', answer: current, sandboxId, waitMs: waited() };
        if (record.status !== 'queued' && record.status !== 'starting') {
          throw new Error(`The sandbox did not start: ${record.error || `the fleet reports it ${record.status}`}`);
        }
        const left = timeLeft();
        if (left <= 0) {
          await dropQueuedBox();
          throw noRoom();
        }
        if (control.draining()) return null;
        if (control.lost()) throw await stopWaiting();
        await noteWait('queued in the fleet').catch(async (err: unknown) => {
          throw control.isSuperseded(err) ? await stopWaiting() : err;
        });
        if (!(await pause(Math.min(FLEET_CAPACITY_WAIT.queuePollMs, left)))) return null;
        if (control.lost() || !(await control.owned())) throw await stopWaiting();
        const polled = await readQueuedBox(client, sandboxId);
        if (polled) {
          current = opts.withRecord(current, polled);
          record = polled;
        }
      }

      // A fleetd restart lost the queued box. Nothing ran, so create it again on the next id.
      sandboxId = await opts.nextId(queuedId, 'queue_lost', `the fleet lost queued sandbox ${queuedId}`);
    }
  } finally {
    if (noted) await opts.onEnd?.(waited(), sandboxId);
  }
}

/**
 * Why the fleet's box did not boot, from fleetd's own 400 for the create that
 * failed. Null when the error is not that.
 */
export function bootFailedError(err: unknown): string | null {
  return err instanceof FleetHttpError && err.status === 400 && err.message.startsWith('sandbox did not boot') ? err.message : null;
}
