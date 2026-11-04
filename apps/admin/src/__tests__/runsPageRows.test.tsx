import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminRunIndex, AdminRunRow } from '@talyn/shared';

/**
 * What each kind of row says on the Runs page.
 *
 * On 2026-11-03 every session box read "orphan", with no host and no owner,
 * and every sleeping box read "wedged?". These pin what a session, a thread, a
 * superseded box, an orphan and a sleeping box each show, and where each row
 * opens.
 */

const runs = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    admin: {
      fleet: {
        runs: (...a: unknown[]) => runs(...a),
        hosts: () => Promise.resolve([{ name: 'hetzner-64' }, { name: 'scaleway-1' }]),
      },
    },
  },
}));
vi.mock('../components/auth/AdminGate', () => ({
  AdminGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAccess: () => ({ admin: true, email: 'op@talyn.dev', capabilities: [] }),
  useCapability: () => false,
}));

const { RunsPage, runLink, canCancel } = await import('../routes/fleet/RunsPage');

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function row(over: Partial<AdminRunRow>): AdminRunRow {
  return {
    runId: 'talyn-x',
    host: 'hetzner-64',
    taskId: null,
    workspaceId: 'ws1',
    ownerEmail: 'owner@example.test',
    repo: 'posthog/posthog',
    kind: 'task',
    claim: 'active',
    supersededReason: null,
    title: null,
    workbenchId: null,
    workspaceName: 'PostHog',
    sandboxStatus: 'busy',
    sleep: null,
    vcpuCount: 4,
    diskMib: null,
    sandboxSize: null,
    status: 'running',
    phase: 'agent',
    adopted: false,
    slot: 1,
    goldenLayer: 'repo',
    createdAt: hoursAgo(5),
    startedAt: hoursAgo(5),
    endedAt: null,
    deadline: null,
    lastHeartbeat: hoursAgo(4),
    lastActivity: hoursAgo(4),
    costUsd: 1.5,
    memUsedMib: null,
    memMib: 12288,
    prUrl: null,
    error: null,
    orphan: false,
    selfTest: false,
    ...over,
  };
}

const SESSION = row({
  runId: 'talyn-wb-0b1a719c5cb94c14901f5b98-r5--3542ee',
  kind: 'session',
  workbenchId: '0b1a719c-5cb9-4c14-901f-5b9812345678',
  title: 'Fix the login flow',
  sandboxStatus: 'suspended',
  sandboxSize: 'large',
  sleep: { kind: 'storage', since: hoursAgo(2), suspendKind: 'rootfs', uploadError: null },
});
const SUPERSEDED = row({
  runId: 'talyn-wb-0b1a719c5cb94c14901f5b98-r4--3542ee',
  kind: 'session',
  claim: 'superseded',
  supersededReason: 'The session moved to talyn-wb-0b1a719c5cb94c14901f5b98-r5',
  workbenchId: '0b1a719c-5cb9-4c14-901f-5b9812345678',
  title: 'Fix the login flow',
  sandboxStatus: 'suspended',
  host: 'scaleway-1',
});
const ORPHAN = row({ runId: 'talyn-wb-ffffffffffffffffffffffff--3542ee', kind: 'session', claim: 'orphan', orphan: true, ownerEmail: null, sandboxStatus: 'idle', lastActivity: hoursAgo(0) });
const WEDGED_TASK = row({ runId: 'talyn-325792e2', taskId: '325792e2', title: 'Get #1 mergeable' });

function page(items: AdminRunRow[]): AdminRunIndex {
  return { items, nextCursor: null, degraded: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  runs.mockResolvedValue(page([SESSION, SUPERSEDED, ORPHAN, WEDGED_TASK]));
});
afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/fleet/runs']}>
      <RunsPage />
    </MemoryRouter>
  );
}

function rowFor(text: string): HTMLElement {
  const cell = screen.getAllByText(text)[0]!;
  return cell.closest('tr') as HTMLElement;
}

describe('Runs page rows', () => {
  it('shows a sleeping session as asleep in storage, with its title, owner, host and size, and not wedged', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Fix the login flow').length).toBeGreaterThan(0));
    const tr = rowFor(SESSION.runId);
    const text = tr.textContent ?? '';
    expect(text).toContain('session');
    expect(text).toContain('asleep · in storage');
    expect(text).toContain('slept 2h');
    expect(text).toContain('hetzner-64');
    expect(text).toContain('owner@example.test');
    expect(text).toContain('Large · 12 GB');
    expect(text).not.toContain('wedged?');
    expect(text).not.toContain('orphan');
  });

  it('marks a superseded box and says why', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('superseded').length).toBeGreaterThan(0));
    const pill = within(rowFor(SUPERSEDED.runId)).getByText('superseded');
    expect(pill.getAttribute('title')).toContain('moved to');
  });

  it('marks an orphan and tints its row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('orphan').length).toBeGreaterThan(0));
    expect(rowFor(ORPHAN.runId).className).toContain('bg-destructive');
  });

  it('keeps "wedged?" for an awake box that has been silent', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('wedged?').length).toBe(1));
    expect(rowFor(WEDGED_TASK.runId).textContent).toContain('wedged?');
  });

  it('counts each category in the header', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/2 asleep/)).toBeTruthy());
    expect(screen.getByText(/2 running/)).toBeTruthy();
    expect(screen.getByText(/1 superseded/)).toBeTruthy();
    expect(screen.getByText(/1 orphaned/)).toBeTruthy();
    expect(screen.getByText(/1 possibly wedged/)).toBeTruthy();
  });

  it('offers the registry hosts in the host filter', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('option', { name: 'scaleway-1' })).toBeTruthy());
  });
});

describe('runLink', () => {
  it.each([
    ['a session box', SESSION, '/product/sessions/0b1a719c-5cb9-4c14-901f-5b9812345678'],
    ['a thread box', { ...SESSION, kind: 'thread' as const }, '/product/sessions/0b1a719c-5cb9-4c14-901f-5b9812345678'],
    ['a task box', WEDGED_TASK, '/fleet/runs/talyn-325792e2?host=hetzner-64'],
    ['an orphan with no host', { ...ORPHAN, host: null }, `/fleet/runs/${ORPHAN.runId}`],
  ])('opens %s', (_label, r, expected) => {
    expect(runLink(r)).toBe(expected);
  });
});

describe('canCancel', () => {
  it.each([
    ['a running task', WEDGED_TASK, true],
    ["a session's current box", { ...SESSION, sandboxStatus: 'idle', sleep: null }, false],
    ["a thread's current box", { ...SESSION, kind: 'thread' as const }, false],
    ['a superseded session box', SUPERSEDED, true],
    ['an orphan', ORPHAN, true],
    ['a finished task', { ...WEDGED_TASK, status: 'completed' as const }, false],
    ['a task row with no status', { ...WEDGED_TASK, status: null }, false],
  ])('for %s: %s', (_label, r, expected) => {
    expect(canCancel(r)).toBe(expected);
  });
});
