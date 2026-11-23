import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_FACT_TEXT } from '@talyn/shared';
import { githubIssueFactsFromDelivery } from '../services/workflows/sources/githubIssues.js';
import { linearFactsFromPayload } from '../services/workflows/sources/linear.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';

/**
 * Vendor payloads → issue facts. Both mappers are pure, so the whole event
 * taxonomy is tested against payloads shaped like the vendors' own.
 */

const ghIssue = {
  id: 9001,
  number: 7,
  title: 'Broken link',
  body: 'The footer link is broken.',
  html_url: 'https://github.com/acme/web/issues/7',
  state: 'open',
  labels: [{ name: 'bug' }, { name: 'web' }],
  assignee: { login: 'octocat', id: 1 },
  user: { login: 'hubot', id: 2 },
};

function gh(eventType: string, action: string | undefined, extra: Record<string, unknown> = {}): WebhookDelivery {
  return {
    deliveryId: 'd-1',
    eventType,
    action,
    repoFullName: 'acme/web',
    enqueuedAtMs: 0,
    payload: { action, issue: ghIssue, sender: { login: 'octocat', id: 1 }, repository: { full_name: 'acme/web' }, ...extra },
  };
}

describe('githubIssueFactsFromDelivery', () => {
  it.each([
    ['issues', 'opened', 'issue_created'],
    ['issues', 'labeled', 'issue_labeled'],
    ['issues', 'assigned', 'issue_assigned'],
    ['issues', 'closed', 'issue_status_changed'],
    ['issues', 'reopened', 'issue_status_changed'],
    ['issues', 'edited', 'issue_updated'],
  ])('%s/%s → %s', (eventType, action, event) => {
    const facts = githubIssueFactsFromDelivery(gh(eventType, action, { label: { name: 'bug' } }));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      integration: 'github_issues',
      event,
      connectionId: null,
      externalId: '9001',
      identifier: 'acme/web#7',
      title: 'Broken link',
      url: 'https://github.com/acme/web/issues/7',
      labels: ['bug', 'web'],
      assignee: 'octocat',
      assigneeId: '1',
      status: 'open',
      actor: 'octocat',
      author: 'hubot',
      repoFullName: 'acme/web',
      number: 7,
    });
    if (event === 'issue_labeled') expect(facts[0].labelName).toBe('bug');
  });

  it.each([
    ['issues', 'deleted'],
    ['issues', 'unlabeled'],
    ['issues', 'transferred'],
    ['issue_comment', 'edited'],
    ['issue_comment', 'deleted'],
    ['pull_request', 'opened'],
  ])('ignores %s/%s', (eventType, action) => {
    expect(githubIssueFactsFromDelivery(gh(eventType, action, { comment: { id: 5, body: 'x' } }))).toEqual([]);
  });

  it('maps a comment on an issue', () => {
    const facts = githubIssueFactsFromDelivery(
      gh('issue_comment', 'created', { comment: { id: 55, body: 'Please fix', user: { login: 'ada' } } })
    );
    expect(facts[0]).toMatchObject({ event: 'issue_commented', comment: { id: '55', body: 'Please fix', author: 'ada' } });
  });

  it('ignores a comment on a pull request: it is a PR comment', () => {
    const delivery = gh('issue_comment', 'created', { comment: { id: 55, body: 'x' } });
    delivery.payload.issue = { ...ghIssue, pull_request: { url: 'https://api.github.com/x' } };
    expect(githubIssueFactsFromDelivery(delivery)).toEqual([]);
  });

  it('cuts a long body', () => {
    const delivery = gh('issues', 'opened');
    delivery.payload.issue = { ...ghIssue, body: 'x'.repeat(MAX_ISSUE_FACT_TEXT + 50) };
    expect(githubIssueFactsFromDelivery(delivery)[0].body).toHaveLength(MAX_ISSUE_FACT_TEXT);
  });

  it.each([
    ['no repository', (d: WebhookDelivery) => ({ ...d, repoFullName: '' })],
    ['no issue', (d: WebhookDelivery) => ({ ...d, payload: { action: 'opened' } })],
    ['no number', (d: WebhookDelivery) => ({ ...d, payload: { ...d.payload, issue: { ...ghIssue, number: undefined } } })],
  ])('answers [] with %s', (_name, change) => {
    expect(githubIssueFactsFromDelivery(change(gh('issues', 'opened')))).toEqual([]);
  });
});

const connection = { id: 'conn-1', workspaceId: 'ws1', kind: 'linear' as const, ruleId: null };

