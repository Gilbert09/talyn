import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { WorkflowInput } from '@talyn/shared';
import { WORKFLOW_LIMIT_ERROR_CODE } from '@talyn/shared';
import { api, ApiError } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useBillingStore } from '../stores/billing';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';

const spy = vi.spyOn.bind(vi);

/**
 * The free plan's workflow cap, as the Workflows page presents it.
 *
 * The server gate is the real one; what is pinned here is that the page refuses
 * BEFORE the form rather than after it — filling in a trigger, conditions and
 * actions and only then being told you may not keep it is the worst order to
 * learn it in — and that a refusal arriving anyway (another window, another
 * workspace) opens the pitch instead of a raw error.
 *
 * The count is owner-wide, so it counts workflows in workspaces this page
 * cannot see. That is why the check reads the billing snapshot and not the list
 * on screen.
 *
 * The editor is stubbed: what is under test is the panel's decision to open it
 * or not, and how it answers a refused save. The editor's own behaviour is not.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

const DRAFT: WorkflowInput = {
  name: 'Label new PRs',
  enabled: true,
  events: ['pr_opened'],
  conditions: {},
  actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
  maxRunsPerPrPerHour: 5,
};

vi.mock('../components/panels/workflows/WorkflowEditorPage', () => ({
  WorkflowEditorPage: ({ onSave }: { onSave: (input: WorkflowInput) => Promise<void> }) => (
    <div data-attr="editor-stub">
      <button data-attr="stub-save" onClick={() => void onSave(DRAFT).catch(() => {})}>
        Save
      </button>
    </div>
  ),
}));

function seed(opts: {
  workflows: number;
  workflowLimit: number | null;
  plan?: 'free' | 'unlimited';
}) {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' } as never);
  useBillingStore.setState({
    status: {
      billingEnabled: true,
      plan: opts.plan ?? 'free',
      planSource: 'default',
      cancelAtPeriodEnd: false,
      activeTasks: 0,
      activeTaskLimit: 3,
      queuedPrs: 0,
      mergeQueueLimit: 3,
      workflows: opts.workflows,
      workflowLimit: opts.workflowLimit,
    },
    upgradeModalOpen: false,
    upgradeReason: null,
  } as never);
}

const newButton = () => document.querySelector('[data-attr="workflow-new"]')!;
const editorOpen = () => Boolean(document.querySelector('[data-attr="editor-stub"]'));

describe('WorkflowsPanel — the free-plan workflow cap', () => {
  beforeEach(() => {
    spy(api.workflows, 'list').mockResolvedValue([]);
    spy(api.workflows, 'suggestions').mockResolvedValue({
      repos: [],
      branches: [],
      labels: [],
      people: [],
      teams: [],
    } as never);
    spy(api.ws, 'on').mockReturnValue(() => {});
    spy(useBillingStore.getState(), 'refresh').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('pitches the upgrade instead of opening the editor at the limit', async () => {
    seed({ workflows: 3, workflowLimit: 3 });
    render(<WorkflowsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    expect(useBillingStore.getState().upgradeReason).toBe('workflow_limit');
    expect(editorOpen()).toBe(false);
  });

  it.each([
    { label: 'below the limit', workflows: 2, workflowLimit: 3 as number | null },
    { label: 'on an unlimited plan', workflows: 40, workflowLimit: null as number | null },
  ])('opens the editor $label', async ({ workflows, workflowLimit }) => {
    seed({ workflows, workflowLimit, plan: workflowLimit === null ? 'unlimited' : 'free' });
    render(<WorkflowsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    await waitFor(() => expect(editorOpen()).toBe(true));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('opens the editor while the snapshot is still loading', async () => {
    // A null status is "not known yet", never "refuse". The server still gates.
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' } as never);
    useBillingStore.setState({
      status: null,
      upgradeModalOpen: false,
      upgradeReason: null,
    } as never);
    render(<WorkflowsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    await waitFor(() => expect(editorOpen()).toBe(true));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('turns a 402 from the save into the pitch, keeping the editor open', async () => {
    // The snapshot says there is room — the slot went elsewhere between the
    // click and the save, which is the only way this 402 reaches a user.
    seed({ workflows: 2, workflowLimit: 3 });
    const create = spy(api.workflows, 'create').mockRejectedValue(
      new ApiError('Free plan is limited to 3 workflows', 402, WORKFLOW_LIMIT_ERROR_CODE)
    );
    render(<WorkflowsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());
    fireEvent.click(newButton());
    await waitFor(() => expect(editorOpen()).toBe(true));

    fireEvent.click(document.querySelector('[data-attr="stub-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(useBillingStore.getState().upgradeModalOpen).toBe(true));
    expect(useBillingStore.getState().upgradeReason).toBe('workflow_limit');
    // The user's work is still on screen — the modal explains, the form waits.
    expect(editorOpen()).toBe(true);
  });

  it('re-reads the owner-wide count after a workflow is created', async () => {
    seed({ workflows: 1, workflowLimit: 3 });
    spy(api.workflows, 'create').mockResolvedValue({
      id: 'wf1',
      workspaceId: 'ws1',
      ...DRAFT,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
      stats: {
        runsTotal: 0,
        runs24h: 0,
        runs7d: 0,
        failures7d: 0,
        tasksStarted: 0,
        lastRunAt: null,
        lastStatus: null,
      },
    } as never);
    render(<WorkflowsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());
    fireEvent.click(newButton());
    await waitFor(() => expect(editorOpen()).toBe(true));

    fireEvent.click(document.querySelector('[data-attr="stub-save"]')!);

    // Without this the NEXT click pre-empts on a stale count, or fails to.
    await waitFor(() => expect(useBillingStore.getState().refresh).toHaveBeenCalled());
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });
});
