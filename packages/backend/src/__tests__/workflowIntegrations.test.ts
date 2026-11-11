import { describe, expect, it } from 'vitest';
import {
  ALL_WORKFLOW_ACTION_TYPES,
  describeWorkflowAction,
  emptyWorkflowAction,
  emptyWorkflowInput,
  GITHUB_WORKFLOW_CONDITION_KEYS,
  isSlackThreadReply,
  renderWorkflowComment,
  renderWorkflowTemplate,
  SLACK_WORKFLOW_CONDITION_KEYS,
  slackRulesOffered,
  validateWorkflow,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_EVENTS,
  workflowActionsFor,
  workflowEventsFor,
  workflowInputProblem,
  workflowIntegrationOf,
  workflowMatches,
  workflowSubjectOf,
  workflowToInput,
  workflowVocabulary,
  type GithubEventFacts,
  type SlackEventFacts,
  type WorkflowConditions,
  type WorkflowDefinition,
  type WorkflowSlackAuthorMatch,
} from '@talyn/shared';
import { workflowFactsFromRun } from '../services/workflows/facts.js';

/**
 * Rules per integration: the shared vocabulary, validator, matcher and
 * renderer for GitHub and Slack rules side by side.
 *
 * What is pinned: a rule's events, conditions and actions all belong to ONE
 * integration, and a mix is refused with a message that says what to change;
 * a Slack rule matches only its own team and channels, only top-level messages
 * by default, and anyone in the channel by default; and the GitHub side of every
 * helper reads exactly as it did before integrations existed.
 */

function slackRule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integration: 'slack',
    name: 'Bugs channel',
    events: ['slack_message'],
    conditions: { slackTeamId: 'T1', channels: ['C1'] },
    actions: [{ type: 'slack_react', emoji: 'eyes' }],
    ...over,
  };
}

function githubRule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Label new PRs',
    events: ['pr_opened'],
    actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
    ...over,
  };
}

function slackFacts(over: Partial<SlackEventFacts> = {}): SlackEventFacts {
  return {
    integration: 'slack',
    event: 'slack_message',
    teamId: 'T1',
    channelId: 'C1',
    channelName: 'eng-bugs',
    userId: 'U1',
    text: 'The checkout page is broken',
    ts: '1700000000.000100',
    threadTs: null,
    permalink: 'https://acme.slack.com/archives/C1/p1700000000000100',
    authorLinked: true,
    ...over,
  };
}

const githubFacts: GithubEventFacts = {
  event: 'pr_opened',
  repoFullName: 'acme/widget',
  number: 42,
  title: 'Add a widget',
  url: 'https://github.com/acme/widget/pull/42',
  author: { login: 'alice', isBot: false },
  actor: { login: 'bob', isBot: false },
  baseBranch: 'main',
  defaultBranch: 'main',
  headBranch: 'alice/widget',
  draft: false,
  labels: [],
};

function slackDef(conditions: WorkflowConditions): Pick<
  WorkflowDefinition,
  'events' | 'conditions' | 'integration'
> {
  return { integration: 'slack', events: ['slack_message'], conditions };
}

describe('integration of a rule', () => {
  it.each([
    [undefined, 'github'],
    [null, 'github'],
    [{}, 'github'],
    [{ integration: 'github' as const }, 'github'],
    [{ integration: 'slack' as const }, 'slack'],
  ])('workflowIntegrationOf(%j) is %s', (value, expected) => {
    expect(workflowIntegrationOf(value)).toBe(expected);
  });

  it('normalises a body with no integration to a GitHub rule', () => {
    expect(validateWorkflow(githubRule()).integration).toBe('github');
  });

  it.each([null, undefined])('treats integration=%s as GitHub', (integration) => {
    expect(validateWorkflow(githubRule({ integration })).integration).toBe('github');
  });

  it.each(['linear', 'GitHub', 3, true])('refuses integration=%j', (integration) => {
    expect(() => validateWorkflow(githubRule({ integration }))).toThrow(/integration must be one of/);
  });

  it('keeps the old exported lists GitHub-only, so the GitHub editor offers no Slack item', () => {
    expect(WORKFLOW_TRIGGER_EVENTS).not.toContain('slack_message');
    expect(WORKFLOW_ACTION_TYPES).not.toContain('slack_reply');
    expect(WORKFLOW_ACTION_TYPES).not.toContain('start_session');
  });
});

