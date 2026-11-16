import type {
  NormalizedWorkflow,
  PostHogInboxDryRun,
  PostHogInboxFacts,
  PostHogInboxReportPreview,
  PostHogInboxStatus,
} from '@talyn/shared';
import { posthogInboxMismatchReason } from '@talyn/shared';
import { preparePostHogInboxFacts } from '../workflows/sources/posthogInbox.js';
import type { PostHogInboxConnection } from './connection.js';
import { storedInboxAccess } from './connection.js';
import { reportToFacts } from './facts.js';
import { pollerState, pollQuery } from './poller.js';

/** How many of the newest ready reports the dry run reads. Each costs one PostHog read. */
export const DRY_RUN_REPORTS = 25;
/** How many reports that did not match the dry run shows. */
const DRY_RUN_SKIPPED_SHOWN = 10;
/** Parallel report reads in a dry run. */
const DRY_RUN_CONCURRENCY = 5;

/** `GET /workflows/posthog-inbox/status`. */
export async function posthogInboxStatus(workspaceId: string): Promise<PostHogInboxStatus> {
  const stored = await storedInboxAccess(workspaceId);
  const state = stored.integrationId ? await pollerState(stored.integrationId) : null;
  let access = stored.access;
  let reason = stored.reason;
  // A personal API key says nothing about its scopes until PostHog answers.
  if (access === 'unknown' && state) {
    if (state.lastErrorStatus === 401 || state.lastErrorStatus === 403) {
      access = 'reconnect';
      reason = 'PostHog refused the API key for the Inbox. Use a key with the inbox:read scope, or connect with PostHog.';
    } else if (state.lastPolledAt && !state.lastError) {
      access = 'ok';
    }
  }
  return {
    access,
    reason,
    authMethod: stored.authMethod,
    projectId: stored.projectId,
    host: stored.host,
    lastPolledAt: state?.lastPolledAt ? state.lastPolledAt.toISOString() : null,
    lastError: state?.lastError ?? null,
  };
}

function preview(facts: PostHogInboxFacts, reason: string | null): PostHogInboxReportPreview {
  return {
    id: facts.reportId,
    title: facts.title,
    url: facts.url,
    priority: facts.priority,
    repository: facts.repository,
    signalCount: facts.signalCount,
    updatedAt: facts.updatedAt,
    matched: reason === null,
    reason,
  };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * What a rule would act on now: the newest ready reports, read one by one
 * from PostHog (only the single-report read carries the repository), matched
 * with the same matcher the engine uses. Starts nothing and writes nothing.
 *
 * It does not count the daily cap, the hourly cap or a report that already
 * has a session: those decide whether a run starts, not whether it matches.
 */
export async function posthogInboxDryRun(
  connection: PostHogInboxConnection,
  workflow: Pick<NormalizedWorkflow, 'conditions'>
): Promise<PostHogInboxDryRun> {
  const rule = { conditions: workflow.conditions } as Parameters<typeof pollQuery>[0][number];
  const page = await connection.client.listReports({
    ...pollQuery([rule]),
    limit: DRY_RUN_REPORTS,
    offset: 0,
  });
  const listed = (Array.isArray(page.results) ? page.results : []).slice(0, DRY_RUN_REPORTS);
  const needsReviewers = (workflow.conditions.suggestedReviewers?.length ?? 0) > 0;
  const previews = await mapLimited(listed, DRY_RUN_CONCURRENCY, async (row) => {
    try {
      const facts = reportToFacts(await connection.client.getReport(row.id), connection);
      if (!facts) return null;
      const prepared = await preparePostHogInboxFacts(connection.workspaceId, facts, {
        needsReviewers,
        client: connection.client,
      });
      return preview(prepared, posthogInboxMismatchReason(workflow.conditions, prepared));
    } catch {
      return null;
    }
  });
  const read = previews.filter((p): p is PostHogInboxReportPreview => p !== null);
  return {
    matches: read.filter((p) => p.matched),
    skipped: read.filter((p) => !p.matched).slice(0, DRY_RUN_SKIPPED_SHOWN),
    scanned: read.length,
    truncated: typeof page.count === 'number' ? page.count > listed.length : listed.length >= DRY_RUN_REPORTS,
  };
}
