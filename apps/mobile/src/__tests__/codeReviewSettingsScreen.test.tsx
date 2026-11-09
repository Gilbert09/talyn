import { AUTO_REVIEW_ERROR_CODE, CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES, type Workspace } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { CodeReviewSettingsScreen } from '../features/codeReviewSettings/CodeReviewSettingsScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockUpdate = jest.fn();
const mockLenses = jest.fn();
const mockSkills = jest.fn();
const mockRefresh = jest.fn(async () => undefined);
const mockNavigate = jest.fn();
let mockWorkspace: Workspace;
const mockRepos = [{ id: 'r1', workspaceId: 'one', owner: 'acme', repo: 'api', fullName: 'acme/api', defaultBranch: 'main' }];

jest.mock('@talyn/client/native', () => ({
  workspaces: { update: (...args: unknown[]) => mockUpdate(...args) },
  codeReviews: { lenses: (...args: unknown[]) => mockLenses(...args) },
  skills: { list: (...args: unknown[]) => mockSkills(...args) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [] }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: (entity: string) => entity === 'workspace'
    ? { status: 'ready', data: mockWorkspace, refreshing: false, stale: false, refresh: mockRefresh }
    : { status: 'ready', data: mockRepos, refreshing: false, stale: false, refresh: jest.fn() },
}));
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));

const workspace = (codeReview: Record<string, unknown> = {}) =>
  ({ id: 'one', name: 'Acme', settings: { codeReview } } as unknown as Workspace);
const alertSpy = () => jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

beforeEach(() => {
  mockWorkspace = workspace();
  mockUpdate.mockResolvedValue({});
  mockLenses.mockResolvedValue({ lenses: [{ lens: 'correctness', raised: 10, kept: 4 }] });
  mockSkills.mockResolvedValue({
    repo: [{ key: 'repo:acme/api:security', source: 'repo', name: 'security', description: 'Looks for holes' }],
    platform: [{ key: 'platform:big', source: 'platform', name: 'Huge', description: '', contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1 }],
    repoStatus: 'ok', usage: {},
  });
});

describe('code review settings', () => {
  it('turns on automatic reviews with only that key', async () => {
    await render(<CodeReviewSettingsScreen />);
    expect(await screen.findByText('4 of 10 kept')).toBeTruthy();
    await act(async () => { fireEvent(screen.getByLabelText('Review my new pull requests automatically'), 'valueChange', true); });
    expect(mockUpdate).toHaveBeenCalledWith('one', { settings: { codeReview: { autoReview: true } } });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('offers Plan and credits when the plan cannot review automatically', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('Unlimited only'), { status: 402, code: AUTO_REVIEW_ERROR_CODE }));
    const alert = alertSpy();
    await render(<CodeReviewSettingsScreen />);
    await act(async () => { fireEvent(screen.getByLabelText('Review my new pull requests automatically'), 'valueChange', true); });
    expect(alert).toHaveBeenCalledWith('Review every new PR with Pro', expect.stringContaining('Pro feature'), expect.any(Array));
    const buttons = alert.mock.calls[0]![2]!;
    buttons.find((button) => button.text === 'Plan and credits')!.onPress!();
    expect(mockNavigate).toHaveBeenCalledWith('/billing');
    // The switch goes back to what is saved.
    expect(screen.getByLabelText('Review my new pull requests automatically').props.value).toBe(false);
    alert.mockRestore();
  });

  it('shows the server message when a change fails', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('Workspace is read-only'), { status: 400 }));
    const alert = alertSpy();
    await render(<CodeReviewSettingsScreen />);
    await act(async () => { fireEvent.press(screen.getByRole('tab', { name: 'Deep' })); });
    expect(mockUpdate).toHaveBeenCalledWith('one', { settings: { codeReview: { preset: 'deep' } } });
    expect(alert).toHaveBeenCalledWith('Could not change the review depth', 'Workspace is read-only');
    alert.mockRestore();
  });

  it('does not save the depth that is already chosen', async () => {
    await render(<CodeReviewSettingsScreen />);
    await act(async () => { fireEvent.press(screen.getByRole('tab', { name: 'Standard' })); });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("keeps Talyn's reviewers on while there is no reviewer of your own", async () => {
    await render(<CodeReviewSettingsScreen />);
    expect(screen.getByLabelText("Talyn's reviewers").props.disabled).toBe(true);
    expect(screen.getByText('To turn these off, add a reviewer of your own first.')).toBeTruthy();
  });

  it('adds a repository skill as a reviewer and refuses one that is too large', async () => {
    await render(<CodeReviewSettingsScreen />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Add reviewer')); });
    await waitFor(() => expect(mockSkills).toHaveBeenCalledWith('one', 'r1'));
    expect(await screen.findByText('In acme/api')).toBeTruthy();
    expect(screen.getByLabelText('Huge. Too large to run as a reviewer').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.press(screen.getByLabelText('security')); });
    expect(mockUpdate).toHaveBeenCalledWith('one', { settings: { codeReview: { customReviewers: [{ skillKey: 'repo:acme/api:security', name: 'security' }] } } });
  });

  it('removes a reviewer, but not the only one when Talyn is off', async () => {
    mockWorkspace = workspace({ customReviewers: [{ skillKey: 'platform:a', name: 'Style' }, { skillKey: 'repo:acme/api:security', name: 'security' }] });
    const { rerender } = await render(<CodeReviewSettingsScreen />);
    expect(screen.getByText("Talyn's and 2 of your own")).toBeTruthy();
    expect(screen.getByText('Runs on pull requests in acme/api only.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Remove Style')); });
    expect(mockUpdate).toHaveBeenCalledWith('one', { settings: { codeReview: { customReviewers: [{ skillKey: 'repo:acme/api:security', name: 'security' }] } } });

    mockWorkspace = workspace({ builtInReviewers: false, customReviewers: [{ skillKey: 'platform:a', name: 'Style' }] });
    await rerender(<CodeReviewSettingsScreen />);
    expect(screen.getByLabelText('Remove Style').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText("This is your only reviewer. Turn on Talyn's reviewers before you remove it.")).toBeTruthy();
  });

  it('shows which findings auto-fix may touch only once auto-fix is on', async () => {
    const { rerender } = await render(<CodeReviewSettingsScreen />);
    expect(screen.queryByText('6. Which findings it may fix')).toBeNull();
    mockWorkspace = workspace({ autoFix: true });
    await rerender(<CodeReviewSettingsScreen />);
    expect(screen.getByText('6. Which findings it may fix')).toBeTruthy();
  });
});
