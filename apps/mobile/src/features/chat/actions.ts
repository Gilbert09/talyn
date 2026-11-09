import { workbenches } from '@talyn/client/native';
import { PLAN_APPROVED_MESSAGE, type SendWorkbenchMessageInput } from '@talyn/shared';

import { uploadImage } from './attachmentUpload';

/**
 * Chat actions the workflow store does not own, with the same client calls as
 * web: stop is `workbenches.cancel`, plan approval sends the approval message
 * with plan mode off, and "Keep planning" turns plan mode back on.
 * Callers refresh the store afterwards.
 */
export const chatActions = {
  stop: (chatId: string) => workbenches.cancel(chatId),
  /** A message with images. The store's own send carries text only. */
  send: (chatId: string, input: SendWorkbenchMessageInput) => workbenches.sendMessage(chatId, input),
  uploadImage,
  async approvePlan(chatId: string) {
    const result = await workbenches.sendMessage(chatId, { text: PLAN_APPROVED_MESSAGE, planMode: false });
    // The build turn already runs without plan mode. This is for the turns after it.
    await workbenches.updateChat(chatId, { planMode: false }).catch(() => undefined);
    return result;
  },
  setPlanMode: (chatId: string, planMode: boolean) => workbenches.updateChat(chatId, { planMode }),
};
