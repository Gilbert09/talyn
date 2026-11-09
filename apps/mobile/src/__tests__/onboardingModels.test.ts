import type { GitHubInstallation, GitHubRepo } from '@talyn/client/native';
import type { RepositorySandboxSizeResponse, WorkbenchReadiness } from '@talyn/shared';

import { redirectSystemPath } from '../../app/+native-intent';
import { homeView } from '../features/nav/HomeScreen';
import { formatOwnerList, installUrls, isOwnerCovered, uncoveredOwners } from '../features/onboarding/githubFlow';
import { parseGithubReturn, receiveGithubReturn, takeGithubReturn } from '../features/onboarding/githubReturn';
import { coverageWarning } from '../features/onboarding/GithubInstallStatus';
import { OnboardingProgress, progressKey } from '../features/onboarding/progress';
import { agentChoice, nothingConnected, readinessRows } from '../features/onboarding/readiness';
import { effectiveLocked, formatAge, matchRepos, sizeHint, sizeOptions, sizeSummary } from '../features/repositories/model';
import { boxRefusal, refusalActions } from '../lib/errors';
import { appReturnBase, returnPrefix } from '../lib/returnTo';
import { billingReturnPath, linkPath } from '../navigation/returnLinks';

jest.mock('../auth/AuthProvider', () => ({}));
jest.mock('../features/create/NewWorkScreen', () => ({ NewWorkScreen: () => null }));
jest.mock('../features/prs/PullRequestsScreen', () => ({ PullRequestsScreen: () => null }));

const reason = (code: string, message = `${code} message`) => ({ code, message });
const readiness = (claude: object, codex: object, ok = true, reasons: Array<{ code: string; message: string }> = []): WorkbenchReadiness =>
  ({ sandbox: { ok, reasons, agents: { claude, codex } } } as WorkbenchReadiness);
const install = (accountLogin: string, suspended = false): GitHubInstallation =>
  ({ accountLogin, accountType: 'Organization', suspended, repositorySelection: 'all' });
const repo = (full: string, isPrivate = false): GitHubRepo => {
  const [owner, name] = full.split('/');
  return { id: full.length, name, full_name: full, private: isPrivate, html_url: '', default_branch: 'main', owner: { login: owner, avatar_url: '' } };
};
const size = (patch: Partial<RepositorySandboxSizeResponse> = {}): RepositorySandboxSizeResponse =>
  ({ setting: 'auto', detected: null, effective: 'standard', ...patch });

describe('return links', () => {
  it.each([
    ['talyn-mobile', 'talyn-mobile://'],
    [['talyn-mobile-preview', 'other'], 'talyn-mobile-preview://'],
    [undefined, 'talyn-mobile-development://'],
    ['Bad Scheme', 'talyn-mobile-development://'],
    [42, 'talyn-mobile-development://'],
  ])('builds the base from scheme %p', (scheme, expected) => expect(appReturnBase(scheme)).toBe(expected));

  it.each([
    ['github', 'talyn-mobile://github/callback'],
    ['billing', 'talyn-mobile://billing/return'],
    ['mcp', 'talyn-mobile://mcp/callback'],
    ['slack', 'talyn-mobile://slack/callback'],
    ['posthog', 'talyn-mobile://posthog/callback'],
  ] as const)('ends a %s flow at its prefix', (kind, expected) => expect(returnPrefix(kind, 'talyn-mobile://')).toBe(expected));

  it.each([
    ['talyn-mobile://github/callback?github=connected', '/github/callback'],
    ['https://mobile.example.com/sessions/one', '/sessions/one'],
    ['talyn-mobile://billing/return', '/billing/return'],
  ])('reads the path of %s', (raw, expected) => expect(linkPath(new URL(raw))).toBe(expected));

  it.each([
    ['talyn-mobile://billing/return?kind=checkout&result=success', '/billing/return?kind=checkout&result=success'],
    ['talyn-mobile://billing/return?kind=portal&result=cancel&token=secret', '/billing/return?kind=portal&result=cancel'],
    ['talyn-mobile://billing/return?kind=evil&result=maybe', '/billing/return'],
    ['talyn-mobile://billing/return', '/billing/return'],
  ])('keeps only the return parameters of %s', (raw, expected) => expect(billingReturnPath(new URL(raw))).toBe(expected));

  it.each([
    ['talyn-mobile://github/callback?github=connected', { result: 'connected', reason: null }],
    ['talyn-mobile://github/callback?github=error&reason=state_mismatch', { result: 'error', reason: 'state_mismatch' }],
    ['talyn-mobile://github/callback?github=error&reason=<script>', { result: 'error', reason: null }],
    ['talyn-mobile://github/callback?github=maybe', null],
    ['talyn-mobile://github/callback', null],
  ])('parses the GitHub return %s', (raw, expected) => expect(parseGithubReturn(raw)).toEqual(expected));

  it.each([
    ['talyn-mobile://github/callback?github=connected', '/github/callback'],
    ['talyn-mobile-preview://github/callback?github=error&reason=denied', '/github/callback'],
    ['talyn-mobile://billing/return?kind=credits&result=success', '/billing/return?kind=credits&result=success'],
    ['talyn-mobile://auth/callback?code=abc', '/auth/callback'],
    ['talyn-mobile://mcp/callback?mcp=connected', '/mcp/callback'],
    ['talyn-mobile://mcp/callback?mcp=error&code=abc', '/mcp/callback'],
    ['talyn-mobile-preview://slack/callback?slack=installed', '/slack/callback'],
    ['talyn-mobile://slack/callback?slack=error&message=Denied', '/slack/callback'],
    ['talyn-mobile://posthog/callback?posthog=connected', '/posthog/callback'],
    ['talyn-mobile://posthog/callback?posthog=error&error=x', '/posthog/callback'],
  ])('routes the system link %s', (path, expected) => expect(redirectSystemPath({ path, initial: false })).toBe(expected));

  it('keeps the GitHub return for the screen that listens', () => {
    takeGithubReturn();
    redirectSystemPath({ path: 'talyn-mobile://github/callback?github=error&reason=denied', initial: false });
    expect(takeGithubReturn()).toEqual({ result: 'error', reason: 'denied' });
    expect(takeGithubReturn()).toBeNull();
    receiveGithubReturn('talyn-mobile://github/callback?nothing=1');
    expect(takeGithubReturn()).toBeNull();
  });
});

