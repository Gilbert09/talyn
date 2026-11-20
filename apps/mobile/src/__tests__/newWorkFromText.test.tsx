import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { NewWorkScreen } from '../features/create/NewWorkScreen';
import { newSessionFromTextRoute } from '../features/sessions/actions';
import { fixture, session, thread } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  usePathname: () => '/new',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => mockRouter,
  Stack: { Screen: () => null },
}));
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] };
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: { getSnapshot: () => mockWorkspace, select: jest.fn() },
    context: mockContext }),
  useNetwork: () => 'online', useAuth: () => ({ user: { id: 'user-one' } }),
  useWorkspace: () => mockWorkspace,
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(), launchCameraAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' } }));
const mockActions = { send: jest.fn(async () => ({ queued: true })) };
jest.mock('../features/chat/actions', () => ({ get chatActions() { return mockActions; } }));

const REPOS = [
  { id: 'repo-one', workspaceId: 'one', owner: 'example', repo: 'project', fullName: 'example/project', defaultBranch: 'main' },
  { id: 'repo-two', workspaceId: 'one', owner: 'example', repo: 'api', fullName: 'example/api', defaultBranch: 'main' },
];

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); jest.clearAllMocks();
  (mockActive.api.repositories.list as jest.Mock).mockResolvedValue(REPOS);
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

describe('newSessionFromTextRoute', () => {
  it.each<[string, Parameters<typeof newSessionFromTextRoute>[0], string, Record<string, string> | null]>([
    ['a session: its repository by name', session(), 'the bug', { mode: 'session', repository: 'example/project', prompt: '> the bug\n\n' }],
    ['a session with no name: its repository id', session({ repoFullName: '' }), 'the bug', { mode: 'session', repository: 'repo-one', prompt: '> the bug\n\n' }],
    ['a thread: no repository', thread(), 'one\ntwo', { mode: 'session', prompt: '> one\n> two\n\n' }],
    ['empty text', session(), '', null],
    ['only whitespace', session(), ' \n\t', null],
  ])('%s', (_name, item, copied, params) => {
    const route = newSessionFromTextRoute(item, copied);
    expect(route).toEqual(params ? { pathname: '/new', params } : null);
  });
});

describe('the new-session composer with a prompt from the route', () => {
  const task = () => screen.findByLabelText('Task');

  it.each<[string, string, string]>([
    ['by full name', 'example/api', 'repo-two'],
    ['by full name in another case', 'Example/API', 'repo-two'],
    ['by id', 'repo-two', 'repo-two'],
  ])('fills the draft and picks the repository %s', async (_name, repository, expected) => {
    mockActive.store.updateLocal('new:prompt', { draft: 'an old draft' });
    await render(<NewWorkScreen initialRepositoryId={repository} initialPrompt={'> the bug\n\n'} />);
    expect(await task()).toHaveTextContent('> the bug');
    await fireEvent.changeText(await task(), '> the bug\n\nFix it');
    const start = screen.getByRole('button', { name: 'Start session' });
    await waitFor(() => expect(start).toBeEnabled());
    await fireEvent.press(start);
    await waitFor(() => expect(mockActive.api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: expected, prompt: '> the bug\n\nFix it' })));
  });

  it('keeps the draft without a prompt', async () => {
    mockActive.store.updateLocal('new:prompt', { draft: 'my draft' });
    await render(<NewWorkScreen />);
    expect(await task()).toHaveTextContent('my draft');
  });
});
