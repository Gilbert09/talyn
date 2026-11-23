import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ContextAttentionCounts, SpacesTeam, Workspace } from '@talyn/shared';
import { ContextRail } from '../renderer/components/layout/ContextRail';
import { api } from '../renderer/lib/api';
import {
  ATTENTION_POLL_MS,
  clientAttentionKey,
  railEntries,
  railEntryAttention,
  railInitials,
  useAttentionRefresh,
  useAttentionSessions,
  useContextAttentionStore,
} from '../renderer/lib/contextRail';
import { SidebarNeedsYou, useNeedsYouItems } from '../renderer/components/layout/SidebarNeedsYou';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useSpacesStore } from '../renderer/stores/spaces';
import { useNavigationStore } from '../renderer/stores/navigation';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));

const ws = (id: string, name: string) => ({ id, name, repos: [] }) as unknown as Workspace;

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'admin',
  homeWorkspaceId: 'ws1',
  createdAt: '',
  spaces: [
    { id: 's1', teamId: 't1', name: 'Web', color: '#10b981', image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
    { id: 's2', teamId: 't1', name: 'Data Platform', color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
  ],
};
const TEAM2: SpacesTeam = {
  ...TEAM,
  id: 't2',
  name: 'Beta',
  spaces: [{ id: 's3', teamId: 't2', name: 'Ops', color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
};

/** Lets the first badge fetch settle inside act. */
const flush = () => act(async () => {
  await Promise.resolve();
});

let attention: jest.SpyInstance;

function setup(opts: { workspaces: Workspace[]; spaces?: boolean; teams?: SpacesTeam[]; counts?: ContextAttentionCounts }) {
  useWorkspaceStore.setState({
    workspaces: opts.workspaces,
    currentWorkspaceId: opts.workspaces[0]?.id ?? null,
    currentContext: { kind: 'personal', workspaceId: opts.workspaces[0]?.id ?? null },
    features: { spaces: opts.spaces ?? false, workbenches: true } as never,
  });
  useSpacesStore.setState({ teams: opts.teams ?? [], sessions: {}, tasks: {}, presence: {}, selfUserId: 'me', dialog: null });
  attention.mockResolvedValue(opts.counts ?? { workspaces: {}, spaces: {} });
}

beforeEach(() => {
  localStorage.clear();
  useContextAttentionStore.setState({ counts: null });
  attention = jest.spyOn(api.workspaces, 'attention');
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('railEntries', () => {
  it('lists workspaces, then each team’s spaces with a line before each team', () => {
    const entries = railEntries([ws('ws1', 'Mine'), ws('ws2', 'Side')], [TEAM, TEAM2], true);
    expect(entries.map((e) => [e.kind, e.id, e.groupStart])).toEqual([
      ['workspace', 'ws1', false],
      ['workspace', 'ws2', false],
      ['space', 's1', true],
      ['space', 's2', false],
      ['space', 's3', true],
    ]);
    expect(entries[2].context).toEqual({ kind: 'space', spaceId: 's1' });
    expect(entries[0].context).toEqual({ kind: 'personal', workspaceId: 'ws1' });
  });

  it('leaves spaces out when spaces are not offered', () => {
    expect(railEntries([ws('ws1', 'Mine')], [TEAM], false).map((e) => e.id)).toEqual(['ws1']);
  });

  it('handles teams not loaded yet', () => {
    expect(railEntries([ws('ws1', 'Mine')], null, true).map((e) => e.id)).toEqual(['ws1']);
  });
});

describe('railEntryAttention', () => {
  const counts = { workspaces: { ws1: 3 }, spaces: { s1: 2 } };
  const [w1, w2, s1] = railEntries([ws('ws1', 'Mine'), ws('ws2', 'Side')], [TEAM], true);
  it.each([
    ['a workspace with items', w1, counts, 3],
    ['a workspace with none', w2, counts, 0],
    ['a space with items', s1, counts, 2],
    ['no counts yet', w1, null, 0],
  ] as const)('%s', (_label, entry, c, expected) => {
    expect(railEntryAttention(entry, c)).toBe(expected);
  });

  describe('a workspace with sessions in spaces', () => {
    // ws1: 1 Personal session, 2 in s1, 1 in s3 (a space with no tile here).
    const spaced = {
      workspaces: { ws1: 4, ws2: 1 },
      spaces: { s1: 3, s3: 1 },
      workspaceSpaces: { ws1: { s1: 2, s3: 1 }, ws2: { s1: 1 } },
    };
    const withSpaces = railEntries([ws('ws1', 'Mine'), ws('ws2', 'Side')], [TEAM], true);
    const noSpaces = railEntries([ws('ws1', 'Mine'), ws('ws2', 'Side')], [TEAM], false);
    const [m, side] = withSpaces;
    it.each([
      ['leaves out the sessions of spaces with a tile', m, spaced, withSpaces, 2],
      ['answers 0 when every session is in a space with a tile', side, spaced, withSpaces, 0],
      ['counts every session when no space has a tile', m, spaced, noSpaces, 4],
      ['counts every session from an older server', m, { workspaces: { ws1: 4 }, spaces: { s1: 3 } }, withSpaces, 4],
      ['counts every session with no entries passed', m, spaced, [], 4],
      ['never goes below 0', m, { ...spaced, workspaces: { ws1: 1 } }, withSpaces, 0],
    ] as const)('%s', (_label, entry, c, entries, expected) => {
      expect(railEntryAttention(entry, c, entries)).toBe(expected);
    });

    it('leaves a space tile unchanged', () => {
      expect(railEntryAttention(withSpaces[2], spaced, withSpaces)).toBe(3);
    });
  });
});

describe('railInitials', () => {
  it.each([
    ['Growth', 'G'],
    ['data platform', 'DP'],
    ['  Web   App  Team ', 'WA'],
    ['', '?'],
    ['🚀 Launch', '🚀L'],
  ])('%j -> %s', (name, initials) => {
    expect(railInitials(name)).toBe(initials);
  });
});

describe('ContextRail', () => {
  it('is hidden with one workspace and no spaces', () => {
    setup({ workspaces: [ws('ws1', 'Mine')] });
    render(<ContextRail />);
    expect(screen.queryByRole('navigation', { name: 'Workspaces and spaces' })).not.toBeInTheDocument();
    expect(attention).not.toHaveBeenCalled();
  });

  it('is hidden with one workspace when the spaces flag is off, even with teams', () => {
    setup({ workspaces: [ws('ws1', 'Mine')], teams: [TEAM], spaces: false });
    render(<ContextRail />);
    expect(screen.queryByRole('navigation', { name: 'Workspaces and spaces' })).not.toBeInTheDocument();
  });

  it('shows with one workspace and a space', async () => {
    setup({ workspaces: [ws('ws1', 'Mine')], teams: [TEAM], spaces: true });
    render(<ContextRail />);
    await flush();
    expect(screen.getByRole('navigation', { name: 'Workspaces and spaces' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Web (Acme)' })).toBeInTheDocument();
    expect(screen.getByText('DP')).toBeInTheDocument();
  });

  it('badges every context, including the open one', async () => {
    setup({
      workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')],
      teams: [TEAM],
      spaces: true,
      counts: { workspaces: { ws1: 5, ws2: 1 }, spaces: { s1: 120 } },
    });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Side, 1 item needs you' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Web (Acme), 120 items need you' })).toHaveTextContent('99+');
    const open = screen.getByRole('button', { name: 'Mine, 5 items need you' });
    expect(open).toHaveAttribute('aria-current', 'true');
    expect(open).toHaveTextContent('5');
    expect(screen.getAllByText((_, el) => el?.getAttribute('data-attr') === 'context-rail-badge')).toHaveLength(3);
  });

  it('counts a session in a space on the space tile only', async () => {
    setup({
      workspaces: [ws('ws1', 'Mine')],
      teams: [TEAM],
      spaces: true,
      counts: { workspaces: { ws1: 2 }, spaces: { s1: 1 }, workspaceSpaces: { ws1: { s1: 1 } } },
    });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Mine, 1 item needs you' })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Web (Acme), 1 item needs you' })).toBeInTheDocument();
  });

  it('switches to a space and asks again for the counts', async () => {
    setup({ workspaces: [ws('ws1', 'Mine')], teams: [TEAM], spaces: true, counts: { workspaces: { ws1: 2 }, spaces: { s1: 3 } } });
    render(<ContextRail />);
    await waitFor(() => expect(attention).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Web (Acme), 3 items need you' }));
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'space', spaceId: 's1' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    await waitFor(() => expect(attention).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Mine, 2 items need you' })).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Web (Acme), 3 items need you' });
    expect(open).toHaveAttribute('aria-current', 'true');
    expect(open).toHaveTextContent('3');
  });

  it('switches workspace when spaces are off', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')] });
    render(<ContextRail />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Side' }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('ws2');
    await flush();
  });

  it('asks again on a timer', async () => {
    jest.useFakeTimers();
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')] });
    render(<ContextRail />);
    await flush();
    expect(attention).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(ATTENTION_POLL_MS);
      await Promise.resolve();
    });
    expect(attention).toHaveBeenCalledTimes(2);
  });

  it('keeps the last badges when an ask fails', async () => {
    jest.useFakeTimers();
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws2: 4 }, spaces: {} } });
    render(<ContextRail />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Side, 4 items need you' })).toBeInTheDocument();
    attention.mockRejectedValue(new Error('offline'));
    await act(async () => {
      jest.advanceTimersByTime(ATTENTION_POLL_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Side, 4 items need you' })).toBeInTheDocument();
  });
});

