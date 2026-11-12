import { and, eq } from 'drizzle-orm';
import type { WorkflowAction } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { repositories as repositoriesTable } from '../../db/schema.js';
import { isBoxGateError } from '../billing/entitlements.js';
import { buildInboundPrompt } from '../inbound/prompt.js';
import { resolveCloudEnv } from '../prCloudFix.js';
import { createCloudTask, TaskReferenceError } from '../taskCreate.js';
import { boxRefused, no, ok, type OneResult } from './actionResult.js';
import type { WebhookActionContext } from './actions.js';

/**
 * The actions an inbound rule (a webhook today) takes: the prompt both start
 * actions send, and `start_task`. `start_session` lives with the other session
 * starts in `sessionAction.ts` and uses {@link inboundRulePrompt}.
 */

type StartTaskAction = Extract<WorkflowAction, { type: 'start_task' }>;

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

/**
 * Start a cloud task on the rule's repository.
 *
 * Through `createCloudTask` with `source: 'workflow'`, so the box gate, the
 * unattended deferral and the task's attribution are the same as for every
 * other rule run. A box refusal parks the run and the retry sweep tries again.
 */
export async function startInboundTask(action: StartTaskAction, ctx: WebhookActionContext): Promise<OneResult> {
  const repoName = await repositoryName(ctx.workspaceId, action.repositoryId);
  if (!repoName) {
    return {
      outcome: no(
        'start_task',
        'repository_unresolved',
        'The repository on this automation is no longer in the workspace. Choose another one.'
      ),
    };
  }
  const env = await resolveCloudEnv(ctx.workspaceId);
  if (!env) {
    return {
      outcome: no('start_task', 'no_cloud_provider', 'this workspace has no connected cloud provider to run the task on'),
    };
  }
  const name = ctx.workflowName ?? 'Webhook automation';
  try {
    const task = await createCloudTask({
      workspaceId: ctx.workspaceId,
      type: 'code_writing',
      source: 'workflow',
      title: name,
      description: `Started by the "${name}" automation from a webhook.`,
      prompt: inboundRulePrompt(action.prompt, ctx, repoName),
      repositoryId: action.repositoryId,
      assignedEnvironmentId: env.envId,
      ...(action.model ? { model: action.model } : {}),
      ...(action.internetAccess ? { internetAccess: true } : {}),
      workflow: { workflowId: ctx.workflowId, runId: ctx.runId, event: ctx.facts.event },
    });
    return { outcome: ok('start_task', `started task ${task.id}`), taskId: task.id };
  } catch (err) {
    if (isBoxGateError(err)) return boxRefused('start_task', err, null, ctx);
    if (err instanceof TaskReferenceError) {
      return { outcome: no('start_task', 'repository_unresolved', err.message) };
    }
    return { outcome: no('start_task', 'error', err instanceof Error ? err.message : String(err)) };
  }
}
