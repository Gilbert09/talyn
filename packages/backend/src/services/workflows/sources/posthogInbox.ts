import { and, eq, sql } from 'drizzle-orm';
import type { PostHogInboxFacts, WorkflowDefinition } from '@talyn/shared';
import { posthogInboxReportBlocked } from '@talyn/shared';
import { getDbClient } from '../../../db/client.js';
import { repositories as repositoriesTable } from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import type { PostHogInboxConnection } from '../../posthogInbox/connection.js';
import { suggestedReviewersFromArtefacts } from '../../posthogInbox/facts.js';
import { workspaceMayUsePostHogInboxRules } from '../../workflowsAccess.js';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../source.js';

/**
 * The PostHog Inbox source adapter: one PostHog self-driving report in,
 * `report_ready` facts out.
 *
 * The input is a report Talyn has just READ from PostHog by id
 * (`ingestPostHogReport`), never a pushed payload: a poll and a future
 * webhook both hand over only the report id. The connection belongs to one
 * workspace, so that is the only target.
 *
 * The delivery id is `posthog_inbox:<reportId>:<updated_at>`. A real change to
 * the report gets a new id, so a rule can act on it again (the claim on the
 * report still stops a second session while the first one works), and the
 * poller and a webhook that both see the same version claim the same run.
 */

export interface PostHogInboxWorkflowInput {
  connection: Pick<PostHogInboxConnection, 'id' | 'workspaceId'> & {
    client?: Pick<PostHogInboxConnection['client'], 'listArtefacts'>;
  };
  facts: PostHogInboxFacts;
}

export interface PostHogInboxWorkflowTarget extends WorkflowSourceTarget {
  connectionId: string;
  /** For the suggested reviewers, which only the report's artefacts carry. */
  client?: Pick<PostHogInboxConnection['client'], 'listArtefacts'>;
}

/** The delivery id of one report version. */
export function posthogInboxDeliveryId(facts: Pick<PostHogInboxFacts, 'reportId' | 'updatedAt'>): string {
  return `posthog_inbox:${facts.reportId}:${facts.updatedAt}`;
}

/** The workspace repository whose `owner/repo` is this one, case-insensitive. */
export async function workspaceRepositoryFor(workspaceId: string, slug: string | null): Promise<string | null> {
  if (!slug) return null;
  const rows = await getDbClient()
    .select({ id: repositoriesTable.id })
    .from(repositoriesTable)
    .where(
      and(eq(repositoriesTable.workspaceId, workspaceId), sql`lower(${repositoriesTable.name}) = ${slug.trim().toLowerCase()}`)
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Fill in what the report read could not say, for one workspace: the Talyn
 * repository of the report's repository, and the suggested reviewers when a
 * rule asks for them. Returns null when PostHog blocked the report.
 */
export async function preparePostHogInboxFacts(
  workspaceId: string,
  raw: PostHogInboxFacts,
  opts: {
    needsReviewers: boolean;
    client?: Pick<PostHogInboxConnection['client'], 'listArtefacts'>;
  }
): Promise<PostHogInboxFacts> {
  const workspaceRepositoryId = await workspaceRepositoryFor(workspaceId, raw.repository);
  let facts: PostHogInboxFacts = { ...raw, workspaceRepositoryId };
  if (opts.needsReviewers && opts.client && workspaceRepositoryId) {
    try {
      const reviewers = suggestedReviewersFromArtefacts(await opts.client.listArtefacts(raw.reportId));
      facts = {
        ...facts,
        suggestedReviewers: reviewers ?? [],
        // No artefact yet means PostHog has not judged it: a reviewer
        // condition fails rather than reading "nobody" as an answer.
        unknownFields: (facts.unknownFields ?? []).filter((f) => f !== 'suggestedReviewers' || reviewers === null),
      };
    } catch (err) {
      debugBus.recordEvent({
        service: 'workflows',
        action: 'posthog_inbox_artefacts_unreadable',
        summary: raw.reportId,
        ok: false,
        error: err,
        workspaceId,
      });
    }
  }
  return facts;
}

export const posthogInboxWorkflowSource: WorkflowSourceAdapter<
  PostHogInboxWorkflowInput,
  PostHogInboxWorkflowTarget,
  PostHogInboxFacts
> = {
  integration: 'posthog_inbox',

  facts: (input) => [input.facts],

  deliveryId: (input) => posthogInboxDeliveryId(input.facts),

  targets: async (input) => [
    {
      workspaceId: input.connection.workspaceId,
      repositoryId: null,
      connectionId: input.connection.id,
      ...(input.connection.client ? { client: input.connection.client } : {}),
    },
  ],

  workspaceAllowed: workspaceMayUsePostHogInboxRules,

  async prepare(target, factsList, workflows: WorkflowDefinition[]) {
    const out: PostHogInboxFacts[] = [];
    for (const raw of factsList) {
      // Never act on a report PostHog's safety judge suppressed, or one that
      // is not ready. The matcher refuses them too; this records why.
      const blocked = posthogInboxReportBlocked(raw);
      if (blocked) {
        debugBus.recordEvent({
          service: 'workflows',
          action: blocked === 'safety' ? 'posthog_inbox_safety_skip' : 'posthog_inbox_skip',
          summary: `report ${raw.reportId} skipped: ${blocked}`,
          workspaceId: target.workspaceId,
        });
        continue;
      }
      const needsReviewers = workflows.some((w) => (w.conditions.suggestedReviewers?.length ?? 0) > 0);
      out.push(await preparePostHogInboxFacts(target.workspaceId, raw, { needsReviewers, client: target.client }));
    }
    return { facts: out };
  },

  actionContext: (_target, facts, base) => ({
    ...base,
    integration: 'posthog_inbox',
    repositoryId: facts.workspaceRepositoryId ?? null,
    facts,
  }),

  blockedUntilMs: () => 0,

  describe: (input) => `posthog_inbox ${input.connection.id} report ${input.facts.reportId} (${input.facts.updatedAt})`,
};
