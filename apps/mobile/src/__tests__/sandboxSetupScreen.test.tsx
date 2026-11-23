import type { SetupListStep, WorkspaceSandboxSetup } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SandboxSetupScreen } from '../features/sandboxSetup/SandboxSetupScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockRetry = jest.fn();
let mockFeatures: { workbenches: boolean } | null = { workbenches: true };
jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  workspaces: { sandboxSetup: { get: (...a: unknown[]) => mockGet(...a), put: (...a: unknown[]) => mockPut(...a), retryStep: (...a: unknown[]) => mockRetry(...a) } },
  github: { listRepos: jest.fn(async () => [{ full_name: 'me/dotfiles' }]) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'one' }),
  useNetwork: () => 'online',
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({ useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?' }));

const step = (patch: Partial<SetupListStep> = {}): SetupListStep => ({
  id: 's1', repositoryId: null, position: 0, name: 'Install', command: 'npm i', kind: 'node', runOn: 'image', origin: 'user', status: 'active',
  statusReason: null, statusChangedAt: null, acceptedBy: null, timeoutSec: null, boxOnlyReason: null, why: null, sourceWorkbenchId: null,
  seenCount: 0, sessionCount: 0, firstSeenAt: '', lastSeenAt: '', confirmedAt: null, imageAppliedAt: 'x', imageFailedAt: null,
  imageFailureReason: null, boxFailureCount: 0, boxLastFailure: null, lastDurationMs: null, typicalDurationMs: null, measuredBoxes: 0,
  createdAt: '', updatedAt: '', ...patch,
});
const setup = (patch: Partial<WorkspaceSandboxSetup> = {}): WorkspaceSandboxSetup => ({
  workspaceId: 'one', dotfiles: null, hosts: [], steps: [step()],
  limits: { imageMaxSteps: 20, imageTotalSec: 3600, maxHosts: 10, maxUserSteps: 40, stepMaxSec: 3600 }, ...patch,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFeatures = { workbenches: true };
  mockGet.mockResolvedValue(setup());
});

describe('SandboxSetupScreen', () => {
  it('shows nothing when the feature is off', async () => {
    mockFeatures = { workbenches: false };
    await render(<SandboxSetupScreen />);
    expect(screen.getByText('Not available')).toBeVisible();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('saves the dotfiles and shows the new state', async () => {
    mockPut.mockResolvedValue(setup({ dotfiles: { slug: 'me/dotfiles', ref: '', install: null } }));
    await render(<SandboxSetupScreen />);
    await screen.findByText('Install');
    await fireEvent.changeText(screen.getByLabelText('Dotfiles repository'), 'me/dotfiles');
    await act(async () => { fireEvent.press(screen.getByLabelText('Save dotfiles')); });
    expect(mockPut).toHaveBeenCalledWith('one', { dotfiles: { slug: 'me/dotfiles', ref: '', install: null } });
    await screen.findByLabelText('Remove dotfiles');
  });

  it('shows a validation error and does not call the server', async () => {
    await render(<SandboxSetupScreen />);
    await screen.findByText('Install');
    await fireEvent.changeText(screen.getByLabelText('Dotfiles repository'), 'bad');
    await act(async () => { fireEvent.press(screen.getByLabelText('Save dotfiles')); });
    expect(screen.getByText('The repository must be owner/name.')).toBeVisible();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('shows the server message when a save fails', async () => {
    mockPut.mockRejectedValue(new Error('The dotfiles repository was not found.'));
    await render(<SandboxSetupScreen />);
    await screen.findByText('Install');
    await fireEvent.changeText(screen.getByLabelText('Dotfiles repository'), 'me/missing');
    await act(async () => { fireEvent.press(screen.getByLabelText('Save dotfiles')); });
    expect(await screen.findByText('The dotfiles repository was not found.')).toBeVisible();
  });

  it('adds a step with the whole ordered list', async () => {
    mockPut.mockResolvedValue(setup({ steps: [step(), step({ id: 's2', name: 'Build', command: 'make' })] }));
    await render(<SandboxSetupScreen />);
    await screen.findByText('Install');
    await fireEvent.press(screen.getByLabelText('Add step'));
    await fireEvent.changeText(screen.getByLabelText('Step name'), 'Build');
    await fireEvent.changeText(screen.getByLabelText('Step command'), 'make');
    await act(async () => { fireEvent.press(screen.getAllByLabelText('Add step').at(-1) as never); });
    expect(mockPut).toHaveBeenCalledWith('one', { steps: [
      { id: 's1', name: 'Install', runOn: 'image', timeoutSec: null },
      { name: 'Build', command: 'make', runOn: 'image', timeoutSec: null },
    ] });
    await screen.findByText('Build');
  });

  it('refuses an empty command in the step form', async () => {
    await render(<SandboxSetupScreen />);
    await screen.findByText('Install');
    await fireEvent.press(screen.getByLabelText('Add step'));
    await fireEvent.changeText(screen.getByLabelText('Step name'), 'Build');
    expect(screen.getByRole('button', { name: 'Add step' })).toBeDisabled; // eslint-disable-line @typescript-eslint/no-unused-expressions
    await act(async () => { fireEvent.press(screen.getAllByLabelText('Add step').at(-1) as never); });
    expect(screen.getByText('The command is empty.')).toBeVisible();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('retries a disabled step', async () => {
    mockGet.mockResolvedValue(setup({ steps: [step({ status: 'disabled', statusReason: 'failed 3 times' })] }));
    mockRetry.mockResolvedValue(step({ status: 'active' }));
    await render(<SandboxSetupScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Retry')); });
    expect(mockRetry).toHaveBeenCalledWith('one', 's1');
    await waitFor(() => expect(screen.queryByLabelText('Retry')).toBeNull());
  });

  it('shows the server message when a retry fails', async () => {
    mockGet.mockResolvedValue(setup({ steps: [step({ status: 'disabled' })] }));
    mockRetry.mockRejectedValue(new Error('Could not reach the fleet.'));
    await render(<SandboxSetupScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Retry')); });
    expect(await screen.findByText('Could not reach the fleet.')).toBeVisible();
  });

  it('moves a step down', async () => {
    mockGet.mockResolvedValue(setup({ steps: [step(), step({ id: 's2', name: 'Build' })] }));
    mockPut.mockResolvedValue(setup({ steps: [step({ id: 's2', name: 'Build' }), step()] }));
    await render(<SandboxSetupScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Move step Install down')); });
    expect(mockPut.mock.calls[0][1].steps.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
  });
});
