import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetClient, FleetHttpError, resetFleetOptionalSupport } from '../services/selfHosted/client.js';
import { fleetClientFor, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';

/**
 * A hibernated sandbox: the fleet refuses every call with 409
 * `remote_resume_required` until somebody posts /resume. The workbench client
 * resumes once and sends the call again.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = () =>
  json({ error: 'remote_resume_required', message: "this sandbox's only copy is in object storage" }, 409);

describe('workbench fleet client: waking a hibernated sandbox', () => {
  let paths: string[];
  let hibernated: boolean;

  beforeEach(() => {
    paths = [];
    hibernated = true;
    resetFleetOptionalSupport();
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    vi.stubGlobal('fetch', async (url: string) => {
      const path = url.replace('https://fleet.test', '');
      paths.push(path);
      if (path.endsWith('/resume')) {
        await new Promise((r) => setTimeout(r, 5));
        hibernated = false;
        return json({ id: 'sb', status: 'running' });
      }
      if (hibernated) return refusal();
      if (path.includes('follow=1')) {
        return new Response(`data: ${JSON.stringify({ events: [], cursor: 1, terminal: true })}\n\n`, { status: 200 });
      }
      return json({ events: [], cursor: 1, terminal: true });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkbenchFleetClientForTests(null);
  });

  it('keeps the fleet code on a refusal', async () => {
    const err = await new FleetClient('https://fleet.test', 'tok').exec('sb', { cmd: ['x'] }).catch((e) => e);
    expect(err).toBeInstanceOf(FleetHttpError);
    expect((err as FleetHttpError).code).toBe('remote_resume_required');
  });

  it('resumes and sends the call again', async () => {
    const client = await fleetClientFor('ws');
    expect(await client.exec('sb', { cmd: ['x'] })).toEqual({ events: [], cursor: 1, terminal: true });
    expect(paths).toEqual(['/v1/sandboxes/sb/exec', '/v1/sandboxes/sb/resume', '/v1/sandboxes/sb/exec']);
  });

  it('sends one resume for a burst of calls', async () => {
    const client = await fleetClientFor('ws');
    await Promise.all([0, 1, 2].map(() => client.exec('sb', { cmd: ['x'] })));
    expect(paths.filter((p) => p.endsWith('/resume'))).toHaveLength(1);
  });

  it('resumes a follow that was refused before its first frame', async () => {
    const client = await fleetClientFor('ws');
    const frames = [];
    for await (const f of client.execFollow('sb', { cmd: ['x'] }, new AbortController().signal)) frames.push(f);
    expect(frames).toEqual([{ events: [], cursor: 1, terminal: true }]);
    expect(paths.filter((p) => p.endsWith('/resume'))).toHaveLength(1);
  });

  it('does not resume for a box being deleted', async () => {
    const client = await fleetClientFor('ws');
    await expect(client.deleteSandbox('sb')).rejects.toBeInstanceOf(FleetHttpError);
    expect(paths).toEqual(['/v1/sandboxes/sb']);
  });

  it('passes any other refusal through', async () => {
    hibernated = false;
    vi.stubGlobal('fetch', async () => json({ error: 'guest_too_old', message: 'too old' }, 409));
    const client = await fleetClientFor('ws');
    const err = await client.exec('sb', { cmd: ['x'] }).catch((e) => e);
    expect((err as FleetHttpError).code).toBe('guest_too_old');
  });
});
