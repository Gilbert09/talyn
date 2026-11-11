import { useEffect, useMemo, useState } from 'react';
import type { WorkbenchChat, WorkbenchEvent, WorkbenchQueuedMessage } from '@talyn/shared';
import { pendingMessageState, PENDING_MESSAGE_GRACE_MS } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { useWorkbenchStore, type OutgoingWorkbenchMessage } from '../../stores/workbenches';

const EMPTY_OUTGOING_MESSAGES: OutgoingWorkbenchMessage[] = [];
const EMPTY_QUEUE: WorkbenchQueuedMessage[] = [];
const EMPTY_EVENTS: WorkbenchEvent[] = [];

export interface PendingMessages {
  /** The transcript draws these as the user's bubbles. */
  shown: OutgoingWorkbenchMessage[];
  /** The composer draws these as queued, until the chat's queue lists them. */
  queuing: OutgoingWorkbenchMessage[];
}

/**
 * The prompts the user sent that the chat does not show yet. The backend
 * writes a prompt's event only when its turn starts, so a new session's first
 * message would otherwise vanish until the sandbox woke. A prompt sent while a
 * turn runs goes to the queue, so it shows as queued from the start.
 * Prompts whose event arrived, or that will not run, are forgotten.
 */
export function usePendingMessages(chat: WorkbenchChat | null, events: WorkbenchEvent[] | undefined, ops: WorkbenchOps): PendingMessages {
  const chatId = chat?.id ?? null;
  const outgoing = useWorkbenchStore((state) => (chatId ? state.outgoingMessages[chatId] : undefined) ?? EMPTY_OUTGOING_MESSAGES);
  const localQueue = useWorkbenchStore((state) => (chatId ? state.localQueues[chatId] : undefined));
  const queued = (ops.runtime === 'local' ? localQueue : chat?.queuedMessages) ?? EMPTY_QUEUE;
  const heldEvents = events ?? EMPTY_EVENTS;
  const running = chat?.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  const states = useMemo(
    () => outgoing.map((message) => pendingMessageState(message, { events: heldEvents, queued, running, now })),
    [outgoing, heldEvents, queued, running, now],
  );

  const done = outgoing.filter((_, i) => states[i] === 'done').map((message) => message.id).join('\n');
  useEffect(() => {
    if (chatId && done) useWorkbenchStore.getState().removeOutgoingMessages(chatId, done.split('\n'));
  }, [chatId, done]);

  // Look again when the grace of a sent message ends. A shown message stays
  // while its turn runs, but a queuing one goes back to the transcript.
  const expiry = outgoing.reduce<number | null>((soonest, message, i) => {
    if (message.settledAt === undefined) return soonest;
    if (states[i] !== 'queue' && (states[i] !== 'show' || running)) return soonest;
    const end = message.settledAt + PENDING_MESSAGE_GRACE_MS;
    return soonest === null ? end : Math.min(soonest, end);
  }, null);
  useEffect(() => {
    if (expiry === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [expiry]);

  return useMemo(
    () => ({
      shown: outgoing.filter((_, i) => states[i] === 'show'),
      queuing: outgoing.filter((_, i) => states[i] === 'queue'),
    }),
    [outgoing, states],
  );
}
