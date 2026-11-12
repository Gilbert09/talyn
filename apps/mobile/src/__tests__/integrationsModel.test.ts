import type { PostHogCodeStatus } from '@talyn/client/native';
import { DEFAULT_POSTHOG_CODE_MODEL_ID, INVALID_RETURN_TO_CODE, type LinearConnection, type TrunkIntegrationStatus } from '@talyn/shared';

import {
  githubIssuesAvailable, isHttpsUrl, keyFormOpen, linearConnectionView, linearReturnError, postHogKeyConfig, postHogModelLabel, postHogModelOf, postHogOAuthOptions, postHogView, refusesReturnTarget,
  ruleIntegration, TRUNK_DESCRIPTION, trunkFormOpen, trunkToken, trunkView, withAppReturn,
} from '../features/integrations/model';

describe('PostHog Code key form', () => {
  it.each([
    [{ apiKey: 'phx_1', projectId: '2', host: 'https://us.posthog.com' }, { apiKey: 'phx_1', projectId: '2', host: 'https://us.posthog.com' }],
    [{ apiKey: '  phx_1 ', projectId: ' 2 ', host: ' https://eu.posthog.com  ' }, { apiKey: 'phx_1', projectId: '2', host: 'https://eu.posthog.com' }],
    [{ apiKey: 'phx_1', projectId: '2', host: '' }, { apiKey: 'phx_1', projectId: '2' }],
    [{ apiKey: 'phx_1', projectId: '2', host: '   ' }, { apiKey: 'phx_1', projectId: '2' }],
    [{ apiKey: '', projectId: '2', host: 'https://us.posthog.com' }, null],
    [{ apiKey: '   ', projectId: '2', host: 'https://us.posthog.com' }, null],
    [{ apiKey: 'phx_1', projectId: '', host: 'https://us.posthog.com' }, null],
    [{ apiKey: 'phx_1', projectId: '  ', host: 'https://us.posthog.com' }, null],
    [{ apiKey: '', projectId: '', host: '' }, null],
  ])('builds the save body for %j', (input, expected) => {
    expect(postHogKeyConfig(input)).toEqual(expected);
  });

  it.each([
    ['https://us.posthog.com', '2', 'talyn-mobile://', { host: 'https://us.posthog.com', projectId: '2', returnTo: 'talyn-mobile://' }],
    [' https://eu.posthog.com ', undefined, undefined, { host: 'https://eu.posthog.com' }],
    ['', '7', undefined, { projectId: '7' }],
    ['   ', undefined, 'talyn-mobile://', { returnTo: 'talyn-mobile://' }],
    ['', undefined, undefined, {}],
  ])('builds the OAuth options for host %p, project %p, return %p', (host, projectId, returnTo, expected) => {
    expect(postHogOAuthOptions(host, projectId, returnTo)).toEqual(expected);
  });
});

