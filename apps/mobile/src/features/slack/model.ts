import {
  normalizeSlackEmojiName, SLACK_NOT_CONFIGURED_CODE, SLACK_UNAVAILABLE_CODE,
  type SlackCustomEmoji, type SlackInstallationView, type SlackStatus, type SlackUserLinkView,
} from '@talyn/shared';

import type { Tone } from '../../components/UI';

export const SLACK_INTRO = 'Start Talyn sessions from Slack: react with your emoji, mention @Talyn, or DM the bot. Talyn never posts in Slack; it shows progress with reactions.';
export const NOT_CONFIGURED_FALLBACK = 'Slack is not set up on this deployment.';

/** What `GET /slack` answered. The two refusal codes are states of the page, not errors. */
export type SlackLoad =
  | { kind: 'ready'; status: SlackStatus }
  | { kind: 'not_configured'; message: string }
  | { kind: 'unavailable' };

function codeOf(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

function messageOf(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/** The 503 `slack_not_configured` sentence, or null for any other error. */
export function notConfiguredMessage(error: unknown): string | null {
  return codeOf(error) === SLACK_NOT_CONFIGURED_CODE ? messageOf(error, NOT_CONFIGURED_FALLBACK) : null;
}

export function isSlackUnavailable(error: unknown): boolean {
  return codeOf(error) === SLACK_UNAVAILABLE_CODE;
}

/** Reads the status, and turns the two refusal codes into states. Any other error is thrown. */
export async function loadSlack(read: () => Promise<SlackStatus>): Promise<SlackLoad> {
  try {
    return { kind: 'ready', status: await read() };
  } catch (error) {
    const notConfigured = notConfiguredMessage(error);
    if (notConfigured) return { kind: 'not_configured', message: notConfigured };
    if (isSlackUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
}

/** One Slack team: its installation, the caller's link, or both. */
export interface TeamEntry {
  teamId: string;
  installation: SlackInstallationView | null;
  link: SlackUserLinkView | null;
}

/** Installations first, in the server's order, then links whose installation is gone. Same as web `mergeTeams`. */
export function mergeTeams(status: SlackStatus): TeamEntry[] {
  const teams: TeamEntry[] = status.installations.map((installation) => ({
    teamId: installation.teamId,
    installation,
    link: status.links.find((link) => link.teamId === installation.teamId) ?? null,
  }));
  for (const link of status.links) {
    if (!teams.some((team) => team.teamId === link.teamId)) teams.push({ teamId: link.teamId, installation: null, link });
  }
  return teams;
}

export type TeamAction = 'reconnect' | 'unlink' | 'disconnect';

export interface TeamView {
  name: string;
  pill: { label: string; tone: Tone };
  /** The install needs a reconnect, or is gone. `brokenMessage` says which. */
  broken: boolean;
  brokenMessage: string | null;
  /** Installed and healthy, but the caller has no link yet. */
  canLink: boolean;
  /** The menu, in web's order. */
  actions: TeamAction[];
}

export function teamView(team: TeamEntry): TeamView {
  const { installation, link } = team;
  const broken = installation ? installation.needsReinstall : true;
  const pill: TeamView['pill'] = !installation ? { label: 'App removed', tone: 'warning' }
    : installation.needsReinstall ? { label: 'Needs reconnect', tone: 'warning' }
      : !link ? { label: 'Not linked', tone: 'muted' } : { label: 'Connected', tone: 'success' };
  const actions: TeamAction[] = ['reconnect'];
  if (link) actions.push('unlink');
  if (installation?.installedByMe) actions.push('disconnect');
  return {
    name: installation?.teamName ?? link?.teamName ?? team.teamId,
    pill,
    broken,
    brokenMessage: !broken ? null : installation
      ? 'Slack stopped accepting Talyn\'s access. Reconnect to start sessions again.'
      : 'The Talyn app is no longer installed in this Slack workspace.',
    canLink: Boolean(installation && !installation.needsReinstall && !link),
    actions,
  };
}

export const TEAM_ACTION_LABEL: Record<TeamAction, string> = {
  reconnect: 'Reconnect', unlink: 'Unlink my account', disconnect: 'Disconnect workspace',
};

/** `/invite @talyn`, with the bot's own handle when Slack told us. */
export function inviteCommand(botName: string | null | undefined): string {
  return `/invite @${botName || 'talyn'}`;
}

/** The workspace a link sends sessions to. Null on the link means the account's first workspace. */
export function linkWorkspaceId(link: Pick<SlackUserLinkView, 'workspaceId'>, workspaces: ReadonlyArray<{ id: string }>): string {
  return link.workspaceId ?? workspaces[0]?.id ?? '';
}

// ---------------------------------------------------------------------------
// Trigger emoji
// ---------------------------------------------------------------------------

/** The name a search would add, or null when it is not a Slack emoji name or is already chosen. */
export function typedEmoji(query: string, taken: readonly string[]): string | null {
  const name = normalizeSlackEmojiName(query);
  return name && !taken.includes(name) ? name : null;
}

/**
 * The workspace's custom emoji that match the search and are not chosen yet,
 * in the server's order. Colons around the search are ignored, as on web.
 */
export function customEmojiChoices(custom: readonly SlackCustomEmoji[], query: string, taken: readonly string[]): SlackCustomEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:+|:+$/g, '');
  return custom.filter((emoji) => !taken.includes(emoji.name) && (!q || emoji.name.includes(q)));
}

export function withEmoji(list: readonly string[], name: string): string[] {
  return list.includes(name) ? [...list] : [...list, name];
}

export function withoutEmoji(list: readonly string[], name: string): string[] {
  return list.filter((item) => item !== name);
}
