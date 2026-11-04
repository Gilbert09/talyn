import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type {
  SandboxStartInfo,
  SandboxStartLayer,
  SandboxStatusAction,
  SandboxWorkSafety,
  Workbench,
  WorkbenchChat,
  WorkbenchSandboxStatus,
} from '@talyn/shared';
import {
  SandboxStatusChip,
  SandboxStatusPanel,
  formatAgo,
  formatSpan,
  sandboxChipState,
  sandboxStatusNeedsAttention,
  useSandboxStatus,
} from '../components/workbench/SandboxStatusPanel';
import { useWorkbenchStore } from '../stores/workbenches';

const sandboxStatus = vi.fn();
const wake = vi.fn();
const retry = vi.fn();
const resize = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    workbenches: {
      sandboxStatus: (...a: unknown[]) => sandboxStatus(...a),
      wake: (...a: unknown[]) => wake(...a),
      retry: (...a: unknown[]) => retry(...a),
      resize: (...a: unknown[]) => resize(...a),
    },
  },
}));

const WB = { id: 'wb1', runtime: 'sandbox', status: 'ready', sandboxState: 'running', updatedAt: '2026-11-03T10:00:00Z' } as Workbench;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function work(over: Partial<SandboxWorkSafety> = {}): SandboxWorkSafety {
  return {
    savedAt: null,
    savedBytes: null,
    checkedAt: null,
    unpushedCommits: null,
    uncommitted: null,
    committed: null,
    branchPushed: null,
    failures: 0,
    lastFailureAt: null,
    lastFailure: null,
    warning: null,
    warningLevel: null,
    ...over,
  };
}

function status(over: Partial<WorkbenchSandboxStatus> = {}): WorkbenchSandboxStatus {
  return {
    workbenchId: 'wb1',
    checkedAt: new Date().toISOString(),
    state: 'running',
    headline: 'The agent is working.',
    detail: null,
    sleepsAt: null,
    since: null,
    replacementStarting: false,
    fleet: { known: true, status: 'running', phase: null, error: null },
    host: 'hetzner-64',
    size: { key: 'standard', label: 'Standard · 4 GB, 4 vCPU', memMib: 4096, vcpus: 4 },
    activity: [],
    work: work(),
    problem: null,
    actions: [],
    ...over,
  };
}

const action = (kind: SandboxStatusAction['kind'], label: string, confirm: string | null = null): SandboxStatusAction => ({
  kind,
  label,
  confirm,
});

function renderPanel(s: WorkbenchSandboxStatus | null, extra: Partial<React.ComponentProps<typeof SandboxStatusPanel>> = {}) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<SandboxStatusPanel workbench={WB} status={s} error={null} onRefresh={onRefresh} onClose={onClose} {...extra} />);
  return { onRefresh, onClose };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('formatSpan and formatAgo', () => {
  it.each<[number, string]>([
    [10_000, 'less than a minute'],
    [12 * MIN, '12 min'],
    [2 * HOUR + 5 * MIN, '2 h'],
    [50 * HOUR, '2 d'],
    [-5_000, 'less than a minute'],
  ])('formatSpan(%i) is %s', (ms, text) => {
    expect(formatSpan(ms)).toBe(text);
  });

  it.each<[number, string]>([
    [20_000, 'just now'],
    [12 * MIN, '12 min ago'],
    [3 * HOUR, '3 h ago'],
  ])('formatAgo for %i ms is %s', (ms, text) => {
    expect(formatAgo(ago(ms))).toBe(text);
  });
});

describe('sandboxStatusNeedsAttention', () => {
  it.each<[string, WorkbenchSandboxStatus | null, 'warn' | 'danger' | null]>([
    ['no status', null, null],
    ['a healthy box', status(), null],
    ['failed', status({ state: 'failed' }), 'danger'],
    ['lost', status({ state: 'lost' }), 'warn'],
    ['a warn warning', status({ work: work({ warning: 'Old work', warningLevel: 'warn' }) }), 'warn'],
    ['a danger warning', status({ work: work({ warning: 'At risk', warningLevel: 'danger' }) }), 'danger'],
    ['a thread with no work', status({ work: null }), null],
  ])('%s', (_name, s, expected) => {
    expect(sandboxStatusNeedsAttention(s)).toBe(expected);
  });
});

