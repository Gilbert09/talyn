import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mcpServerFromCatalog,
  mcpCatalogEntry,
  type McpAuthDiscovery,
  type McpServerDefinition,
  type McpServerInput,
} from '@talyn/shared';
import { McpServerEditorPage } from './McpServerEditorPage';

const mocks = vi.hoisted(() => ({
  discoverAuth: vi.fn(),
  startSignIn: vi.fn(),
  signInStatus: vi.fn(),
  disconnect: vi.fn(),
  account: vi.fn(),
  openExternal: vi.fn(),
  openSignIn: vi.fn(),
  closeSignIn: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: { mcpServers: mocks } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: mocks.openExternal, prepareSignInWindow: () => ({ open: mocks.openSignIn, close: mocks.closeSignIn }) }));
vi.mock('../../../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: { currentWorkspaceId: string }) => unknown) =>
    selector({ currentWorkspaceId: 'ws-1' }),
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
const onSave = vi.fn();
const onTest = vi.fn();
function setup(
  editing: McpServerDefinition | null = null,
  initial: McpServerInput | undefined = { name: 'example', url, authKind: 'bearer', enabled: true }
) {
  return render(
    <McpServerEditorPage
      editing={editing}
      initial={initial}
      onCancel={vi.fn()}
      onSave={onSave}
      onTest={onTest}
    />
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.openSignIn.mockResolvedValue(true);
  mocks.account.mockResolvedValue(null);
  onSave.mockResolvedValue(server);
  onTest.mockResolvedValue({ ok: true, at: '', toolNames: ['read_documents'] });
});
afterEach(cleanup);

describe('MCP authentication setup', () => {
  it.each(['oauth', 'none', 'bearer'] as const)(
    'shows only the detected %s method',
    async (method) => {
      mocks.discoverAuth.mockResolvedValue({ methods: [method], source: 'server' });
      setup();
      await waitFor(() => expect(mocks.discoverAuth).toHaveBeenCalledWith('ws-1', url));
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByPlaceholderText('Paste the key') !== null).toBe(method === 'bearer');
      expect(screen.queryByRole('button', { name: 'Connect account' }) !== null).toBe(
        method === 'oauth'
      );
    }
  );

  it('offers a choice only when the server has multiple methods', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth', 'bearer'], source: 'server' });
    setup();
    const select = await screen.findByRole('combobox');
    expect(Array.from(select.querySelectorAll('option')).map((option) => option.value)).toEqual([
      'oauth',
      'bearer',
    ]);
    fireEvent.change(select, { target: { value: 'bearer' } });
    expect(screen.getByPlaceholderText('Paste the key')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect account' })).toBeNull();
  });

  it('prefills a known header and hides its technical name', async () => {
    mocks.discoverAuth.mockResolvedValue({
      methods: ['header'],
      source: 'catalog',
      inject: { header: 'CONTEXT7_API_KEY' },
    });
    setup();
    await screen.findByPlaceholderText('Paste the key');
    expect(screen.queryByPlaceholderText('X-Api-Key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ authKind: 'header', inject: { header: 'CONTEXT7_API_KEY' } })
      )
    );
  });

  it('keeps manual setup for servers without usable metadata', async () => {
    mocks.discoverAuth.mockResolvedValue({
      methods: [],
      source: 'unknown',
      detail: 'Use manual setup.',
    });
    setup();
    const select = await screen.findByRole('combobox');
    expect(select.querySelectorAll('option')).toHaveLength(6);
    fireEvent.change(select, { target: { value: 'header' } });
    expect(screen.getByPlaceholderText('X-Api-Key')).toBeTruthy();
  });

  it('does not replace an existing API key with OAuth automatically', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    setup({ ...server, hasSecret: true });
    await screen.findByPlaceholderText(/unchanged/);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ authKind: 'bearer' }))
    );
    expect(onSave.mock.calls[0][0].secret).toBeUndefined();
  });

  it('ignores a late discovery response for an old address', async () => {
    let resolveOld!: (result: McpAuthDiscovery) => void;
    mocks.discoverAuth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    mocks.discoverAuth.mockResolvedValueOnce({ methods: ['none'], source: 'server' });
    setup();
    await waitFor(() => expect(mocks.discoverAuth).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('https://mcp.linear.app/mcp'), {
      target: { value: 'https://other.example.com/mcp' },
    });
    await screen.findByText('No credential is needed for this connection.');
    await act(async () => resolveOld({ methods: ['oauth'], source: 'server' }));
    expect(screen.queryByRole('button', { name: 'Connect account' })).toBeNull();
  });

  it.each([true, false])('opens sign-in automatically with a fallback when needed: %s', async (opened) => {
    mocks.openSignIn.mockResolvedValue(opened);
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    mocks.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.example.com/authorize',
      flowId: 'flow-1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    mocks.signInStatus.mockResolvedValue({ status: 'connected', pending: false });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(mocks.openSignIn).toHaveBeenCalledWith('https://auth.example.com/authorize'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ authKind: 'bearer' }));
    expect(mocks.startSignIn).toHaveBeenCalledWith('srv-1');
    if (opened) {
      expect(screen.queryByRole('button', { name: 'Continue in browser' })).toBeNull();
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Continue in browser' }));
      expect(mocks.openExternal).toHaveBeenCalledWith('https://auth.example.com/authorize');
    }
    await screen.findByText('Signed in.', {}, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Continue in browser' })).toBeNull();
  });

  it('reports a failed OAuth callback instead of polling until timeout', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    mocks.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.example.com/authorize',
      flowId: 'flow-1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    mocks.signInStatus.mockResolvedValue({
      status: 'pending',
      pending: false,
      detail: 'The grant was refused.',
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }));
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toBe(
      'The grant was refused.'
    );
  });
});

