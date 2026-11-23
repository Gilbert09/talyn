import { CREATE_PR_MESSAGE, type Workbench } from '@talyn/shared';

import type { WorkflowStore } from '../../workflow/store';
import { createPrSentText } from './model';

/** The chat an action goes to: the one on screen, else the newest. */
function targetChat(workflow: WorkflowStore, item: Workbench) {
  const selected = workflow.local(`selected:${item.id}`).selectedChat;
  const chats = item.chats ?? [];
  return chats.find((chat) => chat.id === selected) ?? chats[chats.length - 1];
}

/**
 * Create PR, like web `sendCreatePullRequest`: send "Create a pull request" to
 * the chat with its own intent. A running turn queues it. Returns the words
 * that confirm it.
 */
export async function sendCreatePullRequest(workflow: WorkflowStore, item: Workbench): Promise<string> {
  const chatId = targetChat(workflow, item)?.id ?? (await workflow.api.workbenches.createChat(item.id)).id;
  const ack = await workflow.api.workbenches.sendMessage(chatId, { text: CREATE_PR_MESSAGE, intent: 'create_pr', planMode: false });
  workflow.refresh('workbench', item.id);
  workflow.refresh('transcript', chatId);
  return createPrSentText(ack.queued, item);
}

/** Resolve conflicts or Fix checks, like web `runPromptAction`: the server writes the prompt and sends it to the chat. */
export async function runPromptAction(workflow: WorkflowStore, item: Workbench, action: 'resolve_conflicts' | 'fix_checks'): Promise<string> {
  const chat = targetChat(workflow, item);
  const answer = await workflow.api.workbenches.action(item.id, action, chat?.id);
  workflow.refresh('workbench', item.id);
  const chatId = answer?.chatId ?? chat?.id;
  if (chatId) workflow.refresh('transcript', chatId);
  return 'Sent to the agent.';
}
