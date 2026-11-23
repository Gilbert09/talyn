import { and, eq } from 'drizzle-orm';
import {
  sessionOriginEventLabel,
  workflowOriginDetails,
  type SessionOrigin,
  type WorkbenchSource,
  type WorkflowFacts,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { loopRuns, loops, workflowRuns, workflows } from '../../db/schema.js';

/**
 * The automation that started a session, with the event it acted on. Null
 * when no rule or loop started the session.
 *
 * Every read is scoped to the session's workspace. A deleted rule, loop or run
 * gives nulls, not an error: the session outlives them.
 */
export async function sessionOriginOf(
  workspaceId: string,
  source: WorkbenchSource | null | undefined
): Promise<SessionOrigin | null> {
  const db = getDbClient();
  if (source?.kind === 'workflow' && source.workflowId) {
    const [rule, run] = await Promise.all([
      db
        .select({ name: workflows.name })
        .from(workflows)
        .where(and(eq(workflows.id, source.workflowId), eq(workflows.workspaceId, workspaceId)))
        .limit(1),
      db
        .select({
          createdAt: workflowRuns.createdAt,
          event: workflowRuns.event,
          facts: workflowRuns.facts,
          subjectLabel: workflowRuns.subjectLabel,
          prUrl: workflowRuns.prUrl,
          triggerSource: workflowRuns.triggerSource,
          triggeredByLabel: workflowRuns.triggeredByLabel,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.id, source.runId),
            eq(workflowRuns.workflowId, source.workflowId),
            eq(workflowRuns.workspaceId, workspaceId)
          )
        )
        .limit(1),
    ]);
    const row = run[0];
    const manual = row?.triggerSource === 'manual';
    return {
      type: 'workflow',
      automationId: source.workflowId,
      automationName: rule[0]?.name ?? null,
      runId: source.runId,
      startedAt: row ? row.createdAt.toISOString() : null,
      trigger: row ? (manual ? 'manual' : 'event') : null,
      triggeredBy: manual ? (row?.triggeredByLabel ?? null) : null,
      event: sessionOriginEventLabel(row?.event),
      ...workflowOriginDetails((row?.facts as WorkflowFacts | null | undefined) ?? null, {
        label: row?.subjectLabel ?? null,
        url: row?.prUrl ?? null,
      }),
    };
  }
  if (source?.kind === 'loop' && source.loopId) {
    const [loop, run] = await Promise.all([
      db
        .select({ name: loops.name })
        .from(loops)
        .where(and(eq(loops.id, source.loopId), eq(loops.workspaceId, workspaceId)))
        .limit(1),
      db
        .select({
          createdAt: loopRuns.createdAt,
          trigger: loopRuns.trigger,
          repoFullName: loopRuns.repoFullName,
          model: loopRuns.model,
        })
        .from(loopRuns)
        .where(
          and(eq(loopRuns.id, source.runId), eq(loopRuns.loopId, source.loopId), eq(loopRuns.workspaceId, workspaceId))
        )
        .limit(1),
    ]);
    const row = run[0];
    const facts: SessionOrigin['facts'] = [];
    if (row?.repoFullName) facts.push({ label: 'Repository', value: row.repoFullName });
    if (row?.model) facts.push({ label: 'Model', value: row.model });
    return {
      type: 'loop',
      automationId: source.loopId,
      automationName: loop[0]?.name ?? null,
      runId: source.runId,
      startedAt: row ? row.createdAt.toISOString() : null,
      trigger: row ? (row.trigger === 'manual' ? 'manual' : 'schedule') : null,
      triggeredBy: null,
      event: null,
      subject: null,
      facts,
      excerpt: null,
    };
  }
  return null;
}
