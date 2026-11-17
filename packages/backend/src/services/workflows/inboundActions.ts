import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { repositories as repositoriesTable } from '../../db/schema.js';
import { buildInboundPrompt } from '../inbound/prompt.js';
import type { WebhookActionContext } from './actions.js';

/**
 * Helpers for an inbound rule (a webhook today). `start_session` lives with
 * the other session starts in `sessionAction.ts` and uses
 * {@link inboundRulePrompt}.
 */

/** The repository's `owner/repo`, or null when it is not in this workspace. */
export async function repositoryName(workspaceId: string, repositoryId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ name: repositoriesTable.name })
    .from(repositoriesTable)
    .where(and(eq(repositoriesTable.id, repositoryId), eq(repositoriesTable.workspaceId, workspaceId)))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** The rule's prompt, with the request quoted below it as untrusted text. */
export function inboundRulePrompt(
  instruction: string,
  ctx: WebhookActionContext,
  repoName: string
): string {
  return buildInboundPrompt({
    instruction,
    sourceLabel: ctx.workflowName ? `a webhook that the automation "${ctx.workflowName}" receives` : 'a webhook',
    identifiers: {
      repo: repoName,
      'webhook.delivery': ctx.facts.deliveryId,
      'webhook.received_at': ctx.facts.receivedAt,
    },
    payload: ctx.facts.payload,
  });
}
