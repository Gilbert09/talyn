import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type {
  ContinueWorkbenchAsThreadInput,
  ThreadSessionAction,
  ThreadSessionEvent,
  Workbench,
  WorkbenchAgent,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable, workbenches } from '../../db/schema.js';
import { createWorkbench } from './create.js';
import { emitWorkbenchEvents } from './emit.js';
import { WorkbenchError } from './errors.js';
import { eligiblePr, linkedBeforeMerge } from './prEligibility.js';
import type { ReadinessUser } from './readiness.js';
import { appendEvents, getWorkbench, isThread, listChats, threadAutoWakeState, threadSessions, type ChatRow, type WorkbenchRow } from './store.js';
import { sendMessage } from './turns.js';

/**
 * Threads: a workbench with `kind = 'thread'` has no repository and starts
 * sessions on repositories. A session in a thread has `threadId` set. When
 * such a session starts, finishes a turn, opens a pull request, has its pull
 * request merged or needs an answer, Talyn writes a `talyn_thread` event in
 * the thread's transcript. For every change but a start, Talyn also queues a
 * short message in the thread chat, so the thread's agent takes a turn and
 * reads what changed.
 *
 * Only a session's own turns call {@link notifyThread}: a thread has no
 * `threadId`, so a thread's turn (Talyn's message included) never notifies.
 */

/** Changes that give the thread's agent a turn. A start is only a card: the thread started it. */
const WAKES: ReadonlySet<ThreadSessionAction> = new Set(['session_finished', 'pr_opened', 'pr_merged', 'needs_input']);

/** The thread chat Talyn writes to: the running one, else the newest open one. */
function activeChat(chats: ChatRow[]): ChatRow | null {
  const open = chats.filter((chat) => !chat.closedAt);
  return open.find((c) => c.status === 'running') ?? [...open].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
}

