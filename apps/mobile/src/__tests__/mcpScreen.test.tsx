import type { McpServerDefinition } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { McpServerEditorScreen } from '../features/mcp/McpServerEditor';
import { McpServersScreen } from '../features/mcp/McpServersScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockApi = {
  list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn(), test: jest.fn(), discoverAuth: jest.fn(),
  startSignIn: jest.fn(), signInStatus: jest.fn(), disconnect: jest.fn(), account: jest.fn(),
};
const mockPrivateConnector = jest.fn();
const mockOpenFlow = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockFeatures: Record<string, boolean> | null = { mcpServers: true };

jest.mock('@talyn/client/native', () => ({
  mcpServers: new Proxy({}, { get: (_target, key: string) => (...args: unknown[]) => (mockApi as Record<string, jest.Mock>)[key](...args) }),
  workspaces: { privateConnector: { get: (...args: unknown[]) => mockPrivateConnector(...args) } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1' }),
  useNetwork: () => 'online',
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('../workflow/hooks', () => ({
  useResource: () => ({ status: 'ready', data: [
    { id: 'repo-a', workspaceId: 'ws-1', fullName: 'acme/api' },
    { id: 'repo-b', workspaceId: 'ws-1', fullName: 'acme/web' },
    { id: 'repo-c', workspaceId: 'ws-2', fullName: 'other/app' },
  ], refresh: jest.fn() }),
}));
jest.mock('../lib/returnTo', () => ({
  appReturnBase: () => 'talyn-mobile://',
  openReturnFlow: (...args: unknown[]) => mockOpenFlow(...args),
}));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?',
}));
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), back: (...args: unknown[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const url = 'https://mcp.example.com/mcp';
const server: McpServerDefinition = {
  id: 'srv-1', workspaceId: 'ws-1', name: 'example', url, authKind: 'bearer', inject: null, hasSecret: false, oauth: null,
  enabled: true, tools: null, repositoryIds: null, catalogHandle: null, displayName: null, description: null, lastProbe: null,
  createdAt: '', updatedAt: '',
};
const connectedServer: McpServerDefinition = {
  ...server, hasSecret: true,
  lastProbe: { ok: true, at: '', toolNames: ['search', 'read'], tools: [{ name: 'search', description: '**Search documents.**' }, { name: 'read' }] },
};
const apiError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });

