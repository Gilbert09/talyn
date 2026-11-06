import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { archiveAllCandidates } from '../renderer/lib/archiveAll';

function wb(over: Partial<Workbench> = {}): Workbench {
  return {
    id: 'wb1',
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: 'lisbon',
    branch: 'tom/lisbon',
    baseBranch: 'main',
    runtime: 'sandbox',
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const prSummary = (state: 'open' | 'merged' | 'closed') =>
  ({ number: 4, url: 'https://github.com/acme/app/pull/4', state, mergeable: 'unknown', ciStatus: 'none' }) as Workbench['pr'];

type Chat = Pick<WorkbenchChat, 'status'> & { queuedMessages?: WorkbenchChat['queuedMessages'] };

describe('archiveAllCandidates', () => {
  it.each<[string, Partial<Workbench>, string[], Chat[] | undefined, boolean]>([
    ['no PR', {}, [], undefined, true],
    ['no PR with unshipped changes', { diffStat: { files: 2, added: 3, removed: 1 } as never }, [], undefined, true],
    ['merged PR', { pullRequestId: 'pr1', pr: prSummary('merged') }, [], undefined, true],
    ['closed PR', { pullRequestId: 'pr1', pr: prSummary('closed') }, [], undefined, true],
    ['open PR in the store', { pullRequestId: 'pr1' }, ['pr1'], undefined, false],
    ['open PR on the session', { pullRequestId: 'pr1', pr: prSummary('open') }, [], undefined, false],
    ['open PR in the store, stale merged summary', { pullRequestId: 'pr1', pr: prSummary('merged') }, ['pr1'], undefined, false],
    ['linked PR with unknown state', { pullRequestId: 'pr1', pr: null }, [], undefined, false],
    ['linked PR with no summary', { pullRequestId: 'pr1' }, [], undefined, false],
    ['other open PRs only', {}, ['pr9'], undefined, true],
    ['a thread', { kind: 'thread', repositoryId: null, repoFullName: '' }, [], undefined, false],
    ['a thread child session', { threadId: 'th1' }, [], undefined, true],
    ['archived status', { status: 'archived' }, [], undefined, false],
    ['archivedAt set', { archivedAt: '2026-11-01T00:00:00Z' }, [], undefined, false],
    ['provisioning', { status: 'provisioning' }, [], undefined, false],
    ['sandbox creating', { sandboxState: 'creating' }, [], undefined, false],
    ['moving to a fresh sandbox', { status: 'moving' }, [], undefined, false],
    ['archive error', { status: 'archiveError' }, [], undefined, true],
    ['errored session', { status: 'error' }, [], undefined, true],
    ['suspended sandbox', { sandboxState: 'suspended' }, [], undefined, true],
    ['local session', { runtime: 'local', localPath: '/tmp/lisbon', deviceId: 'dev1' }, [], undefined, true],
    ['running chat in the store', {}, [], [{ status: 'running' }], false],
    ['queued message in the store', {}, [], [{ status: 'idle', queuedMessages: [{}] as never }], false],
    ['idle chats', {}, [], [{ status: 'idle', queuedMessages: [] }], true],
    ['chat awaiting input', {}, [], [{ status: 'awaiting_input' }], true],
    ['failed chat', {}, [], [{ status: 'error' }], true],
  ])('%s', (_name, over, openPrIds, storeChats, expected) => {
    const session = wb(over);
    const chats = storeChats ? { [session.id]: storeChats } : {};
    const out = archiveAllCandidates([session], new Set(openPrIds), chats);
    expect(out.map((w) => w.id)).toEqual(expected ? [session.id] : []);
  });

  it('reads the chats embedded in the session when the store has none', () => {
    const session = wb({ chats: [{ status: 'running' }] as never });
    expect(archiveAllCandidates([session], new Set(), {})).toEqual([]);
  });

  it('prefers the store chats over the embedded ones', () => {
    const session = wb({ chats: [{ status: 'running' }] as never });
    expect(archiveAllCandidates([session], new Set(), { [session.id]: [{ status: 'idle' }] })).toEqual([session]);
  });

  it('keeps the input order and filters a mixed list', () => {
    const list = [
      wb({ id: 'a' }),
      wb({ id: 'b', pullRequestId: 'pr1' }),
      wb({ id: 'c', pullRequestId: 'pr2', pr: prSummary('merged') }),
      wb({ id: 'd', status: 'provisioning' }),
      wb({ id: 'e' }),
    ];
    expect(archiveAllCandidates(list, new Set(['pr1']), {}).map((w) => w.id)).toEqual(['a', 'c', 'e']);
  });

  it('returns nothing for an empty list', () => {
    expect(archiveAllCandidates([], new Set(), {})).toEqual([]);
  });
});
