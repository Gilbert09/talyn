import { describe, it, expect } from 'vitest';
import { CLOUD_PROVIDER_ORDER, cloudProviderRank, type CloudProviderType } from '@talyn/shared';

/**
 * The order Talyn recommends providers in — asserted once, because it used to
 * be decided in two places that pointed opposite ways.
 *
 * `resolveCloudEnvChain` had its own constant preferring the fleet, while every
 * list the user SEES came out in whatever order the providers happened to call
 * `registerCloudProvider` at boot — and PostHog Code registers first. So the
 * app picked the fleet and recommended PostHog Code, on the same screen.
 */
describe('cloud provider preference order', () => {
  it('leads with the fleet', () => {
    // Not a style choice. The fleet runs on the workspace's own Claude or Codex
    // subscription; PostHog Code needs a PostHog account and bills metered
    // credits on top. For everyone outside one company the fleet is the answer.
    expect(CLOUD_PROVIDER_ORDER[0]).toBe('selfhosted');
    expect(cloudProviderRank('selfhosted')).toBeLessThan(cloudProviderRank('posthog_code'));
  });

  it('sorts an unlisted provider LAST rather than dropping it', () => {
    // `codex_cloud` is deferred, not forbidden — OpenAI exposes no
    // server-to-server API today. A provider missing from a list it was left
    // out of is a far smaller problem than one that silently vanishes, so the
    // rank is a fallback position and never a filter.
    expect(cloudProviderRank('codex_cloud')).toBe(CLOUD_PROVIDER_ORDER.length);
    expect(cloudProviderRank('a-provider-from-the-future')).toBe(CLOUD_PROVIDER_ORDER.length);

    const listed: CloudProviderType[] = ['posthog_code', 'codex_cloud', 'selfhosted'];
    const sorted = [...listed].sort((a, b) => cloudProviderRank(a) - cloudProviderRank(b));
    expect(sorted).toEqual(['selfhosted', 'posthog_code', 'codex_cloud']);
  });

  it('is a stable sort, so equally-ranked providers keep their registration order', () => {
    // Two unlisted providers both rank last. Array.prototype.sort is required
    // to be stable, so they come out in the order they arrived rather than
    // shuffling between boots — which would make the settings screen reorder
    // itself for no reason the user could see.
    const listed = ['b-unlisted', 'posthog_code', 'a-unlisted', 'selfhosted'];
    const sorted = [...listed].sort((a, b) => cloudProviderRank(a) - cloudProviderRank(b));
    expect(sorted).toEqual(['selfhosted', 'posthog_code', 'b-unlisted', 'a-unlisted']);
  });
});
