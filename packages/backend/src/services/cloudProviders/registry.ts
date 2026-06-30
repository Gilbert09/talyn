import type { CloudProviderType } from '@talyn/shared';
import type { CloudTaskProvider } from './types.js';

/**
 * Registry of cloud task providers, keyed by their `type`. Providers
 * register themselves at boot (see index.ts). The task queue, poller, and
 * the generic `/api/cloud-providers` routes all resolve through here, so
 * adding a provider is a register call plus its own module — no edits to
 * the dispatch/poll/credential cores.
 */
const providers = new Map<CloudProviderType, CloudTaskProvider>();

export function registerCloudProvider(provider: CloudTaskProvider): void {
  providers.set(provider.type, provider);
}

export function getCloudProvider(
  type: string | null | undefined,
): CloudTaskProvider | null {
  if (!type) return null;
  return providers.get(type as CloudProviderType) ?? null;
}

export function isCloudProvider(type: string | null | undefined): boolean {
  return !!type && providers.has(type as CloudProviderType);
}

export function listCloudProviders(): CloudTaskProvider[] {
  return [...providers.values()];
}