describe('guided MCP setup', () => {
  it('shows only authentication for a catalog connection', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['bearer'], source: 'catalog' });
    setup(null, mcpServerFromCatalog(mcpCatalogEntry('github')!));
    await screen.findByPlaceholderText('Paste the key');
    expect(screen.queryByPlaceholderText('https://mcp.linear.app/mcp')).toBeNull();
    expect(screen.queryByText('Name')).toBeNull();
    expect(screen.queryByText('What it is for')).toBeNull();
    expect(screen.queryByText('Tools')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Paste the key'), { target: { value: 'token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'github-mcp',
          url: 'https://api.githubcopilot.com/mcp/',
          catalogHandle: 'github',
        })
      )
    );
    await screen.findByText('Tools');
    expect(onTest).toHaveBeenCalledWith('srv-1');
  });

  it('starts a custom connection with only the address field', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['none'], source: 'server' });
    setup(null, { name: '', url: '', authKind: 'bearer', enabled: true });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByText('Authentication')).toBeNull();
    expect(screen.queryByText('Tools')).toBeNull();
    expect(mocks.discoverAuth).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('https://mcp.linear.app/mcp'), {
      target: { value: 'https://tools.example.org/mcp' },
    });
    await screen.findByText('No credential is needed for this connection.');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tools-example-org',
          displayName: 'tools.example.org',
          url: 'https://tools.example.org/mcp',
          authKind: 'none',
        })
      )
    );
    await screen.findByText('Tools');
  });

  it('keeps tools hidden when the connection check fails', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['bearer'], source: 'server' });
    onTest.mockResolvedValue({ ok: false, at: '', detail: 'The credential was refused.' });
    setup();
    await screen.findByPlaceholderText('Paste the key');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText(/The credential was refused/);
    expect(screen.queryByText('Tools')).toBeNull();
  });

  it('loads tools after OAuth succeeds', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    mocks.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.example.com/authorize',
      flowId: 'flow-1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    mocks.signInStatus.mockResolvedValue({ status: 'connected', pending: false });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }));
    expect(screen.queryByText('Tools')).toBeNull();
    await screen.findByText('Tools', {}, { timeout: 3000 });
    expect(onTest).toHaveBeenCalledWith('srv-1');
  });
  it('loads tools when an existing OAuth connection has no probe', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
    setup({ ...server, oauth: { status: 'connected' } });
    await waitFor(() => expect(onTest).toHaveBeenCalledTimes(1));
    await screen.findByRole('switch', { name: 'Enable read_documents' });
    expect(screen.getByText('Tools')).toBeTruthy();
  });

  it('does not show old tools after the address changes during a connection check', async () => {
    mocks.discoverAuth.mockResolvedValue({ methods: ['none'], source: 'server' });
    let finish!: (value: unknown) => void;
    onTest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    setup();
    await screen.findByText('No credential is needed for this connection.');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onTest).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('https://mcp.linear.app/mcp'), {
      target: { value: 'https://other.example.org/mcp' },
    });
    await act(async () => finish({ ok: true, at: '', toolNames: ['old_tool'] }));
    expect(screen.queryByText('Tools')).toBeNull();
  });
});


it('shows the account and compact tool controls after connection', async () => {
  mocks.discoverAuth.mockResolvedValue({ methods: ['oauth'], source: 'server' });
  mocks.account.mockResolvedValue({ name: 'Tom', email: 'tom@example.com' });
  setup({ ...server, oauth: { status: 'connected' }, lastProbe: {
    ok: true, at: '', toolNames: ['search', 'read'], tools: [
      { name: 'search', description: '**Search documents.**' },
      { name: 'read', description: 'Read documents.' },
    ],
  } });
  await screen.findByText('Signed in as Tom · tom@example.com');
  expect(screen.queryByText('Authentication')).toBeNull();
  expect(screen.queryByText('Connection settings')).toBeNull();
  expect(screen.queryByText(/Connected to the server/)).toBeNull();
  const toggle = screen.getByRole('switch', { name: 'Enable search' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getAllByText('Search documents.').every((element) => element.tagName === 'STRONG')).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('switch', { name: 'Enable read' }).getAttribute('aria-checked')).toBe('true');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tools: ['read'] })));
});
