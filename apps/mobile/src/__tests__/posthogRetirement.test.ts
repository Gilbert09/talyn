import {
  automaticDefaultCopy,
  integrationsLinkTitle,
  postHogCatalogOffered,
  postHogListed,
  postHogRetirement,
} from '../features/integrations/posthogRetirement';

type Flag = { posthogCodeRetired: boolean } | null;
const ON: Flag = { posthogCodeRetired: true };
const OFF: Flag = { posthogCodeRetired: false };

describe('postHogRetirement', () => {
  it.each<[string, Flag, Parameters<typeof postHogRetirement>[1], { offered: boolean; notice: boolean }]>([
    ['flag unknown, status loading', null, undefined, { offered: true, notice: false }],
    ['flag off, not connected', OFF, { connected: false }, { offered: true, notice: false }],
    ['flag off, connected', OFF, { connected: true }, { offered: true, notice: false }],
    ['flag on, status loading', ON, undefined, { offered: false, notice: false }],
    ['flag on, not connected', ON, { connected: false }, { offered: false, notice: false }],
    ['flag on, connected', ON, { connected: true }, { offered: true, notice: true }],
    ['flag on, host no longer allowed', ON, { connected: false, hostNotAllowed: true }, { offered: true, notice: true }],
  ])('%s', (_label, features, status, expected) => {
    expect(postHogRetirement(features, status)).toEqual(expected);
    expect(postHogCatalogOffered(features, status)).toBe(expected.offered);
  });
});

describe('provider list helpers', () => {
  const fleetOnly = [{ type: 'selfhosted' }];
  const withPostHog = [{ type: 'selfhosted' }, { type: 'posthog_code' }];

  it.each<[string, Flag, { type: string }[], boolean, string]>([
    ['flag off', OFF, fleetOnly, true, 'PostHog Code and Trunk'],
    ['flag unknown', null, fleetOnly, true, 'PostHog Code and Trunk'],
    ['flag on, not listed', ON, fleetOnly, false, 'Integrations'],
    ['flag on, still listed', ON, withPostHog, true, 'PostHog Code and Trunk'],
  ])('%s', (_label, features, providers, listed, title) => {
    expect(postHogListed(features, providers)).toBe(listed);
    expect(integrationsLinkTitle(features, providers)).toBe(title);
  });

  it.each<[Flag, string]>([
    [OFF, 'Automatic prefers Talyn Fleet, then PostHog Code.'],
    [null, 'Automatic prefers Talyn Fleet, then PostHog Code.'],
    [ON, 'Automatic prefers Talyn Fleet.'],
  ])('automatic default copy for %j', (features, copy) => {
    expect(automaticDefaultCopy(features)).toBe(copy);
  });
});
