import { describe, expect, it } from 'vitest';
import {
  effectiveWorkflowActions,
  integrationOffered,
  integrationRulesOffered,
  ISSUE_MERGE_COMMENT,
  ISSUE_START_COMMENT_SESSION,
  ISSUE_START_COMMENT_TASK,
  issueConditionsMatch,
  issueMergeActions,
  issueRulesOffered,
  renderWorkflowTemplate,
  validateWorkflow,
  workflowMatches,
  workflowSubjectOf,
  workflowVocabulary,
  type IssueEventFacts,
  type WorkflowConditions,
} from '@talyn/shared';

/**
 * The issue rule vocabulary in `@talyn/shared`: the validator (the API's 400
 * message), the matcher, the start comment and the merge actions, the
 * template and the subject the rate cap counts by.
 */

const linearFacts = (over: Partial<IssueEventFacts> = {}): IssueEventFacts => ({
  integration: 'linear',
  event: 'issue_created',
  connectionId: 'conn-1',
  externalId: 'iss-1',
  identifier: 'ENG-12',
  title: 'Crash on save',
  body: 'The editor crashes when saving.',
  url: 'https://linear.app/acme/issue/ENG-12',
  labels: ['Bug', 'Frontend'],
  assignee: 'Ada',
  assigneeId: 'user-ada',
  team: 'ENG',
  project: 'Editor',
  status: 'Todo',
  priority: 'High',
  actor: 'Ada',
  ...over,
});

const githubFacts = (over: Partial<IssueEventFacts> = {}): IssueEventFacts => ({
  integration: 'github_issues',
  event: 'issue_created',
  connectionId: null,
  externalId: '9001',
  identifier: 'acme/web#7',
  title: 'Broken link',
  body: 'The footer link is broken.',
  url: 'https://github.com/acme/web/issues/7',
  labels: ['bug'],
  assignee: 'octocat',
  team: null,
  project: null,
  status: 'open',
  priority: null,
  actor: 'octocat',
  author: 'octocat',
  repoFullName: 'acme/web',
  number: 7,
  ...over,
});

const session = { type: 'start_session', repositoryId: 'r1', prompt: 'Fix {{issue.identifier}}' };

