// The pure halves of the stack batch submission: which rung gets handed to the
// external merge queue, and whether the repo takes stacks at all.
//
// The chain resolution itself (the SQL that reads GitHub's stack off the
// summary jsonb) and the decision rules are covered against a real DB in
// mergeQueue/evaluator.test.ts and mergeQueue/decide.test.ts respectively.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  planStackBatch,
  stackRungReady,
  type NativeStackChain,
  type StackChainMember,
} from '../services/mergeQueue/stack.js';
import {
  BATCH_REFUSAL_TTL_MS,
  noteStackBatchAccepted,
  noteStackBatchRefused,
  stackBatchingAllowed,
  _resetStackBatching,
} from '../services/repoStackBatching.js';

function member(o: Partial<StackChainMember> = {}): StackChainMember {
  return {
    pullRequestId: 'pr1',
    number: 1,
    position: 1,
    state: 'open',
    draft: false,
    entryStatus: 'queued',
    submitted: false,
    baseBranch: 'main',
    ready: true,
    ...o,
  };
}

/** A ready three-rung stack landing on `main`. */
function chain(overrides: Array<Partial<StackChainMember>> = []): NativeStackChain {
  const members = [1, 2, 3].map((position) =>
    member({
      pullRequestId: `pr${position}`,
      number: position,
      position,
      ...(overrides[position - 1] ?? {}),
    })
  );
  return { stackId: 'PRS_1', targetBase: 'main', members };
}

describe('stackRungReady', () => {
  const summary = (o: Record<string, unknown> = {}) =>
    ({ blockingReason: 'mergeable', mergeable: 'MERGEABLE', reviewDecision: null, ...o }) as never;

  it('accepts a rung with nothing individually blocking its merge', () => {
    expect(stackRungReady({ state: 'open', draft: false, summary: summary() })).toBe(true);
  });

  // The provider waits for branch protection itself ("it will be added to the
  // merge queue once all branch protection rules pass"), so holding the
  // submission until every rung is green would add a whole test cycle to the
  // workflow this feature exists to shorten.
  it('accepts a rung whose CI is still running or whose review is outstanding', () => {
    expect(
      stackRungReady({
        state: 'open',
        draft: false,
        summary: summary({ blockingReason: 'blocked', reviewDecision: 'REVIEW_REQUIRED' }),
      })
    ).toBe(true);
  });

  it.each([
    ['a conflict', { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }],
    ['requested changes', { reviewDecision: 'CHANGES_REQUESTED' }],
    ['a red required check', { blockingReason: 'checks_failed' }],
  ])('refuses a rung with %s — no fix run can happen inside the provider', (_label, o) => {
    expect(stackRungReady({ state: 'open', draft: false, summary: summary(o) })).toBe(false);
  });

  it('refuses a draft rung — the provider cannot merge one', () => {
    expect(stackRungReady({ state: 'open', draft: true, summary: summary() })).toBe(false);
  });
});

