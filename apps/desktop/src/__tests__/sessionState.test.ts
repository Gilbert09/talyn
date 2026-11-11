import type { Workbench, WorkbenchBackground, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { isActiveSessionState, sessionPr, sessionState, spaceSessionState, type SessionStateKind } from '../renderer/lib/sessionState';

type Wb = Pick<Workbench, 'status' | 'sandboxState' | 'diffStat' | 'committedStats' | 'archivedAt'>;
const WB: Wb = { status: 'ready', sandboxState: 'running', diffStat: null, archivedAt: null } as Wb;
const chat = (status: WorkbenchChat['status'], id = 'c1') => ({ id, status }) as Pick<WorkbenchChat, 'id' | 'status'>;

function pr(state: PRRow['state'], summary: Partial<PRRow['summary']> = {}) {
  return {
    number: 7,
    state,
    summary: { url: 'https://github.com/a/b/pull/7', mergeable: 'MERGEABLE', ciStatus: 'passing', draft: false, ...summary },
  } as Pick<PRRow, 'number' | 'state' | 'summary'>;
}

describe('sessionState', () => {
  it.each<[string, Partial<Wb>, ReturnType<typeof chat>[], Record<string, true>, ReturnType<typeof pr> | null, SessionStateKind]>([
    ['a failed start wins over everything', { status: 'error' }, [chat('running')], {}, pr('open'), 'failed'],
    ['a failed box', { sandboxState: 'error' }, [], {}, null, 'failed'],
    ['a failed chat', {}, [chat('error')], {}, pr('merged'), 'failed'],
    ['starting', { status: 'provisioning', sandboxState: 'creating' }, [], {}, null, 'starting'],
    ['moving to a fresh sandbox, with the turn that asked for it', { status: 'moving' }, [chat('running')], {}, pr('open'), 'working'],
    ['working', {}, [chat('running')], {}, pr('open'), 'working'],
    ['a message waits for the sandbox', {}, [{ ...chat('idle'), queuedMessages: [{ id: 'q1', text: 'go', queuedAt: '2026-11-04T00:00:00Z' }] } as ReturnType<typeof chat>], {}, pr('open'), 'working'],
    ['an empty queue is not work', {}, [{ ...chat('idle'), queuedMessages: [] } as ReturnType<typeof chat>], {}, null, 'idle'],
    ['waiting for an answer', {}, [chat('awaiting_input')], {}, pr('open'), 'needs_reply'],
    ['an unread reply', {}, [chat('idle')], { c1: true }, pr('open'), 'needs_reply'],
    ['merged is done', {}, [chat('idle')], {}, pr('merged'), 'merged'],
    ['closed', {}, [], {}, pr('closed'), 'closed'],
    ['draft', {}, [], {}, pr('open', { draft: true }), 'draft'],
    ['conflicts need you', {}, [], {}, pr('open', { mergeable: 'CONFLICTING' }), 'pr_attention'],
    ['failing checks keep the open-PR state', {}, [], {}, pr('open', { ciStatus: 'failing_required' }), 'pr_waiting'],
    ['green is ready to merge', {}, [], {}, pr('open'), 'ready_to_merge'],
    ['running checks wait', {}, [], {}, pr('open', { ciStatus: 'running' }), 'pr_waiting'],
    ['changes with no PR', { diffStat: { files: 2, added: 5, removed: 1 } } as Partial<Wb>, [], {}, null, 'unshipped'],
    ['committed changes with no PR', { committedStats: { files: 1, added: 5, removed: 1 } }, [], {}, null, 'unshipped'],
    ['nothing at all', {}, [], {}, null, 'idle'],
  ])('%s', (_name, over, chats, unread, row, kind) => {
    expect(sessionState({ ...WB, ...over }, chats, unread, row).kind).toBe(kind);
  });

  describe('background work', () => {
    const job = (status: WorkbenchBackground['jobs'][number]['status']) => ({ status }) as WorkbenchBackground['jobs'][number];
    const wakeup = (status: WorkbenchBackground['wakeups'][number]['status']) => ({ status }) as WorkbenchBackground['wakeups'][number];
    const ciWakeup = (status: WorkbenchBackground['wakeups'][number]['status']) =>
      ({ status, ci: { pullRequestId: 'p1', headSha: 'a'.repeat(40) } }) as WorkbenchBackground['wakeups'][number];
    const bg = (jobs: ReturnType<typeof job>[], wakeups: ReturnType<typeof wakeup>[] = []) => ({ jobs, wakeups });

    it.each<[string, Partial<Wb>, ReturnType<typeof chat>[], Record<string, true>, ReturnType<typeof pr> | null, ReturnType<typeof bg> | undefined, SessionStateKind]>([
      ['a running job replaces idle', {}, [chat('idle')], {}, null, bg([job('running')]), 'background_job'],
      ['a running job replaces unshipped changes', { diffStat: { files: 2, added: 5, removed: 1 } } as Partial<Wb>, [], {}, null, bg([job('running')]), 'background_job'],
      ['a running job wins over an open PR', {}, [], {}, pr('open', { ciStatus: 'running' }), bg([job('running')]), 'background_job'],
      ['a running job wins over a merged PR', {}, [], {}, pr('merged'), bg([job('running')]), 'background_job'],
      ['a running chat wins over a running job', {}, [chat('running')], {}, null, bg([job('running')]), 'working'],
      ['a question wins over a running job', {}, [chat('awaiting_input')], {}, null, bg([job('running')]), 'needs_reply'],
      ['an unread reply wins over a running job', {}, [chat('idle')], { c1: true }, null, bg([job('running')]), 'needs_reply'],
      ['a failure wins over a running job', {}, [chat('error')], {}, null, bg([job('running')]), 'failed'],
      ['a finished job is not work', {}, [], {}, null, bg([job('exited'), job('stopped'), job('lost')]), 'idle'],
      ['a scheduled wake-up replaces idle', {}, [], {}, null, bg([], [wakeup('scheduled')]), 'wakeup'],
      ['a scheduled wake-up replaces unshipped changes', { committedStats: { files: 1, added: 5, removed: 1 } }, [], {}, null, bg([], [wakeup('scheduled')]), 'wakeup'],
      ['an open PR wins over a scheduled wake-up', {}, [], {}, pr('open', { ciStatus: 'running' }), bg([], [wakeup('scheduled')]), 'pr_waiting'],
      ['a merged PR wins over a scheduled wake-up', {}, [], {}, pr('merged'), bg([], [wakeup('scheduled')]), 'merged'],
      ['a running job wins over a scheduled wake-up', {}, [], {}, null, bg([job('running')], [wakeup('scheduled')]), 'background_job'],
      ['a CI wake-up on an open PR waits for CI', {}, [], {}, pr('open', { ciStatus: 'running' }), bg([], [ciWakeup('scheduled')]), 'waiting_ci'],
      ['a CI wake-up wins over failing checks', {}, [], {}, pr('open', { ciStatus: 'failing_required' }), bg([], [ciWakeup('scheduled')]), 'waiting_ci'],
      ['a CI wake-up wins over a draft PR', {}, [], {}, pr('open', { draft: true }), bg([], [ciWakeup('scheduled')]), 'waiting_ci'],
      ['a merged PR wins over a CI wake-up', {}, [], {}, pr('merged'), bg([], [ciWakeup('scheduled')]), 'merged'],
      ['a closed PR wins over a CI wake-up', {}, [], {}, pr('closed'), bg([], [ciWakeup('scheduled')]), 'closed'],
      ['a running job wins over a CI wake-up', {}, [], {}, pr('open'), bg([job('running')], [ciWakeup('scheduled')]), 'background_job'],
      ['a running chat wins over a CI wake-up', {}, [chat('running')], {}, pr('open'), bg([], [ciWakeup('scheduled')]), 'working'],
      ['a fired CI wake-up leaves the PR state', {}, [], {}, pr('open'), bg([], [ciWakeup('fired')]), 'ready_to_merge'],
      ['a CI wake-up with no PR is a wake-up', {}, [], {}, null, bg([], [ciWakeup('scheduled')]), 'wakeup'],
      ['a fired, cancelled or failed wake-up is not work', {}, [], {}, null, bg([], [wakeup('fired'), wakeup('cancelled'), wakeup('failed')]), 'idle'],
      ['no background payload', {}, [], {}, null, undefined, 'idle'],
    ])('%s', (_name, over, chats, unread, row, background, kind) => {
      expect(sessionState({ ...WB, ...over }, chats, unread, row, false, background).kind).toBe(kind);
    });

    it('labels the background states', () => {
      expect(sessionState(WB, [], {}, null, false, bg([job('running')])).label).toBe('Background job running');
      expect(sessionState(WB, [], {}, null, false, bg([], [wakeup('scheduled')])).label).toBe('Wake-up scheduled');
      expect(sessionState(WB, [], {}, pr('open'), false, bg([], [ciWakeup('scheduled')])).label)
        .toMatch(/^#\d+: waiting for CI, then the agent continues$/);
    });
  });

  it('shows an idle session during a sandbox refresh', () => {
    expect(sessionState({ ...WB, status: 'moving' }, [], {}, null).label).toBe('Idle');
  });

  it('names the PR in the label', () => {
    expect(sessionState(WB, [], {}, pr('open', { mergeable: 'CONFLICTING' })).label).toBe('#7 has conflicts');
    expect(sessionState(WB, [], {}, pr('merged')).label).toBe('Done: #7 merged');
  });

  it('uses the embedded merged PR when the open PR store has no row', () => {
    const workbench = {
      ...WB,
      pr: { number: 42, url: 'https://github.com/a/b/pull/42', state: 'merged', mergeable: 'unknown', ciStatus: 'none' },
    } as Workbench;
    expect(sessionState(workbench, [], {}, sessionPr(workbench, null))).toEqual({ kind: 'merged', label: 'Done: #42 merged' });
    expect(sessionPr(workbench, pr('open') as PRRow)?.state).toBe('open');
  });

  it.each([
    ['working', true],
    ['needs_reply', true],
    ['unshipped', true],
    ['background_job', true],
    ['wakeup', true],
    ['pr_waiting', true],
    ['idle', false],
    ['merged', false],
    ['closed', false],
  ] as [SessionStateKind, boolean][])('classifies %s for the active sidebar group', (kind, active) => {
    expect(isActiveSessionState({ kind, label: kind })).toBe(active);
  });
});

describe('spaceSessionState', () => {
  const SPACE_SESSION: Parameters<typeof spaceSessionState>[0] = {
    id: 's1',
    status: 'ready',
    sandboxState: 'running',
    running: false,
    pullRequest: null,
    archivedAt: null,
  };

  it.each([
    ['an idle session', {}, 'idle'],
    ['a failed session', { status: 'error' }, 'failed'],
    ['a starting session', { status: 'provisioning', sandboxState: 'creating' }, 'starting'],
    ['a running turn', { running: true }, 'working'],
    ['an open pull request', { pullRequest: { number: 7, state: 'open', url: 'https://github.com/a/b/pull/7' } }, 'pr_waiting'],
    ['a merged pull request', { pullRequest: { number: 7, state: 'merged', url: 'https://github.com/a/b/pull/7' } }, 'merged'],
    ['a closed pull request', { pullRequest: { number: 7, state: 'closed', url: 'https://github.com/a/b/pull/7' } }, 'closed'],
  ] as [string, Partial<typeof SPACE_SESSION>, SessionStateKind][])('%s', (_name, patch, kind) => {
    expect(spaceSessionState({ ...SPACE_SESSION, ...patch }).kind).toBe(kind);
  });
});
