import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { MemoryEntry, MemoryEntrySummary, Workspace } from '@talyn/shared';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MemoryEditorScreen } from '../features/memory/MemoryEditorScreen';
import { MemoryScreen } from '../features/memory/MemoryScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockLoad = jest.fn(async (_entity: string) => undefined);
const mockMemory = {
  list: jest.fn(), get: jest.fn(), put: jest.fn(), update: jest.fn(), forget: jest.fn(), restore: jest.fn(), reviews: jest.fn(), startReview: jest.fn(),
};
const mockUpdateWorkspace = jest.fn();
const mockBack = jest.fn();
const mockPush = jest.fn();
let mockWorkspace: Workspace;
let mockFeatures: { workbenches?: boolean } | null;

jest.mock('@talyn/client/native', () => ({
  workbenches: { memory: new Proxy({}, { get: (_target, key: string) => (...args: unknown[]) => (mockMemory as Record<string, jest.Mock>)[key](...args) }) },
  workspaces: { update: (...args: unknown[]) => mockUpdateWorkspace(...args) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: { load: mockLoad }, lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'w1' }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: (entity: string) => ({ status: 'ready', stale: false, refreshing: false, refresh: jest.fn(async () => undefined),
    data: entity === 'workspace' ? mockWorkspace : entity === 'repositories' ? [{ id: 'r1', workspaceId: 'w1', fullName: 'acme/web' }] : undefined }),
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({ useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: jest.fn(),
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const draw = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={insets}>{node}</SafeAreaProvider>);
const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const summary = (overrides: Partial<MemoryEntrySummary> = {}): MemoryEntrySummary => ({ id: 'm1', workspaceId: 'w1', scope: 'workspace',
  repositoryId: null, threadId: null, type: 'project', name: 'Build command', description: 'How to build', bytes: 13, source: { kind: 'user' },
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', forgottenAt: null, ...overrides });
const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...summary(overrides), body: 'npm run build', ...overrides });

beforeEach(() => {
  mockFeatures = { workbenches: true };
  mockWorkspace = { id: 'w1', name: 'Acme', settings: {} } as Workspace;
  mockMemory.list.mockResolvedValue([summary(), summary({ id: 'm2', scope: 'repository', repositoryId: 'r1', name: 'Lint', type: 'feedback' })]);
  mockMemory.reviews.mockResolvedValue({ cadence: 'off', runs: [] });
});

describe('memory list', () => {
  it('groups the notes, counts them and forgets one', async () => {
    mockMemory.forget.mockResolvedValue(summary({ forgottenAt: '2026-11-09T00:00:00Z' }));
    await draw(<MemoryScreen />);
    expect(await screen.findByText('Build command')).toBeTruthy();
    expect(screen.getByText('acme/web')).toBeTruthy();
    expect(screen.getByText('2 of 500')).toBeTruthy();
    expect(mockMemory.list).toHaveBeenCalledWith({ workspaceId: 'w1' });
    await act(async () => { fireEvent(screen.getByLabelText('Build command'), 'longPress'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Forget')); });
    expect(mockMemory.forget).toHaveBeenCalledWith('m1');
    expect(await screen.findByLabelText('Build command, forgotten')).toBeTruthy();
    expect(screen.getByText('1 of 500')).toBeTruthy();
  });

  it('saves the session memory switch', async () => {
    mockUpdateWorkspace.mockResolvedValue(mockWorkspace);
    await draw(<MemoryScreen />);
    await screen.findByText('Build command');
    await act(async () => { fireEvent(screen.getByLabelText('Session memory'), 'valueChange', false); });
    expect(mockUpdateWorkspace).toHaveBeenCalledWith('w1', { settings: { sessionMemory: false } });
  });

  it('is not offered without sessions', async () => {
    mockFeatures = { workbenches: false };
    await draw(<MemoryScreen />);
    expect(screen.getByText('Memory is not available')).toBeTruthy();
    expect(mockMemory.list).not.toHaveBeenCalled();
  });
});

describe('memory editor', () => {
  it('creates a repository note', async () => {
    mockMemory.put.mockResolvedValue({ entry: entry({ id: 'new1' }), outcome: 'created' });
    await draw(<MemoryEditorScreen id="new" />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Applies to: Every session in this workspace')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('acme/web')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Reference')); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Memory name'), 'Deploy'); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Memory description'), 'How to deploy'); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Memory note'), 'npm run deploy'); });
    expect(screen.getByText('6 / 64')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(mockMemory.put).toHaveBeenCalledWith({ workspaceId: 'w1', scope: 'repository', repositoryId: 'r1', type: 'reference',
      name: 'Deploy', description: 'How to deploy', body: 'npm run deploy' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('checks the note before it sends', async () => {
    await draw(<MemoryEditorScreen id="new" />);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Memory note'), 'body only'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(mockMemory.put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('edits only the changed fields', async () => {
    mockMemory.get.mockResolvedValue(entry());
    mockMemory.update.mockResolvedValue(entry({ body: 'make build' }));
    await draw(<MemoryEditorScreen id="m1" />);
    const note = await screen.findByLabelText('Memory note');
    expect(note.props.value).toBe('npm run build');
    expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(note, 'make build'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(mockMemory.update).toHaveBeenCalledWith('m1', { body: 'make build' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('shows the server error inline and stays', async () => {
    mockMemory.get.mockResolvedValue(entry());
    mockMemory.update.mockRejectedValue(Object.assign(new Error('A memory with this name exists'), { status: 409 }));
    await draw(<MemoryEditorScreen id="m1" />);
    await act(async () => { fireEvent.changeText(await screen.findByLabelText('Memory name'), 'Lint'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(await screen.findByText('A memory with this name exists')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('forgets and restores from the detail', async () => {
    mockMemory.get.mockResolvedValue(entry());
    mockMemory.forget.mockResolvedValue(summary({ forgottenAt: '2026-11-09T00:00:00Z' }));
    mockMemory.restore.mockResolvedValue(entry());
    await draw(<MemoryEditorScreen id="m1" />);
    await screen.findByLabelText('Memory note');
    await act(async () => { fireEvent.press(screen.getByLabelText('Forget')); });
    expect(await screen.findByText('This memory is forgotten. Sessions no longer read it.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Restore')); });
    await waitFor(() => expect(mockMemory.restore).toHaveBeenCalledWith('m1'));
    expect(screen.queryByText('This memory is forgotten. Sessions no longer read it.')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });
});
