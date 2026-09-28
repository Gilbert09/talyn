import { describe, it, expect } from 'vitest';
import { checksAreGreen, checksGreenDelivery } from '../services/workflows/checksGreen.js';
import { workflowFactsFromDelivery, CHECKS_GREEN_EVENT } from '../services/workflows/facts.js';
import type { DomainPrChecksEvent } from '../services/events.js';

/**
 * The two properties the `pr_checks_passed` trigger stands on. Both are pure,
 * so neither needs a database or an event loop to pin.
 */

function evt(over: Partial<DomainPrChecksEvent> = {}): DomainPrChecksEvent {
  return {
    repoFullName: 'acme/widgets',
    headSha: 'abc123',
    checks: { total: 4, passed: 4, failed: 0, inProgress: 0, skipped: 0 },
    prs: [{ prId: 'pr-1', workspaceId: 'ws-1', repositoryId: 'repo-1', number: 42 }],
    ...over,
  };
}

describe('checksAreGreen', () => {
  it('is true when everything finished and nothing failed', () => {
    expect(checksAreGreen({ total: 4, passed: 4, failed: 0, inProgress: 0, skipped: 0 })).toBe(true);
  });

  it('counts a skipped check as green — a path-filtered job is not a failure', () => {
    expect(checksAreGreen({ total: 4, passed: 2, failed: 0, inProgress: 0, skipped: 2 })).toBe(true);
  });

  it('is false while anything is still running', () => {
    // The whole point of the trigger: "nothing has failed YET" is not "passed".
    expect(checksAreGreen({ total: 4, passed: 3, failed: 0, inProgress: 1, skipped: 0 })).toBe(
      false,
    );
  });

  it('is false when anything failed', () => {
    expect(checksAreGreen({ total: 4, passed: 3, failed: 1, inProgress: 0, skipped: 0 })).toBe(
      false,
    );
  });

  it('is FALSE for a PR with no checks at all', () => {
    // An all-zero breakdown satisfies "nothing failed and nothing is running"
    // while nothing has actually passed. Without the `total > 0` guard this
    // would arm every such rule on every PR in a repo with no CI.
    expect(checksAreGreen({ total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 })).toBe(
      false,
    );
  });

  it('is false for an absent breakdown', () => {
    expect(checksAreGreen(undefined)).toBe(false);
  });
});

describe('checksGreenDelivery', () => {
  it('derives its delivery id from the commit, which is what makes it fire once', () => {
    // The engine claims (workflow_id, delivery_id) with a unique index before
    // acting, so a stable id per commit means the first flush that finds the
    // commit green wins and every later one is a duplicate that does nothing.
    const a = checksGreenDelivery(evt());
    const b = checksGreenDelivery(evt());
    expect(a.deliveryId).toBe(b.deliveryId);
    expect(a.deliveryId).toBe('checks-green:acme/widgets:abc123');
  });

  it('changes id on a new commit, so a rule may fire again after a push', () => {
    expect(checksGreenDelivery(evt({ headSha: 'def456' })).deliveryId).not.toBe(
      checksGreenDelivery(evt()).deliveryId,
    );
  });

  it('does not collide across repositories on the same sha', () => {
    expect(checksGreenDelivery(evt({ repoFullName: 'other/repo' })).deliveryId).not.toBe(
      checksGreenDelivery(evt()).deliveryId,
    );
  });

  it('produces a delivery the facts module turns into pr_checks_passed', () => {
    // The contract between the two modules, asserted end to end rather than
    // assumed: a shape change in one is caught here rather than in production.
    const facts = workflowFactsFromDelivery(
      checksGreenDelivery(
        evt({
          prs: [
            { prId: 'pr-1', workspaceId: 'ws-1', repositoryId: 'repo-1', number: 42 },
            { prId: 'pr-2', workspaceId: 'ws-1', repositoryId: 'repo-1', number: 43 },
          ],
        }),
      ),
    );
    expect(facts.map((f) => f.event)).toEqual(['pr_checks_passed', 'pr_checks_passed']);
    expect(facts.map((f) => f.number)).toEqual([42, 43]);
    expect(facts[0]?.repoFullName).toBe('acme/widgets');
  });

  it('uses a namespaced event type that cannot collide with a GitHub one', () => {
    expect(checksGreenDelivery(evt()).eventType).toBe(CHECKS_GREEN_EVENT);
    expect(CHECKS_GREEN_EVENT.startsWith('talyn:')).toBe(true);
  });
});
