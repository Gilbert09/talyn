import { api } from '../lib/api';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReviewRankingLog, type ReviewRankingContext, type ReviewRankingRow } from '@talyn/shared';
import { ReviewRankingArchive } from '@talyn/client';
import { exportReviewRankingData, useReviewRankingCapture } from '../components/panels/github/useReviewRankingCapture';

const rows: ReviewRankingRow[] = [{ id: 'pr', workspaceId: 'workspace', number: 1, owner: 'org', repo: 'repo', summary: {} }];
const context: ReviewRankingContext = {
  workspaceId: 'workspace', viewerLogin: 'viewer', sortMode: 'newest',
  filterKey: '', filtered: false, profile: null,
};
let intersect: IntersectionObserverCallback;
const disconnect = vi.fn();
const observed = vi.fn();
function log() { return readReviewRankingLog(localStorage, 'workspace'); }

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api.workspaces, 'recordRankingEvents').mockResolvedValue({ accepted: 1 });
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe = observed;
    disconnect = disconnect;
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.body.innerHTML = '<table><tbody><tr data-review-ranking-id="pr"></tr></tbody></table>';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('local ranking capture', () => {
  it('uploads an observed queue with session identity, then sends opt-out without events', async () => {
    renderHook(() => useReviewRankingCapture(rows, context, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.workspaces.recordRankingEvents).toHaveBeenCalledWith('workspace', expect.objectContaining({
      enabled: true, events: [expect.objectContaining({
        event: 'pr_review_queue_snapshot', properties: expect.objectContaining({
          session_id: expect.any(String), viewer_login: 'viewer', candidate_count: 1,
        }),
      })],
    }));
    localStorage.setItem('fastowl-analytics-opt-out', 'true');
    await act(async () => { window.dispatchEvent(new Event('talyn-analytics-preference-changed')); });
    expect(api.workspaces.recordRankingEvents).toHaveBeenLastCalledWith('workspace', { enabled: false, events: [] });
  });

  it.each([true, false])('exports recent events when the archive is available: %s', async (available) => {
    renderHook(() => useReviewRankingCapture(rows, context, true));
    const recent = log();
    const archived = { ...recent[0], properties: { ...recent[0].properties, snapshot_id: 'older' } };
    const reader = vi.spyOn(ReviewRankingArchive.prototype, 'read');
    if (available) reader.mockResolvedValue({
      events: [...recent, archived],
      archive: { max_age_ms: 100, max_chars: 1000, expired: 0, size_evicted: 0, failed_writes: 0 },
    });
    else reader.mockRejectedValue(new Error('archive disabled'));
    let serialized = '';
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { serialized = parts.join(''); }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:export', revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportReviewRankingData('workspace');
    const exported = JSON.parse(serialized);
    expect(exported.archive_available).toBe(available);
    expect(exported.events).toHaveLength(available ? 2 : 1);
    expect(click).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1000));
  });

  it('records nothing when the feature is unavailable', () => {
    const { result } = renderHook(() => useReviewRankingCapture(rows, context, false));
    act(() => result.current('pr'));
    expect(log()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });

  it('waits until the document is visible', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    renderHook(() => useReviewRankingCapture(rows, context, true));
    expect(log()).toEqual([]);
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(log()).toHaveLength(1);
  });

  it('records viewport exposure and opens independently of the queue', () => {
    const { result } = renderHook(() => useReviewRankingCapture(rows, context, true));
    const row = document.querySelector('[data-review-ranking-id]')!;
    expect(log().map((event) => event.event)).toEqual(['pr_review_queue_snapshot']);
    act(() => intersect([
      { target: row, isIntersecting: true, intersectionRatio: 0.2 } as IntersectionObserverEntry,
    ], {} as IntersectionObserver));
    expect(log()).toHaveLength(1);
    act(() => intersect([
      { target: row, isIntersecting: true, intersectionRatio: 0.8 } as IntersectionObserverEntry,
    ], {} as IntersectionObserver));
    act(() => result.current('pr'));
    expect(log().map((event) => event.event)).toEqual([
      'pr_review_queue_snapshot', 'pr_review_rows_visible', 'pr_review_candidate_opened',
    ]);
  });

  it('stops timers and observers when the panel unmounts', () => {
    const { unmount } = renderHook(() => useReviewRankingCapture(rows, context, true));
    act(() => vi.advanceTimersByTime(300_000));
    expect(log()).toHaveLength(2);
    unmount();
    act(() => vi.advanceTimersByTime(600_000));
    expect(log()).toHaveLength(2);
    expect(disconnect).toHaveBeenCalled();
  });

  it('survives a browser that refuses storage access', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useReviewRankingCapture(rows, context, true));
    expect(() => result.current('pr')).not.toThrow();
  });
});
