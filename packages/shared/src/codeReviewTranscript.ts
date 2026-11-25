// Code review cards in a session's transcript. When a review of the session's
// pull request starts, finishes or fails, Talyn appends one `talyn_code_review`
// event to the session's chat. `buildBlocks` turns it into a system block with
// `codeReview` set, and each client draws it as a card.
//
// The event holds a snapshot of the findings at the time the cycle finished.
// A finding that the agent later fixes or dismisses stays in the snapshot; the
// card links to the live findings list for the current state.

import { codeReviewFindingLocation, isCodeReviewSeverity, type CodeReviewSeverity } from './codeReview.js';

export const CODE_REVIEW_TRANSCRIPT_EVENT_TYPE = 'talyn_code_review';

/** The most findings one event holds. The card links to the full list. */
export const CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS = 20;
/** A finding's summary in the card: the first sentence of its body, capped. */
export const CODE_REVIEW_TRANSCRIPT_SUMMARY_MAX_CHARS = 280;

export interface CodeReviewTranscriptFinding {
  id: string;
  severity: CodeReviewSeverity;
  title: string;
  /** The first sentence of the finding's body. Empty when the body is empty. */
  summary: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

interface CodeReviewTranscriptBase {
  reviewId: string;
  /** Talyn's pull request row id. The clients open the findings list with it. */
  pullRequestId: string;
  /** Null when Talyn did not know the number. */
  prNumber: number | null;
  cycle: number;
  /** The commit under review. Null when Talyn did not know it. */
  headSha: string | null;
}

export type CodeReviewTranscriptEvent =
  | (CodeReviewTranscriptBase & {
      action: 'started';
      fileCount: number;
      reviewerCount: number;
    })
  | (CodeReviewTranscriptBase & {
      action: 'finished';
      /** All confirmed open findings. `findings` holds at most `CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS` of them. */
      findingCount: number;
      findings: CodeReviewTranscriptFinding[];
      /** Talyn also sent the findings to this session's agent as a message. */
      sentToAgent: boolean;
    })
  | (CodeReviewTranscriptBase & {
      action: 'failed';
      message: string;
    })
  | (CodeReviewTranscriptBase & {
      /** A person stopped the review (also before a restart). */
      action: 'cancelled';
    });

export type CodeReviewTranscriptAction = CodeReviewTranscriptEvent['action'];

/** The stored transcript event. */
export function codeReviewTranscriptEvent(event: CodeReviewTranscriptEvent): Record<string, unknown> {
  return { type: CODE_REVIEW_TRANSCRIPT_EVENT_TYPE, ...event };
}

/** One line of prose from a finding body: whitespace collapsed, first sentence, capped. */
export function codeReviewFindingSummary(body: string, max = CODE_REVIEW_TRANSCRIPT_SUMMARY_MAX_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** `path`, `path:12` or `path:12-14`. Null when the finding has no file. */
export function codeReviewTranscriptFindingLocation(
  f: Pick<CodeReviewTranscriptFinding, 'filePath' | 'lineStart' | 'lineEnd'>
): string | null {
  if (!f.filePath) return null;
  return codeReviewFindingLocation({ filePath: f.filePath, lineStart: f.lineStart, lineEnd: f.lineEnd });
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

function parseFinding(raw: unknown): CodeReviewTranscriptFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const id = str(f.id);
  if (!id || !isCodeReviewSeverity(f.severity)) return null;
  return {
    id,
    severity: f.severity,
    title: str(f.title) ?? '',
    summary: str(f.summary) ?? '',
    filePath: str(f.filePath) || null,
    lineStart: int(f.lineStart),
    lineEnd: int(f.lineEnd),
  };
}

/** The event, or null when it is not a well-formed code review event. */
export function parseCodeReviewTranscriptEvent(event: Record<string, unknown>): CodeReviewTranscriptEvent | null {
  if (event.type !== CODE_REVIEW_TRANSCRIPT_EVENT_TYPE) return null;
  const reviewId = str(event.reviewId);
  const pullRequestId = str(event.pullRequestId);
  if (!reviewId || !pullRequestId) return null;
  const base: CodeReviewTranscriptBase = {
    reviewId,
    pullRequestId,
    prNumber: int(event.prNumber),
    cycle: int(event.cycle) ?? 0,
    headSha: str(event.headSha) || null,
  };
  switch (event.action) {
    case 'started':
      return {
        ...base,
        action: 'started',
        fileCount: Math.max(0, int(event.fileCount) ?? 0),
        reviewerCount: Math.max(0, int(event.reviewerCount) ?? 0),
      };
    case 'finished': {
      const findings = Array.isArray(event.findings)
        ? event.findings.map(parseFinding).filter((f): f is CodeReviewTranscriptFinding => f !== null)
        : [];
      return {
        ...base,
        action: 'finished',
        findingCount: Math.max(findings.length, int(event.findingCount) ?? 0),
        findings,
        sentToAgent: event.sentToAgent === true,
      };
    }
    case 'failed':
      return { ...base, action: 'failed', message: str(event.message) ?? '' };
    case 'cancelled':
      return { ...base, action: 'cancelled' };
    default:
      return null;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The card's title. */
export function codeReviewTranscriptTitle(event: CodeReviewTranscriptEvent): string {
  switch (event.action) {
    case 'started':
      return 'Code review started';
    case 'finished':
      return event.findingCount === 0
        ? 'Code review finished with no findings'
        : `Code review finished with ${plural(event.findingCount, 'finding', 'findings')}`;
    case 'failed':
      return 'Code review failed';
    case 'cancelled':
      return 'Code review stopped';
  }
}

/** The card's second line: what was reviewed, or why it failed. */
export function codeReviewTranscriptDetail(event: CodeReviewTranscriptEvent): string {
  const at = event.headSha ? ` at ${event.headSha.slice(0, 7)}` : '';
  switch (event.action) {
    case 'started': {
      const parts = [
        event.fileCount > 0 ? plural(event.fileCount, 'changed file', 'changed files') : '',
        event.reviewerCount > 0 ? plural(event.reviewerCount, 'reviewer', 'reviewers') : '',
      ].filter(Boolean);
      return `${parts.length ? parts.join(' · ') : 'Reviewing the pull request'}${at}`;
    }
    case 'finished':
      return event.sentToAgent ? `Reviewed${at}. Talyn sent the findings to the agent.` : `Reviewed${at}.`;
    case 'failed':
      return event.message || 'The review stopped with an error.';
    case 'cancelled':
      return `Stopped before it finished${at}.`;
  }
}

/** One plain-text line for the transcript (search, mobile, admin). */
export function codeReviewTranscriptText(event: CodeReviewTranscriptEvent): string {
  return `${codeReviewTranscriptTitle(event)}. ${codeReviewTranscriptDetail(event)}`;
}

/** The snapshot's findings, most serious first. Stable within one severity. */
export function sortCodeReviewTranscriptFindings(findings: readonly CodeReviewTranscriptFinding[]): CodeReviewTranscriptFinding[] {
  const rank: Record<CodeReviewSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
  return findings.map((f, i) => ({ f, i })).sort((a, b) => rank[a.f.severity] - rank[b.f.severity] || a.i - b.i).map(({ f }) => f);
}

/** How many of the snapshot's findings have each severity. */
export function codeReviewTranscriptCounts(findings: readonly CodeReviewTranscriptFinding[]): Record<CodeReviewSeverity, number> {
  const counts: Record<CodeReviewSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