describe('PostHog Code card state', () => {
  const s = (status: Partial<PostHogCodeStatus> | null) => status as PostHogCodeStatus | null;
  it.each([
    [null, { connected: false, badge: 'Not Connected', action: 'edit', description: /personal API key \+ project id/ }],
    [s({ connected: false }), { connected: false, badge: 'Not Connected', action: 'edit', description: /personal API key/ }],
    [s({ connected: false, oauthAvailable: true }), { connected: false, badge: 'Not Connected', action: 'switch', description: /Connect your PostHog account/ }],
    [s({ connected: true, projectId: '2', host: 'https://us.posthog.com', authMethod: 'personal_api_key' }),
      { connected: true, badge: 'Connected', action: 'edit', description: 'Cloud tasks run under project 2 on https://us.posthog.com.' }],
    [s({ connected: true, projectId: '2', host: 'https://us.posthog.com', authMethod: 'personal_api_key', oauthAvailable: true }),
      { connected: true, badge: 'Connected', action: 'switch', description: 'Cloud tasks run under project 2 on https://us.posthog.com.' }],
    [s({ connected: true, projectId: '9', host: 'https://eu.posthog.com', authMethod: 'oauth', oauthAvailable: true }),
      { connected: true, badge: 'Connected', action: 'reconnect', description: 'Cloud tasks run under project 9 on https://eu.posthog.com, authorized with your PostHog account.' }],
    [s({ connected: true, projectId: '9', host: 'https://eu.posthog.com', authMethod: 'oauth', needsReauth: true }),
      { connected: true, badge: 'Reconnect needed', action: 'reconnect', description: /PostHog rejected the stored authorization/ }],
  ])('derives the view for %j', (status, expected) => {
    const view = postHogView(status);
    expect(view.connected).toBe(expected.connected);
    expect(view.badge.label).toBe(expected.badge);
    expect(view.connectedAction.kind).toBe(expected.action);
    if (typeof expected.description === 'string') expect(view.description).toBe(expected.description);
    else expect(view.description).toMatch(expected.description);
  });

  it('only trusts an explicit oauthAvailable', () => {
    expect(postHogView(s({ connected: false, oauthAvailable: 'yes' as unknown as boolean })).oauthAvailable).toBe(false);
  });

  it.each([
    [{ connected: false, oauthAvailable: false }, false, true],
    [{ connected: false, oauthAvailable: true }, false, false],
    [{ connected: true, oauthAvailable: false }, false, false],
    [{ connected: true, oauthAvailable: true }, false, false],
    [{ connected: true, oauthAvailable: true }, true, true],
    [{ connected: false, oauthAvailable: true }, true, true],
  ])('opens the key form for %j while editing=%p', (view, editing, open) => {
    expect(keyFormOpen(view, editing)).toBe(open);
  });

  it.each([
    [undefined, DEFAULT_POSTHOG_CODE_MODEL_ID],
    [null, DEFAULT_POSTHOG_CODE_MODEL_ID],
    [{}, DEFAULT_POSTHOG_CODE_MODEL_ID],
    [{ posthogCodeModel: 'claude-sonnet-5' }, 'claude-sonnet-5'],
  ])('reads the model from %j', (settings, model) => {
    expect(postHogModelOf(settings as never)).toBe(model);
  });

  it.each([['claude-opus-5', 'Opus 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-opus-4-5', 'claude-opus-4-5']])('labels %p', (id, label) => {
    expect(postHogModelLabel(id)).toBe(label);
  });
});

describe('Trunk card state', () => {
  const t = (status: Partial<TrunkIntegrationStatus> | null) => status as TrunkIntegrationStatus | null;
  it.each([
    [null, { connected: false, badge: null, replace: 'Replace key', description: TRUNK_DESCRIPTION }],
    [t({ connected: false, needsReauth: false }), { connected: false, badge: null, replace: 'Replace key', description: TRUNK_DESCRIPTION }],
    [t({ connected: true, needsReauth: false }), { connected: true, badge: 'Connected', replace: 'Replace key', description: TRUNK_DESCRIPTION }],
    [t({ connected: true, needsReauth: true }),
      { connected: true, badge: 'Reconnect needed', replace: 'Reconnect', description: 'Trunk refused the saved API key. Paste a new key to see merge ETAs again.' }],
    [t({ connected: true, needsReauth: true, reauthReason: 'Trunk answered 401.' }),
      { connected: true, badge: 'Reconnect needed', replace: 'Reconnect', description: 'Trunk answered 401. Paste a new key to see merge ETAs again.' }],
  ])('derives the view for %j', (status, expected) => {
    const view = trunkView(status);
    expect(view.connected).toBe(expected.connected);
    expect(view.badge?.label ?? null).toBe(expected.badge);
    expect(view.replaceLabel).toBe(expected.replace);
    expect(view.description).toBe(expected.description);
  });

  it.each([[false, false, true], [false, true, true], [true, false, false], [true, true, true]])(
    'shows the form when connected=%p and editing=%p: %p', (connected, editing, open) => {
      expect(trunkFormOpen({ connected }, editing)).toBe(open);
    });

  it.each([['trunk_v2_abc', 'trunk_v2_abc'], ['  trunk_v2_abc\n', 'trunk_v2_abc'], ['', null], ['   ', null]])('trims token %p', (raw, token) => {
    expect(trunkToken(raw)).toBe(token);
  });
});

