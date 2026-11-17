import { v4 as uuid } from 'uuid';
import { QUESTION_EVENT_TYPE, type WorkbenchQuestionEvent, type WorkbenchQuestionItem } from '@talyn/shared';
import { emitWorkbenchEvents } from './emit.js';
import { WorkbenchError } from './errors.js';
import { appendEvents, getWorkbench, listChats, type WorkbenchRow } from './store.js';

/**
 * The agent's question to the person (`talyn_ask_user`): a `talyn_question`
 * event in the turn that asked. The turn then ends as `awaiting_input`
 * (`turnEndStatus` in turns.ts), which notifies the person and wakes the
 * session's thread. See `workbenchQuestion.ts` in shared.
 */
export async function askPerson(
  workbenchId: string,
  questions: WorkbenchQuestionItem[],
): Promise<{ workbench: WorkbenchRow; question: WorkbenchQuestionEvent }> {
  const workbench = await getWorkbench(workbenchId);
  if (!workbench || workbench.archivedAt) throw new WorkbenchError('This session no longer exists.', 404, 'not_found');
  // The turn that called the tool is the running one. With two running chats, the newer one is the likelier caller.
  const chat = (await listChats(workbenchId))
    .filter((c) => !c.closedAt && c.status === 'running')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (!chat) {
    throw new WorkbenchError('No turn of this session is running, so there is nothing to wait on. Ask in your reply instead.', 409, 'no_turn');
  }
  const question: WorkbenchQuestionEvent = { id: uuid(), questions };
  const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: QUESTION_EVENT_TYPE, ...question } }]);
  emitWorkbenchEvents(workbench.workspaceId, chat.id, stored);
  return { workbench, question };
}