describe('validateWorkflow — Slack rules', () => {
  it('normalises a minimal Slack rule', () => {
    expect(validateWorkflow(slackRule())).toEqual({
      integration: 'slack',
      name: 'Bugs channel',
      enabled: true,
      events: ['slack_message'],
      conditions: { slackTeamId: 'T1', channels: ['C1'] },
      actions: [{ type: 'slack_react', emoji: 'eyes' }],
      maxRunsPerPrPerHour: 5,
    });
  });

  it('trims and de-duplicates channels and drops defaults', () => {
    const out = validateWorkflow(
      slackRule({
        conditions: {
          slackTeamId: ' T1 ',
          channels: [' C1 ', 'C1', '', 'C2'],
          textContains: '   ',
          slackAuthors: { kind: 'any' },
          includeThreadReplies: false,
        },
      })
    );
    expect(out.conditions).toEqual({ slackTeamId: 'T1', channels: ['C1', 'C2'] });
  });

  it('keeps the conditions that differ from the defaults', () => {
    const out = validateWorkflow(
      slackRule({
        conditions: {
          slackTeamId: 'T1',
          channels: ['C1'],
          textContains: ' bug ',
          slackAuthors: { kind: 'users', userIds: [' U1 ', 'U1', 'U2'] },
          includeThreadReplies: true,
        },
      })
    );
    expect(out.conditions).toEqual({
      slackTeamId: 'T1',
      channels: ['C1'],
      textContains: 'bug',
      slackAuthors: { kind: 'users', userIds: ['U1', 'U2'] },
      includeThreadReplies: true,
    });
  });

  it('keeps `linked`, because it narrows the rule', () => {
    const out = validateWorkflow(
      slackRule({ conditions: { slackTeamId: 'T1', channels: ['C1'], slackAuthors: { kind: 'linked' } } })
    );
    expect(out.conditions.slackAuthors).toEqual({ kind: 'linked' });
  });

  it.each([
    ['no conditions at all', undefined, /needs a Slack workspace/],
    ['no team', { channels: ['C1'] }, /needs a Slack workspace/],
    ['a blank team', { slackTeamId: '  ', channels: ['C1'] }, /needs a Slack workspace/],
    ['a team that is not a string', { slackTeamId: 7, channels: ['C1'] }, /slackTeamId must be a string/],
    ['no channels', { slackTeamId: 'T1' }, /at least one channel/],
    ['an empty channel list', { slackTeamId: 'T1', channels: [] }, /at least one channel/],
    ['only blank channels', { slackTeamId: 'T1', channels: [' ', ''] }, /at least one channel/],
    ['channels that are not strings', { slackTeamId: 'T1', channels: [1] }, /array of strings/],
    ['a bad author kind', { slackTeamId: 'T1', channels: ['C1'], slackAuthors: { kind: 'bots' } }, /slackAuthors.kind/],
    ['a user list with nobody', { slackTeamId: 'T1', channels: ['C1'], slackAuthors: { kind: 'users', userIds: [] } }, /names no Slack users/],
    ['a non-boolean thread flag', { slackTeamId: 'T1', channels: ['C1'], includeThreadReplies: 'yes' }, /includeThreadReplies must be a boolean/],
    ['a non-string text', { slackTeamId: 'T1', channels: ['C1'], textContains: 3 }, /textContains must be a string/],
    ['an unknown condition', { slackTeamId: 'T1', channels: ['C1'], mood: 'happy' }, /Unknown condition "mood"/],
  ])('refuses %s', (_label, conditions, message) => {
    expect(() => validateWorkflow(slackRule({ conditions }))).toThrow(message);
  });

  it.each([
    ['start_session with a repo', { type: 'start_session', repositoryId: 'repo-1', prompt: ' Fix it ' }, { type: 'start_session', repositoryId: 'repo-1', prompt: 'Fix it' }],
    ['start_session letting Talyn choose', { type: 'start_session', prompt: 'Fix it' }, { type: 'start_session', repositoryId: null, prompt: 'Fix it' }],
    ['start_session with a blank repo', { type: 'start_session', repositoryId: '  ', prompt: 'x' }, { type: 'start_session', repositoryId: null, prompt: 'x' }],
    ['start_session with a model and internet', { type: 'start_session', repositoryId: null, prompt: 'x', model: ' opus ', internetAccess: true }, { type: 'start_session', repositoryId: null, prompt: 'x', model: 'opus', internetAccess: true }],
    ['start_session dropping internetAccess=false', { type: 'start_session', repositoryId: null, prompt: 'x', internetAccess: false }, { type: 'start_session', repositoryId: null, prompt: 'x' }],
    ['slack_reply', { type: 'slack_reply', text: ' On it: {{session.url}} ' }, { type: 'slack_reply', text: 'On it: {{session.url}}' }],
    ['slack_react with colons', { type: 'slack_react', emoji: ':white_check_mark:' }, { type: 'slack_react', emoji: 'white_check_mark' }],
    ['slack_react with a skin tone', { type: 'slack_react', emoji: ':+1::skin-tone-2:' }, { type: 'slack_react', emoji: '+1::skin-tone-2' }],
  ])('accepts %s', (_label, action, expected) => {
    expect(validateWorkflow(slackRule({ actions: [action] })).actions).toEqual([expected]);
  });

  it.each([
    ['start_session without a prompt', { type: 'start_session', repositoryId: null }, /prompt must be a non-empty string/],
    ['start_session with a blank prompt', { type: 'start_session', prompt: '   ' }, /prompt must be a non-empty string/],
    ['start_session with a numeric repo', { type: 'start_session', prompt: 'x', repositoryId: 4 }, /repositoryId must be a string or null/],
    ['start_session with a string internetAccess', { type: 'start_session', prompt: 'x', internetAccess: 'yes' }, /internetAccess must be a boolean/],
    ['slack_reply without text', { type: 'slack_reply', text: '' }, /text must be a non-empty string/],
    ['slack_react without an emoji', { type: 'slack_react', emoji: '::' }, /one emoji name/],
    ['slack_react with two emoji', { type: 'slack_react', emoji: 'eyes fire' }, /one emoji name/],
    ['slack_react with a number', { type: 'slack_react', emoji: 3 }, /emoji must be a string/],
    ['an unknown action', { type: 'dance' }, /not an action a Slack automation can take/],
  ])('refuses %s', (_label, action, message) => {
    expect(() => validateWorkflow(slackRule({ actions: [action] }))).toThrow(message);
  });
});

