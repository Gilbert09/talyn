import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PRRow } from '../lib/api';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../stores/pullRequests';
import { mergeSummaryPatch } from '../lib/summaryPatch';

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


// Echoes arrive in bursts (one per queued PR on every enqueue or merge), so the
// sync hook buffers them and applies a batch in one store write.
describe('pull request store — applyPullRequestUpdates', () => {
  beforeEach(() => usePullRequestStore.setState({ rows: [] }));

  it('applies several echoes for one PR in arrival order, each on top of the last', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    usePullRequestStore.getState().applyPullRequestUpdates([
      // Two partial patches: dropping either one would lose its slice.
      makePayload({ id: 'p1', lastSummary: { title: 'first' } as never, mergeQueued: true }),
      makePayload({ id: 'p1', lastSummary: { draft: true } as never }),
      makePayload({ id: 'p1', lastSummary: { title: 'second' } as never }),
    ]);
    const [p1, p2] = usePullRequestStore.getState().rows;
    expect(p1.summary.title).toBe('second');
    expect(p1.summary.draft).toBe(true);
    expect(p1.mergeQueued).toBe(true);
    expect(p2.summary.title).toBe('PR p2');
  });

  it('writes the store once for a batch', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    const listener = vi.fn();
    const unsubscribe = usePullRequestStore.subscribe(listener);
    usePullRequestStore.getState().applyPullRequestUpdates([
      makePayload({ id: 'p1', lastSummary: { title: 'a' } as never }),
      makePayload({ id: 'p2', lastSummary: { title: 'b' } as never }),
    ]);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<PullRequestUpdatePayload>]>([
    ['the same summary', { lastSummary: { title: 'PR p1' } as never }],
    ['no summary at all', { lastSummary: undefined }],
    ['an empty summary slice', { lastSummary: {} }],
    ['the same flags', { lastSummary: undefined, mergeQueued: false, watching: false, authored: true }],
    ['an equal but freshly parsed queue payload', {
      lastSummary: undefined,
      mergeQueue: { status: 'queued', position: 3 } as never,
    }],
    ['an older checks slice', {
      lastSummary: { checks: { total: 1 }, checksAt: 50 } as never,
    }],
  ])('keeps identity and skips the write for an echo with %s', (_label, over) => {
    const held = makeRow('p1', {
      summary: { title: 'PR p1', checks: { total: 2 }, checksAt: 100 } as never,
      mergeQueue: { status: 'queued', position: 3 } as never,
    });
    const other = makeRow('p2');
    usePullRequestStore.setState({ rows: [held, other] });
    const before = usePullRequestStore.getState().rows;
    const listener = vi.fn();
    const unsubscribe = usePullRequestStore.subscribe(listener);
    usePullRequestStore.getState().applyPullRequestUpdates([makePayload({ id: 'p1', ...over })]);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(usePullRequestStore.getState().rows).toBe(before);
    expect(usePullRequestStore.getState().rows[0]).toBe(held);
  });

  it('replaces only the row that changed', () => {
    const p1 = makeRow('p1');
    const p2 = makeRow('p2');
    usePullRequestStore.setState({ rows: [p1, p2] });
    usePullRequestStore.getState().applyPullRequestUpdates([
      makePayload({ id: 'p1', lastSummary: { title: 'changed' } as never }),
      makePayload({ id: 'p2', lastSummary: { title: 'PR p2' } as never }),
    ]);
    const rows = usePullRequestStore.getState().rows;
    expect(rows[0]).not.toBe(p1);
    expect(rows[1]).toBe(p2);
  });

  it('keeps the held summary when the echo omits lastSummary', () => {
    // The merge queue's position broadcast sends only id/state/queue fields.
    const summary = { title: 'kept', checks: { total: 4 } } as PRRow['summary'];
    usePullRequestStore.setState({ rows: [makeRow('p1', { summary })] });
    usePullRequestStore.getState().applyPullRequestUpdates([
      makePayload({
        id: 'p1',
        lastSummary: undefined,
        mergeQueued: true,
        mergeQueue: { status: 'queued', position: 1 } as never,
      }),
    ]);
    const row = usePullRequestStore.getState().rows[0];
    expect(row.summary).toBe(summary);
    expect(row.mergeQueue).toEqual({ status: 'queued', position: 1 });
  });

  it.each<[string, PullRequestUpdatePayload[], boolean, string[]]>([
    ['an unknown open PR', [makePayload({ id: 'new' })], true, ['p1']],
    ['an unknown closed PR', [makePayload({ id: 'gone', state: 'closed' })], false, ['p1']],
    ['several unknown open PRs', [makePayload({ id: 'n1' }), makePayload({ id: 'n2' })], true, ['p1']],
    ['a held PR that merged', [makePayload({ id: 'p1', state: 'merged' })], false, []],
    [
      'a held PR that merged and then reopened in one batch',
      [makePayload({ id: 'p1', state: 'merged' }), makePayload({ id: 'p1', state: 'open' })],
      true,
      [],
    ],
  ])('refetch signal and remaining rows for %s', (_label, payloads, refetch, ids) => {
    usePullRequestStore.setState({ rows: [makeRow('p1')] });
    expect(usePullRequestStore.getState().applyPullRequestUpdates(payloads)).toBe(refetch);
    expect(usePullRequestStore.getState().rows.map((r) => r.id)).toEqual(ids);
  });

  it('applies the echoes around a removal to the rows that remain', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2'), makeRow('p3')] });
    usePullRequestStore.getState().applyPullRequestUpdates([
      makePayload({ id: 'p1', lastSummary: { title: 'one' } as never }),
      makePayload({ id: 'p2', state: 'closed' }),
      makePayload({ id: 'p3', lastSummary: { title: 'three' } as never }),
    ]);
    const rows = usePullRequestStore.getState().rows;
    expect(rows.map((r) => [r.id, r.summary.title])).toEqual([
      ['p1', 'one'],
      ['p3', 'three'],
    ]);
  });
});

describe('mergeSummaryPatch', () => {
  const held = { title: 'T', checks: { total: 2, passed: 2 }, checksAt: 100 } as PRRow['summary'];

  it.each<[string, Partial<PRRow['summary']> | undefined]>([
    ['an absent patch', undefined],
    ['an empty patch', {}],
    ['an equal scalar', { title: 'T' }],
    ['an equal nested object', { checks: { total: 2, passed: 2 } } as never],
    ['a stale checks slice', { checks: { total: 9 }, checksAt: 50 } as never],
  ])('returns the held object for %s', (_label, patch) => {
    expect(mergeSummaryPatch(held, patch)).toBe(held);
  });

  it.each<[string, Partial<PRRow['summary']>]>([
    ['a changed scalar', { title: 'U' }],
    ['a changed nested value', { checks: { total: 2, passed: 1 } } as never],
    ['a new key', { draft: true }],
  ])('returns a new object for %s', (_label, patch) => {
    const merged = mergeSummaryPatch(held, patch);
    expect(merged).not.toBe(held);
    expect(merged).toEqual({ ...held, ...patch });
  });
});