describe('the sessions the rail counts', () => {
  const counts = { workspaces: { ws1: 2 }, spaces: { s1: 1 }, sessions: { a: 'reply', b: 'conflict' } } as const;

  it('shares the counted sessions with the sidebar', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts });
    const sessions = renderHook(() => useAttentionSessions());
    expect(sessions.result.current).toEqual({});
    render(<ContextRail />);
    await waitFor(() => expect(sessions.result.current).toEqual({ a: 'reply', b: 'conflict' }));
  });

  it('answers no sessions from an older server that does not send them', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws1: 1 }, spaces: {} } });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Mine, 1 item needs you' })).toBeInTheDocument();
    const sessions = renderHook(() => useAttentionSessions());
    expect(sessions.result.current).toEqual({});
  });

  it('forgets the counted sessions when the rail hides', async () => {
    useContextAttentionStore.setState({ counts });
    setup({ workspaces: [ws('ws1', 'Mine')] });
    render(<ContextRail />);
    const sessions = renderHook(() => useAttentionSessions());
    await waitFor(() => expect(sessions.result.current).toEqual({}));
  });

  it('picks the counted live items, in the list order', () => {
    useContextAttentionStore.setState({ counts });
    const list = [{ id: 'c' }, { id: 'b' }, { id: 'a' }, { id: 'gone' }];
    const live = (item: { id: string }) => item.id !== 'gone';
    const { result } = renderHook(() => useNeedsYouItems(list, live));
    expect(result.current.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('leaves out a counted item that is not live', () => {
    useContextAttentionStore.setState({ counts: { ...counts, sessions: { a: 'failed' } } });
    const { result } = renderHook(() => useNeedsYouItems([{ id: 'a' }], () => false));
    expect(result.current).toEqual([]);
  });

  it('shows a "Needs you" section with a count, and nothing when no item waits', () => {
    const { rerender } = render(
      <SidebarNeedsYou items={[{ id: 'a' }, { id: 'b' }]} renderItem={(item) => <div key={item.id}>row {item.id}</div>} />,
    );
    const group = screen.getByRole('group', { name: 'Needs you' });
    expect(group).toHaveTextContent('Needs you2row arow b');
    rerender(<SidebarNeedsYou items={[]} renderItem={() => null} />);
    expect(screen.queryByRole('group', { name: 'Needs you' })).not.toBeInTheDocument();
  });
});

describe('clientAttentionKey', () => {
  const wb = { kind: 'session' as const, status: 'ready' as const, sandboxState: 'running' as const, archivedAt: null };
  const chat = (id: string, status: string) => ({ id, status, queuedMessages: [] }) as never;

  it.each<[string, Parameters<typeof clientAttentionKey>, string | null]>([
    ['an idle session', [wb, [chat('c1', 'idle')], null], null],
    ['a question', [wb, [chat('c1', 'awaiting_input')], null], 'reply:c1@0'],
    ['a failed chat', [wb, [chat('c1', 'error')], null], 'chat_error:c1@0'],
    ['a failed start', [{ ...wb, status: 'error' as const }, [], null], 'error'],
    ['a conflicting PR', [wb, [], { state: 'open', summary: { mergeable: 'CONFLICTING' } }], 'conflict::'],
    ['a mergeable PR', [wb, [], { state: 'open', summary: { mergeable: 'MERGEABLE' } }], null],
    ['a thread with no kind set', [{ ...wb, kind: undefined }, [chat('c1', 'awaiting_input')], null], 'reply:c1@0'],
    ['a running turn, so the key changes when it ends', [wb, [chat('c1', 'running')], null], 'busy'],
    ['a failure next to a running turn', [wb, [chat('c1', 'error'), chat('c2', 'running')], null], 'chat_error:c1@0'],
  ])('%s', (_label, args, expected) => {
    expect(clientAttentionKey(...args)).toBe(expected);
  });
});

describe('useAttentionRefresh', () => {
  it('does not ask the rail again on open, so the session stays in Needs you', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws1: 1 }, spaces: {} } });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Mine, 1 item needs you' })).toBeInTheDocument();
    expect(attention).toHaveBeenCalledTimes(1);

    const { rerender } = renderHook(({ key }) => useAttentionRefresh(key), { initialProps: { key: 'conflict::' as string | null } });
    rerender({ key: 'conflict::' });

    expect(attention).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Mine, 1 item needs you' })).toBeInTheDocument();
  });

  it('asks the rail again when the alert is resolved while the session is open', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws1: 1 }, spaces: {} } });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Mine, 1 item needs you' })).toBeInTheDocument();
    attention.mockResolvedValue({ workspaces: {}, spaces: {} });

    const { rerender } = renderHook(({ key }) => useAttentionRefresh(key), {
      initialProps: { key: 'reply:c1@0' as string | null },
    });
    rerender({ key: 'busy' });

    expect(await screen.findByRole('button', { name: 'Mine' })).toBeInTheDocument();
    expect(attention).toHaveBeenCalledTimes(2);
  });
});
