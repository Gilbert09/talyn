import { describe, expect, it } from 'vitest';
import {
  PR_PRIORITY_GATE_RANK,
  PR_PRIORITY_WEIGHTS,
  REVIEW_RANK_FEATURES,
  PR_PRIORITY_REASON_LABEL,
  agePoints,
  sizePoints,
  buildPRPriorityMap,
  comparePRByPriority,
  describePRPriorityReason,
  humaniseWait,
  scorePRForReview,
  type PRPriorityGate,
  type PRPriorityReason,
  type PRPriorityTarget,
  type ReviewRankProfile,
} from '@talyn/shared';

/** A fixed clock — every assertion here must be reproducible at any wall time. */
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

type RowOpts = Partial<PRPriorityTarget['summary']> & {
  id?: string;
  taskId?: string | null;
  mergeQueued?: boolean;
  /** Hours since the review was requested. Defaults to "just now". */
  waitedHours?: number;
  firstSeenAt?: string | null;
};

function row(opts: RowOpts = {}): PRPriorityTarget {
  const { id, taskId, mergeQueued, waitedHours, firstSeenAt, ...summary } = opts;
  return {
    id: id ?? 'pr-1',
    owner: 'acme',
    repo: 'widgets',
    taskId: taskId ?? null,
    mergeQueued: mergeQueued ?? false,
    createdAt: hoursAgo(waitedHours ?? 0),
    reviewRequestedFirstSeenAt: firstSeenAt,
    summary: {
      author: 'sarah',
      draft: false,
      createdAt: hoursAgo(waitedHours ?? 0),
      mergeable: 'MERGEABLE',
      blockingReason: 'mergeable',
      effectiveReviewDecision: 'REVIEW_REQUIRED',
      checks: { total: 8, passed: 8, failed: 0, inProgress: 0, skipped: 0 },
      ...summary,
    },
  };
}

const ctx = { now: NOW };

/**
 * A fitted profile whose weights isolate ONE feature, so a fixture can prove
 * that feature reaches the chip. `sd: 1` / `mean: 0` makes standardisation the
 * identity, which keeps the arithmetic in these tests readable.
 */
function learned(feature: (typeof REVIEW_RANK_FEATURES)[number], over: Partial<ReviewRankProfile> = {}): ReviewRankProfile {
  const weights = REVIEW_RANK_FEATURES.map((f) => (f === feature ? 3 : 0));
  return {
    authorAffinity: {},
    dirAffinity: {},
    repoAffinity: {},
    ...over,
    featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    model: {
      installed: true,
      nEvents: 10_000,
      weights,
      cvAccuracy: 0.8,
      baselineAccuracy: 0.5,
    },
  };
}
const gateOf = (r: PRPriorityTarget) => scorePRForReview(r, ctx).gate;
const reasonsOf = (r: PRPriorityTarget) =>
  scorePRForReview(r, ctx).terms.map((t) => t.reason);

describe('scorePRForReview — gates', () => {
  it.each<[string, RowOpts, PRPriorityGate]>([
    ['a plain green PR is the working set', {}, 'actionable'],
    ['a draft is never ready', { draft: true }, 'not_ready'],
    ['merge conflicts belong to the author', { mergeable: 'CONFLICTING' }, 'waiting_on_author'],
    [
      'required checks failing belong to the author',
      { blockingReason: 'checks_failed', checks: { total: 8, passed: 6, failed: 2, inProgress: 0, skipped: 0 } },
      'waiting_on_author',
    ],
    [
      'changes already requested belong to the author',
      { effectiveReviewDecision: 'CHANGES_REQUESTED' },
      'waiting_on_author',
    ],
    ['a queued PR is blocking somebody', { mergeQueued: true }, 'blocking_others'],
    [
      'armed auto-merge makes your approval the merge',
      { autoMergeBy: 'sarah' },
      'blocking_others',
    ],
    [
      'the bottom rung of a stack is blocking its rungs',
      { stack: { size: 3, position: 1 } },
      'blocking_others',
    ],
    [
      'a MIDDLE rung is not — the one below it is what is blocking',
      { stack: { size: 3, position: 2 } },
      'actionable',
    ],
    [
      'a one-PR stack blocks nothing',
      { stack: { size: 1, position: 1 } },
      'actionable',
    ],
  ])('%s', (_name, opts, expected) => {
    expect(gateOf(row(opts))).toBe(expected);
  });

  it('suppresses a PR a cloud agent is still pushing commits to', () => {
    const r = row({ taskId: 'task-1' });
    const active = { now: NOW, isTaskActive: (id: string) => id === 'task-1' };
    expect(scorePRForReview(r, active).gate).toBe('not_ready');
    expect(scorePRForReview(r, active).terms.map((t) => t.reason)).toContain('agent_running');
  });

  it('does not suppress a PR whose task has finished', () => {
    const r = row({ taskId: 'task-1' });
    expect(scorePRForReview(r, { now: NOW, isTaskActive: () => false }).gate).toBe('actionable');
  });

  it('does not suppress on a task id it cannot resolve', () => {
    // No `isTaskActive` at all — a task we cannot see is not evidence of one
    // in flight, and guessing would bury a reviewable PR.
    expect(gateOf(row({ taskId: 'task-1' }))).toBe('actionable');
  });

  it('not_ready outranks waiting_on_author for a conflicted draft', () => {
    expect(gateOf(row({ draft: true, mergeable: 'CONFLICTING' }))).toBe('not_ready');
  });

  it('a conflicted PR never reaches blocking_others, however queued', () => {
    expect(gateOf(row({ mergeQueued: true, mergeable: 'CONFLICTING' }))).toBe('waiting_on_author');
  });

  it('names exactly one reason for a multiply-blocked PR', () => {
    const terms = scorePRForReview(
      row({
        mergeable: 'CONFLICTING',
        blockingReason: 'checks_failed',
        effectiveReviewDecision: 'CHANGES_REQUESTED',
      }),
      ctx,
    ).terms.filter((t) => t.gateMarker);
    expect(terms).toHaveLength(1);
    expect(terms[0].reason).toBe('merge_conflicts');
  });
});

