/**
 * The phase graph, tested without a database.
 *
 * This is why `decide` is pure. Every case here is a state the engine will reach in
 * production and several are states it only reaches when something has gone wrong —
 * a lens that died, a pull request closed mid-review, a fan-out wider than the
 * hardware allows. Reaching them through a real database would mean fabricating
 * sandbox failures; reaching them here is an object literal.
 */
import { describe, expect, it } from 'vitest';
import { decide, deferredSinceOf, hasDeferredUnit, settledUnitCount, type DecideState } from '../services/codeReview/decide.js';
import type { RunRow, RunStatus } from '../services/codeReview/store.js';

function run(overrides: Partial<RunRow>): RunRow {
  return {
    id: 'run-1',
    reviewId: 'rev-1',
    workspaceId: 'ws-1',
    cycle: 1,
    kind: 'lens',
    lens: 'correctness',
    chunkIndex: 0,
    chunkTotal: 1,
    status: 'running' as RunStatus,
    failureCode: null,
    provider: 'selfhosted',
    model: 'claude-sonnet-5',
    sandboxId: 'sb-1',
    remoteTaskId: null,
    remoteRunId: null,
    host: null,
    endpoint: null,
    eventCursor: 0,
    findingCount: 0,
    parseAttempts: 0,
    dispatchedAt: new Date(),
    capacityWaitSince: null,
    settledAt: null,
    createdAt: new Date(),
    ...overrides,
  } as RunRow;
}

function state(overrides: Partial<DecideState> = {}): DecideState {
  return {
    phase: 'reviewing',
    cycle: 1,
    preset: 'standard',
    lensKeys: ['correctness', 'security', 'reliability'],
    sweep: true,
    validate: true,
    chunkTotal: 1,
    runs: [],
    prOpen: true,
    ...overrides,
  };
}

