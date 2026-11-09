import type { SlackInstallationView, SlackStatus, SlackUserLinkView } from '@talyn/shared';

import {
  customEmojiChoices, inviteCommand, isSlackUnavailable, linkWorkspaceId, loadSlack, mergeTeams, NOT_CONFIGURED_FALLBACK, notConfiguredMessage,
  teamView, typedEmoji, withEmoji, withoutEmoji,
} from '../features/slack/model';

const install = (teamId: string, extra: Partial<SlackInstallationView> = {}): SlackInstallationView => ({
  teamId, teamName: `Team ${teamId}`, teamUrl: null, botUserId: 'B1', botName: 'talyn', installedByMe: false, needsReinstall: false,
  installedAt: '2026-11-01T00:00:00Z', ...extra,
});
const link = (teamId: string, extra: Partial<SlackUserLinkView> = {}): SlackUserLinkView => ({
  id: `link-${teamId}`, teamId, teamName: `Linked ${teamId}`, slackUserId: 'U1', workspaceId: null, triggerEmojis: ['robot_face'],
  installed: true, createdAt: '2026-11-01T00:00:00Z', ...extra,
});
const apiError = (status: number, code?: string, message = '') => Object.assign(new Error(message), { status, code });

describe('loading Slack status', () => {
  it('passes the status through', async () => {
    const status: SlackStatus = { installations: [install('T1')], links: [] };
    await expect(loadSlack(async () => status)).resolves.toEqual({ kind: 'ready', status });
  });
  it.each([
    [apiError(503, 'slack_not_configured', 'No Slack app on this server.'), { kind: 'not_configured', message: 'No Slack app on this server.' }],
    [apiError(503, 'slack_not_configured'), { kind: 'not_configured', message: NOT_CONFIGURED_FALLBACK }],
    [apiError(403, 'slack_unavailable', 'Off'), { kind: 'unavailable' }],
  ])('turns %p into a page state', async (error, expected) => {
    await expect(loadSlack(async () => { throw error; })).resolves.toEqual(expected);
  });
  it.each([[apiError(500)], [apiError(403, 'forbidden')], [new Error('network')]])('throws %p', async (error) => {
    await expect(loadSlack(async () => { throw error; })).rejects.toBe(error);
  });
  it.each([
    [apiError(503, 'slack_not_configured', 'Set SLACK_CLIENT_ID.'), 'Set SLACK_CLIENT_ID.'],
    [apiError(503, 'slack_not_configured', '   '), NOT_CONFIGURED_FALLBACK],
    [apiError(403, 'slack_unavailable'), null],
    [null, null],
    ['slack_not_configured', null],
  ])('reads the not-configured message from %p', (error, message) => {
    expect(notConfiguredMessage(error)).toBe(message);
  });
  it.each([[apiError(403, 'slack_unavailable'), true], [apiError(403), false], [undefined, false]])('unavailable for %p: %p', (error, value) => {
    expect(isSlackUnavailable(error)).toBe(value);
  });
});

