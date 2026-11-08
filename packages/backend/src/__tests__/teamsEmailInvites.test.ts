import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EmailMessage } from '../services/email.js';
import { createTestDb } from './helpers/testDb.js';
import { teamInvites, teamMembers, users, workspaces } from '../db/schema.js';

vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));

const {
  MAX_PENDING_INVITES_PER_TEAM,
  acceptEmailInvite,
  hashInviteToken,
  inviteByEmail,
  inviteEmailMessage,
  listEmailInvites,
  normaliseInviteEmail,
  previewEmailInvite,
  revokeEmailInvite,
} = await import('../services/teams/emailInvites.js');
const { changeMemberRole, createSpacesTeam, inviteMember, listMembers, listMyTeams } = await import(
  '../services/teams/membership.js'
);
const { TeamError } = await import('../services/billing/teams.js');
const { emailConfigured, escapeHtml, sendEmail } = await import('../services/email.js');
const { resetWebAppUrlCacheForTests } = await import('../services/webApp.js');
const { isValidInviteEmail } = await import('@talyn/shared');

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TeamError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
}

/** Captures sent mail; the token is the last path segment of the link. */
function mailbox(accept = true) {
  const sent: EmailMessage[] = [];
  const send = async (message: EmailMessage) => {
    sent.push(message);
    return accept;
  };
  const tokenOf = (message: EmailMessage) => {
    const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(message.text);
    if (!match) throw new Error('no link in the email');
    return decodeURIComponent(match[1]!);
  };
  return { sent, send, tokenOf, lastToken: () => tokenOf(sent[sent.length - 1]!) };
}

