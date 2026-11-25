// Code review report-back: the confirmed findings of a finished cycle go to
// the live session that owns the pull request, as one message. The session's
// agent then fixes or dismisses each finding, and auto-fix stands down.
//
// Gated by the `codeReviewSessionReportBack` flag. With the flag off, or when
// the session cannot take a message (local, in error, archived), nothing is
// sent and the caller keeps the earlier behaviour.

import { CODE_REVIEW_DISMISS_REASONS, codeReviewFindingSummary, type CodeReviewPhase } from '@talyn/shared';
import { workspaceHasFeature } from '../featureFlags.js';
import { deliverToSession } from '../mergeQueue/sessionFix.js';
import { liveSessionActivityForPr, type PrSessionActivity } from '../workbenches/prSessions.js';
import { confirmedOpenFindings, type ConfirmedFindingRow } from './findings.js';
import {
  appendReviewEvent,
  appendReviewEventOnce,
  getPrForReview,
  getReview,
  type ReviewRow,
} from './store.js';
import { appendCodeReviewCard, finishedCodeReviewCard } from './transcriptCards.js';

/** The event that records the report of one cycle. Its `detail.cycle` is the idempotency key. */
export const SESSION_REPORT_SENT = 'session_report_sent';
export const SESSION_REPORT_FAILED = 'session_report_failed';

/** The most findings the message lists. The rest are one tool call away. */
export const SESSION_REPORT_MAX_LISTED = 20;
const SUMMARY_MAX_CHARS = 200;

export type SessionReportOutcome =
  | { kind: 'sent'; workbenchId: string; chatId: string; findings: number }
  | { kind: 'already_sent' }
  | {
      kind: 'skipped';
      reason: 'flag_off' | 'not_ready' | 'no_session' | 'no_findings' | Exclude<PrSessionActivity, 'idle' | 'working'>;
    }
  | { kind: 'failed'; error: string };

/** True when the findings are with the session, so auto-fix must not run. */
export function findingsWentToSession(outcome: SessionReportOutcome): boolean {
  return outcome.kind === 'sent' || outcome.kind === 'already_sent';
}

/** One line of prose from a finding body: whitespace collapsed, first sentence, capped. */
export function findingSummary(body: string): string {
  return codeReviewFindingSummary(body, SUMMARY_MAX_CHARS);
}

function findingLocation(f: ConfirmedFindingRow): string {
  if (!f.filePath) return 'no file';
  if (f.lineStart === null) return f.filePath;
  const lines = f.lineEnd !== null && f.lineEnd !== f.lineStart ? `${f.lineStart}-${f.lineEnd}` : `${f.lineStart}`;
  return `${f.filePath}:${lines}`;
}

/** The message the session gets. */
export function sessionReportMessage(input: {
  reviewId: string;
  pullRequestId: string;
  prRef: string;
  headSha: string | null;
  findings: ConfirmedFindingRow[];
}): string {
  const { findings } = input;
  const listed = findings.slice(0, SESSION_REPORT_MAX_LISTED);
  const head = input.headSha ? ` at ${input.headSha.slice(0, 12)}` : '';
  const lines = [
    `[Talyn] The code review of ${input.prRef}${head} finished with ${findings.length} confirmed ${findings.length === 1 ? 'finding' : 'findings'}.`,
    `Review: ${input.reviewId}. Pull request id for the Talyn tools: ${input.pullRequestId}.`,
    '',
    ...listed.flatMap((f) => [
      `- ${f.id} [${f.severity}] ${findingLocation(f)}${f.anchorVerified ? '' : ' (location not verified)'}: ${f.title}`,
      ...(f.body.trim() ? [`  ${findingSummary(f.body)}`] : []),
    ]),
    ...(findings.length > listed.length
      ? [`- ${findings.length - listed.length} more. Get them with talyn_get_code_review.`]
      : []),
    '',
    'Check each finding against the code. For the full body and suggestion, call talyn_get_code_review_finding with the pull request id and the finding id.',
    '- If a finding is valid, fix it on this branch. Then push.',
    `- If a finding is not valid, dismiss it with talyn_dismiss_code_review_finding and a reason (${CODE_REVIEW_DISMISS_REASONS.join(', ')}).`,
    'Then report what you fixed and what you dismissed.',
  ];
  return lines.join('\n');
}

