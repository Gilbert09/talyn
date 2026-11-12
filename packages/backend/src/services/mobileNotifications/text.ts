import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  notificationText,
  latestEventTurn,
  truncateNotificationText,
  type AgentEvent,
  type MobileNotificationCategory,
  type MobileNotificationDestination,
  type WorkbenchChatStatus,
  type WorkbenchEvent,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { mergeQueueEntries, pullRequests, workbenchChats, workbenchEvents, workbenches } from '../../db/schema.js';
import { genericPushText, type PushText } from './provider.js';

/**
 * The title and body of a mobile push alert, in the words the desktop
 * notification uses (Tom's call, 2026-11-12). The text goes through Expo, FCM
 * and APNs; the data payload stays the opaque one the app navigates by.
 * Every failure falls back to the category's generic text: a send must never
 * fail because a title could not be built.
 */

export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 178;
/** The newest events read for a chat. The summary comes from the end of the latest turn. */
export const PUSH_EVENT_LIMIT = 200;

const QUEUE_HUMAN_CODES = ['agent_needs_human', 'code_review_blocker'];
const QUEUE_CODE_REASON: Record<string, string> = {
  agent_needs_human: 'the agent needs a person to act',
  code_review_blocker: 'the code review found a blocker',
};

function bounded(text: PushText): PushText {
  return {
    title: truncateNotificationText(text.title.trim(), PUSH_TITLE_MAX),
    body: truncateNotificationText(text.body.trim(), PUSH_BODY_MAX),
  };
}

/**
 * Only the parts of an event the summary reads: top-level type, the text and
 * AskUserQuestion blocks of an assistant message, a result's text and errors,
 * and a `talyn_pr` outcome. Tool results and other events come back NULL, so a
 * large tool output never leaves the database.
 */
const summaryEvent = sql<Record<string, unknown> | null>`CASE
  WHEN ${workbenchEvents.event} ->> 'type' = 'assistant' THEN jsonb_build_object(
    'type', 'assistant',
    'parent_tool_use_id', ${workbenchEvents.event} -> 'parent_tool_use_id',
    'message', jsonb_build_object('content', CASE
      WHEN jsonb_typeof(${workbenchEvents.event} -> 'message' -> 'content') = 'array' THEN COALESCE((
        SELECT jsonb_agg(block ORDER BY position)
        FROM jsonb_array_elements(${workbenchEvents.event} -> 'message' -> 'content') WITH ORDINALITY AS blocks(block, position)
        WHERE block ->> 'type' = 'text' OR (block ->> 'type' = 'tool_use' AND block ->> 'name' = 'AskUserQuestion')
      ), '[]'::jsonb)
    END))
  WHEN ${workbenchEvents.event} ->> 'type' = 'result' THEN jsonb_build_object(
    'type', 'result', 'result', ${workbenchEvents.event} -> 'result', 'errors', ${workbenchEvents.event} -> 'errors')
  WHEN ${workbenchEvents.event} ->> 'type' = 'talyn_pr' THEN ${workbenchEvents.event}
END`;

/** The newest events of one chat, newest first, through the primary key. */
export function pushEventsQuery(db: Database, chatId: string) {
  return db.select({ seq: workbenchEvents.seq, turn: workbenchEvents.turn, event: summaryEvent })
    .from(workbenchEvents)
    .where(eq(workbenchEvents.chatId, chatId))
    .orderBy(desc(workbenchEvents.seq))
    .limit(PUSH_EVENT_LIMIT);
}

/** The PR facts an alert names. Reads single keys of `last_summary`, never the blob. */
export function pushPullRequestQuery(db: Database, destination: MobileNotificationDestination) {
  return db.select({
    owner: pullRequests.owner,
    repo: pullRequests.repo,
    number: pullRequests.number,
    reviewRequested: pullRequests.reviewRequested,
    title: sql<string | null>`${pullRequests.lastSummary} ->> 'title'`,
    reviewDecision: sql<string | null>`${pullRequests.lastSummary} ->> 'reviewDecision'`,
    humanGate: sql<string | null>`COALESCE(${pullRequests.lastSummary} -> 'humanGates' -> 0 ->> 'label',
      ${pullRequests.lastSummary} -> 'humanGates' -> 0 ->> 'name')`,
  }).from(pullRequests)
    .where(and(eq(pullRequests.id, destination.entityId), eq(pullRequests.workspaceId, destination.workspaceId)))
    .limit(1);
}

