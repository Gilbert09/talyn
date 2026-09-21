import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PRStatusPill } from '../components/widgets/PRStatusPill';
import type { PRChecks } from '../lib/api';

const checks = (over: Partial<PRChecks> = {}): PRChecks => ({
  total: 0,
  passed: 0,
  failed: 0,
  inProgress: 0,
  skipped: 0,
  ...over,
});

afterEach(cleanup);

describe('PRStatusPill', () => {
  it('renders a red "N/M failing" pill when checks are genuinely failing', () => {
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 167, passed: 165, failed: 2 })}
      />
    );
    expect(screen.getByText('2/167 failing')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('red-500');
  });

  it('does NOT render a red "0 failing" pill when checks_failed is stale (failed === 0)', () => {
    // Regression: the last failing check re-ran green, so `checks` refreshed to
    // 0 failing, but `blockingReason` lagged at 'checks_failed' (the row store
    // shallow-merges partial summaries). A red "0/N failing" is self-
    // contradictory — it must read Ready/green instead.
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 167, passed: 167, failed: 0 })}
      />
    );
    expect(screen.queryByText('0/167 failing')).toBeNull();
    expect(screen.getByText('Ready')).toBeTruthy();
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('emerald-500');
    expect(cls).not.toContain('red-500');
  });

  it('shows "N running" (not "Review") when blocked only by in-flight required checks', () => {
    // Regression: an APPROVED PR reads mergeStateStatus BLOCKED while its check
    // rollup is PENDING, so the backend returns blockingReason 'blocked'. The
    // immediate gate is CI, not a review — show the running spinner.
    render(
      <PRStatusPill
        blockingReason="blocked"
        checks={checks({ total: 131, passed: 40, inProgress: 91 })}
      />
    );
    expect(screen.getByText('91/131 running')).toBeTruthy();
    expect(screen.queryByText('Review')).toBeNull();
    expect(screen.getByRole('button').className).toContain('blue-500');
  });

  it('still shows "Review" when blocked and no checks are running', () => {
    render(<PRStatusPill blockingReason="blocked" checks={checks({ total: 5, passed: 5 })} />);
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('amber-500');
  });

  it('does NOT render a green "Ready" pill when a stale mergeable hides failing checks', () => {
    // The reported bug: an incremental {checks}-only update advanced `failed` to
    // 26 while `blockingReason` lagged at 'mergeable', so the pill read a green
    // "Ready" beside 26 failing checks. Required failures (non-UNSTABLE) must
    // surface as red.
    render(
      <PRStatusPill
        blockingReason="mergeable"
        checks={checks({ total: 167, passed: 141, failed: 26 })}
        mergeStateStatus="BLOCKED"
      />
    );
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText('26/167 failing')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('red-500');
  });

  it('reads non-required (green) for a stale mergeable when UNSTABLE', () => {
    render(
      <PRStatusPill
        blockingReason="mergeable"
        checks={checks({ total: 167, passed: 141, failed: 26 })}
        mergeStateStatus="UNSTABLE"
      />
    );
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText('26 non-required')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('emerald-500');
  });

  it('shows a running spinner when a stale checks_failed still has in-progress checks', () => {
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 10, passed: 7, failed: 0, inProgress: 3 })}
      />
    );
    expect(screen.getByText('3/10 running')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('blue-500');
  });

  // Trunk reports `not_ready` for the whole CI run — it is waiting on the PR's
  // own branch protection — so it must not hide what the PR is actually doing.
  describe("an external queue that is waiting on the PR's own checks", () => {
    it('keeps the running pill rather than an amber "Queue: not ready"', () => {
      render(
        <PRStatusPill
          blockingReason="blocked"
          checks={checks({ total: 201, passed: 168, inProgress: 33 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('33/201 running')).toBeTruthy();
      expect(screen.queryByText('Queue: not ready')).toBeNull();
    });

    it('keeps the failing pill — that IS the branch protection trunk waits on', () => {
      render(
        <PRStatusPill
          blockingReason="checks_failed"
          checks={checks({ total: 201, passed: 195, failed: 6 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('6/201 failing')).toBeTruthy();
      expect(screen.queryByText('Queue: not ready')).toBeNull();
    });

    it('still shows the queue when the PR itself has nothing left to report', () => {
      render(
        <PRStatusPill
          blockingReason="mergeable"
          checks={checks({ total: 201, passed: 201 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('Queue: not ready')).toBeTruthy();
      expect(screen.queryByText('Ready')).toBeNull();
    });

    it('never defers for a state the queue owns (testing)', () => {
      render(
        <PRStatusPill
          blockingReason="checks_failed"
          checks={checks({ total: 201, passed: 195, failed: 6 })}
          state="open"
          externalQueueState="testing"
        />
      );
      expect(screen.getByText('Queue: testing')).toBeTruthy();
    });
  });

  // Trunk still has the PR while it waits on the PRs ahead, so this is not the
  // red "back in the author's court" state yet.
  it('shows a pending failure in the queue as amber, not as a failed PR', () => {
    render(
      <PRStatusPill
        blockingReason="mergeable"
        checks={checks({ total: 201, passed: 201 })}
        state="open"
        externalQueueState="pending_failure"
      />
    );
    expect(screen.getByText('Queue: pending failure')).toBeTruthy();
    expect(screen.getByRole('button').className).toContain('amber-500');
  });
});

/**
 * A head that is out of date, on a repo that refuses the merge until it is not.
 *
 * It used to render a green "Ready" — the verdict fell through to `mergeable`
 * because only `mergeStateStatus` carried the fact. Reported from
 * posthog-cloud-infra on 2026-09-21: 18 open PRs claiming to be mergeable
 * while GitHub would have refused every one of them.
 */
describe('PRStatusPill — a behind head', () => {
  it('says Behind, in amber, rather than a green Ready', () => {
    render(<PRStatusPill blockingReason="behind" checks={checks({ total: 3, passed: 3 })} />);
    expect(screen.getByText('Behind')).toBeTruthy();
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('amber-500');
    expect(cls).not.toContain('emerald-500');
  });

  it('explains itself in the tooltip, since the fix is a button and not a rebase', () => {
    render(<PRStatusPill blockingReason="behind" checks={checks()} />);
    expect(screen.getByRole('button').getAttribute('title')).toContain('up to date');
  });

  // The pill ranks a provider that HOLDS the PR above every open-state verdict.
  // On such a repo being behind the base is the steady state, not a problem.
  // `state` must be passed explicitly: the queue variant is skipped unless the
  // PR is known to be open, so omitting it silently tests nothing.
  it('still yields to an external merge queue that holds the PR', () => {
    render(
      <PRStatusPill
        blockingReason="behind"
        checks={checks()}
        state="open"
        externalQueueState="testing"
      />
    );
    expect(screen.queryByText('Behind')).toBeNull();
  });

  it.each([['merged'], ['closed']] as const)('never outranks a %s PR', (state) => {
    render(<PRStatusPill blockingReason="behind" checks={checks()} state={state} />);
    expect(screen.queryByText('Behind')).toBeNull();
  });
});
