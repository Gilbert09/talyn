import {
  CODE_REVIEW_SEVERITY_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewFindingLocation,
  isCodeReviewSeverity,
  type CodeReviewSeverity,
} from '@talyn/shared';

/**
 * Turning findings into one GitHub pull request review.
 *
 * Everything here is pure: text and line arithmetic, no database and no
 * network. `postToPr.ts` does the reading, the posting and the marking.
 *
 * The inline check is the part that matters most. GitHub answers 422 for the
 * WHOLE review when one comment points at a line outside the diff, so a finding
 * goes inline only when its lines are proven to be in the diff.
 */

/** GitHub's limit for a review body and for a comment body. */
export const GITHUB_BODY_LIMIT = 65536;

/** What a post needs to know about one finding. */
export interface PostableFinding {
  id: string;
  severity: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  anchorVerified: boolean;
  title: string;
  body: string;
  suggestion: string | null;
}

export interface LineRange {
  start: number;
  end: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines of the NEW file that a comment may point at, one range per hunk.
 *
 * A hunk's added and context lines are consecutive on the right side, so one
 * range describes a hunk. A hunk with deletions only has no right-side line and
 * gives no range. No patch (a binary file, or one too large for GitHub to
 * diff) gives nothing.
 *
 * The lines are counted from the patch text. The header's own count is not
 * trusted, because a comment on a line the patch does not show is a 422.
 */
export function commentableRightLines(patch: string | null | undefined): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  let next = 0;
  let current: LineRange | null = null;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      next = Number(header[1]);
      current = null;
      continue;
    }
    // Text before the first hunk header is not part of any hunk.
    if (next === 0) continue;
    const marker = line[0];
    // '-' is the old file. '\' is "\ No newline at end of file". Neither is a
    // line of the new file.
    if (marker !== '+' && marker !== ' ') continue;
    if (current) current.end = next;
    else {
      current = { start: next, end: next };
      ranges.push(current);
    }
    next += 1;
  }
  return ranges;
}

export type FindingPlacement =
  | { kind: 'inline'; path: string; line: number; startLine?: number }
  | { kind: 'summary' };

/**
 * Where one finding goes: an inline comment, or the review body.
 *
 * Inline needs a verified anchor, a file, a start line, and lines that are in
 * the diff. A range must sit inside one hunk. A range that does not becomes a
 * single-line comment on its last line when that line is in the diff.
 */
export function placeFinding(
  finding: PostableFinding,
  rangesByPath: ReadonlyMap<string, LineRange[]>
): FindingPlacement {
  if (!finding.anchorVerified || !finding.filePath || !finding.lineStart) {
    return { kind: 'summary' };
  }
  const ranges = rangesByPath.get(finding.filePath);
  if (!ranges?.length) return { kind: 'summary' };

  const first = finding.lineStart;
  const line = finding.lineEnd ?? finding.lineStart;
  const lo = Math.min(first, line);
  const hi = Math.max(first, line);
  if (ranges.some((r) => r.start <= lo && hi <= r.end)) {
    return lo === hi
      ? { kind: 'inline', path: finding.filePath, line: hi }
      : { kind: 'inline', path: finding.filePath, line: hi, startLine: lo };
  }
  if (ranges.some((r) => r.start <= line && line <= r.end)) {
    return { kind: 'inline', path: finding.filePath, line };
  }
  return { kind: 'summary' };
}

function severityLabel(severity: string): string {
  return isCodeReviewSeverity(severity) ? CODE_REVIEW_SEVERITY_LABELS[severity] : severity;
}

function severityIndex(severity: string): number {
  const index = CODE_REVIEW_SEVERITY_ORDER.indexOf(severity as CodeReviewSeverity);
  return index === -1 ? CODE_REVIEW_SEVERITY_ORDER.length : index;
}

/** Most serious first, then by file, then by line. */
export function sortFindingsForPost<T extends PostableFinding>(findings: readonly T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      severityIndex(a.severity) - severityIndex(b.severity) ||
      a.filePath.localeCompare(b.filePath) ||
      (a.lineStart ?? Number.MAX_SAFE_INTEGER) - (b.lineStart ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title)
  );
}

