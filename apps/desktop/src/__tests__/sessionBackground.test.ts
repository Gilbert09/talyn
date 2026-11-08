import type { WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { background: jest.fn() } } }));

import { api } from '../renderer/lib/api';
import { formatCountdown, formatRunTime, isActiveBackground, keepAwakeLabel, wakeLaterPresets } from '../renderer/lib/sessionBackground';
import { loadBackground, useSessionBackgroundStore } from '../renderer/stores/sessionBackground';

const empty = (workbenchId: string): WorkbenchBackground => ({ workbenchId, jobs: [], wakeups: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  jest.clearAllMocks();
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
});

describe('session background helpers', () => {
  it('formats run times and wake-up countdowns', () => {
    const start = '2026-11-08T10:00:00Z';
    expect(formatRunTime(start, null, new Date('2026-11-08T10:00:42Z'))).toBe('42s');
    expect(formatRunTime(start, '2026-11-08T10:12:03Z', new Date())).toBe('12m 03s');
    expect(formatRunTime(start, '2026-11-08T12:05:00Z', new Date())).toBe('2h 05m');
    expect(formatCountdown('2026-11-08T10:00:30Z', new Date(start))).toBe('Wakes in less than a minute');
    expect(formatCountdown('2026-11-08T11:05:00Z', new Date(start))).toBe('Wakes in 1 h 5 min');
    expect(formatCountdown('2026-11-10T10:00:00Z', new Date(start))).toBe('Wakes in 2 days');
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