const linearIssue = {
  id: 'iss-1',
  identifier: 'ENG-12',
  title: 'Crash on save',
  description: 'The editor crashes.',
  url: 'https://linear.app/acme/issue/ENG-12',
  priorityLabel: 'High',
  teamId: 'team-1',
  team: { id: 'team-1', key: 'ENG' },
  state: { name: 'Todo' },
  project: { name: 'Editor' },
  assigneeId: 'user-ada',
  assignee: { id: 'user-ada', name: 'Ada' },
  delegateId: null,
  labelIds: ['l-bug', 'l-ui'],
  labels: [
    { id: 'l-bug', name: 'Bug' },
    { id: 'l-ui', name: 'UI' },
  ],
};

const linearPayload = (over: Record<string, unknown>) => ({
  type: 'Issue',
  action: 'create',
  actor: { id: 'user-bob', name: 'Bob' },
  data: linearIssue,
  organizationId: 'org-1',
  webhookTimestamp: Date.now(),
  ...over,
});

describe('linearFactsFromPayload', () => {
  it('maps an issue create', () => {
    const facts = linearFactsFromPayload(linearPayload({}), connection);
    expect(facts).toEqual([
      {
        integration: 'linear',
        event: 'issue_created',
        connectionId: 'conn-1',
        externalId: 'iss-1',
        identifier: 'ENG-12',
        title: 'Crash on save',
        body: 'The editor crashes.',
        url: 'https://linear.app/acme/issue/ENG-12',
        labels: ['Bug', 'UI'],
        assignee: 'Ada',
        assigneeId: 'user-ada',
        delegateId: null,
        team: 'ENG',
        teamId: 'team-1',
        project: 'Editor',
        status: 'Todo',
        priority: 'High',
        actor: 'Bob',
        actorId: 'user-bob',
      },
    ]);
  });

  it.each<[string, Record<string, unknown>, Array<[string, string | undefined]>]>([
    ['a label added', { labelIds: ['l-bug'] }, [['issue_labeled', 'UI']]],
    ['two labels added', { labelIds: [] }, [['issue_labeled', 'Bug'], ['issue_labeled', 'UI']]],
    ['a label removed only', { labelIds: ['l-bug', 'l-ui', 'l-old'] }, []],
    ['assigned', { assigneeId: null }, [['issue_assigned', undefined]]],
    ['state changed', { stateId: 'state-0' }, [['issue_status_changed', undefined]]],
    ['title changed', { title: 'Old title' }, [['issue_updated', undefined]]],
    ['description changed', { description: 'Old' }, [['issue_updated', undefined]]],
    ['label and state at once', { labelIds: ['l-bug'], stateId: 's' }, [['issue_labeled', 'UI'], ['issue_status_changed', undefined]]],
    ['an untracked field', { sortOrder: 3 }, []],
  ])('maps an issue update: %s', (_name, updatedFrom, expected) => {
    const facts = linearFactsFromPayload(linearPayload({ action: 'update', updatedFrom }), connection);
    expect(facts.map((f) => [f.event, f.labelName])).toEqual(expected);
  });

  it('maps a delegation to the app as an assignment', () => {
    const facts = linearFactsFromPayload(
      linearPayload({ action: 'update', updatedFrom: { delegateId: null }, data: { ...linearIssue, delegateId: 'app-user' } }),
      connection
    );
    expect(facts.map((f) => f.event)).toEqual(['issue_assigned']);
    expect(facts[0].delegateId).toBe('app-user');
  });

  it('does not call an unassignment an assignment', () => {
    const facts = linearFactsFromPayload(
      linearPayload({ action: 'update', updatedFrom: { assigneeId: 'user-ada' }, data: { ...linearIssue, assigneeId: null, assignee: null } }),
      connection
    );
    expect(facts).toEqual([]);
  });

  it('maps a comment, with the issue facts marked unknown', () => {
    const facts = linearFactsFromPayload(
      {
        type: 'Comment',
        action: 'create',
        actor: { id: 'user-bob', name: 'Bob' },
        data: { id: 'cm-1', body: 'Talyn, fix this', issueId: 'iss-1', userId: 'user-bob', user: { id: 'user-bob', name: 'Bob' } },
      },
      connection
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      event: 'issue_commented',
      externalId: 'iss-1',
      comment: { id: 'cm-1', body: 'Talyn, fix this', author: 'Bob' },
      actorId: 'user-bob',
    });
    expect(facts[0].unknownFields).toEqual(expect.arrayContaining(['labels', 'status', 'body']));
  });

  it.each([
    ['an issue remove', linearPayload({ action: 'remove' })],
    ['a comment update', { type: 'Comment', action: 'update', data: { id: 'c', issueId: 'i' } }],
    ['a project event', { type: 'Project', action: 'create', data: { id: 'p' } }],
    ['an issue with no id', linearPayload({ data: { ...linearIssue, id: undefined } })],
    ['not an object', 'text'],
    ['null', null],
  ])('answers [] for %s', (_name, payload) => {
    expect(linearFactsFromPayload(payload, connection)).toEqual([]);
  });
});
