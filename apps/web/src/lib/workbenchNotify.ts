import { workbenchDisplayName, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import { lastTurn, setChatFinishedListener, useWorkbenchStore } from '../stores/workbenches';
import { toast } from '../stores/toast';
import { navigateToWorkbench } from './workbenchNavigation';
import { readSessionDefaults } from './sessionDefaults';

/**
 * "Your agent finished" — a browser notification when a chat stops running
 * (done, an error, or waiting for input) while the tab is not focused. The
 * store marks the chat unread on its own; this adds the notification, and its
 * click brings the tab forward on that workbench and chat.
 */

type NotificationChat = Pick<WorkbenchChat, 'status'> & Partial<Pick<WorkbenchChat, 'title'>> & { error?: string | null };

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

function cleanSummary(text: string): string | null {
  const cleaned = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const sentenceEnd = /[.!?](?=\s)/g;
  for (const match of cleaned.matchAll(sentenceEnd)) {
    const end = (match.index ?? 0) + 1;
    if (end >= 20) return truncate(cleaned.slice(0, end), 140);
  }
  return truncate(cleaned, 140);
}

function lastAssistantText(events: WorkbenchEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event;
    if (event.type !== 'assistant' || event.parent_tool_use_id || !Array.isArray(event.message?.content)) continue;
    for (let j = event.message.content.length - 1; j >= 0; j--) {
      const block = event.message.content[j] as { type?: unknown; text?: unknown };
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) return block.text;
    }
  }
  return null;
}

function lastQuestion(events: WorkbenchEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const content = events[i].event.message?.content;
    if (events[i].event.type !== 'assistant' || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: unknown; name?: unknown; input?: { questions?: Array<{ question?: unknown }> } };
      const question = block?.input?.questions?.[0]?.question;
      if (block?.type === 'tool_use' && block.name === 'AskUserQuestion' && typeof question === 'string' && question.trim()) {
        return question;
      }
    }
  }
  return null;
}

function lastResultError(events: WorkbenchEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event;
    if (event.type !== 'result') continue;
    if (typeof event.result === 'string' && event.result.trim()) return event.result;
    const errors = event.errors;
    if (typeof errors === 'string' && errors.trim()) return errors;
    if (Array.isArray(errors)) {
      const messages = errors.map((error: unknown) => {
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
          return error.message;
        }
        return '';
      }).filter(Boolean);
      if (messages.length) return messages.join(' ');
    }
    return null;
  }
  return null;
}

/** A short account of the latest turn, when its events contain one. */
export function notificationSummary(chat: NotificationChat, events: WorkbenchEvent[]): string | null {
  const turn = lastTurn(events);
  const current = events.filter((event) => event.turn === turn);
  for (let i = current.length - 1; i >= 0; i--) {
    const event = current[i].event;
    if (event.type === 'talyn_pr' && event.ok === true && typeof event.number === 'number') {
      return `${event.adopted === true ? 'Linked' : 'Opened'} PR #${event.number}`;
    }
  }
  if (chat.status === 'awaiting_input') return cleanSummary(lastQuestion(current) ?? lastAssistantText(current) ?? '');
  if (chat.status === 'error') return cleanSummary(lastResultError(current) ?? chat.error ?? 'The agent stopped with an error.');
  return cleanSummary(lastAssistantText(current) ?? '');
}

export function notificationText(
  chat: NotificationChat,
  workbench: (Pick<Workbench, 'name'> & { title?: string | null }) | undefined,
  events: WorkbenchEvent[] = []
): { title: string; body: string } {
  const name = (workbench && workbenchDisplayName(workbench).trim()) || 'Session';
  const status = chat.status === 'error' ? 'Failed' : chat.status === 'awaiting_input' ? 'Needs your reply' : 'Done';
  const fallback = chat.status === 'error'
    ? 'The agent stopped with an error.'
    : chat.status === 'awaiting_input' ? 'The agent is waiting for your answer.' : 'The agent finished.';
  return { title: truncate(`${status}: ${name}`, 80), body: notificationSummary(chat, events) ?? fallback };
}

/**
 * A toast when a sandbox Create PR turn could not open its PR. The thread says
 * so too; the toast is for a person looking elsewhere. A local session (made in
 * the desktop app) toasts on its own computer, so it is skipped here.
 */
export function toastPullRequestFailures(chatId: string, events: WorkbenchEvent[]): void {
  const failed = events.filter((e) => e.event.type === 'talyn_pr' && (e.event as { ok?: unknown }).ok !== true);
  if (failed.length === 0) return;
  const { chats, workbenches } = useWorkbenchStore.getState();
  const chat = Object.values(chats)
    .flat()
    .find((c) => c.id === chatId);
  if (!chat || workbenches[chat.workbenchId]?.runtime !== 'sandbox') return;
  for (const e of failed) {
    const message = (e.event as { message?: unknown }).message;
    toast.error('Could not open the pull request', typeof message === 'string' ? message : undefined);
  }
}

/** What a notification click does: raise the tab, then open the workbench route and the chat. */
export function openFromNotification(chat: Pick<WorkbenchChat, 'id' | 'workbenchId'>): void {
  try {
    window.focus();
  } catch {
    // Some browsers refuse focus from a notification click: the route still changes.
  }
  navigateToWorkbench(chat.workbenchId);
  const store = useWorkbenchStore.getState();
  store.selectChat(chat.workbenchId, chat.id);
  store.markRead(chat.id);
}

function notifyChatFinished(chat: WorkbenchChat, workbench: Workbench | undefined): void {
  if (!readSessionDefaults().notifyOnFinish) return;
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  const events = useWorkbenchStore.getState().chatEvents[chat.id]?.events ?? [];
  const { title, body } = notificationText(chat, workbench, events);
  const fire = () => {
    try {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        try {
          openFromNotification(chat);
        } catch {
          // ignore
        }
      };
    } catch {
      // Permission denied or a renderer quirk: the unread dot still shows.
    }
  };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission()
      .then((perm) => {
        if (perm === 'granted') fire();
      })
      .catch(() => {});
  }
}

export function installWorkbenchNotifications(): () => void {
  setChatFinishedListener(notifyChatFinished);
  return () => setChatFinishedListener(null);
}
