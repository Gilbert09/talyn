import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowFacts } from '@talyn/shared';
import { sessionOriginEventLabel, workflowOriginDetails, SESSION_ORIGIN_EXCERPT_MAX } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { loopRuns, loops, workflowRuns, workflows, workspaces } from '../db/schema.js';
import type { Database } from '../db/client.js';

import { sessionOriginOf } from '../services/workbenches/origin.js';

const POSTHOG: WorkflowFacts = {
  integration: 'posthog_inbox',
  event: 'report_ready',
  connectionId: 'c',
  projectId: '2',
  reportId: 'rep-1',
  updatedAt: '2026-11-20T00:00:00Z',
  title: '  Signup button fails on Safari  ',
  summary: 'Users on Safari\n\ncannot sign up.',
  url: 'https://us.posthog.com/project/2/inbox/rep-1',
  status: 'ready',
  priority: 'P1',
  actionability: 'immediately_actionable',
  alreadyAddressed: false,
  suppressionSource: null,
  sourceProducts: ['error_tracking', 'session_replay'],
  scout: 'signup-scout',
  repository: 'acme/web',
  suggestedReviewers: [],
  signalCount: 3,
};

const LINEAR: WorkflowFacts = {
  integration: 'linear',
  event: 'issue_commented',
  connectionId: 'c',
  externalId: 'x',
  identifier: 'ENG-12',
  title: 'Fix login',
  body: 'The body',
  url: 'https://linear.app/acme/issue/ENG-12',
  labels: ['bug', 'p1'],
  assignee: 'ana',
  team: 'ENG',
  project: null,
  status: 'Todo',
  priority: 'High',
  actor: 'bo',
  comment: { id: 'cm', body: 'Please take this', author: 'bo' },
};

const SLACK: WorkflowFacts = {
  integration: 'slack',
  event: 'slack_message',
  teamId: 'T',
  channelId: 'C1',
  channelName: 'eng-bugs',
  userId: 'U1',
  text: 'The deploy is broken',
  ts: '1.0',
  threadTs: null,
  permalink: 'https://acme.slack.com/archives/C1/p1',
  authorLinked: true,
};

const WEBHOOK: WorkflowFacts = {
  integration: 'webhook',
  event: 'webhook_received',
  ruleId: 'wf',
  connectionId: 'c',
  deliveryRowId: 'd',
  deliveryId: 'del-9',
  receivedAt: '2026-11-20T00:00:00Z',
  payload: null,
  headers: {},
};

const GITHUB: WorkflowFacts = {
  event: 'pr_labeled',
  repoFullName: 'acme/web',
  number: 42,
  title: 'Add dark mode',
  url: 'https://github.com/acme/web/pull/42',
  author: { login: 'ana', isBot: false },
  actor: { login: 'bo', isBot: false },
  baseBranch: 'main',
  defaultBranch: 'main',
  headBranch: 'dark',
  draft: false,
  labels: ['ui'],
  labelName: 'ship-it',
};

