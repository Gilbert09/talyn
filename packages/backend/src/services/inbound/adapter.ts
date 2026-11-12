import type { IncomingHttpHeaders } from 'node:http';
import type { InboundKind, WorkflowFacts } from '@talyn/shared';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../workflows/source.js';

/**
 * One vendor's part of the inbound layer.
 *
 * The receiver, the store, the processing claim and the sweep are the same for
 * every vendor. An adapter owns only what differs: how a request proves it came
 * from the sender, which id a resend repeats, what to call the event, and the
 * facts a rule matches on. Linear, Sentry and Jira are later adapters of this
 * shape. Only the generic webhook exists today.
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
}

/** A connection as the processing step reads it. No secrets. */
export interface InboundConnectionRef {
  id: string;
  workspaceId: string;
  kind: InboundKind;
  ruleId: string | null;
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

export interface InboundAdapter<Facts extends WorkflowFacts, Target extends WorkflowSourceTarget> {
  readonly kind: InboundKind;
  /** Whether the request came from the sender. Constant-time comparisons only. */
  verify(input: InboundVerifyInput): InboundVerifyResult;
  /** The id a resend of the same request repeats. */
  deliveryId(rawBody: Buffer, headers: IncomingHttpHeaders): string;
  /** A short name for the event, for the deliveries list. */
  eventType(payload: unknown, headers: IncomingHttpHeaders): string;
  /** PURE: the facts one stored delivery yields. `[]` when no rule can act on it. */
  toFacts(delivery: StoredInboundDelivery, connection: InboundConnectionRef): Facts[];
  /** The rules engine source the facts go to. */
  readonly workflowSource: WorkflowSourceAdapter<InboundWorkflowInput<Facts>, Target, Facts>;
  /** Whether this workspace's owner may use this vendor's rules (its feature flag). */
  workspaceAllowed(workspaceId: string): Promise<boolean>;
}

/** Read one header as a single trimmed string, or null. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
