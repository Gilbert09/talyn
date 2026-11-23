import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { defaultPromptTemplateHash, type Workspace } from '@talyn/shared';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { InstructionsScreen } from '../features/instructions/InstructionsScreen';
import { PromptEditorScreen } from '../features/instructions/PromptEditorScreen';
import { RepositoryInstructionsScreen } from '../features/instructions/RepositoryInstructionsScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockLoad = jest.fn(async (_entity: string) => undefined);
const mockUpdate = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockRemove = jest.fn();
const mockBack = jest.fn();
const mockPush = jest.fn();
let mockWorkspace: Workspace;

jest.mock('@talyn/client/native', () => ({
  workspaces: { update: (...args: unknown[]) => mockUpdate(...args) },
  repositories: { instructions: {
    list: (...args: unknown[]) => mockList(...args), get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args), remove: (...args: unknown[]) => mockRemove(...args),
  } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: { load: mockLoad }, lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'w1' }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: (entity: string) => {
    const data = entity === 'workspace' ? mockWorkspace
      : entity === 'repositories' ? [{ id: 'r1', workspaceId: 'w1', fullName: 'acme/web', owner: 'acme', repo: 'web', defaultBranch: 'main' }]
        : entity === 'attention' ? [] : undefined;
    return { status: 'ready', data, stale: false, refreshing: false, refresh: jest.fn(async () => undefined) };
  },
}));
jest.mock('../lib/features', () => ({ useFeatures: () => ({ workbenches: true }) }));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({ useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: jest.fn(),
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const draw = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={insets}>{node}</SafeAreaProvider>);
const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

beforeEach(() => {
  mockWorkspace = { id: 'w1', name: 'Acme', settings: {} } as Workspace;
  mockList.mockResolvedValue([{ repositoryId: 'r1', agents: 'codex', bytes: 2048, updatedAt: '2026-11-01T00:00:00Z' }]);
});

describe('instructions list', () => {
  it('shows repository instructions and the prompt cards', async () => {
    mockWorkspace = { ...mockWorkspace, settings: { prompts: { skill: { template: 'x {{pr.url}}', basedOnHash: defaultPromptTemplateHash('skill'), updatedAt: '2026-11-01T00:00:00Z' } } } } as Workspace;
    await draw(<InstructionsScreen />);
    expect(await screen.findByText('2.0 KB · Codex')).toBeTruthy();
    expect(screen.getByLabelText('Skill runs, customized')).toBeTruthy();
    expect(screen.getByLabelText('Keep mergeable / Fix PR, default')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Edit instructions for acme/web')); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings/instructions/repository/[id]', params: { id: 'r1' } });
  });
});

