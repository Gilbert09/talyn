import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TickGuard } from '../services/tickGuard.js';

describe('TickGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('claims and releases across normal ticks', () => {
    const guard = new TickGuard('test');
    expect(guard.tryBegin()).toBe(true);
    expect(guard.active).toBe(true);
    guard.end();
    expect(guard.active).toBe(false);
    expect(guard.tryBegin()).toBe(true);
  });

  it('refuses re-entry while a tick is legitimately running', () => {
    const guard = new TickGuard('test', 60_000);
    expect(guard.tryBegin()).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(guard.tryBegin()).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('force-releases a holder wedged past maxTickMs, loudly', () => {
    const guard = new TickGuard('wedgy', 60_000);
    expect(guard.tryBegin()).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(guard.tryBegin()).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/\[wedgy\] previous tick wedged for \d+ms — force-releasing/)
    );
  });

  it('restarts the wedge clock after a force-release', () => {
    const guard = new TickGuard('test', 60_000);
    guard.tryBegin();
    vi.advanceTimersByTime(60_001);
    expect(guard.tryBegin()).toBe(true); // force-release + reclaim
    // The new holder is fresh — re-entry is refused again.
    vi.advanceTimersByTime(1_000);
    expect(guard.tryBegin()).toBe(false);
  });
});