describe('validateWorkflow on issue rules', () => {
  it.each([
    ['linear needs a connection', { integration: 'linear', conditions: {} }, 'needs a Linear workspace'],
    ['linear session needs a repository', { integration: 'linear', conditions: { connectionId: 'c' }, actions: [{ ...session, repositoryId: null }] }, 'choose the repository'],
    ['linear task needs a repository', { integration: 'linear', conditions: { connectionId: 'c' }, actions: [{ type: 'start_task', repositoryId: null, prompt: 'x' }] }, 'choose the repository'],
    ['two starts', { integration: 'github_issues', actions: [session, { type: 'start_task', repositoryId: null, prompt: 'x' }] }, 'one session or one task'],
    ['a Linear condition on GitHub', { integration: 'github_issues', conditions: { teams: ['ENG'] } }, 'Linear condition'],
    ['a GitHub Issues condition on Linear', { integration: 'linear', conditions: { connectionId: 'c', issueAuthors: ['x'] } }, 'GitHub Issues condition'],
    ['a PR condition on an issue rule', { integration: 'linear', conditions: { connectionId: 'c', draft: true } }, 'GitHub condition'],
    ['talyn assignee on GitHub', { integration: 'github_issues', conditions: { issueAssignee: { kind: 'talyn' } } }, 'Only a Linear issue'],
    ['me assignee on Linear', { integration: 'linear', conditions: { connectionId: 'c', issueAssignee: { kind: 'me' } } }, 'GitHub Issues only'],
    ['people with nobody', { integration: 'github_issues', conditions: { issueAssignee: { kind: 'people', people: [] } } }, 'names nobody'],
    ['labelName without issue_labeled', { integration: 'github_issues', conditions: { labelName: 'bug' } }, 'only applies to'],
    ['a GitHub status that is not one', { integration: 'github_issues', actions: [{ type: 'issue_set_status', status: 'Done-ish' }] }, 'done, open or closed'],
    ['an empty comment', { integration: 'github_issues', actions: [{ type: 'issue_comment', body: '  ' }] }, 'non-empty'],
    ['a PR action', { integration: 'github_issues', actions: [{ type: 'add_labels', labels: ['x'] }] }, 'acts on a pull request'],
    ['a PR event', { integration: 'linear', events: ['pr_opened'], conditions: { connectionId: 'c' } }, 'is a GitHub event'],
    ['write-back on a webhook rule', { integration: 'webhook', events: ['webhook_received'], actions: [{ ...session, issueStartComment: false }] }, 'for issue automations'],
    ['a non-boolean write-back flag', { integration: 'github_issues', actions: [{ ...session, issueDoneOnMerge: 'no' }] }, 'must be a boolean'],
  ])('refuses %s', (_name, over, message) => {
    expect(() =>
      validateWorkflow({ name: 'Rule', events: ['issue_created'], actions: [session], ...over })
    ).toThrow(message);
  });

  it('normalises a full Linear rule', () => {
    const rule = validateWorkflow({
      integration: 'linear',
      name: ' Triage ',
      events: ['issue_created', 'issue_labeled'],
      conditions: {
        connectionId: ' conn-1 ',
        teams: ['ENG', ' ENG '],
        statuses: ['Todo'],
        priorities: ['High'],
        labelsAny: ['bug'],
        labelName: ' bug ',
        issueAssignee: { kind: 'talyn' },
        titleContains: '  ',
      },
      actions: [
        { ...session, issueStartComment: false, issueDoneOnMerge: true },
        { type: 'issue_comment', body: 'Hi', afterStart: true },
        { type: 'issue_set_status', status: ' In Progress ' },
      ],
    });
    expect(rule.integration).toBe('linear');
    expect(rule.conditions).toEqual({
      connectionId: 'conn-1',
      teams: ['ENG'],
      statuses: ['Todo'],
      priorities: ['High'],
      labelsAny: ['bug'],
      labelName: 'bug',
      issueAssignee: { kind: 'talyn' },
    });
    // Only `false` is stored; `afterStart` is Talyn's marker and never stored.
    expect(rule.actions).toEqual([
      { type: 'start_session', repositoryId: 'r1', prompt: 'Fix {{issue.identifier}}', issueStartComment: false },
      { type: 'issue_comment', body: 'Hi' },
      { type: 'issue_set_status', status: 'In Progress' },
    ]);
  });

  it.each([
    ['start_session', { ...session, repositoryId: null }],
    ['start_task', { type: 'start_task', repositoryId: '', prompt: 'x' }],
  ])('lets a GitHub Issues %s leave the repository to the issue', (_name, action) => {
    const rule = validateWorkflow({ integration: 'github_issues', name: 'R', events: ['issue_created'], actions: [action] });
    expect((rule.actions[0] as { repositoryId: string | null }).repositoryId).toBeNull();
  });

  it('keeps a webhook start_task requiring its repository', () => {
    expect(() =>
      validateWorkflow({ integration: 'webhook', name: 'R', events: ['webhook_received'], actions: [{ type: 'start_task', repositoryId: null, prompt: 'x' }] })
    ).toThrow('choose the repository');
  });

  it.each([
    ['done', 'done'],
    ['CLOSED', 'closed'],
    ['Open', 'open'],
  ])('lowercases the GitHub status %s', (given, stored) => {
    const rule = validateWorkflow({
      integration: 'github_issues',
      name: 'R',
      events: ['issue_commented'],
      actions: [{ type: 'issue_set_status', status: given }],
    });
    expect(rule.actions[0]).toEqual({ type: 'issue_set_status', status: stored });
  });

  it('does not offer the merge event as a trigger', () => {
    expect(() =>
      validateWorkflow({ integration: 'github_issues', name: 'R', events: ['issue_pr_merged'], actions: [session] })
    ).toThrow();
    expect(workflowVocabulary('linear').events.map((e) => e.event)).not.toContain('issue_pr_merged');
  });

  it.each(['linear', 'github_issues'] as const)('lists %s conditions and actions', (integration) => {
    const vocabulary = workflowVocabulary(integration);
    expect(vocabulary.actions.map((a) => a.type)).toEqual(['start_session', 'start_task', 'issue_comment', 'issue_set_status']);
    const keys = vocabulary.conditions.map((c) => c.key);
    expect(keys.includes('connectionId')).toBe(integration === 'linear');
    expect(keys.includes('repos')).toBe(integration === 'github_issues');
  });
});

