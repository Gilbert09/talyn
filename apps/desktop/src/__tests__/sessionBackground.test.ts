import type { Workbench, WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { background: jest.fn() } } }));

import { api } from '../renderer/lib/api';
import { emptyLogText, formatCountdown, formatRunTime, isActiveBackground, keepAwakeLabel, wakeLaterPresets, wakeupTitle, wakeupWhen } from '../renderer/lib/sessionBackground';
import { loadBackground, pruneBackground, reconcileBackground, useSessionBackgroundStore } from '../renderer/stores/sessionBackground';
import { archiveAllCandidates } from '../renderer/lib/archiveAll';

const empty = (workbenchId: string): WorkbenchBackground => ({ workbenchId, jobs: [], wakeups: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  pruneBackground({});
  jest.resetAllMocks();
});

describe('session background store', () => {
  it('replaces the whole entry for one workbench', () => {
    const store = useSessionBackgroundStore.getState();
    store.applyBackground({ ...empty('a'), jobs: [{ id: 'one' } as WorkbenchBackgroundJob] });
    store.applyBackground(empty('b'));
    store.applyBackground(empty('a'));
    expect(useSessionBackgroundStore.getState().byWorkbench.a.jobs).toEqual([]);
    expect(useSessionBackgroundStore.getState().byWorkbench.b).toEqual(empty('b'));
    store.clear('a');
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
  });

  it('keeps a WS update that arrives during a load', async () => {
    const pending = deferred<WorkbenchBackground>();
    jest.mocked(api.workbenches.background).mockReturnValue(pending.promise);
    const load = loadBackground('a');
    const live = { ...empty('a'), wakeups: [{ id: 'new' } as WorkbenchWakeup] };
    useSessionBackgroundStore.getState().applyBackground(live);
    pending.resolve(empty('a'));
    await load;
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBe(live);
  });

  it.each(['running', 'scheduled'])('discards stale %s state before a reconnect refresh completes', async (status) => {
    const session = { id: 'a', status: 'ready', kind: 'session', pullRequestId: null } as Workbench;
    useSessionBackgroundStore.getState().applyBackground({
      ...empty('a'),
      jobs: status === 'running' ? [{ status } as WorkbenchBackgroundJob] : [],
      wakeups: status === 'scheduled' ? [{ status } as WorkbenchWakeup] : [],
    });
    const candidates = () => archiveAllCandidates([session], new Set(), {}, useSessionBackgroundStore.getState().byWorkbench);
    expect(candidates()).toEqual([]);
    const pending = deferred<WorkbenchBackground>();
    jest.mocked(api.workbenches.background).mockReturnValue(pending.promise);
    const refresh = reconcileBackground();
    expect(candidates()).toEqual([session]);
    pending.resolve(empty('a'));
    await refresh;
    expect(api.workbenches.background).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(candidates()).toEqual([session]);
  });

  it('replaces a load from before reconnect even when no snapshot was cached', async () => {
    const old = deferred<WorkbenchBackground>();
    const fresh = deferred<WorkbenchBackground>();
    jest.mocked(api.workbenches.background).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const load = loadBackground('a');
    const refresh = reconcileBackground();
    old.resolve({ ...empty('a'), jobs: [{ status: 'running' } as WorkbenchBackgroundJob] });
    await load;
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
    fresh.resolve(empty('a'));
    await refresh;
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toEqual(empty('a'));
  });

  it('does not restore a stale snapshot when reconnect refresh fails', async () => {
    useSessionBackgroundStore.getState().applyBackground({
      ...empty('a'), jobs: [{ status: 'running' } as WorkbenchBackgroundJob],
    });
    jest.mocked(api.workbenches.background).mockRejectedValue(new Error('offline'));
    await reconcileBackground();
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
  });

  it.each(['running', 'scheduled'])('retries an unopened session after refresh fails and restores %s state', async (status) => {
    const session = { id: 'a', status: 'ready', kind: 'session', pullRequestId: null } as Workbench;
    useSessionBackgroundStore.getState().applyBackground(empty('a'));
    const live = {
      ...empty('a'),
      jobs: status === 'running' ? [{ status } as WorkbenchBackgroundJob] : [],
      wakeups: status === 'scheduled' ? [{ status } as WorkbenchWakeup] : [],
    };
    jest.mocked(api.workbenches.background).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(live);
    await reconcileBackground();
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenNthCalledWith(2, 'a', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBe(live);
    expect(archiveAllCandidates([session], new Set(), {}, useSessionBackgroundStore.getState().byWorkbench)).toEqual([]);
  });

  it('retries a failed first load after reconnect', async () => {
    jest.mocked(api.workbenches.background).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(empty('a'));
    await loadBackground('a');
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenNthCalledWith(2, 'a', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toEqual(empty('a'));
  });

  it('does not retry a cleared session after refresh fails', async () => {
    useSessionBackgroundStore.getState().applyBackground(empty('a'));
    jest.mocked(api.workbenches.background).mockRejectedValue(new Error('offline'));
    await reconcileBackground();
    useSessionBackgroundStore.getState().clear('a');
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenCalledTimes(1);
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
  });

  it('bounds requests and coalesces repeated reconnects', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
    for (const id of ids) useSessionBackgroundStore.getState().applyBackground(empty(id));
    const blocked = deferred<void>();
    let active = 0;
    let peak = 0;
    jest.mocked(api.workbenches.background).mockImplementation(async (id) => {
      active++;
      peak = Math.max(peak, active);
      await blocked.promise;
      active--;
      return empty(id);
    });
    const first = reconcileBackground();
    const second = reconcileBackground();
    const third = reconcileBackground();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(api.workbenches.background).toHaveBeenCalledTimes(4);
    blocked.resolve();
    await first;
    expect(peak).toBe(4);
    expect(api.workbenches.background).toHaveBeenCalledTimes(16);
    expect(Object.keys(useSessionBackgroundStore.getState().byWorkbench).sort()).toEqual(ids.sort());
  });

  it('cancels stalled requests on reconnect and refreshes every queued session', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `stalled-${i}`);
    for (const id of ids) useSessionBackgroundStore.getState().applyBackground(empty(id));
    const signals: AbortSignal[] = [];
    let online = false;
    jest.mocked(api.workbenches.background).mockImplementation((id, options) => {
      if (online) return Promise.resolve(empty(id));
      const signal = options!.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
    });
    const first = reconcileBackground();
    expect(signals).toHaveLength(4);
    online = true;
    const second = reconcileBackground();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await Promise.all([first, second]);
    expect(api.workbenches.background).toHaveBeenCalledTimes(12);
    expect(Object.keys(useSessionBackgroundStore.getState().byWorkbench).sort()).toEqual(ids.sort());
  });

  it('aborts expired requests and retries the sessions on the next reconnect', async () => {
    jest.useFakeTimers();
    try {
      useSessionBackgroundStore.getState().applyBackground(empty('a'));
      let signal!: AbortSignal;
      jest.mocked(api.workbenches.background).mockImplementationOnce((_id, options) => {
        signal = options!.signal!;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        });
      });
      const refresh = reconcileBackground();
      await jest.advanceTimersByTimeAsync(15_000);
      await refresh;
      expect(signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      jest.mocked(api.workbenches.background).mockResolvedValue(empty('a'));
      await reconcileBackground();
      expect(useSessionBackgroundStore.getState().byWorkbench.a).toEqual(empty('a'));
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes one cache update when pruning many sessions', () => {
    for (let i = 0; i < 1000; i++) useSessionBackgroundStore.getState().applyBackground(empty(`old-${i}`));
    useSessionBackgroundStore.getState().applyBackground(empty('a'));
    const changed = jest.fn();
    const unsubscribe = useSessionBackgroundStore.subscribe(changed);
    try {
      pruneBackground({ a: { id: 'a', status: 'ready' } as Workbench });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(useSessionBackgroundStore.getState().byWorkbench).toEqual({ a: empty('a') });
    } finally {
      unsubscribe();
    }
  });

  it('prunes archived and missing sessions, including queued and pending refreshes', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) useSessionBackgroundStore.getState().applyBackground(empty(id));
    const blocked = deferred<void>();
    jest.mocked(api.workbenches.background).mockImplementation(async (id) => {
      await blocked.promise;
      return empty(id);
    });
    const refresh = reconcileBackground();
    pruneBackground({
      a: { id: 'a', status: 'ready' } as Workbench,
      b: { id: 'b', status: 'archived' } as Workbench,
      c: { id: 'c', status: 'ready', archivedAt: '2026-11-27' } as Workbench,
    });
    blocked.resolve();
    await refresh;
    expect(Object.keys(useSessionBackgroundStore.getState().byWorkbench)).toEqual(['a']);
    expect(api.workbenches.background).not.toHaveBeenCalledWith('e', expect.anything());
    jest.mocked(api.workbenches.background).mockClear();
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenCalledTimes(1);
    expect(api.workbenches.background).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('does not retry or restore a cleared session with a pending load', async () => {
    const pending = deferred<WorkbenchBackground>();
    jest.mocked(api.workbenches.background).mockReturnValue(pending.promise);
    const load = loadBackground('a');
    useSessionBackgroundStore.getState().clear('a');
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenCalledTimes(1);
    pending.resolve(empty('a'));
    await load;
    await reconcileBackground();
    expect(api.workbenches.background).toHaveBeenCalledTimes(1);
    expect(useSessionBackgroundStore.getState().byWorkbench.a).toBeUndefined();
  });
});

