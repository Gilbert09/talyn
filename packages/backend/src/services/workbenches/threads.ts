import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type {
  ContinueWorkbenchAsThreadInput,
  ThreadSessionAction,
  ThreadSessionEvent,
  Workbench,
  WorkbenchAgent,
  WorkbenchQuestionEvent,
} from '@talyn/shared';
import { parseQuestionEvent, QUESTION_EVENT_TYPE, questionSummary, questionText } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable, workbenches } from '../../db/schema.js';
import { workspaceHasFeature } from '../featureFlags.js';
import { createWorkbench } from './create.js';
import { emitWorkbenchEvents } from './emit.js';
import { WorkbenchError } from './errors.js';
import { linkedBeforeMerge, ownsLinkedPr } from './prEligibility.js';
import type { ReadinessUser } from './readiness.js';
import { appendEvents, childSessions, getWorkbench, isThread, latestTurnEvent, listChats, threadAutoWakeState, threadSessions, type ChatRow, type WorkbenchRow } from './store.js';
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

async function childFingerprint(threadId: string, thread = true): Promise<string> {
  const children = await (thread ? threadSessions(threadId) : childSessions(threadId));
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

/** The question the session's chat asked in its latest turn: the named chat, else its newest one waiting for an answer. */
async function pendingQuestion(sessionId: string, chatId?: string): Promise<WorkbenchQuestionEvent | null> {
  const chats = (await listChats(sessionId)).filter((c) => !c.closedAt);
  const chat = chatId
    ? chats.find((c) => c.id === chatId)
    : [...chats].filter((c) => c.status === 'awaiting_input').sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (!chat) return null;
  const event = await latestTurnEvent(chat.id, chat.turnCount, QUESTION_EVENT_TYPE);
  return event ? parseQuestionEvent(event) : null;
}

/** The message that wakes the thread. The agent cannot see transcript cards, so the facts go in the text. */
export function threadWakeText(event: ThreadSessionEvent, question?: WorkbenchQuestionEvent | null): string {
  if (event.action === 'needs_input' && question) {
    const who = `"${event.name}" (session id ${event.sessionId}) on ${event.repo}`;
    return [
      `[Talyn] Session ${who} asks:`,
      '',
      questionText(question),
      '',
      'The person sees these questions in the session too. If the plan, the brief or the person\'s earlier messages give the answer, ' +
        'send it with `talyn_send_session_message`: repeat each question with its answer. ' +
        'If they do not, ask the person with `talyn_ask_user`, then send their answer to the session. ' +
        'Other sessions of this thread may have changed too: see them all with `talyn_list_thread_sessions`.',
    ].join('\n');
  }
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
 * Tell a session's thread and parent that the session changed. Best effort: a failure is
 * logged and never fails the caller's turn or link. `wake: false` writes only
 * the card, for a change that a later wake reports anyway.
 */
export async function notifyThread(
  child: WorkbenchRow,
  action: ThreadSessionAction,
  opts: { wake?: boolean; status?: string; chatId?: string; turn?: number } = {},
): Promise<void> {
  if (isThread(child)) return;
  const parents = new Set([child.threadId, child.parentWorkbenchId]);
  for (const parentId of parents) {
    if (parentId && parentId !== child.id) await notifySessionParent(child, parentId, action, opts);
  }
}

async function notifySessionParent(
  child: WorkbenchRow,
  parentId: string,
  action: ThreadSessionAction,
  opts: { wake?: boolean; status?: string; chatId?: string; turn?: number },
): Promise<void> {
  try {
    const thread = await getWorkbench(parentId);
    if (!thread || thread.archivedAt) return;
    const normalParent = !isThread(thread);
    if (normalParent && !(await workspaceHasFeature('sessionSubagents', thread.workspaceId)).enabled) return;
    const chat = activeChat(await listChats(thread.id));
    if (!chat) return;
    const prUrl = await prUrlOf(child.pullRequestId);
    const childChats = await listChats(child.id);
    const question = action === 'needs_input' ? await pendingQuestion(child.id, opts.chatId) : null;
    const event: ThreadSessionEvent = {
      action,
      sessionId: child.id,
      name: child.title || child.name,
      repo: child.repoFullName,
      status: opts.status ?? activeChat(childChats)?.status ?? 'idle',
      ...(prUrl ? { prUrl } : {}),
      ...(question ? { question: questionSummary(question).slice(0, 300) } : {}),
    };
    const candidate = opts.wake !== false && WAKES.has(action) &&
      (!normalParent || (child.notifyParent && (action === 'session_finished' || action === 'needs_input')));
    const coalesced = chat.queuedMessages.some((m) => m.origin === 'talyn');
    const wakeState = candidate && !coalesced ? await threadAutoWakeState(thread.id) : null;
    const fingerprint = wakeState ? await childFingerprint(thread.id, !normalParent) : null;
    const noProgress = wakeState?.fingerprint === fingerprint && !wakeState?.userSinceWake;
    let willWake = candidate && !coalesced && !noProgress;
    if (willWake && normalParent) {
      const childChat = childChats.find((c) => c.id === opts.chatId) ?? activeChat(childChats);
      if (!childChat) return;
      const key = childChat.id;
      const turn = opts.turn ?? childChat.turnCount;
      const [claimed] = await getPoolDbClient().update(workbenches).set({
        settings: sql`jsonb_set(COALESCE(${workbenches.settings}, '{}'::jsonb), '{parentWakeTurns}',
          COALESCE(${workbenches.settings} -> 'parentWakeTurns', '{}'::jsonb) || jsonb_build_object(${key}::text, ${turn}::int))`,
      }).where(and(eq(workbenches.id, child.id),
        sql`COALESCE((${workbenches.settings} -> 'parentWakeTurns' ->> ${key})::int, -1) < ${turn}`,
      )).returning({ id: workbenches.id });
      willWake = Boolean(claimed);
    }
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
    await sendMessage(chat.id, { text: threadWakeText(event, question).replace('Other sessions of this thread', normalParent ? 'Other child sessions' : 'Other sessions of this thread') }, { origin: 'talyn' });
  } catch (err) {
    console.warn(`[thread] telling the thread of session ${child.id} about ${action} failed:`, err);
  }
}

/** A pull request linked outside the end of a turn. Wakes the thread only when no turn of the session runs. */
export async function notifyThreadOfLinkedPr(child: WorkbenchRow): Promise<void> {
  if (!child.threadId && !child.parentWorkbenchId) return;
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
        eq(workbenches.pullRequestId, pullRequestId), or(isNotNull(workbenches.threadId), isNotNull(workbenches.parentWorkbenchId)),
        eq(prTable.state, 'merged'), ownsLinkedPr(), linkedBeforeMerge(),
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
    if (!(await workspaceHasFeature('sessionSubagents', parent.workspaceId)).enabled) return;
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