describe('validateWorkflow — cross-integration refusals', () => {
  it.each([
    ['a PR event on a Slack rule', slackRule({ events: ['pr_opened'] }), /"pr_opened" is a GitHub event, and this is a Slack automation/],
    ['a Slack event on a GitHub rule', githubRule({ events: ['slack_message'] }), /"slack_message" is a Slack event, and this is a GitHub automation/],
    ['an unknown event on a Slack rule', slackRule({ events: ['slack_reaction'] }), /not a Slack event Talyn can trigger on/],
    ['an unknown event on a GitHub rule', githubRule({ events: ['pr_exploded'] }), /not a PR event Talyn can trigger on/],
  ])('refuses %s', (_label, rule, message) => {
    expect(() => validateWorkflow(rule)).toThrow(message);
  });

  it.each(GITHUB_WORKFLOW_CONDITION_KEYS)('refuses the GitHub condition "%s" on a Slack rule', (key) => {
    const rule = slackRule({ conditions: { slackTeamId: 'T1', channels: ['C1'], [key]: 'x' } });
    expect(() => validateWorkflow(rule)).toThrow(
      new RegExp(`"${key}" is a GitHub condition, and this is a Slack automation`)
    );
  });

  it('refuses the legacy targetIsViewer on a Slack rule', () => {
    const rule = slackRule({ conditions: { slackTeamId: 'T1', channels: ['C1'], targetIsViewer: true } });
    expect(() => validateWorkflow(rule)).toThrow(/is a GitHub condition/);
  });

  it.each(SLACK_WORKFLOW_CONDITION_KEYS)('refuses the Slack condition "%s" on a GitHub rule', (key) => {
    const rule = githubRule({ conditions: { [key]: 'x' } });
    expect(() => validateWorkflow(rule)).toThrow(
      new RegExp(`"${key}" is a Slack condition, and this is a GitHub automation`)
    );
  });

  it.each(WORKFLOW_ACTION_TYPES)('refuses the PR action "%s" on a Slack rule', (type) => {
    const rule = slackRule({ actions: [{ ...emptyWorkflowAction(type) }] });
    expect(() => validateWorkflow(rule)).toThrow(
      new RegExp(`"${WORKFLOW_ACTION_LABELS[type]}" acts on a pull request, so a Slack automation cannot use it`)
    );
  });

  it.each(['slack_reply', 'slack_react'] as const)('refuses the Slack action "%s" on a GitHub rule', (type) => {
    const rule = githubRule({ actions: [emptyWorkflowAction(type)] });
    expect(() => validateWorkflow(rule)).toThrow(/acts on a Slack message, so a GitHub automation cannot use it/);
  });

  it('accepts start_session on both integrations', () => {
    const action = { type: 'start_session', repositoryId: null, prompt: 'Look at this' };
    expect(validateWorkflow(githubRule({ actions: [action] })).actions).toEqual([action]);
    expect(validateWorkflow(slackRule({ actions: [action] })).actions).toEqual([action]);
  });
});

