import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SpacesTeam, TeamEmailInvite, TeamMember } from '@talyn/shared';
import { TeamsSettings } from '../components/settings/sections/TeamsSettings';
import { useSpacesStore } from '../stores/spaces';
import { toast } from '../stores/toast';

const { teamsApi } = vi.hoisted(() => ({
  teamsApi: {
    list: vi.fn(),
    members: vi.fn(),
    invite: vi.fn(),
    emailInvites: vi.fn(),
    inviteByEmail: vi.fn(),
    revokeEmailInvite: vi.fn(),
  },
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { teams: teamsApi },
}));
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/panels/TeamBilling', () => ({ TeamSettings: () => null }));

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'owner',
  homeWorkspaceId: null,
  spaces: [],
} as unknown as SpacesTeam;

const MEMBER: TeamMember = {
  id: 'm1',
  githubLogin: 'ana',
  role: 'owner',
  source: 'seat',
  signedUp: true,
} as unknown as TeamMember;

const PENDING: TeamEmailInvite = {
  id: 'i1',
  teamId: 't1',
  email: 'bob@example.com',
  invitedByLogin: 'ana',
  expiresAt: '2026-11-15T00:00:00Z',
  createdAt: '2026-11-08T00:00:00Z',
};

function setup(role: SpacesTeam['role'] = 'owner', pending: TeamEmailInvite[] = []) {
  const team = { ...TEAM, role };
  useSpacesStore.setState({ teams: [team], members: { t1: [MEMBER] }, settingsTeamId: 't1' } as never);
  teamsApi.list.mockResolvedValue([team]);
  teamsApi.members.mockResolvedValue([MEMBER]);
  teamsApi.emailInvites.mockResolvedValue(pending);
  return render(<TeamsSettings />);
}

function invite(value: string) {
  fireEvent.change(screen.getByPlaceholderText('GitHub username or email'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /^Invite$/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(cleanup);

describe('TeamsSettings invites', () => {
  it('sends an email to inviteByEmail, lowercased, and lists it as pending', async () => {
    teamsApi.inviteByEmail.mockResolvedValue({ invite: PENDING, emailSent: true, acceptUrl: null });
    setup();
    invite('  Bob@Example.com ');

    await waitFor(() => expect(teamsApi.inviteByEmail).toHaveBeenCalledWith('t1', { email: 'bob@example.com' }));
    expect(teamsApi.invite).not.toHaveBeenCalled();
    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-attr="team-email-invite-row"]')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Invite sent to bob@example.com');
    expect(screen.queryByLabelText('Invite link')).toBeNull();
  });

  it.each([
    ['ana', 'ana'],
    ['@ana', 'ana'],
  ])('sends %s to the GitHub invite', async (value, login) => {
    teamsApi.invite.mockResolvedValue({ ...MEMBER, id: 'm2', githubLogin: login });
    setup();
    invite(value);

    await waitFor(() => expect(teamsApi.invite).toHaveBeenCalledWith('t1', { githubLogin: login }));
    expect(teamsApi.inviteByEmail).not.toHaveBeenCalled();
  });

  it.each(['a@b', 'a b@c.com', 'x@@y.com'])('rejects the bad email %s without a request', async (value) => {
    setup();
    invite(value);

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(teamsApi.inviteByEmail).not.toHaveBeenCalled();
    expect(teamsApi.invite).not.toHaveBeenCalled();
  });

  it('shows the link to share when the email was not sent', async () => {
    teamsApi.inviteByEmail.mockResolvedValue({
      invite: PENDING,
      emailSent: false,
      acceptUrl: 'https://app.example.com/invite/abc',
    });
    setup();
    invite('bob@example.com');

    const field = (await screen.findByLabelText('Invite link')) as HTMLInputElement;
    expect(field.value).toBe('https://app.example.com/invite/abc');
    expect(screen.getByText(/could not send the email/i)).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.example.com/invite/abc'));
  });

  it('shows the server message when the invite fails', async () => {
    teamsApi.inviteByEmail.mockRejectedValue(new Error('That person is already in the team.'));
    setup();
    invite('bob@example.com');

    expect(await screen.findByText('That person is already in the team.')).toBeInTheDocument();
  });

  it('loads pending invites and revokes one', async () => {
    teamsApi.revokeEmailInvite.mockResolvedValue(null);
    setup('admin', [PENDING]);

    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Invited · expires/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invite for bob@example.com' }));

    await waitFor(() => expect(teamsApi.revokeEmailInvite).toHaveBeenCalledWith('t1', 'i1'));
    await waitFor(() => expect(screen.queryByText('bob@example.com')).toBeNull());
  });

  it('does not load or show email invites for a plain member', async () => {
    setup('member', [PENDING]);

    expect(await screen.findByText('@ana')).toBeInTheDocument();
    expect(teamsApi.emailInvites).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('GitHub username or email')).toBeNull();
  });
});
