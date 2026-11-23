import '@testing-library/jest-dom';
import React from 'react';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import { emptyLoopInput, type CloudAgentChoice, type LoopInput, type LoopWithStats } from '@talyn/shared';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useSpacesStore } from '../renderer/stores/spaces';
import { LoopEditorPage } from '../renderer/components/panels/loops/LoopEditorPage';

/**
 * When the loop editor is allowed to complain.
 *
 * Only when asked. This started as the workflow editor's rule — quiet until the
 * first Save, live forever after — and that turned one refused click into a
 * permanent nag: change the agent, still be told the name is empty, about a
 * field you had moved on from. The screenshot that prompted this showed exactly
 * that, and the message is the thing under test rather than the layout.
 */

const AGENTS: CloudAgentChoice[] = [
  {
    type: 'selfhosted',
    displayName: 'Talyn Fleet',
    model: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', label: 'Opus 5', blurb: 'Newest Opus.' }],
  },
];

const FLEET_AGENT: CloudAgentChoice = {
  type: 'selfhosted',
  agent: 'codex',
  displayName: 'Talyn Fleet (Codex)',
  model: 'gpt-6.1-sol',
  models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1', blurb: 'Latest Codex model.' }],
};

function renderEditor(
  onSave: (i: LoopInput) => Promise<void> = async () => {},
  agents: CloudAgentChoice[] = AGENTS,
  editing: LoopWithStats | null = null
) {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: [
      { id: 'repo-1', workspaceId: 'ws1', owner: 'acme', repo: 'widget', fullName: 'acme/widget' },
    ],
  } as never);
  return render(
    <LoopEditorPage editing={editing} agents={agents} onCancel={() => {}} onSave={onSave} />
  );
}

const repoPicker = () => screen.getByRole('button', { name: 'Repository' });
const createButton = () => document.querySelector('[data-attr="loop-save-inline"]')!;
// queryAllByText, not queryByText: the message is deliberately shown twice —
// a banner at the top of a long form, and again beside the button you actually
// press — so the single-match query throws rather than answering.
const problemShown = () => screen.queryAllByText(/name must be a non-empty string/i).length > 0;

describe('LoopEditorPage — when it complains', () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver or scrollIntoView. The repository list (cmdk) calls both.
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('says nothing about an empty form until Create is pressed', () => {
    renderEditor();
    // The editor opens blank by definition; announcing that on arrival is
    // telling somebody off for not having started.
    expect(problemShown()).toBe(false);
  });

  it('offers Fleet agents only and has no run-as picker', () => {
    const posthog = { ...AGENTS[0], type: 'posthog_code', displayName: 'PostHog Code' } as CloudAgentChoice;
    renderEditor(async () => {}, [posthog, FLEET_AGENT]);

    expect(screen.queryByText('Start each run as')).not.toBeInTheDocument();
    expect(screen.queryByText('PostHog Code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toHaveValue('selfhosted:codex');
    expect(screen.queryByText('MCP servers')).not.toBeInTheDocument();
  });

  it('explains the refusal when Create is pressed', async () => {
    const onSave = jest.fn(async () => {});
    renderEditor(onSave);

    fireEvent.click(createButton());

    await waitFor(() => expect(problemShown()).toBe(true));
    // Refused locally — the server is never asked for a loop we know is invalid.
    expect(onSave).not.toHaveBeenCalled();
  });

  it('retracts the complaint as soon as the form changes', async () => {
    // The regression. `attempted` used to latch true, so every later edit was
    // re-judged and the message followed the user around the form — including
    // to fields the complaint was not about.
    renderEditor();
    fireEvent.click(createButton());
    await waitFor(() => expect(problemShown()).toBe(true));

    // An edit to an UNRELATED field: this is the case from the screenshot,
    // where touching the agent section redisplayed a complaint about the name.
    fireEvent.click(screen.getByText('Start it anyway'));

    await waitFor(() => expect(problemShown()).toBe(false));
  });

  it('complains again on the next Create, if it is still incomplete', async () => {
    // Retracting must not mean giving up: a second press still has to answer.
    renderEditor();
    fireEvent.click(createButton());
    await waitFor(() => expect(problemShown()).toBe(true));

    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: 'Do the thing.' },
    });
    await waitFor(() => expect(problemShown()).toBe(false));

    fireEvent.click(createButton());
    await waitFor(() => expect(problemShown()).toBe(true));
  });

  it('saves a session loop with no per-loop MCP selection', async () => {
    const onSave = jest.fn(async (_input: LoopInput) => {});
    renderEditor(onSave);
    expect(screen.queryByText('Start each run as')).toBeNull();
    expect(screen.queryByText('MCP servers')).toBeNull();

    fireEvent.change(document.querySelector('input')!, { target: { value: 'Triage' } });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Do the thing.' } });
    expect(repoPicker().textContent).toContain('Pick a repository');
    fireEvent.click(repoPicker());
    fireEvent.click(await screen.findByRole('option', { name: /acme\/widget/ }));
    expect(repoPicker().textContent).toContain('acme/widget');
    fireEvent.click(createButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      target: 'session',
      provider: 'selfhosted',
      mcpServerIds: null,
      repositoryId: 'repo-1',
      repoFullName: 'acme/widget',
    });
  });

  it('preselects the repository of a loop being edited', async () => {
    const onSave = jest.fn(async (_input: LoopInput) => {});
    const loop = {
      ...emptyLoopInput('UTC'),
      id: 'loop-1',
      workspaceId: 'ws1',
      name: 'Triage',
      prompt: 'Do the thing.',
      provider: 'selfhosted',
      model: 'claude-opus-5',
      repositoryId: 'repo-1',
      repoFullName: 'acme/widget',
      createdAt: '',
      updatedAt: '',
    } as unknown as LoopWithStats;
    renderEditor(onSave, AGENTS, loop);
    expect(repoPicker().textContent).toContain('acme/widget');

    fireEvent.click(repoPicker());
    const option = await screen.findByRole('option', { name: /acme\/widget/ });
    expect(option.querySelector('svg.lucide-check')).not.toBeNull();
    fireEvent.click(option);

    fireEvent.click(document.querySelector('[data-attr="loop-save-inline"]')!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ repositoryId: 'repo-1', repoFullName: 'acme/widget' });
  });
});

