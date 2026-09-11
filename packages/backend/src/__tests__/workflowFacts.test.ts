import { describe, it, expect } from 'vitest';
import { workflowFactsFromDelivery } from '../services/workflows/facts.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';

/**
 * The `(eventType, action, payload)` → trigger mapping, against payload shapes
 * as GitHub actually sends them.
 *
 * This is the module the whole feature stands on: a workflow is only ever as
 * correct as the facts it matched, and everything here is pure, so it can be
 * pinned exhaustively without a database or a network.
 */

function delivery(over: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    deliveryId: 'd1',
    eventType: 'pull_request',
    repoFullName: 'acme/widget',
    enqueuedAtMs: 0,
    payload: {},
    ...over,
  };
}

/** A `pull_request` payload's PR node, with the fields Talyn reads. */
function pr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Add a widget',
    html_url: 'https://github.com/acme/widget/pull/42',
    draft: false,
    user: { login: 'alice', type: 'User' },
    base: { ref: 'main' },
    head: { ref: 'alice/widget' },
    labels: [{ name: 'enhancement' }, { name: 'frontend' }],
    ...over,
  };
}

describe('workflowFactsFromDelivery — pull_request actions', () => {
  const cases: Array<[string, string]> = [
    ['opened', 'pr_opened'],
    ['reopened', 'pr_reopened'],
    ['edited', 'pr_edited'],
    ['synchronize', 'pr_synchronized'],
    ['ready_for_review', 'pr_ready_for_review'],
    ['converted_to_draft', 'pr_converted_to_draft'],
    ['labeled', 'pr_labeled'],
    ['unlabeled', 'pr_unlabeled'],
    ['assigned', 'pr_assigned'],
    ['unassigned', 'pr_unassigned'],
    ['review_requested', 'pr_review_requested'],
    ['review_request_removed', 'pr_review_request_removed'],
  ];

  it.each(cases)('maps %s → %s', (action, event) => {
    const [facts] = workflowFactsFromDelivery(
      delivery({ action, payload: { pull_request: pr(), sender: { login: 'bob', type: 'User' } } })
    );
    expect(facts?.event).toBe(event);
  });

  it('carries the whole PR, with nothing unknown', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({ action: 'opened', payload: { pull_request: pr() } })
    );
    expect(facts).toMatchObject({
      repoFullName: 'acme/widget',
      number: 42,
      title: 'Add a widget',
      url: 'https://github.com/acme/widget/pull/42',
      baseBranch: 'main',
      headBranch: 'alice/widget',
      draft: false,
      labels: ['enhancement', 'frontend'],
    });
    expect(facts?.unknownFields).toBeUndefined();
  });

  it('separates the author from the actor who performed the event', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'labeled',
        payload: {
          pull_request: pr(),
          label: { name: 'needs-review' },
          sender: { login: 'talyn-app[bot]', type: 'Bot' },
        },
      })
    );
    expect(facts?.author).toEqual({ login: 'alice', isBot: false });
    expect(facts?.actor).toEqual({ login: 'talyn-app[bot]', isBot: true });
    expect(facts?.labelName).toBe('needs-review');
  });

  it('falls back to the author when the payload names no sender', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({ action: 'opened', payload: { pull_request: pr() } })
    );
    expect(facts?.actor).toEqual({ login: 'alice', isBot: false });
  });

  it('splits closed into merged vs closed on the merge fields', () => {
    const [merged] = workflowFactsFromDelivery(
      delivery({
        action: 'closed',
        payload: { pull_request: pr({ merged: true, merged_at: '2026-09-01T10:00:00Z' }) },
      })
    );
    expect(merged?.event).toBe('pr_merged');

    const [closed] = workflowFactsFromDelivery(
      delivery({
        action: 'closed',
        payload: { pull_request: pr({ merged: false, merged_at: null }) },
      })
    );
    expect(closed?.event).toBe('pr_closed');
  });

  it('reads merged from merged_at alone', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'closed',
        payload: { pull_request: pr({ merged_at: '2026-09-01T10:00:00Z' }) },
      })
    );
    expect(facts?.event).toBe('pr_merged');
  });

  it('names the requested reviewer as the target', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'review_requested',
        payload: {
          pull_request: pr(),
          requested_reviewer: { login: 'tom', type: 'User' },
        },
      })
    );
    expect(facts?.target).toEqual({ login: 'tom', isBot: false });
  });

  it('names the TEAM as the target on a team review request', () => {
    // A team request carries no user at all, so the team itself is the target and
    // its slug goes in `teamSlugs` — that is what lets a rule say "a review was
    // requested from the frontend team".
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'review_requested',
        payload: { pull_request: pr(), requested_team: { slug: 'frontend' } },
      })
    );
    expect(facts?.target).toEqual({ login: 'frontend', isBot: false, teamSlugs: ['frontend'] });
  });

  it('prefers the requested USER over a team when both are present', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'review_requested',
        payload: {
          pull_request: pr(),
          requested_reviewer: { login: 'tom', type: 'User' },
          requested_team: { slug: 'frontend' },
        },
      })
    );
    expect(facts?.target).toEqual({ login: 'tom', isBot: false });
  });

  it('leaves the target absent when a team request carries no slug', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'review_requested',
        payload: { pull_request: pr(), requested_team: { name: 'Frontend' } },
      })
    );
    expect(facts?.target).toBeUndefined();
  });

  it('names the assignee as the target', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        action: 'assigned',
        payload: { pull_request: pr(), assignee: { login: 'tom', type: 'User' } },
      })
    );
    expect(facts?.target).toEqual({ login: 'tom', isBot: false });
  });

  it('is inert for an action with no trigger', () => {
    for (const action of ['auto_merge_enabled', 'locked', 'milestoned', 'review_request']) {
      expect(workflowFactsFromDelivery(delivery({ action, payload: { pull_request: pr() } }))).toEqual([]);
    }
  });

  it('is inert with no PR node or no number', () => {
    expect(workflowFactsFromDelivery(delivery({ action: 'opened', payload: {} }))).toEqual([]);
    expect(
      workflowFactsFromDelivery(delivery({ action: 'opened', payload: { pull_request: { title: 'x' } } }))
    ).toEqual([]);
  });
});

