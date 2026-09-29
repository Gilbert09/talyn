// What a PR's checks SAY, derived in one place.
//
// Before this module there were three answers to "is this PR's CI failing, and
// does that failure block the merge": the backend's full-fetch verdict, the
// webhook path's `reconcileBlockingReason`, and each front end's pill, which
// inferred required-ness from the verdict it was handed. They disagreed exactly
// where it mattered — PostHog/posthog reports `BLOCKED` on every PR, the pill
// read a held `'blocked'` verdict as "every failure is non-required", and a red
// required `Semgrep Checks Pass` drew as a green "2 non-required".
//
// Now the backend derives {@link CiVerdict} from per-check facts (the full
// GraphQL fetch and the webhook ledger feed the same function), persists
// `ciStatus` + `humanGates` on the summary, and the front ends render them.
// Nobody downstream re-derives required-ness.

/** One check's state, as both the GraphQL rollup and the webhook ledger hold it. */
export type CheckFactState = 'success' | 'failure' | 'pending' | 'in_progress' | 'skipped';

/** One check on the head commit — a check run or a legacy commit status. */
export interface CheckFact {
  name: string;
  state: CheckFactState;
  /**
   * Whether GitHub marks the check required for this PR. `null` means we do
   * not know (a webhook ledger row no full fetch has described yet, or the
   * by-branch fetch path, which cannot ask).
   */
  required: boolean | null;
  /**
   * GitHub's own verdict before normalisation — `FAILURE`, `ERROR`,
   * `TIMED_OUT`, … Needed to tell a Visual Review that found CHANGES (a person
   * must approve them) from one that crashed (it is CI's problem, not a
   * person's). Absent on rows written before it was recorded.
   */
  rawState?: string | null;
  url?: string | null;
}

/**
 * The CI picture on its own, apart from reviews, conflicts and mergeability.
 * This is what the PR list's status pill draws when approval has its own
 * column; `blockingReason` remains the whole-PR merge verdict.
 */
export type PRCiStatus =
  /** No checks reported on the head. */
  | 'none'
  | 'passing'
  | 'running'
  /** Only checks GitHub does not require are failing. */
  | 'failing_optional'
  /** A required check is failing — or a failing check whose required-ness we
   *  do not know, which is read as required rather than guessed green. */
  | 'failing_required'
  /** The only blocking failures are gates a PERSON has to clear. */
  | 'needs_human';

/** A failing gate only a person can clear, as the summary carries it. */
export interface PRHumanGate {
  /** The {@link HumanGateDefinition.id} that matched. */
  id: string;
  /** Short name for the gate, e.g. "Visual review". */
  label: string;
  /** The check / status context that is failing. */
  name: string;
  /** Where the person goes to clear it. */
  url: string | null;
}

/**
 * A check that fails until a person acts on it, and that no agent run can
 * turn green. The first — and so far only — entry is PostHog Visual Review.
 */
export interface HumanGateDefinition {
  id: string;
  label: string;
  /** Does this check / status context belong to the gate? */
  matches: (name: string) => boolean;
  /** Is this failing reading one a PERSON has to clear (vs a crash)? */
  isHumanFailure: (fact: CheckFact) => boolean;
  /**
   * Other checks that fail BECAUSE the gate is failing. PostHog's
   * `Visual regression tests pass` is the REQUIRED check, and it goes red on
   * exactly the reading the (non-required) Visual Review status reports. While
   * the gate is failing these are attributed to it, not counted as agent work.
   */
  consequences: readonly string[];
}

/**
 * PostHog Visual Review posts a commit status per run type
 * (`PostHog Visual Review / storybook`, `/ playwright`, …) with state
 * `failure` while changed snapshots await approval ("Visual changes detected:
 * 2 changed") and while approved changes await their commit. `error` is the
 * run itself failing, which is CI's problem. ` (tracking)` / ` (partial)`
 * variants do not gate. Verified on PostHog/posthog#108150 and #108183.
 */
const POSTHOG_VISUAL_REVIEW: HumanGateDefinition = {
  id: 'posthog_visual_review',
  label: 'Visual review',
  matches: (name) =>
    name.startsWith('PostHog Visual Review / ') && !/\((tracking|partial)\)\s*$/i.test(name),
  isHumanFailure: (fact) =>
    fact.state === 'failure' && (fact.rawState == null || fact.rawState.toUpperCase() === 'FAILURE'),
  consequences: ['Visual regression tests pass', 'Complete Visual Review run'],
};

export const HUMAN_GATES: readonly HumanGateDefinition[] = [POSTHOG_VISUAL_REVIEW];

export interface CiVerdict {
  ciStatus: PRCiStatus;
  /** Failing checks that block the merge and that no human gate explains. */
  blockingFailing: number;
  /** Of {@link blockingFailing}, how many we only ASSUMED block (required unknown). */
  unknownFailing: number;
  /** Failing checks GitHub does not require (gate-attributed ones excluded). */
  optionalFailing: number;
  humanGates: PRHumanGate[];
}

/**
 * Which failing checks are a human gate, and which other failures that gate
 * explains. Exported for the detail sheet's per-check list.
 */
export function humanGatesIn(facts: readonly CheckFact[]): {
  gates: PRHumanGate[];
  attributed: Set<string>;
} {
  const gates: PRHumanGate[] = [];
  const attributed = new Set<string>();
  for (const fact of facts) {
    for (const gate of HUMAN_GATES) {
      if (!gate.matches(fact.name) || !gate.isHumanFailure(fact)) continue;
      gates.push({ id: gate.id, label: gate.label, name: fact.name, url: fact.url ?? null });
      attributed.add(fact.name);
      for (const consequence of gate.consequences) attributed.add(consequence);
    }
  }
  return { gates, attributed };
}

/**
 * Derive the CI verdict from per-check facts.
 *
 * Required-ness is taken per check. A failing check whose required-ness is
 * unknown counts as BLOCKING, with one exception GitHub itself vouches for:
 * `MERGEABLE` + `UNSTABLE` is GitHub saying "this can merge, some non-required
 * checks are not passing", so the unknowns are optional there. Everywhere else
 * the wrong guess must be red, never green.
 */
export function deriveCiVerdict(
  facts: readonly CheckFact[],
  pr: { mergeable?: string | null; mergeStateStatus?: string | null } = {},
): CiVerdict {
  const unstable =
    pr.mergeable === 'MERGEABLE' && (pr.mergeStateStatus ?? '').toUpperCase() === 'UNSTABLE';
  const { gates, attributed } = humanGatesIn(facts);
  let blockingFailing = 0;
  let unknownFailing = 0;
  let optionalFailing = 0;
  let running = 0;
  for (const fact of facts) {
    if (fact.state === 'pending' || fact.state === 'in_progress') {
      running++;
      continue;
    }
    if (fact.state !== 'failure' || attributed.has(fact.name)) continue;
    if (fact.required === true) blockingFailing++;
    else if (fact.required === false || unstable) optionalFailing++;
    else {
      blockingFailing++;
      unknownFailing++;
    }
  }

  let ciStatus: PRCiStatus;
  if (facts.length === 0) ciStatus = 'none';
  else if (blockingFailing > 0) ciStatus = 'failing_required';
  else if (gates.length > 0) ciStatus = 'needs_human';
  else if (running > 0) ciStatus = 'running';
  else if (optionalFailing > 0) ciStatus = 'failing_optional';
  else ciStatus = 'passing';

  return { ciStatus, blockingFailing, unknownFailing, optionalFailing, humanGates: gates };
}
