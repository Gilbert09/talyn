import { integrationRulesOffered, integrationsOffered, type IntegrationKind } from '@talyn/shared';

describe('integrationsOffered', () => {
  it.each<[string, Parameters<typeof integrationsOffered>[0], IntegrationKind[]]>([
    ['features still loading', null, []],
    ['nothing gated', {}, ['github', 'posthog']],
    ['sessions on', { workbenches: true }, ['github', 'slack', 'posthog']],
    ['schedule on', { loops: true }, ['github', 'schedule', 'posthog']],
    ['private routes on', { privateRoutes: true }, ['github', 'tailscale', 'posthog']],
    ['Trunk on', { trunkMergeEta: true }, ['github', 'posthog', 'trunk']],
    [
      'everything on',
      { workbenches: true, loops: true, privateRoutes: true, trunkMergeEta: true },
      ['github', 'slack', 'schedule', 'tailscale', 'posthog', 'trunk'],
    ],
  ])('%s', (_label, features, expected) => {
    expect(integrationsOffered(features)).toEqual(expected);
  });
});

describe('integrationRulesOffered', () => {
  it.each<[string, IntegrationKind, Parameters<typeof integrationRulesOffered>[0], boolean]>([
    ['GitHub rules need the workflows flag', 'github', { workflows: false }, false],
    ['GitHub rules with the workflows flag', 'github', { workflows: true }, true],
    ['Schedule rules need the loops flag', 'schedule', {}, false],
    ['Schedule rules with the loops flag', 'schedule', { loops: true }, true],
    ['Slack has no rules yet', 'slack', { workbenches: true, workflows: true }, false],
    ['nothing while loading', 'github', null, false],
  ])('%s', (_label, kind, features, expected) => {
    expect(integrationRulesOffered(features, kind)).toBe(expected);
  });
});
