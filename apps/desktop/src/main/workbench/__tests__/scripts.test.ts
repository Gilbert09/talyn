/** @jest-environment node */
import { PortAllocator, Scripts } from '../scripts';
import { Terminals } from '../terminals';
import { WorkbenchPaths } from '../paths';
import * as config from '../config';

jest.mock('node-pty', () => ({ spawn: jest.fn() }));

test('allocates distinct blocks and keeps a stable block per workbench', () => {
  const ports = new PortAllocator();
  expect(ports.allocate('one')).toBe(55100);
  expect(ports.allocate('two')).toBe(55110);
  expect(ports.allocate('one')).toBe(55100);
  ports.release('one');
  expect(ports.allocate('three')).toBe(55100);
  expect(ports.allocate('two')).toBe(55110);
});

test('does not allocate ports outside the valid range', () => {
  const ports = new PortAllocator();
  for (let i = 0; i < 1043; i += 1)
    expect(ports.allocate(String(i))).toBe(55100 + i * 10);
  expect(() => ports.allocate('overflow')).toThrow('No workbench port range');
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
  const scripts = new Scripts(paths, terminals, jest.fn());
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
