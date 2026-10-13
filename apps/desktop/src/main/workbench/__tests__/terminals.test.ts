/** @jest-environment node */
import * as native from 'node-pty';
import { Terminals } from '../terminals';
import * as environment from '../environment';
import * as processes from '../processes';

jest.mock('node-pty', () => ({ spawn: jest.fn() }));

let onData: (data: string) => void;
let onExit: (event: { exitCode: number; signal?: number }) => void;
const pty = {
  pid: 123,
  write: jest.fn(),
  resize: jest.fn(),
  kill: jest.fn(),
  onData: jest.fn((callback) => {
    onData = callback;
  }),
  onExit: jest.fn((callback) => {
    onExit = callback;
  }),
};

beforeEach(() => {
  jest.spyOn(environment, 'processEnv').mockResolvedValue({ PATH: '/bin' });
  jest.spyOn(processes, 'stopGroup').mockResolvedValue();
  (native.spawn as jest.Mock).mockReturnValue(pty);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('uses a login shell and replays the bounded scrollback on attachment', async () => {
  const emit = jest.fn();
  const terminals = new Terminals(emit);
  const input = { workbenchId: 'wb', path: '/tmp', kind: 'terminal' as const };
  const id = await terminals.open(input);
  expect(native.spawn).toHaveBeenCalledWith(
    expect.any(String),
    ['-l'],
    expect.objectContaining({ name: 'xterm-256color', cwd: '/tmp' }),
  );
  onData('x'.repeat(300 * 1024));
  onData('end');
  emit.mockClear();
  expect(await terminals.open(input)).toBe(id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const frame = emit.mock.calls[0][1] as { data: string };
  expect(Buffer.byteLength(frame.data)).toBe(256 * 1024);
  expect(frame.data.endsWith('end')).toBe(true);
  expect(native.spawn).toHaveBeenCalledTimes(1);
  terminals.write(id, 'hello');
  terminals.resize(id, 80, 24);
  expect(pty.write).toHaveBeenCalledWith('hello');
  expect(pty.resize).toHaveBeenCalledWith(80, 24);
  await terminals.close(id);
  expect(processes.stopGroup).toHaveBeenCalledWith(123);
});

test.each([
  [0, 24],
  [80, -1],
  [1.5, 24],
  [80, 2000],
  [NaN, 24],
])('rejects invalid size %p x %p', (cols, rows) => {
  expect(() => new Terminals(jest.fn()).resize('id', cols, rows)).toThrow(
    'Invalid terminal size',
  );
});

test('runs commands in script terminals and sends the exit code', async () => {
  const emit = jest.fn();
  const terminals = new Terminals(emit);
  const onScriptExit = jest.fn();
  const id = await terminals.open({
    workbenchId: 'wb',
    path: '/tmp',
    kind: 'setup',
    command: 'echo hello',
    onExit: onScriptExit,
  });
  expect(native.spawn).toHaveBeenCalledWith(
    expect.any(String),
    ['-lc', 'echo hello'],
    expect.any(Object),
  );
  onExit({ exitCode: 2 });
  expect(emit).toHaveBeenCalledWith('workbench:terminal-data', {
    terminalId: id,
    exitCode: 2,
  });
  expect(onScriptExit).toHaveBeenCalledWith(2);
  await terminals.shutdown();
});

test('coalesces concurrent opens', async () => {
  const terminals = new Terminals(jest.fn());
  const input = { workbenchId: 'wb', path: '/tmp', kind: 'terminal' as const };
  const ids = await Promise.all([terminals.open(input), terminals.open(input)]);
  expect(ids[0]).toBe(ids[1]);
  expect(native.spawn).toHaveBeenCalledTimes(1);
  await terminals.shutdown();
});
