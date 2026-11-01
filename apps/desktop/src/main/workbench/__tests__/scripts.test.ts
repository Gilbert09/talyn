/** @jest-environment node */
import net from 'net';
import { PortAllocator, portIsFree, Scripts } from '../scripts';
import { Terminals } from '../terminals';
import { WorkbenchPaths } from '../paths';
import * as config from '../config';

jest.mock('node-pty', () => ({ spawn: jest.fn() }), { virtual: true });

/** A probe that says every port in `busy` is in use. */
const probe = (busy: number[] = []) => {
  const taken = new Set(busy);
  return jest.fn(async (port: number) => !taken.has(port));
};

test('allocates distinct blocks and keeps a stable block per workbench', async () => {
  const ports = new PortAllocator(probe());
  expect(await ports.allocate('one')).toBe(55100);
  expect(await ports.allocate('two')).toBe(55110);
  expect(await ports.allocate('one')).toBe(55100);
  ports.release('one');
  expect(await ports.allocate('three')).toBe(55100);
  expect(await ports.allocate('two')).toBe(55110);
});

test('keeps a block for the session without asking the OS again', async () => {
  const isFree = probe();
  const ports = new PortAllocator(isFree);
  await ports.allocate('one');
  isFree.mockClear();
  isFree.mockResolvedValue(false);
  expect(await ports.allocate('one')).toBe(55100);
  expect(isFree).not.toHaveBeenCalled();
});

test.each([
  ['the first port', [55100], 55101],
  ['a port inside the block', [55104], 55105],
  ['the last port', [55109], 55110],
  ['ports in two blocks', [55103, 55112], 55113],
])('skips past %s of a block when another program holds it', async (_name, busy, expected) => {
  const ports = new PortAllocator(probe(busy));
  expect(await ports.allocate('one')).toBe(expected);
});

test('never gives a block that overlaps another session', async () => {
  const ports = new PortAllocator(probe([55100]));
  expect(await ports.allocate('one')).toBe(55101);
  expect(await ports.allocate('two')).toBe(55111);
});

test('two sessions asking at once get different blocks', async () => {
  const ports = new PortAllocator(probe());
  const [one, two] = await Promise.all([ports.allocate('one'), ports.allocate('two')]);
  expect(new Set([one, two]).size).toBe(2);
  expect(Math.abs(one - two)).toBeGreaterThanOrEqual(10);
});

test('says so when no 10 ports in a row are free', async () => {
  const ports = new PortAllocator(async () => false, 65500);
  await expect(ports.allocate('one')).rejects.toThrow('No 10 free ports in a row from 65500');
});

test('does not allocate ports outside the valid range', async () => {
  const ports = new PortAllocator(probe(), 65520);
  expect(await ports.allocate('a')).toBe(65520);
  await expect(ports.allocate('b')).rejects.toThrow('No 10 free ports');
});

test('a real port another server listens on is not free, and skipped', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const held = (server.address() as net.AddressInfo).port;
  try {
    expect(await portIsFree(held)).toBe(false);
    // A block above the held port fits only when the OS gave a port below 65526.
    if (held + 10 <= 65535) expect(await new PortAllocator(portIsFree, held).allocate('one')).toBeGreaterThan(held);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  expect(await portIsFree(held)).toBe(true);
});

test('loads scripts, applies environment variables, and stops nonconcurrent runs', async () => {
  jest
    .spyOn(config, 'readConfig')
    .mockResolvedValue({
      run: [{ name: 'web', command: 'start-web', default: true }],
      setup: { command: 'setup-command' },
      runMode: 'nonconcurrent',
      source: 'talyn',
      filesToCopy: [],
      errors: [],
    });
  const paths = new WorkbenchPaths('/tmp/unused-state');
  jest
    .spyOn(paths, 'load')
    .mockResolvedValue({
      workbenchId: 'wb',
      path: '/tmp/worktree',
      rootPath: '/tmp/root',
      name: 'london',
      baseBranch: 'main',
    });
  const terminals = new Terminals(jest.fn());
  const open = jest
    .spyOn(terminals, 'open')
    .mockResolvedValueOnce('first')
    .mockResolvedValueOnce('second')
    .mockResolvedValueOnce('setup');
  const close = jest.spyOn(terminals, 'close').mockResolvedValue();
  const scripts = new Scripts(paths, terminals, jest.fn(), new PortAllocator(probe()));
  await scripts.run({
    workbenchId: 'one',
    path: '/tmp/worktree',
    name: 'web',
    command: '',
    env: { CUSTOM: 'value', TALYN_PORT: '1' },
  });
  expect(open.mock.calls[0][0]).toMatchObject({
    kind: 'run',
    command: 'start-web',
    env: {
      CUSTOM: 'value',
      TALYN_PORT: '55100',
      CONDUCTOR_PORT: '55100',
      TALYN_ROOT_PATH: '/tmp/root',
      TALYN_DEFAULT_BRANCH: 'main',
    },
  });
  await scripts.run({
    workbenchId: 'two',
    path: '/tmp/worktree',
    name: 'web',
    command: 'custom-run',
    env: {},
  });
  expect(close).toHaveBeenCalledWith('first');
  expect(open.mock.calls[1][0]).toMatchObject({
    kind: 'run',
    command: 'custom-run',
    env: { TALYN_PORT: '55110' },
  });
  await scripts.run({
    workbenchId: 'two',
    path: '/tmp/worktree',
    name: 'setup',
    command: '',
    env: {},
  });
  expect(close).not.toHaveBeenCalledWith('second');
  expect(open.mock.calls[2][0]).toMatchObject({
    kind: 'setup',
    command: 'setup-command',
  });
  await scripts.shutdown();
  expect(close).toHaveBeenCalledWith('second');
  expect(close).toHaveBeenCalledWith('setup');
  jest.restoreAllMocks();
});
