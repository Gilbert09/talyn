import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiToken } from '@talyn/shared';
import { ApiTokensSettings } from '../components/settings/sections/ApiTokensSettings';

const { mockList, mockCreate, mockRevoke, state } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockRevoke: vi.fn(),
  state: { features: { publicApi: true } as { publicApi?: boolean } | null },
}));
vi.mock('../lib/api', () => ({
  api: {
    apiTokens: {
      list: mockList,
      create: mockCreate,
      revoke: mockRevoke,
    },
  },
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const workspaces = [
  { id: 'ws1', name: 'Alpha' },
  { id: 'ws2', name: 'Beta' },
];
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ features: state.features, workspaces }),
}));

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: 't1',
  name: 'CI script',
  tokenPrefix: 'tly_abc123',
  scopes: ['workspaces:read'],
  workspaceIds: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

const fillName = (value: string) =>
  fireEvent.change(screen.getByLabelText('Name'), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create token/i }));

beforeEach(() => {
  state.features = { publicApi: true };
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({ token: 'tly_SECRET_VALUE', apiToken: token() });
  mockRevoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ApiTokensSettings visibility', () => {
  it('draws nothing when the flag is off and there are no tokens', async () => {
    state.features = { publicApi: false };
    const { container } = render(<ApiTokensSettings />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it('lists existing tokens without the create form when the flag is off', async () => {
    state.features = { publicApi: false };
    mockList.mockResolvedValue([token()]);
    render(<ApiTokensSettings />);
    expect(await screen.findByText('CI script')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});

describe('ApiTokensSettings create', () => {
  it('sends the defaults: three read scopes, all workspaces, 90 days', async () => {
    render(<ApiTokensSettings />);
    fillName('  My token ');
    submit();
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'My token',
        scopes: ['workspaces:read', 'repositories:read', 'sessions:read'],
        workspaceIds: null,
        expiresInDays: 90,
      }),
    );
  });

  it('sends picked workspaces and an added write scope', async () => {
    render(<ApiTokensSettings />);
    fillName('Scoped');
    fireEvent.click(screen.getByLabelText('Start sessions and send messages'));
    fireEvent.click(screen.getByLabelText('Only these workspaces'));
    fireEvent.click(screen.getByLabelText('Beta'));
    submit();
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      workspaceIds: ['ws2'],
      scopes: ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write'],
    });
  });

  it.each([
    ['30', 30],
    ['365', 365],
    ['none', null],
  ])('sends expiry %s as %s', async (value, expected) => {
    render(<ApiTokensSettings />);
    fillName('Expiry');
    fireEvent.change(screen.getByLabelText('Expires after'), { target: { value } });
    if (value === 'none') {
      expect(screen.getByText(/stays valid until you revoke it/i)).toBeTruthy();
    }
    submit();
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].expiresInDays).toBe(expected);
  });

  it('keeps the button off with no name or no workspace picked', () => {
    render(<ApiTokensSettings />);
    expect((screen.getByRole('button', { name: /create token/i }) as HTMLButtonElement).disabled).toBe(true);
    fillName('x');
    expect((screen.getByRole('button', { name: /create token/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Only these workspaces'));
    expect((screen.getByRole('button', { name: /create token/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server error on failure and no token', async () => {
    mockCreate.mockRejectedValue(new Error('Public API is not available'));
    render(<ApiTokensSettings />);
    fillName('Nope');
    submit();
    expect(await screen.findByText(/Public API is not available/)).toBeTruthy();
    expect(screen.queryByTestId('api-token-plaintext')).toBeNull();
  });
});

describe('ApiTokensSettings plaintext', () => {
  it('shows the token once, with a curl example, and drops it on Done', async () => {
    render(<ApiTokensSettings />);
    fillName('Once');
    submit();
    expect((await screen.findByTestId('api-token-plaintext')).textContent).toBe('tly_SECRET_VALUE');
    expect(screen.getByText(/You cannot see it again/)).toBeTruthy();
    expect(
      screen.getByText('curl https://api.talyn.dev/v1/me -H "Authorization: Bearer tly_SECRET_VALUE"'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/tly_SECRET_VALUE/)).toBeNull();
  });

  it('is gone after a remount', async () => {
    const first = render(<ApiTokensSettings />);
    fillName('Once');
    submit();
    await screen.findByTestId('api-token-plaintext');
    first.unmount();
    render(<ApiTokensSettings />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/tly_SECRET_VALUE/)).toBeNull();
  });
});

describe('ApiTokensSettings list and revoke', () => {
  it('renders prefix, Never for last used, workspace names and Expired', async () => {
    mockList.mockResolvedValue([
      token(),
      token({
        id: 't2',
        name: 'Old',
        workspaceIds: ['ws1', 'ws2'],
        lastUsedAt: '2026-10-02T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ]);
    render(<ApiTokensSettings />);
    expect(await screen.findByText('Old')).toBeTruthy();
    expect(screen.getAllByText('tly_abc123…')).toHaveLength(2);
    expect(screen.getAllByText('Never', { selector: 'div' })).toHaveLength(2);
    expect(screen.getByText(/Alpha, Beta/)).toBeTruthy();
    expect(screen.getByText(/^Expired /)).toBeTruthy();
    expect(screen.getByText(/Workspaces:\s*All/)).toBeTruthy();
  });

  it('revokes after confirm and does nothing when cancelled', async () => {
    mockList.mockResolvedValue([token()]);
    const confirm = vi.spyOn(window, 'confirm');
    render(<ApiTokensSettings />);
    const button = await screen.findByRole('button', { name: /revoke/i });

    confirm.mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(mockRevoke).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(button);
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('t1'));
    confirm.mockRestore();
  });
});
