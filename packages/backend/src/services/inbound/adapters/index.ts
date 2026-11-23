import type { WorkflowFacts } from '@talyn/shared';
import type { WorkflowSourceTarget } from '../../workflows/source.js';
import type { AnyInboundAdapter, InboundAdapter, InboundVendorRoute } from '../adapter.js';
import { linearAdapter, linearVendorRoute } from './linear.js';
import { posthogInboxAdapter } from './posthogInbox.js';
import { webhookAdapter } from './webhook.js';

/**
 * The adapter for a connection's kind, or null when this build has none.
 * Each later vendor (Sentry, Jira) adds a branch here.
 */
export function inboundAdapterFor(kind: string): AnyInboundAdapter | null {
  if (kind === 'webhook') return webhookAdapter as unknown as InboundAdapter<WorkflowFacts, WorkflowSourceTarget>;
  if (kind === 'linear') return linearAdapter as unknown as InboundAdapter<WorkflowFacts, WorkflowSourceTarget>;
  if (kind === 'posthog_inbox') return posthogInboxAdapter;
  return null;
}

/** The app-level vendor routes, mounted at `/webhooks/in/<path>`. */
export const INBOUND_VENDOR_ROUTES: readonly InboundVendorRoute[] = [linearVendorRoute];