/**
 * Send the confirmed findings of the cycle that just finished to the live
 * session on the pull request. Never throws: the cycle has finished, and a
 * report that could not go must not fail the review.
 */
export async function reportFindingsToSession(review: ReviewRow): Promise<SessionReportOutcome> {
  try {
    if (!(await workspaceHasFeature('codeReviewSessionReportBack', review.workspaceId)).enabled) {
      return { kind: 'skipped', reason: 'flag_off' };
    }
    // Re-read: `finishCycle` has just moved the row. Only a `ready` review of
    // this same cycle reports; anything else means a new commit, a cancel or a
    // fix moved it, and the next cycle reports instead.
    const fresh = await getReview(review.id);
    if (!fresh || fresh.phase !== 'ready' || fresh.cycle !== review.cycle) {
      return { kind: 'skipped', reason: 'not_ready' };
    }

    const session = await liveSessionActivityForPr(fresh.workspaceId, fresh.pullRequestId);
    if (!session) return { kind: 'skipped', reason: 'no_session' };
    // Idle (also asleep): the message wakes it. Working: the message queues
    // behind the running turn. Local and unavailable sessions cannot take a
    // message, so the caller keeps the earlier behaviour.
    if (session.activity === 'local' || session.activity === 'unavailable') {
      return { kind: 'skipped', reason: session.activity };
    }

    const findings = await confirmedOpenFindings(fresh.id);
    // A clean review sends nothing: no other path posts a "review clean" note,
    // and a turn that has nothing to do only costs box time.
    if (!findings.length) return { kind: 'skipped', reason: 'no_findings' };

    const pr = await getPrForReview(fresh.pullRequestId);
    const prRef = pr ? `${pr.owner}/${pr.repo}#${pr.number}` : 'the pull request';
    // Record, then send (as wake-ups do). A crash between the two loses the
    // message; the other order could send it twice.
    const claimed = await appendReviewEventOnce(fresh.id, fresh.cycle, {
      fromPhase: fresh.phase as CodeReviewPhase,
      toPhase: fresh.phase as CodeReviewPhase,
      trigger: 'executor',
      code: SESSION_REPORT_SENT,
      message: `Sent ${findings.length} confirmed ${findings.length === 1 ? 'finding' : 'findings'} to the session "${session.name}".`,
      detail: {
        workbenchId: session.id,
        activity: session.activity,
        findingIds: findings.map((f) => f.id),
      },
    });
    if (!claimed) return { kind: 'already_sent' };

    const headSha = fresh.reviewedHeadSha ?? fresh.targetHeadSha;
    try {
      const chatId = await deliverToSession(
        session.id,
        sessionReportMessage({ reviewId: fresh.id, pullRequestId: fresh.pullRequestId, prRef, headSha, findings }),
        {
          trigger: { kind: 'code_review', reviewId: fresh.id, findingCount: findings.length },
          // The finished card goes into the same chat, before the message.
          beforeSend: (chat) =>
            appendCodeReviewCard(fresh, finishedCodeReviewCard(findings, headSha, true), {
              workbenchId: session.id,
              name: session.name,
              chat,
            }),
        }
      );
      return { kind: 'sent', workbenchId: session.id, chatId, findings: findings.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      try {
        await appendReviewEvent(fresh.id, {
          toPhase: fresh.phase as CodeReviewPhase,
          trigger: 'executor',
          code: SESSION_REPORT_FAILED,
          message: `Talyn could not send the findings to the session "${session.name}": ${error}`,
          detail: { workbenchId: session.id, cycle: fresh.cycle },
        });
      } catch (eventErr) {
        console.warn(`[code-review] recording the failed session report for ${fresh.id} failed:`, eventErr);
      }
      return { kind: 'failed', error };
    }
  } catch (err) {
    console.warn(`[code-review] session report for ${review.id} failed:`, err);
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
