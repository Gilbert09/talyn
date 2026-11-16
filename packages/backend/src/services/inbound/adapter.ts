import type { IncomingHttpHeaders } from 'node:http';
import type { InboundKind, WorkflowFacts } from '@talyn/shared';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../workflows/source.js';

/**
 * One vendor's part of the inbound layer.
 *
 * The receiver, the store, the processing claim and the sweep are the same for
 * every vendor. An adapter owns only what differs: how a request proves it came
 * from the sender, which id a resend repeats, what to call the event, and the
 * facts a rule matches on. The generic webhook and Linear exist today;
 * Sentry and Jira are later adapters of this shape.
 *
 * A "nudge" adapter (the PostHog Inbox) takes no facts from the request. Its
 * request only names a subject, and `nudge` reads the subject from the vendor
 * with the connection's own credentials before any rule runs.
 */

export type InboundVerifyResult = 'valid' | 'invalid' | 'missing' | 'stale';

/** What the receiver gives `verify`. Secrets are read only for the one connection asked about. */
export interface InboundVerifyInput {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  /** The token in the URL, or null when the route had none. */
  urlToken: string | null;
  connection: InboundConnectionSecrets;
}

/** The parts of a connection the receiver needs. Never sent to a client. */
export interface InboundConnectionSecrets {
  id: string;
  workspaceId: string;
  kind: InboundKind;
  ruleId: string | null;
  tokenHash: string | null;
  /** The decrypted signing secret, or null when the connection has none. */
  signingSecret: string | null;
  /**
   * Whether the row stores a secret. True with a null `signingSecret` means
   * the secret did not decrypt: an adapter that requires its secret refuses.
   */
  hasSecret: boolean;
}

/** A connection as the processing step reads it. No secrets. */
export interface InboundConnectionRef {
  id: string;
  workspaceId: string;
  kind: InboundKind;
  ruleId: string | null;
  /** The vendor account the connection is for (the PostHog project id), when it has one. */
  externalAccountId?: string | null;
}

/** A stored delivery as the processing step reads it. */
export interface StoredInboundDelivery {
  /** `inbound_deliveries.id`. */
  id: string;
  connectionId: string;
  deliveryId: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, string>;
  receivedAt: Date;
}

/** What one stored delivery hands the rules engine. */
export interface InboundWorkflowInput<Facts extends WorkflowFacts> {
  connection: InboundConnectionRef;
  delivery: StoredInboundDelivery;
  facts: Facts[];
}

/** What every adapter has: the request checks and the flag. */
interface InboundAdapterBase {
  readonly kind: InboundKind;
  /** Whether the request came from the sender. Constant-time comparisons only. */
  verify(input: InboundVerifyInput): InboundVerifyResult;
  /** The id a resend of the same request repeats. */
  deliveryId(rawBody: Buffer, headers: IncomingHttpHeaders): string;
  /** A short name for the event, for the deliveries list. */
  eventType(payload: unknown, headers: IncomingHttpHeaders): string;
  /** Whether this workspace's owner may use this vendor's rules (its feature flag). */
  workspaceAllowed(workspaceId: string): Promise<boolean>;
}

/** How a nudge ended. `note` is shown on the delivery (why it was dropped or failed). */
export interface InboundNudgeResult {
  outcome: 'handled' | 'ignored' | 'failed';
  /** Rule runs that acted. */
  ran: number;
  note: string | null;
}

/**
 * An adapter whose request is only a nudge: it names a subject, and `nudge`
 * reads that subject from the vendor and runs the rules on what it read.
 * Throw to have the delivery retried.
 */
export interface InboundNudgeAdapter extends InboundAdapterBase {
  nudge(delivery: StoredInboundDelivery, connection: InboundConnectionRef): Promise<InboundNudgeResult>;
}

export interface InboundAdapter<Facts extends WorkflowFacts, Target extends WorkflowSourceTarget> extends InboundAdapterBase {
  /** PURE: the facts one stored delivery yields. `[]` when no rule can act on it. */
  toFacts(delivery: StoredInboundDelivery, connection: InboundConnectionRef): Facts[];
  /** The rules engine source the facts go to. */
  readonly workflowSource: WorkflowSourceAdapter<InboundWorkflowInput<Facts>, Target, Facts>;
}

/** Either kind of adapter, as `inboundAdapterFor` returns it. */
export type AnyInboundAdapter = InboundAdapter<WorkflowFacts, WorkflowSourceTarget> | InboundNudgeAdapter;

export function isNudgeAdapter(adapter: AnyInboundAdapter): adapter is InboundNudgeAdapter {
  return 'nudge' in adapter && typeof adapter.nudge === 'function';
}

/**
 * A vendor that posts every organization's events to ONE app-level URL
 * (`/webhooks/in/<path>`) and signs them with one app secret, as Linear's
 * OAuth app webhook does. The receiver verifies with the app secret first
 * (no database read), then asks the route which connections the event is
 * for, and stores one delivery per connection.
 */
export interface InboundVendorRoute {
  /** The path segment after `/webhooks/in/`, like `linear`. */
  readonly path: string;
  readonly kind: InboundKind;
  /** False when this deployment has no app secret: the route then answers 404. */
  configured(): boolean;
  /** Whether the request came from the vendor. Constant-time comparisons only. */
  verify(rawBody: Buffer, headers: IncomingHttpHeaders, payload: unknown, now: number): InboundVerifyResult;
  /**
   * A message about the app itself, not an event (Linear's "app revoked").
   * Returns true when it handled the payload, and nothing is stored.
   */
  handleControl?(payload: unknown): Promise<boolean>;
  /** The connections an event is for: every workspace that connected this vendor account. */
  connectionsFor(payload: unknown): Promise<InboundConnectionRef[]>;
  deliveryId(rawBody: Buffer, headers: IncomingHttpHeaders): string;
  eventType(payload: unknown, headers: IncomingHttpHeaders): string;
}

/** Read one header as a single trimmed string, or null. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