describe('workflowFactsFromDelivery — reviews', () => {
  const reviewPayload = (over: Record<string, unknown> = {}) => ({
    pull_request: pr(),
    review: {
      state: 'changes_requested',
      body: 'Please rename this',
      user: { login: 'carol', type: 'User' },
    },
    sender: { login: 'carol', type: 'User' },
    ...over,
  });

  it('maps submitted → pr_review_submitted with the verdict and body', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({ eventType: 'pull_request_review', action: 'submitted', payload: reviewPayload() })
    );
    expect(facts?.event).toBe('pr_review_submitted');
    expect(facts?.reviewState).toBe('changes_requested');
    expect(facts?.body).toBe('Please rename this');
  });

  it.each([
    ['approved', 'approved'],
    ['commented', 'commented'],
    ['APPROVED', 'approved'],
  ])('normalises review state %s → %s', (state, expected) => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'pull_request_review',
        action: 'submitted',
        payload: reviewPayload({ review: { state, user: { login: 'c' } } }),
      })
    );
    expect(facts?.reviewState).toBe(expected);
  });

  it('maps dismissed and credits the REVIEWER, not whoever dismissed it', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'pull_request_review',
        action: 'dismissed',
        payload: reviewPayload({ sender: { login: 'alice', type: 'User' } }),
      })
    );
    expect(facts?.event).toBe('pr_review_dismissed');
    expect(facts?.actor).toEqual({ login: 'carol', isBot: false });
  });

  it('leaves reviewState absent for a state no rule can test', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'pull_request_review',
        action: 'submitted',
        payload: reviewPayload({ review: { state: 'pending', user: { login: 'c' } } }),
      })
    );
    expect(facts?.reviewState).toBeUndefined();
  });

  it('is inert on review edited', () => {
    expect(
      workflowFactsFromDelivery(
        delivery({ eventType: 'pull_request_review', action: 'edited', payload: reviewPayload() })
      )
    ).toEqual([]);
  });
});