describe('teams', () => {
  it('pairs installations with links and keeps orphan links last', () => {
    const teams = mergeTeams({ installations: [install('T1'), install('T2')], links: [link('T3'), link('T1')] });
    expect(teams.map((team) => [team.teamId, Boolean(team.installation), team.link?.id ?? null]))
      .toEqual([['T1', true, 'link-T1'], ['T2', true, null], ['T3', false, 'link-T3']]);
  });
  it('is empty with nothing installed or linked', () => {
    expect(mergeTeams({ installations: [], links: [] })).toEqual([]);
  });

  it.each([
    ['healthy and linked', install('T1'), link('T1'), { pill: 'Connected', broken: false, canLink: false, actions: ['reconnect', 'unlink'] }],
    ['healthy, not linked', install('T1'), null, { pill: 'Not linked', broken: false, canLink: true, actions: ['reconnect'] }],
    ['installed by me', install('T1', { installedByMe: true }), link('T1'),
      { pill: 'Connected', broken: false, canLink: false, actions: ['reconnect', 'unlink', 'disconnect'] }],
    ['needs reinstall', install('T1', { needsReinstall: true }), null,
      { pill: 'Needs reconnect', broken: true, canLink: false, actions: ['reconnect'], message: /stopped accepting/ }],
    ['app removed', null, link('T1'), { pill: 'App removed', broken: true, canLink: false, actions: ['reconnect', 'unlink'], message: /no longer installed/ }],
  ] as Array<[string, ReturnType<typeof install> | null, ReturnType<typeof link> | null, { pill: string; broken: boolean; canLink: boolean; actions: string[]; message?: RegExp }]>)('derives the card for %s', (_name, installation, userLink, expected) => {
    const view = teamView({ teamId: 'T1', installation, link: userLink });
    expect(view.pill.label).toBe(expected.pill);
    expect(view.broken).toBe(expected.broken);
    expect(view.canLink).toBe(expected.canLink);
    expect(view.actions).toEqual(expected.actions);
    if (expected.message) expect(view.brokenMessage).toMatch(expected.message);
    else expect(view.brokenMessage).toBeNull();
  });

  it.each([
    [install('T1', { teamName: 'Acme' }), link('T1', { teamName: 'Other' }), 'Acme'],
    [install('T1', { teamName: null }), link('T1', { teamName: 'Linked' }), 'Linked'],
    [null, link('T1', { teamName: null }), 'T1'],
  ])('names the team', (installation, userLink, name) => {
    expect(teamView({ teamId: 'T1', installation, link: userLink }).name).toBe(name);
  });

  it.each([['talyn', '/invite @talyn'], ['acme-bot', '/invite @acme-bot'], [null, '/invite @talyn'], ['', '/invite @talyn']])(
    'invites @%p', (bot, command) => { expect(inviteCommand(bot)).toBe(command); });

  it.each([
    ['w2', [{ id: 'w1' }, { id: 'w2' }], 'w2'],
    [null, [{ id: 'w1' }, { id: 'w2' }], 'w1'],
    [null, [], ''],
  ])('targets workspace %p', (workspaceId, workspaces, target) => {
    expect(linkWorkspaceId({ workspaceId }, workspaces)).toBe(target);
  });
});

describe('trigger emoji', () => {
  it.each([
    ['robot_face', [], 'robot_face'],
    [':Robot_Face:', [], 'robot_face'],
    ['  ::tada::  ', [], 'tada'],
    ['+1', [], '+1'],
    ['white-check', [], 'white-check'],
    ['tada', ['tada'], null],
    [':TADA:', ['tada'], null],
    ['', [], null],
    ['::', [], null],
    ['two words', [], null],
    ['emoji!', [], null],
    ['é', [], null],
    ['a'.repeat(100), [], 'a'.repeat(100)],
    ['a'.repeat(101), [], null],
  ])('typing %p with %j taken adds %p', (query, taken, name) => {
    expect(typedEmoji(query, taken)).toBe(name);
  });

  const custom = [{ name: 'partyparrot', url: 'https://e/1.png' }, { name: 'shipit', url: 'https://e/2.png' }, { name: 'party-blob', url: 'https://e/3.png' }];
  it.each([
    ['', [], ['partyparrot', 'shipit', 'party-blob']],
    ['party', [], ['partyparrot', 'party-blob']],
    [':PARTY:', [], ['partyparrot', 'party-blob']],
    ['party', ['partyparrot'], ['party-blob']],
    ['zzz', [], []],
    ['  ', ['shipit'], ['partyparrot', 'party-blob']],
  ])('filters custom emoji by %p with %j taken', (query, taken, names) => {
    expect(customEmojiChoices(custom, query, taken).map((emoji) => emoji.name)).toEqual(names);
  });

  it.each([
    [['a'], 'b', ['a', 'b']],
    [['a', 'b'], 'a', ['a', 'b']],
    [[], 'a', ['a']],
  ])('adds to %j', (list, name, next) => { expect(withEmoji(list, name)).toEqual(next); });
  it.each([
    [['a', 'b'], 'a', ['b']],
    [['a'], 'z', ['a']],
    [[], 'a', []],
  ])('removes from %j', (list, name, next) => { expect(withoutEmoji(list, name)).toEqual(next); });
});
