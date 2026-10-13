import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FleetClient,
  FleetHttpError,
  FleetRunNotFoundError,
  resetFleetOptionalSupport,
} from '../services/selfHosted/client.js';

/**
 * The workbench additions to the fleet client: bare creates, exec in its three
 * modes, and the probes that learn once whether a newer route exists.
 */

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fleet client: workbench methods', () => {
  let calls: Call[];
  let respond: (call: Call) => Response;
  const client = new FleetClient('https://fleet.test', 'tok');

  beforeEach(() => {
    calls = [];
    resetFleetOptionalSupport();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const call = {
        method: init.method ?? 'GET',
        path: url.replace('https://fleet.test', ''),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return respond(call);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends a bare create with no task and no ephemeral flag', async () => {
    respond = () => json({ id: 'talyn-wb-1', status: 'idle' });
    await client.createSandbox({ id: 'talyn-wb-1', workspaceId: 'ws', provider: 'openai', openaiKey: 'k' });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/sandboxes',
      body: { id: 'talyn-wb-1', workspaceId: 'ws', provider: 'openai', openaiKey: 'k' },
    });
  });

  it('runs a wait-mode exec and returns its frame', async () => {
    const frame = { events: [{ seq: 4, at: '', event: { type: 'exec_exit', raw: { exitCode: 0 } } }], cursor: 4, terminal: true };
    respond = () => json(frame);
    expect(await client.exec('sb 1', { cmd: ['true'], cwd: '/work' })).toEqual(frame);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/sandboxes/sb%201/exec', body: { cmd: ['true'], cwd: '/work' } });
  });

  it('follows an exec over SSE across chunk boundaries and stops at the terminal frame', async () => {
    const frames = [
      { events: [{ seq: 1, at: '', event: { type: 'exec_output', raw: { data: 'a' } } }], cursor: 1, terminal: false },
      { events: [], cursor: 1, terminal: true },
      { events: [], cursor: 9, terminal: false },
    ];
    const text = `: ping\n\n${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}`;
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const seen = [];
    for await (const f of client.execFollow('sb', { cmd: ['x'] }, new AbortController().signal)) seen.push(f);
    expect(seen).toEqual(frames.slice(0, 2));
    expect(calls[0].path).toBe('/v1/sandboxes/sb/exec?follow=1');
  });

  it.each([
    [404, { error: 'not_found', message: 'no such sandbox' }, FleetRunNotFoundError],
    [409, { error: 'sandbox_not_live', message: 'not running' }, FleetHttpError],
  ])('throws on a follow answered %i', async (status, body, type) => {
    respond = () => json(body, status);
    await expect(client.execFollow('sb', { cmd: ['x'] }, new AbortController().signal).next()).rejects.toBeInstanceOf(type);
  });

  describe('quiet exec', () => {
    it('uses the quiet answer when the fleet has one', async () => {
      respond = () => json({ stdout: 'out', stderr: '', exit: { exitCode: 2 }, truncated: false });
      expect(await client.quietExec('sb', { cmd: ['x'] })).toEqual({
        kind: 'quiet',
        result: { stdout: 'out', stderr: '', exitCode: 2 },
      });
      expect(calls[0].path).toBe('/v1/sandboxes/sb/exec?quiet=1');
      // The option is a query parameter, never a body field.
      expect(calls[0].body).toEqual({ cmd: ['x'] });
    });

    it('learns from an events answer that the fleet ignored the option, and stops asking', async () => {
      const frame = { events: [], cursor: 3, terminal: true };
      respond = () => json(frame);
      expect(await client.quietExec('sb', { cmd: ['x'] })).toEqual({ kind: 'events', frame });
      expect(await client.quietExec('sb', { cmd: ['y'] })).toEqual({ kind: 'events', frame });
      expect(calls.map((c) => c.path)).toEqual(['/v1/sandboxes/sb/exec?quiet=1', '/v1/sandboxes/sb/exec']);
    });

    it.each([400, 404])('falls back to a plain exec on %i, and remembers when that works', async (status) => {
      const frame = { events: [], cursor: 1, terminal: true };
      respond = (call) => (call.path.includes('quiet') ? json({ error: 'bad_request', message: 'unknown option' }, status) : json(frame));
      expect(await client.quietExec('sb', { cmd: ['x'] })).toEqual({ kind: 'events', frame });
      await client.quietExec('sb', { cmd: ['x'] });
      expect(calls.map((c) => c.path)).toEqual([
        '/v1/sandboxes/sb/exec?quiet=1',
        '/v1/sandboxes/sb/exec',
        '/v1/sandboxes/sb/exec',
      ]);
    });

    it('reports a sandbox that is really gone, and does not blame the option', async () => {
      respond = () => json({ error: 'not_found', message: 'no such sandbox' }, 404);
      await expect(client.quietExec('sb', { cmd: ['x'] })).rejects.toBeInstanceOf(FleetRunNotFoundError);
      respond = () => json({ stdout: '', stderr: '', exit: { exitCode: 0 } });
      expect((await client.quietExec('sb', { cmd: ['x'] })).kind).toBe('quiet');
    });

    it.each([500, 502])('does not fall back on %i', async (status) => {
      respond = () => json({ error: 'exec_failed', message: 'boom' }, status);
      await expect(client.quietExec('sb', { cmd: ['x'] })).rejects.toThrow('boom');
      expect(calls).toHaveLength(1);
    });
  });

  describe('optional routes', () => {
    it('reads a diff with its query, and remembers the route exists', async () => {
      const diff = { base: 'origin/main', mergeBase: 'a', headSha: 'b', files: [], truncated: false };
      respond = () => json(diff);
      expect(await client.getDiff('sb', { base: 'origin/main', path: 'a b.ts', patch: true, cwd: '/work/app' })).toEqual({
        supported: true,
        data: diff,
      });
      expect(calls[0].path).toBe('/v1/sandboxes/sb/diff?base=origin%2Fmain&path=a+b.ts&patch=1&cwd=%2Fwork%2Fapp');
    });

    it.each([
      ['a plain-text 404 from the mux', () => new Response('404 page not found', { status: 404 })],
      ['a 405', () => new Response('', { status: 405 })],
      ['a 501', () => new Response('', { status: 501 })],
    ])('reads %s as "no such route", once', async (_name, answer) => {
      respond = answer;
      expect(await client.listFiles('sb', { cwd: '/work/app' })).toEqual({ supported: false });
      expect(await client.listFiles('sb')).toEqual({ supported: false });
      expect(calls).toHaveLength(1);
      // One feature being absent says nothing about another.
      respond = () => json({ path: 'a', size: 1, binary: false, encoding: 'utf8', content: 'x' });
      expect((await client.readFile('sb', 'a')).supported).toBe(true);
    });

    it.each([
      [404, { error: 'not_found', message: 'no such sandbox' }, FleetRunNotFoundError, undefined],
      [409, { error: 'not_a_repository', message: 'not a git repository' }, FleetHttpError, 'not_a_repository'],
      [400, { error: 'bad_ref', message: 'unknown ref' }, FleetHttpError, 'bad_ref'],
    ])('keeps a real %i as an error, with the fleet code', async (status, body, type, code) => {
      respond = () => json(body, status);
      const err = await client.getDiff('sb', { base: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(type);
      if (code) expect((err as FleetHttpError).code).toBe(code);
      // Not learned as "unsupported": the next call asks again.
      respond = () => json({ base: 'x', mergeBase: 'a', headSha: 'b', files: [] });
      expect((await client.getDiff('sb', { base: 'x' })).supported).toBe(true);
    });
  });

  it('replaces the ssh key set and treats a deleted sandbox as deleted', async () => {
    respond = (call) =>
      call.method === 'DELETE' ? json({ error: 'not_found', message: 'no such sandbox' }, 404) : json({ user: 'sandbox', hostPublicKey: 'ssh-ed25519 AAAA' });
    expect(await client.setSshKeys('sb', ['ssh-ed25519 KEY'])).toMatchObject({ user: 'sandbox' });
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/sandboxes/sb/ssh', body: { publicKeys: ['ssh-ed25519 KEY'] } });
    await expect(client.deleteSandbox('sb')).resolves.toBeUndefined();
  });

  it.each([
    ['suspendSandbox', '/v1/sandboxes/sb/suspend'],
    ['resumeSandbox', '/v1/sandboxes/sb/resume'],
  ] as const)('%s posts to %s', async (method, path) => {
    respond = () => json({ id: 'sb', status: 'suspended' });
    await client[method]('sb');
    expect(calls[0]).toMatchObject({ method: 'POST', path });
  });

  it('proxies a preview port with the fleet token, never the caller\'s headers', async () => {
    respond = () => new Response('<html>', { status: 404 });
    const resp = await client.proxyPort('sb', 3000, '/a/b?x=1', { method: 'GET', headers: { accept: 'text/html' } });
    expect(resp.status).toBe(404);
    expect(calls[0].path).toBe('/v1/sandboxes/sb/ports/3000/a/b?x=1');
  });
});
