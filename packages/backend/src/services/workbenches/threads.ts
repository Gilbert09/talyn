import type { ContinueWorkbenchAsThreadInput, Workbench, WorkbenchAgent } from '@talyn/shared';
import { createWorkbench } from './create.js';
import { WorkbenchError } from './errors.js';
import type { ReadinessUser } from './readiness.js';
import { isThread, type WorkbenchRow } from './store.js';

/**
 * Threads: a workbench with `kind = 'thread'` has no repository and starts
 * sessions on repositories. A session in a thread has `threadId` set.
 */

/**
 * `POST /workbenches/:id/thread`: a new thread whose first message recaps the
 * session's chat, with the session as its first member.
 */
export async function continueAsThread(
  session: WorkbenchRow,
  body: ContinueWorkbenchAsThreadInput,
  actor: ReadinessUser,
): Promise<Workbench> {
  if (isThread(session)) throw new WorkbenchError('This is already a thread.', 409, 'already_thread');
  if (body.agent !== undefined && body.agent !== 'claude' && body.agent !== 'codex') {
    throw new WorkbenchError('agent must be "claude" or "codex"', 400, '');
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new WorkbenchError('prompt must be a string', 400, '');
  const agent = body.agent ?? (session.agent as WorkbenchAgent);
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : agent === session.agent ? session.model : null;
  return createWorkbench(
    {
      workspaceId: session.workspaceId,
      kind: 'thread',
      runtime: 'sandbox',
      agent,
      ...(model ? { model } : {}),
      ...(body.prompt?.trim() ? { prompt: body.prompt } : {}),
      fromSessionId: session.id,
    },
    actor,
  );
}
