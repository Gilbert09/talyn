import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ListSkillsResponse, PlatformSkill } from '@talyn/shared';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RepoSkillScreen } from '../features/skills/RepoSkillScreen';
import { SkillEditorScreen } from '../features/skills/SkillEditorScreen';
import { SkillsScreen } from '../features/skills/SkillsScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockSkills = { list: jest.fn(), get: jest.fn(), repoContent: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() };
const mockBack = jest.fn();
const mockPush = jest.fn();
const mockRepos = [{ id: 'r1', workspaceId: 'w1', fullName: 'acme/web' }, { id: 'r2', workspaceId: 'w1', fullName: 'acme/api' }];

jest.mock('@talyn/client/native', () => ({
  skills: new Proxy({}, { get: (_target, key: string) => (...args: unknown[]) => (mockSkills as Record<string, jest.Mock>)[key](...args) }),
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: { load: jest.fn() }, lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'w1' }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: (entity: string) => ({ status: 'ready', stale: false, refreshing: false, refresh: jest.fn(async () => undefined),
    data: entity === 'repositories' ? mockRepos : undefined }),
}));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({ useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: jest.fn(),
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const draw = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={insets}>{node}</SafeAreaProvider>);
const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const listing = (overrides: Partial<ListSkillsResponse> = {}): ListSkillsResponse => ({
  platform: [{ key: 'platform:s1', source: 'platform', id: 's1', name: 'pr-review', description: 'Reviews a PR' }],
  repo: [{ key: 'repo:acme/web/lint', source: 'repo', repositoryId: 'r1', name: 'lint', description: '', repoPath: '.claude/skills/lint/SKILL.md' }],
  repoStatus: 'ok', usage: {}, ...overrides,
});
const platformSkill: PlatformSkill = { key: 'platform:s1', source: 'platform', id: 's1', name: 'pr-review', description: 'Reviews a PR',
  content: '# Review', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };

beforeEach(() => { mockSkills.list.mockResolvedValue(listing()); });

describe('skills list', () => {
  it('lists Talyn and repo skills and says where local skills live', async () => {
    await draw(<SkillsScreen />);
    expect(await screen.findByText('pr-review')).toBeTruthy();
    expect(screen.getByText('.claude/skills/lint/SKILL.md')).toBeTruthy();
    expect(screen.getByText(/Manage them in the Talyn desktop app/)).toBeTruthy();
    expect(mockSkills.list).toHaveBeenCalledWith('w1', 'r1', undefined);
    await act(async () => { fireEvent.press(screen.getByLabelText('lint')); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings/skills/repo', params: { repositoryId: 'r1', name: 'lint' } });
  });

  it('switches repository and re-fetches from GitHub', async () => {
    await draw(<SkillsScreen />);
    await screen.findByText('pr-review');
    await act(async () => { fireEvent.press(screen.getByLabelText('Repository: acme/web')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('acme/api')); });
    await waitFor(() => expect(mockSkills.list).toHaveBeenLastCalledWith('w1', 'r2', undefined));
    await act(async () => { fireEvent.press(screen.getByLabelText('Re-fetch from GitHub')); });
    await waitFor(() => expect(mockSkills.list).toHaveBeenLastCalledWith('w1', 'r2', true));
  });

  it('says when GitHub could not be read', async () => {
    mockSkills.list.mockResolvedValue(listing({ repo: [], repoStatus: 'error' }));
    await draw(<SkillsScreen />);
    expect(await screen.findByText('Could not load skills from GitHub. Try refreshing.')).toBeTruthy();
  });

  it('deletes a Talyn skill after a confirm', async () => {
    mockSkills.remove.mockResolvedValue(undefined);
    await draw(<SkillsScreen />);
    await act(async () => { fireEvent(await screen.findByLabelText('pr-review'), 'longPress'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Delete')); });
    expect(alert).toHaveBeenLastCalledWith('Delete this skill?', expect.stringContaining('pr-review is removed'), expect.any(Array));
    const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => { buttons.find((button) => button.text === 'Delete')?.onPress?.(); });
    await waitFor(() => expect(mockSkills.remove).toHaveBeenCalledWith('s1'));
  });
});

describe('skill editor', () => {
  it('creates a skill', async () => {
    mockSkills.create.mockResolvedValue(platformSkill);
    await draw(<SkillEditorScreen id="new" />);
    expect(screen.getByLabelText('Create skill').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Name'), 'pr-review'); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Content (SKILL.md)'), '# Review'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Create skill')); });
    expect(mockSkills.create).toHaveBeenCalledWith({ workspaceId: 'w1', name: 'pr-review', description: '', content: '# Review' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('asks for a name and content', async () => {
    await draw(<SkillEditorScreen id="new" />);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Description'), 'Only this'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Create skill')); });
    expect(screen.getByText('Name and content are required')).toBeTruthy();
    expect(mockSkills.create).not.toHaveBeenCalled();
  });

  it('updates a skill', async () => {
    mockSkills.get.mockResolvedValue(platformSkill);
    mockSkills.update.mockResolvedValue({ ...platformSkill, content: '# Better' });
    await draw(<SkillEditorScreen id="s1" />);
    const content = await screen.findByLabelText('Content (SKILL.md)');
    expect(content.props.value).toBe('# Review');
    await act(async () => { fireEvent.changeText(content, '# Better'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save changes')); });
    expect(mockSkills.update).toHaveBeenCalledWith('s1', { name: 'pr-review', description: 'Reviews a PR', content: '# Better' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('shows the server error and stays', async () => {
    mockSkills.get.mockResolvedValue(platformSkill);
    mockSkills.update.mockRejectedValue(Object.assign(new Error('A skill with this name already exists'), { status: 409 }));
    await draw(<SkillEditorScreen id="s1" />);
    await act(async () => { fireEvent.changeText(await screen.findByLabelText('Name'), 'other'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save changes')); });
    expect(alert).toHaveBeenCalledWith('Could not update skill', 'A skill with this name already exists');
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('repo skill', () => {
  it('shows the SKILL.md read-only', async () => {
    mockSkills.repoContent.mockResolvedValue({ content: '# Lint\nRun eslint.', repoPath: '.claude/skills/lint/SKILL.md' });
    await draw(<RepoSkillScreen repositoryId="r1" name="lint" />);
    expect(await screen.findByText('# Lint\nRun eslint.')).toBeTruthy();
    expect(mockSkills.repoContent).toHaveBeenCalledWith('w1', 'r1', 'lint');
  });
});
