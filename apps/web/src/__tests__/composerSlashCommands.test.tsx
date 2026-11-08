import { vi, it, expect, afterEach, beforeEach, describe } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat, Workspace } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { ComposerPopover } from '../components/workbench/ComposerPopover';
import { sandboxOps, type WorkbenchOps } from '../lib/workbenchOps';
import { composerSettingsLinks, matchComposerLinks } from '../lib/composerLinks';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const workbench = {
  id: 'wb-1',
  workspaceId: 'ws-1',
  runtime: 'sandbox',
  status: 'ready',
  sandboxId: 'box-1',
  sandboxState: 'running',
  archivedAt: null,
  agent: 'claude',
  settings: {},
} as Workbench;
const chat = { id: 'chat-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;
const workspace = {
  id: 'ws-1',
  name: 'Workspace',
  repos: [],
  integrations: {},
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Workspace;

const FILES: Record<string, string> = {
  '.claude/commands/deploy.md': '---\ndescription: Ship the app to production\n---\nRun the deploy.',
  '.claude/skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort new issues\n---\nBody',
};

function opsWithFiles(): WorkbenchOps {
  return {
    ...sandboxOps(workbench),
    listFiles: vi.fn().mockResolvedValue(['src/app.ts', ...Object.keys(FILES)]),
    readFile: vi.fn().mockImplementation(async (path: string) => ({ content: FILES[path] ?? '', binary: false })),
  };
}

const navigate = vi.fn();

function textbox() {
  return screen.getByRole('textbox', { name: 'Message the agent' });
}

function type(value: string) {
  fireEvent.change(textbox(), { target: { value, selectionStart: value.length } });
}

function renderComposer(ops: WorkbenchOps = opsWithFiles(), slashCommands: string[] | null = null) {
  render(<Composer workbench={workbench} chat={chat} ops={ops} todos={null} contextUsage={null} slashCommands={slashCommands} />);
  return ops;
}

beforeEach(() => {
  // jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {} });
  useWorkspaceStore.setState({ features: { workbenches: true, mcpServers: true } as Features, workspaces: [workspace] });
  useNavigationStore.setState({ navigate });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the composer slash list', () => {
  it('lists the installed Talyn skills for Codex', async () => {
    render(
      <Composer
        workbench={{ ...workbench, agent: 'codex' }}
        chat={chat}
        ops={opsWithFiles()}
        todos={null}
        contextUsage={null}
        slashCommands={['compact']}
      />,
    );
    type('/');
    await screen.findByText('Open or update the pull request for this session');
    expect(screen.getByText('talyn-ship-pr')).toBeInTheDocument();
    expect(screen.queryByText('Summarise the conversation to free context')).not.toBeInTheDocument();
  });

  it('hides Talyn skills for Codex when the skill pack is off', async () => {
    useWorkspaceStore.setState({ workspaces: [{ ...workspace, settings: { sessionSkillPack: false } }] });
    render(
      <Composer
        workbench={{ ...workbench, agent: 'codex' }}
        chat={chat}
        ops={opsWithFiles()}
        todos={null}
        contextUsage={null}
        slashCommands={null}
      />,
    );
    type('/talyn');
    await screen.findByText('No matching command.');
    expect(screen.queryByText('talyn-ship-pr')).not.toBeInTheDocument();
  });

  it('describes built-in commands, Talyn skills and the repository files', async () => {
    const ops = renderComposer(undefined, ['compact', 'talyn-ship-pr', 'mystery']);
    type('/');
    await waitFor(() => expect(screen.getByText('Ship the app to production')).toBeInTheDocument());
    expect(screen.getByText('Sort new issues')).toBeInTheDocument();
    expect(screen.getByText('Summarise the conversation to free context')).toBeInTheDocument();
    expect(screen.getByText('Open or update the pull request for this session')).toBeInTheDocument();
    const mystery = screen.getByText('mystery').closest('button')!;
    expect(mystery).toHaveTextContent(/^mystery$/);
    expect(ops.readFile).toHaveBeenCalledTimes(2);
  });

  it('reads each command file one time', async () => {
    const ops = renderComposer();
    type('/');
    await waitFor(() => expect(screen.getByText('Ship the app to production')).toBeInTheDocument());
    type('/d');
    type('/de');
    await waitFor(() => expect(screen.getByText('Ship the app to production')).toBeInTheDocument());
    expect(ops.readFile).toHaveBeenCalledTimes(2);
  });

  it('keeps a command without a description when its file cannot be read', async () => {
    const ops = { ...opsWithFiles(), readFile: vi.fn().mockRejectedValue(new Error('gone')) };
    renderComposer(ops);
    type('/dep');
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    await act(async () => {});
    expect(screen.getByText('deploy').closest('button')).toHaveTextContent(/^deploy$/);
  });

  it('lists settings pages after the commands', async () => {
    renderComposer();
    type('/');
    const settings = await screen.findByRole('listbox', { name: 'Settings' });
    expect(within(settings).getByText('MCP servers')).toBeInTheDocument();
    expect(within(settings).getByText('Connect tool servers for the agents')).toBeInTheDocument();
    expect(within(settings).getByText('Skills')).toBeInTheDocument();
  });

  it('opens a settings page on click and drops the typed command', async () => {
    renderComposer();
    type('/mcp');
    const link = await screen.findByText('MCP servers');
    fireEvent.mouseDown(link);
    expect(navigate).toHaveBeenCalledWith({ view: 'mcp_servers' });
    expect(textbox()).toHaveValue('');
    expect(screen.queryByRole('listbox', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('reaches a settings page with the arrow keys and Enter', async () => {
    renderComposer(undefined, ['compact']);
    type('/me');
    // `memory` matches no command, so the first option is the Memory link.
    await screen.findByText('Memory');
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith({ view: 'settings', section: 'memory' });
  });

  it('moves from the last command to the first link', async () => {
    renderComposer(undefined, ['compact']);
    type('/comp');
    await screen.findByText('compact');
    fireEvent.keyDown(textbox(), { key: 'ArrowDown' });
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    expect(textbox()).toHaveValue('/compact ');
  });

  it('shows no settings links for a file mention', async () => {
    renderComposer();
    type('@src');
    await screen.findByText('src/app.ts');
    expect(screen.queryByRole('listbox', { name: 'Settings' })).not.toBeInTheDocument();
  });
});

describe('ComposerPopover', () => {
  it('shows the empty text only when nothing matches', () => {
    render(<ComposerPopover kind="slash" items={[]} active={0} loading={false} onPick={vi.fn()} onHover={vi.fn()} />);
    expect(screen.getByText('No matching command.')).toBeInTheDocument();
  });

  it('shows links without commands and calls back with the link id', () => {
    const onPickLink = vi.fn();
    const onHover = vi.fn();
    render(
      <ComposerPopover
        kind="slash"
        items={[]}
        active={0}
        loading={false}
        onPick={vi.fn()}
        onHover={onHover}
        links={[{ id: 'skills', label: 'Skills', description: 'Manage skills' }]}
        onPickLink={onPickLink}
      />,
    );
    expect(screen.queryByText('No matching command.')).not.toBeInTheDocument();
    const option = screen.getByRole('option', { selected: true });
    expect(option).toHaveTextContent('SkillsManage skills');
    fireEvent.mouseEnter(within(option).getByRole('button'));
    expect(onHover).toHaveBeenCalledWith(0);
    fireEvent.mouseDown(within(option).getByRole('button'));
    expect(onPickLink).toHaveBeenCalledWith('skills');
  });

  it('marks the active link after the items', () => {
    render(
      <ComposerPopover
        kind="slash"
        items={['compact']}
        active={1}
        loading={false}
        onPick={vi.fn()}
        onHover={vi.fn()}
        links={[{ id: 'skills', label: 'Skills', description: 'Manage skills' }]}
      />,
    );
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Skills');
  });
});

describe('composerSettingsLinks', () => {
  const ids = (features: Partial<Features> | null) => composerSettingsLinks(features as Features | null).map((l) => l.id);

  it.each<[string, Partial<Features> | null, string[]]>([
    ['features still loading', null, ['skills', 'instructions', 'integrations']],
    ['sessions only', { workbenches: true }, ['skills', 'instructions', 'memory', 'sandbox-setup', 'integrations']],
    ['MCP servers', { mcpServers: true }, ['mcp-servers', 'skills', 'instructions', 'integrations']],
    ['private routes', { privateRoutes: true }, ['skills', 'instructions', 'private-routes', 'integrations']],
    [
      'everything',
      { workbenches: true, mcpServers: true, privateRoutes: true },
      ['mcp-servers', 'skills', 'instructions', 'memory', 'sandbox-setup', 'private-routes', 'integrations'],
    ],
  ])('offers the pages for %s', (_name, features, expected) => {
    expect(ids(features)).toEqual(expected);
  });

  it.each([
    ['an empty query', '', 7],
    ['a label', 'MCP', 1],
    ['a keyword', 'tailnet', 1],
    ['an id with a dash', 'sandbox-', 1],
    ['no page', 'zzz', 0],
  ])('matches %s', (_name, query, count) => {
    const links = composerSettingsLinks({ workbenches: true, mcpServers: true, privateRoutes: true } as Features);
    expect(matchComposerLinks(links, query)).toHaveLength(count);
  });
});
