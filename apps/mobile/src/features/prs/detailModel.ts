import type { PRBlockingReason, PRCheckContext, PRFile, PRReviewDetail, PRReviewThread } from '@talyn/client/native';
import { humanGatesIn } from '@talyn/shared';

export type PrDetailTab = 'overview' | 'checks' | 'files' | 'reviews' | 'findings';

export interface FailingCheck { check: PRCheckContext; optional: boolean; needsHuman: boolean }
export interface CheckGroups { failing: FailingCheck[]; running: PRCheckContext[]; passed: PRCheckContext[]; skipped: PRCheckContext[] }

/**
 * The Checks tab's groups. Mirrors web `ChecksTab`: a failure is optional when
 * GitHub says so, or when the PR is mergeable despite it; human gates sort first.
 */
export function groupChecks(contexts: PRCheckContext[] | undefined, blockingReason?: PRBlockingReason | null): CheckGroups {
  const all = contexts ?? [];
  const failures = all.filter((check) => check.state === 'failure');
  const optionalAll = blockingReason === 'checks_failed_optional' || (failures.length > 0 && failures.every((check) => check.required === false));
  const { attributed } = humanGatesIn(all.map((check) => ({ name: check.name, state: check.state, required: check.required ?? null, url: check.url })));
  const failing = failures.map((check) => ({
    check,
    optional: check.required === false || (check.required == null && optionalAll),
    needsHuman: attributed.has(check.name),
  })).sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman) || Number(a.optional) - Number(b.optional) || a.check.name.localeCompare(b.check.name));
  const byName = (a: PRCheckContext, b: PRCheckContext) => a.name.localeCompare(b.name);
  return {
    failing,
    running: all.filter((check) => check.state === 'in_progress' || check.state === 'pending').sort(byName),
    passed: all.filter((check) => check.state === 'success').sort(byName),
    skipped: all.filter((check) => check.state === 'skipped').sort(byName),
  };
}

/**
 * The Checks tab badge: every failing check, the same number the next-step card states and the tab lists.
 * Optional failures count too; the tab marks them "Not required".
 */
export function failingBadge(groups: CheckGroups, failedCount: number): number {
  return groups.failing.length || failedCount;
}

export type ReviewItem =
  | { kind: 'review'; key: string; at: number; review: PRReviewDetail['reviews'][number] }
  | { kind: 'thread'; key: string; at: number; thread: PRReviewThread }
  | { kind: 'comment'; key: string; at: number; comment: PRReviewDetail['comments'][number] };

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? 0 : at;
};

/** Reviews, threads and comments in one list, oldest first. A bare "commented" review is left out, as on web. */
export function reviewTimeline(detail: PRReviewDetail | undefined): ReviewItem[] {
  if (!detail) return [];
  return [
    ...detail.reviews.filter((review) => review.state !== 'COMMENTED' || review.body.trim())
      .map((review): ReviewItem => ({ kind: 'review', key: `r:${review.id}`, at: time(review.submittedAt), review })),
    ...detail.threads.map((thread): ReviewItem => ({ kind: 'thread', key: `t:${thread.id}`, at: time(thread.comments[0]?.createdAt), thread })),
    ...detail.comments.map((comment): ReviewItem => ({ kind: 'comment', key: `c:${comment.id}`, at: time(comment.createdAt), comment })),
  ].sort((a, b) => a.at - b.at);
}

export const REVIEW_STATE_LABEL: Record<string, string> = {
  APPROVED: 'Approved', CHANGES_REQUESTED: 'Requested changes', COMMENTED: 'Commented', DISMISSED: 'Dismissed',
};

/** The last lines of a diff hunk: the ones a comment is anchored to. */
export function lastHunkLines(hunk: string, max = 6): string {
  const lines = hunk.split('\n');
  return lines.length <= max ? hunk : lines.slice(-max).join('\n');
}

export function fileTotals(files: PRFile[]): { added: number; removed: number } {
  return files.reduce((acc, file) => ({ added: acc.added + file.additions, removed: acc.removed + file.deletions }), { added: 0, removed: 0 });
}

export const FILE_STATUS_LABEL: Record<PRFile['status'], string> = {
  added: 'Added', removed: 'Removed', modified: 'Modified', renamed: 'Renamed', copied: 'Copied', changed: 'Changed', unchanged: 'Unchanged',
};

const DESCRIPTION_LINES = 12;
/** A description long enough to fold. Line count, with a character bound for long paragraphs. */
export function descriptionIsLong(body: string): boolean {
  return body.split('\n').length > DESCRIPTION_LINES || body.length > DESCRIPTION_LINES * 70;
}
