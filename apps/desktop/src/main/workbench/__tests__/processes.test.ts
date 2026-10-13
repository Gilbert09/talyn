/** @jest-environment node */
import { signalGroup, stopGroup } from '../processes';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('escalates from SIGTERM to SIGKILL after five seconds', async () => {
  const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
  const stopped = stopGroup(123);
  const group = process.platform === 'win32' ? 123 : -123;
  expect(kill).toHaveBeenCalledWith(group, 'SIGTERM');
  jest.advanceTimersByTime(4999);
  expect(kill).not.toHaveBeenCalledWith(group, 'SIGKILL');
  jest.advanceTimersByTime(1);
  await stopped;
  expect(kill).toHaveBeenCalledWith(group, 'SIGKILL');
});

test('does not signal a group again when it has exited', async () => {
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  await stopGroup(123);
  jest.advanceTimersByTime(5000);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(signalGroup(123, 0)).toBe(false);
});
