/**
 * Threads: a long conversation with no repository. A thread starts sessions on
 * repositories with `talyn_create_session`. Talyn tells the thread when one of
 * its sessions changes: a `talyn_thread` event in the thread's transcript, and
 * for most changes a short Talyn message that gives the thread's agent a turn.
 */

export type ThreadSessionAction = 'session_started' | 'session_finished' | 'pr_opened' | 'pr_merged' | 'needs_input' | 'paused';
export const THREAD_SESSION_ACTIONS: readonly ThreadSessionAction[] = [
  'session_started',
  'session_finished',
  'pr_opened',
  'pr_merged',
  'needs_input',
  'paused',
];

/** The `talyn_thread` transcript event, without its `type`. */
export interface ThreadSessionEvent {
  action: ThreadSessionAction;
  sessionId: string;
  name: string;
  /** `owner/name`. */
  repo: string;
  /** The session's chat status when the event was written (`idle`, `error`, ...). */
  status: string;
  prUrl?: string;
}

/** A stored `talyn_thread` event, or null when it is not one. */
export function parseThreadSessionEvent(event: Record<string, unknown>): ThreadSessionEvent | null {
  if (event.type !== 'talyn_thread') return null;
  const action = event.action;
  if (!THREAD_SESSION_ACTIONS.includes(action as ThreadSessionAction)) return null;
  const text = (key: string) => (typeof event[key] === 'string' ? (event[key] as string) : '');
  if (!text('sessionId')) return null;
  return {
    action: action as ThreadSessionAction,
    sessionId: text('sessionId'),
    name: text('name'),
    repo: text('repo'),
    status: text('status'),
    ...(text('prUrl') ? { prUrl: text('prUrl') } : {}),
  };
}

/** One line for the transcript card. */
export function threadSessionEventText(event: ThreadSessionEvent): string {
  const who = `Session ${event.name || event.sessionId}${event.repo ? ` on ${event.repo}` : ''}`;
  switch (event.action) {
    case 'session_started':
      return `${who} started`;
    case 'pr_opened':
      return `${who} opened a pull request`;
    case 'pr_merged':
      return `${who}: pull request merged`;
    case 'needs_input':
      return `${who} needs an answer`;
    case 'session_finished':
      return event.status === 'error' ? `${who} stopped with an error` : `${who} finished its turn`;
    case 'paused':
      return 'The thread stopped waking itself because its sessions made no progress since its last turn. It waits for the person.';
  }
}

/** True for a queued or stored message that Talyn wrote, not a person. */
export function isTalynOriginMessage(talyn: unknown): boolean {
  return Boolean(talyn && typeof talyn === 'object' && (talyn as { origin?: unknown }).origin === 'talyn');
}
