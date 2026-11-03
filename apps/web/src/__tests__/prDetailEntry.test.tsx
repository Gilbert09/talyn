import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { pullRequestOutcomeEvent, type AgentEvent, type Workbench } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { WorkbenchHeader } from '../components/workbench/WorkbenchHeader';
import { prDetailIdFor } from '../lib/prDetail';
import { openExternal } from '../lib/openExternal';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { pullRequests: {}, workbenches: {} } }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const WB = {
  id: 'wb1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'lisbon',
  baseBranch: 'main',
  runtime: 'sandbox',
  status: 'ready',
  sandboxState: 'running',
  pullRequestId: 'pr1',
  pr: { number: 42 },
  settings: {},
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
} as unknown as Workbench;

// An untracked row: session PRs are no longer marked tracked.
const ROW = {
  id: 'pr1',
  number: 42,
  repo: 'acme/app',
  state: 'open',
  tracked: false,
  summary: { title: 'Add a thing', url: 'https://github.com/acme/app/pull/42', checks: { total: 0 } },
} as unknown as PRRow;

const ops = { runtime: 'sandbox', unavailable: null, canRemoveQueued: false, canAttach: false } as unknown as WorkbenchOps;

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useWorkbenchStore.setState({ workbenches: { wb1: WB }, selectedWorkbenchId: 'wb1', prDetailId: null });
  usePullRequestStore.setState({ rows: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the session header PR button', () => {
  it('opens the details for an untracked PR and keeps a GitHub link', () => {
    render(<WorkbenchHeader workbench={WB} pr={ROW} chat={null} ops={ops} />);
    fireEvent.click(screen.getByRole('button', { name: /PR #42/ }));
    expect(useWorkbenchStore.getState().prDetailId).toBe('pr1');
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open #42 on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/42');
  });
});

describe('the PR card in the chat', () => {
  const url = 'https://github.com/acme/app/pull/42';
  const event = (number: number) =>
    ({ seq: 3, ...pullRequestOutcomeEvent({ ok: true, number, url, existing: false }) }) as AgentEvent;

  it('opens the details of the session PR', () => {
    render(<AgentBlocks events={[event(42)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the details of pull request #42' }));
    expect(useWorkbenchStore.getState().prDetailId).toBe('pr1');
  });

  it('finds another PR of the same repository in the loaded rows', () => {
    usePullRequestStore.setState({ rows: [{ ...ROW, id: 'pr9', number: 9 }] });
    render(<AgentBlocks events={[event(9)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the details of pull request #9' }));
    expect(useWorkbenchStore.getState().prDetailId).toBe('pr9');
  });

  it('shows no Details button for a PR it cannot place, and keeps Open', () => {
    render(<AgentBlocks events={[event(77)]} />);
    expect(screen.queryByRole('button', { name: /Open the details/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open pull request #77' })).toBeInTheDocument();
  });
});

describe('prDetailIdFor', () => {
  it.each([
    ['no session', null, 42, null],
    ['the session PR', WB, 42, 'pr1'],
    ['a session with no PR summary', { ...WB, pr: null } as unknown as Workbench, 5, 'pr1'],
    ['an unknown number', WB, 5, null],
  ])('%s', (_name, wb, number, expected) => {
    expect(prDetailIdFor(wb as Workbench | null, number)).toBe(expected);
  });
});
