import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AdminPage, AdminSessionDetail, AdminSessionSummary } from '@talyn/shared';

/**
 * The Sessions list and one session's detail.
 */

const list = vi.fn();
const get = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    admin: {
      sessions: { list: (...a: unknown[]) => list(...a), get: (...a: unknown[]) => get(...a) },
      fleet: {
        hosts: () => Promise.resolve([{ name: 'hetzner-64' }]),
      },
    },
  },
}));

const { SessionsPage } = await import('../routes/product/SessionsPage');
const { SessionDetailPage } = await import('../routes/product/SessionDetailPage');

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function summary(over: Partial<AdminSessionSummary> = {}): AdminSessionSummary {
  return {
    id: 'wb-1',
    kind: 'session',
    workspaceId: 'ws1',
    workspaceName: 'PostHog',
    ownerEmail: 'owner@example.test',
    repoFullName: 'posthog/posthog',
    title: 'Fix the login flow',
    name: 'lisbon',
    branch: 'tom/fix-login',
    runtime: 'sandbox',
    agent: 'claude',
    model: null,
    status: 'ready',
    statusMessage: null,
    sandboxState: 'suspended',
    sandboxId: 'talyn-wb-abc-r5',
    fleetHost: 'hetzner-64',
    sandboxSize: 'large',
    source: null,
    pullRequestId: null,
    chatCount: 1,
    runningChats: 0,
    lastActivityAt: ago(5),
    stuckProvisioning: false,
    archivedAt: null,
    createdAt: ago(600),
    updatedAt: ago(5),
    ...over,
  };
}

function detail(over: Partial<AdminSessionDetail> = {}): AdminSessionDetail {
  return {
    ...summary(),
    baseBranch: 'master',
    threadId: null,
    sandboxGeneration: null,
    fleetSandboxId: null,
    moveSandboxId: null,
    keptSandboxIds: [],
    internetAccess: true,
    archivePendingAt: null,
    archiveFailures: 0,
    restoreRequestedAt: null,
    memoryRestorePending: null,
    workCheckpoint: { sha: 'abcdef1234567890', at: ago(30), bytes: 2048 },
    pullRequest: { number: 12, owner: 'posthog', repo: 'posthog', state: 'open', url: 'https://github.com/posthog/posthog/pull/12' },
    slackPermalink: null,
    chats: [
      {
        id: 'chat1',
        title: 'Chat 1',
        agent: 'claude',
        model: null,
        status: 'running',
        statusMessage: null,
        turnCount: 3,
        queuedCount: 2,
        turnStartedAt: ago(2),
        turnHeartbeatAt: ago(0),
        closedAt: null,
        updatedAt: ago(0),
      },
    ],
    turns: [{ chatId: 'chat1', turn: 2, wallMs: 90_000, toolMs: 30_000, modelMs: 60_000, calls: 5, at: ago(10) }],
    events: [{ chatId: 'chat1', seq: 9, turn: 3, type: 'result', subtype: 'success', at: ago(1) }],
    setup: {
      timing: { totalMs: 580_000, repositoryMs: 125_000, learnedMs: 455_000, measuredAt: ago(60), thisSession: true },
      steps: [
        {
          id: 's1',
          kind: 'install',
          phase: 'setup',
          command: 'pnpm install',
          sessionCount: 4,
          live: false,
          disabled: false,
          boxFailureCount: 3,
          boxDisabled: true,
          boxLastFailure: 'exit 1',
          typicalDurationMs: 90_000,
        },
      ],
    },
    sandbox: {
      runId: 'talyn-wb-abc-r5--3542ee',
      host: 'scaleway-1',
      taskId: null,
      workspaceId: 'ws1',
      ownerEmail: 'owner@example.test',
      repo: 'posthog/posthog',
      kind: 'session',
      claim: 'active',
      sandboxStatus: 'suspended',
      sleep: { kind: 'local', since: ago(120), suspendKind: 'memory', uploadError: null },
      status: 'running',
      phase: null,
      adopted: false,
      slot: null,
      goldenLayer: null,
      createdAt: ago(600),
      startedAt: ago(600),
      endedAt: null,
      deadline: null,
      lastHeartbeat: ago(120),
      lastActivity: ago(120),
      costUsd: null,
      memUsedMib: null,
      memMib: 12288,
      vcpuCount: 6,
      diskMib: 40960,
      prUrl: null,
      error: null,
      orphan: false,
      selfTest: false,
    },
    sandboxError: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [summary(), summary({ id: 'wb-2', title: 'Slow start', status: 'provisioning', stuckProvisioning: true })], nextCursor: null } satisfies AdminPage<AdminSessionSummary>);
  get.mockResolvedValue(detail());
});
afterEach(cleanup);

describe('SessionsPage', () => {
  it('lists sessions with their sandbox state, host and owner, and calls out a stuck one', async () => {
    render(
      <MemoryRouter initialEntries={['/product/sessions']}>
        <SessionsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Fix the login flow')).toBeTruthy());
    expect(screen.getAllByText('asleep').length).toBeGreaterThan(0);
    expect(screen.getAllByText('hetzner-64').length).toBeGreaterThan(0);
    expect(screen.getAllByText('owner@example.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('stuck provisioning').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 stuck provisioning/)).toBeTruthy();
  });

  it.each([
    ['/product/sessions', { state: 'live' }],
    ['/product/sessions?state=stuck', { state: 'stuck' }],
    ['/product/sessions?kind=thread&owner=tom&host=hetzner-64&q=login', { state: 'live', kind: 'thread', owner: 'tom', host: 'hetzner-64', q: 'login' }],
  ])('reads %s into the request', async (url, expected) => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <SessionsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/product/sessions/wb-1']}>
      <Routes>
        <Route path="/product/sessions/:sessionId" element={<SessionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionDetailPage', () => {
  it('shows the live box, chats, turns, events, setup and checkpoint', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Fix the login flow')).toBeTruthy());
    const text = document.body.textContent ?? '';
    // The host the fleet named, not the recorded one.
    expect(text).toContain('scaleway-1');
    expect(text).toMatch(/asleep · local/);
    expect(text).toContain('Large · 12 GB');
    expect(text).toContain('Chat 1');
    expect(text).toContain('result/success');
    expect(text).toContain('pnpm install');
    expect(text).toContain('off after failures');
    expect(text).toContain('posthog/posthog#12 (open)');
    expect(text).toContain('abcdef123456');
    expect(text).not.toContain('wedged?');
  });

  it('says why the live read failed instead of showing nothing', async () => {
    get.mockResolvedValue(detail({ sandbox: null, sandboxError: 'fleet unreachable' }));
    renderDetail();
    await waitFor(() => expect(document.body.textContent).toContain('fleet unreachable'));
  });

  it('says when a session is not found', async () => {
    get.mockRejectedValue(new Error('Session not found'));
    renderDetail();
    await waitFor(() => expect(document.body.textContent).toContain('Session not found'));
  });
});
