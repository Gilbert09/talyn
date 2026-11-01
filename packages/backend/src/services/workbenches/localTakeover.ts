import { emitWorkbenchEvents } from './emit.js';
import { appendEvents, listChats, updateWorkbench, type WorkbenchRow } from './store.js';

export const LOCAL_MOVE_NOTE = 'Moved to this computer. Commits that were not pushed from the other computer are not here.';

export async function claimLocalWorkbench(row: WorkbenchRow, deviceId: string, localPath: string): Promise<WorkbenchRow> {
  const updated = (await updateWorkbench(row.id, { deviceId, localPath })) ?? row;
  if (row.deviceId !== updated.deviceId || row.localPath !== updated.localPath) {
    for (const chat of await listChats(row.id)) {
      if (chat.closedAt) continue;
      const events = await appendEvents(chat.id, [{ turn: chat.turnCount, event: {
        type: 'system', subtype: 'local_session_moved', text: LOCAL_MOVE_NOTE,
      } }]);
      emitWorkbenchEvents(chat.workspaceId, chat.id, events);
    }
  }
  return updated;
}
