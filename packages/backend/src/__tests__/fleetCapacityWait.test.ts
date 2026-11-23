import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as warmPool from '../services/workbenches/warmPool.js';
import {
  FleetCapacityError,
  FleetHttpError,
  FleetThrottleError,
  type FleetClient,
  type FleetSandbox,
} from '../services/selfHosted/client.js';
import {
  bootFailedError,
  capacityWaitDelayMs,
  FLEET_CAPACITY_WAIT,
  isQueueRecord,
  NoFreeSandboxError,
  waitForFleetCapacity,
  type CapacityWaitOptions,
} from '../services/selfHosted/capacityWait.js';

/**
 * The shared wait for fleet room, on its own: a fake fleet, a fake owner. The
 * session path and the review path each have their own tests through it.
 */

type Answer = { sandbox: FleetSandbox };
const DEFAULT_WAIT = { ...FLEET_CAPACITY_WAIT };

class Superseded extends Error {}

const box = (id: string, status: FleetSandbox['status'], extra: Partial<FleetSandbox> = {}): FleetSandbox =>
  ({ id, status, ...extra }) as FleetSandbox;
const busy = (reason: 'no_capacity' | 'unreachable' = 'no_capacity', retryAfterMs?: number) =>
  new FleetCapacityError('host full at http://10.0.0.1', retryAfterMs, reason);

