import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SpacesTeam, TeamInvitePreview } from '@talyn/shared';
import { AcceptInvite } from '../routes/AcceptInvite';
import { PendingInviteDialog } from '../components/spaces/PendingInviteDialog';
import { readPendingInvite, rememberPendingInvite } from '../lib/pendingInvite';
import { useSpacesStore } from '../stores/spaces';
import { toast } from '../stores/toast';

const { teamsApi } = vi.hoisted(() => ({ teamsApi: { previewInvite: vi.fn(), acceptInvite: vi.fn() } }));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { teams: teamsApi },
}));
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { ApiError } = await import('../lib/api');

const PREVIEW: TeamInvitePreview = {
  teamId: 't1',
  teamName: 'Acme',
  invitedByLogin: 'ana',
  email: 'bob@example.com',
  expiresAt: '2026-11-15T00:00:00Z',
  alreadyMember: false,
};
const TEAM = { id: 't1', name: 'Acme', role: 'member', homeWorkspaceId: null, spaces: [] } as unknown as SpacesTeam;

function Location() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSpacesStore.setState({ teams: [] } as never);
});
afterEach(cleanup);

describe('AcceptInvite', () => {
  it('stores the token and redirects home', () => {
    render(
      <MemoryRouter initialEntries={['/invite/tok-123']}>
        <Routes>
          <Route path="/invite/:token" element={<AcceptInvite />} />
          <Route path="/" element={<Location />} />
        </Routes>
      </MemoryRouter>
    );

    expect(readPendingInvite()).toBe('tok-123');
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });
});

describe('PendingInviteDialog', () => {
  it('renders nothing without a pending invite', () => {
    const { container } = render(<PendingInviteDialog />);
    expect(container).toBeEmptyDOMElement();
    expect(teamsApi.previewInvite).not.toHaveBeenCalled();
  });

  it('accepts the invite, adds the team and clears the token', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockResolvedValue(PREVIEW);
    teamsApi.acceptInvite.mockResolvedValue(TEAM);
    render(<PendingInviteDialog />);

    expect(await screen.findByText('@ana invited you to join Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(teamsApi.acceptInvite).toHaveBeenCalledWith('tok'));
    await waitFor(() => expect(readPendingInvite()).toBeNull());
    expect(useSpacesStore.getState().teams?.map((t) => t.id)).toContain('t1');
    expect(toast.success).toHaveBeenCalledWith('You joined Acme');
    expect(screen.queryByText('@ana invited you to join Acme')).toBeNull();
  });

  it('declines without calling accept and clears the token', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockResolvedValue(PREVIEW);
    render(<PendingInviteDialog />);

    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    expect(teamsApi.acceptInvite).not.toHaveBeenCalled();
    expect(readPendingInvite()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('keeps the dialog open and the token when accept fails', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockResolvedValue(PREVIEW);
    teamsApi.acceptInvite.mockRejectedValue(new Error('Network down.'));
    render(<PendingInviteDialog />);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    expect(await screen.findByText('Network down.')).toBeInTheDocument();
    expect(readPendingInvite()).toBe('tok');
  });

  it('says so when the person is already a member', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockResolvedValue({ ...PREVIEW, alreadyMember: true });
    render(<PendingInviteDialog />);

    expect(await screen.findByText('You are already in Acme')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(readPendingInvite()).toBeNull();
  });

  it('explains an invalid link and clears the token on close', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockRejectedValue(new ApiError('Not found', 404));
    render(<PendingInviteDialog />);

    expect(await screen.findByText(/This invite link is not valid/)).toBeInTheDocument();
    expect(readPendingInvite()).toBe('tok');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(readPendingInvite()).toBeNull();
  });

  it('shows the server message for spaces_unavailable and clears the token on close', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockRejectedValue(new ApiError('Spaces are not on for you.', 403, 'spaces_unavailable'));
    render(<PendingInviteDialog />);

    expect(await screen.findByText('Spaces are not on for you.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(readPendingInvite()).toBeNull();
  });

  it('keeps the token after another error so the next load retries', async () => {
    rememberPendingInvite('tok');
    teamsApi.previewInvite.mockRejectedValue(new Error('Network error'));
    render(<PendingInviteDialog />);

    expect(await screen.findByText('Network error')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(readPendingInvite()).toBe('tok');
  });
});
