/** @jest-environment node */
import { execFile, spawn } from 'child_process';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { CoderCli, classifyCoderFailure, coderSearchDirs, parseAppUrls, parseWorkspaces, remotePath, shellQuote, workspaceName } from '../main/workbench/coder';
import { locate, mergePath } from '../main/workbench/environment';
import { pickWorkspace } from '../main/workbench/coderPreview';

const BINARY = '/opt/homebrew/bin/coder';
type Response = { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };

function fakeCli(responses: Response[], find: () => Promise<string | null> = async () => BINARY) {
  const input = new PassThrough();
  const writes: string[] = [];
  input.on('data', (chunk) => writes.push(String(chunk)));
  const execute = jest.fn((_file, _args, _options, callback) => {
    const response = responses.shift() ?? {};
    const failed = response.code || response.killed;
    const error = failed ? Object.assign(new Error('failed'), { code: response.killed ? null : response.code, killed: response.killed, signal: response.killed ? 'SIGTERM' : null }) : null;
    queueMicrotask(() => callback(error, response.stdout ?? '', response.stderr ?? ''));
    return { stdin: input };
  });
  const cli = new CoderCli(execute as unknown as typeof execFile, spawn, async () => '/login/bin', async () => undefined, find);
  return { cli, execute, writes };
}

it.each([
  ['https://coder.example', true, undefined],
  ['https://coder.example/path', true, undefined],
  ['https://other.example', false, 'wrong_deployment'],
  ['http://coder.example', false, 'wrong_deployment'],
])('compares deployment origins: %s', async (url, loggedIn, problem) => {
  const { cli, execute } = fakeCli([{ stdout: JSON.stringify([{ url: 'https://coder.example/', username: 'tom' }]) }]);
  expect(await cli.status(url)).toEqual({ installed: true, loggedIn, url: 'https://coder.example/', user: 'tom', binary: BINARY, ...(problem ? { problem } : {}) });
  expect(execute).toHaveBeenCalledWith(BINARY, ['whoami', '--output', 'json'], expect.objectContaining({ env: expect.objectContaining({ PATH: '/login/bin' }), timeout: 30000 }), expect.any(Function));
});

it('reports a CLI that is not on any searched path without running it', async () => {
  const { cli, execute } = fakeCli([], async () => null);
  expect(await cli.status()).toEqual({ installed: false, loggedIn: false, problem: 'not_installed' });
  expect(execute).not.toHaveBeenCalled();
});
it('reports a CLI that disappeared before it ran (ENOENT)', async () => {
  expect(await fakeCli([{ code: 'ENOENT' }]).cli.status()).toMatchObject({ installed: false, loggedIn: false, problem: 'not_installed', detail: expect.stringContaining(BINARY) });
});
it.each([
  ['You are not logged in. Try logging in using \'coder login <url>\'.', 'not_logged_in'],
  ['error: Try logging in: GET https://coder.example/api/v2/users/me: unexpected status code 401: Unauthorized', 'not_logged_in'],
  ['Your session has expired', 'not_logged_in'],
  ['something unexpected', 'not_logged_in'],
  ['Get "https://coder.example/api/v2/users/me": dial tcp: lookup coder.example: no such host', 'unreachable'],
  ['Get "https://coder.example/api/v2/users/me": dial tcp 100.64.0.1:443: i/o timeout', 'unreachable'],
  ['context deadline exceeded (Client.Timeout exceeded while awaiting headers)', 'unreachable'],
])('classifies the whoami failure %j as %s', async (stderr, problem) => {
  expect(await fakeCli([{ code: 1, stderr }]).cli.status('https://coder.example')).toEqual({ installed: true, loggedIn: false, binary: BINARY, problem, detail: stderr });
});
it.each([
  ['dial tcp: connection refused', 'unreachable'],
  ['coder list did not finish in 60 seconds.', 'unreachable'],
  ['401 Unauthorized', 'not_logged_in'],
  ['template has no parameters', 'error'],
])('classifies %j as %s', (output, kind) => {
  expect(classifyCoderFailure(output)).toBe(kind);
});
it('reports a whoami that never answers as unreachable', async () => {
  expect(await fakeCli([{ killed: true, stderr: 'still waiting' }]).cli.status('https://coder.example')).toMatchObject({
    installed: true, loggedIn: false, problem: 'unreachable', detail: expect.stringContaining('coder whoami --output did not finish in 30 seconds.'),
  });
});
it('falls back to the text output of older clients', async () => {
  const { cli, execute } = fakeCli([{ code: 1, stderr: 'unknown flag: --output' }, { stdout: "Coder is running at https://coder.example, You're authenticated as tom !" }]);
  expect(await cli.status('https://coder.example')).toMatchObject({ installed: true, loggedIn: true, user: 'tom' });
  expect(execute.mock.calls[1][1]).toEqual(['whoami']);
});
it('does not treat a connection failure as a missing CLI', async () => {
  expect(await fakeCli([{ code: 'ETIMEDOUT' }]).cli.status()).toMatchObject({ installed: true, loggedIn: false, problem: 'unreachable' });
});
it('reports whoami output it cannot read', async () => {
  expect(await fakeCli([{ stdout: 'not json' }]).cli.status()).toMatchObject({ installed: true, loggedIn: false, problem: 'error', detail: expect.stringContaining('not json') });
});
it('keeps the stderr of a failed coder list', async () => {
  await expect(fakeCli([{ code: 1, stderr: 'dial tcp: no such host' }]).cli.workspaces()).rejects.toThrow('dial tcp: no such host');
});
it('names the command that timed out', async () => {
  await expect(fakeCli([{ killed: true }]).cli.exec('dev', 'true', { timeout: 5000 })).rejects.toThrow('coder ssh dev did not finish in 5 seconds.');
});
it('does not hide a CLI that cannot answer behind the port-forward fallback', async () => {
  await expect(fakeCli([{ killed: true }]).cli.appUrls('dev')).rejects.toThrow('did not finish');
});

