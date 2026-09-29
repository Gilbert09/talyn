import type { PRRow } from '../renderer/lib/api';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../renderer/stores/pullRequests';

function makeRow(id: string, over: Partial<PRRow> = {}): PRRow {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: `PR ${id}` } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueue: null,
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
    ...over,
  };
}

function makePayload(
  over: Partial<PullRequestUpdatePayload> & { id: string }
): PullRequestUpdatePayload {
  return {
    taskId: null,
    state: 'open',
    lastSummary: { title: 'updated' } as PullRequestUpdatePayload['lastSummary'],
    ...over,
  };
}

describe('pull request store — applyPullRequestUpdate', () => {
  beforeEach(() => usePullRequestStore.setState({ rows: [] }));

  it('patches an existing open row in place and keeps omitted fields', () => {
    usePullRequestStore.setState({
      rows: [makeRow('p1', { taskId: 't1', authored: true, mergeQueued: true })],
    });
    const needsRefetch = usePullRequestStore
      .getState()
      .applyPullRequestUpdate(makePayload({ id: 'p1', lastSummary: { title: 'new' } as never }));

    expect(needsRefetch).toBe(false);
    const row = usePullRequestStore.getState().rows[0];
    expect(row.summary.title).toBe('new');
    // Echo omitted taskId / flags / queue state → keep what we had.
    expect(row.taskId).toBe('t1');
    expect(row.authored).toBe(true);
    expect(row.mergeQueued).toBe(true);
  });

  it('adopts changed relationship + queue fields when the echo carries them', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1', { reviewRequested: false })] });
    usePullRequestStore.getState().applyPullRequestUpdate(
      makePayload({
        id: 'p1',
        reviewRequested: true,
        mergeQueued: true,
        mergeQueue: { status: 'merging', position: 2 },
      })
    );
    const row = usePullRequestStore.getState().rows[0];
    expect(row.reviewRequested).toBe(true);
    expect(row.mergeQueued).toBe(true);
    expect(row.mergeQueue).toEqual({ status: 'merging', position: 2 });
  });

  it('drops a row that left the open state (merged/closed upstream)', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    const needsRefetch = usePullRequestStore
      .getState()
      .applyPullRequestUpdate(makePayload({ id: 'p1', state: 'merged' }));
    expect(needsRefetch).toBe(false);
    expect(usePullRequestStore.getState().rows.map((r) => r.id)).toEqual(['p2']);
  });

  it('signals a refetch for an unknown OPEN PR, but not an unknown non-open one', () => {
    expect(
      usePullRequestStore.getState().applyPullRequestUpdate(makePayload({ id: 'new', state: 'open' }))
    ).toBe(true);
    expect(
      usePullRequestStore
        .getState()
        .applyPullRequestUpdate(makePayload({ id: 'gone', state: 'closed' }))
    ).toBe(false);
    // Neither inserted a row.
    expect(usePullRequestStore.getState().rows).toHaveLength(0);
  });

  it('patchRow and removeRow mutate the targeted row only', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    usePullRequestStore.getState().patchRow('p1', { mergeQueued: true });
    expect(usePullRequestStore.getState().rows.find((r) => r.id === 'p1')?.mergeQueued).toBe(true);
    expect(usePullRequestStore.getState().rows.find((r) => r.id === 'p2')?.mergeQueued).toBe(false);

    usePullRequestStore.getState().removeRow('p1');
    expect(usePullRequestStore.getState().rows.map((r) => r.id)).toEqual(['p2']);
  });

  // Broadcasts cross replicas through Redis, so a partial checks echo from one
  // replica can land after a newer full write from another. The older one must
  // not paint "1 running" back over settled checks.
  describe('checksAt ordering', () => {
    const held = {
      title: 'PR p1',
      blockingReason: 'mergeable',
      ciStatus: 'passing',
      checks: { total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 },
      checksAt: 200,
    };
    const stale = {
      blockingReason: 'blocked',
      ciStatus: 'running',
      humanGates: [],
      checks: { total: 3, passed: 2, failed: 0, inProgress: 1, skipped: 0 },
    };

    it.each([
      ['drops an older checks slice', 100, 'passing', 0],
      ['applies an equal-age slice', 200, 'running', 1],
      ['applies a newer slice', 300, 'running', 1],
    ])('%s', (_label, checksAt, ciStatus, inProgress) => {
      usePullRequestStore.setState({
        rows: [makeRow('p1', { summary: held as never })],
      });
      usePullRequestStore.getState().applyPullRequestUpdate(
        makePayload({ id: 'p1', lastSummary: { ...stale, checksAt, title: 'renamed' } as never })
      );
      const summary = usePullRequestStore.getState().rows[0].summary;
      expect(summary.ciStatus).toBe(ciStatus);
      expect(summary.checks.inProgress).toBe(inProgress);
      // Everything outside the checks slice still lands.
      expect(summary.title).toBe('renamed');
    });

    it('applies a slice with no checksAt, as before the field existed', () => {
      usePullRequestStore.setState({ rows: [makeRow('p1', { summary: held as never })] });
      usePullRequestStore
        .getState()
        .applyPullRequestUpdate(makePayload({ id: 'p1', lastSummary: stale as never }));
      expect(usePullRequestStore.getState().rows[0].summary.ciStatus).toBe('running');
    });
  });
});

