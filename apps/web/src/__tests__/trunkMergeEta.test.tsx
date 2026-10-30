import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { MergeEtaAnswer, TrunkMergeEta } from '@talyn/shared';

/**
 * Trunk's merge ETA on a PR row, and the token card in Settings.
 *
 * Both draw nothing unless the `trunkMergeEta` feature is on, and the chip
 * draws nothing when Trunk has no estimate. Between asks the chip counts down
 * on its own; it asks again once a minute.
 *
 * Duplicated from apps/desktop on purpose: the renderer is a deliberate fork.
 */

const mergeEta = vi.fn();
const getStatus = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    pullRequests: { mergeEta: (...args: unknown[]) => mergeEta(...args) },
    trunk: {
      getStatus: (...args: unknown[]) => getStatus(...args),
      saveToken: vi.fn(),
      removeToken: vi.fn(),
    },
  },
}));

const { TrunkMergeEtaChip, _resetTrunkMergeEtaCache } = await import(
  '../components/widgets/TrunkMergeEta'
);
const { TrunkSettingsCard } = await import('../components/panels/TrunkSettingsCard');
const { useWorkspaceStore } = await import('../stores/workspace');

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function eta(over: Partial<TrunkMergeEta> = {}): TrunkMergeEta {
  return {
    computedAt: at(0),
    kind: 'merge',
    estimatedAt: at(20),
    estimatedAtState: 'on_track',
    confidence: 'high',
    pullRequestsAhead: 2,
    waitingForPullRequestNumbers: [],
    sampleSize: 40,
    startsTestingAt: at(5),
    startsTestingAtState: 'holding',
    testsFinishAt: at(15),
    testsFinishAtState: 'on_track',
    typicalTestDurationSeconds: 600,
    ...over,
  };
}

function setFlag(on: boolean) {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws-1',
    features: { trunkMergeEta: on } as never,
  });
}

/** Let resolved promises run their `.then`s under fake timers. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  cleanup();
  mergeEta.mockReset();
  getStatus.mockReset();
  _resetTrunkMergeEtaCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TrunkMergeEtaChip', () => {
  it('draws nothing and asks nothing when the feature is off', () => {
    setFlag(false);
    const { container } = render(<TrunkMergeEtaChip prId="pr-1" />);
    expect(container.innerHTML).toBe('');
    expect(mergeEta).not.toHaveBeenCalled();
  });

  it('draws the merge time, the testing start and the queue ahead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setFlag(true);
    mergeEta.mockResolvedValue({ eta: eta(), queueState: 'pending', fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await flush();
    expect(screen.getByText('Will merge in ~20 min')).toBeTruthy();
    expect(screen.getByText('· Starts testing in ~5 min')).toBeTruthy();
    expect(screen.getByText('· 2 PRs ahead')).toBeTruthy();
    expect(screen.queryByText(/running long/)).toBeNull();
  });

  it('labels a failure resolution estimate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setFlag(true);
    mergeEta.mockResolvedValue({ eta: eta({ kind: 'pendingFailureResolution', estimatedAt: at(12) }), fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await flush();
    expect(screen.getByText('Waiting for a failure to resolve (est. ~12 min)')).toBeTruthy();
    expect(screen.queryByText(/Will merge/)).toBeNull();
  });

  it('shows a repository access error', async () => {
    setFlag(true);
    mergeEta.mockResolvedValue({ eta: null, reason: 'no_access', message: 'This Trunk key cannot see PostHog/posthog', fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await flush();
    expect(screen.getByText('This Trunk key cannot see PostHog/posthog')).toBeTruthy();
  });

  it('marks a late estimate as running long', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setFlag(true);
    mergeEta.mockResolvedValue({
      eta: eta({ testsFinishAtState: 'behind', startsTestingAt: at(-5) }),
      queueState: 'testing',
      fetchedAt: at(0),
    });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await flush();
    expect(screen.getByText('· running long')).toBeTruthy();
    expect(screen.getByText('· Testing · ~15 min left')).toBeTruthy();
  });

  it.each([
    ['no estimate', { eta: null, reason: 'no_estimate', fetchedAt: at(0) }],
    ['no token', { eta: null, reason: 'no_token', fetchedAt: at(0) }],
  ] as Array<[string, MergeEtaAnswer]>)('draws nothing for %s', async (_name, answer) => {
    setFlag(true);
    mergeEta.mockResolvedValue(answer);
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(mergeEta).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(/Will merge/)).toBeNull();
  });

  it('draws nothing when the request fails', async () => {
    setFlag(true);
    mergeEta.mockRejectedValue(new Error('offline'));
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(mergeEta).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(/Will merge/)).toBeNull();
  });

  it('counts down between asks and asks again after a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setFlag(true);
    mergeEta.mockResolvedValue({ eta: eta(), queueState: 'pending', fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await flush();
    expect(screen.getByText('Will merge in ~20 min')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    // 19.5 minutes left rounds up.
    expect(screen.getByText('Will merge in ~20 min')).toBeTruthy();
    expect(mergeEta).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(mergeEta).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Will merge in ~19 min')).toBeTruthy();
  });

  it('shares one request between two chips for the same PR', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setFlag(true);
    mergeEta.mockResolvedValue({ eta: eta(), fetchedAt: at(0) });
    render(
      <>
        <TrunkMergeEtaChip prId="pr-1" />
        <TrunkMergeEtaChip prId="pr-1" />
      </>
    );
    await flush();
    expect(screen.getAllByText('Will merge in ~20 min')).toHaveLength(2);
    expect(mergeEta).toHaveBeenCalledTimes(1);
  });
});

describe('TrunkSettingsCard', () => {
  it('draws nothing when the feature is off', () => {
    setFlag(false);
    const { container } = render(<TrunkSettingsCard />);
    expect(container.innerHTML).toBe('');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('offers the token form when no token is set', async () => {
    setFlag(true);
    getStatus.mockResolvedValue({ connected: false, needsReauth: false });
    render(<TrunkSettingsCard />);
    await waitFor(() => expect(screen.getByLabelText('Trunk API key')).toBeTruthy());
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('shows a connected token without the form', async () => {
    setFlag(true);
    getStatus.mockResolvedValue({ connected: true, needsReauth: false });
    render(<TrunkSettingsCard />);
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    expect(screen.getByText('Replace key')).toBeTruthy();
    expect(screen.queryByLabelText('Trunk API key')).toBeNull();
  });

  it('asks for a reconnect when Trunk refused the token', async () => {
    setFlag(true);
    getStatus.mockResolvedValue({ connected: true, needsReauth: true });
    render(<TrunkSettingsCard />);
    await waitFor(() => expect(screen.getByText('Reconnect needed')).toBeTruthy());
    expect(screen.getByText('Reconnect')).toBeTruthy();
  });
});