describe('scorePRForReview — state adjustments', () => {
  it('rewards a fully green PR', () => {
    expect(reasonsOf(row())).toContain('checks_green');
  });

  it('does not call a PR green while checks are still running', () => {
    const r = row({ checks: { total: 8, passed: 4, failed: 0, inProgress: 4, skipped: 0 } });
    expect(reasonsOf(r)).toContain('checks_running');
    expect(reasonsOf(r)).not.toContain('checks_green');
  });

  it('says nothing about checks when the PR has none', () => {
    const r = row({ checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 } });
    expect(reasonsOf(r)).not.toContain('checks_green');
    expect(reasonsOf(r)).not.toContain('checks_running');
  });

  it('penalises an unresolved HUMAN thread more than a bot one', () => {
    const human = scorePRForReview(row({ unresolvedHumanReviewThreads: 2 }), ctx).score;
    const bot = scorePRForReview(row({ unresolvedBotReviewThreads: 2 }), ctx).score;
    const clean = scorePRForReview(row(), ctx).score;
    expect(human).toBeLessThan(bot);
    expect(bot).toBeLessThan(clean);
  });

  it('treats an absent thread split as unknown, not as zero threads', () => {
    // A row cached before the split shipped must score exactly like one with
    // no threads — never be credited for cleanliness it has not demonstrated,
    // and never be penalised either.
    const unknown = scorePRForReview(row(), ctx);
    expect(unknown.terms.map((t) => t.reason)).not.toContain('human_threads');
    expect(unknown.terms.map((t) => t.reason)).not.toContain('bot_threads');
  });

  it('rewards a direct request over a team one', () => {
    const direct = scorePRForReview(
      row({ reviewRequestVia: { direct: true, teams: [] } }),
      ctx,
    ).score;
    const team = scorePRForReview(
      row({ reviewRequestVia: { direct: false, teams: ['posthog/core'] } }),
      ctx,
    ).score;
    expect(direct).toBeGreaterThan(team);
  });

  it('rewards being the last approval needed', () => {
    expect(reasonsOf(row({ effectiveReviewDecision: 'APPROVED' }))).toContain('last_approval');
  });

  it('prefers effectiveReviewDecision over the raw one', () => {
    const r = row({ reviewDecision: 'REVIEW_REQUIRED', effectiveReviewDecision: 'APPROVED' });
    expect(reasonsOf(r)).toContain('last_approval');
  });

  it('demotes a bot author', () => {
    expect(reasonsOf(row({ author: 'dependabot[bot]' }))).toContain('bot_author');
    expect(reasonsOf(row({ author: 'sarah' }))).not.toContain('bot_author');
  });

  it('scales the stack reward with how many PRs are blocked, then caps it', () => {
    const two = scorePRForReview(row({ stack: { size: 3, position: 1 } }), ctx).score;
    const five = scorePRForReview(row({ stack: { size: 6, position: 1 } }), ctx).score;
    const twenty = scorePRForReview(row({ stack: { size: 21, position: 1 } }), ctx).score;
    expect(five).toBeGreaterThan(two);
    expect(twenty).toBe(five); // both past the cap
  });
});

describe('agePoints', () => {
  it.each([
    [0, 0],
    [3.9, 0],
    [4, 4],
    [11.9, 4],
    [12, 10],
    [24, 10],
    [47.9, 10],
    [48, 14],
    [119.9, 14],
    [120, 16],
    [335.9, 16],
  ])('%sh → %s points', (hours, expected) => {
    expect(agePoints(hours)).toBe(expected);
  });

  it('DECAYS past two weeks rather than climbing forever', () => {
    // Without this the list becomes a graveyard sorted by neglect, with the
    // single most-abandoned request permanently on top.
    expect(agePoints(336)).toBeLessThan(agePoints(335));
    expect(agePoints(10_000)).toBe(agePoints(336));
  });

  it('never rewards a negative or non-finite age', () => {
    expect(agePoints(-5)).toBe(0);
    expect(agePoints(Number.NaN)).toBe(0);
  });

  it('a three-week-old request does not outrank a fresh, green, direct one', () => {
    const ancient = scorePRForReview(row({ waitedHours: 24 * 21 }), ctx);
    const fresh = scorePRForReview(
      row({ waitedHours: 6, reviewRequestVia: { direct: true, teams: [] } }),
      ctx,
    );
    expect(fresh.score).toBeGreaterThan(ancient.score);
  });
});