const posix = process.platform === 'win32' ? it.skip : it;
describe('finding the CLI outside the GUI PATH', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'coder-home-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const install = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'coder'), '#!/bin/sh\n', { mode: 0o755 });
    return path.join(dir, 'coder');
  };

  posix('finds Homebrew\'s coder when the inherited PATH has only /usr/bin', async () => {
    const brew = install(path.join(home, 'opt/homebrew/bin'));
    // The same shape as mergePath: the GUI PATH, then the fixed folders it appends.
    const searchPath = mergePath('', '/usr/bin:/bin', home, 'darwin').replace('/opt/homebrew/bin', path.join(home, 'opt/homebrew/bin'));
    expect(await locate('coder', coderSearchDirs(home, 'darwin'), searchPath)).toBe(brew);
  });
  posix('prefers hogli\'s managed coder in ~/.hogli/bin', async () => {
    install(path.join(home, 'opt/homebrew/bin'));
    const hogli = install(path.join(home, '.hogli/bin'));
    expect(await locate('coder', coderSearchDirs(home, 'darwin'), path.join(home, 'opt/homebrew/bin'))).toBe(hogli);
  });
  posix('finds ~/.local/bin/coder', async () => {
    const local = install(path.join(home, '.local/bin'));
    expect(await locate('coder', coderSearchDirs(home, 'darwin'), mergePath('', '/usr/bin', home, 'darwin'))).toBe(local);
  });
  posix('answers null when no folder has the CLI', async () => {
    expect(await locate('coder', coderSearchDirs(home, 'darwin'), path.join(home, 'empty'))).toBeNull();
  });
  it('searches no hogli folder on Windows', () => {
    expect(coderSearchDirs('C:\\Users\\tom', 'win32')).toEqual([]);
  });
});
it('parses SDK workspace output', () => {
  expect(parseWorkspaces(JSON.stringify([{ name: 'dev-tom', owner_name: 'tom', template_name: 'linux', latest_build: { status: 'running' } }]))).toEqual([{ name: 'dev-tom', owner: 'tom', template: 'linux', status: 'running' }]);
});
it('passes one quoted script argument and sends stdin separately', async () => {
  const { cli, execute, writes } = fakeCli([{ stdout: 'done' }]);
  const script = `cd ${remotePath('~/repo with spaces')} && printf '%s' "a'b"`;
  expect(await cli.exec('dev-tom', script, { input: 'binary patch\n' })).toEqual({ code: 0, stdout: 'done', stderr: '' });
  expect(execute.mock.calls[0][1]).toEqual(['ssh', 'dev-tom', '--', 'bash', '-lc', shellQuote(script)]);
  expect(writes).toEqual(['binary patch\n']);
});
it('preserves quotes through the Coder SSH argument join', () => {
  const value = "one ' two; $(nope)\nthree";
  const result = require('child_process').execFileSync('bash', ['-c', `bash -lc ${shellQuote(`printf '%s' ${shellQuote(value)}`)}`], { encoding: 'utf8' });
  expect(result).toBe(value);
});
it.each(['x/y', '-flag', '..', 'x;date', 'x\ny', '$(date)', ''])('rejects workspace %j', (value) => {
  expect(() => workspaceName(value)).toThrow();
});
it.each(["~/a'b", '~/a"b', '~/a\nb', '~/../repo', 'relative', '~other/repo'])('rejects path %j', (value) => {
  expect(() => remotePath(value)).toThrow();
});
it('quotes path metacharacters without expansion', () => {
  expect(remotePath('~/a $(date); b')).toBe('"$HOME"/\'a $(date); b\'');
});
const workspace = (name: string, template = 'linux', status = 'running') => ({ name, owner: 'tom', template, status });
it.each([
  [[workspace('a'), workspace('b')], { workspace: 'b' }, 'b'],
  [[workspace('a', 'mac'), workspace('b')], { template: 'linux' }, 'b'],
  [[workspace('a', 'linux', 'stopped'), workspace('b', 'mac')], { template: 'linux' }, 'a'],
  [[workspace('a')], {}, 'a'],
  [[workspace('a')], { template: 'other' }, 'a'],
])('picks a workspace from %j with %j', (items, choice, expected) => {
  expect(pickWorkspace(items, choice).name).toBe(expected);
});
it.each([
  [[workspace('a'), workspace('b')], {}],
  [[workspace('a'), workspace('b')], { template: 'linux' }],
  [[workspace('a')], { workspace: 'missing' }],
])('requires a selection for %j with %j', (items, choice) => {
  expect(() => pickWorkspace(items, choice)).toThrow('Select a workspace in Settings');
});
it.each([
  [[], {}, false, ['coder create'], 'You have no Coder workspace.'],
  [[workspace('a', 'mac'), workspace('b', 'mac')], { template: 'linux' }, false, ['coder create --template linux'], 'from the template linux'],
  [[], { template: 'posthog linux' }, false, ["coder create --template 'posthog linux'"], 'from the template posthog linux'],
  [[], { template: 'linux' }, true, ['hogli devbox:start', 'coder create --template linux'], 'from the template linux'],
])('explains how to create a missing workspace: %j %j hogli=%s', (items, choice, hogli, commands, text) => {
  let problem: unknown;
  try { pickWorkspace(items, choice, hogli); } catch (error) { problem = (error as { problem: unknown }).problem; }
  expect(problem).toMatchObject({ step: 'workspace', code: 'no_workspace', message: expect.stringContaining(text), note: expect.stringContaining('Talyn does not create workspaces') });
  expect((problem as { commands: { command: string }[] }).commands.map((item) => item.command)).toEqual(commands);
});
it('starts a workspace and polls until it runs', async () => {
  const rows = (status: string) => JSON.stringify([workspace('dev', 'linux', status)]);
  const { cli, execute } = fakeCli([{}, { stdout: rows('starting') }, { stdout: rows('running') }]);
  await cli.start('dev');
  expect(execute.mock.calls.map((call) => call[1])).toEqual([['start', '--yes', 'dev'], ['list', '--output', 'json'], ['list', '--output', 'json']]);
});
it('only returns usable subdomain apps', () => {
  expect(parseAppUrls(JSON.stringify({ resources: [{ agents: [{ apps: [
    { slug: 'app', subdomain: true, external_url: 'https://app.example', url: 'http://localhost:8010' },
    { slug: 'internal', subdomain: true, url: 'http://localhost:3000' },
    { slug: 'path', subdomain: false, url: 'https://coder.example/path' },
  ] }] }] }))).toEqual([{ slug: 'app', url: 'https://app.example/', port: 8010 }]);
});
it('falls back when coder show has no JSON mode', async () => {
  expect(await fakeCli([{ code: 1, stderr: 'unknown flag' }]).cli.appUrls('dev')).toEqual([]);
});


