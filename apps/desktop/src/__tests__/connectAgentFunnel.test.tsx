import '@testing-library/jest-dom';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';
import { trackEvent } from '../renderer/lib/analytics';
import { ConnectAgentModal } from '../renderer/components/modals/ConnectAgentModal';

/**
 * The connect funnel. 29 of 46 active accounts have no agent connected and so
 * cannot delegate anything, and until now this modal — the one surface that
 * asks them at the moment they wanted work done — recorded nothing at all.
 * "We asked and they declined" and "we never asked" were the same absence.
 *
 * Two events, and the pair is the point: `connect_agent_opened` is the ask,
 * `connect_agent_dispatched` is the stashed click actually running afterwards.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

type Harness = {
  open: boolean;
  pending: unknown;
  source: string | null;
  providerReady: boolean;
  createPostHogTask: jest.Mock;
  runSkillTask: jest.Mock;
  closeConnectAgent: jest.Mock;
};
// On globalThis, not in module scope: both runners hoist their `mock` calls
// above every import, so a plain const is still in its dead zone when a
// factory first runs.
const h = (): Harness =>
  ((globalThis as unknown as { __talynConnect?: Harness }).__talynConnect ??= {
    open: false,
    pending: null,
    source: null,
    providerReady: false,
    createPostHogTask: jest.fn(async () => true),
    runSkillTask: jest.fn(async () => true),
    closeConnectAgent: jest.fn(),
  });

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/components/panels/SettingsPanel', () => ({ ProviderConnectCards: () => null }));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => {
    const s = (globalThis as unknown as { __talynConnect: Harness }).__talynConnect;
    return {
      createPostHogTask: s.createPostHogTask,
      runSkillTask: s.runSkillTask,
      providerReady: s.providerReady,
    };
  },
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: unknown) => unknown) => {
    const s = (globalThis as unknown as { __talynConnect: Harness }).__talynConnect;
    return sel({
      connectAgentOpen: s.open,
      pendingCloudTask: s.pending,
      connectAgentSource: s.source,
      closeConnectAgent: s.closeConnectAgent,
    });
  },
}));

const row = { id: 'pr1', owner: 'acme', repo: 'app', number: 7 } as unknown as PRRow;

const calls = (name: string) =>
  (trackEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    (c) => c[0] === name
  );

beforeEach(() => {
  const s = h();
  s.open = false;
  s.pending = null;
  s.source = null;
  s.providerReady = false;
  s.createPostHogTask = jest.fn(async () => true);
  s.runSkillTask = jest.fn(async () => true);
  s.closeConnectAgent = jest.fn();
});
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('connect_agent_opened — the ask', () => {
  it('records the surface that asked and what was stashed', () => {
    Object.assign(h(), { open: true, source: 'pr_detail_banner', pending: { kind: 'fix', row } });
    render(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')).toEqual([
      [
        'connect_agent_opened',
        { source: 'pr_detail_banner', pending_kind: 'fix', provider_ready: false },
      ],
    ]);
  });

  it.each([
    ['task_button', { kind: 'fix', row }, 'fix'],
    ['pr_detail_banner', null, 'none'],
  ] as const)('reports source %s with pending_kind %s', (source, pending, kind) => {
    Object.assign(h(), { open: true, source, pending });
    render(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')[0][1]).toMatchObject({
      source,
      pending_kind: kind,
    });
  });

  it('falls back to "unknown" rather than dropping the property', () => {
    Object.assign(h(), { open: true, source: null });
    render(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')[0][1]).toMatchObject({ source: 'unknown' });
  });

  it('counts one ask per open, not one per render', () => {
    Object.assign(h(), { open: true, source: 'task_button' });
    const { rerender } = render(<ConnectAgentModal />);
    rerender(<ConnectAgentModal />);
    rerender(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')).toHaveLength(1);
  });

  it('asks again after the modal has closed and reopened', () => {
    Object.assign(h(), { open: true, source: 'task_button' });
    const { rerender } = render(<ConnectAgentModal />);
    h().open = false;
    rerender(<ConnectAgentModal />);
    h().open = true;
    rerender(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')).toHaveLength(2);
  });

  it('says nothing while it is closed', () => {
    render(<ConnectAgentModal />);
    expect(calls('connect_agent_opened')).toHaveLength(0);
  });
});

describe('connect_agent_dispatched — the ask paying off', () => {
  it('fires when the stashed fix runs after a provider connects', async () => {
    Object.assign(h(), { open: true, source: 'pr_detail_banner', pending: { kind: 'fix', row } });
    const { rerender } = render(<ConnectAgentModal />);
    expect(h().createPostHogTask).not.toHaveBeenCalled();

    h().providerReady = true; // the env row lands over the websocket
    rerender(<ConnectAgentModal />);

    await waitFor(() => expect(h().createPostHogTask).toHaveBeenCalledWith(row, undefined, undefined));
    await waitFor(() =>
      expect(calls('connect_agent_dispatched')).toEqual([
        ['connect_agent_dispatched', { source: 'pr_detail_banner', pending_kind: 'fix' }],
      ])
    );
  });

  it('stays silent when the dispatch itself declines to run', async () => {
    Object.assign(h(), {
      open: true,
      source: 'task_button',
      pending: { kind: 'fix', row },
      providerReady: true,
      createPostHogTask: jest.fn(async () => false),
    });
    render(<ConnectAgentModal />);
    await waitFor(() => expect(h().closeConnectAgent).toHaveBeenCalled());
    expect(calls('connect_agent_dispatched')).toHaveLength(0);
  });

  it('never fires on an open with nothing stashed', async () => {
    Object.assign(h(), { open: true, source: 'pr_detail_banner', providerReady: true });
    render(<ConnectAgentModal />);
    await waitFor(() => expect(calls('connect_agent_opened')).toHaveLength(1));
    expect(calls('connect_agent_dispatched')).toHaveLength(0);
    expect(h().createPostHogTask).not.toHaveBeenCalled();
  });
});
