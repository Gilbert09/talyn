import type { WorkflowFacts } from '@talyn/shared';
import type { WorkflowSourceTarget } from '../../workflows/source.js';
import type { InboundAdapter, InboundVendorRoute } from '../adapter.js';
import { linearAdapter, linearVendorRoute } from './linear.js';
import { webhookAdapter } from './webhook.js';

/**
 * The adapter for a connection's kind, or null when this build has none.
 * Each later vendor (Sentry, Jira) adds a branch here.
 */
export function inboundAdapterFor(kind: string): InboundAdapter<WorkflowFacts, WorkflowSourceTarget> | null {
  if (kind === 'webhook') return webhookAdapter as unknown as InboundAdapter<WorkflowFacts, WorkflowSourceTarget>;
  if (kind === 'linear') return linearAdapter as unknown as InboundAdapter<WorkflowFacts, WorkflowSourceTarget>;
  return null;
}

/** The app-level vendor routes, mounted at `/webhooks/in/<path>`. */
export const INBOUND_VENDOR_ROUTES: readonly InboundVendorRoute[] = [linearVendorRoute];
