import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetCapacityError, FleetClient, FleetHttpError } from '../services/selfHosted/client.js';
import { userFacingError } from '../services/workbenches/errors.js';

const answer = (body: string, status: number, type = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': type } });

describe('fleet client: a 502 from the edge or the gateway', () => {
  let reply: () => Response;

  beforeEach(() => {
    vi.stubGlobal('fetch', async () => reply());
  });

  afterEach(() => vi.unstubAllGlobals());

  const client = () => new FleetClient('https://fleet.test', 'tok');

  it('reads Railway\'s "Application failed to respond" as an unreachable fleet', async () => {
    reply = () => answer('<html><body>Application failed to respond</body></html>', 502);
    const err = await client().getSandbox('sb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetCapacityError);
    expect((err as FleetCapacityError).reason).toBe('unreachable');
    expect(userFacingError(err)).toBe('The sandbox runners are not reachable right now. Try again shortly.');
  });

  it('reads a JSON 502 from the gateway the same way', async () => {
    reply = () => answer(JSON.stringify({ error: 'host_unreachable', message: 'no answer from host' }), 502, 'application/json');
    const err = await client().getSandbox('sb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetCapacityError);
    expect((err as FleetCapacityError).reason).toBe('unreachable');
  });

  it('keeps other 5xx answers as a refusal', async () => {
    reply = () => answer(JSON.stringify({ error: 'create_failed', message: 'bad body' }), 500, 'application/json');
    const err = await client().getSandbox('sb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetHttpError);
    expect(err).not.toBeInstanceOf(FleetCapacityError);
  });
});
