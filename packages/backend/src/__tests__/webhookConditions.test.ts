import { describe, expect, it } from 'vitest';
import type { WebhookEventFacts, WebhookPayloadCondition } from '@talyn/shared';
import {
  emptyWorkflowInput,
  parseWebhookPath,
  validateWorkflow,
  webhookConditionPasses,
  webhookValueAt,
  workflowActionsFor,
  workflowIntegrationOf,
  workflowMatches,
  workflowSubjectOf,
  workflowVocabulary,
} from '@talyn/shared';

/**
 * The webhook half of the shared rule vocabulary: payload paths, the three
 * operators, the matcher's rule-id check and the validator.
 */

const PAYLOAD = {
  action: 'opened',
  count: 3,
  draft: false,
  nothing: null,
  issue: {
    title: 'Login fails on Safari',
    labels: [{ name: 'bug' }, { name: 'p1' }],
    tags: ['Frontend', 'urgent'],
    'odd-key': 'yes',
    $ref: 'r1',
  },
  matrix: [
    [1, 2],
    [3, 4],
  ],
};

function facts(over: Partial<WebhookEventFacts> = {}): WebhookEventFacts {
  return {
    integration: 'webhook',
    event: 'webhook_received',
    ruleId: 'rule-1',
    connectionId: 'conn-1',
    deliveryRowId: 'row-1',
    deliveryId: 'd-1',
    receivedAt: '2026-11-12T10:00:00.000Z',
    payload: PAYLOAD,
    headers: {},
    ...over,
  };
}

describe('parseWebhookPath', () => {
  it.each([
    ['action', ['action']],
    ['issue.title', ['issue', 'title']],
    ['issue.labels[0].name', ['issue', 'labels', 0, 'name']],
    ['issue.labels.0.name', ['issue', 'labels', 0, 'name']],
    ['matrix[1][0]', ['matrix', 1, 0]],
    ['issue.odd-key', ['issue', 'odd-key']],
    ['issue.$ref', ['issue', '$ref']],
    ['  action  ', ['action']],
  ])('parses %s', (path, steps) => {
    expect(parseWebhookPath(path)).toEqual(steps);
  });

  it.each(['', '   ', 'a..b', '.a', 'a.', 'a[x]', 'a[0', 'a b', 'a.[0]x', 'a/b'])('refuses %j', (path) => {
    expect(parseWebhookPath(path)).toBeNull();
  });
});

describe('webhookValueAt', () => {
  it.each([
    ['action', 'opened'],
    ['count', 3],
    ['draft', false],
    ['nothing', null],
    ['issue.labels[1].name', 'p1'],
    ['issue.labels.1.name', 'p1'],
    ['matrix[1][1]', 4],
    ['issue.tags', ['Frontend', 'urgent']],
  ])('reads %s', (path, value) => {
    expect(webhookValueAt(PAYLOAD, path)).toEqual(value);
  });

  it.each(['missing', 'issue.labels[5].name', 'issue.title.length', 'action.0', 'matrix[0][9]', 'issue.labels.x'])(
    'is undefined for %s',
    (path) => {
      expect(webhookValueAt(PAYLOAD, path)).toBeUndefined();
    }
  );

  it('does not read inherited properties', () => {
    expect(webhookValueAt({}, 'constructor')).toBeUndefined();
    expect(webhookValueAt({ a: {} }, 'a.toString')).toBeUndefined();
  });

  it('reads nothing from a text body', () => {
    expect(webhookValueAt('plain text', 'length')).toBeUndefined();
  });
});