/**
 * The explanation and the suggested fix, shared by both kinds of comment.
 *
 * The suggestion is never put in a GitHub `suggestion` fence. Applying one
 * replaces the commented lines with the text exactly as written, and the
 * agent's text is not guaranteed to be an exact replacement.
 */
function findingDetail(finding: PostableFinding): string {
  const parts: string[] = [];
  const body = finding.body.trim();
  if (body) parts.push(body);
  const suggestion = finding.suggestion?.trim();
  if (suggestion) parts.push(`**Suggested fix**\n\n${suggestion}`);
  return parts.join('\n\n');
}

/** The body of one inline comment. */
export function inlineCommentBody(finding: PostableFinding): string {
  const heading = `**${severityLabel(finding.severity)}: ${finding.title}**`;
  const detail = findingDetail(finding);
  return detail ? `${heading}\n\n${detail}` : heading;
}

/** One finding as an entry in the review body. */
export function summaryEntry(finding: PostableFinding): string {
  const location = finding.filePath
    ? ` (\`${codeReviewFindingLocation(finding)}\`)`
    : '';
  const heading = `**${severityLabel(finding.severity)}: ${finding.title}**${location}`;
  const detail = findingDetail(finding);
  return detail ? `${heading}\n\n${detail}` : heading;
}

function plural(count: number): string {
  return `${count} finding${count === 1 ? '' : 's'}`;
}

function renderReviewBody(
  shaShort: string,
  inlineCount: number,
  entries: readonly string[],
  leftOut: number
): string {
  const total = inlineCount + entries.length;
  const split =
    inlineCount && entries.length
      ? `${plural(total)}: ${inlineCount} as inline comment${inlineCount === 1 ? '' : 's'}, ${entries.length} below.`
      : inlineCount
        ? `${plural(total)}, as inline comment${inlineCount === 1 ? '' : 's'}.`
        : `${plural(total)}.`;
  const parts = [`Findings from a Talyn code review of ${shaShort}.`, split];
  if (entries.length) {
    parts.push('### Findings without an inline comment', ...entries);
  }
  if (leftOut) {
    parts.push(
      `${plural(leftOut)} did not fit in this comment and ${leftOut === 1 ? 'is' : 'are'} not shown here. You can read ${leftOut === 1 ? 'it' : 'them'} in Talyn.`
    );
  }
  return parts.join('\n\n');
}

export interface ReviewBody<T extends PostableFinding> {
  body: string;
  /** The summary findings the body carries, in the order it shows them. */
  included: T[];
  /** The summary findings that did not fit. They are not on the pull request. */
  leftOut: T[];
}

/**
 * The body of the review: one opening line, a count, then the findings that
 * have no inline comment.
 *
 * GitHub refuses a body over `limit`. A finding is kept whole or left out
 * whole, never cut. The body says how many were left out, and the caller must
 * not mark those as posted.
 */
export function buildReviewBody<T extends PostableFinding>(input: {
  shaShort: string;
  inlineCount: number;
  summaryFindings: readonly T[];
  limit?: number;
}): ReviewBody<T> {
  const limit = input.limit ?? GITHUB_BODY_LIMIT;
  const ordered = sortFindingsForPost(input.summaryFindings);
  const entries = ordered.map(summaryEntry);
  // Drop from the end, so the most serious findings are the ones that stay.
  for (let keep = entries.length; keep >= 0; keep -= 1) {
    const body = renderReviewBody(
      input.shaShort,
      input.inlineCount,
      entries.slice(0, keep),
      entries.length - keep
    );
    if (body.length <= limit || keep === 0) {
      return { body, included: ordered.slice(0, keep), leftOut: ordered.slice(keep) };
    }
  }
  // Unreachable: the loop returns at `keep === 0`.
  return { body: '', included: [], leftOut: ordered };
}