describe('decide', () => {
  describe('the phases at rest', () => {
    it.each(['idle', 'ready', 'fixed', 'failed', 'cancelled'] as const)(
      'does nothing at %s',
      (phase) => {
        // Load-bearing: if this function could start a cycle, the ordinary
        // recovery sweep would be able to spend money nobody asked it to.
        expect(decide(state({ phase }))).toEqual([]);
      }
    );

    it('does nothing while a fix run is in flight', () => {
      // The fix is driven by its task's own status arriving as a domain event.
      // There is nothing here to poll and nothing to dispatch.
      expect(decide(state({ phase: 'fixing' }))).toEqual([]);
    });
  });

  it('walks queued → preparing → the units', () => {
    expect(decide(state({ phase: 'queued' }))).toEqual([
      { type: 'phase', to: 'preparing', code: 'preparing' },
    ]);
    expect(decide(state({ phase: 'preparing' }))).toEqual([{ type: 'prepare' }]);
  });

  describe('dispatching the lens units', () => {
    it('fires one unit per lens when there is room for all of them', () => {
      const actions = decide(state());
      expect(actions).toHaveLength(3);
      expect(actions.map((a) => (a.type === 'dispatch' ? a.unit.lens : null))).toEqual([
        'correctness',
        'security',
        'reliability',
      ]);
    });

    it.each([
      ['one chunk, three lenses', 1, ['correctness', 'security', 'reliability'], 3],
      ['four chunks, three lenses', 4, ['correctness', 'security', 'reliability'], 12],
      ['two chunks, six lenses', 2, ['correctness', 'security', 'reliability', 'performance', 'tests', 'style'], 12],
    ])('fires every missing unit at once, with no workspace cap (%s)', (_label, chunkTotal, lensKeys, expected) => {
      // No per-workspace ceiling: each box is metered against the user's compute
      // time, and a unit that finds the fleet full waits there for room.
      const actions = decide(state({ chunkTotal, lensKeys }));
      expect(actions).toHaveLength(expected);
      expect(actions.every((a) => a.type === 'dispatch')).toBe(true);
    });

    it('fires only the units that are missing, beside units already in flight', () => {
      const runs = [
        run({ id: 'a', lens: 'correctness', status: 'running' }),
        run({ id: 'b', lens: 'security', status: 'claimed', dispatchedAt: null, failureCode: 'capacity_deferred' }),
      ];
      expect(decide(state({ runs }))).toEqual([
        { type: 'dispatch', unit: { kind: 'lens', lens: 'reliability', chunkIndex: 0 } },
      ]);
    });

    it.each([
      ['waiting at the fleet', { status: 'claimed', dispatchedAt: null, failureCode: 'capacity_deferred', capacityWaitSince: new Date() }],
      ['waiting with no box', { status: 'claimed', dispatchedAt: null, failureCode: 'capacity_deferred', sandboxId: null }],
      ['mid-dispatch', { status: 'dispatching', dispatchedAt: null }],
    ] as const)('neither re-dispatches nor ends the phase while a unit is %s', (_label, waiting) => {
      // "Waiting for a runner" is a state, not an error, and not a missing unit:
      // its dispatch waits at the fleet, and the reconciler resumes a lost wait.
      const runs = [
        run({ id: 'a', lens: 'correctness', status: 'succeeded' }),
        run({ id: 'b', lens: 'security', status: 'succeeded' }),
        run({ id: 'c', lens: 'reliability', ...waiting }),
      ];
      expect(decide(state({ runs }))).toEqual([]);
    });

    it('fires a lens per chunk when the pull request was split', () => {
      const actions = decide(state({ chunkTotal: 2 }));
      expect(actions).toHaveLength(6);
      expect(new Set(actions.map((a) => (a.type === 'dispatch' ? a.unit.chunkIndex : -1)))).toEqual(
        new Set([0, 1])
      );
    });

    it('waits rather than re-dispatching while a unit is running', () => {
      const runs = ['correctness', 'security', 'reliability'].map((lens) =>
        run({ id: `run-${lens}`, lens, status: 'running' })
      );
      expect(decide(state({ runs }))).toEqual([]);
    });
  });

  describe('advancing past the lenses', () => {
    const settled = (status: RunStatus) =>
      ['correctness', 'security', 'reliability'].map((lens) =>
        run({ id: `run-${lens}`, lens, status })
      );

    it('goes to the sweep when the preset asked for one', () => {
      expect(decide(state({ runs: settled('succeeded') }))).toEqual([
        { type: 'phase', to: 'sweeping', code: 'reviewing_done' },
      ]);
    });

    it('skips straight to judging when the preset has no sweep', () => {
      expect(decide(state({ sweep: false, runs: settled('succeeded') }))).toEqual([
        { type: 'phase', to: 'validating', code: 'reviewing_done' },
      ]);
    });

    it('finishes immediately when the preset has neither — the Quick shape', () => {
      const actions = decide(
        state({
          preset: 'quick',
          lensKeys: ['correctness'],
          sweep: false,
          validate: false,
          runs: [run({ status: 'succeeded' })],
        })
      );
      expect(actions).toEqual([{ type: 'finish' }]);
    });

    it('advances on a PARTIAL phase, so one dead lens does not void the review', () => {
      // A review missing one lens is a smaller review. Refusing to show four good
      // findings because a fifth agent died is worse than useless.
      const runs = [
        run({ id: 'a', lens: 'correctness', status: 'succeeded' }),
        run({ id: 'b', lens: 'security', status: 'failed', failureCode: 'timeout' }),
        run({ id: 'c', lens: 'reliability', status: 'succeeded' }),
      ];
      expect(decide(state({ runs }))).toEqual([
        { type: 'phase', to: 'sweeping', code: 'reviewing_done' },
      ]);
    });

    it('fails the cycle when NOTHING reviewed, rather than showing an empty list', () => {
      // The one case where continuing is dishonest: with no reviewer output, an
      // empty findings list would read as a clean bill of health.
      expect(decide(state({ runs: settled('failed') }))).toEqual([
        {
          type: 'fail',
          code: 'no_reviewer_finished',
          message: 'No reviewer finished, so there is nothing to show yet. Try again.',
        },
      ]);
    });
  });

  describe('the sweep and the judge degrade rather than fail', () => {
    it('carries on to judging when the sweep died', () => {
      // The lenses' findings are already recorded, so a dead sweep costs breadth
      // and nothing else.
      const runs = [run({ id: 's', kind: 'sweep', lens: '', status: 'failed' })];
      expect(decide(state({ phase: 'sweeping', runs }))).toEqual([
        {
          type: 'phase',
          to: 'validating',
          code: 'sweep_failed',
          message: 'Continuing with what the reviewers found.',
        },
      ]);
    });

    it('finishes when the judge died, leaving the candidates unjudged', () => {
      const runs = [run({ id: 'j', kind: 'validate', lens: '', status: 'failed' })];
      expect(decide(state({ phase: 'validating', runs }))).toEqual([
        { type: 'finish', message: 'Continuing with what the reviewers found.' },
      ]);
    });

    it('finishes normally once the judge has ruled', () => {
      const runs = [run({ id: 'j', kind: 'validate', lens: '', status: 'succeeded' })];
      expect(decide(state({ phase: 'validating', runs }))).toEqual([{ type: 'finish' }]);
    });
  });

  describe('a pull request that closed underneath the review', () => {
    it('fails an in-flight cycle with a reason a person can read', () => {
      expect(decide(state({ prOpen: false }))).toEqual([
        {
          type: 'fail',
          code: 'pr_closed',
          message: 'The pull request was closed while the review was running.',
        },
      ]);
    });

    it.each(['ready', 'failed', 'cancelled'] as const)(
      'leaves a review already at %s alone',
      (phase) => {
        // Findings on a merged pull request are still worth reading, and a closed
        // one must not rewrite history into a failure.
        expect(decide(state({ phase, prOpen: false }))).toEqual([]);
      }
    );

    it('leaves an unreviewed pull request alone', () => {
      expect(decide(state({ phase: 'idle', prOpen: false }))).toEqual([]);
    });
  });

  describe('units of an older cycle are invisible', () => {
    it('re-dispatches when the runs on record belong to the previous cycle', () => {
      // Exactly what `cycle` exists for: without it the claim key would find the
      // old rows and the review would "finish" without reviewing anything.
      const stale = ['correctness', 'security', 'reliability'].map((lens) =>
        run({ id: `old-${lens}`, lens, cycle: 1, status: 'succeeded' })
      );
      const actions = decide(state({ cycle: 2, runs: stale }));
      expect(actions).toHaveLength(3);
      expect(actions.every((a) => a.type === 'dispatch')).toBe(true);
    });
  });
});