describe('webhookConditionPasses', () => {
  const c = (path: string, op: WebhookPayloadCondition['op'], value?: string): WebhookPayloadCondition => ({
    path,
    op,
    ...(value !== undefined ? { value } : {}),
  });

  it.each<[string, WebhookPayloadCondition, boolean]>([
    ['equals a string', c('action', 'equals', 'opened'), true],
    ['equals is exact on case', c('action', 'equals', 'Opened'), false],
    ['equals a number as text', c('count', 'equals', '3'), true],
    ['equals a boolean as text', c('draft', 'equals', 'false'), true],
    ['equals never matches null', c('nothing', 'equals', 'null'), false],
    ['equals on a missing path', c('missing', 'equals', ''), false],
    ['contains in text, any case', c('issue.title', 'contains', 'SAFARI'), true],
    ['contains not in text', c('issue.title', 'contains', 'chrome'), false],
    ['contains an array item, any case', c('issue.tags', 'contains', 'frontend'), true],
    ['contains is whole-item for arrays', c('issue.tags', 'contains', 'front'), false],
    ['contains skips object items', c('issue.labels', 'contains', 'bug'), false],
    ['contains on an object', c('issue', 'contains', 'bug'), false],
    ['contains on a number', c('count', 'contains', '3'), true],
    ['exists on a value', c('issue.labels[0]', 'exists'), true],
    ['exists on false', c('draft', 'exists'), true],
    ['exists on null', c('nothing', 'exists'), false],
    ['exists on a missing path', c('issue.assignee', 'exists'), false],
  ])('%s', (_name, condition, expected) => {
    expect(webhookConditionPasses(PAYLOAD, condition)).toBe(expected);
  });
});

describe('workflowMatches for webhook facts', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'rule-1',
    integration: 'webhook' as const,
    events: ['webhook_received' as const],
    conditions: {},
    ...over,
  });

  it('matches its own rule with no conditions', () => {
    expect(workflowMatches(rule(), facts())).toBe(true);
  });

  it.each([
    ['another rule id', { id: 'rule-2' }],
    ['no rule id', { id: undefined }],
    ['a Slack rule', { integration: 'slack' }],
    ['a GitHub rule', { integration: 'github' }],
    ['no events', { events: [] }],
  ])('refuses %s', (_name, over) => {
    expect(workflowMatches(rule(over), facts())).toBe(false);
  });

  it.each<[string, WebhookPayloadCondition[], boolean]>([
    ['every test passes', [{ path: 'action', op: 'equals', value: 'opened' }, { path: 'issue.tags', op: 'contains', value: 'urgent' }], true],
    ['one test fails', [{ path: 'action', op: 'equals', value: 'opened' }, { path: 'issue.tags', op: 'contains', value: 'low' }], false],
    ['a missing path fails', [{ path: 'issue.assignee.login', op: 'exists' }], false],
  ])('ANDs the payload tests: %s', (_name, payloadMatches, expected) => {
    expect(workflowMatches(rule({ conditions: { payloadMatches } }), facts())).toBe(expected);
  });

  it('keys the rate cap per rule', () => {
    expect(workflowSubjectOf(facts())).toEqual({ key: 'webhook:rule-1', label: 'Webhook' });
  });
});