describe('pure invite helpers', () => {
  it.each<[string, boolean]>([
    ['ana@example.com', true],
    ['ana.b+tag@sub.example.co.uk', true],
    ['ana@example', false],
    ['@example.com', false],
    ['ana@', false],
    ['ana example@x.com', false],
    ['', false],
    [`${'a'.repeat(250)}@x.io`, false],
  ])('isValidInviteEmail(%j) is %s', (value, expected) => {
    expect(isValidInviteEmail(value)).toBe(expected);
  });

  it.each([
    ['  Ana@Example.COM ', 'ana@example.com'],
    ['bob@x.io', 'bob@x.io'],
  ])('normalises %j', (raw, expected) => {
    expect(normaliseInviteEmail(raw)).toBe(expected);
  });

  it('escapes the team name and keeps the subject on one line', () => {
    const message = inviteEmailMessage({
      to: 'x@y.io',
      teamName: '<script>alert(1)</script>\r\nBcc: evil@x.io',
      inviterLogin: 'alice',
      acceptUrl: 'https://app.talyn.dev/invite/abc?x=1&y=2',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain(escapeHtml('<script>alert(1)</script>'));
    expect(message.html).toContain('https://app.talyn.dev/invite/abc?x=1&amp;y=2');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain('@alice invited you to');
    expect(message.text).toContain('https://app.talyn.dev/invite/abc?x=1&y=2');
  });

  it('names "A teammate" when the inviter has no login', () => {
    const message = inviteEmailMessage({ to: 'x@y.io', teamName: 'Acme', inviterLogin: null, acceptUrl: 'https://a/invite/t' });
    expect(message.subject).toBe('A teammate invited you to Acme on Talyn');
  });
});

describe('sendEmail', () => {
  const message = { to: 'x@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends nothing without an API key', async () => {
    vi.stubEnv('RESEND_API_KEY', '  ');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(emailConfigured()).toBe(false);
    expect(await sendEmail(message)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, string | undefined, string]>([
    ['the default sender', undefined, 'Talyn <noreply@talyn.dev>'],
    ['EMAIL_FROM', 'Team <team@example.com>', 'Team <team@example.com>'],
  ])('posts to Resend with %s', async (_name, from, expected) => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    if (from !== undefined) vi.stubEnv('EMAIL_FROM', from);
    else vi.stubEnv('EMAIL_FROM', '');
    const fetchMock = vi.fn(async () => new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(emailConfigured()).toBe(true);
    expect(await sendEmail(message)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({ from: expected, to: ['x@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  });

  it.each<[string, () => Promise<Response>]>([
    ['a refusal', async () => new Response('{"message":"domain not verified"}', { status: 403 })],
    ['a network error', async () => Promise.reject(new Error('ECONNRESET'))],
  ])('answers false on %s', async (_name, impl) => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubGlobal('fetch', vi.fn(impl));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await sendEmail(message)).toBe(false);
  });
});

describe('team invites by email', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const savedWebAppUrl = process.env.WEB_APP_URL;

  beforeEach(async () => {
    process.env.WEB_APP_URL = 'https://app.example.test';
    resetWebAppUrlCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'u-alice', email: 'a@x.test', githubUserId: 100, githubUsername: 'alice' },
      { id: 'u-bob', email: 'Bob@X.test', githubUserId: 200, githubUsername: 'bob' },
      { id: 'u-carol', email: 'c@x.test', githubUserId: 300, githubUsername: 'carol' },
      { id: 'u-nogh', email: 'n@x.test' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-alice', ownerId: 'u-alice', name: 'Alice' },
      { id: 'ws-carol-old', ownerId: 'u-carol', name: 'Old', createdAt: new Date('2026-01-01') },
      { id: 'ws-carol-new', ownerId: 'u-carol', name: 'New', createdAt: new Date('2026-06-01') },
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
    if (savedWebAppUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = savedWebAppUrl;
    resetWebAppUrlCacheForTests();
  });

  const resolveBob = async (login: string) => (login === 'bob' ? { id: 200, login: 'bob', avatarUrl: null } : null);

  async function teamWithBob(role: 'member' | 'admin' = 'member'): Promise<string> {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const bob = await inviteMember(team.id, 'u-alice', 'bob', resolveBob);
    if (role !== 'member') await changeMemberRole(team.id, 'u-alice', bob.id, role);
    return team.id;
  }

  it('emails a link, lists the invite, and stores only a hash of the token', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    const res = await inviteByEmail(team.id, 'u-alice', '  Carol@Example.com ', mail.send);

    expect(res.emailSent).toBe(true);
    expect(res.acceptUrl).toBeNull();
    expect(res.invite).toMatchObject({ teamId: team.id, email: 'carol@example.com', invitedByLogin: 'alice' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('carol@example.com');
    expect(mail.sent[0]!.subject).toBe('@alice invited you to Acme on Talyn');
    expect(mail.sent[0]!.text).toContain('https://app.example.test/invite/');

    const token = mail.lastToken();
    const [row] = await testDb.db.select().from(teamInvites).where(eq(teamInvites.teamId, team.id));
    expect(row!.tokenHash).toBe(hashInviteToken(token));
    expect(row!.tokenHash).not.toContain(token);
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);

    expect(await listEmailInvites(team.id, 'u-alice')).toEqual([
      expect.objectContaining({ id: res.invite.id, email: 'carol@example.com', invitedByLogin: 'alice' }),
    ]);
  });

  it('returns the link to the inviter when the email is not sent', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox(false);
    const res = await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    expect(res.emailSent).toBe(false);
    expect(res.acceptUrl).toBe(`https://app.example.test/invite/${mail.lastToken()}`);
  });

  it('replaces the token when the same email is invited again', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    const first = await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    const oldToken = mail.lastToken();
    const second = await inviteByEmail(team.id, 'u-alice', 'CAROL@example.com', mail.send);
    const newToken = mail.lastToken();

    expect(second.invite.id).toBe(first.invite.id);
    expect(newToken).not.toBe(oldToken);
    expect(await listEmailInvites(team.id, 'u-alice')).toHaveLength(1);
    expect((await refusal(previewEmailInvite(oldToken, 'u-carol'))).status).toBe(404);
    expect((await previewEmailInvite(newToken, 'u-carol')).teamName).toBe('Acme');
  });

  it.each([
    ['not an email', 400],
    ['', 400],
    ['bob@x.test', 409],
  ])('refuses to invite %j with %i', async (email, status) => {
    const teamId = await teamWithBob();
    const mail = mailbox();
    expect((await refusal(inviteByEmail(teamId, 'u-alice', email, mail.send))).status).toBe(status);
    expect(mail.sent).toHaveLength(0);
  });

  it.each([
    ['a stranger', 'u-carol', 404],
    ['a plain member', 'u-bob', 403],
  ])('refuses %s managing invites', async (_name, actor, status) => {
    const teamId = await teamWithBob();
    const mail = mailbox();
    const { invite } = await inviteByEmail(teamId, 'u-alice', 'dan@example.com', mail.send);
    expect((await refusal(inviteByEmail(teamId, actor, 'eve@example.com', mail.send))).status).toBe(status);
    expect((await refusal(listEmailInvites(teamId, actor))).status).toBe(status);
    expect((await refusal(revokeEmailInvite(teamId, actor, invite.id))).status).toBe(status);
    expect(mail.sent).toHaveLength(1);
  });

  it('lets an admin invite and revoke', async () => {
    const teamId = await teamWithBob('admin');
    const mail = mailbox();
    const { invite } = await inviteByEmail(teamId, 'u-bob', 'dan@example.com', mail.send);
    expect(invite.invitedByLogin).toBe('bob');
    await revokeEmailInvite(teamId, 'u-bob', invite.id);
    expect(await listEmailInvites(teamId, 'u-alice')).toEqual([]);
    expect((await refusal(previewEmailInvite(mail.lastToken(), 'u-carol'))).status).toBe(404);
    expect((await refusal(revokeEmailInvite(teamId, 'u-bob', invite.id))).status).toBe(404);
  });

  it('caps pending invites per team, but still lets a pending one be sent again', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const expiresAt = new Date(Date.now() + 86_400_000);
    await testDb.db.insert(teamInvites).values(
      Array.from({ length: MAX_PENDING_INVITES_PER_TEAM }, (_, i) => ({
        id: `inv-${i}`,
        teamId: team.id,
        email: `p${i}@example.com`,
        tokenHash: `hash-${i}`,
        expiresAt,
      }))
    );
    const mail = mailbox();
    expect((await refusal(inviteByEmail(team.id, 'u-alice', 'new@example.com', mail.send))).status).toBe(409);
    await expect(inviteByEmail(team.id, 'u-alice', 'p0@example.com', mail.send)).resolves.toMatchObject({ emailSent: true });
  });

  it('previews the team for the invitee', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    expect(await previewEmailInvite(mail.lastToken(), 'u-carol')).toMatchObject({
      teamId: team.id,
      teamName: 'Acme',
      invitedByLogin: 'alice',
      email: 'carol@example.com',
      alreadyMember: false,
    });
    expect((await previewEmailInvite(mail.lastToken(), 'u-alice')).alreadyMember).toBe(true);
  });

  it('accepts as the signed-in account, even with a different email, and uses the link up', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol.work@example.com', mail.send);
    const token = mail.lastToken();

    const joined = await acceptEmailInvite(token, 'u-carol');
    expect(joined).toMatchObject({ id: team.id, name: 'Acme', role: 'member', homeWorkspaceId: 'ws-carol-old' });
    const carol = (await listMembers(team.id, 'u-alice')).find((m) => m.githubLogin === 'carol');
    expect(carol).toMatchObject({ role: 'member', source: 'invite', signedUp: true, githubUserId: 300 });
    const [row] = await testDb.db
      .select({ userId: teamMembers.userId, invitedBy: teamMembers.invitedByUserId })
      .from(teamMembers)
      .where(eq(teamMembers.githubUserId, 300));
    expect(row).toEqual({ userId: 'u-carol', invitedBy: 'u-alice' });

    expect(await listEmailInvites(team.id, 'u-alice')).toEqual([]);
    expect((await refusal(acceptEmailInvite(token, 'u-carol'))).status).toBe(404);
    expect((await refusal(previewEmailInvite(token, 'u-carol'))).status).toBe(404);
  });

  it('keeps an existing member and their role when they accept', async () => {
    const teamId = await teamWithBob('admin');
    const mail = mailbox();
    await inviteByEmail(teamId, 'u-alice', 'bob.other@example.com', mail.send);
    expect(await acceptEmailInvite(mail.lastToken(), 'u-bob')).toMatchObject({ id: teamId, role: 'admin' });
    expect((await listMembers(teamId, 'u-alice')).filter((m) => m.githubLogin === 'bob')).toHaveLength(1);
  });

  it('lets only one of two concurrent accepts win', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    const token = mail.lastToken();
    const results = await Promise.allSettled([acceptEmailInvite(token, 'u-carol'), acceptEmailInvite(token, 'u-bob')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const members = (await listMembers(team.id, 'u-alice')).map((m) => m.githubLogin).sort();
    expect(members.length).toBe(2);
  });

  it('refuses an expired link', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    await testDb.db.update(teamInvites).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await refusal(previewEmailInvite(mail.lastToken(), 'u-carol'))).status).toBe(404);
    expect((await refusal(acceptEmailInvite(mail.lastToken(), 'u-carol'))).status).toBe(404);
    expect(await listEmailInvites(team.id, 'u-alice')).toEqual([]);
    expect(await listMyTeams('u-carol')).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a missing token', undefined],
    ['a number', 42],
    ['a short string', 'abc'],
    ['an unknown token', 'x'.repeat(43)],
    ['a huge string', 'x'.repeat(500)],
  ])('answers 404 for %s', async (_name, token) => {
    expect((await refusal(previewEmailInvite(token, 'u-carol'))).status).toBe(404);
    expect((await refusal(acceptEmailInvite(token, 'u-carol'))).status).toBe(404);
  });

  it('refuses an account with no known GitHub id, and leaves the link usable', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    expect((await refusal(acceptEmailInvite(mail.lastToken(), 'u-nogh'))).status).toBe(409);
    await expect(acceptEmailInvite(mail.lastToken(), 'u-carol')).resolves.toMatchObject({ id: team.id });
  });

  it('drops pending invites with the team', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const mail = mailbox();
    await inviteByEmail(team.id, 'u-alice', 'carol@example.com', mail.send);
    await testDb.pglite.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
    expect(await testDb.db.select().from(teamInvites)).toEqual([]);
  });
});
