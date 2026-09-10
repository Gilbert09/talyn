/**
 * The pieces of webhook handling that are pure payload reading.
 *
 * A leaf module on purpose. `webhookWorker` is the orchestrator and imports half
 * the service layer; the workflow engine needs the delivery envelope and the
 * merged/closed reading, and importing them from the worker would make a cycle
 * (worker → engine → facts → worker). Splitting the pure half out is cheaper
 * than tolerating one, and cheaper still than a second copy of the
 * merged/merged_at precedence.
 *
 * Both symbols are re-exported from `webhookWorker` so existing importers and
 * its test suite are unaffected.
 */

/** One delivery as it travels the Redis stream. */
export interface WebhookDelivery {
  deliveryId: string;
  eventType: string;
  action?: string;
  repoFullName: string;
  installationId?: string;
  enqueuedAtMs: number;
  payload: Record<string, unknown>;
}

/**
 * Read a merged/closed outcome off a `pull_request` payload. Pure, so the
 * precedence between `merged` and `merged_at` is unit-testable: GitHub sets
 * both on a merge, but only `merged_at` carries the instant, and a bad
 * timestamp must not downgrade the merge to a plain close. Returns null when
 * the payload doesn't describe a close.
 */
export function terminalOutcomeFromPayload(
  action: string | undefined,
  payload: Record<string, unknown>,
): { merged: boolean; mergedAt: Date | null } | null {
  if (action !== 'closed') return null;
  const pr = payload.pull_request as
    | { merged?: unknown; merged_at?: unknown }
    | undefined;
  if (!pr) return null;
  let mergedAt: Date | null = null;
  if (typeof pr.merged_at === 'string') {
    const parsed = new Date(pr.merged_at);
    if (!Number.isNaN(parsed.getTime())) mergedAt = parsed;
  }
  const merged = pr.merged === true || mergedAt !== null;
  // A merge with no usable timestamp is still a merge — stamp it now rather
  // than leaving the row in `merged` with a null mergedAt.
  return { merged, mergedAt: merged ? (mergedAt ?? new Date()) : null };
}
