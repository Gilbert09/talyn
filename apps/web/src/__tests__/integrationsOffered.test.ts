import { describe, expect, it } from 'vitest';
import { integrationRulesOffered, integrationsOffered, type IntegrationKind } from '@talyn/shared';

describe('integrationsOffered', () => {
  it.each<[string, Parameters<typeof integrationsOffered>[0], IntegrationKind[]]>([
    ['features still loading', null, []],
    ['nothing gated', {}, ['github', 'posthog']],
    ['sessions on', { workbenches: true }, ['github', 'slack', 'posthog']],
    ['schedule on', { loops: true }, ['github', 'schedule', 'posthog']],
    ['private routes on', { privateRoutes: true }, ['github', 'tailscale', 'posthog']],
    ['Trunk on', { trunkMergeEta: true }, ['github', 'posthog', 'trunk']],
    ['issue rules on', { workflows: true, issueRules: true }, ['github', 'github_issues', 'linear', 'posthog']],
    ['issue rules need workflows', { workflows: false, issueRules: true }, ['github', 'posthog']],
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
    ['Linear rules need the issue rules flag', 'linear', { workflows: true }, false],
    ['Linear rules with the issue rules flag', 'linear', { workflows: true, issueRules: true }, true],
    ['GitHub Issues rules with the issue rules flag', 'github_issues', { workflows: true, issueRules: true }, true],
    ['GitHub Issues rules need workflows', 'github_issues', { workflows: false, issueRules: true }, false],
  ])('%s', (_label, kind, features, expected) => {
    expect(integrationRulesOffered(features, kind)).toBe(expected);
  });
});