describe('SandboxStatusPanel', () => {
  it.each<[string, Partial<WorkbenchSandboxStatus>, string, RegExp | null]>([
    ['idle with sleep', { state: 'idle', headline: 'Idle. It goes to sleep in 12 minutes.', since: ago(2 * HOUR), sleepsAt: ago(-12 * MIN) }, 'Idle. It goes to sleep in 12 minutes.', /^Up for 2 h$/],
    ['running', { state: 'running', headline: 'The agent is working.', since: ago(30 * MIN) }, 'The agent is working.', /^Up for 30 min$/],
    ['asleep', { state: 'asleep', headline: 'Asleep. It wakes in seconds.', since: ago(3 * HOUR) }, 'Asleep. It wakes in seconds.', /^Asleep for 3 h$/],
    ['hibernated', { state: 'hibernated', headline: 'Hibernated. Waking takes a few minutes.', since: ago(26 * HOUR) }, 'Hibernated. Waking takes a few minutes.', /^Asleep for 1 d$/],
    ['lost with a replacement', { state: 'lost', headline: 'The box was lost. Talyn is starting a new one.', replacementStarting: true, since: ago(HOUR) }, 'The box was lost. Talyn is starting a new one.', null],
    ['failed', { state: 'failed', headline: 'The session could not start.', detail: 'The setup script failed.' }, 'The session could not start.', null],
  ])('%s shows its headline', (_name, over, headline, since) => {
    renderPanel(status(over));
    expect(screen.getByTestId('sandbox-headline')).toHaveTextContent(headline);
    expect(screen.getByTestId('sandbox-status-panel')).toHaveAttribute('data-state', over.state);
    if (since) expect(screen.getByText(since)).toBeInTheDocument();
    else expect(screen.queryByText(/^(Up|Asleep) for/)).not.toBeInTheDocument();
  });

  it('shows the detail, host and size', () => {
    renderPanel(status({ detail: 'The setup script failed.' }));
    expect(screen.getByText('The setup script failed.')).toBeInTheDocument();
    expect(screen.getByText('hetzner-64')).toBeInTheDocument();
    expect(screen.getByText('Size: Standard · 4 GB, 4 vCPU')).toBeInTheDocument();
  });

  it('shows a loading line and then an error when there is no status', () => {
    const { rerender } = render(<SandboxStatusPanel workbench={WB} status={null} error={null} onRefresh={vi.fn()} />);
    expect(screen.getByText('Reading the sandbox status')).toBeInTheDocument();
    rerender(<SandboxStatusPanel workbench={WB} status={null} error="Not found" onRefresh={vi.fn()} />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });

  it.each<[string, Partial<SandboxWorkSafety>, 'warn' | 'danger' | null]>([
    ['warn', { warning: 'The work is not saved for 40 minutes.', warningLevel: 'warn' }, 'warn'],
    ['danger', { warning: 'The box is lost and the work is not saved.', warningLevel: 'danger' }, 'danger'],
    ['no warning', { warning: null, warningLevel: null }, null],
  ])('the work warning banner for %s', (_name, over, level) => {
    renderPanel(status({ work: work(over) }));
    const banner = screen.queryByTestId('sandbox-work-warning');
    if (!level) {
      expect(banner).not.toBeInTheDocument();
      return;
    }
    expect(banner).toHaveAttribute('data-level', level);
    expect(banner).toHaveTextContent(over.warning!);
    expect(banner?.className).toContain(level === 'danger' ? 'text-destructive' : 'text-amber-700');
  });

  it.each<[string, Partial<SandboxWorkSafety>, string[]]>([
    ['nothing saved', {}, ['No checkpoint yet']],
    ['a checkpoint and a newer check', { savedAt: ago(12 * MIN), checkedAt: ago(2 * MIN) }, ['Last checkpoint 12 min ago', 'Checked 2 min ago: no new changes']],
    ['uncommitted files and unpushed commits', { uncommitted: { files: 3, added: 20, removed: 4 }, unpushedCommits: 2 }, ['Not committed: 3 files, +20 -4', '2 commits not on GitHub']],
    ['one unpushed commit', { unpushedCommits: 1 }, ['1 commit not on GitHub']],
    ['a pushed branch with clean files', { uncommitted: { files: 0, added: 0, removed: 0 }, unpushedCommits: 0, branchPushed: true }, ['All changes are committed', 'Branch is pushed']],
    ['failed saves', { failures: 2, lastFailure: 'The upload timed out', lastFailureAt: ago(5 * MIN) }, ['The last 2 saves failed (5 min ago): The upload timed out']],
  ])('work safety: %s', (_name, over, lines) => {
    renderPanel(status({ work: work(over) }));
    const list = screen.getByTestId('sandbox-work');
    for (const line of lines) expect(list).toHaveTextContent(line);
  });

  it('hides the checked line when it is older than the checkpoint', () => {
    renderPanel(status({ work: work({ savedAt: ago(2 * MIN), checkedAt: ago(12 * MIN) }) }));
    expect(screen.queryByText(/no new changes/)).not.toBeInTheDocument();
  });

  it('has no work section for a thread', () => {
    renderPanel(status({ work: null }));
    expect(screen.queryByTestId('sandbox-work')).not.toBeInTheDocument();
  });

  it('lists the activity', () => {
    renderPanel(
      status({
        activity: [
          { kind: 'turn', text: 'The agent is working', since: null, chatId: 'c1' },
          { kind: 'script', text: 'The run script is running', since: null, name: 'run' },
        ],
      })
    );
    expect(screen.getByText('The agent is working')).toBeInTheDocument();
    expect(screen.getByText('The run script is running')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is running.')).not.toBeInTheDocument();
  });

  it('says nothing is running when the activity is empty', () => {
    renderPanel(status({ activity: [] }));
    expect(screen.getByText('Nothing is running.')).toBeInTheDocument();
  });

  it.each<[string, Partial<WorkbenchSandboxStatus['fleet']>, boolean]>([
    ['the fleet did not answer', { known: false, error: 'timeout' }, true],
    ['the fleet was not asked', { known: false, error: null }, false],
    ['the fleet answered', { known: true, error: null }, false],
  ])('the fleet line when %s', (_name, fleet, shown) => {
    renderPanel(status({ fleet: { known: true, status: null, phase: null, error: null, ...fleet } }));
    expect(Boolean(screen.queryByText('The fleet did not answer. Some facts are unknown.'))).toBe(shown);
  });

  it('shows the last problem', () => {
    renderPanel(status({ problem: { text: 'The box was lost on its host.', at: ago(4 * MIN) } }));
    expect(screen.getByTestId('sandbox-problem')).toHaveTextContent('The box was lost on its host. · 4 min ago');
  });

  it.each<[string, SandboxStatusAction[], string[], string[]]>([
    ['no actions', [], [], ['Wake', 'Retry', 'Change size', 'Show setup output']],
    ['wake only', [action('wake', 'Wake')], ['Wake'], ['Retry', 'Change size', 'Show setup output']],
    [
      'retry and setup output',
      [action('retry', 'Retry'), action('show_setup_output', 'Show setup output')],
      ['Retry', 'Show setup output'],
      ['Wake', 'Change size'],
    ],
    ['resize', [action('resize', 'Change size')], ['Change size'], ['Wake', 'Retry']],
  ])('actions: %s', (_name, actions, shown, hidden) => {
    renderPanel(status({ actions }));
    for (const label of shown) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    for (const label of hidden) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it('calls wake at once when confirm is null, then refreshes', async () => {
    wake.mockResolvedValue({ status: 'resuming' });
    const { onRefresh } = renderPanel(status({ state: 'asleep', actions: [action('wake', 'Wake')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(wake).toHaveBeenCalledWith('wb1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks before retry when confirm is set, and calls it only after Confirm', async () => {
    retry.mockResolvedValue({ ...WB, status: 'provisioning' });
    const upsert = vi.spyOn(useWorkbenchStore.getState(), 'upsertWorkbench');
    const onHoldOpen = vi.fn();
    const { onRefresh } = renderPanel(
      status({ state: 'failed', actions: [action('retry', 'Retry', 'Retry starts a new box. Work that is not saved is lost.')] }),
      { onHoldOpen }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText('Retry starts a new box. Work that is not saved is lost.')).toBeInTheDocument();
    expect(onHoldOpen).toHaveBeenLastCalledWith(true);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!);
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(retry).toHaveBeenCalledWith('wb1');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'provisioning' }));
    expect(onHoldOpen).toHaveBeenLastCalledWith(false);
    upsert.mockRestore();
  });

  it('does not call retry when the confirmation is cancelled', () => {
    renderPanel(status({ state: 'failed', actions: [action('retry', 'Retry', 'Are you sure?')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(retry).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows an action error in the panel', async () => {
    wake.mockRejectedValue(new Error('The fleet is full'));
    renderPanel(status({ actions: [action('wake', 'Wake')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake' }));
    expect(await screen.findByText('The fleet is full')).toBeInTheDocument();
  });

  it('opens a size picker with the current size marked, then resizes', async () => {
    resize.mockResolvedValue({ outcome: 'after_turn', size: 'large', rememberedForRepository: false, continued: false });
    const { onRefresh } = renderPanel(status({ actions: [action('resize', 'Change size')] }));
    expect(screen.queryByTestId('sandbox-size-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change size' }));
    const current = screen.getByRole('button', { name: /Standard · 4 GB/ });
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent('Current');
    fireEvent.click(screen.getByRole('button', { name: /Large · 12 GB/ }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(resize).toHaveBeenCalledWith('wb1', { size: 'large' });
    expect(screen.getByText('The move starts when the current turn ends.')).toBeInTheDocument();
  });

  it('asks before a resize with a confirmation', () => {
    renderPanel(status({ actions: [action('resize', 'Change size', 'The box restarts.')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Change size' }));
    fireEvent.click(screen.getByRole('button', { name: /Medium · 8 GB/ }));
    expect(resize).not.toHaveBeenCalled();
    expect(screen.getByText('The box restarts.')).toBeInTheDocument();
  });

  it('opens the setup output tab and closes the panel', () => {
    const { onClose } = renderPanel(status({ actions: [action('show_setup_output', 'Show setup output')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Show setup output' }));
    expect(useWorkbenchStore.getState().terminalTab).toBe('setup');
    expect(useWorkbenchStore.getState().terminalOpen).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('How this box started', () => {
  function start(over: Partial<SandboxStartInfo> = {}): SandboxStartInfo {
    return {
      image: {
        layer: 'repo',
        label: 'The shared image for this repository',
        detail: 'The image has the repository and its own setup. The box ran the Setup list steps itself.',
        repoCommit: 'abc123def4567890',
        builtAt: null,
        userLayerPending: true,
        repoLayerPending: false,
        pending: 'The fleet is building a new image with the Setup list. A new box uses it when it is ready.',
        stale: false,
      },
      timeline: {
        sandboxId: 'box',
        cause: 'new',
        requestedAt: ago(40 * MIN),
        totalMs: 380_000,
        capacityWaitMs: 90_000,
        steps: [
          { kind: 'capacity_wait', label: 'Waited for a free sandbox', durationMs: 90_000, ok: null },
          { kind: 'box', label: 'Box started', durationMs: 20_000, ok: null },
          { kind: 'checkout', label: 'Checked out the branch', durationMs: 4_000, ok: null },
          { kind: 'repository_setup', label: 'Repository setup', durationMs: 6_000, ok: true },
          { kind: 'box_steps', label: 'Setup list steps', durationMs: 312_000, ok: false },
          { kind: 'setup_step', label: 'Install sqlx', durationMs: 12_000, ok: true },
          { kind: 'setup_step', label: 'Start the database', durationMs: 300_000, ok: false, detail: 'timed out' },
          { kind: 'ready', label: 'Ready', durationMs: 380_000, ok: null },
        ],
      },
      lastWake: { at: ago(10 * MIN), durationMs: 130_000, from: 'storage', ok: true, text: 'Restored from storage in 2m 10s.' },
      recent: [
        { at: ago(40 * MIN), totalMs: 380_000, layer: 'repo', thisSession: true },
        { at: ago(3 * HOUR), totalMs: 48_000, layer: 'base', thisSession: false },
      ],
      medianMs: 48_000,
      comparison: 'This start took 6m 20s. The median start for this repository is 48s.',
      slow: true,
      note: null,
      ...over,
    };
  }

  it('shows the image, the timeline with its failed steps, the last wake, the slow start and the recent starts', () => {
    renderPanel(status({ start: start() }));
    expect(screen.getByText('How this box started')).toBeInTheDocument();
    const image = screen.getByTestId('sandbox-start-image');
    expect(image).toHaveAttribute('data-layer', 'repo');
    expect(image).toHaveTextContent('Image: The shared image for this repository');
    expect(image).toHaveTextContent('Commit abc123d');
    expect(screen.getByTestId('sandbox-start-pending')).toHaveTextContent('The fleet is building a new image');

    const rows = screen.getByTestId('sandbox-start-timeline').querySelectorAll('li');
    expect(Array.from(rows).map((r) => r.getAttribute('data-kind'))).toEqual([
      'capacity_wait', 'box', 'checkout', 'repository_setup', 'box_steps', 'setup_step', 'setup_step', 'ready',
    ]);
    expect(rows[0]).toHaveTextContent('Waited for a free sandbox1m 30s');
    expect(rows[5]).toHaveAttribute('data-ok', 'true');
    expect(rows[6]).toHaveAttribute('data-ok', 'false');
    expect(rows[6]).toHaveTextContent('Start the database(timed out)5m 0s');
    expect(rows[6]).toHaveClass('text-destructive');
    expect(rows[7]).toHaveTextContent('Ready6m 20s');

    const comparison = screen.getByTestId('sandbox-start-comparison');
    expect(comparison).toHaveAttribute('data-slow', 'true');
    expect(comparison).toHaveTextContent('This start took 6m 20s. The median start for this repository is 48s.');
    expect(screen.getByTestId('sandbox-start-wake')).toHaveTextContent('Restored from storage in 2m 10s. · 10 min ago');
    const recent = screen.getByTestId('sandbox-start-recent');
    expect(recent).toHaveTextContent('40 min ago · repository image · this session6m 20s');
    expect(recent).toHaveTextContent('3 h ago · base image48s');
  });

  it.each<[SandboxStartLayer | null, string]>([
    ['user', 'Your image for this repository'],
    ['repo', 'The shared image for this repository'],
    ['legacy', 'An older image for this repository'],
    ['base', 'The base image, with a full clone'],
    [null, 'Not known'],
  ])('names the %s image', (layer, label) => {
    renderPanel(status({ start: start({ image: { ...start().image!, layer, label, pending: null, repoCommit: null } }) }));
    expect(screen.getByTestId('sandbox-start-image')).toHaveAttribute('data-layer', layer ?? 'unknown');
    expect(screen.getByTestId('sandbox-start-image')).toHaveTextContent(`Image: ${label}`);
    expect(screen.queryByTestId('sandbox-start-pending')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Commit/)).not.toBeInTheDocument();
  });

  it('shows a normal start without the warning, and a build time when the fleet gives one', () => {
    renderPanel(status({
      start: start({
        slow: false,
        comparison: 'This start took 50s. The median start for this repository is 48s.',
        image: { ...start().image!, builtAt: ago(2 * HOUR), stale: true },
      }),
    }));
    expect(screen.getByTestId('sandbox-start-comparison')).toHaveAttribute('data-slow', 'false');
    expect(screen.getByTestId('sandbox-start-image')).toHaveTextContent('Commit abc123d · Built 2 h ago');
    expect(screen.getByText('A newer image exists. A new box boots it.')).toBeInTheDocument();
  });

  it('says what Talyn does not know, and leaves out what is empty', () => {
    renderPanel(status({
      start: start({
        image: null, timeline: null, lastWake: null, recent: [], medianMs: null, comparison: null, slow: false,
        note: 'Talyn has no start times for this box. A box that started before Talyn kept them has none.',
      }),
    }));
    expect(screen.getByTestId('sandbox-start-note')).toHaveTextContent('Talyn has no start times for this box.');
    for (const id of ['sandbox-start-image', 'sandbox-start-timeline', 'sandbox-start-wake', 'sandbox-start-recent', 'sandbox-start-comparison']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });

  it('shows a row that was not measured, and a failed wake', () => {
    renderPanel(status({
      start: start({
        timeline: { ...start().timeline!, steps: [{ kind: 'box_steps', label: 'Setup list steps', durationMs: null, ok: null }] },
        lastWake: { at: ago(MIN), durationMs: 300_000, from: 'storage', ok: false, text: 'A restore from storage failed after 5m 0s.' },
      }),
    }));
    expect(screen.getByTestId('sandbox-start-timeline')).toHaveTextContent('Setup list stepsnot measured');
    expect(screen.getByTestId('sandbox-start-wake')).toHaveClass('text-destructive');
  });

  it.each<[string, WorkbenchSandboxStatus]>([
    ['an older backend that sends no start', status()],
    ['a start with nothing in it', status({ start: start({ image: null, timeline: null, lastWake: null, recent: [], comparison: null, note: null }) })],
    ['a null start', status({ start: null })],
  ])('has no section for %s', (_name, s) => {
    renderPanel(s);
    expect(screen.getByTestId('sandbox-headline')).toBeInTheDocument();
    expect(screen.queryByText('How this box started')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-start')).not.toBeInTheDocument();
  });
});

describe('sandboxChipState', () => {
  const row = (over: Partial<Workbench> = {}) => ({ status: 'ready', sandboxState: 'running', ...over }) as Workbench;
  it.each<[string, Workbench, WorkbenchChat['status'] | null, WorkbenchSandboxStatus | null, string | null, string | null]>([
    ['status running', row(), null, status({ state: 'running' }), 'Running', 'running'],
    ['status idle with a sleep time', row(), 'idle', status({ state: 'idle', sleepsAt: ago(-6 * MIN + 5_000) }), 'Idle · sleeps in 6m', 'idle'],
    ['status idle in hours', row(), 'idle', status({ state: 'idle', sleepsAt: ago(-2 * HOUR) }), 'Idle · sleeps in 2h', 'idle'],
    ['status idle with no sleep time', row(), 'idle', status({ state: 'idle' }), 'Idle', 'idle'],
    ['status idle but a turn runs', row(), 'running', status({ state: 'idle' }), 'Running', 'running'],
    ['status asleep', row(), null, status({ state: 'asleep' }), 'Asleep', 'asleep'],
    ['status hibernated', row(), null, status({ state: 'hibernated' }), 'In storage', 'asleep'],
    ['status waking', row(), null, status({ state: 'waking' }), 'Waking', 'busy'],
    ['status moving', row(), null, status({ state: 'moving' }), 'Moving', 'busy'],
    ['status starting', row(), null, status({ state: 'starting' }), 'Starting', 'busy'],
    ['status lost', row(), null, status({ state: 'lost' }), 'Lost', 'lost'],
    ['status failed', row(), null, status({ state: 'failed' }), 'Failed', 'failed'],
    ['no status, row running, chat idle', row(), 'idle', null, 'Idle', 'idle'],
    ['no status, row running, chat running', row(), 'running', null, 'Running', 'running'],
    ['no status, row suspended', row({ sandboxState: 'suspended' }), null, null, 'Asleep', 'asleep'],
    ['no status, row creating', row({ sandboxState: 'creating' }), null, null, 'Starting', 'busy'],
    ['no status, provisioning', row({ status: 'provisioning', sandboxState: 'none' }), null, null, 'Starting', 'busy'],
    ['no status, moving', row({ status: 'moving' }), null, null, 'Moving', 'busy'],
    ['no status, row lost', row({ sandboxState: 'lost' }), null, null, 'Lost', 'lost'],
    ['no status, row error', row({ sandboxState: 'error' }), null, null, 'Failed', 'failed'],
    ['no status, no sandbox', row({ sandboxState: 'none' }), null, null, null, null],
    ['status unknown falls back to the row', row({ sandboxState: 'suspended' }), null, status({ state: 'unknown' }), 'Asleep', 'asleep'],
  ])('%s', (_name, wb, chatStatus, s, word, tone) => {
    const out = sandboxChipState(wb, chatStatus, s);
    expect(out?.word ?? null).toBe(word);
    expect(out?.tone ?? null).toBe(tone);
  });
});

describe('SandboxStatusChip', () => {
  beforeEach(() => useWorkbenchStore.setState({ sideTab: 'files', rightPanelOpen: false }));

  it('shares a status update across two hook instances', async () => {
    sandboxStatus.mockResolvedValue(status());
    const first = renderHook(() => useSandboxStatus(WB, false));
    const second = renderHook(() => useSandboxStatus(WB, false));
    await waitFor(() => expect(first.result.current.status?.state).toBe('running'));
    expect(second.result.current.status?.state).toBe('running');
    expect(sandboxStatus).toHaveBeenCalledTimes(1);

    sandboxStatus.mockResolvedValue(status({ state: 'asleep' }));
    await act(async () => { await second.result.current.refresh(); });
    expect(first.result.current.status?.state).toBe('asleep');
    expect(second.result.current.status?.state).toBe('asleep');
    expect(sandboxStatus).toHaveBeenCalledTimes(2);
  });

  it('updates the chip when another hook refreshes', async () => {
    sandboxStatus.mockResolvedValue(status());
    render(<SandboxStatusChip workbench={WB} />);
    const other = renderHook(() => useSandboxStatus(WB, false));
    expect(await screen.findByTestId('sandbox-chip-word')).toHaveTextContent('Running');
    await waitFor(() => expect(other.result.current.status?.state).toBe('running'));

    sandboxStatus.mockResolvedValue(status({ state: 'waking' }));
    await act(async () => { await other.result.current.refresh(); });
    expect(screen.getByTestId('sandbox-chip-word')).toHaveTextContent('Waking');
  });

  it('refreshes the chip every 30 s', async () => {
    vi.useFakeTimers();
    sandboxStatus.mockResolvedValue(status());
    render(<SandboxStatusChip workbench={WB} />);
    await act(async () => {});
    expect(sandboxStatus).toHaveBeenCalledTimes(1);

    sandboxStatus.mockResolvedValue(status({ state: 'asleep' }));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(sandboxStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('sandbox-chip-word')).toHaveTextContent('Asleep');
  });

  it('refreshes the chip when the window gains focus', async () => {
    sandboxStatus.mockResolvedValue(status());
    render(<SandboxStatusChip workbench={WB} />);
    expect(await screen.findByTestId('sandbox-chip-word')).toHaveTextContent('Running');

    sandboxStatus.mockResolvedValue(status({ state: 'asleep' }));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByTestId('sandbox-chip-word')).toHaveTextContent('Asleep'));
  });

  it.each<[string, WorkbenchSandboxStatus, 'warn' | 'danger' | null]>([
    ['healthy', status(), null],
    ['a work warning', status({ work: work({ warning: 'Not saved', warningLevel: 'warn' }) }), 'warn'],
    ['failed', status({ state: 'failed' }), 'danger'],
  ])('shows the warning dot for %s', async (_name, s, level) => {
    sandboxStatus.mockResolvedValue(s);
    render(<SandboxStatusChip workbench={WB} />);
    await waitFor(() => expect(sandboxStatus).toHaveBeenCalledWith('wb1'));
    if (level) expect(await screen.findByTestId('sandbox-chip-warning')).toHaveAttribute('data-level', level);
    else {
      await waitFor(() => expect(sandboxStatus).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('sandbox-chip-warning')).not.toBeInTheDocument();
    }
  });

  it('shows the row state at once, then the status word and dot', async () => {
    sandboxStatus.mockResolvedValue(status({ state: 'asleep' }));
    render(<SandboxStatusChip workbench={WB} chat={{ id: 'c1', status: 'running' } as WorkbenchChat} />);
    expect(screen.getByTestId('sandbox-chip-word')).toHaveTextContent('Running');
    expect(screen.getByTestId('sandbox-chip-dot')).toHaveAttribute('data-tone', 'running');
    await waitFor(() => expect(screen.getByTestId('sandbox-chip-word')).toHaveTextContent('Asleep'));
    expect(screen.getByTestId('sandbox-chip-dot')).toHaveAttribute('data-tone', 'asleep');
  });

  it('has a tooltip and opens the Sandbox tab of the right panel', async () => {
    sandboxStatus.mockResolvedValue(status());
    render(<SandboxStatusChip workbench={WB} />);
    await waitFor(() => expect(sandboxStatus).toHaveBeenCalledTimes(1));
    const chip = await screen.findByRole('button', { name: /Running/ });
    expect(chip).toHaveAttribute('title', 'Sandbox status');
    fireEvent.click(chip);
    expect(useWorkbenchStore.getState().sideTab).toBe('sandbox');
    expect(useWorkbenchStore.getState().rightPanelOpen).toBe(true);
    // Clicking does not poll: the tab does that while it is visible.
    expect(sandboxStatus).toHaveBeenCalledTimes(1);
  });

  it('reads again when the session row changes', async () => {
    sandboxStatus.mockResolvedValue(status());
    const { rerender } = render(<SandboxStatusChip workbench={WB} />);
    await waitFor(() => expect(sandboxStatus).toHaveBeenCalledTimes(1));
    rerender(<SandboxStatusChip workbench={WB} />);
    expect(sandboxStatus).toHaveBeenCalledTimes(1);
    rerender(<SandboxStatusChip workbench={{ ...WB, sandboxState: 'suspended' } as Workbench} />);
    await waitFor(() => expect(sandboxStatus).toHaveBeenCalledTimes(2));
  });
});