describe('session background helpers', () => {
  it.each([
    [true, 'No output yet.'],
    [false, 'The job printed no output.'],
  ])('says what an empty log means when running is %s', (running, expected) => {
    expect(emptyLogText(running)).toBe(expected);
  });

  it('formats run times and wake-up countdowns', () => {
    const start = '2026-11-08T10:00:00Z';
    expect(formatRunTime(start, null, new Date('2026-11-08T10:00:42Z'))).toBe('42s');
    expect(formatRunTime(start, '2026-11-08T10:12:03Z', new Date())).toBe('12m 03s');
    expect(formatRunTime(start, '2026-11-08T12:05:00Z', new Date())).toBe('2h 05m');
    expect(formatCountdown('2026-11-08T10:00:30Z', new Date(start))).toBe('Wakes in less than a minute');
    expect(formatCountdown('2026-11-08T11:05:00Z', new Date(start))).toBe('Wakes in 1 h 5 min');
    expect(formatCountdown('2026-11-10T10:00:00Z', new Date(start))).toBe('Wakes in 2 days');
  });

  it.each([
    ['a timed wake-up', null, 'Wakes in 1 h 5 min', 'Wakes in 1 h 5 min: Check'],
    ['a CI wake-up', { pullRequestId: 'p1', headSha: 'abcdef1234567890abcdef1234567890abcdef12' }, 'Waits for CI on abcdef1', 'Waits for CI on abcdef1. Wakes in 1 h 5 min at the latest: Check'],
  ])('says when %s fires', (_name, ci, when, title) => {
    const now = new Date('2026-11-08T10:00:00Z');
    const wakeup = { wakeAt: '2026-11-08T11:05:00Z', ci, reason: 'Check' };
    expect(wakeupWhen(wakeup, now)).toBe(when);
    expect(wakeupTitle(wakeup, now)).toBe(title);
  });

  it('sets tomorrow at 09:00 local time', () => {
    const now = new Date(2026, 10, 8, 16, 30);
    const presets = wakeLaterPresets(now);
    expect(presets.map((preset) => preset.delaySeconds).slice(0, 4)).toEqual([600, 1800, 3600, 10800]);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(presets[4]).toEqual({ id: 'tomorrow', label: 'Tomorrow 09:00', delaySeconds: (tomorrow.getTime() - now.getTime()) / 1000 });
  });

  it('shows active work and future awake time', () => {
    expect(keepAwakeLabel('2026-11-08T11:00:00Z', new Date('2026-11-08T12:00:00Z'))).toBeNull();
    expect(keepAwakeLabel('2026-11-08T13:00:00Z', new Date('2026-11-08T12:00:00Z'))).toContain('Keeps the box awake until');
    expect(isActiveBackground(empty('a'))).toBe(false);
    expect(isActiveBackground({ ...empty('a'), jobs: [{ status: 'running' } as WorkbenchBackgroundJob] })).toBe(true);
    expect(isActiveBackground({ ...empty('a'), wakeups: [{ status: 'scheduled' } as WorkbenchWakeup] })).toBe(true);
  });
});
