import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import { emptyLoopInput, type CloudAgentChoice, type LoopInput, type LoopWithStats } from '@talyn/shared';
import { useWorkspaceStore } from '../stores/workspace';
import { LoopEditorPage } from '../components/panels/loops/LoopEditorPage';

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

function renderEditor(
  onSave: (i: LoopInput) => Promise<void> = async () => {},
  editing: LoopWithStats | null = null
) {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: [
      { id: 'repo-1', workspaceId: 'ws1', owner: 'acme', repo: 'widget', fullName: 'acme/widget' },
    ],
  } as never);
  return render(
    <LoopEditorPage editing={editing} agents={AGENTS} onCancel={() => {}} onSave={onSave} />
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
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says nothing about an empty form until Create is pressed', () => {
    renderEditor();
    // The editor opens blank by definition; announcing that on arrival is
    // telling somebody off for not having started.
    expect(problemShown()).toBe(false);
  });

  it('explains the refusal when Create is pressed', async () => {
    const onSave = vi.fn(async () => {});
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
    const onSave = vi.fn(async (_input: LoopInput) => {});
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
    const onSave = vi.fn(async (_input: LoopInput) => {});
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
    renderEditor(onSave, loop);
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
