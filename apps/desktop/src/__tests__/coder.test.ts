/** @jest-environment node */
import { execFile, spawn } from 'child_process';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import net from 'net';
import { CoderCli, parseAppUrls, parseWorkspaces, remotePath, shellQuote, workspaceName } from '../main/workbench/coder';
import { pickWorkspace } from '../main/workbench/coderPreview';

function fakeCli(responses: Array<{ stdout?: string; stderr?: string; code?: number | string }>) {
  const input = new PassThrough();
  const writes: string[] = [];
  input.on('data', (chunk) => writes.push(String(chunk)));
  const execute = jest.fn((_file, _args, _options, callback) => {
    const response = responses.shift() ?? {};
    queueMicrotask(() => callback(response.code ? Object.assign(new Error('failed'), { code: response.code }) : null, response.stdout ?? '', response.stderr ?? ''));
    return { stdin: input };
  });
  const cli = new CoderCli(execute as unknown as typeof execFile, spawn, async () => '/login/bin', async () => undefined);
  return { cli, execute, writes };
}

it.each([
  ['https://coder.example', true],
  ['https://coder.example/path', true],
  ['https://other.example', false],
  ['http://coder.example', false],
])('compares deployment origins: %s', async (url, loggedIn) => {
  const { cli, execute } = fakeCli([{ stdout: JSON.stringify([{ url: 'https://coder.example/', username: 'tom' }]) }]);
  expect(await cli.status(url)).toEqual({ installed: true, loggedIn, url: 'https://coder.example/', user: 'tom' });
  expect(execute).toHaveBeenCalledWith('coder', ['whoami', '--output', 'json'], expect.objectContaining({ env: expect.objectContaining({ PATH: '/login/bin' }), timeout: 60000 }), expect.any(Function));
});

it('reports a missing CLI', async () => {
  expect(await fakeCli([{ code: 'ENOENT' }]).cli.status()).toEqual({ installed: false, loggedIn: false });
});
it('reports an expired login', async () => {
  expect(await fakeCli([{ code: 1, stderr: 'not logged in' }]).cli.status()).toMatchObject({ installed: true, loggedIn: false });
});
it('falls back to the text output of older clients', async () => {
  const { cli, execute } = fakeCli([{ code: 1, stderr: 'unknown flag: --output' }, { stdout: "Coder is running at https://coder.example, You're authenticated as tom !" }]);
  expect(await cli.status('https://coder.example')).toMatchObject({ installed: true, loggedIn: true, user: 'tom' });
  expect(execute.mock.calls[1][1]).toEqual(['whoami']);
});
it('does not treat a connection failure as a missing CLI', async () => {
  await expect(fakeCli([{ code: 'ETIMEDOUT' }]).cli.status()).rejects.toThrow('failed');
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
  [[], {}],
])('requires a selection for %j with %j', (items, choice) => {
  expect(() => pickWorkspace(items, choice)).toThrow('Select a workspace in Settings');
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
  const cli = new CoderCli(execFile, launch as unknown as typeof spawn, async () => '/login/bin');
  return { cli, child, launch, socket };
}

afterEach(() => jest.restoreAllMocks());

it('keeps a port forward until stopped and waits for its listener', async () => {
  const { cli, child, launch, socket } = fakeForward();
  try {
    expect(await cli.portForward('dev', 8010)).toBe('http://localhost:8010');
    expect(socket.destroy).toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith('coder', ['port-forward', 'dev', '--tcp', '8010:8010'], expect.objectContaining({ env: expect.objectContaining({ PATH: '/login/bin' }) }));
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
