import type { PRCheckContext } from './api';

/**
 * Pure helpers for the checks list in the workbench Pull request tab: the
 * order checks are listed in, and the one line "Add to chat" puts in the
 * composer.
 */

export type CheckRequirement = 'required' | 'optional' | 'unknown';

export function checkRequirement(check: Pick<PRCheckContext, 'required'>): CheckRequirement {
  if (check.required === true) return 'required';
  if (check.required === false) return 'optional';
  return 'unknown';
}

const STATE_RANK: Record<PRCheckContext['state'], number> = {
  failure: 0,
  in_progress: 1,
  pending: 2,
  success: 3,
  skipped: 4,
};

const REQUIREMENT_RANK: Record<CheckRequirement, number> = { required: 0, unknown: 1, optional: 2 };

/** Failing first, required before optional inside each state, then by name. */
export function orderChecks(checks: PRCheckContext[]): PRCheckContext[] {
  return checks
    .slice()
    .sort(
      (a, b) =>
        (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) ||
        REQUIREMENT_RANK[checkRequirement(a)] - REQUIREMENT_RANK[checkRequirement(b)] ||
        a.name.localeCompare(b.name)
    );
}

const STATE_PHRASE: Record<PRCheckContext['state'], string> = {
  failure: 'is failing',
  in_progress: 'is running',
  pending: 'is pending',
  success: 'passed',
  skipped: 'was skipped',
};

/** One line for the composer: what the check is, how it stands, and its link. */
export function checkChatLine(check: PRCheckContext, prNumber: number): string {
  const req = checkRequirement(check);
  const tag = req === 'unknown' ? '' : ` (${req})`;
  const link = check.url ? `: ${check.url}` : '';
  return `The CI check \`${check.name}\`${tag} ${STATE_PHRASE[check.state] ?? check.state} on #${prNumber}${link}`;
}

export interface CheckTally {
  failing: number;
  failingRequired: number;
  running: number;
  passed: number;
  skipped: number;
}

export function tallyChecks(checks: PRCheckContext[]): CheckTally {
  const t: CheckTally = { failing: 0, failingRequired: 0, running: 0, passed: 0, skipped: 0 };
  for (const c of checks) {
    if (c.state === 'failure') {
      t.failing += 1;
      if (c.required !== false) t.failingRequired += 1;
    } else if (c.state === 'in_progress' || c.state === 'pending') t.running += 1;
    else if (c.state === 'success') t.passed += 1;
    else t.skipped += 1;
  }
  return t;
}