describe('workflowOriginDetails', () => {
  it.each<[string, WorkflowFacts, ReturnType<typeof workflowOriginDetails>]>([
    [
      'a PostHog Inbox report',
      POSTHOG,
      {
        subject: { label: 'Signup button fails on Safari', url: 'https://us.posthog.com/project/2/inbox/rep-1' },
        facts: [
          { label: 'Priority', value: 'P1' },
          { label: 'Actionability', value: 'Immediately actionable' },
          { label: 'Repository', value: 'acme/web' },
          { label: 'Signals', value: '3' },
          { label: 'Scout', value: 'signup-scout' },
          { label: 'Products', value: 'error_tracking, session_replay' },
        ],
        excerpt: 'Users on Safari cannot sign up.',
      },
    ],
    [
      'a Linear comment',
      LINEAR,
      {
        subject: { label: 'ENG-12 Fix login', url: 'https://linear.app/acme/issue/ENG-12' },
        facts: [
          { label: 'Status', value: 'Todo' },
          { label: 'Priority', value: 'High' },
          { label: 'Assignee', value: 'ana' },
          { label: 'Team', value: 'ENG' },
          { label: 'Labels', value: 'bug, p1' },
          { label: 'By', value: 'bo' },
        ],
        excerpt: 'Please take this',
      },
    ],
    [
      'a Slack message',
      SLACK,
      {
        subject: { label: 'Slack message', url: 'https://acme.slack.com/archives/C1/p1' },
        facts: [{ label: 'Channel', value: '#eng-bugs' }],
        excerpt: 'The deploy is broken',
      },
    ],
    [
      'a webhook request',
      WEBHOOK,
      { subject: { label: 'Webhook request', url: null }, facts: [{ label: 'Delivery', value: 'del-9' }], excerpt: null },
    ],
    [
      'a GitHub pull request',
      GITHUB,
      {
        subject: { label: '#42 Add dark mode', url: 'https://github.com/acme/web/pull/42' },
        facts: [
          { label: 'Repository', value: 'acme/web' },
          { label: 'Author', value: 'ana' },
          { label: 'By', value: 'bo' },
          { label: 'Branch', value: 'dark → main' },
          { label: 'Label', value: 'ship-it' },
        ],
        excerpt: null,
      },
    ],
  ])('describes %s', (_name, facts, expected) => {
    expect(workflowOriginDetails(facts)).toEqual(expected);
  });

  it.each<[string, WorkflowFacts, string]>([
    ['an untitled report', { ...POSTHOG, title: '  ' }, 'Report rep-1'],
    ['an untitled issue', { ...LINEAR, title: '' }, 'ENG-12'],
    ['an untitled pull request', { ...GITHUB, title: '' }, 'acme/web#42'],
  ])('labels %s by its id', (_name, facts, label) => {
    expect(workflowOriginDetails(facts).subject?.label).toBe(label);
  });

  it('leaves out empty facts', () => {
    const facts = workflowOriginDetails({
      ...POSTHOG,
      priority: null,
      actionability: null,
      repository: null,
      signalCount: 0,
      scout: null,
      sourceProducts: [],
      summary: '   ',
    });
    expect(facts.facts).toEqual([]);
    expect(facts.excerpt).toBeNull();
  });

  it('keeps an unknown actionability as PostHog sent it', () => {
    expect(workflowOriginDetails({ ...POSTHOG, actionability: 'later' }).facts).toContainEqual({
      label: 'Actionability',
      value: 'later',
    });
  });

  it('falls back to the issue body when the event has no comment', () => {
    expect(workflowOriginDetails({ ...LINEAR, comment: undefined }).excerpt).toBe('The body');
  });

  it('names the same GitHub author and actor once', () => {
    const facts = workflowOriginDetails({ ...GITHUB, actor: { login: 'ana', isBot: false } }).facts;
    expect(facts.filter((f) => f.label === 'By')).toEqual([]);
  });

  it('cuts a long excerpt', () => {
    const excerpt = workflowOriginDetails({ ...SLACK, text: 'a'.repeat(1000) }).excerpt!;
    expect(excerpt).toHaveLength(SESSION_ORIGIN_EXCERPT_MAX);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it.each<[string, { label: string | null; url: string | null } | undefined, ReturnType<typeof workflowOriginDetails>['subject']]>([
    ['the run columns', { label: 'acme/web#7', url: 'https://github.com/acme/web/pull/7' }, { label: 'acme/web#7', url: 'https://github.com/acme/web/pull/7' }],
    ['an empty URL', { label: '#eng', url: '' }, { label: '#eng', url: null }],
    ['nothing', undefined, null],
  ])('without facts, uses %s', (_name, fallback, subject) => {
    expect(workflowOriginDetails(null, fallback)).toEqual({ subject, facts: [], excerpt: null });
  });
});

describe('sessionOriginEventLabel', () => {
  it.each<[string | null | undefined, string | null]>([
    ['report_ready', 'Report ready for work'],
    ['pr_opened', 'PR opened'],
    ['something_new', 'something_new'],
    [null, null],
    ['', null],
  ])('%s → %s', (event, label) => {
    expect(sessionOriginEventLabel(event)).toBe(label);
  });
});

describe('sessionOriginOf', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const at = new Date('2026-11-20T10:00:00.000Z');

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: 'owner' });
    await seedUser(db, { id: 'owner-other' });
    await db.insert(workspaces).values([
      { id: 'ws', ownerId: 'owner', name: 'mine', settings: {} },
      { id: 'ws-other', ownerId: 'owner-other', name: 'theirs', settings: {} },
    ]);
    await db.insert(workflows).values([
      { id: 'wf', workspaceId: 'ws', integration: 'posthog_inbox', name: 'Fix P1 reports', events: [], actions: [] },
      { id: 'wf-other', workspaceId: 'ws-other', name: 'Theirs', events: [], actions: [] },
    ]);
    const run = {
      workflowId: 'wf',
      workspaceId: 'ws',
      integration: 'posthog_inbox',
      subjectLabel: 'Signup button fails on Safari',
      event: 'report_ready',
      status: 'succeeded',
      createdAt: at,
    };
    await db.insert(workflowRuns).values([
      { ...run, id: 'run', deliveryId: 'd1', facts: POSTHOG },
      { ...run, id: 'run-manual', deliveryId: 'd2', facts: POSTHOG, triggerSource: 'manual', triggeredByLabel: 'tom@example.test' },
      { ...run, id: 'run-old', deliveryId: 'd3', facts: null, prUrl: '' },
      { ...run, id: 'run-other', workflowId: 'wf-other', workspaceId: 'ws-other', deliveryId: 'd4', facts: GITHUB },
    ]);
    await db.insert(loops).values({
      id: 'loop',
      workspaceId: 'ws',
      name: 'Morning triage',
      prompt: 'p',
      cron: '0 9 * * *',
      timezone: 'UTC',
      provider: 'selfhosted',
      model: 'claude-opus-5-5',
      repoFullName: 'acme/web',
    });
    await db.insert(loopRuns).values([
      {
        id: 'lr',
        loopId: 'loop',
        workspaceId: 'ws',
        scheduledFor: at,
        trigger: 'schedule',
        repoFullName: 'acme/web',
        provider: 'selfhosted',
        model: 'claude-opus-5-5',
        status: 'running',
        createdAt: at,
      },
      {
        id: 'lr-manual',
        loopId: 'loop',
        workspaceId: 'ws',
        scheduledFor: new Date(at.getTime() + 1000),
        trigger: 'manual',
        repoFullName: 'acme/web',
        provider: 'selfhosted',
        model: 'claude-opus-5-5',
        status: 'running',
        createdAt: at,
      },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('describes a rule run from its facts', async () => {
    const origin = await sessionOriginOf('ws', { kind: 'workflow', workflowId: 'wf', runId: 'run', integration: 'posthog_inbox' });
    expect(origin).toEqual({
      type: 'workflow',
      automationId: 'wf',
      automationName: 'Fix P1 reports',
      runId: 'run',
      startedAt: at.toISOString(),
      trigger: 'event',
      triggeredBy: null,
      event: 'Report ready for work',
      ...workflowOriginDetails(POSTHOG),
    });
  });

  it('names who ran a rule by hand', async () => {
    const origin = await sessionOriginOf('ws', { kind: 'workflow', workflowId: 'wf', runId: 'run-manual' });
    expect(origin).toMatchObject({ trigger: 'manual', triggeredBy: 'tom@example.test' });
  });

  it('uses the run columns when the run kept no facts', async () => {
    const origin = await sessionOriginOf('ws', { kind: 'workflow', workflowId: 'wf', runId: 'run-old' });
    expect(origin).toMatchObject({ subject: { label: 'Signup button fails on Safari', url: null }, facts: [], excerpt: null });
  });

  it('gives nulls when the rule and the run are gone', async () => {
    await db.delete(workflows).where(eq(workflows.id, 'wf'));
    const origin = await sessionOriginOf('ws', { kind: 'workflow', workflowId: 'wf', runId: 'run' });
    expect(origin).toEqual({
      type: 'workflow',
      automationId: 'wf',
      automationName: null,
      runId: 'run',
      startedAt: null,
      trigger: null,
      triggeredBy: null,
      event: null,
      subject: null,
      facts: [],
      excerpt: null,
    });
  });

  it.each<[string, string, string]>([
    ['a rule in another workspace', 'wf-other', 'run-other'],
    ['a run of another rule', 'wf', 'run-other'],
  ])('reads nothing from %s', async (_name, workflowId, runId) => {
    const origin = await sessionOriginOf('ws', { kind: 'workflow', workflowId, runId });
    expect(origin).toMatchObject({ automationName: workflowId === 'wf' ? 'Fix P1 reports' : null, startedAt: null, subject: null });
  });

  it.each<[string, string, 'schedule' | 'manual']>([
    ['a scheduled loop run', 'lr', 'schedule'],
    ['a loop run started by hand', 'lr-manual', 'manual'],
  ])('describes %s', async (_name, runId, trigger) => {
    const origin = await sessionOriginOf('ws', { kind: 'loop', loopId: 'loop', runId });
    expect(origin).toEqual({
      type: 'loop',
      automationId: 'loop',
      automationName: 'Morning triage',
      runId,
      startedAt: at.toISOString(),
      trigger,
      triggeredBy: null,
      event: null,
      subject: null,
      facts: [
        { label: 'Repository', value: 'acme/web' },
        { label: 'Model', value: 'claude-opus-5-5' },
      ],
      excerpt: null,
    });
  });

  it('reads no loop from another workspace', async () => {
    const origin = await sessionOriginOf('ws-other', { kind: 'loop', loopId: 'loop', runId: 'lr' });
    expect(origin).toMatchObject({ automationName: null, startedAt: null, facts: [] });
  });

  it.each([
    ['the composer', null],
    ['a Slack mention', { kind: 'slack', teamId: 'T', teamName: null, channelId: 'C1', channelName: 'eng', messageTs: '1', threadTs: '1', permalink: null }],
    ['a memory review', { kind: 'memory_review', runId: 'r' }],
  ] as const)('gives null for %s', async (_name, source) => {
    expect(await sessionOriginOf('ws', source as Parameters<typeof sessionOriginOf>[1])).toBeNull();
  });
});
