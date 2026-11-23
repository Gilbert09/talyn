import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetClient, FleetHttpError, resetFleetOptionalSupport } from '../services/selfHosted/client.js';
import {
  fleetClientFor,
  resumeOnce,
  setResumeCredentialsTimeoutForTests,
  setWorkbenchFleetClientForTests,
  wakeWithCredentials,
} from '../services/workbenches/sandboxRuntime.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';

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

/**
 * A resume carries the box's credentials, so the fleet boots with them and
 * skips its own fetch (3.6-4.3 s of a 5.4 s local wake, 2026-11-04). When they
 * cannot be had in time, the resume goes without and the fleet fetches, as it
 * did before. A fleet that predates the field ignores it.
 */
describe('workbench resume: credentials in the request', () => {
  let resumeBodies: unknown[];
  const creds = { githubToken: 'ghp_x', anthropicKey: 'sk-ant-x', repo: 'acme/app' };

  beforeEach(() => {
    resumeBodies = [];
    resetFleetOptionalSupport();
    setResumeCredentialsTimeoutForTests(50);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/resume')) resumeBodies.push(JSON.parse(String(init.body)));
      return json({ id: 'sb', status: 'idle' });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setResumeCredentialsTimeoutForTests(null);
  });

  const client = () => new FleetClient('https://fleet.test', 'tok');

  it.each([
    ['resolved', async () => creds, { idleTtlSec: 180, credentials: creds }],
    ['none for this box', async () => null, { idleTtlSec: 180 }],
    ['a failed lookup', async () => Promise.reject(new Error('custody down')), { idleTtlSec: 180 }],
    ['a lookup slower than the fleet fetch it replaces', () => new Promise<null>(() => undefined), { idleTtlSec: 180 }],
  ] as const)('%s', async (_name, source, body) => {
    await resumeOnce(client(), 'sb', 'host', source as () => Promise<typeof creds | null>);
    expect(resumeBodies).toEqual([body]);
  });

  it('looks up the owning session by default and goes without when it cannot', async () => {
    // No database in this suite: the lookup fails, and the resume still goes.
    await resumeOnce(client(), 'sb', 'storage');
    expect(resumeBodies).toEqual([{ idleTtlSec: 180 }]);
  });

  it('asks for the credentials once for a burst of callers', async () => {
    let asked = 0;
    const source = async () => {
      asked++;
      return creds;
    };
    const c = client();
    await Promise.all([0, 1, 2].map(() => resumeOnce(c, 'sb', 'host', source)));
    expect(asked).toBe(1);
    expect(resumeBodies).toHaveLength(1);
  });
});

describe('workbench turn start: waking a sleeping box with its credentials', () => {
  const row = {
    id: 'wb-1',
    workspaceId: 'ws',
    sandboxId: 'sb',
    fleetHost: null,
    runtime: 'sandbox',
    status: 'ready',
  } as unknown as WorkbenchRow;
  let resumes: number;
  let sandbox: Record<string, unknown> | Error;

  beforeEach(() => {
    resumes = 0;
    resetFleetOptionalSupport();
    setResumeCredentialsTimeoutForTests(50);
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    vi.stubGlobal('fetch', async (url: string) => {
      const path = String(url).replace('https://fleet.test', '');
      if (path.endsWith('/resume')) {
        resumes++;
        return json({ id: 'sb', status: 'idle' });
      }
      if (sandbox instanceof Error) return json({ error: 'internal', message: sandbox.message }, 500);
      return json({ sandbox });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkbenchFleetClientForTests(null);
    setResumeCredentialsTimeoutForTests(null);
  });

  it.each([
    ['asleep on its host', { id: 'sb', status: 'suspended', suspendDir: '/var/lib/fleet/suspended/sb' }, 1],
    ['asleep on its host, also in the bucket', { id: 'sb', status: 'suspended', suspendDir: '/d', suspendUploaded: true }, 1],
    ['only in the bucket (left to withWake)', { id: 'sb', status: 'suspended', suspendUploaded: true }, 0],
    ['awake', { id: 'sb', status: 'idle' }, 0],
  ] as const)('a box %s is resumed %i time(s)', async (_name, box, want) => {
    sandbox = box;
    await wakeWithCredentials(row);
    expect(resumes).toBe(want);
  });

  it('never throws: the exec after it wakes the box the old way', async () => {
    sandbox = new Error('the fleet is down');
    await expect(wakeWithCredentials(row)).resolves.toBeUndefined();
    expect(resumes).toBe(0);
  });
});
