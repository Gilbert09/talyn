import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SETUP_LIST_LIMITS, type RepositorySetup, type SetupImageStatus, type SetupListStep } from '@talyn/shared';
import { RepoSetup } from '../renderer/components/widgets/RepoSetup';

const setupGet = jest.fn();
const setupPut = jest.fn();
const acceptStep = jest.fn();
const dismissStep = jest.fn();
const retryStep = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  api: {
    repositories: {
      setup: {
        get: (...args: unknown[]) => setupGet(...args),
        put: (...args: unknown[]) => setupPut(...args),
        acceptStep: (...args: unknown[]) => acceptStep(...args),
        dismissStep: (...args: unknown[]) => dismissStep(...args),
        retryStep: (...args: unknown[]) => retryStep(...args),
      },
    },
  },
}));

function step(patch: Partial<SetupListStep> = {}): SetupListStep {
  return {
    id: 's1',
    repositoryId: 'r1',
    position: 0,
    name: 'Install libpq',
    command: 'apt-get install -y libpq-dev',
    kind: 'apt',
    runOn: 'image',
    origin: 'user',
    status: 'active',
    statusReason: null,
    statusChangedAt: null,
    acceptedBy: 'person',
    timeoutSec: null,
    boxOnlyReason: null,
    why: null,
    sourceWorkbenchId: null,
    seenCount: 0,
    sessionCount: 0,
    firstSeenAt: '2026-11-01T10:00:00Z',
    lastSeenAt: '2026-11-01T10:00:00Z',
    confirmedAt: '2026-11-01T10:00:00Z',
    imageAppliedAt: '2026-11-01T10:00:00Z',
    imageFailedAt: null,
    imageFailureReason: null,
    boxFailureCount: 0,
    boxLastFailure: null,
    lastDurationMs: null,
    typicalDurationMs: null,
    measuredBoxes: 0,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    ...patch,
  };
}

function image(patch: Partial<SetupImageStatus> = {}): SetupImageStatus {
  return {
    layer: 'repo',
    repoCommit: 'abcdef1234567890',
    repoLayerPending: false,
    userLayerPending: false,
    repoSetupOk: true,
    appliedStepIds: [],
    checkedAt: '2026-11-02T10:00:00Z',
    workbenchId: 'wb1',
    ...patch,
  };
}

function setup(steps: SetupListStep[], patch: Partial<RepositorySetup> = {}): RepositorySetup {
  return {
    repositoryId: 'r1',
    learningDisabled: false,
    windowDays: 14,
    maxLearnedSteps: 20,
    limits: SETUP_LIST_LIMITS,
    repoSetup: { command: 'npm ci', source: 'talyn', readAt: '2026-11-02T10:00:00Z', runOnBox: 'always' },
    steps,
    hosts: [],
    image: image(),
    lastSetupTiming: null,
    timingHistory: [],
    ...patch,
  };
}

async function renderWith(value: RepositorySetup) {
  setupGet.mockResolvedValue(value);
  const view = render(<RepoSetup repositoryId="r1" />);
  await screen.findByText('Repository setup');
  return view;
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector(`[data-attr="setup-step"][data-step-id="${id}"]`);
  if (!row) throw new Error(`no row ${id}`);
  return row as HTMLElement;
}