describe('GitHub install', () => {
  it('asks the server to return to the app', async () => {
    const call = jest.fn(async () => ({ installUrl: 'i', manageUrl: 'm' }));
    await expect(installUrls('ws', call, 'talyn-mobile://')).resolves.toEqual({ installUrl: 'i', manageUrl: 'm' });
    expect(call).toHaveBeenCalledWith('ws', { returnTo: 'talyn-mobile://' });
  });
  it('retries without the return when an older server refuses it', async () => {
    const call = jest.fn(async (_ws: string, options?: { returnTo?: string }) => {
      if (options) throw { status: 400, code: 'invalid_return_to' };
      return { installUrl: 'i', manageUrl: 'm' };
    });
    await expect(installUrls('ws', call, 'talyn-mobile://')).resolves.toEqual({ installUrl: 'i', manageUrl: 'm' });
    expect(call).toHaveBeenLastCalledWith('ws');
  });
  it.each([401, 500, undefined])('does not retry a %p failure', async (status) => {
    const call = jest.fn(async () => { throw { status }; });
    await expect(installUrls('ws', call, 'talyn-mobile://')).rejects.toEqual({ status });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [['Acme', 'beta', 'acme', 'Gamma'], [install('acme')], ['beta', 'Gamma']],
    [['acme'], [install('ACME', true)], ['acme']],
    [['a'], [install('a')], []],
    [[], [], []],
  ])('finds owners without an active install in %p', (owners, installations, expected) => {
    expect(uncoveredOwners(owners, installations)).toEqual(expected);
  });
  it.each([
    ['Acme', [install('acme')], true],
    ['acme', [install('acme', true)], false],
    ['other', [install('acme')], false],
  ])('knows whether %s is covered', (owner, installations, expected) => expect(isOwnerCovered(owner, installations)).toBe(expected));
  it.each([
    [[], ''], [['a'], '@a'], [['a', 'b'], '@a and @b'], [['a', 'b', 'c'], '@a, @b and @c'],
  ])('lists %p', (owners, expected) => expect(formatOwnerList(owners)).toBe(expected));
  it.each([
    ['nothing checked yet', [], false, ['a'], null],
    ['no install anywhere', [], true, [], /not installed on any account/],
    ['a watched owner without the app', [install('a')], true, ['a', 'b'], /not installed on @b/],
    ['every owner covered', [install('a')], true, ['a'], null],
  ])('warns about coverage when %s', (_name, installations, checked, owners, expected) => {
    const warning = coverageWarning(installations, checked, owners);
    if (expected === null) expect(warning).toBeNull();
    else expect(warning).toMatch(expected);
  });
});

