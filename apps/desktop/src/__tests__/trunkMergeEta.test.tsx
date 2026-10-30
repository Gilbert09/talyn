import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { MergeEtaAnswer, TrunkMergeEta } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import {
  TrunkMergeEtaChip,
  _resetTrunkMergeEtaCache,
} from '../renderer/components/widgets/TrunkMergeEta';
import { TrunkSettingsCard } from '../renderer/components/panels/TrunkSettingsCard';

/**
 * Trunk's merge ETA on a PR row, and the token card in Settings.
 *
 * Both draw nothing unless the `trunkMergeEta` feature is on, and the chip
 * draws nothing when Trunk has no estimate. Between asks the chip counts down
 * on its own; it asks again once a minute.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

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

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  _resetTrunkMergeEtaCache();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('TrunkMergeEtaChip', () => {
  it('draws nothing and asks nothing when the feature is off', () => {
    setFlag(false);
    const spy = jest.spyOn(api.pullRequests, 'mergeEta');
    const { container } = render(<TrunkMergeEtaChip prId="pr-1" />);
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });

  it('draws the merge time, the testing start and the queue ahead', async () => {
    setFlag(true);
    jest
      .spyOn(api.pullRequests, 'mergeEta')
      .mockResolvedValue({ eta: eta(), queueState: 'pending', fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(screen.getByText('Will merge in ~20 min')).toBeInTheDocument());
    expect(screen.getByText('· Starts testing in ~5 min')).toBeInTheDocument();
    expect(screen.getByText('· 2 PRs ahead')).toBeInTheDocument();
    expect(screen.queryByText(/running long/)).toBeNull();
  });

  it('marks a late estimate as running long', async () => {
    setFlag(true);
    jest.spyOn(api.pullRequests, 'mergeEta').mockResolvedValue({
      eta: eta({ testsFinishAtState: 'behind', startsTestingAt: at(-5) }),
      queueState: 'testing',
      fetchedAt: at(0),
    });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(screen.getByText('· running long')).toBeInTheDocument());
    expect(screen.getByText('· Testing · ~15 min left')).toBeInTheDocument();
  });

  it.each([
    ['no estimate', { eta: null, reason: 'no_estimate', fetchedAt: at(0) }],
    ['no token', { eta: null, reason: 'no_token', fetchedAt: at(0) }],
  ] as Array<[string, MergeEtaAnswer]>)('draws nothing for %s', async (_name, answer) => {
    setFlag(true);
    const spy = jest.spyOn(api.pullRequests, 'mergeEta').mockResolvedValue(answer);
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText(/Will merge/)).toBeNull();
  });

  it('draws nothing when the request fails', async () => {
    setFlag(true);
    const spy = jest.spyOn(api.pullRequests, 'mergeEta').mockRejectedValue(new Error('offline'));
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText(/Will merge/)).toBeNull();
  });

  it('counts down between asks and asks again after a minute', async () => {
    setFlag(true);
    const spy = jest
      .spyOn(api.pullRequests, 'mergeEta')
      .mockResolvedValue({ eta: eta(), queueState: 'pending', fetchedAt: at(0) });
    render(<TrunkMergeEtaChip prId="pr-1" />);
    await waitFor(() => expect(screen.getByText('Will merge in ~20 min')).toBeInTheDocument());

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    // 19.5 minutes left rounds up.
    expect(screen.getByText('Will merge in ~20 min')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('Will merge in ~19 min')).toBeInTheDocument());
  });

  it('shares one request between two chips for the same PR', async () => {
    setFlag(true);
    const spy = jest
      .spyOn(api.pullRequests, 'mergeEta')
      .mockResolvedValue({ eta: eta(), fetchedAt: at(0) });
    render(
      <>
        <TrunkMergeEtaChip prId="pr-1" />
        <TrunkMergeEtaChip prId="pr-1" />
      </>
    );
    await waitFor(() => expect(screen.getAllByText('Will merge in ~20 min')).toHaveLength(2));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('TrunkSettingsCard', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it('draws nothing when the feature is off', () => {
    setFlag(false);
    const spy = jest.spyOn(api.trunk, 'getStatus');
    const { container } = render(<TrunkSettingsCard />);
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });

  it('offers the token form when no token is set', async () => {
    setFlag(true);
    jest.spyOn(api.trunk, 'getStatus').mockResolvedValue({ connected: false, needsReauth: false });
    render(<TrunkSettingsCard />);
    await waitFor(() =>
      expect(screen.getByLabelText('Trunk API key')).toBeInTheDocument()
    );
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('shows a connected token without the form', async () => {
    setFlag(true);
    jest.spyOn(api.trunk, 'getStatus').mockResolvedValue({ connected: true, needsReauth: false });
    render(<TrunkSettingsCard />);
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(screen.getByText('Replace key')).toBeInTheDocument();
    expect(screen.queryByLabelText('Trunk API key')).toBeNull();
  });

  it('asks for a reconnect when Trunk refused the token', async () => {
    setFlag(true);
    jest.spyOn(api.trunk, 'getStatus').mockResolvedValue({ connected: true, needsReauth: true });
    render(<TrunkSettingsCard />);
    await waitFor(() => expect(screen.getByText('Reconnect needed')).toBeInTheDocument());
    expect(screen.getByText('Reconnect')).toBeInTheDocument();
  });
});
