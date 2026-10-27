import type { Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { sessionPr, sessionState, type SessionStateKind } from '../renderer/lib/sessionState';

type Wb = Pick<Workbench, 'status' | 'sandboxState' | 'diffStat' | 'archivedAt'>;
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
    ['waiting for an answer', {}, [chat('awaiting_input')], {}, pr('open'), 'needs_reply'],
    ['an unread reply', {}, [chat('idle')], { c1: true }, pr('open'), 'needs_reply'],
    ['merged is done', {}, [chat('idle')], {}, pr('merged'), 'merged'],
    ['closed', {}, [], {}, pr('closed'), 'closed'],
    ['draft', {}, [], {}, pr('open', { draft: true }), 'draft'],
    ['conflicts need you', {}, [], {}, pr('open', { mergeable: 'CONFLICTING' }), 'pr_attention'],
    ['failing checks need you', {}, [], {}, pr('open', { ciStatus: 'failing_required' }), 'pr_attention'],
    ['green is ready to merge', {}, [], {}, pr('open'), 'ready_to_merge'],
    ['running checks wait', {}, [], {}, pr('open', { ciStatus: 'running' }), 'pr_waiting'],
    ['changes with no PR', { diffStat: { files: 2, added: 5, removed: 1 } } as Partial<Wb>, [], {}, null, 'unshipped'],
    ['nothing at all', {}, [], {}, null, 'idle'],
  ])('%s', (_name, over, chats, unread, row, kind) => {
    expect(sessionState({ ...WB, ...over }, chats, unread, row).kind).toBe(kind);
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
});