describe('the age basis', () => {
  it('prefers when the review was REQUESTED over when the PR was opened', () => {
    // A three-week-old PR you were added to an hour ago has waited an hour.
    const r = row({ waitedHours: 24 * 21, firstSeenAt: hoursAgo(1) });
    expect(reasonsOf(r)).not.toContain('waited');
  });

  it('falls back to the open date when the request time is unknown', () => {
    const r = row({ waitedHours: 30, firstSeenAt: null });
    const waited = scorePRForReview(r, ctx).terms.find((t) => t.reason === 'waited');
    expect(waited?.points).toBe(agePoints(30));
  });

  it('ignores an unparseable timestamp instead of scoring it as 1970', () => {
    const r = row();
    r.summary.createdAt = 'not a date';
    r.createdAt = 'also not a date';
    expect(reasonsOf(r)).not.toContain('waited');
  });
});

describe('humaniseWait', () => {
  it.each([
    [0.25, '15m'],
    [1, '1h'],
    [30, '30h'],
    [48, '2d'],
    [24 * 9, '9d'],
  ] as Array<[number, string]>)('%sh → %s', (hours, expected) => {
    expect(humaniseWait(hours)).toBe(expected);
  });
});

describe('the reason vocabulary', () => {
  it('has a phrase for every reason', () => {
    // A total Record makes a MISSING phrase a compile error; this catches the
    // other half — a phrase that is present but empty.
    for (const [reason, label] of Object.entries(PR_PRIORITY_REASON_LABEL)) {
      expect(label.trim(), reason).not.toBe('');
    }
  });

  it('can produce every reason from some real row', () => {
    // The guard against a weight change silently orphaning a chip the UI still
    // has a string for.
    const fixtures: Array<[PRPriorityReason, PRPriorityTarget, typeof ctx]> = [
      ['unblocks_stack', row({ stack: { size: 3, position: 1 } }), ctx],
      ['in_merge_queue', row({ mergeQueued: true }), ctx],
      ['auto_merge_armed', row({ autoMergeBy: 'sarah' }), ctx],
      ['merge_conflicts', row({ mergeable: 'CONFLICTING' }), ctx],
      ['checks_failed', row({ blockingReason: 'checks_failed' }), ctx],
      ['changes_requested', row({ effectiveReviewDecision: 'CHANGES_REQUESTED' }), ctx],
      ['draft', row({ draft: true }), ctx],
      [
        'agent_running',
        row({ taskId: 't1' }),
        { now: NOW, isTaskActive: () => true } as typeof ctx,
      ],
      ['checks_green', row(), ctx],
      [
        'checks_running',
        row({ checks: { total: 4, passed: 1, failed: 0, inProgress: 3, skipped: 0 } }),
        ctx,
      ],
      ['last_approval', row({ effectiveReviewDecision: 'APPROVED' }), ctx],
      ['direct_request', row({ reviewRequestVia: { direct: true, teams: [] } }), ctx],
      ['human_threads', row({ unresolvedHumanReviewThreads: 1 }), ctx],
      ['bot_threads', row({ unresolvedBotReviewThreads: 1 }), ctx],
      ['bot_author', row({ author: 'renovate[bot]' }), ctx],
      ['size', row({ additions: 10, deletions: 2 }), ctx],
      [
        're_review',
        row({ viewerLatestReview: { state: 'CHANGES_REQUESTED', submittedAt: null } }),
        ctx,
      ],
      [
        'your_threads',
        row({ unresolvedHumanReviewThreads: 2, unresolvedThreadsOpenedByViewer: 2 }),
        ctx,
      ],
      ['waited', row({ waitedHours: 30 }), ctx],
      [
        'known_author',
        row({ author: 'sarah' }),
        {
          now: NOW,
          profile: learned('authorAffinity', {
            authorAffinity: { sarah: { gave: 30, got: 0 } },
          }),
        } as typeof ctx,
      ],
      [
        'reviews_you',
        row({ author: 'sarah' }),
        {
          now: NOW,
          profile: learned('reciprocity', {
            authorAffinity: { sarah: { gave: 0, got: 30 } },
          }),
        } as typeof ctx,
      ],
      [
        'known_files',
        row({ topDirs: ['packages/backend'] }),
        {
          now: NOW,
          profile: learned('pathFamiliarity', {
            dirAffinity: { 'packages/backend': 10 },
          }),
        } as typeof ctx,
      ],
      [
        'your_repo',
        row(),
        {
          now: NOW,
          profile: learned('repoAffinity', { repoAffinity: { 'acme/widgets': 0.9 } }),
        } as typeof ctx,
      ],
      [
        'their_team',
        row({ reviewRequestVia: { direct: false, teams: ['posthog/hogql'] } }),
        {
          now: NOW,
          profile: learned('teamAffinity', {
            teamAffinity: { 'posthog/hogql': { gave: 30, got: 30 } },
          }),
        } as typeof ctx,
      ],
      [
        'quick_for_you',
        row({ additions: 500, deletions: 200 }),
        { now: NOW, profile: learned('logSize') } as typeof ctx,
      ],
    ];

    const covered = new Set<string>();
    for (const [reason, r, c] of fixtures) {
      const produced = scorePRForReview(r, c).terms.map((t) => t.reason);
      expect(produced, `fixture for ${reason}`).toContain(reason);
      covered.add(reason);
    }
    expect([...covered].sort()).toEqual(Object.keys(PR_PRIORITY_REASON_LABEL).sort());
  });

  it('folds a count or duration into the phrase', () => {
    const stack = scorePRForReview(row({ stack: { size: 4, position: 1 } }), ctx);
    const term = stack.terms.find((t) => t.reason === 'unblocks_stack')!;
    expect(describePRPriorityReason(term)).toBe('Unblocks others 3');

    const waited = scorePRForReview(row({ waitedHours: 72 }), ctx);
    expect(describePRPriorityReason(waited.terms.find((t) => t.reason === 'waited')!)).toBe(
      'Waited 3d',
    );
  });
});