describe('workflowFactsFromDelivery — comments', () => {
  it('maps a review comment, crediting the commenter', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'pull_request_review_comment',
        action: 'created',
        payload: {
          pull_request: pr(),
          comment: { body: 'nit: spelling', user: { login: 'dave', type: 'User' } },
        },
      })
    );
    expect(facts?.event).toBe('pr_review_comment');
    expect(facts?.body).toBe('nit: spelling');
    expect(facts?.actor).toEqual({ login: 'dave', isBot: false });
  });

  it('maps an issue comment on a PR, and declares what an issue payload cannot say', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'issue_comment',
        action: 'created',
        payload: {
          issue: {
            number: 42,
            title: 'Add a widget',
            html_url: 'https://github.com/acme/widget/pull/42',
            user: { login: 'alice', type: 'User' },
            labels: [{ name: 'enhancement' }],
            pull_request: { url: 'https://api.github.com/…/pulls/42' },
          },
          comment: { body: '/trunk merge', user: { login: 'alice', type: 'User' } },
        },
      })
    );
    expect(facts?.event).toBe('pr_comment');
    expect(facts?.labels).toEqual(['enhancement']);
    // An issue has no base branch, no head branch and no draft flag.
    expect(facts?.unknownFields).toEqual(['baseBranch', 'headBranch', 'draft']);
  });

  it('ignores a comment on a plain issue', () => {
    expect(
      workflowFactsFromDelivery(
        delivery({
          eventType: 'issue_comment',
          action: 'created',
          payload: { issue: { number: 9, user: { login: 'a' } }, comment: { body: 'hi' } },
        })
      )
    ).toEqual([]);
  });

  it('ignores a deleted or edited comment', () => {
    for (const action of ['deleted', 'edited']) {
      expect(
        workflowFactsFromDelivery(
          delivery({
            eventType: 'issue_comment',
            action,
            payload: {
              issue: { number: 9, pull_request: {}, user: { login: 'a' } },
              comment: { body: 'hi' },
            },
          })
        )
      ).toEqual([]);
    }
  });
});

describe('workflowFactsFromDelivery — checks', () => {
  const suite = (over: Record<string, unknown> = {}) => ({
    check_suite: {
      conclusion: 'failure',
      pull_requests: [
        { number: 42, base: { ref: 'main' }, head: { ref: 'alice/widget' } },
        { number: 43, base: { ref: 'main' }, head: { ref: 'alice/other' } },
      ],
      ...over,
    },
  });

  it('yields one fact per PR the suite covers', () => {
    const facts = workflowFactsFromDelivery(
      delivery({ eventType: 'check_suite', action: 'completed', payload: suite() })
    );
    expect(facts.map((f) => f.number)).toEqual([42, 43]);
    expect(facts.every((f) => f.event === 'pr_checks_completed')).toBe(true);
    expect(facts[0]?.checkConclusion).toBe('failure');
    // A suite's embedded PRs are {number, base, head} and nothing else.
    expect(facts[0]?.unknownFields).toContain('title');
    expect(facts[0]?.unknownFields).toContain('labels');
  });

  it('treats timed_out as a failure', () => {
    const [facts] = workflowFactsFromDelivery(
      delivery({
        eventType: 'check_suite',
        action: 'completed',
        payload: suite({ conclusion: 'timed_out' }),
      })
    );
    expect(facts?.checkConclusion).toBe('failure');
  });

  it.each(['neutral', 'skipped', 'cancelled', 'stale', 'action_required', null])(
    'is inert for the ambiguous conclusion %s',
    (conclusion) => {
      expect(
        workflowFactsFromDelivery(
          delivery({
            eventType: 'check_suite',
            action: 'completed',
            payload: suite({ conclusion }),
          })
        )
      ).toEqual([]);
    }
  );

  it('is inert while the suite is still running', () => {
    expect(
      workflowFactsFromDelivery(
        delivery({ eventType: 'check_suite', action: 'requested', payload: suite() })
      )
    ).toEqual([]);
  });

  it('ignores check_run entirely — a single run is not "the checks finished"', () => {
    expect(
      workflowFactsFromDelivery(
        delivery({
          eventType: 'check_run',
          action: 'completed',
          payload: { check_run: { conclusion: 'failure', pull_requests: [{ number: 42 }] } },
        })
      )
    ).toEqual([]);
  });
});

describe('workflowFactsFromDelivery — everything else', () => {
  it.each(['push', 'status', 'workflow_run', 'release', 'pull_request_review_thread'])(
    'is inert for %s',
    (eventType) => {
      expect(workflowFactsFromDelivery(delivery({ eventType, payload: {} }))).toEqual([]);
    }
  );

  it('is inert with no repository', () => {
    expect(
      workflowFactsFromDelivery(
        delivery({ action: 'opened', repoFullName: '', payload: { pull_request: pr() } })
      )
    ).toEqual([]);
  });
});