async function prUrlOf(pullRequestId: string | null): Promise<string | undefined> {
  if (!pullRequestId) return undefined;
  const [pr] = await getPoolDbClient()
    .select({ owner: prTable.owner, repo: prTable.repo, number: prTable.number })
    .from(prTable)
    .where(eq(prTable.id, pullRequestId))
    .limit(1);
  return pr ? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` : undefined;
}

async function childFingerprint(threadId: string): Promise<string> {
  const children = await threadSessions(threadId);
  const state = await Promise.all(children.map(async (child) => {
    // Read stored state only: an exec would wake every sleeping child box.
    const [pr] = child.pullRequestId ? await getPoolDbClient()
      .select({ state: prTable.state, lastSummary: prTable.lastSummary })
      .from(prTable)
      .where(eq(prTable.id, child.pullRequestId))
      .limit(1) : [];
    const summary = (pr?.lastSummary ?? {}) as Record<string, unknown>;
    const chat = activeChat(await listChats(child.id));
    return [
      child.id, child.branch, child.pushedHeadShas.at(-1) ?? null,
      child.pullRequestId, summary.headSha ?? null, pr?.state ?? null,
      summary.ciStatus ?? null, summary.checksTotal ?? null, summary.checksPassed ?? null,
      summary.checksFailed ?? null, summary.checksInProgress ?? null, summary.checksSkipped ?? null,
      chat?.status ?? child.status,
    ];
  }));
  return JSON.stringify(state.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** The message that wakes the thread. The agent cannot see transcript cards, so the facts go in the text. */
export function threadWakeText(event: ThreadSessionEvent): string {
  const who = `"${event.name}" (session id ${event.sessionId}) on ${event.repo}`;
  const what =
    event.action === 'pr_opened'
      ? `Session ${who} opened a pull request${event.prUrl ? `: ${event.prUrl}` : ''}.`
      : event.action === 'pr_merged'
        ? `The pull request of session ${who} merged${event.prUrl ? `: ${event.prUrl}` : ''}.`
      : event.action === 'needs_input'
        ? `Session ${who} is waiting for an answer.`
        : event.status === 'error'
          ? `Session ${who} stopped with an error.`
          : `Session ${who} finished its turn.${event.prUrl ? ` Its pull request is ${event.prUrl}.` : ''}`;
  return [
    `[Talyn] ${what}`,
    'Read what it did with `talyn_get_session_transcript`. Other sessions of this thread may have changed too: ' +
      'see them all with `talyn_list_thread_sessions`. Then continue the plan, or report to the person.',
  ].join('\n');
}

/**
 * Tell a session's thread that the session changed. Best effort: a failure is
 * logged and never fails the caller's turn or link. `wake: false` writes only
 * the card, for a change that a later wake reports anyway.
 */
export async function notifyThread(
  child: WorkbenchRow,
  action: ThreadSessionAction,
  opts: { wake?: boolean; status?: string } = {},
): Promise<void> {
  try {
    if (!child.threadId || isThread(child)) return;
    const thread = await getWorkbench(child.threadId);
    if (!thread || !isThread(thread) || thread.archivedAt) return;
    const chat = activeChat(await listChats(thread.id));
    if (!chat) return;
    const prUrl = await prUrlOf(child.pullRequestId);
    const event: ThreadSessionEvent = {
      action,
      sessionId: child.id,
      name: child.title || child.name,
      repo: child.repoFullName,
      status: opts.status ?? activeChat(await listChats(child.id))?.status ?? 'idle',
      ...(prUrl ? { prUrl } : {}),
    };
    const candidate = opts.wake !== false && WAKES.has(action);
    const coalesced = chat.queuedMessages.some((m) => m.origin === 'talyn');
    const wakeState = candidate && !coalesced ? await threadAutoWakeState(thread.id) : null;
    const fingerprint = wakeState ? await childFingerprint(thread.id) : null;
    const noProgress = wakeState?.fingerprint === fingerprint && !wakeState?.userSinceWake;
    const willWake = candidate && !coalesced && !noProgress;
    const stored = await appendEvents(chat.id, [{
      turn: chat.turnCount,
      event: { type: 'talyn_thread', ...event, ...(willWake ? { wakeFingerprint: fingerprint } : {}) },
    }]);
    emitWorkbenchEvents(thread.workspaceId, chat.id, stored);
    if (noProgress) {
      if (!wakeState?.paused) {
        const paused = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'talyn_thread', ...event, action: 'paused' } }]);
        emitWorkbenchEvents(thread.workspaceId, chat.id, paused);
      }
      return;
    }
    // One waiting wake is enough: the agent lists every session when it runs.
    if (!willWake) return;
    await sendMessage(chat.id, { text: threadWakeText(event) }, { origin: 'talyn' });
  } catch (err) {
    console.warn(`[thread] telling the thread of session ${child.id} about ${action} failed:`, err);
  }
}

/** A pull request linked outside the end of a turn. Wakes the thread only when no turn of the session runs. */
export async function notifyThreadOfLinkedPr(child: WorkbenchRow): Promise<void> {
  if (!child.threadId) return;
  // A running turn ends in `session_finished`, which wakes the thread and names the pull request.
  const running = (await listChats(child.id).catch(() => [])).some((c) => c.status === 'running');
  await notifyThread(child, 'pr_opened', { wake: !running });
}

/**
 * A pull request merged: tell the thread of each session that owns it. Call it
 * after the row is `merged`, so the wake sees the new state as progress. The
 * `threadToldOfMerge` mark makes sure that one merge wakes a thread one time,
 * also when the webhook and the poll sweep both see it.
 */
export async function notifyThreadsOfMergedPr(pullRequestId: string): Promise<void> {
  try {
    const db = getPoolDbClient();
    const children = await db.select({ id: workbenches.id }).from(workbenches)
      .innerJoin(prTable, eq(prTable.id, workbenches.pullRequestId))
      .where(and(
        eq(workbenches.pullRequestId, pullRequestId), isNotNull(workbenches.threadId),
        eq(prTable.state, 'merged'), eligiblePr(), linkedBeforeMerge(),
        sql`NOT (COALESCE(${workbenches.settings} -> 'threadToldOfMerge', '[]'::jsonb) ? ${pullRequestId})`,
      ));
    for (const { id } of children) {
      const [marked] = await db.update(workbenches).set({
        settings: sql`COALESCE(${workbenches.settings}, '{}'::jsonb) || jsonb_build_object('threadToldOfMerge',
          COALESCE(${workbenches.settings} -> 'threadToldOfMerge', '[]'::jsonb) || jsonb_build_array(${pullRequestId}::text))`,
      }).where(and(
        eq(workbenches.id, id), eq(workbenches.pullRequestId, pullRequestId),
        sql`NOT (COALESCE(${workbenches.settings} -> 'threadToldOfMerge', '[]'::jsonb) ? ${pullRequestId})`,
      )).returning({ id: workbenches.id });
      if (!marked) continue;
      const child = await getWorkbench(id);
      if (child) await notifyThread(child, 'pr_merged');
    }
  } catch (err) {
    console.warn(`[thread] telling threads that pull request ${pullRequestId} merged failed:`, err);
  }
}

/** `talyn_create_session` from a thread: the session-started card. */
export async function announceThreadSession(childId: string): Promise<void> {
  const child = await getWorkbench(childId).catch(() => null);
  if (child) await notifyThread(child, 'session_started');
}

/**
 * `talyn_create_session` from a session: show the new session in the caller's
 * chat. A thread uses the same card through its normal notification path.
 */
export async function announceSessionSpawn(parentId: string, childId: string): Promise<void> {
  try {
    const [parent, child] = await Promise.all([
      getWorkbench(parentId),
      getWorkbench(childId),
    ]);
    if (!parent || !child || parent.archivedAt) return;
    if (isThread(parent)) {
      await notifyThread(child, 'session_started');
      return;
    }
    const chat = activeChat(await listChats(parent.id));
    if (!chat) return;
    const event: ThreadSessionEvent = {
      action: 'session_started',
      sessionId: child.id,
      name: child.title || child.name,
      repo: child.repoFullName,
      status: activeChat(await listChats(child.id))?.status ?? 'idle',
    };
    const stored = await appendEvents(chat.id, [{
      turn: chat.turnCount,
      event: { type: 'talyn_thread', ...event },
    }]);
    emitWorkbenchEvents(parent.workspaceId, chat.id, stored);
  } catch (err) {
    console.warn(`[session] announcing child session ${childId} to parent ${parentId} failed:`, err);
  }
}

/**
 * `POST /workbenches/:id/thread`: a new thread whose first message recaps the
 * session's chat, with the session as its first member.
 */
export async function continueAsThread(
  session: WorkbenchRow,
  body: ContinueWorkbenchAsThreadInput,
  actor: ReadinessUser,
): Promise<Workbench> {
  if (isThread(session)) throw new WorkbenchError('This is already a thread.', 409, 'already_thread');
  if (body.agent !== undefined && body.agent !== 'claude' && body.agent !== 'codex') {
    throw new WorkbenchError('agent must be "claude" or "codex"', 400, '');
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new WorkbenchError('prompt must be a string', 400, '');
  const agent = body.agent ?? (session.agent as WorkbenchAgent);
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : agent === session.agent ? session.model : null;
  return createWorkbench(
    {
      workspaceId: session.workspaceId,
      kind: 'thread',
      runtime: 'sandbox',
      agent,
      ...(model ? { model } : {}),
      ...(body.prompt?.trim() ? { prompt: body.prompt } : {}),
      fromSessionId: session.id,
    },
    actor,
  );
}
