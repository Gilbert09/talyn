import { describe, expect, it } from 'vitest';
import {
  agentGlance,
  backgroundGlance,
  checksGlance,
  diffGlance,
  errorGlance,
  prSizeGlance,
  sandboxGlance,
  sessionGlanceFacts,
  sourceGlance,
  type SessionGlanceWorkbench,
  type WorkbenchBackground,
  type WorkbenchSource,
} from '@talyn/shared';

const chat = (agent: 'claude' | 'codex', model: string | null, updatedAt: string) => ({ agent, model, updatedAt });

const WB: SessionGlanceWorkbench = {
  agent: 'claude',
  runtime: 'sandbox',
  status: 'ready',
  sandboxState: 'running',
  diffStat: null,
};

function background(over: Partial<{ jobs: unknown[]; wakeups: unknown[] }> = {}) {
  return { jobs: [], wakeups: [], ...over } as unknown as Pick<WorkbenchBackground, 'jobs' | 'wakeups'>;
}

describe('agentGlance', () => {
  it.each<[string, Parameters<typeof agentGlance>, string]>([
    ['no chats: the session agent', ['claude', []], 'Claude'],
    ['null chats', ['codex', null], 'Codex'],
    ['a known model uses its catalogue label', ['claude', [chat('claude', 'claude-opus-5-5', '2026-01-01')]], 'Claude · Opus 5.5'],
    ['an unknown model shows its id', ['claude', [chat('claude', 'claude-mystery-9', '2026-01-01')]], 'Claude · claude-mystery-9'],
    ['a chat with no model shows the agent only', ['claude', [chat('claude', null, '2026-01-01')]], 'Claude'],
    [
      'the newest chat wins and the count shows',
      ['claude', [chat('claude', null, '2026-01-01'), chat('codex', null, '2026-01-03'), chat('claude', null, '2026-01-02')]],
      'Codex · 3 chats',
    ],
    ['an unknown agent shows as given', ['other', []], 'other'],
  ])('%s', (_name, args, expected) => {
    expect(agentGlance(...args)).toBe(expected);
  });
});

describe('sandboxGlance', () => {
  it.each<[string, Parameters<typeof sandboxGlance>[0], string | null]>([
    ['local runtime', { runtime: 'local', status: 'ready', sandboxState: 'none' }, 'Local worktree'],
    ['moving', { runtime: 'sandbox', status: 'moving', sandboxState: 'running' }, 'Moving to a fresh sandbox'],
    ['archived', { runtime: 'sandbox', status: 'archived', sandboxState: 'deleted' }, 'Archived'],
    ['creating', { runtime: 'sandbox', status: 'provisioning', sandboxState: 'creating' }, 'Starting'],
    ['running', { runtime: 'sandbox', status: 'ready', sandboxState: 'running' }, 'Awake'],
    ['suspended', { runtime: 'sandbox', status: 'ready', sandboxState: 'suspended' }, 'Asleep, wakes when you send a message'],
    ['lost', { runtime: 'sandbox', status: 'ready', sandboxState: 'lost' }, 'Lost'],
    ['deleted', { runtime: 'sandbox', status: 'ready', sandboxState: 'deleted' }, 'Deleted'],
    ['error', { runtime: 'sandbox', status: 'error', sandboxState: 'error' }, 'Failed'],
    ['no sandbox yet', { runtime: 'sandbox', status: 'ready', sandboxState: 'none' }, null],
  ])('%s', (_name, workbench, expected) => {
    expect(sandboxGlance(workbench)?.value ?? null).toBe(expected);
  });
});

