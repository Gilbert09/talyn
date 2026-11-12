import { integrationRulesOffered, integrationsOffered } from '@talyn/shared';

describe('integration catalog gates', () => {
  it.each([
    [null, []],
    [{}, ['github', 'posthog']],
    [{ workbenches: true, loops: true, privateRoutes: true, trunkMergeEta: true },
      ['github', 'slack', 'schedule', 'tailscale', 'posthog', 'trunk']],
  ] as const)('offers the right cards for %j', (features, kinds) => {
    expect(integrationsOffered(features)).toEqual(kinds);
  });

  it.each([
    [{ workflows: true, webhookRules: true }, true],
    [{ webhookRules: true }, false],
    [{ webhookRules: false }, false],
    [{}, false],
    [null, false],
  ] as const)('offers the webhook card for %j: %s', (features, offered) => {
    expect(integrationsOffered(features).includes('webhook')).toBe(offered);
  });

  it('shows GitHub rules only with the workflow feature', () => {
    expect(integrationRulesOffered({ workflows: false }, 'github')).toBe(false);
    expect(integrationRulesOffered({ workflows: true }, 'github')).toBe(true);
  });

  it.each([
    [{ workflows: true, issueRules: true }, true],
    [{ workflows: true, issueRules: false }, false],
    [{ workflows: false, issueRules: true }, false],
    [{}, false],
    [null, false],
  ] as const)('offers the issue cards for %j: %s', (features, offered) => {
    const kinds = integrationsOffered(features);
    expect(kinds.includes('linear')).toBe(offered);
    expect(kinds.includes('github_issues')).toBe(offered);
    expect(integrationRulesOffered(features, 'linear')).toBe(offered);
    expect(integrationRulesOffered(features, 'github_issues')).toBe(offered);
  });
});
