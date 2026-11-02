import { eq } from 'drizzle-orm';
import { getPoolDbClient } from '../../../db/client.js';
import { workbenches } from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import { emitWorkbenchEvents } from '../../workbenches/emit.js';
import { fleetClientFor } from '../../workbenches/sandboxRuntime.js';
import { appendEvents, listChats, otherRunningChats } from '../../workbenches/store.js';
import { setWorkbenchSandboxState } from '../../workbenches/sandboxState.js';
import { markIntervalClosed, openIntervalOfSubjectQuery, openIntervalsOfKindQuery } from './intervals.js';

export const EXHAUSTED_NOTE = 'Paused: your box-hours and credits are used up. Add credits or upgrade to wake this session.';

const WORKBENCH_COLUMNS = {
  id: workbenches.id,
  workspaceId: workbenches.workspaceId,
  fleetHost: workbenches.fleetHost,
  sandboxId: workbenches.sandboxId,
} as const;

type SessionBox = Pick<typeof workbenches.$inferSelect, keyof typeof WORKBENCH_COLUMNS>;

/**
 * Suspend one workbench box for billing. Never while a turn runs: a running
 * turn finishes (spec), and the turn's end or the next meter tick suspends
 * the box then. Returns whether the box was suspended.
 */
async function suspendSessionBox(box: SessionBox, sandboxId: string, now: Date): Promise<boolean> {
  if ((await otherRunningChats(box.id)) > 0) return false;
  try {
    const client = await fleetClientFor(box.workspaceId, box.fleetHost);
    await client.suspendSandbox(sandboxId);
  } catch (error) {
    // The box still runs; the interval stays open and the next tick retries.
    debugBus.recordEvent({
      service: 'billing',
      action: 'usage_suspend_failed',
      summary: `Could not suspend ${sandboxId} for billing`,
      ok: false,
      error,
      workspaceId: box.workspaceId,
    });
    return false;
  }
  // Another actor (a second replica's meter) may have closed it first; it
  // wrote the notes then.
  if (!(await markIntervalClosed(sandboxId, now, 'exhausted'))) return true;
  await setWorkbenchSandboxState({ workbenchId: box.id }, 'running', 'suspended');
  for (const chat of await listChats(box.id)) {
    if (chat.closedAt) continue;
    const stored = await appendEvents(chat.id, [
      { turn: chat.turnCount, event: { type: 'system', subtype: 'usage_exhausted', text: EXHAUSTED_NOTE } },
    ]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
  debugBus.recordEvent({
    service: 'billing',
    action: 'usage_suspend',
    summary: `Suspended ${sandboxId}: box-hours used up`,
    ok: true,
    workspaceId: box.workspaceId,
  });
  return true;
}

/**
 * What runs while an owner is out of hours and credits: every workbench box
 * of theirs with no live turn suspends. Tasks and review units are never
 * touched: a run is never killed part-way. Returns the boxes suspended.
 */
export async function enforceExhaustion(ownerId: string, now = new Date()): Promise<number> {
  const open = await openIntervalsOfKindQuery(ownerId, 'workbench');
  let suspended = 0;
  for (const interval of open) {
    const [box] = await getPoolDbClient()
      .select(WORKBENCH_COLUMNS)
      .from(workbenches)
      .where(eq(workbenches.id, interval.subjectId))
      .limit(1);
    if (!box) continue;
    if (await suspendSessionBox(box, interval.sandboxId, now)) suspended += 1;
  }
  return suspended;
}

/**
 * Suspend one workbench box now if its owner is out of budget. For the end of
 * a turn (WP4/WP5 call this from `finishTurn`), so an exhausted owner's box
 * does not stay awake until the next meter tick. Never throws.
 */
export async function suspendWorkbenchIfExhausted(
  workbenchId: string,
  isExhausted: (ownerId: string) => Promise<boolean>,
  now = new Date(),
): Promise<boolean> {
  try {
    const db = getPoolDbClient();
    const [box] = await db.select(WORKBENCH_COLUMNS).from(workbenches).where(eq(workbenches.id, workbenchId)).limit(1);
    if (!box?.sandboxId) return false;
    const [interval] = await openIntervalOfSubjectQuery('workbench', workbenchId);
    if (!interval || !(await isExhausted(interval.ownerId))) return false;
    // The budget check charges, and charging an exhausted owner already
    // suspends their idle boxes; this one may be closed by now.
    const [stillOpen] = await openIntervalOfSubjectQuery('workbench', workbenchId);
    if (!stillOpen) return true;
    return await suspendSessionBox(box, stillOpen.sandboxId, now);
  } catch (error) {
    debugBus.recordEvent({ service: 'billing', action: 'usage_suspend_failed', summary: `Exhaustion check for ${workbenchId} failed`, ok: false, error });
    return false;
  }
}