describe('topReason — the chip', () => {
  it('names the largest positive term', () => {
    const v = scorePRForReview(
      row({ waitedHours: 200, reviewRequestVia: { direct: true, teams: [] } }),
      ctx,
    );
    expect(v.topReason?.reason).toBe('waited'); // 16 beats green's 8 and direct's 8
  });

  it('explains a suppressed PR rather than leaving the cell blank', () => {
    // The failure PRioritizer's user study died of: an order nobody can argue
    // with because nothing says why.
    expect(scorePRForReview(row({ draft: true }), ctx).topReason?.reason).toBe('draft');
    expect(scorePRForReview(row({ mergeable: 'CONFLICTING' }), ctx).topReason?.reason).toBe(
      'merge_conflicts',
    );
  });

  it('lets the gate marker win over a positive term in a demoted band', () => {
    // A buried draft whose chip reads "All checks green" explains the opposite
    // of what the ordering just did to it.
    const v = scorePRForReview(row({ draft: true }), ctx);
    expect(v.terms.some((t) => t.reason === 'checks_green')).toBe(true);
    expect(v.topReason?.reason).toBe('draft');
  });

  it('also in a PROMOTED band — armed auto-merge is why that row is on top', () => {
    // Not "All checks green", which is true of half the list and says nothing
    // about why this row jumped it.
    const v = scorePRForReview(row({ autoMergeBy: 'sarah', waitedHours: 200 }), ctx);
    expect(v.topReason?.reason).toBe('auto_merge_armed');
  });

  it('lets a scoring term win where the gate has no marker to give', () => {
    // The stack case: `unblocks_stack` scores rather than marking, because its
    // members differ in HOW MUCH they block, and the count is the useful part.
    const v = scorePRForReview(row({ stack: { size: 4, position: 1 } }), ctx);
    expect(v.topReason?.reason).toBe('unblocks_stack');
    expect(v.topReason?.detail).toBe('3');
  });

  it('falls back to a negative when a row has nothing good to say', () => {
    const v = scorePRForReview(
      row({
        author: 'dependabot[bot]',
        checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
      }),
      ctx,
    );
    expect(v.topReason?.reason).toBe('bot_author');
  });
});

describe('degenerate rows', () => {
  it('scores a row cached before any of this shipped, without throwing', () => {
    const bare: PRPriorityTarget = { id: 'old', summary: { title: 'x' } as never };
    const v = scorePRForReview(bare, ctx);
    // Neither promoted on evidence it does not have, nor buried for it.
    expect(v.gate).toBe('actionable');
    expect(v.score).toBe(0);
    expect(v.topReason).toBeNull();
  });

  it('tolerates a completely absent summary', () => {
    const bare = { id: 'old' } as unknown as PRPriorityTarget;
    expect(() => scorePRForReview(bare, ctx)).not.toThrow();
  });
});

describe('purity', () => {
  it('gives an identical verdict for identical input', () => {
    expect(scorePRForReview(row({ waitedHours: 30 }), ctx)).toEqual(
      scorePRForReview(row({ waitedHours: 30 }), ctx),
    );
  });

  it('does not read the wall clock — only ctx.now', () => {
    const r = row({ waitedHours: 30 });
    const a = scorePRForReview(r, { now: NOW });
    // +100h pushes the same row from the 12-48h band into the 120h+ one. If
    // the age term read Date.now() instead of ctx.now the two would agree.
    const b = scorePRForReview(r, { now: NOW + 100 * 3_600_000 });
    expect(b.score).toBeGreaterThan(a.score);
  });
});

