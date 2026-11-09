import type { FleetAccountsResponse, FleetAccountView, WorkbenchReadiness } from '@talyn/shared';

import { defaultOptions, defaultPatch, defaultValue } from '../features/agents/model';
import { accountActions, accountErrorMessage, agentState, apiKeyError, apiKeyLabel, connectTarget, looksLikeClaudeCode, movedOrder,
  nextAccountLabel } from '../features/agents/connect/model';
import { CONNECT_ACTION, connectNotice } from '../features/create/model';

const account = (patch: Partial<FleetAccountView> = {}): FleetAccountView => ({
  id: 'a1', agent: 'claude', kind: 'claude_oauth', label: 'Claude 1', priority: 0, needsReauth: false, held: null, usage: null, over: false, ...patch,
});
const response = (accounts: FleetAccountView[]): FleetAccountsResponse => ({ accounts, switchAtPercent: 90, active: { claude: null, codex: null } });

describe('Claude code detection', () => {
  const state = '0123456789abcdef0123456789abcdef';
  it.each<[string, string | null | undefined, boolean]>([
    ['a code and state', `AbCdEf0123456789_-xyz#${state}`, true],
    ['surrounding whitespace', `  AbCdEf0123456789_-xyz#${state}\n`, true],
    ['no state', 'AbCdEf0123456789_-xyz', false],
    ['a short code', `abc#${state}`, false],
    ['a short state', 'AbCdEf0123456789_-xyz#abc', false],
    ['two hashes', `AbCdEf0123456789#${state}#${state}`, false],
    ['a space inside', `AbCdEf 0123456789xyz#${state}`, false],
    ['a URL', `https://example.com/page#${state}`, false],
    ['a sentence', 'Remember to buy milk tomorrow', false],
    ['empty', '', false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s', (_name, text, expected) => expect(looksLikeClaudeCode(text)).toBe(expected));
});

describe('API key validation', () => {
  it.each<[string, 'claude' | 'codex', string, string | null]>([
    ['an empty Claude key', 'claude', '   ', 'Paste a key.'],
    ['a Console key', 'claude', 'sk-ant-api03-abc', null],
    ['a setup token', 'claude', 'sk-ant-oat01-abc', null],
    ['a padded Console key', 'claude', '  sk-ant-api03-abc  ', null],
    ['an OpenAI key for Claude', 'claude', 'sk-proj-abc', 'That does not look like a Claude credential. Expected an OAuth token (sk-ant-oat…) from a Claude subscription, or a Console API key (sk-ant-api…).'],
    ['a key with a space for Claude', 'claude', 'sk-ant-api03 abc', 'That does not look like a Claude credential. Expected an OAuth token (sk-ant-oat…) from a Claude subscription, or a Console API key (sk-ant-api…).'],
    ['an empty OpenAI key', 'codex', '', 'Paste a key.'],
    ['an OpenAI key', 'codex', 'sk-proj-abc', null],
    ['a plain word for Codex', 'codex', 'password', 'That does not look like an OpenAI platform key. Expected sk-….'],
    ['a bare prefix for Codex', 'codex', 'sk-', 'That does not look like an OpenAI platform key. Expected sk-….'],
  ])('%s', (_name, agent, key, expected) => expect(apiKeyError(agent, key)).toBe(expected));
});

describe('connect target', () => {
  const stale = account({ id: 'stale', needsReauth: true });
  const staleKey = account({ id: 'key', kind: 'anthropic_key', needsReauth: true, label: 'Key' });
  const codex = account({ id: 'cx', agent: 'codex', kind: 'codex_oauth', needsReauth: true, label: 'Codex 1' });
  it.each<[string, FleetAccountsResponse | null | undefined, 'claude' | 'codex', { accountId?: string; add?: boolean }, unknown]>([
    ['an older backend', null, 'claude', {}, undefined],
    ['a list still loading', undefined, 'claude', {}, undefined],
    ['an older backend with a named account', null, 'claude', { accountId: 'x' }, { accountId: 'x' }],
    ['no accounts', response([]), 'claude', {}, { label: 'Claude 1' }],
    ['a healthy account', response([account()]), 'claude', {}, { label: 'Claude 2' }],
    ['a subscription to reconnect', response([account(), stale]), 'claude', {}, { accountId: 'stale' }],
    ['a reconnect skipped by add', response([stale]), 'claude', { add: true }, { label: 'Claude 2' }],
    ['a named account', response([stale]), 'claude', { accountId: 'a1' }, { accountId: 'a1' }],
    ['a stale API key, not a sign-in', response([staleKey]), 'claude', {}, { label: 'Claude 2' }],
    ['another agent’s stale account', response([codex]), 'claude', {}, { label: 'Claude 1' }],
    ['a stale Codex sign-in', response([codex]), 'codex', {}, { accountId: 'cx' }],
  ])('%s', (_name, value, agent, options, expected) => expect(connectTarget(value, agent, options)).toEqual(expected));

  it.each<[FleetAccountsResponse | null, 'claude' | 'codex', string | undefined]>([
    [null, 'claude', undefined],
    [response([]), 'codex', 'Codex 1'],
    [response([account(), account({ id: 'a2' }), codex]), 'claude', 'Claude 3'],
  ])('API key label %#', (value, agent, expected) => expect(apiKeyLabel(value, agent)).toBe(expected));

  it('names the next account by its agent', () => expect(nextAccountLabel([account(), codex], 'codex')).toBe('Codex 2'));
});

describe('agent state', () => {
  it.each<[string, FleetAccountsResponse | null | undefined, { connectedAgents?: string[]; reauthAgents?: string[] } | undefined, string, boolean, boolean]>([
    ['no accounts', response([]), undefined, 'Not connected', false, false],
    ['one healthy account', response([account()]), undefined, 'Connected', true, false],
    ['a healthy and a stale account', response([account(), account({ id: 'b', needsReauth: true })]), undefined, 'Connected', true, false],
    ['only stale accounts', response([account({ needsReauth: true })]), undefined, 'Reconnect needed', true, true],
    ['an older backend, connected', null, { connectedAgents: ['claude'] }, 'Connected', true, false],
    ['an older backend, reconnect', null, { connectedAgents: ['claude'], reauthAgents: ['claude'] }, 'Reconnect needed', true, true],
    ['an older backend, nothing', null, { connectedAgents: ['codex'] }, 'Not connected', false, false],
    ['nothing known', undefined, undefined, 'Not connected', false, false],
  ])('%s', (_name, value, fleet, label, connected, reauth) => {
    expect(agentState('claude', value, fleet)).toMatchObject({ label, connected, reauth });
  });
});

describe('account actions', () => {
  it.each<[string, Partial<FleetAccountView>, number, number, string[]]>([
    ['a lone subscription', {}, 0, 1, ['refresh', 'rename', 'remove']],
    ['a stale subscription', { needsReauth: true }, 0, 1, ['reconnect', 'refresh', 'rename', 'remove']],
    ['a stale ChatGPT sign-in', { kind: 'codex_oauth', needsReauth: true }, 0, 1, ['reconnect', 'refresh', 'rename', 'remove']],
    ['a stale API key', { kind: 'anthropic_key', needsReauth: true }, 0, 1, ['rename', 'remove']],
    ['the first of three', {}, 0, 3, ['refresh', 'down', 'rename', 'remove']],
    ['the middle of three', { kind: 'openai_key' }, 1, 3, ['up', 'down', 'rename', 'remove']],
    ['the last of three', {}, 2, 3, ['refresh', 'up', 'rename', 'remove']],
  ])('%s', (_name, patch, index, count, expected) => expect(accountActions(account(patch), index, count)).toEqual(expected));

  it.each<[number, -1 | 1, string[]]>([
    [0, 1, ['b', 'a', 'c']], [2, -1, ['a', 'c', 'b']], [0, -1, ['a', 'b', 'c']], [2, 1, ['a', 'b', 'c']], [5, 1, ['a', 'b', 'c']],
  ])('moves %i by %i', (index, direction, expected) => expect(movedOrder(['a', 'b', 'c'], index, direction)).toEqual(expected));

  it.each<[string, unknown, string]>([
    ['a turned-off second account', { code: 'multi_account_disabled', message: 'Multiple accounts are disabled' }, 'Adding more accounts is turned off for this workspace.'],
    ['a refused grant', { message: 'This sign-in cannot run a model.' }, 'This sign-in cannot run a model.'],
    ['a blank message', { message: '  ' }, 'Fallback.'],
    ['nothing', null, 'Fallback.'],
  ])('error for %s', (_name, error, expected) => expect(accountErrorMessage(error, 'Fallback.')).toBe(expected));
});

describe('default agent', () => {
  const providers = [
    { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude', 'codex', 'gemini'] },
    { type: 'posthog_code', displayName: 'PostHog Code', connected: true },
    { type: 'other', displayName: 'Other', connected: false },
  ];
  it('offers automatic, each connected agent and ask', () => {
    expect(defaultOptions(providers).map((option) => option.value)).toEqual(['', 'selfhosted:claude', 'selfhosted:codex', 'posthog_code', 'ask']);
    expect(defaultOptions(providers)[1].label).toBe('Talyn Fleet · Claude');
  });
  it.each<[string, Record<string, unknown> | null, string]>([
    ['nothing stored', null, ''],
    ['ask', { defaultCloudProvider: 'ask' }, 'ask'],
    ['PostHog Code', { defaultCloudProvider: 'posthog_code' }, 'posthog_code'],
    ['the fleet on a Claude model', { defaultCloudProvider: 'selfhosted', fleetModel: 'claude-opus-5-5' }, 'selfhosted:claude'],
    ['the fleet on a Codex model', { defaultCloudProvider: 'selfhosted', fleetModel: 'gpt-6-astra' }, 'selfhosted:codex'],
  ])('reads %s', (_name, settings, expected) => expect(defaultValue(settings as never)).toBe(expected));

  it.each<[string, string, Record<string, unknown>, Record<string, unknown>]>([
    ['automatic clears the default', '', { fleetModel: 'claude-opus-5-5' }, { defaultCloudProvider: null }],
    ['ask', 'ask', {}, { defaultCloudProvider: 'ask' }],
    ['the same vendor keeps the model', 'selfhosted:claude', { fleetModel: 'claude-opus-5-5' }, { defaultCloudProvider: 'selfhosted' }],
  ])('patch for %s', (_name, value, settings, expected) => expect(defaultPatch(value, settings as never)).toEqual(expected));

  it('remembers the model it leaves when the vendor changes', () => {
    const patch = defaultPatch('selfhosted:codex', { fleetModel: 'claude-opus-5-5' } as never);
    expect(patch.defaultCloudProvider).toBe('selfhosted');
    expect(patch.fleetModels).toEqual({ claude: 'claude-opus-5-5' });
    expect(String(patch.fleetModel)).toMatch(/^gpt-/);
  });
});

describe('composer connect notice', () => {
  const sandbox = (claude: unknown, ok = true): WorkbenchReadiness['sandbox'] => ({ ok, reasons: ok ? [] : [{ code: 'fleet_not_deployed', message: 'Down' }],
    agents: { claude, codex: { ok: true } } } as WorkbenchReadiness['sandbox']);
  it.each<[string, WorkbenchReadiness['sandbox'] | null, unknown]>([
    ['loading', null, null],
    ['a ready agent', sandbox({ ok: true }), null],
    ['a sandbox outage', sandbox({ ok: true }, false), null],
    ['another reason', sandbox({ ok: false, reason: { code: 'fleet_capacity', message: 'Busy' } }), null],
    ['no subscription', sandbox({ ok: false, reason: { code: 'agent_not_connected', message: 'x' } }),
      { agent: 'claude', kind: 'connect', message: 'Claude is not connected. Connect your Claude subscription to start.', action: 'Connect' }],
    ['an expired sign-in', sandbox({ ok: false, reason: { code: 'agent_reauth_required', message: 'x' } }),
      { agent: 'claude', kind: 'reauth', message: 'The Claude sign-in has expired. Sign in again to start.', action: 'Sign in' }],
  ])('%s', (_name, value, expected) => expect(connectNotice(value, 'claude')).toEqual(expected));

  it('names ChatGPT for Codex', () => {
    const value = { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: false, reason: { code: 'agent_not_connected', message: 'x' } } } } as WorkbenchReadiness['sandbox'];
    expect(connectNotice(value, 'codex')?.message).toBe('Codex is not connected. Connect your ChatGPT subscription to start.');
  });

  it.each([['connect', 'Connect'], ['reauth', 'Sign in again']] as const)('model sheet action for %s', (kind, label) => expect(CONNECT_ACTION[kind]).toBe(label));
});