beforeEach(() => {
  mockFeatures = { mcpServers: true };
  mockApi.list.mockResolvedValue([]);
  mockApi.create.mockResolvedValue(server);
  mockApi.update.mockImplementation(async (_id: string, input: object) => ({ ...connectedServer, ...input }));
  mockApi.test.mockResolvedValue({ ok: true, at: '', toolNames: ['read_documents'] });
  mockApi.account.mockResolvedValue(null);
  mockApi.get.mockResolvedValue({ ...server, oauth: { status: 'connected' } });
  mockPrivateConnector.mockRejectedValue(apiError('Not found', 404));
  mockOpenFlow.mockResolvedValue('returned');
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

const lastBody = (mock: jest.Mock) => {
  const args = mock.mock.calls[mock.mock.calls.length - 1] as unknown[];
  return args[args.length - 1] as Record<string, unknown>;
};

describe('MCP servers list', () => {
  it('shows each server with its state and the catalog', async () => {
    mockApi.list.mockResolvedValue([
      { ...connectedServer, displayName: 'Example', catalogHandle: 'linear' },
      { ...server, id: 'srv-2', name: 'notion', oauth: { status: 'needs_reauth', detail: 'The refresh token was revoked.' }, enabled: false },
      { ...server, id: 'srv-3', name: 'pending', oauth: { status: 'pending' } },
    ]);
    await render(<McpServersScreen />);
    expect(await screen.findByText('Example')).toBeTruthy();
    expect(screen.getAllByText('Connected')).toHaveLength(2);
    expect(screen.getByText('2/2 tools')).toBeTruthy();
    expect(screen.getByText('Sign in again')).toBeTruthy();
    expect(screen.getByText('The refresh token was revoked.')).toBeTruthy();
    expect(screen.getByText('Needs sign-in')).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('Add another')).toBeTruthy();
    expect(screen.getByLabelText('Linear. Connected').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Search MCP servers'), 'no such vendor');
    expect(screen.getByText('No servers match your search.')).toBeTruthy();
  });

  it('opens the editor for a catalog entry and for a custom server', async () => {
    await render(<McpServersScreen />);
    expect(await screen.findByText('Connect your first MCP server')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add Sentry'));
    expect(mockPush).toHaveBeenLastCalledWith('/settings/mcp/new?catalog=sentry');
    await fireEvent.press(screen.getByLabelText('Add a server'));
    expect(mockPush).toHaveBeenLastCalledWith('/settings/mcp/new');
  });

  it('turns a server off and keeps its allow-lists', async () => {
    mockApi.list.mockResolvedValue([{ ...connectedServer, tools: [], repositoryIds: ['repo-a'] }]);
    await render(<McpServersScreen />);
    await fireEvent(await screen.findByLabelText('Use example'), 'valueChange', false);
    expect(mockApi.update).toHaveBeenCalledWith('srv-1', expect.objectContaining({ enabled: false, tools: [], repositoryIds: ['repo-a'] }));
    expect('secret' in lastBody(mockApi.update)).toBe(false);
  });

  it('says why a server could not be turned off', async () => {
    mockApi.list.mockResolvedValue([connectedServer]);
    mockApi.update.mockRejectedValue(apiError('The server is busy.', 503));
    await render(<McpServersScreen />);
    await fireEvent(await screen.findByLabelText('Use example'), 'valueChange', false);
    expect(Alert.alert).toHaveBeenCalledWith('Could not change that', 'The server is busy.');
  });

  it('asks before it removes a server', async () => {
    mockApi.list.mockResolvedValueOnce([connectedServer]);
    mockApi.remove.mockResolvedValue(undefined);
    await render(<McpServersScreen />);
    await fireEvent(await screen.findByLabelText('example. Connected'), 'longPress');
    await fireEvent.press(screen.getByLabelText('Remove'));
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Remove this MCP server?');
    await act(async () => { (buttons as { text: string; onPress?(): void }[]).find((button) => button.text === 'Remove')?.onPress?.(); });
    expect(mockApi.remove).toHaveBeenCalledWith('srv-1');
    await waitFor(() => expect(screen.queryByText('example')).toBeNull());
  });

  it('shows nothing to an account without the feature', async () => {
    mockFeatures = { mcpServers: false };
    await render(<McpServersScreen />);
    expect(screen.getByText('MCP servers are not available')).toBeTruthy();
    expect(mockApi.list).not.toHaveBeenCalled();
  });
});

describe('adding a server', () => {
  it('connects a custom address and loads its tools', async () => {
    mockApi.discoverAuth.mockResolvedValue({ methods: ['none'], source: 'server' });
    await render(<McpServerEditorScreen id="new" />);
    await fireEvent.changeText(await screen.findByLabelText('MCP server address'), 'https://tools.example.org/mcp');
    expect(await screen.findByText('No credential is needed for this connection.', {}, { timeout: 3000 })).toBeTruthy();
    expect(mockApi.discoverAuth).toHaveBeenCalledWith('ws-1', 'https://tools.example.org/mcp');
    await fireEvent.press(screen.getByLabelText('Connect'));
    expect(mockApi.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      name: 'tools-example-org', displayName: 'tools.example.org', url: 'https://tools.example.org/mcp', authKind: 'none',
      tools: null, repositoryIds: null, enabled: true,
    }));
    expect(mockApi.test).toHaveBeenCalledWith('srv-1');
    expect(await screen.findByText('Tools')).toBeTruthy();
    expect(screen.getByText('Repository access')).toBeTruthy();
  });

  it.each([
    ['https://mcp.polar.sh/mcp/polar-mcp?telemetry=false', /may not carry a query string/],
    ['https://user:pass@mcp.example.com/mcp', /put the credential in the key field/],
    ['ftp://mcp.example.com/mcp', /must be an https:\/\/ address/],
  ])('says why %s cannot connect while it is typed', async (address, reason) => {
    await render(<McpServerEditorScreen id="new" />);
    await fireEvent.changeText(await screen.findByLabelText('MCP server address'), address);
    expect(screen.getByRole('alert').props.children).toMatch(reason);
    expect(screen.queryByLabelText('Connect')).toBeNull();
    expect(screen.queryByText('Authentication')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('MCP server address'), 'htt');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockApi.discoverAuth).not.toHaveBeenCalled();
  });

  it('sends a pasted key from a catalog prefill and never keeps it', async () => {
    mockApi.discoverAuth.mockResolvedValue({ methods: ['bearer'], source: 'catalog' });
    await render(<McpServerEditorScreen id="new" catalog="github" />);
    const key = await screen.findByLabelText('Key', {}, { timeout: 3000 });
    expect(key.props.secureTextEntry).toBe(true);
    expect(screen.queryByLabelText('MCP server address')).toBeNull();
    await fireEvent.changeText(key, 'ghp_secret');
    await fireEvent.press(screen.getByLabelText('Connect'));
    expect(mockApi.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      name: 'github-mcp', url: 'https://api.githubcopilot.com/mcp/', catalogHandle: 'github', authKind: 'bearer', secret: 'ghp_secret',
    }));
  });

  it('shows the server’s refusal when the save fails', async () => {
    mockApi.discoverAuth.mockResolvedValue({ methods: ['none'], source: 'server' });
    mockApi.create.mockRejectedValue(apiError('another MCP server in this workspace already uses "tools-example-org"', 409));
    await render(<McpServerEditorScreen id="new" />);
    await fireEvent.changeText(await screen.findByLabelText('MCP server address'), 'https://tools.example.org/mcp');
    await screen.findByText('No credential is needed for this connection.', {}, { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Connect'));
    expect(await screen.findByText('another MCP server in this workspace already uses "tools-example-org"')).toBeTruthy();
    expect(mockApi.test).not.toHaveBeenCalled();
  });

  it('keeps tools hidden when the connection check fails', async () => {
    mockApi.discoverAuth.mockResolvedValue({ methods: ['none'], source: 'server' });
    mockApi.test.mockResolvedValue({ ok: false, at: '', detail: 'The credential was refused.' });
    await render(<McpServerEditorScreen id="new" />);
    await fireEvent.changeText(await screen.findByLabelText('MCP server address'), 'https://tools.example.org/mcp');
    await screen.findByText('No credential is needed for this connection.', {}, { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Connect'));
    expect(await screen.findByText('Could not connect. The credential was refused.')).toBeTruthy();
    expect(screen.queryByText('Tools')).toBeNull();
  });
});

describe('editing a server', () => {
  async function openConnected(patch: Partial<McpServerDefinition> = {}) {
    mockApi.list.mockResolvedValue([{ ...connectedServer, ...patch }, { ...server, id: 'srv-2', name: 'linear' }]);
    mockApi.discoverAuth.mockResolvedValue({ methods: ['bearer'], source: 'server' });
    await render(<McpServerEditorScreen id="srv-1" />);
    await screen.findByText('Repository access');
  }
  const save = async () => {
    await waitFor(() => expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(false), { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Save'));
  };

  it.each([
    ['only selected', ['repo-a', 'repo-b']],
    ['none', []],
  ] as const)('limits repositories to %s', async (_label, expected) => {
    await openConnected();
    await fireEvent.press(screen.getByLabelText('Only selected repositories'));
    if (expected.length === 0) {
      await fireEvent.press(screen.getByLabelText('Repositories. 2 of 2.'));
      expect(screen.queryByText('other/app')).toBeNull();
      await fireEvent.press(screen.getByLabelText('acme/api'));
      await fireEvent.press(screen.getByLabelText('acme/web'));
      expect(screen.getByText('No repository can access this server.')).toBeTruthy();
    }
    await save();
    expect(mockApi.update).toHaveBeenCalledWith('srv-1', expect.objectContaining({ repositoryIds: [...expected] }));
  });

  it('goes back to all repositories as null', async () => {
    await openConnected({ repositoryIds: [] });
    await fireEvent.press(screen.getByLabelText('All repositories'));
    await save();
    expect(lastBody(mockApi.update).repositoryIds).toBeNull();
  });

  it.each([
    ['all', null, null],
    ['a list without one tool', 'untick', ['search']],
    ['none', 'none', []],
  ] as const)('saves %s tools', async (_label, action, expected) => {
    await openConnected();
    if (action === 'untick') {
      await fireEvent.press(screen.getByLabelText('Choose tools. 2 of 2 on.'));
      expect(screen.getByText('Search documents.')).toBeTruthy();
      await fireEvent.press(screen.getByLabelText('Enable read'));
    } else if (action === 'none') {
      await fireEvent(screen.getByLabelText('All tools'), 'valueChange', false);
      await fireEvent.press(screen.getByLabelText('Choose tools. 2 of 2 on.'));
      await fireEvent.press(screen.getByLabelText('Enable read'));
      await fireEvent.press(screen.getByLabelText('Enable search'));
      expect(screen.getByText('Nothing is ticked, so this server will be connected with no tools at all.')).toBeTruthy();
    } else {
      await fireEvent.changeText(screen.getByLabelText('Display name'), 'Example (work)');
    }
    await save();
    expect(lastBody(mockApi.update).tools).toEqual(expected);
  });

  it('turns the server off with Save', async () => {
    await openConnected();
    await fireEvent(screen.getByLabelText('On'), 'valueChange', false);
    await save();
    expect(mockApi.update).toHaveBeenCalledWith('srv-1', expect.objectContaining({ enabled: false }));
  });

  it('refuses an identifier another server uses', async () => {
    await openConnected();
    await fireEvent.changeText(screen.getByLabelText('Identifier'), 'Linear');
    expect(screen.getByLabelText('Identifier').props.value).toBe('linear');
    expect(screen.getByRole('alert').props.children).toMatch(/already uses "linear"/);
    await save();
    expect(mockApi.update).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal when the save fails', async () => {
    mockApi.update.mockRejectedValue(apiError('"x" is not a header name', 400));
    await openConnected();
    await fireEvent.changeText(screen.getByLabelText('Display name'), 'Example');
    await save();
    expect(await screen.findByText('"x" is not a header name')).toBeTruthy();
  });
});

describe('OAuth sign-in', () => {
  const flow = { flowId: 'flow-1', authorizeUrl: 'https://auth.example.com/authorize', expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [] };

  async function startSignIn() {
    mockApi.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    await render(<McpServerEditorScreen id="new" catalog="sentry" />);
    const button = await screen.findByLabelText('Connect account', {}, { timeout: 3000 });
    await fireEvent.press(button);
  }

  it('saves, opens the browser with the app return link, polls and loads tools', async () => {
    mockApi.startSignIn.mockResolvedValue(flow);
    mockApi.signInStatus.mockResolvedValue({ status: 'connected', pending: false });
    mockApi.test.mockResolvedValue({ ok: true, at: '', toolNames: ['search_issues'] });
    await startSignIn();
    expect(mockApi.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({ catalogHandle: 'sentry', authKind: 'bearer' }));
    expect(mockApi.startSignIn).toHaveBeenCalledWith('srv-1', { returnTo: 'talyn-mobile://' });
    expect(mockOpenFlow).toHaveBeenCalledWith('https://auth.example.com/authorize', 'mcp');
    expect(await screen.findByText('Signed in.')).toBeTruthy();
    expect(mockApi.signInStatus).toHaveBeenCalledWith('srv-1', 'flow-1');
    expect(mockApi.get).toHaveBeenCalledWith('srv-1');
    await waitFor(() => expect(mockApi.test).toHaveBeenCalledWith('srv-1'));
    expect(await screen.findByText('Tools')).toBeTruthy();
  });

  it('starts again without the return link on an older backend', async () => {
    mockApi.startSignIn.mockRejectedValueOnce(apiError('returnTo is not allowed', 400, 'invalid_return_to')).mockResolvedValueOnce(flow);
    mockApi.signInStatus.mockResolvedValue({ status: 'connected', pending: false });
    await startSignIn();
    expect(await screen.findByText('Signed in.')).toBeTruthy();
    expect(mockApi.startSignIn.mock.calls).toEqual([['srv-1', { returnTo: 'talyn-mobile://' }], ['srv-1', undefined]]);
  });

  it('shows why the sign-in failed', async () => {
    mockApi.startSignIn.mockResolvedValue(flow);
    mockApi.signInStatus.mockResolvedValue({ status: 'pending', pending: false, detail: 'The grant was refused.' });
    await startSignIn();
    expect(await screen.findByText('The grant was refused.')).toBeTruthy();
    expect(screen.getByLabelText('Connect account')).toBeTruthy();
  });

  it('shows a start failure', async () => {
    mockApi.startSignIn.mockRejectedValue(apiError('The vendor refused to register a client.', 502));
    await startSignIn();
    expect(await screen.findByText('The vendor refused to register a client.')).toBeTruthy();
    expect(mockOpenFlow).not.toHaveBeenCalled();
  });

  it('disconnects a connected account', async () => {
    mockApi.list.mockResolvedValue([{ ...connectedServer, oauth: { status: 'connected' } }]);
    mockApi.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    mockApi.account.mockResolvedValue({ name: 'Tom', email: 'tom@example.com', workspace: 'Example workspace' });
    mockApi.disconnect.mockResolvedValue({ ...server, oauth: null });
    await render(<McpServerEditorScreen id="srv-1" />);
    expect(await screen.findByText('Signed in as Tom · tom@example.com')).toBeTruthy();
    expect(screen.getByText('Workspace: Example workspace')).toBeTruthy();
    await waitFor(() => expect(mockApi.discoverAuth).toHaveBeenCalled(), { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Disconnect'));
    expect(mockApi.disconnect).toHaveBeenCalledWith('srv-1');
    expect(await screen.findByLabelText('Connect account')).toBeTruthy();
  });
});