describe('waitForFleetCapacity', () => {
  let client: { getSandbox: ReturnType<typeof vi.fn>; deleteSandbox: ReturnType<typeof vi.fn> };
  let yieldPool: MockInstance<typeof warmPool.yieldWarmPool>;

  beforeEach(() => {
    Object.assign(FLEET_CAPACITY_WAIT, { maxMs: 400, firstDelayMs: 5, maxDelayMs: 20, checkMs: 2, queuePollMs: 3 });
    client = { getSandbox: vi.fn(), deleteSandbox: vi.fn(async () => undefined) };
    yieldPool = vi.spyOn(warmPool, 'yieldWarmPool').mockResolvedValue(0);
  });

  afterEach(() => {
    Object.assign(FLEET_CAPACITY_WAIT, DEFAULT_WAIT);
    vi.restoreAllMocks();
  });

  /** The options with every hook a spy. `create` answers from `script`, then creates the box. */
  function options(script: Array<Error | FleetSandbox>, over: Partial<CapacityWaitOptions<Answer>> = {}) {
    let attempt = 0;
    const create = vi.fn(async (id: string): Promise<Answer> => {
      const step = script[attempt++];
      if (step instanceof Error) throw step;
      return { sandbox: step ? { ...step, id } : box(id, 'idle') };
    });
    const hooks = {
      onWait: vi.fn(async () => undefined),
      onEnd: vi.fn(async () => undefined),
      owned: vi.fn(async () => true),
      nextId: vi.fn(async (fromId: string) => `${fromId}-next`),
      draining: vi.fn(() => false),
      lost: vi.fn(() => false),
    };
    const opts: CapacityWaitOptions<Answer> = {
      label: 'test unit',
      sandboxId: 'sb-1',
      create,
      queueOf: (answer) => ({ client: client as unknown as FleetClient, record: answer.sandbox }),
      withRecord: (answer, sandbox) => ({ ...answer, sandbox }),
      control: {
        draining: hooks.draining,
        lost: hooks.lost,
        owned: hooks.owned,
        superseded: () => new Superseded('moved on'),
        isSuperseded: (err) => err instanceof Superseded,
      },
      onWait: hooks.onWait,
      nextId: hooks.nextId,
      onEnd: hooks.onEnd,
      ...over,
    };
    return { opts, create, hooks };
  }

  it('hands back a box the fleet created at once, with no wait', async () => {
    const { opts, create, hooks } = options([]);
    const result = await waitForFleetCapacity(opts);
    expect(result).toMatchObject({ kind: 'created', sandboxId: 'sb-1', waitMs: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(hooks.onWait).not.toHaveBeenCalled();
    expect(hooks.onEnd).not.toHaveBeenCalled();
    expect(yieldPool).not.toHaveBeenCalled();
  });

  it.each([
    ['a full host', [busy(), busy()], 'no_capacity'],
    ['an unreachable fleet', [busy('unreachable')], 'unreachable'],
    ['the tenant queue cap (429)', [new FleetThrottleError('queue_depth')], 'throttled'],
    ['a mix of refusals', [new FleetThrottleError('rate'), busy(), busy('unreachable')], 'throttled'],
  ])('waits through %s on the SAME id, and notes the wait once', async (_label, refusals, why) => {
    const { opts, create, hooks } = options(refusals as Error[]);
    const result = await waitForFleetCapacity(opts);
    expect(result).toMatchObject({ kind: 'created', sandboxId: 'sb-1' });
    expect(create.mock.calls.map(([id]) => id)).toEqual(Array(refusals.length + 1).fill('sb-1'));
    expect(hooks.onWait).toHaveBeenCalledTimes(1);
    expect(hooks.onWait).toHaveBeenCalledWith(why);
    // The owner is asked again (and can renew a heartbeat) after every pause.
    expect(hooks.owned).toHaveBeenCalledTimes(refusals.length);
    expect(yieldPool).toHaveBeenCalledTimes(1);
    expect(yieldPool).toHaveBeenCalledWith(`test unit is waiting for room (${why})`);
    expect(hooks.onEnd).toHaveBeenCalledWith(expect.any(Number), 'sb-1');
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['a 400', new FleetHttpError('bad request', 400)],
  ])('throws %s at once, with no wait', async (_label, err) => {
    const { opts, hooks } = options([err]);
    await expect(waitForFleetCapacity(opts)).rejects.toBe(err);
    expect(hooks.onWait).not.toHaveBeenCalled();
  });

  it('throws a refusal the caller does not wait on', async () => {
    const refusal = busy();
    const { opts, hooks } = options([refusal], { waitsOn: () => false });
    await expect(waitForFleetCapacity(opts)).rejects.toBe(refusal);
    expect(hooks.onWait).not.toHaveBeenCalled();
  });

  it('gives up with NoFreeSandboxError when the fleet stays full past the bound', async () => {
    const { opts, hooks } = options(Array(10_000).fill(busy()));
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(NoFreeSandboxError);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps one bound across a resume: a wait that began long ago gives up at the first refusal', async () => {
    const { opts, create, hooks } = options([busy(), busy()], { startedAt: Date.now() - FLEET_CAPACITY_WAIT.maxMs - 1 });
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(NoFreeSandboxError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(hooks.onWait).not.toHaveBeenCalled();
  });

  it('polls a queued box until it boots, and hands back the polled record', async () => {
    client.getSandbox
      .mockResolvedValueOnce({ sandbox: box('sb-1', 'queued') })
      .mockResolvedValueOnce({ sandbox: box('sb-1', 'starting') })
      .mockResolvedValueOnce({ sandbox: box('sb-1', 'busy', { host: 'h-2' } as Partial<FleetSandbox>) });
    const { opts, hooks } = options([box('', 'queued')]);
    const result = await waitForFleetCapacity(opts);
    expect(result).toMatchObject({ kind: 'created', sandboxId: 'sb-1', answer: { sandbox: { status: 'busy' } } });
    expect(client.getSandbox).toHaveBeenCalledTimes(3);
    expect(hooks.onWait).toHaveBeenCalledWith('queued in the fleet');
    expect(hooks.onWait).toHaveBeenCalledTimes(1);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ['a capacity refusal', busy()],
    ['a throttle', new FleetThrottleError('slow down')],
  ])('polls again when reading the queued box meets %s', async (_label, err) => {
    client.getSandbox.mockRejectedValueOnce(err).mockResolvedValueOnce({ sandbox: box('sb-1', 'idle') });
    const { opts } = options([box('', 'queued')]);
    expect(await waitForFleetCapacity(opts)).toMatchObject({ kind: 'created' });
    expect(client.getSandbox).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the default (a booted box)', undefined, 'stopped', 'throws'],
    ['a caller that takes any box out of the queue', (r: { status: string }) => r.status !== 'starting', 'stopped', 'created'],
    ['a caller that takes any box out of the queue, failed', (r: { status: string }) => r.status !== 'starting', 'failed', 'created'],
  ] as const)('a box that left the queue as %s: %s → %s', async (_label, booted, status, outcome) => {
    client.getSandbox.mockResolvedValueOnce({ sandbox: box('sb-1', status, { error: 'it ended' }) });
    const { opts } = options([box('', 'queued')], booted ? { booted } : {});
    const run = waitForFleetCapacity(opts);
    if (outcome === 'throws') await expect(run).rejects.toThrow('The sandbox did not start: it ended');
    else expect(await run).toMatchObject({ kind: 'created', answer: { sandbox: { status } } });
  });

  it.each(['lost while queued: fleetd restarted', 'queued run did not survive the restart'])(
    'creates the box again on the next id when the fleet lost the queued one (%s)',
    async (error) => {
      const { opts, create, hooks } = options([box('', 'failed', { phase: 'queued', error } as Partial<FleetSandbox>)]);
      const result = await waitForFleetCapacity(opts);
      expect(hooks.nextId).toHaveBeenCalledWith('sb-1', 'queue_lost', 'the fleet lost queued sandbox sb-1');
      expect(create.mock.calls.map(([id]) => id)).toEqual(['sb-1', 'sb-1-next']);
      expect(result).toMatchObject({ kind: 'created', sandboxId: 'sb-1-next' });
    }
  );

  it.each([
    ['the fleet’s own queue limit', 'waited 30m0s for capacity', NoFreeSandboxError],
    ['any other queue failure', 'disk full', 'The sandbox failed while it waited for room: disk full'],
  ] as const)('ends on %s', async (_label, error, expected) => {
    const { opts } = options([box('', 'failed', { phase: 'queued', error } as Partial<FleetSandbox>)]);
    const run = waitForFleetCapacity(opts);
    if (typeof expected === 'string') await expect(run).rejects.toThrow(expected);
    else await expect(run).rejects.toBeInstanceOf(expected);
  });

  it('deletes a box still queued at the bound', async () => {
    client.getSandbox.mockResolvedValue({ sandbox: box('sb-1', 'queued') });
    const { opts } = options([box('', 'queued')]);
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(NoFreeSandboxError);
    expect(client.deleteSandbox).toHaveBeenCalledWith('sb-1');
  });

  it('stops waiting on a queued box the owner no longer names, and deletes it', async () => {
    client.getSandbox.mockResolvedValue({ sandbox: box('sb-1', 'queued') });
    const { opts, hooks } = options([box('', 'queued')]);
    hooks.owned.mockResolvedValue(false);
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(Superseded);
    expect(client.deleteSandbox).toHaveBeenCalledWith('sb-1');
  });

  it('keeps a queued box for a new owner when the claim lapsed but the work still names it', async () => {
    const { opts, hooks } = options([box('', 'queued')]);
    hooks.lost.mockReturnValue(true);
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(Superseded);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it('stops a 503 wait when the owner moved on, with nothing to delete', async () => {
    const { opts, hooks } = options([busy(), busy()]);
    hooks.owned.mockResolvedValue(false);
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(Superseded);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it('turns a superseded error from the first note on a queued box into a stop that deletes it', async () => {
    const { opts, hooks } = options([box('', 'queued')]);
    hooks.onWait.mockRejectedValue(new Superseded('row moved'));
    hooks.owned.mockResolvedValue(false);
    await expect(waitForFleetCapacity(opts)).rejects.toBeInstanceOf(Superseded);
    expect(client.deleteSandbox).toHaveBeenCalledWith('sb-1');
  });

  it.each([
    ['a 503 wait', [busy(), busy()] as Array<Error | FleetSandbox>],
    ['a queued box', [box('', 'queued')]],
  ])('ends quietly (null) at a drain during %s', async (_label, script) => {
    client.getSandbox.mockResolvedValue({ sandbox: box('sb-1', 'queued') });
    const { opts, hooks } = options(script);
    hooks.draining.mockReturnValue(true);
    expect(await waitForFleetCapacity(opts)).toBeNull();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  describe('a boot that failed', () => {
    const failedBoot = () => new FleetHttpError('sandbox did not boot: host busy', 400);
    const bootFailure = (max: number) => ({
      retries: { max },
      reason: (_answer: Answer | null, err: unknown) => bootFailedError(err),
    });

    it.each([
      [1, 1],
      [2, 1],
      [2, 2],
    ])('with %i retries and %i failures, goes to a new id and boots', async (max, failures) => {
      const { opts, create, hooks } = options(Array(failures).fill(failedBoot()), { bootFailure: bootFailure(max) });
      expect(await waitForFleetCapacity(opts)).toMatchObject({ kind: 'created' });
      expect(create).toHaveBeenCalledTimes(failures + 1);
      expect(hooks.nextId).toHaveBeenCalledTimes(failures);
      expect(hooks.nextId).toHaveBeenCalledWith('sb-1', 'boot_failed', 'sandbox did not boot: host busy');
    });

    it('answers boot_failed once the retries are spent', async () => {
      const { opts } = options([failedBoot(), failedBoot(), failedBoot()], { bootFailure: bootFailure(1) });
      expect(await waitForFleetCapacity(opts)).toMatchObject({
        kind: 'boot_failed',
        reason: 'sandbox did not boot: host busy',
        sandboxId: 'sb-1-next',
      });
    });

    it('is a plain error when the caller asks for no boot retries', async () => {
      const err = failedBoot();
      const { opts } = options([err]);
      await expect(waitForFleetCapacity(opts)).rejects.toBe(err);
    });
  });
});

describe('the wait helpers', () => {
  afterEach(() => {
    Object.assign(FLEET_CAPACITY_WAIT, DEFAULT_WAIT);
  });

  it.each([
    [{ status: 'queued' }, true],
    [{ status: 'failed', phase: 'queued' }, true],
    [{ status: 'failed', phase: 'boot' }, false],
    [{ status: 'idle' }, false],
    [{ status: 'starting' }, false],
  ] as const)('isQueueRecord(%o) is %s', (record, expected) => {
    expect(isQueueRecord(record as never)).toBe(expected);
  });

  it.each([
    [0, undefined, 10_000],
    [1, undefined, 20_000],
    [3, undefined, 60_000],
    [40, undefined, 60_000],
    [0, 45_000, 45_000],
    [0, 600_000, 60_000],
  ])('capacityWaitDelayMs(%i, %s) is %i at the middle of the jitter', (attempt, retryAfter, expected) => {
    expect(capacityWaitDelayMs(attempt, retryAfter, () => 0.5)).toBe(expected);
  });

  it.each([
    [new FleetHttpError('sandbox did not boot: x', 400), 'sandbox did not boot: x'],
    [new FleetHttpError('bad request', 400), null],
    [new FleetHttpError('sandbox did not boot: x', 500), null],
    [new Error('sandbox did not boot: x'), null],
  ])('bootFailedError(%s) is %s', (err, expected) => {
    expect(bootFailedError(err)).toBe(expected);
  });
});