describe('prompt editor', () => {
  const fill = async (text: string) => {
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Keep mergeable / Fix PR prompt'), text); });
  };

  it('saves a valid template and goes back', async () => {
    mockUpdate.mockResolvedValue(mockWorkspace);
    await draw(<PromptEditorScreen kind="mergeable" />);
    const save = screen.getByLabelText('Save as workspace prompt');
    expect(save.props.accessibilityState.disabled).toBe(true);
    await fill('Fix {{pr.url}}\n{{gitRules}}');
    expect(screen.getByText('Ready to save.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Save as workspace prompt')); });
    expect(mockUpdate).toHaveBeenCalledWith('w1', { settings: { prompts: { mergeable: expect.objectContaining({
      template: 'Fix {{pr.url}}\n{{gitRules}}', basedOnHash: defaultPromptTemplateHash('mergeable') }) } } });
    expect(mockLoad).toHaveBeenCalledWith('workspace');
    expect(mockBack).toHaveBeenCalled();
  });

  it('keeps Save off while the template is invalid', async () => {
    await draw(<PromptEditorScreen kind="mergeable" />);
    await fill('No variables');
    expect(screen.getByText('Missing required variables: {{pr.url}}, {{gitRules}}.')).toBeTruthy();
    expect(screen.getByLabelText('Save as workspace prompt').props.accessibilityState.disabled).toBe(true);
  });

  it('inserts a variable at the cursor', async () => {
    await draw(<PromptEditorScreen kind="mergeable" />);
    await fill('Fix ');
    await act(async () => { fireEvent(screen.getByLabelText('Keep mergeable / Fix PR prompt'), 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } }); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Insert {{pr.url}}, required, missing')); });
    expect(screen.getByLabelText('Keep mergeable / Fix PR prompt').props.value).toBe('Fix {{pr.url}}');
  });

  it('shows the server error and stays', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('Workspace not found'), { status: 404 }));
    await draw(<PromptEditorScreen kind="mergeable" />);
    await fill('Fix {{pr.url}}\n{{gitRules}}');
    await act(async () => { fireEvent.press(screen.getByLabelText('Save as workspace prompt')); });
    expect(alert).toHaveBeenCalledWith('Could not save the prompt', 'Workspace not found');
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('resets a customized prompt after a confirm', async () => {
    mockWorkspace = { ...mockWorkspace, settings: { prompts: { mergeable: { template: 'Fix {{pr.url}}\n{{gitRules}}', basedOnHash: 'old', updatedAt: '2026-11-01T00:00:00Z' } } } } as Workspace;
    mockUpdate.mockResolvedValue(mockWorkspace);
    await draw(<PromptEditorScreen kind="mergeable" />);
    expect(screen.getByText(/default for this prompt changed since you customized it/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Reset to default')); });
    const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => { buttons.find((button) => button.text === 'Reset')?.onPress?.(); });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('w1', { settings: { prompts: { mergeable: null } } }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('refuses an unknown kind', async () => {
    await draw(<PromptEditorScreen kind="nope" />);
    expect(screen.getByText('This prompt does not exist')).toBeTruthy();
  });
});

describe('repository instructions editor', () => {
  it('writes new instructions for the chosen agents', async () => {
    mockGet.mockResolvedValue(null);
    mockPut.mockResolvedValue({ repositoryId: 'r1', body: 'Run npm test', agents: 'claude', bytes: 12, updatedAt: 'now' });
    await draw(<RepositoryInstructionsScreen repositoryId="r1" />);
    const field = await screen.findByLabelText('Instructions for acme/web');
    expect(screen.queryByLabelText('Delete')).toBeNull();
    await act(async () => { fireEvent.changeText(field, 'Run npm test'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Claude')); });
    expect(screen.getByText('0.0 KB of 64 KB')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(mockPut).toHaveBeenCalledWith('r1', { body: 'Run npm test', agents: 'claude' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('shows the server error and stays', async () => {
    mockGet.mockResolvedValue({ repositoryId: 'r1', body: 'Old', agents: 'both', bytes: 3, updatedAt: 'then' });
    mockPut.mockRejectedValue(Object.assign(new Error('Repository instructions load into every turn; these are 70 KB. Trim them below 64 KB.'), { status: 400 }));
    await draw(<RepositoryInstructionsScreen repositoryId="r1" />);
    const field = await screen.findByLabelText('Instructions for acme/web');
    expect(field.props.value).toBe('Old');
    expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(field, 'New'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(alert).toHaveBeenCalledWith('Could not save these instructions', 'Repository instructions load into every turn; these are 70 KB. Trim them below 64 KB.');
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('deletes after a confirm', async () => {
    mockGet.mockResolvedValue({ repositoryId: 'r1', body: 'Old', agents: 'both', bytes: 3, updatedAt: 'then' });
    mockRemove.mockResolvedValue(undefined);
    await draw(<RepositoryInstructionsScreen repositoryId="r1" />);
    await screen.findByLabelText('Instructions for acme/web');
    await act(async () => { fireEvent.press(screen.getByLabelText('Delete')); });
    const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => { buttons.find((button) => button.text === 'Confirm delete')?.onPress?.(); });
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('r1'));
    expect(mockBack).toHaveBeenCalled();
  });
});
