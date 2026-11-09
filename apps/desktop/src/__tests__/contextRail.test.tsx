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
  useAttentionSeen,
} from '../renderer/lib/contextRail';
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
  ])('%s', (_label, args, expected) => {
    expect(clientAttentionKey(...args)).toBe(expected);
  });
});

describe('useAttentionSeen', () => {
  let seen: jest.SpyInstance;

  beforeEach(() => {
    seen = jest.spyOn(api.workbenches, 'attentionSeen').mockResolvedValue({ acknowledged: true });
  });

  it('marks the session seen on open and asks the rail again, so its badge clears', async () => {
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws1: 1 }, spaces: {} } });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Mine, 1 item needs you' })).toBeInTheDocument();
    attention.mockResolvedValue({ workspaces: {}, spaces: {} });

    renderHook(() => useAttentionSeen('wb1', 'conflict::'));

    await waitFor(() => expect(seen).toHaveBeenCalledWith('wb1'));
    expect(await screen.findByRole('button', { name: 'Mine' })).toBeInTheDocument();
    expect(attention).toHaveBeenCalledTimes(2);
  });

  it('marks again when the alert changes while the session is open, not on a plain re-render', async () => {
    const { rerender } = renderHook(({ key }) => useAttentionSeen('wb1', key), {
      initialProps: { key: null as string | null },
    });
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    rerender({ key: null });
    rerender({ key: 'reply:c1@0' });
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
  });

  it('marks again when the window comes back with an alert showing', async () => {
    renderHook(() => useAttentionSeen('wb1', 'error'));
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
  });

  it('keeps quiet about a failed mark', async () => {
    seen.mockRejectedValue(new Error('forbidden'));
    renderHook(() => useAttentionSeen('wb1', 'error'));
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
  });
});
