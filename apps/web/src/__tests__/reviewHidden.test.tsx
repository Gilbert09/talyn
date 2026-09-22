import { describe, it, expect, beforeEach } from 'vitest';
import type { PRRow } from '../lib/api';
import {
  hiddenReviewCohort,
  isHiddenReview,
  visibleReviewCohort,
} from '../components/panels/github/reviewHidden';
import { usePullRequestStore } from '../stores/pullRequests';

/**
 * Hiding a PR in the Reviews tab.
 *
 * Three callers have to agree about the rule — the list, the hidden section and
 * the sidebar badge — so it lives in one helper and is pinned here. The store
 * half matters just as much: the hide arrives over the same WS event every
 * other PR change does, where `undefined` and `null` mean opposite things.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

function row(over: Partial<PRRow> = {}): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'a',
    repo: 'b',
    number: 7,
    state: 'open',
    reviewRequested: true,
    authored: false,
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-09-22T10:00:00.000Z',
    summary: { title: 'A PR' },
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-22T09:00:00.000Z',
    ...over,
  } as unknown as PRRow;
}

describe('the Reviews tab cohort', () => {
  const visible = row({ id: 'visible' });
  const hiddenEarly = row({ id: 'hidden-early', reviewHiddenAt: '2026-09-20T10:00:00.000Z' });
  const hiddenLate = row({ id: 'hidden-late', reviewHiddenAt: '2026-09-21T10:00:00.000Z' });
  // Hidden, then reviewed on github.com (or the request was withdrawn).
  const gone = row({ id: 'gone', reviewRequested: false, reviewHiddenAt: '2026-09-19T10:00:00.000Z' });
  const mine = row({ id: 'mine', reviewRequested: false, authored: true });
  const all = [visible, hiddenEarly, hiddenLate, gone, mine];

  it('lists only the review requests that are not hidden', () => {
    expect(visibleReviewCohort(all).map((r) => r.id)).toEqual(['visible']);
  });

  it('lists the hidden ones newest hide first', () => {
    // `gone` is left out: it is not review-requested any more, and listing it
    // would make this an archive of everything ever skipped.
    expect(hiddenReviewCohort(all).map((r) => r.id)).toEqual(['hidden-late', 'hidden-early']);
  });

  it('treats a row with no field at all as visible', () => {
    // An older backend sends no `reviewHiddenAt`. That has to read as visible,
    // not as hidden — the failure mode would be an empty Reviews tab.
    expect(isHiddenReview(row())).toBe(false);
    expect(isHiddenReview(row({ reviewHiddenAt: null }))).toBe(false);
    expect(isHiddenReview(hiddenLate)).toBe(true);
  });
});

describe('a hide arriving over the websocket', () => {
  beforeEach(() => {
    usePullRequestStore.setState({ rows: [row({ id: 'pr1' })] });
  });

  function echo(over: Record<string, unknown>) {
    usePullRequestStore.getState().applyPullRequestUpdate({
      id: 'pr1',
      taskId: null,
      state: 'open',
      lastSummary: {},
      ...over,
    } as Parameters<ReturnType<typeof usePullRequestStore.getState>['applyPullRequestUpdate']>[0]);
  }
  const held = () => usePullRequestStore.getState().rows[0].reviewHiddenAt;

  it('applies the hide', () => {
    echo({ reviewHiddenAt: '2026-09-22T11:00:00.000Z' });
    expect(held()).toBe('2026-09-22T11:00:00.000Z');
  });

  it('keeps it through every echo that says nothing about it', () => {
    echo({ reviewHiddenAt: '2026-09-22T11:00:00.000Z' });
    // The poll's flag reconcile and every prCache upsert emit this event
    // without the field. Dropping it there would unhide the PR on the next
    // tick, which is the bug `watching` had to be taught not to have.
    echo({ lastSummary: { title: 'Renamed' } });
    expect(held()).toBe('2026-09-22T11:00:00.000Z');
  });

  it('honours an explicit null as an unhide', () => {
    echo({ reviewHiddenAt: '2026-09-22T11:00:00.000Z' });
    // `??` would swallow this and the PR would never come back without a
    // refetch. `undefined` and `null` are different answers here.
    echo({ reviewHiddenAt: null });
    expect(held()).toBeNull();
  });
});