describe('readiness checklist', () => {
  it('shows loading rows before an answer', () => {
    expect(readinessRows(undefined).map((row) => `${row.label}:${row.state}`)).toEqual(['Sandbox:loading', 'Claude Code:loading', 'Codex:loading']);
  });
  it.each([
    ['everything ready', readiness({ ok: true }, { ok: true }), ['ready:-', 'ready:-', 'ready:-']],
    ['Codex needs a connection', readiness({ ok: true }, { ok: false, reason: reason('agent_not_connected') }), ['ready:-', 'ready:-', 'blocked:connect']],
    ['Claude needs a new sign-in', readiness({ ok: false, reason: reason('agent_reauth_required') }, { ok: false, reason: reason('agent_not_connected') }),
      ['blocked:-', 'blocked:reauth', 'blocked:connect']],
    ['an agent blocked for another reason', readiness({ ok: false, reason: reason('quota') }, { ok: true }), ['ready:-', 'blocked:-', 'ready:-']],
    ['the sandbox is off', readiness({ ok: true }, { ok: true }, false, [reason('fleet_disabled', 'Paused.')]), ['blocked:-', 'blocked:-', 'blocked:-']],
  ])('rows when %s', (_name, value, expected) => {
    expect(readinessRows(value).map((row) => `${row.state}:${row.fix ?? '-'}`)).toEqual(expected);
  });
  it.each([
    ['the sandbox reason first', readiness({ ok: false, reason: reason('agent_not_connected') }, {}, false, [reason('fleet_disabled', 'Paused.')]), 'Paused.'],
    ['the agent reason', readiness({ ok: false, reason: reason('agent_not_connected', 'Connect Claude.') }, {}), 'Connect Claude.'],
    ['a fallback with no reason', readiness({ ok: false }, {}), 'Claude Code is not connected'],
  ])('explains with %s', (_name, value, expected) => expect(agentChoice(value, 'claude').reason).toBe(expected));
  it.each([
    ['nothing loaded', undefined, false],
    ['both agents unconnected', readiness({ ok: false, reason: reason('agent_not_connected') }, { ok: false, reason: reason('agent_not_connected') }), true],
    ['one agent connected', readiness({ ok: true }, { ok: false, reason: reason('agent_not_connected') }), false],
    ['a reconnect needed', readiness({ ok: false, reason: reason('agent_reauth_required') }, { ok: false, reason: reason('agent_not_connected') }), false],
    ['a sandbox outage', readiness({ ok: false, reason: reason('agent_not_connected') }, { ok: false, reason: reason('agent_not_connected') }, false), false],
  ])('nothing is connected with %s', (_name, value, expected) => expect(nothingConnected(value)).toBe(expected));
  it.each([
    ['a space is active', { repositories: [], readiness: undefined, inSpace: true }, 'composer'],
    ['no repository', { repositories: [], readiness: undefined, inSpace: false }, 'welcome'],
    ['repositories still loading', { repositories: undefined, readiness: undefined, inSpace: false }, 'composer'],
    ['repositories and no agent', { repositories: [1], readiness: readiness({ ok: false, reason: reason('agent_not_connected') },
      { ok: false, reason: reason('agent_not_connected') }), inSpace: false }, 'welcome'],
    ['repositories and an agent', { repositories: [1], readiness: readiness({ ok: true }, {}), inSpace: false }, 'composer'],
  ])('home draws the %s view', (_name, value, expected) => expect(homeView(value)).toBe(expected));
});

