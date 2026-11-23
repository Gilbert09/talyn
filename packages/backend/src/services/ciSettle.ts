import { deriveCiVerdict, type AwaitCiOutcome, type CheckFact } from '@talyn/shared';

/**
 * What "CI settled" means, shared by a parked fix run (`ciPark.ts`) and a
 * session's CI wake-up (`workbenches/ciWakeups.ts`).
 */

/** Same commit, when one side may be a short sha. */
export function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * What the checks on one commit say, or null while they have not settled.
 * Settled means at least one check and none pending or in progress. A failure
 * with others still running waits: the agent gets one complete answer.
 */
export function settledOutcome(facts: readonly CheckFact[]): AwaitCiOutcome | null {
  if (facts.length === 0) return null;
  if (facts.some((f) => f.state === 'pending' || f.state === 'in_progress')) return null;
  const verdict = deriveCiVerdict(facts);
  if (verdict.ciStatus === 'failing_required' || verdict.ciStatus === 'needs_human') {
    const checks = facts.filter((f) => f.state === 'failure' && f.required !== false).map((f) => f.name);
    return { kind: 'failing', checks: [...new Set(checks)].sort() };
  }
  return { kind: 'passing' };
}