describe('the vocabulary per integration', () => {
  it.each(['github', 'slack'] as const)('%s: every listed item validates on its own integration', (integration) => {
    const vocab = workflowVocabulary(integration);
    expect(vocab.integration).toBe(integration);
    expect(vocab.events.map((e) => e.event)).toEqual([...workflowEventsFor(integration)]);
    expect(vocab.actions.map((a) => a.type)).toEqual([...workflowActionsFor(integration)]);
    for (const { label } of [...vocab.events, ...vocab.actions, ...vocab.conditions]) {
      expect(label).toBeTruthy();
    }
    // Every action the vocabulary offers is one the validator accepts here.
    for (const { type } of vocab.actions) {
      const base = integration === 'slack' ? slackRule() : githubRule();
      const action =
        type === 'start_session'
          ? { type, repositoryId: null, prompt: 'x' }
          : type === 'slack_reply'
            ? { type, text: 'x' }
            : { ...emptyWorkflowAction(type) };
      if (['add_labels', 'remove_labels'].includes(type)) Object.assign(action, { labels: ['x'] });
      if (['request_reviewers', 'assign'].includes(type)) Object.assign(action, { users: ['x'] });
      if (type === 'comment') Object.assign(action, { body: 'x' });
      if (type === 'run_skill') Object.assign(action, { skillKey: 'platform:x' });
      if (type === 'run_prompt') Object.assign(action, { prompt: 'x' });
      expect(() => validateWorkflow({ ...base, actions: [action] }), type).not.toThrow();
    }
  });

  it('marks the Slack team and channels as required', () => {
    const required = workflowVocabulary('slack')
      .conditions.filter((c) => c.required)
      .map((c) => c.key);
    expect(required.sort()).toEqual(['channels', 'slackTeamId']);
  });

  it('lists the condition keys the validator accepts, and no others', () => {
    expect(workflowVocabulary('slack').conditions.map((c) => c.key).sort()).toEqual(
      [...SLACK_WORKFLOW_CONDITION_KEYS].sort()
    );
    expect(workflowVocabulary('github').conditions.map((c) => c.key).sort()).toEqual(
      [...GITHUB_WORKFLOW_CONDITION_KEYS].sort()
    );
  });

  it('labels, describes and blanks every action type', () => {
    for (const type of ALL_WORKFLOW_ACTION_TYPES) {
      expect(WORKFLOW_ACTION_LABELS[type]).toBeTruthy();
      const blank = emptyWorkflowAction(type);
      expect(blank.type).toBe(type);
      expect(describeWorkflowAction(blank)).toBeTruthy();
    }
    expect(describeWorkflowAction({ type: 'slack_react', emoji: 'eyes' })).toBe('React with :eyes:');
  });
});