describe('issueConditionsMatch', () => {
  it.each<[string, WorkflowConditions, Partial<IssueEventFacts>, boolean]>([
    ['no conditions', { connectionId: 'conn-1' }, {}, true],
    ['another connection', { connectionId: 'conn-2' }, {}, false],
    ['no connection on a Linear rule', {}, {}, false],
    ['team matches, any case', { connectionId: 'conn-1', teams: ['eng'] }, {}, true],
    ['team does not match', { connectionId: 'conn-1', teams: ['OPS'] }, {}, false],
    ['team unknown', { connectionId: 'conn-1', teams: ['ENG'] }, { unknownFields: ['team'] }, false],
    ['project', { connectionId: 'conn-1', projects: ['editor'] }, {}, true],
    ['status', { connectionId: 'conn-1', statuses: ['In Progress'] }, {}, false],
    ['priority', { connectionId: 'conn-1', priorities: ['high', 'urgent'] }, {}, true],
    ['labels any', { connectionId: 'conn-1', labelsAny: ['bug', 'x'] }, {}, true],
    ['labels all', { connectionId: 'conn-1', labelsAll: ['bug', 'x'] }, {}, false],
    ['labels none', { connectionId: 'conn-1', labelsNone: ['frontend'] }, {}, false],
    ['labels unknown', { connectionId: 'conn-1', labelsAny: ['bug'] }, { unknownFields: ['labels'] }, false],
    ['label that was added', { connectionId: 'conn-1', labelName: 'Bug' }, { event: 'issue_labeled', labelName: 'bug' }, true],
    ['another label was added', { connectionId: 'conn-1', labelName: 'Bug' }, { event: 'issue_labeled', labelName: 'docs' }, false],
    ['assigned to Talyn', { connectionId: 'conn-1', issueAssignee: { kind: 'talyn' } }, { assignedToApp: true }, true],
    ['not assigned to Talyn', { connectionId: 'conn-1', issueAssignee: { kind: 'talyn' } }, {}, false],
    ['unassigned', { connectionId: 'conn-1', issueAssignee: { kind: 'unassigned' } }, { assignee: null, assigneeId: null }, true],
    ['assigned is not unassigned', { connectionId: 'conn-1', issueAssignee: { kind: 'unassigned' } }, {}, false],
    ['people by name', { connectionId: 'conn-1', issueAssignee: { kind: 'people', people: ['ada'] } }, {}, true],
    ['people by id', { connectionId: 'conn-1', issueAssignee: { kind: 'people', people: ['USER-ADA'] } }, {}, true],
    ['people miss', { connectionId: 'conn-1', issueAssignee: { kind: 'people', people: ['bob'] } }, {}, false],
    ['assignee unknown', { connectionId: 'conn-1', issueAssignee: { kind: 'people', people: ['ada'] } }, { unknownFields: ['assignee'] }, false],
    ['title contains', { connectionId: 'conn-1', titleContains: 'CRASH' }, {}, true],
    ['body contains', { connectionId: 'conn-1', bodyContains: 'saving' }, {}, true],
    ['body in the comment', { connectionId: 'conn-1', bodyContains: '/talyn' }, { comment: { id: 'c', body: 'please /talyn fix', author: null } }, true],
    ['body nowhere', { connectionId: 'conn-1', bodyContains: '/talyn' }, {}, false],
  ])('Linear: %s', (_name, conditions, over, expected) => {
    expect(issueConditionsMatch(conditions, linearFacts(over))).toBe(expected);
  });

  it.each<[string, WorkflowConditions, Partial<IssueEventFacts>, string | null, boolean]>([
    ['repo', { repos: ['ACME/web'] }, {}, null, true],
    ['another repo', { repos: ['acme/api'] }, {}, null, false],
    ['author', { issueAuthors: ['OctoCat'] }, {}, null, true],
    ['another author', { issueAuthors: ['hubot'] }, {}, null, false],
    ['assigned to me', { issueAssignee: { kind: 'me' } }, {}, 'octocat', true],
    ['me is unknown', { issueAssignee: { kind: 'me' } }, {}, null, false],
    ['me is someone else', { issueAssignee: { kind: 'me' } }, {}, 'hubot', false],
    ['closed status', { statuses: ['closed'] }, { status: 'closed' }, null, true],
  ])('GitHub Issues: %s', (_name, conditions, over, viewer, expected) => {
    expect(issueConditionsMatch(conditions, githubFacts(over), viewer)).toBe(expected);
  });

  it('only matches a rule of the same integration and event', () => {
    const rule = { integration: 'linear' as const, events: ['issue_created' as const], conditions: { connectionId: 'conn-1' } };
    expect(workflowMatches(rule, linearFacts())).toBe(true);
    expect(workflowMatches(rule, linearFacts({ event: 'issue_commented' }))).toBe(false);
    expect(workflowMatches({ ...rule, integration: 'github_issues' }, linearFacts())).toBe(false);
    expect(workflowMatches({ events: ['pr_opened'], conditions: {} }, githubFacts())).toBe(false);
  });
});

