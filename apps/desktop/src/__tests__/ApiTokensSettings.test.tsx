import { trackEvent, captureAnalyticsException } from '../renderer/lib/analytics';
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiToken } from '@talyn/shared';
import { ApiTokensSettings } from '../renderer/components/settings/sections/ApiTokensSettings';

const mockList = jest.fn();
const mockCreate = jest.fn();
const mockRevoke = jest.fn();
const mockOpenExternal = jest.fn();
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
const mockState: { features: { publicApi?: boolean; spaces?: boolean } | null } = { features: { publicApi: true } };
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({
  api: {
    apiTokens: {
      list: (...a: unknown[]) => mockList(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      revoke: (...a: unknown[]) => mockRevoke(...a),
    },
  },
}));
jest.mock('../renderer/lib/openExternal', () => ({
  openExternal: (...a: unknown[]) => mockOpenExternal(...a),
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
    info: (...a: unknown[]) => mockToast.info(...a),
  },
}));

const mockWorkspaces = [
  { id: 'ws1', name: 'Alpha' },
  { id: 'ws2', name: 'Beta' },
];
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ features: mockState.features, workspaces: mockWorkspaces }),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inDays = (days: number) => new Date(Date.now() + days * DAY + HOUR).toISOString();
const SECRET = 'talyn_pat_SECRET_VALUE';
const CURL = `curl https://api.talyn.dev/v1/me -H "Authorization: Bearer ${SECRET}"`;

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: 't1',
  name: 'CI script',
  tokenPrefix: 'talyn_pat_ab12',
  scopes: ['workspaces:read'],
  workspaceIds: null,
  createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /create token/i }));
  return screen.getByRole('dialog', { name: 'Create API token' });
};
const fillName = (value: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value } });
const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /create token/i });
const pick = (resource: string, level: string) =>
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: `${resource} access` })).getByRole('radio', { name: level }),
  );