describe('comparePRByPriority', () => {
  const sortWith = (rows: PRPriorityTarget[]) => {
    const map = buildPRPriorityMap(rows, ctx);
    return rows.slice().sort((a, b) => comparePRByPriority(a, b, map));
  };

  it('puts the gates in order, whatever the points say', () => {
    const rows = [
      row({ id: 'draft', draft: true, reviewRequestVia: { direct: true, teams: [] }, waitedHours: 400 }),
      row({ id: 'conflicted', mergeable: 'CONFLICTING' }),
      row({ id: 'plain' }),
      row({ id: 'queued', mergeQueued: true }),
    ];
    expect(sortWith(rows).map((r) => r.id)).toEqual([
      'queued',
      'plain',
      'conflicted',
      'draft',
    ]);
  });

  it('is a total order — sorting a shuffled list twice agrees', () => {
    const rows = [
      row({ id: 'a', waitedHours: 30 }),
      row({ id: 'b', reviewRequestVia: { direct: true, teams: [] } }),
      row({ id: 'c', draft: true }),
      row({ id: 'd', mergeQueued: true }),
      row({ id: 'e', unresolvedHumanReviewThreads: 1 }),
      row({ id: 'f' }),
    ];
    const once = sortWith(rows).map((r) => r.id);
    const twice = sortWith(rows.slice().reverse()).map((r) => r.id);
    expect(twice).toEqual(once);
  });

  it('breaks a dead tie by id, so the list cannot jitter between polls', () => {
    // Two identical PRs opened at the same instant. Without the id tiebreak
    // they swap places on every poll, which reads as a bug rather than a tie.
    const rows = [row({ id: 'zzz' }), row({ id: 'aaa' })];
    expect(sortWith(rows).map((r) => r.id)).toEqual(['aaa', 'zzz']);
    expect(sortWith(rows.slice().reverse()).map((r) => r.id)).toEqual(['aaa', 'zzz']);
  });

  it('prefers the older PR when scores tie', () => {
    const rows = [
      row({ id: 'new', waitedHours: 5 }),
      row({ id: 'old', waitedHours: 11 }),
    ];
    // Both land in the same age band (4–12h), so the scores are equal and the
    // tiebreak decides.
    expect(sortWith(rows).map((r) => r.id)).toEqual(['old', 'new']);
  });

  it('is monotone — adding a positive signal never sends a PR down', () => {
    const plain = row({ id: 'plain' });
    const better = row({ id: 'better', reviewRequestVia: { direct: true, teams: [] } });
    const map = buildPRPriorityMap([plain, better], ctx);
    expect(comparePRByPriority(better, plain, map)).toBeLessThan(0);
  });

  it('sorts an unscored row last instead of throwing', () => {
    const known = row({ id: 'known' });
    const stranger = row({ id: 'stranger' });
    const map = buildPRPriorityMap([known], ctx);
    expect([stranger, known].sort((a, b) => comparePRByPriority(a, b, map)).map((r) => r.id)).toEqual(
      ['known', 'stranger'],
    );
  });
});

