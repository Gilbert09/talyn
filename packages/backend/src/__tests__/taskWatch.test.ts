import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markWatched,
  clearWatched,
  isWatched,
  _resetTaskWatch,
  TASK_WATCH_CONSTANTS,
} from '../services/cloudProviders/taskWatch.js';

const { WATCH_TTL_MS } = TASK_WATCH_CONSTANTS;

describe('taskWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTaskWatch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is unwatched by default', () => {
    expect(isWatched('t1')).toBe(false);
  });

  it('markWatched makes a task watched until the TTL lapses', () => {
    markWatched('t1');
    expect(isWatched('t1')).toBe(true);

    vi.advanceTimersByTime(WATCH_TTL_MS);
    expect(isWatched('t1')).toBe(true); // exactly at TTL — still inside

    vi.advanceTimersByTime(1);
    expect(isWatched('t1')).toBe(false); // past TTL — expired
  });

  it('a heartbeat re-mark refreshes the TTL', () => {
    markWatched('t1');
    vi.advanceTimersByTime(WATCH_TTL_MS - 1_000);
    markWatched('t1'); // heartbeat just before expiry
    vi.advanceTimersByTime(WATCH_TTL_MS - 1_000);
    expect(isWatched('t1')).toBe(true);
  });

  it('clearWatched drops the watch immediately and is idempotent', () => {
    markWatched('t1');
    clearWatched('t1');
    expect(isWatched('t1')).toBe(false);
    clearWatched('t1'); // no-op
    expect(isWatched('t1')).toBe(false);
  });

  it('tasks are tracked independently', () => {
    markWatched('t1');
    expect(isWatched('t1')).toBe(true);
    expect(isWatched('t2')).toBe(false);
    clearWatched('t1');
    markWatched('t2');
    expect(isWatched('t1')).toBe(false);
    expect(isWatched('t2')).toBe(true);
  });

  it('expired entries are cleaned up on read', () => {
    markWatched('t1');
    vi.advanceTimersByTime(WATCH_TTL_MS + 1);
    expect(isWatched('t1')).toBe(false);
    // Re-marking after lazy deletion works as a fresh watch.
    markWatched('t1');
    expect(isWatched('t1')).toBe(true);
  });
});
