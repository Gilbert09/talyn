import { eq, sql } from 'drizzle-orm';
import { SLACK_STATUS_REACTIONS, type SlackStatusState, type Workbench, type WorkbenchChat } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { onWorkbenchEmit } from '../workbenches/emit.js';
import { publicWorkbench } from '../workbenches/prLink.js';
import { getWorkbench } from '../workbenches/store.js';
import { SlackApiError } from './api.js';
import { getThreadById, swapStatusReaction, threadForWorkbench, type SlackThreadRow } from './threads.js';
import { callSlackAsBot } from './tokens.js';

/**
 * One reaction on the triggering Slack message that says what the session is
 * doing: 👀 starting, ⏳ working, ✅ done or waiting for you, 🔗 PR open,
 * 🎉 merged, ❌ failed, ❓ needs a repository or an answer.
 *
 * Driven by the session's own emits (`emitWorkbenchUpdated` /
 * `emitWorkbenchChat`), never a poller. Debounced per session, because a turn
 * flips the chat running → idle → running in a second when messages are
 * queued, and every flip would otherwise cost two Slack calls.
 *
 * Talyn removes only the reaction it stored on `slack_threads`, and only as
 * the bot: the user's own trigger emoji is theirs and stays. Best effort: a
 * Slack failure is logged and never reaches the turn loop.
 */

export const STATUS_DEBOUNCE_MS = 2_000;

/** The state a session's reaction should show. Pure. */
export function stateForWorkbench(wb: Pick<Workbench, 'status' | 'sandboxState' | 'archivedAt' | 'pr' | 'chats'>): SlackStatusState {
  const chats: Pick<WorkbenchChat, 'status' | 'queuedMessages'>[] = wb.chats ?? [];
  if (wb.status === 'error' || wb.sandboxState === 'error' || chats.some((c) => c.status === 'error')) return 'failed';
  if (chats.some((c) => c.status === 'running')) return 'working';
  if (wb.pr?.state === 'merged') return 'merged';
  if (wb.status === 'provisioning' || wb.status === 'moving' || wb.sandboxState === 'creating') return 'starting';
  if (chats.some((c) => c.status === 'awaiting_input')) return 'needs_input';
  // Ready with a message waiting: the turn is about to start.
  if (!wb.archivedAt && chats.some((c) => (c.queuedMessages ?? []).length > 0)) return 'starting';
  if (wb.pr?.state === 'open') return 'pr_open';
  return 'done';
}

/** Slack answers these when the reaction is already in the state we want. */
const ADD_OK = new Set(['already_reacted']);
const REMOVE_OK = new Set(['no_reaction', 'message_not_found']);

async function react(teamId: string, method: 'reactions.add' | 'reactions.remove', channel: string, ts: string, name: string): Promise<void> {
  try {
    await callSlackAsBot(teamId, method, { channel, timestamp: ts, name });
  } catch (err) {
    const ok = method === 'reactions.add' ? ADD_OK : REMOVE_OK;
    if (err instanceof SlackApiError && ok.has(err.code)) return;
    throw err;
  }
}

/** Add one reaction outside any thread record (an unlinked mention). Never throws. */
export async function reactOnce(teamId: string, channel: string, ts: string, name: string): Promise<void> {
  try {
    await react(teamId, 'reactions.add', channel, ts, name);
  } catch (err) {
    debugBus.recordEvent({ service: 'slack_events', action: 'reaction_failed', ok: false, summary: `${name} on ${channel}`, error: err });
  }
}

/**
 * Swaps for one thread run one at a time in this process: two overlapping
 * swaps could otherwise remove a reaction before the other has added it and
 * leave two. Across replicas the compare-and-set below keeps the row honest;
 * the debounce makes an overlap there rare.
 */
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  chains.set(threadId, settled);
  void settled.then(() => {
    if (chains.get(threadId) === settled) chains.delete(threadId);
  });
  return next;
}

/**
 * Show `state` on the thread's trigger message. Compare-and-set first, so two
 * replicas cannot both swap; the Slack calls follow. Returns false when it did
 * nothing (already showing it, or lost the race twice). Never throws.
 */
export function setThreadStatus(thread: SlackThreadRow, state: SlackStatusState): Promise<boolean> {
  return serialized(thread.id, () => swapStatus(thread, state));
}

async function swapStatus(thread: SlackThreadRow, state: SlackStatusState): Promise<boolean> {
  try {
    let current: SlackThreadRow | null = thread;
    for (let attempt = 0; attempt < 2 && current; attempt++) {
      const reaction = SLACK_STATUS_REACTIONS[state];
      if (current.statusReaction === reaction) return false;
      const won = await swapStatusReaction(
        current.id,
        { reaction: current.statusReaction, messageTs: current.triggerMessageTs },
        { reaction, state }
      );
      if (won) {
        if (current.statusReaction) {
          await react(current.teamId, 'reactions.remove', current.channelId, current.triggerMessageTs, current.statusReaction);
        }
        await react(current.teamId, 'reactions.add', current.channelId, current.triggerMessageTs, reaction);
        return true;
      }
      current = await getThreadById(thread.id);
    }
    return false;
  } catch (err) {
    debugBus.recordEvent({ service: 'slack_events', action: 'status_failed', ok: false, summary: `${state} for thread ${thread.id}`, error: err });
    return false;
  }
}

