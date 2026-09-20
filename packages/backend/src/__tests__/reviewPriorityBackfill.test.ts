import { describe, it, expect } from 'vitest';
import { toHistoryRow } from '../services/reviewPriority/backfill.js';

/**
 * The label construction, which is the part of the backfill that has to be
 * right. Everything else is pagination.
 *
 * The negative class is the interesting half: GitHub REMOVES an individual
 * review request the moment you submit a review, so a closed PR still carrying
 * a standing `review-requested:{login}` is, to a good approximation, exactly a
 * request that was never serviced. That is what makes the class collectable at
 * all — and it is also why `direct` stays a deterministic rule rather than a
 * learned feature (the negative class skews toward TEAM requests as a direct
 * consequence of the same mechanic).
 */

type Raw = Parameters<typeof toHistoryRow>[0];

function raw(over: Partial<Raw> = {}): Raw {
  return {
    number: 7,
    createdAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    additions: 40,
    deletions: 10,
    author: { login: 'sarah' },
    repository: { nameWithOwner: 'acme/widgets' },
    files: { nodes: [{ path: 'src/api/handler.ts' }] },
    reviews: { nodes: [] },
    timelineItems: { nodes: [] },
    ...over,
  } as Raw;
}

const requestedMe = (at: string) => ({
  createdAt: at,
  requestedReviewer: { __typename: 'User' as const, login: 'me' },
});
const requestedTeam = (at: string) => ({
  createdAt: at,
  requestedReviewer: { __typename: 'Team' as const, combinedSlug: 'acme/core' },
});

describe('toHistoryRow', () => {
  it('records a review the viewer performed', () => {
    const row = toHistoryRow(
      raw({
        timelineItems: { nodes: [requestedMe('2026-01-01T01:00:00Z')] },
        reviews: {
          nodes: [{ author: { login: 'me' }, submittedAt: '2026-01-01T05:00:00Z' }],
        },
      }),
      'me',
    );
    expect(row?.reviewedAt?.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(row?.requestedAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(row?.direct).toBe(true);
  });

  it('records a request that was never serviced — the negative class', () => {
    const row = toHistoryRow(
      raw({
        closedAt: '2026-01-09T00:00:00Z',
        timelineItems: { nodes: [requestedTeam('2026-01-01T01:00:00Z')] },
        reviews: { nodes: [] },
      }),
      'me',
    );
    expect(row?.reviewedAt).toBeNull();
    expect(row?.closedAt).not.toBeNull();
    expect(row?.direct).toBe(false);
  });

  it('ignores somebody ELSE’s review on the same PR', () => {
    const row = toHistoryRow(
      raw({
        timelineItems: { nodes: [requestedTeam('2026-01-01T01:00:00Z')] },
        reviews: { nodes: [{ author: { login: 'raj' }, submittedAt: '2026-01-02T00:00:00Z' }] },
      }),
      'me',
    );
    expect(row?.reviewedAt).toBeNull();
  });

  it('drops the viewer’s OWN PR', () => {
    // Not a review decision, and counting it would teach the model that people
    // love their own code.
    expect(toHistoryRow(raw({ author: { login: 'me' } }), 'me')).toBeNull();
  });

  it('drops a PR with no readable author', () => {
    expect(toHistoryRow(raw({ author: null }), 'me')).toBeNull();
  });

  it('matches the viewer case-insensitively', () => {
    const row = toHistoryRow(
      raw({
        timelineItems: {
          nodes: [
            { createdAt: '2026-01-01T01:00:00Z', requestedReviewer: { __typename: 'User', login: 'Me' } },
          ],
        },
        reviews: { nodes: [{ author: { login: 'ME' }, submittedAt: '2026-01-02T00:00:00Z' }] },
      }),
      'me',
    );
    expect(row?.reviewedAt).not.toBeNull();
    expect(row?.direct).toBe(true);
  });

  it('takes the EARLIEST request, so the wait is not understated', () => {
    const row = toHistoryRow(
      raw({
        timelineItems: {
          nodes: [requestedMe('2026-01-05T00:00:00Z'), requestedTeam('2026-01-02T00:00:00Z')],
        },
      }),
      'me',
    );
    expect(row?.requestedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    // …and still records that one of them named the viewer directly.
    expect(row?.direct).toBe(true);
  });

  it('ignores a request naming somebody else entirely', () => {
    const row = toHistoryRow(
      raw({
        timelineItems: {
          nodes: [
            {
              createdAt: '2026-01-02T00:00:00Z',
              requestedReviewer: { __typename: 'User', login: 'raj' },
            },
          ],
        },
      }),
      'me',
    );
    expect(row?.requestedAt).toBeNull();
  });

  it('falls back to the PR’s open date for an opening-payload request', () => {
    // GitHub emits no ReviewRequestedEvent for a reviewer named when the PR was
    // opened. Dropping those rows would discard a common case that skews
    // exactly toward the people you work with most — the signal this is for.
    const row = toHistoryRow(
      raw({
        createdAt: '2026-01-01T00:00:00Z',
        timelineItems: { nodes: [] },
        reviews: { nodes: [{ author: { login: 'me' }, submittedAt: '2026-01-03T00:00:00Z' }] },
      }),
      'me',
    );
    expect(row?.requestedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does NOT invent a request time for a PR the viewer never reviewed', () => {
    // The fallback above is evidence-based: a review proves they were asked.
    // Without one there is nothing to infer from, and guessing would
    // manufacture negatives out of PRs nobody ever put in front of them.
    const row = toHistoryRow(raw({ timelineItems: { nodes: [] }, reviews: { nodes: [] } }), 'me');
    expect(row?.requestedAt).toBeNull();
  });

  it('carries the size and the directories', () => {
    const row = toHistoryRow(
      raw({
        additions: 120,
        deletions: 8,
        files: { nodes: [{ path: 'packages/backend/src/a.ts' }, { path: 'docs/readme.md' }] },
      }),
      'me',
    );
    expect(row?.additions).toBe(120);
    expect(row?.dirs).toEqual(['packages/backend', 'docs']);
  });

  it('tolerates a PR with no files, reviews or timeline at all', () => {
    const row = toHistoryRow(
      raw({ files: null, reviews: null, timelineItems: null }),
      'me',
    );
    expect(row).not.toBeNull();
    expect(row?.dirs).toEqual([]);
  });

  it('ignores an unparseable timestamp instead of storing 1970', () => {
    const row = toHistoryRow(
      raw({ timelineItems: { nodes: [requestedMe('not a date')] } }),
      'me',
    );
    expect(row?.requestedAt).toBeNull();
  });
});
