import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FleetCapacityError,
  FleetClient,
  FleetDispatchUncertainError,
  HOST_SILENT,
  HOST_UNRESPONSIVE,
} from '../services/selfHosted/client.js';
import { isFleetTimeout, isHostSilentAnswer, isWakeRefusal } from '../services/workbenches/errors.js';

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('fleet client: a host that does not answer', () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = (timeoutMs?: number) => new FleetClient('https://fleet.test', 'tok', timeoutMs ? { timeoutMs } : {});
  const fails = (reply: () => Response | Promise<Response>, timeoutMs?: number) => {
    vi.stubGlobal('fetch', async () => reply());
    return client(timeoutMs).getSandbox('sb').catch((e: unknown) => e);
  };

  it('reads a 503 host_unresponsive as a refusal that waits, with its code and Retry-After', async () => {
    const err = await fails(() => json({ error: HOST_UNRESPONSIVE, message: 'host coder-1 does not answer' }, 503, { 'Retry-After': '15' }));
    expect(err).toBeInstanceOf(FleetCapacityError);
    expect(err).toMatchObject({ code: HOST_UNRESPONSIVE, retryAfterMs: 15_000, timedOut: false });
    expect(isWakeRefusal(err)).toBe(true);
    expect(isHostSilentAnswer(err)).toBe(true);
  });

  it('keeps the code of a 504 host_silent', async () => {
    const err = await fails(() => json({ error: HOST_SILENT, message: 'the host never answered' }, 504));
    expect(err).toBeInstanceOf(FleetDispatchUncertainError);
    expect(err).toMatchObject({ code: HOST_SILENT, message: 'the host never answered' });
    expect(isHostSilentAnswer(err)).toBe(true);
  });

  it.each([
    ['a 504 with no code', () => new Response('', { status: 504 })],
    ['a 504 dispatch_uncertain', () => json({ error: 'dispatch_uncertain' }, 504)],
    ['a 503 with no room', () => json({ error: 'no_capacity' }, 503)],
    ['a 503 host_unreachable (dial error)', () => json({ error: 'host_unreachable' }, 503)],
  ])('does not read %s as a silent host', async (_name, reply) => {
    const err = await fails(reply);
    expect(isHostSilentAnswer(err)).toBe(false);
    expect(isFleetTimeout(err)).toBe(false);
  });

  it('marks a request that ran out of time', async () => {
    // The fake fetch never answers; the client's own timeout ends it.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const timedOut = await client(20).getSandbox('sb').catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(FleetCapacityError);
    expect(timedOut).toMatchObject({ reason: 'unreachable', timedOut: true });
    expect(isFleetTimeout(timedOut)).toBe(true);
    expect(isHostSilentAnswer(timedOut)).toBe(false);
  });

  it('does not mark a refused connection as a timeout', async () => {
    const err = await fails(() => Promise.reject(new TypeError('fetch failed')));
    expect(err).toMatchObject({ reason: 'unreachable', timedOut: false });
    expect(isFleetTimeout(err)).toBe(false);
  });
});