/**
 * A later trigger in the same thread: the status moves to the NEW message.
 * Our reaction comes off the old one first; the user's emoji stays. Returns
 * the row as it now is. Never throws.
 */
export async function moveStatusToMessage(thread: SlackThreadRow, messageTs: string): Promise<SlackThreadRow> {
  if (thread.triggerMessageTs === messageTs) return thread;
  try {
    const won = await swapStatusReaction(
      thread.id,
      { reaction: thread.statusReaction, messageTs: thread.triggerMessageTs },
      { reaction: null, state: null, messageTs }
    );
    if (won && thread.statusReaction) {
      await react(thread.teamId, 'reactions.remove', thread.channelId, thread.triggerMessageTs, thread.statusReaction).catch((err) =>
        debugBus.recordEvent({ service: 'slack_events', action: 'reaction_failed', ok: false, summary: 'remove on move', error: err })
      );
    }
  } catch (err) {
    debugBus.recordEvent({ service: 'slack_events', action: 'status_failed', ok: false, summary: `move for thread ${thread.id}`, error: err });
  }
  return (await getThreadById(thread.id).catch(() => null)) ?? { ...thread, triggerMessageTs: messageTs, statusReaction: null, lastState: null };
}

// ---------------------------------------------------------------------------
// Following the session's emits
// ---------------------------------------------------------------------------

/**
 * Whether a session came from Slack. `source` is set at creation and never
 * changes, so an answer is good for the life of the process. Bounded; the
 * oldest answer goes first.
 */
const SOURCE_CACHE_MAX = 10_000;
const fromSlack = new Map<string, boolean>();
const timers = new Map<string, NodeJS.Timeout>();

function remember(workbenchId: string, slack: boolean): void {
  if (fromSlack.size >= SOURCE_CACHE_MAX) {
    const oldest = fromSlack.keys().next().value;
    if (oldest !== undefined) fromSlack.delete(oldest);
  }
  fromSlack.set(workbenchId, slack);
}

async function isFromSlack(workbenchId: string): Promise<boolean> {
  const known = fromSlack.get(workbenchId);
  if (known !== undefined) return known;
  const rows = await getPoolDbClient()
    .select({ slack: sql<boolean>`(${workbenches.source} ->> 'kind') = 'slack'` })
    .from(workbenches)
    .where(eq(workbenches.id, workbenchId))
    .limit(1);
  const slack = rows[0]?.slack === true;
  if (rows[0]) remember(workbenchId, slack);
  return slack;
}

/** Schedule a status update for a session, coalescing flips inside the debounce. */
export function scheduleSlackStatus(workbenchId: string, delayMs = STATUS_DEBOUNCE_MS): void {
  const prior = timers.get(workbenchId);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    timers.delete(workbenchId);
    void runWithoutScope(() => applyWorkbenchStatus(workbenchId)).catch((err) =>
      debugBus.recordEvent({ service: 'slack_events', action: 'status_failed', ok: false, summary: workbenchId, error: err })
    );
  }, delayMs);
  timer.unref?.();
  timers.set(workbenchId, timer);
}

/** Read the session as it is now and show that. */
export async function applyWorkbenchStatus(workbenchId: string): Promise<SlackStatusState | null> {
  const thread = await threadForWorkbench(workbenchId);
  if (!thread || thread.phase !== 'started') return null;
  const row = await getWorkbench(workbenchId);
  if (!row) return null;
  const state = stateForWorkbench(await publicWorkbench(row));
  await setThreadStatus(thread, state);
  return state;
}

let unregister: (() => void) | null = null;

/** Follow session emits. Called once at boot. */
export function registerSlackStatusReactions(): void {
  if (unregister) return;
  unregister = onWorkbenchEmit({
    workbench: (wb) => {
      const slack = wb.source?.kind === 'slack';
      remember(wb.id, slack);
      if (slack) scheduleSlackStatus(wb.id);
    },
    chat: (_workspaceId, chat) => {
      const known = fromSlack.get(chat.workbenchId);
      if (known === false) return;
      if (known === true) return scheduleSlackStatus(chat.workbenchId);
      void isFromSlack(chat.workbenchId)
        .then((slack) => {
          if (slack) scheduleSlackStatus(chat.workbenchId);
        })
        .catch(() => undefined);
    },
  });
}

/** Tests: stop following emits and forget timers and cached answers. */
export function resetSlackStatusForTests(): void {
  unregister?.();
  unregister = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  fromSlack.clear();
  chains.clear();
}
