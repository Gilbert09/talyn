import { sessionGlanceText } from '../features/sessions/glance';
import { chat, session, thread } from './workflowFixtures';

const NOW = Date.parse('2026-11-08T11:30:00Z');

describe('the long-press glance', () => {
  it('lists the state, the branch, the facts and the times', () => {
    expect(sessionGlanceText(session(), NOW).split('\n')).toEqual([
      'Idle',
      'example/project · tom/example → main',
      'Agent: Codex',
      'Sandbox: Awake',
      'Active 30 minutes ago · started 2 hours ago',
    ]);
  });

  it('names the pull request in the state line and leaves committed work to it', () => {
    const item = session({
      pr: { number: 12, url: 'https://github.com/example/project/pull/12', state: 'open', mergeable: 'conflicting', ciStatus: 'success' },
      committedStats: { added: 5, removed: 1, files: 2 },
    });
    const lines = sessionGlanceText(item, NOW).split('\n');
    expect(lines[0]).toBe('#12 has conflicts');
    expect(lines.some((line) => line.startsWith('Committed'))).toBe(false);
  });

  it.each([
    ['uncommitted work', { uncommittedStats: { added: 3, removed: 1, files: 1 } }, 'Uncommitted: +3 −1 in 1 file'],
    ['committed work with no PR', { pr: null, committedStats: { added: 9, removed: 0, files: 2 } }, 'Committed: +9 −0 in 2 files, no pull request yet'],
    ['a sleeping sandbox', { sandboxState: 'suspended' as const }, 'Sandbox: Asleep, wakes when you send a message'],
    ['a failed start', { status: 'error' as const, sandboxState: 'error' as const, error: 'Clone failed' }, 'Error: Clone failed'],
    ['a Slack source', { source: { kind: 'slack', teamId: 'T', teamName: null, channelId: 'C1', channelName: 'eng', messageTs: '1', threadTs: '1', permalink: null } as never }, 'Started from: Slack #eng'],
    ['several chats, newest first', { chats: [chat({ updatedAt: '2026-11-08T09:00:00Z' }), chat({ id: 'two', agent: 'claude', model: 'claude-opus-5-5', updatedAt: '2026-11-08T11:20:00Z' })] }, 'Agent: Claude · Opus 5.5 · 2 chats'],
  ])('shows %s', (_name, patch, line) => {
    expect(sessionGlanceText(session(patch), NOW).split('\n')).toContain(line);
  });

  it('uses the newest chat for the activity time', () => {
    const item = session({ chats: [chat({ updatedAt: '2026-11-08T11:29:50Z' })] });
    expect(sessionGlanceText(item, NOW)).toContain('Active a few seconds ago');
  });

  it('has no branch line for a thread', () => {
    const lines = sessionGlanceText(thread(), NOW).split('\n');
    expect(lines).not.toContain(expect.stringContaining('→'));
    expect(lines[1]).toBe('Agent: Codex');
  });
});