async function latestTurnEvents(db: Database, chatId: string): Promise<WorkbenchEvent[]> {
  const rows = await pushEventsQuery(db, chatId);
  const turn = latestEventTurn(rows);
  return rows
    .filter((row) => row.turn === turn && row.event && typeof row.event === 'object')
    .reverse()
    .map((row) => ({ chatId, seq: row.seq, turn: row.turn, event: { ...row.event, seq: row.seq } as AgentEvent }));
}

async function sessionText(db: Database, category: MobileNotificationCategory,
  destination: MobileNotificationDestination): Promise<PushText | null> {
  const [bench] = await db.select({
    id: workbenches.id, name: workbenches.name, title: workbenches.title,
    status: workbenches.status, statusMessage: workbenches.statusMessage,
  }).from(workbenches).where(and(eq(workbenches.id, destination.entityId),
    eq(workbenches.workspaceId, destination.workspaceId), eq(workbenches.kind, destination.kind))).limit(1);
  if (!bench) return null;
  if (category === 'session_update' && (bench.status === 'error' || bench.status === 'archiveError')) {
    return notificationText({ status: 'error', error: bench.statusMessage?.trim() || null }, bench);
  }
  const statuses: WorkbenchChatStatus[] = category === 'human_gate' ? ['awaiting_input'] : ['idle', 'error'];
  const [chat] = await db.select({ id: workbenchChats.id, status: workbenchChats.status, statusMessage: workbenchChats.statusMessage })
    .from(workbenchChats)
    .where(and(eq(workbenchChats.workbenchId, bench.id), inArray(workbenchChats.status, statuses),
      ...(category === 'human_gate' ? [isNull(workbenchChats.closedAt)] : [])))
    .orderBy(desc(workbenchChats.updatedAt)).limit(1);
  if (!chat) return notificationText({ status: statuses[0] }, bench);
  const status = chat.status as WorkbenchChatStatus;
  const events = await latestTurnEvents(db, chat.id);
  return notificationText({ status, error: status === 'error' ? chat.statusMessage?.trim() || null : null }, bench, events);
}

async function pullRequestText(db: Database, category: MobileNotificationCategory,
  destination: MobileNotificationDestination): Promise<PushText | null> {
  const [pr] = await pushPullRequestQuery(db, destination);
  if (!pr) return null;
  const ref = `${pr.owner}/${pr.repo}#${pr.number}`;
  const prTitle = pr.title?.trim();
  const named = prTitle ? `${ref} ${prTitle}` : ref;
  switch (category) {
    case 'pr_review': {
      const title = pr.reviewRequested ? 'Review requested'
        : pr.reviewDecision === 'APPROVED' ? 'Approved'
          : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review update';
      return { title, body: named };
    }
    case 'ci_failure': return { title: 'Checks failed', body: named };
    case 'merge_ready': return { title: 'Ready to merge', body: named };
    case 'human_gate': {
      const [entry] = await db.select({ code: mergeQueueEntries.blockedCode, reason: mergeQueueEntries.blockedReason })
        .from(mergeQueueEntries)
        .where(and(eq(mergeQueueEntries.pullRequestId, destination.entityId),
          eq(mergeQueueEntries.workspaceId, destination.workspaceId),
          inArray(mergeQueueEntries.status, ['blocked', 'blocked_manual']),
          inArray(mergeQueueEntries.blockedCode, QUEUE_HUMAN_CODES)))
        .orderBy(desc(mergeQueueEntries.enqueuedAt)).limit(1);
      if (entry) {
        const reason = entry.reason?.trim().replace(/[.\s]+$/, '') || QUEUE_CODE_REASON[entry.code ?? ''] || 'it is blocked';
        return { title: 'Merge queue blocked', body: `${ref} can't merge — ${reason}. Needs manual intervention.` };
      }
      const gate = pr.humanGate?.trim();
      return { title: 'A PR needs you', body: gate ? `${ref} needs you — ${gate}` : named };
    }
    default: return null;
  }
}

export async function composeMobilePushText(category: MobileNotificationCategory,
  destination: MobileNotificationDestination, db: Database = getPoolDbClient()): Promise<PushText> {
  try {
    const text = destination.kind === 'pull_request'
      ? await pullRequestText(db, category, destination)
      : await sessionText(db, category, destination);
    return bounded(text ?? genericPushText(category));
  } catch {
    return genericPushText(category);
  }
}
