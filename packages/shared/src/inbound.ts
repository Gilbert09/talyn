import type { WorkflowWithStats } from './workflows.js';

/**
 * Inbound integrations: requests that other systems send to Talyn, stored and
 * then matched against rules. The backend keeps one store for every vendor
 * (`inbound_connections`, `inbound_deliveries`) and one adapter per vendor.
 * Only the generic webhook exists today.
 */

/** The vendors an inbound connection can belong to. Only `webhook` has an adapter today. */
export const INBOUND_KINDS = ['webhook', 'linear', 'jira', 'sentry', 'posthog_errors'] as const;

export type InboundKind = (typeof INBOUND_KINDS)[number];

/** The header a sender may set to sign a webhook body: `sha256=<hex HMAC>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-talyn-signature';
/** The header a sender may set to name a delivery, so a resend is a no-op. */
export const WEBHOOK_DELIVERY_HEADER = 'x-talyn-delivery';
/** The header a sender may set to name the kind of event. */
export const WEBHOOK_EVENT_HEADER = 'x-talyn-event';

/** What a webhook rule's connection looks like after it was created. Never holds a secret. */
export interface WebhookConnectionSummary {
  connectionId: string;
  ruleId: string;
  /** The URL up to the token, for display: `https://…/webhooks/in/<id>/`. */
  urlPrefix: string;
  createdAt: string;
  /** When the URL and the signing secret were last replaced, or null. */
  rotatedAt: string | null;
  /** The newest delivery, or null when none arrived. */
  lastDeliveryAt: string | null;
}

/**
 * The URL and the signing secret, shown ONCE: when the rule is created and
 * when they are rotated. Talyn keeps only a hash of the URL token, so it
 * cannot show the URL again.
 */
export interface WebhookSecretReveal {
  connectionId: string;
  /** The full URL, token included. */
  url: string;
  /** The HMAC key for `X-Talyn-Signature`. Optional for the sender to use. */
  signingSecret: string;
}

/** What `POST /workflows` answers. A webhook rule carries its URL, once. */
export type CreatedWorkflow = WorkflowWithStats & { webhook?: WebhookSecretReveal };

export type InboundDeliveryOutcome = 'handled' | 'ignored' | 'failed';

/** One stored request, as a list shows it. Never carries the body. */
export interface InboundDeliverySummary {
  id: string;
  connectionId: string;
  /** The sender's delivery id, a hash of the body, or `<id>:replay:<n>`. */
  deliveryId: string;
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  attempts: number;
  /** `handled` when a rule ran, `ignored` when none matched, null while waiting. */
  outcome: InboundDeliveryOutcome | null;
  error: string | null;
  /** The delivery this one replays, or null. */
  replayOf: string | null;
  payloadBytes: number;
}

/** One stored request with its body and the headers Talyn kept. */
export interface InboundDelivery extends InboundDeliverySummary {
  payload: unknown;
  headers: Record<string, string>;
}

// ---- Linear -----------------------------------------------------------------

/** The answer code when this deployment has no Linear OAuth app. */
export const LINEAR_NOT_CONFIGURED_CODE = 'linear_not_configured';
/** The answer code when the `issueRules` flag is off for the caller. */
export const ISSUE_RULES_UNAVAILABLE_CODE = 'issue_rules_unavailable';

/** One connected Linear organization. Never holds a credential. */
export interface LinearConnection {
  id: string;
  workspaceId: string;
  organizationId: string;
  organizationName: string | null;
  /** The organization's URL key: `linear.app/<urlKey>`. */
  urlKey: string | null;
  scopes: string[];
  /** Whether the grant has `app:assignable`, so an issue can be assigned to Talyn. */
  canAssign: boolean;
  /** Set when Linear revoked the grant or a refresh failed for good. Connect again. */
  reauthRequiredAt: string | null;
  reauthReason: string | null;
  createdAt: string;
}

/** What `GET /linear` answers. */
export interface LinearStatus {
  /** Whether this deployment has a Linear OAuth app. */
  configured: boolean;
  connections: LinearConnection[];
}

export interface LinearAuthorizeResponse {
  authorizeUrl: string;
}

/** Editor data: one Linear team. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** Editor data: one Linear label. `teamId` is null for a workspace label. */
export interface LinearLabel {
  id: string;
  name: string;
  teamId: string | null;
}

/** Editor data: one Linear workflow state. */
export interface LinearWorkflowState {
  id: string;
  name: string;
  /** Linear's state type: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. */
  type: string;
  position: number;
  teamId: string;
}

/** Editor data: one Linear project. */
export interface LinearProject {
  id: string;
  name: string;
}

/** What `GET /linear/connections/:id/options` answers, for the rule editor. */
export interface LinearEditorOptions {
  teams: LinearTeam[];
  labels: LinearLabel[];
  states: LinearWorkflowState[];
  projects: LinearProject[];
  /** True when Linear could not be read; the fields still take typed values. */
  partial: boolean;
}

/** Linear's priority names, in Linear's order (0 = no priority). */
export const LINEAR_PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;