describe('repositories', () => {
  const all = [repo('Zeta/app'), repo('acme/api', true), repo('acme/web'), repo('beta/tool')];
  it.each([
    ['no search', '', ['acme/api', 'beta/tool', 'Zeta/app']],
    ['a search in any case', 'ACME', ['acme/api']],
    ['a search with spaces', '  tool ', ['beta/tool']],
    ['no match', 'nothing', []],
  ])('matches with %s and hides watched ones', (_name, search, expected) => {
    expect(matchRepos(all, [{ fullName: 'ACME/web' }], search).shown.map((item) => item.full_name)).toEqual(expected);
  });
  it('caps a long list and says so', () => {
    expect(matchRepos(all, [], '', 2)).toMatchObject({ total: 4, truncated: true, shown: [{ full_name: 'acme/api' }, { full_name: 'acme/web' }] });
  });
  it.each([
    [10_000, 'just now'], [5 * 60_000, '5m ago'], [3 * 3_600_000, '3h ago'], [2 * 86_400_000, '2d ago'],
  ])('formats an age of %i ms', (age, expected) => expect(formatAge(1_000_000_000 - age, 1_000_000_000)).toBe(expected));

  it.each([
    ['auto with detection', size({ detected: { size: 'large', reason: 'Runs Kafka.', sha: 's', at: 'a' }, effective: 'large' }),
      'Auto: Large · 12 GB', 'Auto picks Large · 12 GB: Runs Kafka.'],
    ['auto without detection', size(), 'Auto: Standard · 4 GB', 'Auto picks Standard · 4 GB.'],
    ['a fixed size', size({ setting: 'small', effective: 'small' }), 'Small · 2 vCPU', null],
  ])('summarises %s', (_name, info, summary, hint) => {
    expect(sizeSummary(info)).toBe(summary);
    expect(sizeHint(info)).toBe(hint);
  });

  it('locks the sizes Free cannot start and prices each one', () => {
    const options = sizeOptions(size(), 'free');
    expect(options.map((option) => `${option.setting}:${option.locked}`)).toEqual(
      ['auto:false', 'small:false', 'standard:false', 'medium:true', 'large:true', 'xlarge:true']);
    expect(options.find((option) => option.setting === 'large')?.detail).toMatch(/box-hours\/h · \$.*Requires Pro$/);
    expect(options[0].selected).toBe(true);
  });
  it('keeps a locked size that is already chosen selectable', () => {
    expect(sizeOptions(size({ setting: 'large', effective: 'large' }), 'free').find((option) => option.setting === 'large'))
      .toMatchObject({ locked: false, selected: true });
  });
  it.each(['pro', 'max', 'legacy_pro'] as const)('locks nothing on %s', (tier) => {
    expect(sizeOptions(size(), tier).some((option) => option.locked)).toBe(false);
  });
  it('locks and prices nothing when billing is off', () => {
    const options = sizeOptions(size(), null);
    expect(options.some((option) => option.locked || option.detail.includes('$'))).toBe(false);
  });
  it.each([
    ['free', 'large', true], ['free', 'standard', false], ['pro', 'xlarge', false], [null, 'xlarge', false],
  ] as const)('on %s a %s box is locked: %s', (tier, effective, expected) => expect(effectiveLocked({ effective }, tier)).toBe(expected));
});

describe('box refusals', () => {
  it.each([
    ['usage_exhausted', ['Plan and credits']],
    ['size_requires_pro', ['Change the box size', 'Plan and credits']],
    ['concurrent_box_limit_reached', ['Show sessions']],
  ] as const)('%s offers %p', (code, labels) => expect(refusalActions(code).map((action) => action.label)).toEqual(labels));
  it.each([
    ['usage_exhausted', '/billing'], ['concurrent_box_limit_reached', '/sessions'],
  ] as const)('%s goes to %s', (code, href) => expect(refusalActions(code)[0].href).toBe(href));
  it('sends a size refusal to the plan page with a note', () => {
    expect(refusalActions('size_requires_pro')[1].href).toEqual({ pathname: '/billing', params: { note: 'size_requires_pro' } });
  });
  it('keeps the server notice copy', () => {
    expect(boxRefusal({ code: 'size_requires_pro', details: { notice: { message: 'Large boxes need Pro.' } } }))
      .toEqual({ code: 'size_requires_pro', title: 'This size needs Pro', message: 'Large boxes need Pro.' });
  });
});

describe('onboarding progress', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return { map, storage: { getItem: jest.fn(async (key: string) => map.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { map.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { map.delete(key); }) } };
  };
  it('reads, starts and finishes, and keeps the answer in storage', async () => {
    const { map, storage } = memory();
    const progress = new OnboardingProgress(storage);
    const key = progressKey('user/1', 'ws');
    expect(key).toBe('talyn.onboarding.user%2F1.ws');
    expect(progress.read(key)).toBeUndefined();
    await progress.load(key);
    expect(progress.read(key)).toBe(false);
    progress.start(key);
    expect(progress.read(key)).toBe(true);
    await Promise.resolve();
    expect(map.get(key)).toBe('1');
    progress.finish(key);
    expect(progress.read(key)).toBe(false);
    await Promise.resolve();
    expect(map.has(key)).toBe(false);
  });
  it('resumes a stored start, and a start during the read wins', async () => {
    const { map, storage } = memory();
    map.set('a', '1');
    const first = new OnboardingProgress(storage);
    await first.load('a');
    expect(first.read('a')).toBe(true);
    const second = new OnboardingProgress(storage);
    const loading = second.load('b');
    second.start('b');
    await loading;
    expect(second.read('b')).toBe(true);
  });
  it('treats a storage failure as not started', async () => {
    const progress = new OnboardingProgress({ getItem: async () => { throw new Error('locked'); }, setItem: async () => {}, removeItem: async () => {} });
    await progress.load('k');
    expect(progress.read('k')).toBe(false);
  });
});
