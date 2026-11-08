import { sanitizeWorkbenchTitle, workbenchTitlePrompt } from '@talyn/shared';
import { askSessionAgent, type CheapAgentOptions } from './cheapAgent.js';
import { emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent } from './sandboxRuntime.js';
import { listChats, setGeneratedTitle, type WorkbenchRow } from './store.js';

/**
 * A display title for a sandbox session, from its first message.
 *
 * Runs the session's own agent CLI in its sandbox, on the subscription the
 * sandbox already has, with the cheapest catalogue model. It runs beside the
 * first turn and never blocks or fails it: any failure keeps the name. The
 * write only lands while the session has no title, so a person's rename wins.
 */

/** Failed tries allowed per workbench, per process. */
export const MAX_TITLE_FAILURES = 3;

const failures = new Map<string, number>();
const inFlight = new Set<string>();

/**
 * Start a title call in the background, on any turn, while the session has no
 * title. A failed try counts. After MAX_TITLE_FAILURES the session keeps its name
 * until the process restarts. Only one call per workbench runs at a time.
 */
export function startTitleGeneration(row: WorkbenchRow, message: string, opts: CheapAgentOptions = {}): Promise<void> {
  if (row.title || row.runtime !== 'sandbox' || inFlight.has(row.id)) return Promise.resolve();
  if ((failures.get(row.id) ?? 0) >= MAX_TITLE_FAILURES) return Promise.resolve();
  inFlight.add(row.id);
  return generateSandboxTitle(row, message, opts)
    .then((updated) => {
      if (!updated) failures.set(row.id, (failures.get(row.id) ?? 0) + 1);
    })
    .catch((err) => {
      failures.set(row.id, (failures.get(row.id) ?? 0) + 1);
      console.warn(`[workbench] title for ${row.id} failed:`, err);
    })
    .finally(() => inFlight.delete(row.id));
}

/**
 * Start the title as soon as a new box exists, from the first message that
 * waits in a chat's queue. The first turn waits for the clone and the setup
 * script, which can take minutes; the title needs neither. When no message
 * waits yet, the first turn starts the title as before.
 */
export async function startTitleFromQueue(row: WorkbenchRow, opts: CheapAgentOptions = {}): Promise<void> {
  if (row.title || row.runtime !== 'sandbox') return;
  const chats = await listChats(row.id);
  const text = chats
    .filter((chat) => !chat.closedAt)
    .flatMap((chat) => chat.queuedMessages ?? [])
    .map((message) => message.text.trim())
    .find(Boolean);
  if (text) await startTitleGeneration(row, text, opts);
}

/** Test hook: forget the failure counts. */
export function resetTitleAttempts(): void {
  failures.clear();
  inFlight.clear();
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
