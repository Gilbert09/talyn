import {
  DEFAULT_AUTO_ARCHIVE_IDLE_DAYS, PLAN_TIER_LABELS, mcpServersOffered, privateRoutesOffered, workbenchesOffered,
  type BillingStatus, type Features, type Workspace, type WorkspaceSettings,
} from '@talyn/shared';

import type { ThemePreference } from '../../theme/tokens';
import { formatLeftPercent, usageViewOf } from '../usage/model';

/** Archive idle sessions after this many days. 0 is off. The same choices as web. */
export const IDLE_DAY_OPTIONS = [0, 1, 3, 7, 14, 30] as const;

export function idleDaysLabel(days: number): string {
  if (days === 0) return 'Off';
  return `After ${days} ${days === 1 ? 'day' : 'days'}${days === DEFAULT_AUTO_ARCHIVE_IDLE_DAYS ? ' (default)' : ''}`;
}

/** The choices, with a stored value outside them kept in order. */
export function idleDayChoices(current: number): number[] {
  const options: number[] = [...IDLE_DAY_OPTIONS];
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

export interface SessionSettingsView {
  idleDays: number;
  archiveOnMerge: boolean;
  continueOnLimit: boolean;
  branchPrefix: string;
  claudeCoAuthor: boolean;
}

/** The session settings with web's defaults filled in. Absent means the default, never off. */
export function sessionSettingsOf(settings: WorkspaceSettings | null | undefined): SessionSettingsView {
  return {
    idleDays: settings?.autoArchiveIdleDays === undefined ? DEFAULT_AUTO_ARCHIVE_IDLE_DAYS : settings.autoArchiveIdleDays ?? 0,
    archiveOnMerge: settings?.autoArchiveOnMerge !== false,
    continueOnLimit: settings?.autoResumeOnLimit !== false,
    branchPrefix: settings?.sessionBranchPrefix ?? '',
    claudeCoAuthor: settings?.claudeCoAuthoredBy !== false,
  };
}

/** "New branches look like tom/seattle", like the web hint. */
export function branchPrefixLine(prefix: string): string {
  return prefix ? `New branches look like ${prefix}seattle` : 'New branches use the session name, like seattle';
}

export type GitHubState = 'connected' | 'not_connected' | 'unknown';

export function githubStateOf(workspace: Pick<Workspace, 'integrations'> | null | undefined): GitHubState {
  if (!workspace) return 'unknown';
  return workspace.integrations?.github?.enabled ? 'connected' : 'not_connected';
}

export function githubStateLabel(state: GitHubState): string {
  return state === 'connected' ? 'Connected' : state === 'not_connected' ? 'Not connected' : '';
}

/** "Pro · 45% left", or the plan alone. Null hides the subtitle. */
export function billingLine(status: BillingStatus | null | undefined): string | null {
  const view = usageViewOf(status);
  if (!view) return status && !status.billingEnabled ? 'No plan limits' : null;
  return `${PLAN_TIER_LABELS[view.tier]} · ${formatLeftPercent(view.usage.percent, view.usage.exhausted)}`;
}

export const APPEARANCE_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
];

export interface WebSettingsLink { key: string; title: string; subtitle: string; path: string }

/** The settings that stay on the web, each only when web would draw its section. */
export function webSettingsLinks(features: Partial<Features> | null | undefined): WebSettingsLink[] {
  const sessions = workbenchesOffered(features);
  const links: Array<WebSettingsLink | false> = [
    sessions && { key: 'sandbox', title: 'Sandbox setup', subtitle: 'Dotfiles and setup steps', path: '/settings/sandboxSetup' },
    privateRoutesOffered(features) && { key: 'private', title: 'Private routes', subtitle: 'Reach private networks', path: '/settings/privateRoutes' },
    mcpServersOffered(features ?? null) && { key: 'mcp', title: 'MCP servers', subtitle: 'Linear, Sentry and other tools', path: '/mcp-servers' },
    features?.publicApi === true && { key: 'tokens', title: 'API tokens', subtitle: 'Personal access tokens', path: '/settings/apiTokens' },
    sessions && { key: 'slack', title: 'Slack', subtitle: 'Start and follow sessions in Slack', path: '/settings/slack' },
    { key: 'integrations', title: 'Integrations', subtitle: 'PostHog Code and Trunk', path: '/settings/integrations' },
    { key: 'skills', title: 'Skills', subtitle: 'Reusable instructions for agents', path: '/settings/skills' },
    { key: 'instructions', title: 'Instructions', subtitle: 'What every agent reads first', path: '/settings/instructions' },
    sessions && { key: 'memory', title: 'Memory', subtitle: 'What agents remember', path: '/settings/memory' },
    { key: 'review', title: 'Code review', subtitle: 'Reviewers and auto-review', path: '/settings/codeReview' },
  ];
  return links.filter((link): link is WebSettingsLink => Boolean(link));
}
