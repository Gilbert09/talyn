import type { Workbench, WorkbenchChat, WorkbenchEvent } from './workbench.js';
import { workbenchDisplayName } from './workbenchTitle.js';

/**
 * The text of a "your agent finished" alert: the desktop and web OS
 * notifications and the mobile push alert all build it here, so the three
 * say the same thing about the same turn.
 */

export type NotificationChat = Pick<WorkbenchChat, 'status'> & Partial<Pick<WorkbenchChat, 'title'>> & { error?: string | null };

/** Cuts `text` to `length` characters, ending in an ellipsis when it was longer. */
export function truncateNotificationText(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/** The highest turn among the events, or 0 when there are none. */
export function latestEventTurn(events: readonly Pick<WorkbenchEvent, 'turn'>[]): number {
  let turn = 0;
  for (const e of events) if (e.turn > turn) turn = e.turn;
  return turn;
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
    if (end >= 20) return truncateNotificationText(cleaned.slice(0, end), 140);
  }
  return truncateNotificationText(cleaned, 140);
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
  const turn = latestEventTurn(events);
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
  return { title: truncateNotificationText(`${status}: ${name}`, 80), body: notificationSummary(chat, events) ?? fallback };
}