describe('sourceGlance', () => {
  const slack = (channelId: string, channelName: string | null) =>
    ({ kind: 'slack', teamId: 'T', teamName: null, channelId, channelName, messageTs: '1', threadTs: '1', permalink: null }) as WorkbenchSource;
  it.each<[string, WorkbenchSource | null | undefined, string | null]>([
    ['the composer', null, null],
    ['absent', undefined, null],
    ['a Slack channel', slack('C1', 'eng'), 'Slack #eng'],
    ['a Slack DM', slack('D1', null), 'Slack DM'],
    ['a Slack channel with no name', slack('C1', null), 'Slack'],
    ['a scheduled rule', { kind: 'loop', loopId: 'l', runId: 'r' }, 'A scheduled rule'],
    ['a GitHub rule with no integration', { kind: 'workflow', workflowId: 'w', runId: 'r' }, 'A GitHub rule'],
    ['a Linear rule', { kind: 'workflow', workflowId: 'w', runId: 'r', integration: 'linear' }, 'A Linear rule'],
    ['a memory review', { kind: 'memory_review', runId: 'r' } as WorkbenchSource, 'Memory review'],
  ])('%s', (_name, source, expected) => {
    expect(sourceGlance(source)).toBe(expected);
  });
});

describe('backgroundGlance', () => {
  it.each<[string, ReturnType<typeof background> | null, string[]]>([
    ['nothing', null, []],
    ['only ended work', background({ jobs: [{ status: 'exited', name: 'a' }], wakeups: [{ status: 'fired', ci: null, reason: 'x' }] }), []],
    ['one running job', background({ jobs: [{ status: 'running', name: 'npm test' }] }), ['Running: npm test']],
    ['two running jobs', background({ jobs: [{ status: 'running', name: 'a' }, { status: 'running', name: 'b' }] }), ['2 running']],
    ['a timed wake-up', background({ wakeups: [{ status: 'scheduled', ci: null, reason: ' check deploy ' }] }), ['Scheduled: check deploy']],
    ['a wake-up with no reason', background({ wakeups: [{ status: 'scheduled', ci: null, reason: '' }] }), ['Scheduled']],
    [
      'a CI wake-up wins over a timed one',
      background({ wakeups: [{ status: 'scheduled', ci: null, reason: 'x' }, { status: 'scheduled', ci: { prNumber: 1 }, reason: 'y' }] }),
      ['When CI finishes, the agent continues'],
    ],
    [
      'a job and a wake-up',
      background({ jobs: [{ status: 'running', name: 'build' }], wakeups: [{ status: 'scheduled', ci: null, reason: 'r' }] }),
      ['Running: build', 'Scheduled: r'],
    ],
  ])('%s', (_name, value, expected) => {
    expect(backgroundGlance(value).map((fact) => fact.value)).toEqual(expected);
  });

  it('cuts a long reason', () => {
    const [fact] = backgroundGlance(background({ wakeups: [{ status: 'scheduled', ci: null, reason: 'x'.repeat(200) }] }));
    expect(fact.value).toHaveLength('Scheduled: '.length + 80);
    expect(fact.value.endsWith('…')).toBe(true);
  });
});

describe('diffGlance, checksGlance and prSizeGlance', () => {
  it.each<[string, Parameters<typeof diffGlance>[0], string | null]>([
    ['null', null, null],
    ['no files', { added: 0, removed: 0, files: 0 }, null],
    ['one file', { added: 3, removed: 1, files: 1 }, '+3 −1 in 1 file'],
    ['many files', { added: 120, removed: 30, files: 8 }, '+120 −30 in 8 files'],
  ])('diffGlance: %s', (_name, stats, expected) => {
    expect(diffGlance(stats)).toBe(expected);
  });

  const checks = (over: Partial<NonNullable<Parameters<typeof checksGlance>[0]>>) => ({
    total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0, ...over,
  });
  it.each<[string, Parameters<typeof checksGlance>[0], string | null]>([
    ['absent', undefined, null],
    ['no checks', checks({}), null],
    ['all passed', checks({ total: 4, passed: 4 }), '4 passed'],
    ['a mix', checks({ total: 16, passed: 10, failed: 1, inProgress: 2, skipped: 3 }), '10 passed, 1 failed, 2 running, 3 skipped'],
    ['a total with no breakdown', checks({ total: 1 }), '1 check'],
    ['totals with no breakdown', checks({ total: 3 }), '3 checks'],
  ])('checksGlance: %s', (_name, value, expected) => {
    expect(checksGlance(value)).toBe(expected);
  });

  it.each<[string, Parameters<typeof prSizeGlance>, string | null]>([
    ['unknown size', [undefined, undefined, undefined], null],
    ['only additions known', [5, undefined, 2], null],
    ['lines only', [5, 2, undefined], '+5 −2'],
    ['a zero-line diff is real', [0, 0, 0], '+0 −0 in 0 files'],
    ['one file', [5, 2, 1], '+5 −2 in 1 file'],
  ])('prSizeGlance: %s', (_name, args, expected) => {
    expect(prSizeGlance(...args)).toBe(expected);
  });
});

