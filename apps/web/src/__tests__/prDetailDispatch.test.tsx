import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import { trackEvent } from '../lib/analytics';
import { PRDetailSheet } from '../components/widgets/PRDetailSheet';

/**
 * The PR detail sheet is where the reading happens, and until now it offered
 * no way to hand the PR to an agent and recorded nothing about whether it
 * could have. Both are under test here.
 *
 * `pr_detail_opened` carries what the sheet COULD have offered at the instant
 * it opened. That is the number that sizes the whole opportunity: a disabled
 * control emits nothing, so "people read PRs and never delegate" and "we
 * refuse nearly every PR they read" used to be the same shape in the funnel.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

/**
 * Mutable state the module factories read. Kept on `globalThis` rather than in
 * module scope because both runners hoist their `mock` calls above every
 * import, so a plain const is still in its temporal dead zone when a factory
 * first runs. Named, not anonymous, so a leak between files is greppable.
 */
type Harness = { providerReady: boolean; tasks: Array<{ id: string; status: string }> };
const harness = (): Harness =>
  ((globalThis as unknown as { __talynPrDetail?: Harness }).__talynPrDetail ??= {
    providerReady: true,
    tasks: [],
  });

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/prSummaryCache', () => ({ prime: vi.fn() }));
vi.mock('../hooks/useOnReconnect', () => ({ useOnReconnect: vi.fn() }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => ({
    createPostHogTask: vi.fn(async () => true),
    providerReady: (
      globalThis as unknown as { __talynPrDetail?: { providerReady: boolean } }
    ).__talynPrDetail?.providerReady !== false,
  }),
}));
vi.mock('../stores/pullRequests', () => ({
  usePullRequestStore: (sel: (s: unknown) => unknown) => sel({ rows: [] }),
}));
vi.mock('../stores/workspace', () => {
  const getState = () => ({
    tasks:
      (globalThis as unknown as { __talynPrDetail?: { tasks: unknown[] } }).__talynPrDetail
        ?.tasks ?? [],
    openConnectAgent: vi.fn(),
  });
  const hook = (sel: (s: unknown) => unknown) => sel(getState());
  hook.getState = getState;
  return { useWorkspaceStore: hook };
});
vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      // Never resolves: the sheet must report what it knew from `seedRow` at
      // open time, not wait on a round trip to GitHub to do it.
      description: vi.fn(() => new Promise(() => {})),
      get: vi.fn(() => new Promise(() => {})),
      files: vi.fn(() => new Promise(() => {})),
      focus: vi.fn(async () => {}),
    },
    posthog: { getStatus: vi.fn(async () => ({ connected: false })) },
    ws: { on: vi.fn(() => () => {}) },
  },
}));

/** `fixable: false` is a clean, approved, green PR — nothing to point an agent at. */
function row(opts: { fixable: boolean; taskId?: string | null; state?: string }): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: opts.taskId ?? null,
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: (opts.state ?? 'open') as PRRow['state'],
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '',
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '',
    updatedAt: '',
    summary: {
      title: 'a PR',
      author: 'octocat',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE',
      mergeStateStatus: opts.fixable ? 'UNSTABLE' : 'CLEAN',
      reviewDecision: opts.fixable ? null : 'APPROVED',
      blockingReason: opts.fixable ? 'checks_failed' : 'mergeable',
      checks: opts.fixable
        ? { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 }
        : { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  };
}

function open(seedRow: PRRow | null) {
  render(<PRDetailSheet pullRequestId="pr1" onClose={vi.fn()} seedRow={seedRow} />);
}

const opened = () =>
  (trackEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
    (c) => c[0] === 'pr_detail_opened'
  )?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  harness().providerReady = true;
  harness().tasks.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('pr_detail_opened — what the sheet could have offered', () => {
  it('reports a fixable PR as dispatchable, with no blocked reason', () => {
    open(row({ fixable: true }));
    expect(opened()).toEqual({ can_dispatch: true, has_agent: true });
  });

  it('names why a clean PR cannot be delegated', () => {
    open(row({ fixable: false }));
    expect(opened()).toEqual({
      can_dispatch: false,
      dispatch_blocked_reason: 'no_fixable_issues',
      has_agent: true,
    });
  });

  it('separates "a run is already on it" from "nothing to fix"', () => {
    harness().tasks.push({ id: 't1', status: 'in_progress' });
    open(row({ fixable: true, taskId: 't1' }));
    expect(opened()).toMatchObject({
      can_dispatch: false,
      dispatch_blocked_reason: 'task_running',
    });
  });

  it('treats a finished run as no obstacle at all', () => {
    harness().tasks.push({ id: 't1', status: 'completed' });
    open(row({ fixable: true, taskId: 't1' }));
    expect(opened()).toMatchObject({ can_dispatch: true });
  });

  it.each([true, false])('records whether an agent is connected (%s)', (ready) => {
    harness().providerReady = ready;
    open(row({ fixable: true }));
    expect(opened()).toMatchObject({ has_agent: ready });
  });

  // Opened from a surface with no loaded row (the task screen). Guessing
  // "dispatchable" or "blocked" here would read as fact in the funnel.
  it('omits the dispatch properties rather than guessing when it has no row', () => {
    open(null);
    expect(opened()).toEqual({ has_agent: true });
  });
});

describe('the connect prompt, at the point of need', () => {
  it('asks an unconnected author to connect an agent', async () => {
    harness().providerReady = false;
    open(row({ fixable: true }));
    await waitFor(() => expect(screen.getByText('Connect an agent')).toBeTruthy());
  });

  it('stays out of the way once an agent is connected', () => {
    harness().providerReady = true;
    open(row({ fixable: true }));
    expect(screen.queryByText('Connect an agent')).toBeNull();
  });

  it('does not ask on a closed PR, where an agent has nothing to push to', () => {
    harness().providerReady = false;
    open(row({ fixable: true, state: 'closed' }));
    expect(screen.queryByText('Connect an agent')).toBeNull();
  });
});
