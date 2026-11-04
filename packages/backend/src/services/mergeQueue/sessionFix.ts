// Merge queue v2 — a fix sent INTO the live session on a PR.
//
// When the queue needs a fix on a PR that a live, idle session owns, a
// separate fix task would put two agents on one branch. So the queue sends
// the fix request to the session as a message, and the session's own agent
// does it with its own context. This module holds the I/O for that: the
// delivery, and the read that tells decide whether the session's turn is
// still running and what it said at the end.
//
// The entry carries it as `fixKind: 'session'` with `fixTaskId: null`. The
// session's turn takes the place of the fix run in every rule that reads one
// (R6 holds while it works, R8 accounts it: same budget, same progress rule,
// same needs-human stand-down).

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { parseNeedsHumanSentinel } from '@talyn/shared';
import { v4 as uuid } from 'uuid';
import { getPoolDbClient } from '../../db/client.js';
import { mergeQueueEvents, workbenchEvents } from '../../db/schema.js';
import { sessionActivity } from '../workbenches/prSessions.js';
import { emitWorkbenchChat } from '../workbenches/emit.js';
import { getWorkbench, insertChat, latestChat, rowToChat } from '../workbenches/store.js';
import { sendMessage } from '../workbenches/turns.js';
import type { EntrySnapshot } from './types.js';

/** The event code whose `detail` records where the fix went. */
export const SESSION_FIX_SENT = 'session_fix_sent';

export interface SessionFixSent {
  workbenchId: string;
  chatId: string;
  sentAt: string;
}

/** Where the entry's unaccounted session fix went, read off its own timeline. */
export async function readSessionFixSent(entryId: string): Promise<SessionFixSent | null> {
  const [row] = await getPoolDbClient()
    .select({ detail: mergeQueueEvents.detail })
    .from(mergeQueueEvents)
    .where(and(eq(mergeQueueEvents.entryId, entryId), eq(mergeQueueEvents.code, SESSION_FIX_SENT)))
    .orderBy(desc(mergeQueueEvents.at), desc(mergeQueueEvents.id))
    .limit(1);
  const d = (row?.detail ?? null) as Partial<SessionFixSent> | null;
  if (!d || typeof d.workbenchId !== 'string' || typeof d.chatId !== 'string' || typeof d.sentAt !== 'string') {
    return null;
  }
  return { workbenchId: d.workbenchId, chatId: d.chatId, sentAt: d.sentAt };
}

/**
 * The closing text of the newest turn in `chatId` that ended at or after
 * `since`. Only the `result` text ships, never the rest of the transcript.
 */
export async function lastTurnResultSince(chatId: string, since: string): Promise<string | null> {
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) return null;
  const [row] = await getPoolDbClient()
    .select({ text: sql<string | null>`${workbenchEvents.event} ->> 'result'` })
    .from(workbenchEvents)
    .where(
      and(
        eq(workbenchEvents.chatId, chatId),
        sql`${workbenchEvents.event} ->> 'type' = 'result'`,
        gte(workbenchEvents.createdAt, sinceDate)
      )
    )
    .orderBy(desc(workbenchEvents.seq))
    .limit(1);
  return row?.text ?? null;
}

/**
 * The session's turn as decide reads a fix run. `active` while the session
 * works; `terminal` once it is idle, gone or archived. A terminal session that
 * ended on the needs-human sentinel carries the reason.
 */
export interface SessionFixRunState {
  state: 'active' | 'terminal';
  startedAt: string | null;
  lastActivityAt: string | null;
  needsHumanReason: string | null;
}

export async function sessionFixRunState(entry: EntrySnapshot): Promise<SessionFixRunState> {
  const sent = await readSessionFixSent(entry.id);
  if (!sent) return { state: 'terminal', startedAt: null, lastActivityAt: null, needsHumanReason: null };
  const activity = await sessionActivity(sent.workbenchId);
  if (activity?.activity === 'working') {
    return {
      state: 'active',
      startedAt: sent.sentAt,
      lastActivityAt: activity.lastActivityAt ?? sent.sentAt,
      needsHumanReason: null,
    };
  }
  const said = await lastTurnResultSince(sent.chatId, sent.sentAt).catch(() => null);
  const needsHuman = parseNeedsHumanSentinel(said);
  return {
    state: 'terminal',
    startedAt: sent.sentAt,
    lastActivityAt: activity?.lastActivityAt ?? sent.sentAt,
    needsHumanReason: needsHuman ? needsHuman.reason : null,
  };
}

/** The message the session gets: the fix run's own prompt, with one line in front. */
export function sessionFixMessage(ref: string, prompt: string): string {
  return (
    `The merge queue needs this pull request fixed: ${ref}. ` +
    'Do the work below in this session, on this branch. The merge queue waits for your turn to end.\n\n' +
    prompt
  );
}

/**
 * Send `text` to the session's most recent chat (a new chat when it has none
 * open), through the ordinary send path. Returns the chat it went to. Throws
 * when the session cannot take a message (archived, in error, local).
 */
export async function deliverToSession(workbenchId: string, text: string): Promise<string> {
  const row = await getWorkbench(workbenchId);
  if (!row) throw new Error('The session is gone.');
  let chat = await latestChat(row.id);
  if (!chat || chat.closedAt) {
    chat = await insertChat({
      id: uuid(),
      workbenchId: row.id,
      workspaceId: row.workspaceId,
      title: 'Chat',
      agent: row.agent,
      model: row.model,
    });
    emitWorkbenchChat(row.workspaceId, rowToChat(chat));
  }
  await sendMessage(chat.id, { text }, { origin: 'talyn' });
  return chat.id;
}
