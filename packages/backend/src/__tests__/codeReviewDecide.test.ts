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
import { decide, hasDeferredUnit, settledUnitCount, type DecideState } from '../services/codeReview/decide.js';
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
    unitsAllowed: 3,
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

    it('fires only as many as the pacing allows, and leaves the rest for later', () => {
      // The fleet is one box. The remainder has no row yet, so the next pass finds
      // it missing again — nothing is lost by firing fewer.
      const actions = decide(state({ unitsAllowed: 2 }));
      expect(actions).toHaveLength(2);
    });

    it('fires nothing at all when there is no room, rather than failing', () => {
      // "Waiting for a runner" is a state, not an error. A review that failed
      // because the box was busy would be indistinguishable from a broken one.
      expect(decide(state({ unitsAllowed: 0 }))).toEqual([]);
    });

    it('fires a lens per chunk when the pull request was split', () => {
      const actions = decide(state({ chunkTotal: 2, unitsAllowed: 99 }));
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
      expect(actions).toEqual([
        { type: 'phase', to: 'ready', code: 'reviewing_done' },
        { type: 'finish' },
      ]);
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
        {
          type: 'phase',
          to: 'ready',
          code: 'judge_failed',
          message: 'Continuing with what the reviewers found.',
        },
        { type: 'finish' },
      ]);
    });

    it('finishes normally once the judge has ruled', () => {
      const runs = [run({ id: 'j', kind: 'validate', lens: '', status: 'succeeded' })];
      expect(decide(state({ phase: 'validating', runs }))).toEqual([
        { type: 'phase', to: 'ready', code: 'validating_done' },
        { type: 'finish' },
      ]);
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
  });
});
