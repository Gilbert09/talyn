import type { WebhookEventFacts } from '@talyn/shared';
import { workspaceMayUseWebhookRules } from '../../workflowsAccess.js';
import type { InboundWorkflowInput } from '../../inbound/adapter.js';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../source.js';

/**
 * The webhook source adapter: one stored request to a rule's URL in, the facts
 * of that request out.
 *
 * A generic webhook connection belongs to exactly one rule, so the only target
 * is that rule's workspace, and the matcher refuses every other rule
 * (`workflowMatches` compares the rule id). The engine core does the rest: the
 * flags, the per-rule rate cap, the claim on `inbound:<connection>:<delivery>`
 * and the actions.
 */

export interface WebhookWorkflowTarget extends WorkflowSourceTarget {
  repositoryId: null;
  ruleId: string;
}

export const webhookWorkflowSource: WorkflowSourceAdapter<
  InboundWorkflowInput<WebhookEventFacts>,
  WebhookWorkflowTarget,
  WebhookEventFacts
> = {
  integration: 'webhook',

  facts: (input) => input.facts,

  // A replay has its own `delivery_id` (`<orig>:replay:<n>`), so it gets a
  // fresh claim and the rule runs again.
  deliveryId: (input) => `inbound:${input.connection.id}:${input.delivery.deliveryId}`,

  targets: async (input) =>
    input.connection.ruleId
      ? [{ workspaceId: input.connection.workspaceId, repositoryId: null, ruleId: input.connection.ruleId }]
      : [],

  workspaceAllowed: workspaceMayUseWebhookRules,

  prepare: async (target, facts) => ({ facts: facts.filter((f) => f.ruleId === target.ruleId) }),

  actionContext: (_target, facts, base) => ({
    ...base,
    integration: 'webhook',
    repositoryId: null,
    facts,
  }),

  // No account-wide gate: a webhook action calls no vendor API.
  blockedUntilMs: () => 0,

  describe: (input) => `webhook ${input.connection.id} (${input.delivery.deliveryId})`,
};