describe('planStackBatch', () => {
  // The provider lands the rung it is given plus everything beneath it, so the
  // top rung is the one submission that lands the whole stack. Submitting any
  // lower rung would land a prefix and leave the rest for another cycle.
  it('submits the TOP rung', () => {
    const plan = planStackBatch(chain(), 'pr3');
    expect(plan?.submitNumber).toBe(3);
    expect(plan?.isSubmitRung).toBe(true);
    expect(plan?.size).toBe(3);
  });

  it('marks the rungs below it as not the submit rung', () => {
    expect(planStackBatch(chain(), 'pr1')?.isSubmitRung).toBe(false);
    expect(planStackBatch(chain(), 'pr2')?.isSubmitRung).toBe(false);
  });

  it('withholds the submission while any rung has a real blocker', () => {
    const plan = planStackBatch(chain([{ ready: false }]), 'pr3');
    expect(plan?.submitNumber).toBeNull();
    // Still the submit rung — it is just not submittable yet, which is what
    // keeps the top rung waiting with the others rather than going alone.
    expect(plan?.isSubmitRung).toBe(true);
  });

  // The submission lands rungs whether or not Talyn is tracking them, so a
  // stack with an unqueued rung would merge a PR the user never asked to merge.
  it('withholds the submission while any rung is not in the queue', () => {
    expect(planStackBatch(chain([{ entryStatus: null }]), 'pr3')?.submitNumber).toBeNull();
  });

  describe('a live submission', () => {
    const submittedTop = () => chain([{}, {}, { submitted: true }]);

    it('covers every rung beneath it', () => {
      expect(planStackBatch(submittedTop(), 'pr1')?.coveredBy).toBe(3);
      expect(planStackBatch(submittedTop(), 'pr2')?.coveredBy).toBe(3);
    });

    // The submitted rung tracks the provider through R5b, which is the rule
    // that knows what to do when the batch is ejected. Marking it "covered"
    // would park it and nothing would ever take the PR back.
    it('never covers the rung that made it', () => {
      expect(planStackBatch(submittedTop(), 'pr3')?.coveredBy).toBeNull();
    });
  });

  it('declines a stack of one — that is just a PR', () => {
    const single: NativeStackChain = {
      stackId: 'PRS_1',
      targetBase: 'main',
      members: [member()],
    };
    expect(planStackBatch(single, 'pr1')).toBeNull();
  });

  it('declines when the PR is not in the chain it was resolved from', () => {
    expect(planStackBatch(chain(), 'pr-elsewhere')).toBeNull();
  });

  // A rung below the top that this workspace does not track would be merged by
  // the submission without ever having been enqueued. Positions are 1-based
  // from the base, so a set that does not read 1, 2, 3 … has a hole under it.
  it('declines when a rung below the top is missing', () => {
    const holed = chain();
    holed.members = [holed.members[0]!, { ...holed.members[2]! }]; // positions 1 and 3
    expect(planStackBatch(holed, 'pr3')).toBeNull();
  });

  it('declines when the bottom rung is missing entirely', () => {
    const topless = chain();
    topless.members = topless.members.slice(1); // positions 2 and 3
    expect(planStackBatch(topless, 'pr3')).toBeNull();
  });
});

describe('repoStackBatching', () => {
  beforeEach(() => _resetStackBatching());
  afterEach(() => vi.useRealTimers());

  // Optimistic: the cost of guessing wrong is one refusal comment on one PR,
  // which this module then remembers. Guessing the other way makes every stack
  // in every repo take N times longer with nothing to say why.
  it('allows batching for a repo it knows nothing about', () => {
    expect(stackBatchingAllowed('a', 'b', 'main')).toBe(true);
  });

  it('stops batching once the provider refuses', () => {
    noteStackBatchRefused('a', 'b', 'main', 'our merge queue will be unable to merge this PR');
    expect(stackBatchingAllowed('a', 'b', 'main')).toBe(false);
  });

  it('scopes the refusal to the repo and the landing branch', () => {
    noteStackBatchRefused('a', 'b', 'main', 'nope');
    expect(stackBatchingAllowed('a', 'b', 'release-1')).toBe(true);
    expect(stackBatchingAllowed('c', 'd', 'main')).toBe(true);
  });

  it('is case-insensitive about the repo, like every other repo-scoped tally', () => {
    noteStackBatchRefused('A', 'B', 'main', 'nope');
    expect(stackBatchingAllowed('a', 'b', 'main')).toBe(false);
  });

  // The reading decays and re-earns itself: a repo that switches the feature on
  // must start batching by itself, with no restart in the recovery path.
  it('re-allows batching once the refusal ages out', () => {
    vi.useFakeTimers();
    noteStackBatchRefused('a', 'b', 'main', 'nope');
    vi.advanceTimersByTime(BATCH_REFUSAL_TTL_MS + 1);
    expect(stackBatchingAllowed('a', 'b', 'main')).toBe(true);
  });

  it('forgets the refusal the moment a submission is accepted', () => {
    noteStackBatchRefused('a', 'b', 'main', 'nope');
    noteStackBatchAccepted('a', 'b', 'main');
    expect(stackBatchingAllowed('a', 'b', 'main')).toBe(true);
  });
});
