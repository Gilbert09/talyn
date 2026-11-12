import { webhookAdapter } from './webhook.js';

/**
 * The adapter for a connection's kind, or null when this build has none.
 * Each later vendor (Linear, Sentry, Jira) adds a branch here.
 */
export function inboundAdapterFor(kind: string): typeof webhookAdapter | null {
  return kind === 'webhook' ? webhookAdapter : null;
}
