import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRestoring, withRestorePhase } from '../services/workbenches/restorePhase.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('withRestorePhase', () => {
  it.each(['suspended', 'starting'])('marks a %s box as restoring until the exec settles', async (status) => {
    const exec = deferred<string>();
    const publish = vi.fn();
    const readSandbox = vi.fn().mockResolvedValue({ status });
    const run = withRestorePhase('chat-1', () => exec.promise, { readSandbox, publish, delayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(readSandbox).toHaveBeenCalledTimes(1);
    expect(isRestoring('chat-1')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    exec.resolve('done');
    await expect(run).resolves.toBe('done');
    expect(isRestoring('chat-1')).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it.each(['idle', 'busy', 'queued'])('does not mark a %s box', async (status) => {
    const exec = deferred<void>();
    const publish = vi.fn();
    const run = withRestorePhase('chat-2', () => exec.promise, {
      readSandbox: vi.fn().mockResolvedValue({ status }),
      publish,
      delayMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(isRestoring('chat-2')).toBe(false);
    exec.resolve();
    await run;
    expect(publish).not.toHaveBeenCalled();
  });

  it('makes no fleet call when the exec finishes before the delay', async () => {
    const readSandbox = vi.fn();
    const publish = vi.fn();
    await withRestorePhase('chat-3', async () => 'fast', { readSandbox, publish, delayMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    expect(readSandbox).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not set the phase when the read returns after the exec settled', async () => {
    const read = deferred<{ status: string }>();
    const publish = vi.fn();
    const exec = deferred<void>();
    const run = withRestorePhase('chat-4', () => exec.promise, { readSandbox: () => read.promise, publish, delayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    exec.resolve();
    await run;
    read.resolve({ status: 'suspended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(isRestoring('chat-4')).toBe(false);
  });

  it('clears the phase when the exec fails, and survives a failed read', async () => {
    let fail!: (e: Error) => void;
    const exec = new Promise<void>((_, reject) => (fail = reject));
    const run = withRestorePhase('chat-5', () => exec, {
      readSandbox: vi.fn().mockResolvedValue({ status: 'suspended' }),
      publish: vi.fn(),
      delayMs: 100,
    });
    const caught = run.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(100);
    expect(isRestoring('chat-5')).toBe(true);
    fail(new Error('boom'));
    await expect(caught).resolves.toBe('boom');
    expect(isRestoring('chat-5')).toBe(false);

    const ok = await withRestorePhase('chat-6', async () => 'ok', {
      readSandbox: vi.fn().mockRejectedValue(new Error('fleet down')),
      publish: vi.fn(),
      delayMs: 100,
    });
    expect(ok).toBe('ok');
  });
});