describe('LoopEditorPage — the Space section', () => {
  const TEAM = {
    id: 'team-1',
    name: 'Acme',
    role: 'member',
    homeWorkspaceId: 'ws1',
    createdAt: '2026-11-01T00:00:00Z',
    spaces: [{ id: 'space-1', teamId: 'team-1', name: 'Web' }],
  };

  function renderWith(
    opts: { spaces: boolean; teams: unknown[] | null; editing?: unknown },
    onSave: (i: LoopInput) => Promise<void> = async () => {}
  ) {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      features: { spaces: opts.spaces },
      repositories: [
        { id: 'repo-1', workspaceId: 'ws1', owner: 'acme', repo: 'widget', fullName: 'acme/widget' },
      ],
    } as never);
    useSpacesStore.setState({ teams: opts.teams } as never);
    return render(
      <LoopEditorPage
        editing={(opts.editing ?? null) as never}
        agents={AGENTS}
        onCancel={() => {}}
        onSave={onSave}
      />
    );
  }

  afterEach(() => {
    cleanup();
    useSpacesStore.setState({ teams: null } as never);
    useWorkspaceStore.setState({ features: null } as never);
  });

  it('is hidden while Spaces is off', () => {
    renderWith({ spaces: false, teams: [TEAM] });
    expect(screen.queryByText('Space')).toBeNull();
  });

  it('is hidden when I am in no team with a space', () => {
    renderWith({ spaces: true, teams: [] });
    expect(screen.queryByText('Space')).toBeNull();
  });

  it('defaults to Personal and saves the space I pick', async () => {
    const onSave = jest.fn(async (_input: LoopInput) => {});
    renderWith({ spaces: true, teams: [TEAM] }, onSave);
    const select = document.querySelector('[data-attr="loop-space"]') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByText("Every run's session goes to this space.")).toBeTruthy();

    fireEvent.change(select, { target: { value: 'space-1' } });
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Triage' } });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Do the thing.' } });
    fireEvent.change(screen.getByDisplayValue('Pick a repository...'), { target: { value: 'repo-1' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ spaceId: 'space-1' });
  });

  it('saves Personal as null', async () => {
    const onSave = jest.fn(async (_input: LoopInput) => {});
    renderWith({ spaces: true, teams: [TEAM] }, onSave);
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Triage' } });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Do the thing.' } });
    fireEvent.change(screen.getByDisplayValue('Pick a repository...'), { target: { value: 'repo-1' } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ spaceId: null });
  });

  it('keeps a saved space I can no longer use, and says so', () => {
    renderWith({
      spaces: true,
      teams: [],
      editing: {
        id: 'loop-1',
        workspaceId: 'ws1',
        name: 'Triage',
        enabled: true,
        prompt: 'Do the thing.',
        cron: '0 9 * * *',
        timezone: 'UTC',
        provider: 'selfhosted',
        model: AGENTS[0].model,
        target: 'session',
        concurrency: 'skip',
        internetAccess: false,
        mcpServerIds: null,
        repositoryId: 'repo-1',
        repoFullName: 'acme/widget',
        spaceId: 'space-gone',
        nextRunAt: null,
        disabledReason: null,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
        stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null },
      },
    });
    const select = document.querySelector('[data-attr="loop-space"]') as HTMLSelectElement;
    expect(select.value).toBe('space-gone');
    expect(screen.getByText('A space you cannot use')).toBeTruthy();
  });
});