describe('progress helpers', () => {
  it('counts only the settled units of the current cycle', () => {
    const runs = [
      run({ id: 'a', cycle: 1, status: 'succeeded' }),
      run({ id: 'b', cycle: 1, status: 'failed' }),
      run({ id: 'c', cycle: 1, status: 'running' }),
      run({ id: 'd', cycle: 0, status: 'succeeded' }),
    ];
    expect(settledUnitCount(runs, 1)).toBe(2);
  });

  it('spots a unit waiting for a runner, and only that', () => {
    // A claim with no dispatch time is waiting; one WITH a dispatch time had a
    // sandbox. The column exists to keep those apart.
    expect(hasDeferredUnit([run({ status: 'claimed', dispatchedAt: null })], 1)).toBe(true);
    expect(hasDeferredUnit([run({ status: 'claimed', dispatchedAt: new Date() })], 1)).toBe(false);
    expect(hasDeferredUnit([run({ status: 'running' })], 1)).toBe(false);
    expect(hasDeferredUnit([run({ status: 'dispatching', dispatchedAt: null })], 1)).toBe(false);
    expect(hasDeferredUnit([run({ status: 'claimed', dispatchedAt: null, cycle: 0 })], 1)).toBe(false);
  });

  describe('when the wait for a runner began', () => {
    const early = new Date('2026-11-23T10:00:00Z');
    const late = new Date('2026-11-23T10:05:00Z');
    const waiting = (over: Partial<RunRow>) =>
      run({ status: 'claimed', dispatchedAt: null, failureCode: 'capacity_deferred', ...over });

    it.each([
      ['no unit waits', [run({ status: 'running' })], null],
      ['a waiting unit records no start', [waiting({ capacityWaitSince: null })], null],
      ['one unit waits', [waiting({ capacityWaitSince: late })], late],
      ['the longest wait wins', [waiting({ id: 'a', capacityWaitSince: late }), waiting({ id: 'b', capacityWaitSince: early })], early],
      ['a dispatched unit no longer counts', [run({ status: 'running', capacityWaitSince: early }), waiting({ capacityWaitSince: late })], late],
      ['an earlier cycle does not count', [waiting({ cycle: 0, capacityWaitSince: early }), waiting({ capacityWaitSince: late })], late],
    ])('%s', (_label, runs, expected) => {
      expect(deferredSinceOf(runs, 1)).toEqual(expected);
    });
  });
});