describe('editor helpers', () => {
  it.each([
    ['github', 'pr_opened'],
    ['slack', 'slack_message'],
  ] as const)('a blank %s rule starts on %s and is not yet savable', (integration, event) => {
    const blank = emptyWorkflowInput(integration);
    expect(blank.integration).toBe(integration);
    expect(blank.events).toEqual([event]);
    expect(workflowInputProblem(blank)).not.toBeNull();
  });

  it('keeps a rule’s integration through workflowToInput', () => {
    const stored = { ...(validateWorkflow(slackRule()) as object), id: 'w', workspaceId: 'ws', createdAt: '', updatedAt: '' } as WorkflowDefinition;
    expect(workflowToInput(stored).integration).toBe('slack');
    const { integration: _drop, ...old } = stored;
    void _drop;
    expect(workflowToInput(old as WorkflowDefinition).integration).toBe('github');
  });

  it.each([
    [null, false],
    [{ workflows: true }, false],
    [{ workflows: false, slackChannelRules: true }, false],
    [{ workflows: true, slackChannelRules: false }, false],
    [{ workflows: true, slackChannelRules: true }, true],
  ])('slackRulesOffered(%j) is %s', (features, expected) => {
    expect(slackRulesOffered(features)).toBe(expected);
  });
});

describe('workflowMatches — Slack facts', () => {
  const base: WorkflowConditions = { slackTeamId: 'T1', channels: ['C1', 'C2'] };

  it.each<[string, WorkflowConditions, Partial<SlackEventFacts>, boolean]>([
    ['a message in a watched channel', base, {}, true],
    ['a message in the second channel', base, { channelId: 'C2' }, true],
    ['a channel id in another case', { ...base, channels: ['c1'] }, {}, true],
    ['a channel the rule does not watch', base, { channelId: 'C9' }, false],
    ['another Slack team', base, { teamId: 'T2' }, false],
    ['a rule that lost its team', { channels: ['C1'] }, {}, false],
    ['a rule that lost its channels', { slackTeamId: 'T1' }, {}, false],
    ['a rule with an empty channel list', { slackTeamId: 'T1', channels: [] }, {}, false],
  ])('%s → %s', (_label, conditions, over, expected) => {
    expect(workflowMatches(slackDef(conditions), slackFacts(over))).toBe(expected);
  });

  it.each([
    ['a top-level message', { threadTs: null }, false, true],
    ['the first message of a thread', { threadTs: '1700000000.000100' }, false, true],
    ['a reply, replies off', { threadTs: '1699999999.000001' }, false, false],
    ['a reply, replies on', { threadTs: '1699999999.000001' }, true, true],
    ['a top-level message, replies on', { threadTs: null }, true, true],
  ] as const)('threads: %s', (_label, over, includeThreadReplies, expected) => {
    const conditions = includeThreadReplies ? { ...base, includeThreadReplies } : base;
    expect(workflowMatches(slackDef(conditions), slackFacts(over))).toBe(expected);
  });

  it.each<[string, WorkflowSlackAuthorMatch | undefined, Partial<SlackEventFacts>, boolean]>([
    ['default (any), linked author', undefined, { authorLinked: true }, true],
    ['default (any), unlinked author', undefined, { authorLinked: false }, true],
    ['linked, linked author', { kind: 'linked' }, { authorLinked: true }, true],
    ['linked, unlinked author', { kind: 'linked' }, { authorLinked: false }, false],
    ['any, unlinked author', { kind: 'any' }, { authorLinked: false }, true],
    ['users, listed', { kind: 'users', userIds: ['U9', 'U1'] }, { authorLinked: false }, true],
    ['users, listed in another case', { kind: 'users', userIds: ['u1'] }, {}, true],
    ['users, not listed even when linked', { kind: 'users', userIds: ['U9'] }, { authorLinked: true }, false],
  ])('authors: %s → %s', (_label, slackAuthors, over, expected) => {
    const conditions = slackAuthors ? { ...base, slackAuthors } : base;
    expect(workflowMatches(slackDef(conditions), slackFacts(over))).toBe(expected);
  });

  it.each([
    ['', 'anything', true],
    ['broken', 'The checkout page is broken', true],
    ['BROKEN', 'The checkout page is broken', true],
    ['  broken  ', 'The checkout page is broken', true],
    ['outage', 'The checkout page is broken', false],
    ['broken', '', false],
  ])('textContains %j in %j → %s', (textContains, text, expected) => {
    expect(workflowMatches(slackDef({ ...base, textContains }), slackFacts({ text }))).toBe(expected);
  });

  it('never matches across integrations', () => {
    const githubDef = { events: ['pr_opened' as const], conditions: {} };
    expect(workflowMatches(githubDef, slackFacts())).toBe(false);
    expect(workflowMatches(slackDef(base), githubFacts)).toBe(false);
    // A Slack rule that somehow names a PR event still never matches PR facts.
    expect(
      workflowMatches({ integration: 'slack', events: ['pr_opened'], conditions: base }, githubFacts)
    ).toBe(false);
  });

  it('keeps matching GitHub facts with no integration tag, as stored before integrations', () => {
    expect(workflowMatches({ events: ['pr_opened'], conditions: {} }, githubFacts)).toBe(true);
    expect(
      workflowMatches({ events: ['pr_opened'], conditions: {} }, { ...githubFacts, integration: 'github' })
    ).toBe(true);
  });

  it.each([
    [{ ts: '1', threadTs: null }, false],
    [{ ts: '1', threadTs: '1' }, false],
    [{ ts: '2', threadTs: '1' }, true],
    [{ ts: '2', threadTs: '' }, false],
  ])('isSlackThreadReply(%j) is %s', (facts, expected) => {
    expect(isSlackThreadReply(facts)).toBe(expected);
  });
});

