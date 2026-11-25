import { isFleetTimeout, isHostSilentAnswer } from './errors.js';
import { fleetClientFor } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';
import { checkpointTime } from './workCheckpointScripts.js';

/**
 * How a turn fails over from a box whose fleet host does not answer. A field,
 * not a constant, so tests and an operator can tune it. `silentForMs`: how
 * long the host must stay silent, counted from the first silent answer in
 * the turn's wait for its box, before Talyn replaces the box.
 */
export const HOST_FAILOVER = {
  silentForMs: 2 * 60_000,
};

/**
 * Whether a refusal says the box's host does not answer. The fleet says so
 * with a code. A timeout of Talyn's own request counts only while the fleet
 * API answers another call: when the whole fleet is down, a new box cannot
 * start either, so the turn waits as before.
 */
export async function hostNotAnswering(wb: Pick<WorkbenchRow, 'workspaceId'>, err: unknown): Promise<boolean> {
  if (isHostSilentAnswer(err)) return true;
  if (!isFleetTimeout(err)) return false;
  try {
    // The fleet's own client, never the box's host.
    await (await fleetClientFor(wb.workspaceId)).ping();
    return true;
  } catch {
    return false;
  }
}

/** The transcript note when Talyn replaces the box. `checkpointAt`: the last checkpoint of the work, if any. */
export function hostFailoverNote(checkpointAt: Date | null): string {
  const from = checkpointAt
    ? `from the checkpoint of ${checkpointTime(checkpointAt)}. Changes made after that checkpoint stay on the old sandbox.`
    : 'from the branch on GitHub, because Talyn had no checkpoint of the work. Changes that were not pushed stay on the old sandbox.';
  return `The sandbox's host is not answering. Talyn started a new sandbox on another host ${from} Talyn runs this message on the new sandbox.`;
}
