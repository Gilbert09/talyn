import type { CodeReviewFinding, CodeReviewPublic, CodeReviewSeverity } from '@talyn/client/native';
import { CODE_REVIEW_PHASE_AT_REST, CODE_REVIEW_PRESET_PLAN, CODE_REVIEW_SEVERITY_ORDER, codeReviewLensLabel, isCustomReviewerLens,
  severityAtOrAbove, type CodeReviewLensNames } from '@talyn/shared';

import type { StatusTone } from '../../lib/status';

// Pure parts of the code review section. Each one ports a rule from web
// `FindingsTab.tsx`, so the two clients show and act on the same findings.

type Shown = Pick<CodeReviewFinding, 'id' | 'severity' | 'disposition'>;

/** Not at rest: reviewing or fixing. */
export const reviewRunning = (review: Pick<CodeReviewPublic, 'phase'> | null | undefined) => Boolean(review && !CODE_REVIEW_PHASE_AT_REST[review.phase]);

/** Open findings at or above the reporting bar, grouped most serious first. Empty groups are dropped. */
export function groupFindings<T extends Shown>(findings: readonly T[], bar: CodeReviewSeverity): { severity: CodeReviewSeverity; items: T[] }[] {
  const active = findings.filter((finding) => (finding.disposition === 'open' || finding.disposition === 'selected') && severityAtOrAbove(finding.severity, bar));
  return CODE_REVIEW_SEVERITY_ORDER.map((severity) => ({ severity, items: active.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.items.length > 0);
}

/** What "Fix all" acts on: what is shown, less what a fix already owns. */
export const fixableIds = (groups: readonly { items: readonly Shown[] }[]) =>
  groups.flatMap((group) => group.items.filter((finding) => finding.disposition !== 'selected').map((finding) => finding.id));

/** Nitpicks below the bar and dismissed findings: "Also looked at". */
export const bucketFindings = <T extends Shown>(findings: readonly T[], bar: CodeReviewSeverity) => findings.filter((finding) =>
  finding.disposition === 'dismissed' || ((finding.disposition === 'open' || finding.disposition === 'selected') && !severityAtOrAbove(finding.severity, bar)));
export const droppedFindings = <T extends Pick<CodeReviewFinding, 'verdict'>>(findings: readonly T[]) => findings.filter((finding) => finding.verdict === 'rejected');
export const fixedFindings = <T extends Pick<CodeReviewFinding, 'disposition'>>(findings: readonly T[]) => findings.filter((finding) => finding.disposition === 'fixed');

export interface PostState { label: string; ids: string[]; disabledReason: string | null }

/**
 * What "Post to PR" says and posts. Web `postToPrState`: the ticked findings, or
 * every shown finding when none is ticked. A finding already on the PR is never
 * posted again, so the count is the number of comments to expect.
 */
export function postToPrState(input: { running: boolean; shown: readonly Pick<CodeReviewFinding, 'id' | 'postedAt'>[]; ticked: ReadonlySet<string> }): PostState {
  const postable = input.shown.filter((finding) => !finding.postedAt).map((finding) => finding.id);
  const tickedShown = input.shown.filter((finding) => input.ticked.has(finding.id));
  const ids = tickedShown.length ? postable.filter((id) => input.ticked.has(id)) : postable;
  const label = tickedShown.length && ids.length ? `Post ${ids.length} to PR` : 'Post to PR';
  if (input.running) return { label, ids, disabledReason: 'Wait for the review to finish before you post.' };
  if (!ids.length) {
    return { label, ids, disabledReason: tickedShown.length ? 'The findings you ticked are already on the pull request.'
      : 'Every finding shown is already on the pull request.' };
  }
  return { label, ids, disabledReason: null };
}

/** The confirmation before a post. Web's dialog copy. */
export function postConfirmation(count: number, prLabel: string | null) {
  return {
    title: 'Post findings to the pull request?',
    message: `This writes ${count} finding${count === 1 ? '' : 's'} on ${prLabel ?? 'this pull request'} as a review comment from your GitHub account. You cannot undo it from Talyn.`,
  };
}

/** The header line of a review at rest. Web `headline`, without the dash. */
export function reviewHeadline(review: Pick<CodeReviewPublic, 'phase' | 'openCount'>): string {
  if (review.phase === 'failed') return 'The review did not finish';
  if (review.phase === 'cancelled') return 'Review stopped';
  if (review.phase === 'fixed') return 'Fix pushed. Review again to confirm it held';
  if (review.openCount === 0) return 'Nothing to flag';
  return `${review.openCount} finding${review.openCount === 1 ? '' : 's'}`;
}

/** How many of Talyn's own reviewers sat this change out. Web `notNeededCount`. */
export function notNeededCount(review: Pick<CodeReviewPublic, 'lensesRun' | 'preset'>): number {
  const builtIn = review.lensesRun.filter((lens) => !isCustomReviewerLens(lens)).length;
  if (builtIn === 0) return 0;
  return Math.max(0, CODE_REVIEW_PRESET_PLAN[review.preset].lenses - builtIn);
}

/** "Logic and Security agree", or null for one reviewer. Named, not counted, as on web. */
export function agreementLabel(lenses: readonly string[], names?: CodeReviewLensNames): string | null {
  return lenses.length > 1 ? `${lenses.map((lens) => codeReviewLensLabel(lens, names)).join(' and ')} agree` : null;
}

/** The small line under a finding's title. */
export function findingMeta(finding: Pick<CodeReviewFinding, 'filePath' | 'lineStart' | 'carriedOver' | 'verdict' | 'lenses' | 'anchorVerified' | 'postedAt'>,
  options: { stillChecking: boolean; names?: CodeReviewLensNames }): string[] {
  return [
    findingLocation(finding),
    finding.carriedOver ? 'still here' : '',
    options.stillChecking && finding.verdict === 'unvalidated' ? 'not checked yet' : '',
    agreementLabel(finding.lenses, options.names) ?? '',
    finding.anchorVerified ? '' : 'location approximate',
    finding.postedAt ? 'Posted to PR' : '',
  ].filter(Boolean);
}

/** `path/to/file.ts:12`, or "Whole pull request" when the finding names no file. */
export const findingLocation = (finding: Pick<CodeReviewFinding, 'filePath' | 'lineStart'>) =>
  finding.filePath ? `${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''}` : 'Whole pull request';

export const SEVERITY_TONE: Record<CodeReviewSeverity, StatusTone> = { blocker: 'destructive', major: 'warning', minor: 'muted', nit: 'muted' };

/** Shared copy is written for web and may carry dashes. Phone copy has none. */
export const plainCopy = (text: string) => text.replace(/\s+[—–]\s+/g, ': ');
