import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FleetCapacityError,
  FleetClient,
  FleetHibernationLostError,
  FleetHttpError,
  FleetRunNotFoundError,
  isHibernationLostResponse,
  lostSandboxError,
  resetFleetOptionalSupport,
} from '../services/selfHosted/client.js';
import {
  fleetErrorAsRefusal,
  isHibernationFetchFailed,
  SANDBOX_WAKING_MESSAGE,
  userFacingError,
} from '../services/workbenches/errors.js';
import { isHibernationLost, SANDBOX_LOST_MESSAGE } from '../services/workbenches/recovery.js';

const RAW = "this sandbox's hibernated copy cannot be restored: sandbox talyn-wb-406f67ad at suspend/x: rootfs.img.data is truncated";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The fleet answers the hibernation contract cases. */
const ANSWERS = {
  unusable: () => json({ error: 'hibernation_unusable', message: RAW, localCopy: false }, 409),
  lost: () => json({ error: 'hibernation_lost', message: 'the copy is gone' }, 409),
  messageOnly: () => json({ message: RAW }, 500),
  oldBuild: () => json({ error: 'hibernation_unusable', message: 'could not fetch' }, 500),
  fetchFailed: () => json({ error: 'hibernation_fetch_failed', message: RAW, retryable: true }, 503),
  unrelated: () => json({ error: 'guest_too_old', message: 'too old' }, 409),
} as const;

describe('isHibernationLostResponse', () => {
  it.each([
    [409, 'x', 'hibernation_unusable'],
    [409, 'x', 'hibernation_lost'],
    [500, 'x', 'hibernation_unusable'],
    [409, RAW, undefined],
    [500, 'Hibernated copy cannot be restored', undefined],
  ])('reads %i %s (%s) as lost', (status, message, code) => {
    expect(isHibernationLostResponse(status, message, code)).toBe(true);
    expect(lostSandboxError(status, message, code)).toBeInstanceOf(FleetHibernationLostError);
  });

  it.each([
    [503, RAW, 'hibernation_fetch_failed'],
    [503, RAW, 'hibernation_unusable'],
    [409, 'not running', 'sandbox_not_live'],
    [409, 'too old', 'guest_too_old'],
    [500, 'the hibernated copy is fine', undefined],
  ])('does not read %i %s (%s) as lost', (status, message, code) => {
    expect(isHibernationLostResponse(status, message, code)).toBe(false);
  });

  it('keeps the existing lost-box answer for a missing sandbox', () => {
    const err = lostSandboxError(409, 'not running', 'sandbox_not_live');
    expect(err).toBeInstanceOf(FleetRunNotFoundError);
    expect(err).not.toBeInstanceOf(FleetHibernationLostError);
    expect(lostSandboxError(409, 'too old', 'guest_too_old')).toBeNull();
  });
});

describe('fleet client: a hibernated copy that cannot come back', () => {
  let answer: () => Response;
  let paths: string[];

  beforeEach(() => {
    resetFleetOptionalSupport();
    paths = [];
    vi.stubGlobal('fetch', async (url: string) => {
      paths.push(url.replace('https://fleet.test', ''));
      return answer();
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const client = () => new FleetClient('https://fleet.test', 'tok');
  const CALLS: Array<[string, (c: FleetClient) => Promise<unknown>]> = [
    ['resume', (c) => c.resumeSandbox('sb')],
    ['exec', (c) => c.exec('sb', { cmd: ['x'] })],
    ['quiet exec', (c) => c.quietExec('sb', { cmd: ['x'] })],
    ['diff', (c) => c.getDiff('sb', { base: 'main' })],
    ['follow', async (c) => {
      for await (const frame of c.execFollow('sb', { cmd: ['x'] }, new AbortController().signal)) void frame;
    }],
  ];

  describe.each(CALLS)('%s', (_label, call) => {
    it.each(['unusable', 'lost', 'messageOnly', 'oldBuild'] as const)('throws a lost box for %s', async (kind) => {
      answer = ANSWERS[kind];
      const err = await call(client()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetHibernationLostError);
      expect(err).toBeInstanceOf(FleetRunNotFoundError);
      expect(isHibernationLost(err)).toBe(true);
    });

    it('keeps the code on a failed fetch, as a capacity error', async () => {
      answer = ANSWERS.fetchFailed;
      const err = await call(client()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetCapacityError);
      expect((err as FleetCapacityError).code).toBe('hibernation_fetch_failed');
      expect(isHibernationFetchFailed(err)).toBe(true);
    });

    it('passes an unrelated refusal through', async () => {
      answer = ANSWERS.unrelated;
      const err = await call(client()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetHttpError);
      expect((err as FleetHttpError).code).toBe('guest_too_old');
    });
  });

  it('does not send a quiet exec again for a lost copy', async () => {
    answer = ANSWERS.unusable;
    await client().quietExec('sb', { cmd: ['x'] }).catch(() => undefined);
    expect(paths).toHaveLength(1);
  });
});

describe('the words a person sees', () => {
  it.each([
    ['409 hibernation_unusable', new FleetHibernationLostError(RAW)],
    ['hibernation_lost', lostSandboxError(409, 'gone', 'hibernation_lost')!],
    ['the message only', lostSandboxError(500, RAW)!],
  ])('a lost copy (%s) reads as a lost box', (_label, err) => {
    expect(userFacingError(err)).toBe(SANDBOX_LOST_MESSAGE);
    expect(fleetErrorAsRefusal(err)).toMatchObject({ status: 409, code: 'sandbox_gone', message: SANDBOX_LOST_MESSAGE });
  });

  it.each([
    ['a capacity error', new FleetCapacityError(RAW, undefined, 'no_capacity', 'hibernation_fetch_failed')],
    ['a plain refusal', new FleetHttpError(RAW, 503, 'hibernation_fetch_failed')],
  ])('a failed fetch (%s) says Talyn will try again', (_label, err) => {
    expect(userFacingError(err)).toBe(SANDBOX_WAKING_MESSAGE);
    expect(fleetErrorAsRefusal(err)).toMatchObject({ status: 503, code: 'sandbox_waking', message: SANDBOX_WAKING_MESSAGE });
  });

  it.each([
    new FleetHibernationLostError(RAW),
    new FleetCapacityError(RAW, undefined, 'no_capacity', 'hibernation_fetch_failed'),
  ])('never shows the raw fleet text', (err) => {
    expect(userFacingError(err)).not.toContain('hibernated copy');
    expect(fleetErrorAsRefusal(err)?.message).not.toContain('hibernated copy');
  });

  it.each([
    [new FleetHttpError('too old', 409, 'guest_too_old'), 'Talyn Fleet refused the request: too old'],
    [new FleetCapacityError('full'), 'The sandbox runners are all busy. Try again shortly.'],
    [new FleetRunNotFoundError('gone'), SANDBOX_LOST_MESSAGE],
  ])('keeps the old words for %s', (err, words) => {
    expect(userFacingError(err)).toBe(words);
  });

  it('keeps an unrelated refusal a fleet_unavailable 503', () => {
    expect(fleetErrorAsRefusal(new FleetHttpError('too old', 409, 'guest_too_old'))).toMatchObject({ status: 503, code: 'fleet_unavailable' });
  });
});