function fakeForward(portBusy = false) {
  const server = Object.assign(new EventEmitter(), {
    listen: jest.fn((_port, _host, callback) => {
      queueMicrotask(() => portBusy ? server.emit('error', new Error('EADDRINUSE')) : callback());
    }),
    close: jest.fn((callback) => callback()),
  });
  jest.spyOn(net, 'createServer').mockReturnValue(server as unknown as net.Server);
  const socket = Object.assign(new EventEmitter(), { setTimeout: jest.fn(), destroy: jest.fn() });
  jest.spyOn(net, 'connect').mockImplementation(() => {
    queueMicrotask(() => socket.emit('connect'));
    return socket as unknown as net.Socket;
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: jest.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; }),
  });
  const launch = jest.fn(() => {
    queueMicrotask(() => child.stderr.write('Forwarding TCP port'));
    return child;
  });
  const cli = new CoderCli(execFile, launch as unknown as typeof spawn, async () => '/login/bin', undefined, async () => BINARY);
  return { cli, child, launch, socket };
}

afterEach(() => jest.restoreAllMocks());

it('keeps a port forward until stopped and waits for its listener', async () => {
  const { cli, child, launch, socket } = fakeForward();
  try {
    expect(await cli.portForward('dev', 8010)).toBe('http://localhost:8010');
    expect(socket.destroy).toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith(BINARY, ['port-forward', 'dev', '--tcp', '8010:8010'], expect.objectContaining({ env: expect.objectContaining({ PATH: '/login/bin' }) }));
    expect(child.kill).not.toHaveBeenCalled();
    expect(await cli.portForward('dev', 8010)).toBe('http://localhost:8010');
    expect(launch).toHaveBeenCalledTimes(1);
  } finally { cli.stopForwards('dev'); }
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('does not open another process on an occupied local port', async () => {
  const { cli, launch } = fakeForward(true);
  await expect(cli.portForward('dev', 8010)).rejects.toThrow('is in use');
  expect(launch).not.toHaveBeenCalled();
});

it('rejects a forward that exits before it binds', async () => {
  const { cli, child, launch } = fakeForward();
  launch.mockImplementation(() => {
    queueMicrotask(() => {
      child.stderr.write('Forwarding TCP port');
      child.emit('close', 1);
    });
    return child;
  });
  await expect(cli.portForward('dev', 8010)).rejects.toThrow('coder port-forward dev --tcp 8010:8010');
});
