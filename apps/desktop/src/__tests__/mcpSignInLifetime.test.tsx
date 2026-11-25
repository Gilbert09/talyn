import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpServerDefinition, McpServerInput } from '@talyn/shared';
import { McpServerEditorPage } from '../renderer/components/panels/mcpServers/McpServerEditorPage';

/**
 * The loopback listener must outlive the editor page. For the hosted callback
 * the browser finishes sign-in on its own; for the loopback one, the listener
 * is the only way the code reaches the backend.
 */

const mockApi = {
  discoverAuth: jest.fn(),
  signInStatus: jest.fn(),
  account: jest.fn(),
  disconnect: jest.fn(),
};
const mockStartMcpSignIn = jest.fn();
const mockClose = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  api: {
    mcpServers: new Proxy({}, { get: (_t, key: string) => (...args: unknown[]) => (mockApi as Record<string, jest.Mock>)[key]?.(...args) }),
    workspaces: { privateConnector: { get: () => Promise.resolve({ routes: [] }) } },
  },
}));
jest.mock('../renderer/lib/mcpSignIn', () => ({ startMcpSignIn: (...args: unknown[]) => mockStartMcpSignIn(...args) }));
jest.mock('../renderer/lib/openExternal', () => ({
  openExternal: jest.fn(),
  prepareSignInWindow: () => ({ open: () => Promise.resolve(true), close: () => undefined }),
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (pick: (state: { currentWorkspaceId: string; repositories: unknown[] }) => unknown) =>
    pick({ currentWorkspaceId: 'ws-1', repositories: [] }),
}));

const url = 'https://mcp.example.com/mcp';
const server: McpServerDefinition = {
  id: 'srv-1',
  workspaceId: 'ws-1',
  name: 'example',
  url,
  authKind: 'bearer',
  inject: null,
  hasSecret: false,
  oauth: null,
  enabled: true,
  tools: null,
  catalogHandle: null,
  displayName: null,
  description: null,
  lastProbe: null,
  createdAt: '',
  updatedAt: '',
};
const initial: McpServerInput = { name: 'example', url, authKind: 'bearer', enabled: true };

function setup() {
  return render(
    <McpServerEditorPage
      editing={null}
      initial={initial}
      onCancel={jest.fn()}
      onSave={jest.fn().mockResolvedValue(server)}
      onTest={jest.fn()}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
  mockApi.account.mockResolvedValue(null);
  mockStartMcpSignIn.mockResolvedValue({
    flow: {
      authorizeUrl: 'https://auth.example.com/authorize',
      flowId: 'flow-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: [],
    },
    close: mockClose,
  });
});

describe('MCP sign-in listener lifetime', () => {
  it.each([
    ['connected', { status: 'connected', pending: false }],
    ['refused', { status: 'pending', pending: false, detail: 'The grant was refused.' }],
  ])('closes the listener when the sign-in finishes (%s)', async (_name, status) => {
    mockApi.signInStatus.mockResolvedValue(status);
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(mockStartMcpSignIn).toHaveBeenCalledWith('srv-1');
  });

  it('keeps the listener open when the page closes mid-sign-in', async () => {
    mockApi.signInStatus.mockResolvedValue({ status: 'pending', pending: true });
    const view = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(mockStartMcpSignIn).toHaveBeenCalled());
    view.unmount();
    // Past one poll tick, where the superseded loop returns through `finally`.
    await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
    expect(mockClose).not.toHaveBeenCalled();
  });
});
