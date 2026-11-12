/**
 * Session starters: the suggestions the sidebar shows to somebody with no
 * sessions yet. Most of these people came for the pull request list, so the
 * best pitch for a session is a job on one of their own pull requests. When no
 * pull request needs work, the list falls back to general jobs on a repository.
 *
 * One set of rules, so desktop, web and mobile suggest the same things.
 */

export type SessionStarterKind = 'fix_checks' | 'resolve_conflicts' | 'address_review' | 'review' | 'explain' | 'tests';

/** The parts of a pull request row the starters read. Every front end's row is a superset. */
export interface SessionStarterPr {
  id: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  authored: boolean;
  reviewRequested: boolean;
  summary: {
    title?: string;
    mergeable?: string;
    blockingReason?: string | null;
    unresolvedReviewThreads?: number;
    draft?: boolean;
  };
}

export interface SessionStarter {
  key: string;
  kind: SessionStarterKind;
  /** The short line on the button. */
  label: string;
  /** A second line naming the pull request, when there is one. */
  detail: string | null;
  /** The first message, put in the composer. The person can edit it before they send it. */
  prompt: string;
  /** The pull request the session starts from. Null for a general starter. */
  pr: { id: string; repositoryId: string; owner: string; repo: string; number: number } | null;
}

export const SESSION_STARTER_PROMPTS: Record<SessionStarterKind, string> = {
  fix_checks: 'Find out why the CI checks fail on this pull request. Fix the cause and push the fix.',
  resolve_conflicts: 'Merge the base branch into this pull request. Resolve the conflicts, check that the tests still pass, and push.',
  address_review: 'Read the review comments on this pull request. Make the changes they ask for and push.',
  review: 'Review this pull request. Tell me what it changes, and point out bugs and risks. Do not push any changes.',
  explain: 'Give me a tour of this repository: how it is organised, the main entry points, and how to run the tests.',
  tests: 'Find an important part of this repository that has few tests. Add tests for it and open a pull request.',
};

const LABELS: Record<SessionStarterKind, string> = {
  fix_checks: 'Fix the failing checks',
  resolve_conflicts: 'Resolve the merge conflicts',
  address_review: 'Address the review comments',
  review: 'Get a first review',
  explain: 'Explain a repository',
  tests: 'Add missing tests',
};

/** The job a session can do on this pull request, or null when it needs none. */
export function starterKindForPr(row: SessionStarterPr): SessionStarterKind | null {
  if (row.state !== 'open') return null;
  const s = row.summary;
  if (row.authored) {
    if (s.blockingReason === 'checks_failed') return 'fix_checks';
    if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') return 'resolve_conflicts';
    if (s.blockingReason === 'changes_requested' || (s.unresolvedReviewThreads ?? 0) > 0) return 'address_review';
    return null;
  }
  if (row.reviewRequested && !s.draft) return 'review';
  return null;
}

const PR_KIND_ORDER: SessionStarterKind[] = ['fix_checks', 'resolve_conflicts', 'address_review', 'review'];

/**
 * Up to `limit` starters: at most one per kind, pull request jobs first (in
 * {@link PR_KIND_ORDER}, newest pull request first), then general ones.
 */
export function sessionStarters(rows: readonly SessionStarterPr[], limit = 3): SessionStarter[] {
  const max = Math.max(0, Math.floor(limit));
  const byKind = new Map<SessionStarterKind, SessionStarterPr>();
  for (const row of [...rows].sort((a, b) => b.number - a.number)) {
    const kind = starterKindForPr(row);
    if (kind && !byKind.has(kind)) byKind.set(kind, row);
  }
  const out: SessionStarter[] = [];
  for (const kind of PR_KIND_ORDER) {
    const row = byKind.get(kind);
    if (!row) continue;
    out.push({
      key: `${kind}:${row.id}`,
      kind,
      label: LABELS[kind],
      detail: row.summary.title ? `#${row.number} ${row.summary.title}` : `${row.owner}/${row.repo}#${row.number}`,
      prompt: SESSION_STARTER_PROMPTS[kind],
      pr: { id: row.id, repositoryId: row.repositoryId, owner: row.owner, repo: row.repo, number: row.number },
    });
  }
  for (const kind of ['explain', 'tests'] as const) {
    out.push({ key: kind, kind, label: LABELS[kind], detail: null, prompt: SESSION_STARTER_PROMPTS[kind], pr: null });
  }
  return out.slice(0, max);
}