describe('buildPRPriorityMap', () => {
  it('scores every row exactly once', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const map = buildPRPriorityMap(rows, ctx);
    expect(map.size).toBe(3);
    expect([...map.keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('gate ranks', () => {
  it('orders the bands the way the comparator relies on', () => {
    expect(PR_PRIORITY_GATE_RANK.blocking_others).toBeGreaterThan(
      PR_PRIORITY_GATE_RANK.actionable,
    );
    expect(PR_PRIORITY_GATE_RANK.actionable).toBeGreaterThan(
      PR_PRIORITY_GATE_RANK.waiting_on_author,
    );
    expect(PR_PRIORITY_GATE_RANK.waiting_on_author).toBeGreaterThan(
      PR_PRIORITY_GATE_RANK.not_ready,
    );
  });
});


describe('sizePoints', () => {
  it.each([
    [0, 8],
    [100, 8],
    [101, 3],
    [400, 3],
    [401, 0],
    [800, 0],
    [801, -6],
    [5000, -6],
  ])('%s lines → %s points', (lines, expected) => {
    expect(sizePoints(lines)).toBe(expected);
  });

  it('treats UNKNOWN as unknown, not as small', () => {
    // The trap: a row cached before `additions` shipped has no size, and
    // scoring that as the smallest possible diff would float every
    // un-refreshed PR straight to the top of the list.
    expect(sizePoints(undefined)).toBe(0);
    expect(sizePoints(Number.NaN)).toBe(0);
  });
});

describe('real diff size', () => {
  it('scores a small PR above a huge one', () => {
    const small = scorePRForReview(row({ additions: 30, deletions: 5 }), ctx).score;
    const huge = scorePRForReview(row({ additions: 2000, deletions: 900 }), ctx).score;
    expect(small).toBeGreaterThan(huge);
  });

  it('does NOT fall back to changedFiles, which disagrees where it matters', () => {
    // A one-line fix across twelve files vs a 900-line rewrite of one: by file
    // count the first is bigger, by lines the second is. Only lines are used.
    const manyFilesTinyDiff = scorePRForReview(row({ additions: 12, deletions: 0 }), ctx);
    expect(manyFilesTinyDiff.terms.find((t) => t.reason === 'size')?.points).toBe(8);
  });

  it('scores nothing for size when the row has never been refreshed', () => {
    expect(reasonsOf(row())).not.toContain('size');
  });

  it('counts a deletions-only PR', () => {
    const v = scorePRForReview(row({ deletions: 40 }), ctx);
    expect(v.terms.find((t) => t.reason === 'size')?.points).toBe(8);
  });
});

describe('re-review', () => {
  it('rewards a PR the viewer already asked for changes on', () => {
    const fresh = scorePRForReview(row(), ctx).score;
    const again = scorePRForReview(
      row({ viewerLatestReview: { state: 'CHANGES_REQUESTED', submittedAt: null } }),
      ctx,
    ).score;
    expect(again).toBeGreaterThan(fresh);
  });

  it('does not reward a stale APPROVAL', () => {
    // Approved, then re-requested, means the PR moved on — that is a fresh
    // look, not the tail of work already started.
    expect(
      reasonsOf(row({ viewerLatestReview: { state: 'APPROVED', submittedAt: null } })),
    ).not.toContain('re_review');
  });
});

describe('whose threads are open', () => {
  it('rewards threads the VIEWER opened and penalises other people’s', () => {
    const mine = scorePRForReview(
      row({ unresolvedHumanReviewThreads: 2, unresolvedThreadsOpenedByViewer: 2 }),
      ctx,
    );
    const theirs = scorePRForReview(row({ unresolvedHumanReviewThreads: 2 }), ctx);
    expect(mine.score).toBeGreaterThan(theirs.score);
  });

  it('nets the viewer’s own threads out of the human penalty', () => {
    // Otherwise the PR is penalised for exactly the threads that make it the
    // viewer's to come back to, and the two terms cancel to nothing.
    const allMine = scorePRForReview(
      row({ unresolvedHumanReviewThreads: 3, unresolvedThreadsOpenedByViewer: 3 }),
      ctx,
    );
    expect(allMine.terms.map((t) => t.reason)).not.toContain('human_threads');
    expect(allMine.terms.map((t) => t.reason)).toContain('your_threads');
  });

  it('still penalises the remainder when a thread is someone else’s', () => {
    const mixed = scorePRForReview(
      row({ unresolvedHumanReviewThreads: 3, unresolvedThreadsOpenedByViewer: 1 }),
      ctx,
    );
    expect(mixed.terms.map((t) => t.reason)).toContain('human_threads');
    expect(mixed.terms.map((t) => t.reason)).toContain('your_threads');
  });

  it('never goes negative when the counts disagree', () => {
    // Defensive: the two numbers come from different filters over the same
    // list and a future change could let the viewer count exceed the human one.
    const odd = scorePRForReview(
      row({ unresolvedHumanReviewThreads: 1, unresolvedThreadsOpenedByViewer: 5 }),
      ctx,
    );
    expect(odd.terms.map((t) => t.reason)).not.toContain('human_threads');
  });
});

describe('the learned term — its limits are the safety property', () => {
  /** A profile that loves this author as much as it possibly can. */
  const adoring = (author: string): ReviewRankProfile => ({
    authorAffinity: { [author]: { gave: 10_000, got: 10_000 } },
    dirAffinity: {},
    repoAffinity: { 'acme/widgets': 1 },
    teamAffinity: {},
    featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    model: {
      installed: true,
      nEvents: 10_000,
      // Absurd weights on every feature — far beyond anything a fit would
      // produce. The clamp has to hold against a model that has gone wrong,
      // not merely against a reasonable one.
      weights: [50, 50, 50, 50, 50, 50],
      cvAccuracy: 0.9,
      baselineAccuracy: 0.5,
    },
  });

  it('never moves a PR by more than the cap, however extreme the model', () => {
    const plain = scorePRForReview(row({ author: 'sarah' }), ctx).score;
    const loved = scorePRForReview(row({ author: 'sarah' }), {
      now: NOW,
      profile: adoring('sarah'),
    }).score;
    expect(Math.abs(loved - plain)).toBeLessThanOrEqual(PR_PRIORITY_WEIGHTS.learnedCap);
  });

  it('cannot promote a PR out of its gate', () => {
    // The model learns whether you RESPOND, not what you should have read. Left
    // unbounded it entrenches — the person you never get to sinks further. The
    // gate is what makes that bounded rather than self-reinforcing.
    const beloved = scorePRForReview(row({ author: 'sarah', draft: true }), {
      now: NOW,
      profile: adoring('sarah'),
    });
    expect(beloved.gate).toBe('not_ready');
  });

  it('cannot bury a PR that is blocking others', () => {
    const hated: ReviewRankProfile = {
      ...adoring('nobody'),
      authorAffinity: {},
      repoAffinity: {},
    };
    const v = scorePRForReview(row({ author: 'stranger', mergeQueued: true }), {
      now: NOW,
      profile: hated,
    });
    expect(v.gate).toBe('blocking_others');
  });

  it('does nothing at all without a profile', () => {
    const withProfile = scorePRForReview(row(), { now: NOW, profile: null });
    const without = scorePRForReview(row(), ctx);
    expect(withProfile).toEqual(without);
  });

  it('refuses to score without stored feature stats, rather than guessing', () => {
    // Weights fitted on standardised features are meaningless applied to raw
    // ones — it is arithmetic on mismatched units. The deterministic terms
    // still rank the list, so skipping is the honest answer.
    const noStats: ReviewRankProfile = {
      authorAffinity: { sarah: { gave: 100, got: 100 } },
      dirAffinity: {},
      repoAffinity: {},
      teamAffinity: {},
      featureStats: null,
      model: {
        installed: true,
        nEvents: 500,
        weights: [5, 5, 5, 5, 5, 5],
        cvAccuracy: 0.8,
        baselineAccuracy: 0.5,
      },
    };
    const v = scorePRForReview(row({ author: 'sarah' }), { now: NOW, profile: noStats });
    expect(v.terms.map((t) => t.reason)).not.toContain('known_author');
  });

  it('falls back to the PRIOR when the model was refused', () => {
    // A refusal is not an absence: the aggregates are still there, so the
    // shipped prior still ranks on them. What it stops is the fitted weights.
    const refused: ReviewRankProfile = {
      authorAffinity: { sarah: { gave: 200, got: 0 } },
      dirAffinity: {},
      repoAffinity: {},
      teamAffinity: {},
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
      model: {
        installed: false,
        nEvents: 12,
        weights: [0, 0, 0, 0, 0, 0],
        cvAccuracy: 0,
        baselineAccuracy: 0.5,
      },
    };
    const v = scorePRForReview(row({ author: 'sarah' }), { now: NOW, profile: refused });
    // The prior weights authorAffinity positively, so a well-known author still
    // ranks up even though the personal fit was thrown away.
    expect(v.terms.map((t) => t.reason)).toContain('known_author');
  });

  it('ranks a teammate above a stranger, all else equal', () => {
    // The thing the whole feature is for.
    const p: ReviewRankProfile = {
      authorAffinity: { sarah: { gave: 60, got: 40 }, stranger: { gave: 0, got: 1 } },
      dirAffinity: {},
      repoAffinity: {},
      teamAffinity: {},
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
      model: null,
    };
    const c = { now: NOW, profile: p };
    const teammate = scorePRForReview(row({ id: 'a', author: 'sarah' }), c);
    const stranger = scorePRForReview(row({ id: 'b', author: 'stranger' }), c);
    expect(teammate.score).toBeGreaterThan(stranger.score);
  });

  it('still lets age overtake affinity eventually', () => {
    // The anti-entrenchment guard: a stranger's PR left long enough must climb
    // past a teammate's fresh one, or the model quietly decides you never read
    // certain people again.
    const p: ReviewRankProfile = {
      authorAffinity: { sarah: { gave: 200, got: 200 } },
      dirAffinity: {},
      repoAffinity: {},
      teamAffinity: {},
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
      model: null,
    };
    const c = { now: NOW, profile: p };
    const freshTeammate = scorePRForReview(row({ id: 'a', author: 'sarah', waitedHours: 1 }), c);
    const oldStranger = scorePRForReview(
      row({ id: 'b', author: 'stranger', waitedHours: 100 }),
      c,
    );
    expect(oldStranger.score).toBeGreaterThan(freshTeammate.score);
  });
});

describe('the learned cap is calibrated against the age ramp', () => {
  it('sits below the age ramp maximum, which is what stops entrenchment', () => {
    // If the model could outweigh any amount of waiting, a person whose PRs the
    // viewer never gets to would sink further and further — and the model would
    // read its own effect back as confirmation. Age is the only term that rises
    // with nothing but time, so it has to be able to win.
    const maxAge = Math.max(...[0, 4, 12, 24, 48, 120, 200, 335].map(agePoints));
    expect(PR_PRIORITY_WEIGHTS.learnedCap).toBeLessThan(maxAge);
  });
});

describe('the chip can actually name the model', () => {
  /** A profile that likes this author, with a realistic installed model. */
  const likes = (author: string): ReviewRankProfile => ({
    authorAffinity: { [author]: { gave: 80, got: 80 } },
    dirAffinity: { 'posthog/hogql': 40 },
    repoAffinity: { 'acme/widgets': 0.8 },
    teamAffinity: {},
    featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    model: {
      installed: true,
      nEvents: 201,
      weights: [1, 0.8, 0.5, 0.3, 0.7, -0.3],
      cvAccuracy: 0.72,
      baselineAccuracy: 0.63,
    },
  });

  it('names the model on a PR the model likes, even against an older one', () => {
    // The bug this guards: age is ONE term worth up to 16, while the learned
    // signal is capped at 12 in total and split across five features — so
    // compared part-by-part, age wins essentially always. Every chip then
    // reads "Waited Nd", and a list the model genuinely reordered is
    // indistinguishable from a plain age sort.
    const v = scorePRForReview(
      row({ author: 'sarah', topDirs: ['posthog/hogql'], waitedHours: 30 }),
      { now: NOW, profile: likes('sarah') },
    );
    expect(v.topReason?.reason).not.toBe('waited');
    expect(
      ['known_author', 'reviews_you', 'known_files', 'your_repo', 'quick_for_you'],
    ).toContain(v.topReason!.reason);
  });

  it('still lets a long wait win when the model is indifferent', () => {
    // The collapse must not flip the opposite way: a PR nobody has touched for
    // a week, on an author the model has no opinion about, is a waiting PR.
    const v = scorePRForReview(row({ author: 'stranger', waitedHours: 200 }), {
      now: NOW,
      profile: likes('sarah'),
    });
    expect(v.topReason?.reason).toBe('waited');
  });

  it('keeps the FULL per-feature breakdown for the tooltip', () => {
    // Only the headline collapses. The tooltip still has to show which parts
    // of the model moved the row, or the explanation is just a different
    // opaque claim.
    const v = scorePRForReview(
      row({ author: 'sarah', topDirs: ['posthog/hogql'] }),
      { now: NOW, profile: likes('sarah') },
    );
    const learnedTerms = v.terms.filter((t) =>
      ['known_author', 'reviews_you', 'known_files', 'your_repo', 'quick_for_you'].includes(
        t.reason,
      ),
    );
    expect(learnedTerms.length).toBeGreaterThan(1);
  });

  it('names the collapsed group by its LARGEST component', () => {
    // "You review them often" is actionable; a generic "your profile likes
    // this" is not.
    const v = scorePRForReview(row({ author: 'sarah' }), {
      now: NOW,
      profile: likes('sarah'),
    });
    const fromModel = v.terms.filter((t) =>
      ['known_author', 'reviews_you', 'known_files', 'your_repo', 'quick_for_you'].includes(
        t.reason,
      ),
    );
    const largest = fromModel.reduce((a, b) => (Math.abs(b.points) > Math.abs(a.points) ? b : a));
    expect(v.topReason?.reason).toBe(largest.reason);
  });

  it('changes nothing when there is no model at all', () => {
    expect(scorePRForReview(row({ waitedHours: 30 }), ctx).topReason?.reason).toBe('waited');
  });
});

describe('machine-authored PRs', () => {
  it('trusts GitHub’s own answer over the login', () => {
    // The case that prompted this: PostHog's automation opens PRs as
    // `@PostHog`, an ORGANIZATION account whose name looks entirely human. The
    // old `[bot]`-suffix check scored it as a person and left a wall of
    // machine-authored PRs sitting at the top of the list.
    expect(reasonsOf(row({ author: 'PostHog', prAuthorIsBot: true }))).toContain('bot_author');
  });

  it('still catches the obvious suffix on rows cached before the field shipped', () => {
    expect(reasonsOf(row({ author: 'dependabot[bot]' }))).toContain('bot_author');
  });

  it('treats an UNKNOWN author as a person, not as a machine', () => {
    // The conservative direction: leave a PR in the list rather than demote one
    // nobody asked us to.
    expect(reasonsOf(row({ author: 'sarah' }))).not.toContain('bot_author');
  });

  it('lets GitHub OVERRIDE a misleading login either way', () => {
    // A human whose login happens to end in [bot] is vanishingly rare, but the
    // explicit field should win rather than be ANDed with a guess.
    expect(reasonsOf(row({ author: 'weird[bot]', prAuthorIsBot: false }))).not.toContain(
      'bot_author',
    );
  });

  it('still lets a machine PR that is blocking a stack surface', () => {
    // Heavier than the other adjustments, but deliberately short of a gate.
    const v = scorePRForReview(
      row({ author: 'renovate[bot]', stack: { size: 4, position: 1 } }),
      ctx,
    );
    expect(v.gate).toBe('blocking_others');
  });
});

describe('the requesting team', () => {
  const teamProfile = (rates: Record<string, { gave: number; got: number }>): ReviewRankProfile => ({
    authorAffinity: {},
    dirAffinity: {},
    repoAffinity: {},
    teamAffinity: rates,
    featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    model: null,
  });

  it('ranks a team you service above one you do not', () => {
    // The user's own framing: "I don't review PRs for team hogql these days."
    const p = teamProfile({
      'posthog/warehouse': { gave: 18, got: 20 },
      'posthog/hogql': { gave: 1, got: 40 },
    });
    const c = { now: NOW, profile: p };
    const serviced = scorePRForReview(
      row({ id: 'a', reviewRequestVia: { direct: false, teams: ['posthog/warehouse'] } }),
      c,
    );
    const ignored = scorePRForReview(
      row({ id: 'b', reviewRequestVia: { direct: false, teams: ['posthog/hogql'] } }),
      c,
    );
    expect(serviced.score).toBeGreaterThan(ignored.score);
  });

  it('takes the BEST-serviced team when several requested it', () => {
    // A PR is in front of you because of whichever team you actually answer.
    // Averaging would let a team you ignore dilute one you always service.
    const p = teamProfile({
      'posthog/good': { gave: 20, got: 20 },
      'posthog/ignored': { gave: 0, got: 50 },
    });
    const c = { now: NOW, profile: p };
    const both = scorePRForReview(
      row({ id: 'a', reviewRequestVia: { direct: false, teams: ['posthog/ignored', 'posthog/good'] } }),
      c,
    );
    const onlyGood = scorePRForReview(
      row({ id: 'b', reviewRequestVia: { direct: false, teams: ['posthog/good'] } }),
      c,
    );
    expect(both.score).toBe(onlyGood.score);
  });

  it('is a RATE, so a noisy team cannot buy rank with volume', () => {
    const p = teamProfile({
      'posthog/noisy': { gave: 10, got: 200 },
      'posthog/quiet': { gave: 4, got: 4 },
    });
    const c = { now: NOW, profile: p };
    const noisy = scorePRForReview(
      row({ id: 'a', reviewRequestVia: { direct: false, teams: ['posthog/noisy'] } }),
      c,
    );
    const quiet = scorePRForReview(
      row({ id: 'b', reviewRequestVia: { direct: false, teams: ['posthog/quiet'] } }),
      c,
    );
    expect(quiet.score).toBeGreaterThan(noisy.score);
  });

  it('says nothing about a team it has never seen', () => {
    const v = scorePRForReview(
      row({ reviewRequestVia: { direct: false, teams: ['posthog/brand-new'] } }),
      { now: NOW, profile: teamProfile({}) },
    );
    expect(v.terms.map((t) => t.reason)).not.toContain('their_team');
  });
});
