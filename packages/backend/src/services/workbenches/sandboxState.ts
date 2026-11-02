import { and, eq } from 'drizzle-orm';
import type { WorkbenchSandboxState } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { emitWorkbenchUpdated } from './emit.js';
import { WORKBENCH_COLUMNS } from './store.js';

/**
 * The ONE writer of `sandbox_state` for metering: the hooks, the usage sweep
 * and the exhaustion suspend all come through here. Move it between `running` and `suspended`, only from the state
 * named. `lost`, `deleted` and `error` are never overwritten.
 */
export async function setWorkbenchSandboxState(
  target: { sandboxId: string } | { workbenchId: string },
  from: WorkbenchSandboxState,
  to: WorkbenchSandboxState,
): Promise<void> {
  const label = 'sandboxId' in target ? target.sandboxId : target.workbenchId;
  try {
    const [row] = await getPoolDbClient()
      .update(workbenches)
      .set({ sandboxState: to, updatedAt: new Date() })
      .where(
        and(
          'sandboxId' in target ? eq(workbenches.sandboxId, target.sandboxId) : eq(workbenches.id, target.workbenchId),
          eq(workbenches.sandboxState, from),
        ),
      )
      .returning(WORKBENCH_COLUMNS);
    if (!row) return;
    const { publicWorkbench } = await import('./prLink.js');
    await emitWorkbenchUpdated(await publicWorkbench(row));
  } catch (err) {
    console.warn(`[workbench] recording sandbox ${label} as ${to} failed:`, err);
  }
}