describe('errorGlance', () => {
  it.each<[string, Parameters<typeof errorGlance>[0], string | null]>([
    ['no error', { status: 'ready' }, null],
    ['the error field', { status: 'ready', error: ' Clone failed ' }, 'Clone failed'],
    ['the status message of a failed session', { status: 'error', statusMessage: 'No capacity' }, 'No capacity'],
    ['an informational message is not an error', { status: 'provisioning', statusMessage: 'Running the setup script' }, null],
    ['a blank error falls back to the message', { status: 'error', error: '  ', statusMessage: 'Boom' }, 'Boom'],
  ])('%s', (_name, workbench, expected) => {
    expect(errorGlance(workbench)).toBe(expected);
  });
});

describe('sessionGlanceFacts', () => {
  const labels = (facts: ReturnType<typeof sessionGlanceFacts>) => facts.map((fact) => `${fact.label}: ${fact.value}`);

  it('lists the agent and the sandbox for a plain session', () => {
    expect(labels(sessionGlanceFacts({ workbench: WB }))).toEqual(['Agent: Claude', 'Sandbox: Awake']);
  });

  it('lists every fact in order', () => {
    const facts = sessionGlanceFacts({
      workbench: {
        ...WB,
        sandboxState: 'suspended',
        error: 'Push refused',
        diffStat: { added: 9, removed: 9, files: 9 },
        uncommittedStats: { added: 2, removed: 1, files: 1 },
        committedStats: { added: 40, removed: 4, files: 3 },
        source: { kind: 'loop', loopId: 'l', runId: 'r' },
      },
      chats: [chat('claude', 'claude-opus-5-5', '2026-01-01')],
      background: background({ jobs: [{ status: 'running', name: 'dev' }] }),
    });
    expect(labels(facts)).toEqual([
      'Error: Push refused',
      'Uncommitted: +2 −1 in 1 file',
      'Committed: +40 −4 in 3 files, no pull request yet',
      'Job: Running: dev',
      'Agent: Claude · Opus 5.5',
      'Sandbox: Asleep, wakes when you send a message',
      'Started from: A scheduled rule',
    ]);
  });

  it('uses the diff stat when the server sends no uncommitted stats', () => {
    const facts = sessionGlanceFacts({ workbench: { ...WB, diffStat: { added: 1, removed: 0, files: 1 } } });
    expect(labels(facts)).toContain('Uncommitted: +1 −0 in 1 file');
  });

  it('leaves committed changes to the pull request when there is one', () => {
    const facts = sessionGlanceFacts({
      workbench: { ...WB, committedStats: { added: 40, removed: 4, files: 3 } },
      hasPullRequest: true,
    });
    expect(labels(facts).some((line) => line.startsWith('Committed'))).toBe(false);
  });

  it('marks the error and the awake sandbox with their tones', () => {
    const facts = sessionGlanceFacts({ workbench: { ...WB, error: 'x' } });
    expect(facts.find((fact) => fact.label === 'Error')?.tone).toBe('destructive');
    expect(facts.find((fact) => fact.label === 'Sandbox')?.tone).toBe('success');
  });
});