describe('return target fallback', () => {
  const error = (status: number, code?: string) => Object.assign(new Error('refused'), { status, code });
  it.each([
    [error(400, INVALID_RETURN_TO_CODE), true],
    [error(400), true],
    [error(400, 'invalid_host'), false],
    [error(500), false],
    [error(503, 'slack_not_configured'), false],
    [null, false],
    ['text', false],
  ])('refuses the return target for %p: %p', (value, refused) => {
    expect(refusesReturnTarget(value)).toBe(refused);
  });

  it('asks with the return target first', async () => {
    const request = jest.fn(async (returnTo?: string) => returnTo ?? 'none');
    await expect(withAppReturn(request, 'talyn-mobile://')).resolves.toBe('talyn-mobile://');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks once more without it when an older server refuses it', async () => {
    const request = jest.fn(async (returnTo?: string) => {
      if (returnTo) throw error(400, INVALID_RETURN_TO_CODE);
      return 'web';
    });
    await expect(withAppReturn(request, 'talyn-mobile://')).resolves.toBe('web');
    expect(request.mock.calls).toEqual([['talyn-mobile://'], [undefined]]);
  });

  it('does not retry another error', async () => {
    const request = jest.fn(async () => { throw error(503, 'slack_not_configured'); });
    await expect(withAppReturn(request, 'talyn-mobile://')).rejects.toMatchObject({ code: 'slack_not_configured' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['https://us.posthog.com/oauth/authorize?x=1', true],
    ['http://us.posthog.com/oauth', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    [undefined, false],
  ])('accepts %p as a browser address: %p', (url, ok) => {
    expect(isHttpsUrl(url)).toBe(ok);
  });
});

describe('issue integrations model', () => {
  it.each([
    ['slack', 'slack'], ['webhook', 'webhook'], ['linear', 'linear'], ['github_issues', 'github_issues'],
    ['github', 'github'], ['schedule', 'github'], ['tailscale', 'github'],
  ] as const)('opens the %s card on the %s rule list', (kind, expected) => {
    expect(ruleIntegration(kind)).toBe(expected);
  });

  it.each([
    [{ organizationName: 'Acme', urlKey: 'acme', reauthRequiredAt: null, reauthReason: null }, 'Acme', false, 'Connected'],
    [{ organizationName: null, urlKey: 'acme', reauthRequiredAt: null, reauthReason: null }, 'acme', false, 'Connected'],
    [{ organizationName: null, urlKey: null, reauthRequiredAt: null, reauthReason: null }, 'Linear workspace', false, 'Connected'],
    [{ organizationName: 'Acme', urlKey: 'acme', reauthRequiredAt: '2026-11-10T00:00:00Z', reauthReason: 'Revoked.' }, 'Acme', true, 'Revoked.'],
    [{ organizationName: 'Acme', urlKey: 'acme', reauthRequiredAt: '2026-11-10T00:00:00Z', reauthReason: null }, 'Acme', true,
      'Linear ended the connection. Connect again.'],
  ] as const)('describes a Linear connection %j', (partial, name, needsReconnect, detail) => {
    expect(linearConnectionView({ id: 'c1', ...partial } as unknown as LinearConnection)).toEqual({ id: 'c1', name, needsReconnect, detail });
  });

  it.each([
    ['talyn-mobile://linear/callback?linear=connected', null],
    ['talyn-mobile://linear/callback?linear=error&message=Nope', 'Nope'],
    ['talyn-mobile://linear/callback?linear=error', 'Linear sign-in did not finish.'],
    ['not a url', null],
  ])('reads the Linear return %s', (url, expected) => {
    expect(linearReturnError(url)).toBe(expected);
  });

  it.each([[true], [false]])('offers GitHub Issues when GitHub connected is %s', (connected) => {
    expect(githubIssuesAvailable(connected)).toBe(connected);
  });
});