beforeEach(() => {
  setupPut.mockImplementation(async (_id: string, input: { hosts?: string[] }) => setup([], input.hosts ? { hosts: input.hosts } : {}));
  acceptStep.mockImplementation(async () => setup([]));
  dismissStep.mockImplementation(async () => setup([]));
  retryStep.mockImplementation(async () => setup([]));
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('row 0', () => {
  test('shows the repository command, its source and the image line', async () => {
    await renderWith(setup([]));
    const row0 = document.querySelector('[data-attr="repo-setup-row0"]') as HTMLElement;
    expect(within(row0).getByText('From the repository')).toBeInTheDocument();
    expect(within(row0).getByText('npm ci')).toBeInTheDocument();
    expect(within(row0).getByText('.talyn/settings.toml')).toBeInTheDocument();
    expect(within(row0).getByText(/Edit it in the repository/)).toBeInTheDocument();
    expect(within(row0).getByText('Built into the shared image at abcdef1')).toBeInTheDocument();
  });

  test.each([
    { name: 'no command, read', repoSetup: { command: null, source: 'none' as const, readAt: '2026-11-02T10:00:00Z', runOnBox: 'always' as const }, text: 'No setup command in the repository' },
    { name: 'never read', repoSetup: { command: null, source: null, readAt: null, runOnBox: 'always' as const }, text: 'Not read yet. A session reads it when its box starts.' },
  ])('command text when $name', async ({ repoSetup, text }) => {
    await renderWith(setup([], { repoSetup }));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  test.each([
    { name: 'no image', value: null, text: 'Image not built yet' },
    { name: 'repo layer pending', value: image({ repoLayerPending: true }), text: 'Image not built yet' },
    { name: 'repository setup failed', value: image({ repoSetupOk: false }), text: 'The repository setup failed in the image build. Each box runs it.' },
    { name: 'user layer', value: image({ layer: 'user', repoCommit: '1234567890' }), text: 'Built into the shared image at 1234567' },
  ])('image line with $name', async ({ value, text }) => {
    await renderWith(setup([], { image: value }));
    expect(screen.getByText(text, { selector: '[data-attr="repo-setup-image-line"]' })).toBeInTheDocument();
  });

  test('no image line on the base layer', async () => {
    await renderWith(setup([], { image: image({ layer: 'base' }) }));
    expect(document.querySelector('[data-attr="repo-setup-image-line"]')).toBeNull();
  });

  test.each(['moved', 'never'] as const)('saves run on each box as %s', async (value) => {
    await renderWith(setup([]));
    fireEvent.change(screen.getByLabelText('Run the repository setup on each box'), { target: { value } });
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', { runOnBox: value }));
  });
});

describe('step state', () => {
  test.each([
    { name: 'active in the image', patch: {}, texts: ['Active'], absent: ['Not in the image yet'] },
    { name: 'active, not in the image yet', patch: { imageAppliedAt: null }, texts: ['Active', 'Not in the image yet'], absent: [] },
    { name: 'active on each box', patch: { runOn: 'box' as const, imageAppliedAt: null }, texts: ['Active'], absent: ['Not in the image yet'] },
    { name: 'suggested', patch: { origin: 'learned' as const, status: 'suggested' as const }, texts: ['Suggested'], absent: ['Active'] },
    { name: 'disabled', patch: { status: 'disabled' as const, statusReason: 'it failed on 2 boxes' }, texts: ['Disabled: it failed on 2 boxes'], absent: [] },
    { name: 'image failed', patch: { imageFailedAt: '2026-11-02T10:00:00Z', imageFailureReason: 'exit 1' }, texts: ['Active', 'Not in the image: exit 1'], absent: ['Not in the image yet'] },
  ])('$name', async ({ patch, texts, absent }) => {
    await renderWith(setup([step(patch)]));
    const row = rowOf('s1');
    for (const text of texts) expect(within(row).getByText(text)).toBeInTheDocument();
    for (const text of absent) expect(within(row).queryByText(text)).toBeNull();
  });

  test.each([
    { name: 'user', patch: { origin: 'user' as const }, text: 'You' },
    { name: 'learned with counts', patch: { origin: 'learned' as const, recentNeededSessions: 4, recentSessions: 9 }, text: 'Talyn learned it from 4 of 9 sessions' },
    { name: 'learned without counts', patch: { origin: 'learned' as const }, text: 'Talyn learned it' },
    { name: 'agent', patch: { origin: 'agent' as const }, text: 'Agent recorded it' },
  ])('origin badge for $name', async ({ patch, text }) => {
    await renderWith(setup([step(patch)]));
    expect(within(rowOf('s1')).getByText(text, { selector: '[data-attr="setup-step-origin"]' })).toBeInTheDocument();
  });

  test('shows the typical time and masks a secret in the command', async () => {
    await renderWith(setup([step({ typicalDurationMs: 65_000, command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://x.test' })]));
    const row = rowOf('s1');
    expect(within(row).getByText('Typical time 1m 5s')).toBeInTheDocument();
    expect(row.textContent).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('row actions', () => {
  test('a suggestion is added or dismissed', async () => {
    await renderWith(setup([step({ origin: 'learned', status: 'suggested' })]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(acceptStep).toHaveBeenCalledWith('r1', 's1'));
    cleanup();
    await renderWith(setup([step({ origin: 'learned', status: 'suggested' })]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismissStep).toHaveBeenCalledWith('r1', 's1'));
  });

  test('a suggestion that Talyn removed says Restore and shows the reason', async () => {
    await renderWith(setup([step({ origin: 'learned', status: 'suggested', statusReason: 'Talyn removed this step on 2026-11-02: few sessions need it.' })]));
    const row = rowOf('s1');
    expect(within(row).getByText(/Talyn removed this step on 2026-11-02/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Add' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(acceptStep).toHaveBeenCalledWith('r1', 's1'));
  });

  test('a disabled step is retried', async () => {
    await renderWith(setup([step({ status: 'disabled', statusReason: 'failed' })]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryStep).toHaveBeenCalledWith('r1', 's1'));
  });

  test('a step that failed in the image is retried or moved to each box', async () => {
    const failed = step({ imageFailedAt: '2026-11-02T10:00:00Z', imageFailureReason: 'exit 1', timeoutSec: 120 });
    await renderWith(setup([failed]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryStep).toHaveBeenCalledWith('r1', 's1'));
    cleanup();
    await renderWith(setup([failed]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Run on each box instead' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', { steps: [{ id: 's1', name: 'Install libpq', runOn: 'box', timeoutSec: 120 }] }));
  });

  test('dismissed steps are in a closed group and can be restored', async () => {
    await renderWith(setup([step(), step({ id: 's2', name: 'Old', origin: 'learned', status: 'dismissed' })]));
    expect(document.querySelector('[data-step-id="s2"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismissed (1)' }));
    fireEvent.click(within(rowOf('s2')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(acceptStep).toHaveBeenCalledWith('r1', 's2'));
  });

  test('a person removes their own step with a PUT that leaves it out', async () => {
    await renderWith(setup([step(), step({ id: 's2', name: 'Two', position: 1 })]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', { steps: [{ id: 's2', name: 'Two', runOn: 'image', timeoutSec: null }] }));
  });

  test('a learned step has no edit or remove', async () => {
    await renderWith(setup([step({ origin: 'learned' })]));
    expect(within(rowOf('s1')).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(rowOf('s1')).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  test('a person edits their own step', async () => {
    await renderWith(setup([step()]));
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'apt-get install -y libpq-dev postgresql-client' } });
    fireEvent.change(screen.getByLabelText('Step time limit in seconds'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save step' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', {
      steps: [{ id: 's1', name: 'Install libpq', runOn: 'image', timeoutSec: 90, command: 'apt-get install -y libpq-dev postgresql-client' }],
    }));
  });
});

describe('runs select', () => {
  test.each(['box', 'both'] as const)('changing to %s sends the whole list with the new place', async (runOn) => {
    await renderWith(setup([step(), step({ id: 's2', name: 'Two', origin: 'learned', timeoutSec: 60 })]));
    fireEvent.change(within(rowOf('s2')).getByLabelText('Where step Two runs'), { target: { value: runOn } });
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', {
      steps: [
        { id: 's1', name: 'Install libpq', runOn: 'image', timeoutSec: null },
        { id: 's2', name: 'Two', runOn, timeoutSec: 60 },
      ],
    }));
  });

  test('a step that reads a secret is forced to each box and shows why', async () => {
    await renderWith(setup([step({ runOn: 'box', boxOnlyReason: 'The command reads a secret variable, so it runs on each box and never in an image.' })]));
    const select = within(rowOf('s1')).getByLabelText('Where step Install libpq runs') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.value).toBe('box');
    expect(within(rowOf('s1')).getByText(/reads a secret variable/)).toBeInTheDocument();
  });
});

describe('reorder', () => {
  const three = () => setup([
    step({ id: 'a', name: 'A' }),
    step({ id: 'b', name: 'B', origin: 'learned', status: 'suggested' }),
    step({ id: 'c', name: 'C', runOn: 'box' }),
    step({ id: 'd', name: 'D', origin: 'learned', status: 'dismissed' }),
  ]);
  const ids = () => (setupPut.mock.calls[0][1].steps as { id: string }[]).map((s) => s.id);

  test.each([
    { name: 'down', button: 'Move step A down', order: ['b', 'a', 'c'] },
    { name: 'up', button: 'Move step C up', order: ['a', 'c', 'b'] },
  ])('moving $name sends the new order without dismissed rows', async ({ button, order }) => {
    await renderWith(three());
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(setupPut).toHaveBeenCalled());
    expect(ids()).toEqual(order);
  });

  test('the first row cannot move up and the last cannot move down', async () => {
    await renderWith(three());
    expect(screen.getByRole('button', { name: 'Move step A up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move step C down' })).toBeDisabled();
  });

  test('drag and drop sends the new order', async () => {
    await renderWith(three());
    const dataTransfer = { setData: jest.fn(), effectAllowed: '' };
    fireEvent.dragStart(rowOf('c'), { dataTransfer });
    fireEvent.dragOver(rowOf('a'), { dataTransfer });
    fireEvent.drop(rowOf('a'), { dataTransfer });
    await waitFor(() => expect(setupPut).toHaveBeenCalled());
    expect(ids()).toEqual(['c', 'a', 'b']);
  });
});

describe('add step', () => {
  test('adds a new step at the end of the list', async () => {
    await renderWith(setup([step()]));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Start Redis' } });
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'redis-server --daemonize yes' } });
    fireEvent.change(screen.getByLabelText('Step runs'), { target: { value: 'box' } });
    fireEvent.click(within(document.querySelector('[data-attr="setup-step-form"]') as HTMLElement).getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', {
      steps: [
        { id: 's1', name: 'Install libpq', runOn: 'image', timeoutSec: null },
        { name: 'Start Redis', command: 'redis-server --daemonize yes', runOn: 'box', timeoutSec: null },
      ],
    }));
  });

  test.each([
    { name: 'a literal secret', command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', alert: /looks like it contains a secret/ },
    { name: 'a destructive command', command: 'rm -rf /', alert: /destroy data/ },
  ])('refuses $name', async ({ command, alert }) => {
    await renderWith(setup([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: command } });
    expect(screen.getByRole('alert')).toHaveTextContent(alert);
    const form = document.querySelector('[data-attr="setup-step-form"]') as HTMLElement;
    expect(within(form).getByRole('button', { name: 'Add step' })).toBeDisabled();
    expect(setupPut).not.toHaveBeenCalled();
  });

  test('a command that reads a secret variable is forced to each box', async () => {
    await renderWith(setup([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Login' } });
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'npm config set token "$NPM_TOKEN"' } });
    const runs = screen.getByLabelText('Step runs') as HTMLSelectElement;
    expect(runs).toBeDisabled();
    expect(runs.value).toBe('box');
    expect(screen.getByText(/reads a secret variable/, { selector: '[data-attr="setup-step-force-box"]' })).toBeInTheDocument();
    fireEvent.click(within(document.querySelector('[data-attr="setup-step-form"]') as HTMLElement).getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', {
      steps: [{ name: 'Login', command: 'npm config set token "$NPM_TOKEN"', runOn: 'box', timeoutSec: null }],
    }));
  });

  test.each([
    { name: 'no name', fill: { name: '', command: 'echo ok', timeout: '' }, alert: 'Give the step a name.' },
    { name: 'a time limit of 0', fill: { name: 'A', command: 'echo ok', timeout: '0' }, alert: /from 1 to 3600 seconds/ },
    { name: 'a time limit over the limit', fill: { name: 'A', command: 'echo ok', timeout: '3601' }, alert: /from 1 to 3600 seconds/ },
    { name: 'an empty command', fill: { name: 'A', command: '', timeout: '' }, alert: 'The command is empty.' },
  ])('blocks $name', async ({ fill, alert }) => {
    await renderWith(setup([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: fill.name } });
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: fill.command } });
    fireEvent.change(screen.getByLabelText('Step time limit in seconds'), { target: { value: fill.timeout } });
    fireEvent.click(within(document.querySelector('[data-attr="setup-step-form"]') as HTMLElement).getByRole('button', { name: 'Add step' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(alert);
    expect(setupPut).not.toHaveBeenCalled();
  });

  test('shows the backend refusal and keeps the form open', async () => {
    setupPut.mockRejectedValue(new Error('A list can have at most 40 of your own steps.'));
    await renderWith(setup([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'echo ok' } });
    fireEvent.click(within(document.querySelector('[data-attr="setup-step-form"]') as HTMLElement).getByRole('button', { name: 'Add step' }));
    expect(await screen.findByText('A list can have at most 40 of your own steps.')).toBeInTheDocument();
    expect(screen.getByLabelText('Step name')).toBeInTheDocument();
  });
});

describe('footer', () => {
  test('shows the image status, the last box times and the history median', async () => {
    await renderWith(setup([], {
      image: image({ layer: 'user', userLayerPending: true }),
      lastSetupTiming: { totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '2026-11-02T10:00:00Z', workbenchId: 'wb1', boxReadyMs: 40_000, checkoutMs: 5_000, setupBoxStepsMs: 12_000 },
      timingHistory: [
        { totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '', workbenchId: null, boxReadyMs: 40_000 },
        { totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '', workbenchId: null, boxReadyMs: 60_000 },
        { totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '', workbenchId: null, boxReadyMs: 50_000 },
        { totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '', workbenchId: null },
      ],
    }));
    expect(screen.getByText(/The newest box started from your image\..*Next build: pending\./)).toBeInTheDocument();
    expect(screen.getByText('Last box: ready in 40s, checkout 5s, setup steps 12s.')).toBeInTheDocument();
    expect(screen.getByText('Last 3 sessions: ready in 50s median.')).toBeInTheDocument();
  });

  test('no history line without box ready times', async () => {
    await renderWith(setup([], { timingHistory: [{ totalMs: 1, repositoryMs: null, learnedMs: 0, measuredAt: '', workbenchId: null }] }));
    expect(document.querySelector('[data-attr="repo-setup-history"]')).toBeNull();
  });

  test.each([
    { learningDisabled: false, sent: true },
    { learningDisabled: true, sent: false },
  ])('the learning switch sends learningDisabled $sent', async ({ learningDisabled, sent }) => {
    await renderWith(setup([], { learningDisabled }));
    fireEvent.click(screen.getByRole('switch', { name: 'Learn setup steps from sessions' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', { learningDisabled: sent }));
  });

  test('adds and removes an allowed host', async () => {
    await renderWith(setup([], { hosts: ['a.example.com'] }));
    fireEvent.change(screen.getByLabelText('Allowed extra hosts'), { target: { value: 'b.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    await waitFor(() => expect(setupPut).toHaveBeenCalledWith('r1', { hosts: ['a.example.com', 'b.example.com'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove host a.example.com' }));
    await waitFor(() => expect(setupPut).toHaveBeenLastCalledWith('r1', { hosts: ['b.example.com'] }));
  });

  test('refuses a host past the limit', async () => {
    const hosts = Array.from({ length: SETUP_LIST_LIMITS.maxHosts }, (_, i) => `h${i}.example.com`);
    await renderWith(setup([], { hosts }));
    expect(screen.getByRole('button', { name: 'Add host' })).toBeDisabled();
  });
});