describe('workflowSubjectOf', () => {
  it.each([
    [githubFacts, { key: 'pr:acme/widget#42', label: 'acme/widget#42' }],
    [slackFacts(), { key: 'slack:T1:C1', label: '#eng-bugs' }],
    [slackFacts({ channelName: undefined }), { key: 'slack:T1:C1', label: 'C1' }],
    [slackFacts({ channelId: 'C2', teamId: 'T9' }), { key: 'slack:T9:C2', label: '#eng-bugs' }],
  ])('subject of %#', (facts, expected) => {
    expect(workflowSubjectOf(facts)).toEqual(expected);
  });
});

describe('renderWorkflowTemplate', () => {
  it.each([
    ['{{pr.number}} {{pr.title}}', '42 Add a widget'],
    ['{{ pr.url }}', 'https://github.com/acme/widget/pull/42'],
    ['{{pr.author}} by {{actor}} in {{repo}}', 'alice by bob in acme/widget'],
    ['{{pr.baseBranch}} <- {{pr.headBranch}}', 'main <- alice/widget'],
    ['{{event}}', 'PR opened'],
    ['{{message.text}}', '{{message.text}}'],
    ['{{session.url}}', '{{session.url}}'],
    ['{{pr.reviewer}}', '{{pr.reviewer}}'],
  ])('GitHub: %j → %j', (body, expected) => {
    expect(renderWorkflowTemplate(body, githubFacts)).toBe(expected);
    // The old name renders exactly the same.
    expect(renderWorkflowComment(body, githubFacts)).toBe(expected);
  });

  it.each([
    ['{{message.text}}', {}, 'The checkout page is broken'],
    ['{{message.permalink}}', {}, 'https://acme.slack.com/archives/C1/p1700000000000100'],
    ['{{message.permalink}}', { permalink: undefined }, '{{message.permalink}}'],
    ['{{channel}}', {}, '#eng-bugs'],
    ['{{channel}}', { channelName: undefined }, '<#C1>'],
    ['{{event}}', {}, 'New message in a channel'],
    ['{{pr.number}}', {}, '{{pr.number}}'],
    ['{{repo}}', {}, '{{repo}}'],
  ] as const)('Slack: %j with %j → %j', (body, over, expected) => {
    expect(renderWorkflowTemplate(body, slackFacts(over))).toBe(expected);
  });

  it.each([
    [{ sessionUrl: 'https://app.talyn.dev/s/1' }, 'On it: https://app.talyn.dev/s/1'],
    [{ sessionUrl: null }, 'On it: {{session.url}}'],
    [{}, 'On it: {{session.url}}'],
  ])('session.url with %j', (extras, expected) => {
    expect(renderWorkflowTemplate('On it: {{session.url}}', slackFacts(), extras)).toBe(expected);
    expect(renderWorkflowTemplate('On it: {{session.url}}', githubFacts, extras)).toBe(expected);
  });
});

