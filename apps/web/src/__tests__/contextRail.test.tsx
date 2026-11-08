import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContextAttentionCounts, SpacesTeam, Workspace } from '@talyn/shared';
import { ContextRail } from '../components/layout/ContextRail';
import { api } from '../lib/api';
import { ATTENTION_POLL_MS, railEntries, railEntryAttention, railInitials } from '../lib/contextRail';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

const ws = (id: string, name: string) => ({ id, name, repos: [] }) as unknown as Workspace;

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'admin',
  homeWorkspaceId: 'ws1',
  createdAt: '',
  spaces: [
    { id: 's1', teamId: 't1', name: 'Web', color: '#10b981', createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
    { id: 's2', teamId: 't1', name: 'Data Platform', color: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
  ],
};
const TEAM2: SpacesTeam = {
  ...TEAM,
  id: 't2',
  name: 'Beta',
  spaces: [{ id: 's3', teamId: 't2', name: 'Ops', color: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
};

/** Lets the first badge fetch settle inside act. */
const flush = () => act(async () => {
  await Promise.resolve();
});

let attention: ReturnType<typeof vi.spyOn>;

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
  attention = vi.spyOn(api.workspaces, 'attention');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it('badges the contexts that are not open, and not the open one', async () => {
    setup({
      workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')],
      teams: [TEAM],
      spaces: true,
      counts: { workspaces: { ws1: 5, ws2: 1 }, spaces: { s1: 120 } },
    });
    render(<ContextRail />);
    expect(await screen.findByRole('button', { name: 'Side, 1 item needs you' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Web (Acme), 120 items need you' })).toHaveTextContent('99+');
    const open = screen.getByRole('button', { name: 'Mine' });
    expect(open).toHaveAttribute('aria-current', 'true');
    expect(open).not.toHaveTextContent('5');
    expect(screen.getAllByText((_, el) => el?.getAttribute('data-attr') === 'context-rail-badge')).toHaveLength(2);
  });

  it('switches to a space and asks again for the counts', async () => {
    setup({ workspaces: [ws('ws1', 'Mine')], teams: [TEAM], spaces: true, counts: { workspaces: { ws1: 2 }, spaces: {} } });
    render(<ContextRail />);
    await waitFor(() => expect(attention).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Web (Acme)' }));
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'space', spaceId: 's1' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    await waitFor(() => expect(attention).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Mine, 2 items need you' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Web (Acme)' })).toHaveAttribute('aria-current', 'true');
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
    vi.useFakeTimers();
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')] });
    render(<ContextRail />);
    await flush();
    expect(attention).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_MS);
      await Promise.resolve();
    });
    expect(attention).toHaveBeenCalledTimes(2);
  });

  it('keeps the last badges when an ask fails', async () => {
    vi.useFakeTimers();
    setup({ workspaces: [ws('ws1', 'Mine'), ws('ws2', 'Side')], counts: { workspaces: { ws2: 4 }, spaces: {} } });
    render(<ContextRail />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Side, 4 items need you' })).toBeInTheDocument();
    attention.mockRejectedValue(new Error('offline'));
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Side, 4 items need you' })).toBeInTheDocument();
  });
});