describe('validateWorkflow for webhook rules', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    integration: 'webhook',
    name: 'Triage',
    events: ['webhook_received'],
    actions: [{ type: 'start_session', repositoryId: 'r1', prompt: 'Fix it' }],
    ...over,
  });

  it('accepts and normalises a webhook rule', () => {
    const out = validateWorkflow(
      base({
        conditions: {
          payloadMatches: [
            { path: ' action ', op: 'equals', value: 'opened' },
            { path: 'issue', op: 'exists', value: 'ignored' },
          ],
        },
        actions: [
          { type: 'start_session', repositoryId: ' r1 ', prompt: ' Fix it ', model: 'claude-x', internetAccess: true },
          { type: 'start_task', repositoryId: 'r1', prompt: 'Also this' },
        ],
      })
    );
    expect(out.integration).toBe('webhook');
    expect(out.conditions).toEqual({
      payloadMatches: [
        { path: 'action', op: 'equals', value: 'opened' },
        { path: 'issue', op: 'exists' },
      ],
    });
    expect(out.actions).toEqual([
      { type: 'start_session', repositoryId: 'r1', prompt: 'Fix it', model: 'claude-x', internetAccess: true },
      { type: 'start_task', repositoryId: 'r1', prompt: 'Also this' },
    ]);
  });

  it('drops an empty payload list', () => {
    expect(validateWorkflow(base({ conditions: { payloadMatches: [] } })).conditions).toEqual({});
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a session with no repository', { actions: [{ type: 'start_session', repositoryId: null, prompt: 'x' }] }, /choose the repository/],
    ['a task with no repository', { actions: [{ type: 'start_task', repositoryId: '', prompt: 'x' }] }, /choose the repository/],
    ['a task with no prompt', { actions: [{ type: 'start_task', repositoryId: 'r1', prompt: ' ' }] }, /prompt/],
    ['a task with a bad internetAccess', { actions: [{ type: 'start_task', repositoryId: 'r1', prompt: 'x', internetAccess: 'yes' }] }, /internetAccess/],
    ['a PR action', { actions: [{ type: 'add_labels', labels: ['x'] }] }, /acts on a pull request.*Webhook automation/],
    ['a Slack action', { actions: [{ type: 'slack_react', emoji: 'eyes' }] }, /acts on a Slack message/],
    ['a GitHub event', { events: ['pr_opened'] }, /is a GitHub event/],
    ['a Slack event', { events: ['slack_message'] }, /is a Slack event/],
    ['an unknown event', { events: ['nope'] }, /not a Webhook event/],
    ['a GitHub condition', { conditions: { repos: ['a/b'] } }, /is a GitHub condition/],
    ['a Slack condition', { conditions: { channels: ['C1'] } }, /is a Slack condition/],
    ['an unknown condition', { conditions: { whatever: 1 } }, /Unknown condition/],
    ['payloadMatches not a list', { conditions: { payloadMatches: {} } }, /must be an array/],
    ['a bad path', { conditions: { payloadMatches: [{ path: 'a..b', op: 'exists' }] } }, /is not a path/],
    ['an empty path', { conditions: { payloadMatches: [{ path: '', op: 'exists' }] } }, /path must be a non-empty/],
    ['a bad op', { conditions: { payloadMatches: [{ path: 'a', op: 'matches', value: 'x' }] } }, /op must be one of/],
    ['equals with no value', { conditions: { payloadMatches: [{ path: 'a', op: 'equals' }] } }, /value must be a string/],
    ['contains with a blank value', { conditions: { payloadMatches: [{ path: 'a', op: 'contains', value: ' ' }] } }, /must not be empty/],
  ])('refuses %s', (_name, over, message) => {
    expect(() => validateWorkflow(base(over))).toThrow(message);
  });

  it.each([
    ['github', 'start_task'],
    ['slack', 'start_task'],
  ])('refuses start_task on a %s rule', (integration, type) => {
    const rule =
      integration === 'slack'
        ? {
            integration,
            name: 'x',
            events: ['slack_message'],
            conditions: { slackTeamId: 'T1', channels: ['C1'] },
            actions: [{ type, repositoryId: 'r1', prompt: 'x' }],
          }
        : { integration, name: 'x', events: ['pr_opened'], actions: [{ type, repositoryId: 'r1', prompt: 'x' }] };
    expect(() => validateWorkflow(rule)).toThrow(/is for webhook automations/);
  });

  it('refuses a webhook condition on a GitHub rule', () => {
    expect(() =>
      validateWorkflow({
        name: 'x',
        events: ['pr_opened'],
        conditions: { payloadMatches: [] },
        actions: [{ type: 'watch_pr' }],
      })
    ).toThrow(/is a Webhook condition/);
  });

  it('describes the vocabulary and the empty input', () => {
    expect(workflowActionsFor('webhook')).toEqual(['start_session', 'start_task']);
    const vocab = workflowVocabulary('webhook');
    expect(vocab.events.map((e) => e.event)).toEqual(['webhook_received']);
    expect(vocab.conditions.map((c) => c.key)).toEqual(['payloadMatches']);
    expect(emptyWorkflowInput('webhook')).toMatchObject({ integration: 'webhook', events: ['webhook_received'] });
    expect(workflowIntegrationOf({ integration: 'webhook' })).toBe('webhook');
    expect(workflowIntegrationOf({ integration: 'bogus' as never })).toBe('github');
  });
});