describe('the start comment and the merge actions', () => {
  it.each([
    ['session, comment on', { ...session }, [ISSUE_START_COMMENT_SESSION]],
    ['task, comment on', { type: 'start_task', repositoryId: 'r1', prompt: 'x' }, [ISSUE_START_COMMENT_TASK]],
    ['session, comment off', { ...session, issueStartComment: false }, []],
  ])('adds the comment after a start action: %s', (_name, action, comments) => {
    const rule = validateWorkflow({ integration: 'github_issues', name: 'R', events: ['issue_created'], actions: [action, { type: 'issue_set_status', status: 'open' }] });
    const actions = effectiveWorkflowActions(rule);
    expect(actions[0].type).toBe(action.type);
    const added = actions.filter((a) => a.type === 'issue_comment');
    expect(added.map((a) => (a as { body: string }).body)).toEqual(comments);
    if (comments.length) expect(actions[1]).toMatchObject({ type: 'issue_comment', afterStart: true });
    expect(actions[actions.length - 1]).toEqual({ type: 'issue_set_status', status: 'open' });
  });

  it('adds nothing on a rule that is not an issue rule', () => {
    const rule = validateWorkflow({ integration: 'webhook', name: 'R', events: ['webhook_received'], actions: [session] });
    expect(effectiveWorkflowActions(rule)).toEqual(rule.actions);
  });

  it.each([
    [undefined, [{ type: 'issue_comment', body: ISSUE_MERGE_COMMENT }, { type: 'issue_set_status', status: 'done' }]],
    [true, [{ type: 'issue_comment', body: ISSUE_MERGE_COMMENT }, { type: 'issue_set_status', status: 'done' }]],
    [false, [{ type: 'issue_comment', body: ISSUE_MERGE_COMMENT }]],
  ])('merge actions with issueDoneOnMerge=%s', (done, expected) => {
    const action = done === undefined ? session : { ...session, issueDoneOnMerge: done };
    const rule = validateWorkflow({ integration: 'linear', name: 'R', events: ['issue_created'], conditions: { connectionId: 'c' }, actions: [action] });
    expect(issueMergeActions(rule)).toEqual(expected);
  });
});

describe('templates, subjects and gates', () => {
  it('renders issue identifiers and the work links, never the issue body', () => {
    const facts = linearFacts({ mergedPrUrl: 'https://github.com/acme/web/pull/3' });
    const out = renderWorkflowTemplate(
      '{{issue.identifier}} {{issue.url}} {{issue.title}} {{session.url}} {{task.url}} {{pr.url}} {{issue.body}} {{event}}',
      facts,
      { sessionUrl: 'S', taskUrl: 'T' }
    );
    expect(out).toBe(
      'ENG-12 https://linear.app/acme/issue/ENG-12 Crash on save S T https://github.com/acme/web/pull/3 {{issue.body}} Issue created'
    );
  });

  it('keys the rate cap per issue', () => {
    expect(workflowSubjectOf(linearFacts())).toEqual({ key: 'issue:linear:iss-1', label: 'ENG-12' });
    expect(workflowSubjectOf(githubFacts())).toEqual({ key: 'issue:github_issues:9001', label: 'acme/web#7' });
  });

  it.each([
    [{ workflows: true, issueRules: true }, true],
    [{ workflows: true, issueRules: false }, false],
    [{ workflows: false, issueRules: true }, false],
    [null, false],
  ])('offers the issue cards for %j', (features, expected) => {
    expect(issueRulesOffered(features)).toBe(expected);
    expect(integrationOffered(features, 'linear')).toBe(expected);
    expect(integrationOffered(features, 'github_issues')).toBe(expected);
    expect(integrationRulesOffered(features, 'linear')).toBe(expected);
  });
});
