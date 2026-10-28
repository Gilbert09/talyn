import { sanitizeWorkbenchTitle, workbenchTitlePrompt } from '@talyn/shared';
import { askSessionAgent, type CheapAgentOptions } from './cheapAgent.js';
import { emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent } from './sandboxRuntime.js';
import { setGeneratedTitle, type WorkbenchRow } from './store.js';

/**
 * A display title for a sandbox session, from its first message.
 *
 * Runs the session's own agent CLI in its sandbox, on the subscription the
 * sandbox already has, with the cheapest catalogue model. It runs beside the
 * first turn and never blocks or fails it: any failure keeps the name. The
 * write only lands while the session has no title, so a person's rename wins.
 */

/** Workbenches this process has already asked about. One attempt each. */
const attempted = new Set<string>();

/** Start the title call once per workbench, in the background. */
export function startTitleGeneration(row: WorkbenchRow, firstMessage: string): void {
  if (row.title || row.runtime !== 'sandbox' || attempted.has(row.id)) return;
  attempted.add(row.id);
  void generateSandboxTitle(row, firstMessage).catch((err) => {
    console.warn(`[workbench] title for ${row.id} failed:`, err);
  });
}

/** The new row when a title was written; null when the name stays. */
export async function generateSandboxTitle(
  row: WorkbenchRow,
  firstMessage: string,
  opts: CheapAgentOptions = {},
): Promise<WorkbenchRow | null> {
  if (!firstMessage.trim()) return null;
  const result = await askSessionAgent(row, workbenchTitlePrompt(firstMessage), opts);
  const title = result && result.exitCode === 0 ? sanitizeWorkbenchTitle(result.stdout) : null;
  if (!title) {
    recordWorkbenchEvent(row, 'title', result ? `no usable title (exit ${result.exitCode})` : 'no answer from the sandbox', false);
    return null;
  }
  const updated = await setGeneratedTitle(row.id, title);
  if (!updated) return null;
  recordWorkbenchEvent(row, 'title', 'title set');
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return updated;
}