describe('workflowFactsFromRun — both shapes', () => {
  const githubRow = {
    integration: 'github',
    repoFullName: 'acme/widget',
    prNumber: 42,
    prTitle: 'Add a widget',
    prUrl: 'https://github.com/acme/widget/pull/42',
    prAuthor: 'alice',
    event: 'pr_opened',
  };

  it('reads stored GitHub facts back unchanged', () => {
    expect(workflowFactsFromRun({ ...githubRow, facts: githubFacts })).toEqual(githubFacts);
  });

  it('reads stored Slack facts back unchanged, so a parked Slack run can retry', () => {
    const facts = slackFacts({ threadTs: '1699999999.000001' });
    expect(
      workflowFactsFromRun({
        integration: 'slack',
        repoFullName: null,
        prNumber: null,
        prTitle: '',
        prUrl: '',
        prAuthor: '',
        event: 'slack_message',
        facts,
      })
    ).toEqual(facts);
  });

  it('rebuilds a GitHub run from its columns when no facts were stored', () => {
    expect(workflowFactsFromRun({ ...githubRow, facts: null })).toMatchObject({
      event: 'pr_opened',
      repoFullName: 'acme/widget',
      number: 42,
      unknownFields: ['baseBranch', 'defaultBranch', 'headBranch', 'draft', 'labels'],
    });
  });

  it.each([
    ['a Slack run with no facts', { integration: 'slack', facts: null }],
    ['a Slack run whose facts lost the channel', { integration: 'slack', facts: { integration: 'slack', teamId: 'T1' } }],
    ['a run with no PR columns and no facts', { repoFullName: null, prNumber: null, facts: null }],
  ])('returns null for %s', (_label, over) => {
    expect(workflowFactsFromRun({ ...githubRow, ...over })).toBeNull();
  });
});