beforeEach(() => {
  mockState.features = { publicApi: true };
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({ token: SECRET, apiToken: token({ id: 'new', name: 'Once' }) });
  mockRevoke.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('ApiTokensSettings visibility', () => {
  it('draws nothing when the flag is off and there are no tokens', async () => {
    mockState.features = { publicApi: false };
    const { container } = render(<ApiTokensSettings />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists tokens and keeps revoke, with no create button, when the flag is off', async () => {
    mockState.features = { publicApi: false };
    mockList.mockResolvedValue([token()]);
    render(<ApiTokensSettings />);
    expect(await screen.findByText('CI script')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create token/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke CI script' })).toBeInTheDocument();
    expect(screen.getByText(/cannot create new tokens/i)).toBeInTheDocument();
  });

  it('shows an empty state with one create button', async () => {
    render(<ApiTokensSettings />);
    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /create token/i })).toHaveLength(1);
  });

  it('shows one create button in the header when there are tokens', async () => {
    mockList.mockResolvedValue([token()]);
    render(<ApiTokensSettings />);
    await screen.findByText('CI script');
    expect(screen.getAllByRole('button', { name: /create token/i })).toHaveLength(1);
    expect(screen.queryByText('No API tokens yet')).toBeNull();
  });

  it('shows a load error inline and retries', async () => {
    mockList.mockRejectedValueOnce(new Error('Network down'));
    render(<ApiTokensSettings />);
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('opens the OpenAPI reference', async () => {
    render(<ApiTokensSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /api reference/i }));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://api.talyn.dev/v1/openapi.json');
  });
});

describe('ApiTokensSettings create', () => {
  it('sends Teams and Spaces scopes with Full access when Spaces is offered', async () => {
    mockState.features = { publicApi: true, spaces: true };
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    expect(screen.getByRole('radiogroup', { name: 'Teams access' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Spaces access' })).toBeInTheDocument();
    fillName('Scoped');
    fireEvent.click(screen.getByRole('button', { name: 'Full access' }));
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].scopes).toEqual([
      'workspaces:read', 'teams:read', 'spaces:read', 'spaces:write',
      'repositories:read', 'sessions:read', 'sessions:write',
    ]);
  });

  it('sends the defaults: read access, all workspaces, 90 days', async () => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('  My token ');
    fireEvent.click(submitButton(dialog));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'My token',
        scopes: ['workspaces:read', 'repositories:read', 'sessions:read'],
        workspaceIds: null,
        expiresInDays: 90,
      }),
    );
  });

  it.each<[string, () => void, string[]]>([
    [
      'the Full access preset',
      () => fireEvent.click(screen.getByRole('button', { name: 'Full access' })),
      ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write'],
    ],
    [
      'Read only after Full access',
      () => {
        fireEvent.click(screen.getByRole('button', { name: 'Full access' }));
        fireEvent.click(screen.getByRole('button', { name: 'Read only' }));
      },
      ['workspaces:read', 'repositories:read', 'sessions:read'],
    ],
    [
      'sessions read and write only',
      () => {
        pick('Workspaces', 'None');
        pick('Repositories', 'None');
        pick('Sessions', 'Read & write');
      },
      ['sessions:read', 'sessions:write'],
    ],
    [
      'repositories only',
      () => {
        pick('Workspaces', 'None');
        pick('Sessions', 'None');
      },
      ['repositories:read'],
    ],
  ])('sends the scopes for %s', async (_label, act, expected) => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('Scoped');
    act();
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].scopes).toEqual(expected);
  });

  it('offers write only where the API has a write scope', async () => {
    render(<ApiTokensSettings />);
    await openDialog();
    const options = (resource: string) =>
      within(screen.getByRole('radiogroup', { name: `${resource} access` }))
        .getAllByRole('radio')
        .map((r) => r.textContent);
    expect(options('Workspaces')).toEqual(['None', 'Read']);
    expect(options('Repositories')).toEqual(['None', 'Read', 'Read & write']);
    expect(options('Sessions')).toEqual(['None', 'Read', 'Read & write']);
  });

  it('sends one picked workspace', async () => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('Scoped');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws2' } });
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].workspaceIds).toEqual(['ws2']);
  });

  it.each([
    ['30', 30],
    ['90', 90],
    ['365', 365],
    ['none', null],
  ])('sends expiry %s as %s', async (value, expected) => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('Expiry');
    fireEvent.change(screen.getByLabelText('Expires after'), { target: { value } });
    const warning = screen.queryByText(/stays valid until you revoke it/i);
    if (value === 'none') expect(warning).toBeInTheDocument();
    else expect(warning).toBeNull();
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].expiresInDays).toBe(expected);
    expect(trackEvent).toHaveBeenCalledWith('api_token_created', { scopes_count: 3, expiry_set: value !== 'none' });
  });

  it('keeps Create off with no name, or with no access picked', async () => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    expect(submitButton(dialog)).toBeDisabled();
    fillName('   ');
    expect(submitButton(dialog)).toBeDisabled();
    fillName('x');
    expect(submitButton(dialog)).toBeEnabled();
    pick('Workspaces', 'None');
    pick('Repositories', 'None');
    pick('Sessions', 'None');
    expect(submitButton(dialog)).toBeDisabled();
    expect(screen.getByText(/access to at least one thing/i)).toBeInTheDocument();
  });

  it('shows the server error in the dialog and no token', async () => {
    mockCreate.mockRejectedValue(new Error('Public API is not available'));
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('Nope');
    fireEvent.click(submitButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Public API is not available');
    expect(screen.queryByTestId('api-token-plaintext')).toBeNull();
  });

  it.each<[string, () => void]>([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
  ])('closes the form with %s and sends nothing', async (_label, close) => {
    render(<ApiTokensSettings />);
    await openDialog();
    close();
    expect(screen.queryByRole('dialog', { name: 'Create API token' })).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('ApiTokensSettings new token', () => {
  const createOnce = async () => {
    render(<ApiTokensSettings />);
    const dialog = await openDialog();
    fillName('Once');
    fireEvent.click(submitButton(dialog));
    return screen.findByTestId('api-token-plaintext');
  };

  it('shows the token once with a curl example, and adds the row', async () => {
    expect(await createOnce()).toHaveTextContent(SECRET);
    expect(screen.getByText(/won't see this token again/i)).toBeInTheDocument();
    expect(screen.getByText(CURL)).toBeInTheDocument();
    expect(screen.getAllByTestId('api-token-row')).toHaveLength(1);
    expect(trackEvent).toHaveBeenCalledWith('api_token_created', { scopes_count: 3, expiry_set: true });
  });

  it.each([
    ['Copy token', SECRET, 'Token copied'],
    ['Copy curl command', CURL, 'Command copied'],
  ])('%s copies the right text', async (button, text, message) => {
    await createOnce();
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text));
    expect(mockToast.success).toHaveBeenCalledWith(message);
  });

  it('reports a clipboard failure', async () => {
    await createOnce();
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not copy to clipboard'));
  });

  it('ignores Escape on the token step, and Done drops the secret', async () => {
    await createOnce();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('api-token-plaintext')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
  });

  it('opens a blank form after Done', async () => {
    await createOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.queryByTestId('api-token-plaintext')).toBeNull();
  });

  it('is gone after a remount', async () => {
    await createOnce();
    cleanup();
    render(<ApiTokensSettings />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
  });
});

describe('ApiTokensSettings list', () => {
  it('renders prefix, workspace binding and dates', async () => {
    mockList.mockResolvedValue([
      token(),
      token({
        id: 't2',
        name: 'Scoped',
        workspaceIds: ['ws1', 'ws2', 'gone'],
        lastUsedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        expiresAt: inDays(60),
      }),
    ]);
    render(<ApiTokensSettings />);
    const rows = await screen.findAllByTestId('api-token-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('talyn_pat_ab12…')).toBeInTheDocument();
    expect(within(rows[0]).getByText('All workspaces')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Created 3 days ago')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Never used')).toBeInTheDocument();
    expect(within(rows[0]).getByText('No expiry')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Alpha, Beta, Unknown workspace')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Last used 2 hours ago')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Expires in 2 months')).toBeInTheDocument();
  });

  it.each<[ApiToken['scopes'], string[]]>([
    [['workspaces:read'], ['Workspaces: read']],
    [['sessions:read', 'sessions:write'], ['Sessions: read & write']],
    [['sessions:write'], ['Sessions: read & write']],
    [
      ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write'],
      ['Workspaces: read', 'Repositories: read', 'Sessions: read & write'],
    ],
  ])('collapses scopes %j into %j', async (scopes, chips) => {
    mockList.mockResolvedValue([token({ scopes })]);
    render(<ApiTokensSettings />);
    const row = await screen.findByTestId('api-token-row');
    for (const chip of chips) expect(within(row).getByText(chip)).toBeInTheDocument();
    expect(within(row).queryByText('Sessions: read')).toBeNull();
  });

  it.each<[string, string, RegExp, 'expired' | 'soon' | 'normal']>([
    ['expired', '2020-01-01T00:00:00.000Z', /^Expired /, 'expired'],
    ['expiring in 3 days', inDays(3), /^Expires in 3 days$/, 'soon'],
    ['expiring in 30 days', inDays(30), /^Expires in 1 month$/, 'normal'],
  ])('marks a token %s', async (_label, expiresAt, text, tone) => {
    mockList.mockResolvedValue([token({ expiresAt })]);
    render(<ApiTokensSettings />);
    const row = await screen.findByTestId('api-token-row');
    const expiry = within(row).getByText(text);
    expect(within(row).queryByText('Expired') !== null).toBe(tone === 'expired');
    expect(expiry.classList.contains('text-destructive')).toBe(tone === 'expired');
    expect(expiry.classList.contains('text-amber-600')).toBe(tone === 'soon');
  });
});

describe('ApiTokensSettings revoke', () => {
  it('asks in the app, never with window.confirm, and Cancel keeps the token', async () => {
    mockList.mockResolvedValue([token()]);
    const confirm = jest.spyOn(window, 'confirm');
    render(<ApiTokensSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke CI script' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Revoke "CI script"?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('revokes on confirm and removes the row', async () => {
    mockList.mockResolvedValue([token(), token({ id: 't2', name: 'Other' })]);
    render(<ApiTokensSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke CI script' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByText('CI script')).toBeNull());
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Token revoked');
    expect(trackEvent).toHaveBeenCalledWith('api_token_revoked');
  });

  it('keeps the row and reports the error when revoke fails', async () => {
    mockList.mockResolvedValue([token()]);
    mockRevoke.mockRejectedValue(new Error('Token not found'));
    render(<ApiTokensSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke CI script' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Token not found'));
    expect(screen.getAllByTestId('api-token-row')).toHaveLength(1);
    expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), { flow: 'api_token_revoke' });
  });
});
