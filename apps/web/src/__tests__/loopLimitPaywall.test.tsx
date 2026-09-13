import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { LoopInput } from '@talyn/shared';
import { LOOP_LIMIT_ERROR_CODE } from '@talyn/shared';
import { api, ApiError } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useBillingStore } from '../stores/billing';
import { LoopsPanel } from '../components/panels/loops/LoopsPanel';

const spy = vi.spyOn.bind(vi);

/**
 * The free plan's loop cap, as the Loops page presents it.
 *
 * The workflow paywall test's twin. The server gate is the real one; what is
 * pinned here is that the page refuses BEFORE the form — writing a prompt,
 * picking a schedule and an agent and only then being told you may not keep it
 * is the worst order to learn it in — and that a refusal arriving anyway
 * (another window, another workspace) opens the pitch instead of a raw error.
 *
 * The count is owner-wide, so it counts loops in workspaces this page cannot
 * see. That is why the check reads the billing snapshot and not the list on
 * screen.
 *
 * The editor is stubbed: what is under test is the panel's decision to open it
 * or not, and how it answers a refused save.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

const DRAFT: LoopInput = {
  name: 'Morning triage',
  enabled: true,
  prompt: 'Fix yesterday’s failing checks.',
  cron: '0 9 * * *',
  timezone: 'UTC',
  provider: 'posthog_code',
  model: 'claude-opus-5',
  concurrency: 'skip',
  repositoryId: 'repo-1',
  repoFullName: 'acme/widget',
};

vi.mock('../components/panels/loops/LoopEditorPage', () => ({
  LoopEditorPage: ({ onSave }: { onSave: (input: LoopInput) => Promise<void> }) => (
    <div data-attr="editor-stub">
      <button data-attr="stub-save" onClick={() => void onSave(DRAFT).catch(() => {})}>
        Save
      </button>
    </div>
  ),
}));

function seed(opts: { loops: number; loopLimit: number | null; plan?: 'free' | 'unlimited' }) {
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
      workflows: 0,
      workflowLimit: 3,
      loops: opts.loops,
      loopLimit: opts.loopLimit,
    },
    upgradeModalOpen: false,
    upgradeReason: null,
  } as never);
}

const newButton = () => document.querySelector('[data-attr="loop-new"]')!;
const editorOpen = () => Boolean(document.querySelector('[data-attr="editor-stub"]'));

describe('LoopsPanel — the free-plan loop cap', () => {
  beforeEach(() => {
    spy(api.loops, 'list').mockResolvedValue([]);
    spy(api.ws, 'on').mockReturnValue(() => {});
    spy(useBillingStore.getState(), 'refresh').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('pitches the upgrade instead of opening the editor at the limit', async () => {
    seed({ loops: 3, loopLimit: 3 });
    render(<LoopsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    // Its own reason, not the workflow one — the modal branches on this to pick
    // which pitch to show.
    expect(useBillingStore.getState().upgradeReason).toBe('loop_limit');
    expect(editorOpen()).toBe(false);
  });

  it.each([
    { label: 'below the limit', loops: 2, loopLimit: 3 as number | null },
    { label: 'on an unlimited plan', loops: 40, loopLimit: null as number | null },
  ])('opens the editor $label', async ({ loops, loopLimit }) => {
    seed({ loops, loopLimit, plan: loopLimit === null ? 'unlimited' : 'free' });
    render(<LoopsPanel />);
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
    render(<LoopsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    await waitFor(() => expect(editorOpen()).toBe(true));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('a full WORKFLOW allowance does not refuse a loop', async () => {
    // The two caps are independent. A panel that read the wrong field would
    // pass every test above.
    seed({ loops: 0, loopLimit: 3 });
    useBillingStore.setState({
      status: { ...useBillingStore.getState().status!, workflows: 3, workflowLimit: 3 },
    } as never);
    render(<LoopsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());

    fireEvent.click(newButton());

    await waitFor(() => expect(editorOpen()).toBe(true));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('turns a 402 from the save into the pitch, keeping the editor open', async () => {
    // The snapshot says there is room — the slot went elsewhere between the
    // click and the save, which is the only way this 402 reaches a user.
    seed({ loops: 2, loopLimit: 3 });
    const create = spy(api.loops, 'create').mockRejectedValue(
      new ApiError('Free plan is limited to 3 loops', 402, LOOP_LIMIT_ERROR_CODE)
    );
    render(<LoopsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());
    fireEvent.click(newButton());
    await waitFor(() => expect(editorOpen()).toBe(true));

    fireEvent.click(document.querySelector('[data-attr="stub-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(useBillingStore.getState().upgradeModalOpen).toBe(true));
    expect(useBillingStore.getState().upgradeReason).toBe('loop_limit');
    // The user's work is still on screen — the modal explains, the form waits.
    expect(editorOpen()).toBe(true);
  });

  it('re-reads the owner-wide count after a loop is created', async () => {
    seed({ loops: 1, loopLimit: 3 });
    spy(api.loops, 'create').mockResolvedValue({
      id: 'loop1',
      workspaceId: 'ws1',
      ...DRAFT,
      nextRunAt: '2026-09-13T09:00:00.000Z',
      disabledReason: null,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
      stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null },
    } as never);
    render(<LoopsPanel />);
    await waitFor(() => expect(newButton()).toBeTruthy());
    fireEvent.click(newButton());
    await waitFor(() => expect(editorOpen()).toBe(true));

    fireEvent.click(document.querySelector('[data-attr="stub-save"]')!);

    // Without this the NEXT click pre-empts on a stale count, or fails to.
    await waitFor(() => expect(useBillingStore.getState().refresh).toHaveBeenCalled());
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });
});
