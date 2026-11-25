// Code review cards in the session transcript. When a cycle starts, finishes
// or fails, Talyn appends one `talyn_code_review` event to the newest open chat
// of the live cloud session that owns the pull request.
//
// Gated by the `codeReviewTranscriptCards` flag. A card is a side note: it
// never throws, and it never fails or holds back a review.
//
// Exactly once per (review, cycle, action): the card first claims a review
// event with `appendReviewEventOnce`, then writes. A crash between the two
// loses the card; the other order could write it twice.

import {
  CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS,
  codeReviewFindingSummary,
  codeReviewTranscriptEvent,
  isCodeReviewSeverity,
  type CodeReviewPhase,
  type CodeReviewTranscriptAction,
  type CodeReviewTranscriptEvent,
  type CodeReviewTranscriptFinding,
} from '@talyn/shared';
import { workspaceHasFeature } from '../featureFlags.js';
import { emitWorkbenchEvents } from '../workbenches/emit.js';
import { liveSessionActivityForPr } from '../workbenches/prSessions.js';
import { appendEvents, latestChat, type ChatRow } from '../workbenches/store.js';
import { confirmedOpenFindings, type ConfirmedFindingRow } from './findings.js';
import { appendReviewEventOnce, getPrForReview, type ReviewRow } from './store.js';

/** The review event that claims each card. Its `detail.cycle` is the idempotency key. */
export const TRANSCRIPT_CARD_CODES: Record<CodeReviewTranscriptAction, string> = {
  started: 'transcript_card_started',
  finished: 'transcript_card_finished',
  failed: 'transcript_card_failed',
};

const PHASE_AFTER: Record<CodeReviewTranscriptAction, CodeReviewPhase> = {
  started: 'reviewing',
  finished: 'ready',
  failed: 'failed',
};

type WithoutReviewFields<T> = T extends unknown ? Omit<T, 'reviewId' | 'pullRequestId' | 'prNumber' | 'cycle'> : never;

/** A card's own fields. The review fields come from the review row. */
export type CodeReviewCard = WithoutReviewFields<CodeReviewTranscriptEvent>;

export type CardReview = Pick<ReviewRow, 'id' | 'workspaceId' | 'pullRequestId' | 'cycle'>;

/** A chat that the caller already holds, e.g. the chat a report message goes to. */
export interface CardTarget {
  workbenchId: string;
  name: string;
  chat: ChatRow;
}

/** The snapshot of confirmed findings that a finished card holds. Rows with an unknown severity are left out. */
export function codeReviewCardFindings(rows: readonly ConfirmedFindingRow[]): CodeReviewTranscriptFinding[] {
  return rows
    .filter((f) => isCodeReviewSeverity(f.severity))
    .slice(0, CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS)
    .map((f) => ({
      id: f.id,
      severity: f.severity as CodeReviewTranscriptFinding['severity'],
      title: f.title,
      summary: codeReviewFindingSummary(f.body),
      filePath: f.filePath || null,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
    }));
}

export function finishedCodeReviewCard(
  rows: readonly ConfirmedFindingRow[],
  headSha: string | null,
  sentToAgent: boolean
): CodeReviewCard {
  return {
    action: 'finished',
    headSha: headSha || null,
    findingCount: rows.length,
    findings: codeReviewCardFindings(rows),
    sentToAgent,
  };
}

async function findTarget(review: CardReview): Promise<CardTarget | null> {
  const session = await liveSessionActivityForPr(review.workspaceId, review.pullRequestId);
  // A local session keeps its transcript on the desktop.
  if (!session || session.activity === 'local') return null;
  const chat = await latestChat(session.id);
  if (!chat || chat.closedAt) return null;
  return { workbenchId: session.id, name: session.name, chat };
}

/**
 * Append the card to the session that owns the review's pull request. True
 * when this call wrote it. With `target`, the card goes to that chat.
 */
export async function appendCodeReviewCard(
  review: CardReview,
  card: CodeReviewCard,
  target?: CardTarget
): Promise<boolean> {
  try {
    if (!(await workspaceHasFeature('codeReviewTranscriptCards', review.workspaceId)).enabled) return false;
    const to = target ?? (await findTarget(review));
    if (!to) return false;

    const pr = await getPrForReview(review.pullRequestId);
    const phase = PHASE_AFTER[card.action];
    const claimed = await appendReviewEventOnce(review.id, review.cycle, {
      fromPhase: phase,
      toPhase: phase,
      trigger: 'executor',
      code: TRANSCRIPT_CARD_CODES[card.action],
      message: `Added the "${card.action}" card to the session "${to.name}".`,
      detail: { workbenchId: to.workbenchId, chatId: to.chat.id },
    });
    if (!claimed) return false;

    const event = codeReviewTranscriptEvent({
      ...card,
      reviewId: review.id,
      pullRequestId: review.pullRequestId,
      prNumber: pr?.number ?? null,
      cycle: review.cycle,
    } as CodeReviewTranscriptEvent);
    const stored = await appendEvents(to.chat.id, [{ turn: to.chat.turnCount, event }]);
    emitWorkbenchEvents(review.workspaceId, to.chat.id, stored);
    return true;
  } catch (err) {
    console.warn(`[code-review] ${card.action} card for ${review.id} failed:`, err);
    return false;
  }
}

/** The finished card, with the confirmed open findings read now. */
export async function appendFinishedCodeReviewCard(
  review: CardReview,
  headSha: string | null,
  sentToAgent: boolean
): Promise<boolean> {
  try {
    if (!(await workspaceHasFeature('codeReviewTranscriptCards', review.workspaceId)).enabled) return false;
    const rows = await confirmedOpenFindings(review.id);
    return await appendCodeReviewCard(review, finishedCodeReviewCard(rows, headSha, sentToAgent));
  } catch (err) {
    console.warn(`[code-review] finished card for ${review.id} failed:`, err);
    return false;
  }
}
