import type { BillingStatus, Features, WorkspaceSettings } from '@talyn/shared';

import {
  billingLine, branchPrefixLine, githubStateLabel, githubStateOf, idleDayChoices, idleDaysLabel, sessionSettingsOf, settingsEditorLinks,
} from '../features/settings/model';
import {
  getThemePreference, hydrateThemePreference, isThemePreference, resolveScheme, setThemePreference, subscribeThemePreference,
  type ThemePreference,
} from '../theme/tokens';

describe('session settings', () => {
  it.each([
    [undefined, { idleDays: 7, archiveOnMerge: true, continueOnLimit: true, branchPrefix: '', claudeCoAuthor: true }],
    [{}, { idleDays: 7, archiveOnMerge: true, continueOnLimit: true, branchPrefix: '', claudeCoAuthor: true }],
    [{ autoArchiveIdleDays: null }, { idleDays: 0 }],
    [{ autoArchiveIdleDays: 14, autoArchiveOnMerge: false }, { idleDays: 14, archiveOnMerge: false }],
    [{ autoResumeOnLimit: false, claudeCoAuthoredBy: false, sessionBranchPrefix: 'tom/' }, { continueOnLimit: false, claudeCoAuthor: false, branchPrefix: 'tom/' }],
  ])('fills web defaults for %j', (settings, expected) => {
    expect(sessionSettingsOf(settings as WorkspaceSettings | undefined)).toMatchObject(expected);
  });
  it.each([[0, 'Off'], [1, 'After 1 day'], [7, 'After 7 days (default)'], [30, 'After 30 days']])('labels %d idle days', (days, label) => {
    expect(idleDaysLabel(days)).toBe(label);
  });
  it.each([[7, [0, 1, 3, 7, 14, 30]], [5, [0, 1, 3, 5, 7, 14, 30]], [60, [0, 1, 3, 7, 14, 30, 60]]])('keeps a stored %d in the choices', (days, choices) => {
    expect(idleDayChoices(days)).toEqual(choices);
  });
  it.each([['', 'New branches use the session name, like seattle'], ['tom/', 'New branches look like tom/seattle']])('explains prefix %p', (prefix, line) => {
    expect(branchPrefixLine(prefix)).toBe(line);
  });
});

describe('connections and plan lines', () => {
  it.each([
    [null, 'unknown', ''],
    [{ integrations: {} }, 'not_connected', 'Not connected'],
    [{ integrations: { github: { enabled: false, watchedRepos: [] } } }, 'not_connected', 'Not connected'],
    [{ integrations: { github: { enabled: true, watchedRepos: [] } } }, 'connected', 'Connected'],
  ])('GitHub state for %j', (workspace, state, label) => {
    const result = githubStateOf(workspace as never);
    expect(result).toBe(state);
    expect(githubStateLabel(result)).toBe(label);
  });
  const usage = { periodStart: '', periodEnd: '', includedWsec: 720_000, usedWsec: 396_000, percent: 55, exhausted: false };
  it.each([
    [undefined, null],
    [{ billingEnabled: false }, 'No plan limits'],
    [{ billingEnabled: true }, null],
    [{ billingEnabled: true, tier: 'pro', usage }, 'Pro · 45% left'],
  ])('plan line for %j', (status, line) => {
    expect(billingLine(status as BillingStatus | undefined)).toBe(line);
  });
});

describe('settings editor links', () => {
  const keys = (features: Partial<Features> | null) => settingsEditorLinks(features).map((link) => link.key);
  it.each([
    [null, ['integrations', 'skills', 'instructions', 'review']],
    [{ workbenches: true }, ['sandbox', 'slack', 'integrations', 'skills', 'instructions', 'memory', 'review']],
    [{ workbenches: true, privateRoutes: true, mcpServers: true, publicApi: true },
      ['sandbox', 'private', 'mcp', 'tokens', 'slack', 'integrations', 'skills', 'instructions', 'memory', 'review']],
    [{ mcpServers: false, publicApi: false }, ['integrations', 'skills', 'instructions', 'review']],
  ])('follows the flags %j', (features, expected) => {
    expect(keys(features)).toEqual(expected);
  });
  it('opens every editor under /settings', () => {
    for (const link of settingsEditorLinks({ workbenches: true, privateRoutes: true, mcpServers: true, publicApi: true })) {
      expect(link.href).toMatch(/^\/settings\/[a-zA-Z]+$/);
    }
  });
});

describe('theme preference', () => {
  it.each([
    ['system', 'dark', 'dark'], ['system', 'light', 'light'], ['system', null, 'light'], ['system', undefined, 'light'],
    ['light', 'dark', 'light'], ['dark', 'light', 'dark'], ['dark', null, 'dark'],
  ] as const)('%s on a %s system draws %s', (preference, system, scheme) => {
    expect(resolveScheme(preference, system)).toBe(scheme);
  });
  it.each([['system', true], ['dark', true], ['light', true], ['auto', false], [null, false], [1, false]])('%p is a preference: %s', (value, valid) => {
    expect(isThemePreference(value)).toBe(valid);
  });

  it('saves a choice, tells subscribers, and is not undone by a later load', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: jest.fn(async (key: string) => saved.get(key) ?? 'light'), setItem: jest.fn(async (key: string, value: string) => { saved.set(key, value); }) };
    const listener = jest.fn();
    const stop = subscribeThemePreference(listener);
    setThemePreference('dark', storage);
    expect(getThemePreference()).toBe('dark');
    expect(listener).toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith('talyn.appearance.v1', 'dark');
    await hydrateThemePreference(storage);
    expect(getThemePreference()).toBe('dark');
    setThemePreference('system' as ThemePreference, storage);
    expect(getThemePreference()).toBe('system');
    stop();
  });
});
