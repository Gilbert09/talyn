import type { PostHogInboxFacts } from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { evaluateWorkflows } from '../workflows/engine.js';
import { posthogInboxWorkflowSource } from '../workflows/sources/posthogInbox.js';
import type { PostHogInboxConnection } from './connection.js';
import { reportToFacts } from './facts.js';

export type IngestOutcome =
  /** The report was read and the rules evaluated. `ran` runs acted. */
  | { kind: 'evaluated'; ran: number; facts: PostHogInboxFacts }
  /** PostHog answered with something that is not a report. */
  | { kind: 'unreadable' };

/**
 * The ONE way a PostHog Inbox report reaches the rules engine.
 *
 * Takes only a report id and reads the report from PostHog: the poller calls
 * it for each report it finds, and the webhook receiver (a later step) will
 * call it with the id from PostHog's push. Nothing in a pushed payload ever
 * decides an action. Throws when PostHog cannot be read, so the caller can
 * keep its cursor and back off.
 */
export async function ingestPostHogReport(connection: PostHogInboxConnection, reportId: string): Promise<IngestOutcome> {
  const report = await connection.client.getReport(reportId);
  const facts = reportToFacts(report, connection);
  if (!facts) {
    debugBus.recordEvent({
      service: 'workflows',
      action: 'posthog_inbox_unreadable',
      summary: `report ${reportId} had no id or updated_at`,
      ok: false,
      workspaceId: connection.workspaceId,
    });
    return { kind: 'unreadable' };
  }
  const ran = await evaluateWorkflows(posthogInboxWorkflowSource, { connection, facts });
  return { kind: 'evaluated', ran, facts };
}
