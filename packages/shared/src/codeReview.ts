import type { Features } from './featureFlags.js';

/**
 * Code review — the vocabulary both front ends, the routes and the engine share.
 *
 * # Why `CodeReview` and not `Review`
 *
 * `review` is the most overloaded word in this repo and it already means *a
 * human review requested of you*: `reviewRequested`, `reviewDecision`,
 * `reviewPriority`, `reviewRank*`, `PRReviewPill`, the Reviews tab. A
 * `PRReviewStatus` sitting next to `PRReviewDecision` in one import block is a
 * drift trap rather than a naming preference, so everything here is prefixed
 * `CodeReview`.
 *
 * # What lives here and what does not
 *
 * Here: the preset vocabulary, the phases and their labels, the severity order,
 * the public payload shape, the progress arithmetic, the findings parser, and
 * the dedupe key. All pure, all needed by both forks.
 *
 * Not here: the lens identities and their prompts, the chunking algorithm, the
 * mapping from a preset to real model ids. Those are backend-only — lens names
 * are internal vocabulary the user must never see, and shipping prompts to a
 * renderer bundle would be silly.
 */

// ---------- Presets ----------

export type CodeReviewPreset = 'quick' | 'standard' | 'deep';

export const CODE_REVIEW_PRESETS: readonly CodeReviewPreset[] = [
  'quick',
  'standard',
  'deep',
] as const;

export const DEFAULT_CODE_REVIEW_PRESET: CodeReviewPreset = 'standard';

export function isCodeReviewPreset(value: unknown): value is CodeReviewPreset {
  return typeof value === 'string' && (CODE_REVIEW_PRESETS as readonly string[]).includes(value);
}

/**
 * Typed as a full `Record` rather than a lookup with a fallback, so a fourth
 * preset is a compile error at every site that has to describe one. The
 * `QUEUE_STATUS_LABEL` precedent.
 */
export const CODE_REVIEW_PRESET_LABELS: Record<CodeReviewPreset, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

/**
 * What each preset actually does, in the user's words.
 *
 * No internal vocabulary: no "lens", no "sweep", no vendor, no stage name. This
 * copy is what makes "no advanced panel" an acceptable design — a preset the
 * user cannot see inside has to say what it does, or "Deep" is a mystery knob.
 */
export const CODE_REVIEW_PRESET_BLURBS: Record<CodeReviewPreset, string> = {
  quick:
    'A fast pass for the obvious problems. Good for a small change you want a second pair of eyes on before you merge.',
  standard:
    'The everyday review. Looks at the change from several angles, then checks back over the whole thing for anything it missed.',
  deep:
    'For a change you want picked apart. More angles, a final pass looking for what the others missed, and a large pull request is read in pieces rather than skimmed.',
};

/**
 * Roughly how long, from MEASURED runs rather than hope.
 *
 * The first Standard review of an eight-file pull request took 41 minutes end to
 * end — three lenses in parallel (14m), then the sweep (15m), then the judging
 * pass (8m), because those three phases are necessarily serial. This said
 * "around ten minutes" before that was measured, which is the kind of estimate
 * that makes a working feature feel broken.
 */
export const CODE_REVIEW_PRESET_TIME_HINTS: Record<CodeReviewPreset, string> = {
  quick: 'Usually under ten minutes.',
  standard: 'Typically half an hour.',
  deep: 'Can take an hour or more on a large pull request.',
};

/**
 * What a preset actually does, as comparable lines rather than prose.
 *
 * DERIVED from `CODE_REVIEW_PRESET_PLAN` on purpose. A hand-written comparison
 * is a second source of truth about what "Standard" means, and it goes stale the
 * first time the plan changes — which is exactly the failure the plan record
 * exists to prevent. Somebody choosing a depth needs to compare the three
 * without selecting each in turn to read its blurb.
 */
export function codeReviewPresetFacts(preset: CodeReviewPreset): string[] {
  const plan = CODE_REVIEW_PRESET_PLAN[preset];
  const facts = [
    plan.lenses === 1
      ? 'Read once, by a single reviewer'
      : `Read by ${plan.lenses} reviewers at once, each looking for something different`,
  ];
  facts.push(
    plan.sweep
      ? 'A further pass looks for what all of them missed'
      : 'No second pass — what the reviewer finds is what you get'
  );
  facts.push(
    plan.validate
      ? 'Every finding is re-checked against the code before you see it'
      : 'Findings are reported as found, so expect more noise'
  );
  if (plan.chunk) facts.push('A large pull request is read in pieces rather than skimmed');
  if (plan.effort === 'top') facts.push('Uses the strongest model you have connected');
  facts.push(CODE_REVIEW_PRESET_TIME_HINTS[preset]);
  return facts;
}

/**
 * The shape a preset resolves to. One definition, so the settings blurb, the
 * planner and the progress denominator cannot disagree about what "Standard"
 * means.
 *
 * `effort` is NOT a reasoning-effort parameter — the fleet's create body has no
 * such field and the model catalogue has no effort variants. It says which
 * model tier a unit runs at, which the backend maps onto real model ids from
 * whatever the workspace has connected.
 */
export interface CodeReviewPresetPlan {
  /** How many independent lenses read each chunk. */
  readonly lenses: number;
  /** Whether a final pass hunts for what every lens missed. */
  readonly sweep: boolean;
  /** Whether a judging pass decides which candidates survive. */
  readonly validate: boolean;
  /** Whether a large diff is split and read in pieces. */
  readonly chunk: boolean;
  /** 'default' runs the workspace's chosen model; 'top' its strongest. */
  readonly effort: 'default' | 'top';
}

export const CODE_REVIEW_PRESET_PLAN: Record<CodeReviewPreset, CodeReviewPresetPlan> = {
  // One unit, and the reporting bar goes in the lens prompt rather than in a
  // judging pass of its own: at this size a second sandbox costs more than the
  // precision it buys.
  quick: { lenses: 1, sweep: false, validate: false, chunk: false, effort: 'default' },
  standard: { lenses: 3, sweep: true, validate: true, chunk: false, effort: 'default' },
  deep: { lenses: 5, sweep: true, validate: true, chunk: true, effort: 'top' },
};

/**
 * How many agent runs a preset will spend on a given number of chunks.
 *
 * This is the progress denominator, and it is computed in one place because the
 * bar and the engine must agree on it. A bar that says "3 of 5" and then
 * discovers a sixth step is worse than an indeterminate one.
 */
export function codeReviewUnitCount(preset: CodeReviewPreset, chunks = 1): number {
  const plan = CODE_REVIEW_PRESET_PLAN[preset];
  const perChunk = plan.lenses + (plan.sweep ? 1 : 0);
  return perChunk * Math.max(1, chunks) + (plan.validate ? 1 : 0);
}

// ---------- Phases ----------

export type CodeReviewPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'reviewing'
  | 'sweeping'
  | 'validating'
  | 'ready'
  | 'fixing'
  | 'fixed'
  | 'failed'
  | 'cancelled';

/**
 * Which phases are at rest, as a `Record` so the compiler routes you to every
 * consumer when a phase is added. The `TASK_STATUS_TERMINAL` trick, and it
 * exists for the same reason: before that record there were eight hand-written
 * copies of "which statuses are active", and a value in neither set is simply
 * invisible.
 *
 * `ready` is at rest and that is the load-bearing entry. A review resting with
 * findings on screen holds no plan slot; only `fixing` puts the cycle back in
 * flight. That is what makes "one review-and-fix cycle at a time" one gate
 * rather than two.
 */
export const CODE_REVIEW_PHASE_AT_REST: Record<CodeReviewPhase, boolean> = {
  idle: true,
  queued: false,
  preparing: false,
  reviewing: false,
  sweeping: false,
  validating: false,
  ready: true,
  fixing: false,
  fixed: true,
  failed: true,
  cancelled: true,
};

export const CODE_REVIEW_PHASES = Object.keys(CODE_REVIEW_PHASE_AT_REST) as CodeReviewPhase[];

export const CODE_REVIEW_ACTIVE_PHASES = CODE_REVIEW_PHASES.filter(
  (p) => !CODE_REVIEW_PHASE_AT_REST[p]
);

export function isCodeReviewPhase(value: unknown): value is CodeReviewPhase {
  return typeof value === 'string' && value in CODE_REVIEW_PHASE_AT_REST;
}

/** What the user reads. No stage names, no counts — the counts are separate. */
export const CODE_REVIEW_PHASE_LABELS: Record<CodeReviewPhase, string> = {
  idle: 'Not reviewed',
  queued: 'Waiting to start',
  preparing: 'Reading the pull request',
  reviewing: 'Looking for problems',
  sweeping: 'Checking for anything missed',
  validating: 'Checking the findings',
  ready: 'Review ready',
  fixing: 'Fixing',
  fixed: 'Pushed a fix',
  failed: 'Review failed',
  cancelled: 'Review stopped',
};

/** One word, for the PR row, where a title already owns the space. */
export const CODE_REVIEW_PHASE_SHORT: Record<CodeReviewPhase, string> = {
  idle: '',
  queued: 'Queued',
  preparing: 'Reading',
  reviewing: 'Reviewing',
  sweeping: 'Checking',
  validating: 'Judging',
  ready: 'Findings',
  fixing: 'Fixing',
  fixed: 'Fixed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

/**
 * Relative wall-clock weight per phase, for the progress bar.
 *
 * Deliberately UNEQUAL. Reading the pull request is quick and reviewing is most
 * of the wall clock, so equal fifths would hang the bar at 40% for minutes and
 * then jump. These are rough by nature; they only have to be less wrong than
 * treating every phase as the same size.
 */
export const CODE_REVIEW_PHASE_WEIGHTS: Record<CodeReviewPhase, number> = {
  idle: 0,
  queued: 0,
  preparing: 1,
  reviewing: 6,
  sweeping: 2,
  validating: 2,
  ready: 0,
  fixing: 6,
  fixed: 0,
  failed: 0,
  cancelled: 0,
};

// ---------- Severity ----------

export type CodeReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** Most serious first — the order the findings list renders its groups in. */
export const CODE_REVIEW_SEVERITY_ORDER: readonly CodeReviewSeverity[] = [
  'blocker',
  'major',
  'minor',
  'nit',
] as const;

export const CODE_REVIEW_SEVERITY_LABELS: Record<CodeReviewSeverity, string> = {
  blocker: 'Blocker',
  major: 'Worth fixing',
  minor: 'Minor',
  nit: 'Nitpick',
};

/** Plural group headings, which read better than a bare label plus a count. */
export const CODE_REVIEW_SEVERITY_GROUP_LABELS: Record<CodeReviewSeverity, string> = {
  blocker: 'Blockers',
  major: 'Worth fixing',
  minor: 'Minor',
  nit: 'Nitpicks',
};

export function isCodeReviewSeverity(value: unknown): value is CodeReviewSeverity {
  return (
    typeof value === 'string' && (CODE_REVIEW_SEVERITY_ORDER as readonly string[]).includes(value)
  );
}

/**
 * Whether a severity is at or above a threshold.
 *
 * One answer for three questions that must never diverge: which findings the
 * badge counts, which the row chip colours for, and which an opted-in workspace
 * would post inline on GitHub.
 */
export function severityAtOrAbove(
  severity: CodeReviewSeverity,
  threshold: CodeReviewSeverity
): boolean {
  return (
    CODE_REVIEW_SEVERITY_ORDER.indexOf(severity) <=
    CODE_REVIEW_SEVERITY_ORDER.indexOf(threshold)
  );
}

/** What a finding's severity is worth escalating for. Blockers only. */
export const CODE_REVIEW_BLOCKING_SEVERITY: CodeReviewSeverity = 'blocker';

/**
 * The bar for "how many findings am I being asked about".
 *
 * Nitpicks are below it, which is what puts them in the collapsed bucket at the
 * foot of the list rather than in the badge. One constant, because the tab badge,
 * the row chip and the sheet header must never disagree about the number they are
 * each showing the same person.
 */
export const CODE_REVIEW_REPORTING_BAR: CodeReviewSeverity = 'minor';

// ---------- Findings and the public payload ----------

export type CodeReviewDisposition =
  | 'open'
  | 'selected'
  | 'dismissed'
  | 'fixed'
  | 'stale'
  | 'discarded';

export type CodeReviewVerdict = 'unvalidated' | 'confirmed' | 'rejected' | 'uncertain';

export type CodeReviewDismissReason =
  | 'not_a_problem'
  | 'already_handled'
  | 'wont_fix_here'
  | 'wrong_about_code';

export const CODE_REVIEW_DISMISS_REASONS: readonly CodeReviewDismissReason[] = [
  'not_a_problem',
  'already_handled',
  'wont_fix_here',
  'wrong_about_code',
] as const;

export const CODE_REVIEW_DISMISS_REASON_LABELS: Record<CodeReviewDismissReason, string> = {
  not_a_problem: 'Not a problem',
  already_handled: 'Already handled',
  wont_fix_here: 'Not in this PR',
  wrong_about_code: 'Wrong about the code',
};

export function isCodeReviewDismissReason(value: unknown): value is CodeReviewDismissReason {
  return (
    typeof value === 'string' &&
    (CODE_REVIEW_DISMISS_REASONS as readonly string[]).includes(value)
  );
}

/** One finding, as the app renders it. */
export interface CodeReviewFinding {
  id: string;
  severity: CodeReviewSeverity;
  category: string;
  /** Which lenses reported it. Two is agreement, not a duplicate. */
  lenses: string[];
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** False means the agent paraphrased its anchor, or invented the path. */
  anchorVerified: boolean;
  title: string;
  /** Absent on a list read — the list projection drops the big columns. */
  body?: string;
  suggestion?: string | null;
  /** The agent's verbatim quote of the code. Detail read only. */
  anchor?: string | null;
  confidence: number | null;
  verdict: CodeReviewVerdict;
  verdictReason?: string | null;
  disposition: CodeReviewDisposition;
  dismissedReason?: CodeReviewDismissReason | null;
  /** True when this finding was already present in the previous cycle. */
  carriedOver: boolean;
  seenCount: number;
}

export type CodeReviewCounts = Record<CodeReviewSeverity, number>;

export const EMPTY_CODE_REVIEW_COUNTS: CodeReviewCounts = {
  blocker: 0,
  major: 0,
  minor: 0,
  nit: 0,
};

/**
 * The payload mirrored onto a pull-request row and read by the sheet.
 *
 * The analogue of `MergeQueuePublic`, and it inherits that type's hard-won
 * rules: `headShaShort` is pre-shortened here rather than in three components,
 * `openCount` is computed here rather than re-derived from `counts` at every
 * call site, and `staleForHead` is decided server-side because the row's summary
 * and the review can arrive in either order and a client deriving it would
 * flicker.
 */
export interface CodeReviewPublic {
  id: string;
  preset: CodeReviewPreset;
  phase: CodeReviewPhase;
  /** The ordered phases THIS cycle will execute — what makes the bar determinate. */
  phasePlan: CodeReviewPhase[];
  /** Units settled and units planned, for progress within the reviewing phases. */
  runsDone: number;
  runsTotal: number;
  headSha: string;
  headShaShort: string;
  /** The sha the findings on screen belong to. */
  reviewedHeadSha: string;
  /** The PR has moved on since the findings were produced. */
  staleForHead: boolean;
  counts: CodeReviewCounts;
  /** At or above the app's reporting bar, and not dismissed. What the badge shows. */
  openCount: number;
  dismissedCount: number;
  /** A user-facing sentence. Never a stack, never a host address. */
  failureReason: string | null;
  /** Set while a unit is waiting for a runner the plan will not give it yet. */
  deferredSince: string | null;
  fixTaskId: string | null;
  lastFix: { at: string; fixedCount: number; commentUrl: string | null } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------- Progress ----------

export interface CodeReviewProgress {
  /** 0..1, or null when there is nothing honest to show. */
  fraction: number | null;
  /** The phase's own words, with a count when one helps. */
  label: string;
  /** One word, for a PR row. */
  short: string;
  /** True when the phase is real but its position is unknowable. */
  indeterminate: boolean;
}

/**
 * The bar's arithmetic, in the one place both forks call.
 *
 * Weighted by phase rather than treated as equal steps, and interpolated
 * *within* the reviewing phases by settled units — otherwise a Standard review
 * sits motionless for most of its life on the one phase that takes the longest.
 *
 * A queued review is deliberately indeterminate rather than 0%: it is waiting
 * for a runner, and a bar pinned at zero reads as broken.
 */
export function codeReviewProgress(review: {
  phase: CodeReviewPhase;
  phasePlan: CodeReviewPhase[];
  runsDone: number;
  runsTotal: number;
  counts?: CodeReviewCounts;
  openCount?: number;
}): CodeReviewProgress {
  const { phase, phasePlan, runsDone, runsTotal } = review;
  const short = CODE_REVIEW_PHASE_SHORT[phase];

  if (phase === 'idle' || phase === 'cancelled' || phase === 'failed') {
    return { fraction: null, label: CODE_REVIEW_PHASE_LABELS[phase], short, indeterminate: false };
  }
  if (phase === 'ready' || phase === 'fixed') {
    return { fraction: 1, label: CODE_REVIEW_PHASE_LABELS[phase], short, indeterminate: false };
  }
  if (phase === 'queued') {
    return { fraction: null, label: CODE_REVIEW_PHASE_LABELS[phase], short, indeterminate: true };
  }

  const plan: CodeReviewPhase[] = phasePlan.length ? phasePlan : ['preparing', 'reviewing'];
  const total = plan.reduce((sum, p) => sum + CODE_REVIEW_PHASE_WEIGHTS[p], 0);
  const index = plan.indexOf(phase);
  if (total <= 0 || index < 0) {
    return { fraction: null, label: CODE_REVIEW_PHASE_LABELS[phase], short, indeterminate: true };
  }

  const done = plan.slice(0, index).reduce((sum, p) => sum + CODE_REVIEW_PHASE_WEIGHTS[p], 0);
  const within =
    runsTotal > 0 && phase === 'reviewing'
      ? Math.min(1, Math.max(0, runsDone / runsTotal))
      : 0;
  const fraction = Math.min(0.99, (done + CODE_REVIEW_PHASE_WEIGHTS[phase] * within) / total);

  const label =
    phase === 'reviewing' && runsTotal > 0
      ? `${CODE_REVIEW_PHASE_LABELS[phase]} (${Math.min(runsDone + 1, runsTotal)} of ${runsTotal})`
      : CODE_REVIEW_PHASE_LABELS[phase];

  return { fraction, label, short, indeterminate: false };
}

/** The ordered phases a preset will walk, which is what makes the bar honest. */
export function codeReviewPhasePlan(preset: CodeReviewPreset): CodeReviewPhase[] {
  const plan = CODE_REVIEW_PRESET_PLAN[preset];
  return [
    'preparing',
    'reviewing',
    ...(plan.sweep ? (['sweeping'] as const) : []),
    ...(plan.validate ? (['validating'] as const) : []),
    'ready',
  ];
}

// ---------- The findings contract ----------

/**
 * The line an agent must emit before its JSON block.
 *
 * Read back by taking the first fenced block after the LAST occurrence of this
 * line, so an agent that mentions the sentinel while explaining itself cannot
 * trip it. The same restraint `parseNeedsHumanSentinel` applies, and for the
 * same reason: text ABOUT a thing is not the thing.
 */
export const CODE_REVIEW_FINDINGS_SENTINEL = 'TALYN_REVIEW_FINDINGS:';

/** Bounds on one unit's payload. Each one TRUNCATES rather than rejects. */
export const CODE_REVIEW_MAX_FINDINGS_PER_UNIT = 40;
export const CODE_REVIEW_MAX_BODY_CHARS = 4000;
export const CODE_REVIEW_MAX_ANCHOR_CHARS = 200;
export const CODE_REVIEW_MAX_TITLE_CHARS = 200;

/** A finding exactly as an agent reports it, before any of our bookkeeping. */
export interface RawCodeReviewFinding {
  severity: CodeReviewSeverity;
  category: string;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  anchor: string;
  title: string;
  body: string;
  suggestion: string | null;
  confidence: number | null;
}

/**
 * One candidate the judging pass threw away, and why.
 *
 * Only the judge emits these. It matters because the judging pass rejected five
 * of six findings on the first real review and recorded nothing about any of
 * them, which makes the stage that decides what you see unauditable: there was
 * no way to tell a judge protecting you from noise from one discarding real
 * bugs.
 */
export interface DroppedCodeReviewCandidate {
  readonly id: string;
  readonly reason: string;
}

export type ParsedCodeReviewFindings =
  | {
      ok: true;
      findings: RawCodeReviewFinding[];
      truncated: boolean;
      /** Empty for every unit except the judge, which is the only one that drops. */
      dropped: DroppedCodeReviewCandidate[];
    }
  | { ok: false; error: string };

/**
 * The instruction block appended to every review prompt.
 *
 * Generated from the constants above so the prompt and the parser cannot drift:
 * change the sentinel or a cap and the words the agent reads change with it.
 */
export function codeReviewOutputContract(): string {
  return [
    `Finish your final message with the line \`${CODE_REVIEW_FINDINGS_SENTINEL}\` on its own,`,
    'then one fenced JSON code block, and nothing after it. The schema is:',
    '',
    '```json',
    '{"schema":1,"findings":[{',
    '  "severity":"blocker|major|minor|nit",',
    '  "category":"a short slug, e.g. correctness, security, performance",',
    '  "file":"path/relative/to/the/repo/root.ts",',
    '  "lineStart":41, "lineEnd":44,',
    '  "anchor":"the exact source line this is about, copied verbatim",',
    '  "title":"one short sentence naming the problem",',
    '  "body":"what goes wrong, when it is triggered, and what the consequence is",',
    '  "suggestion":"what to do about it, or null",',
    '  "confidence":80',
    '}]}',
    '```',
    '',
    'Rules for that block:',
    `- At most ${CODE_REVIEW_MAX_FINDINGS_PER_UNIT} findings. Report the ones that matter, not everything you noticed.`,
    '- `anchor` must be copied from the file verbatim, not paraphrased. It is how a',
    '  finding survives somebody rebasing the branch, and a paraphrase silently',
    '  becomes a duplicate.',
    '- Report a problem only if you can name a concrete trigger and a concrete',
    '  consequence. If you cannot, leave it out.',
    '- An empty findings array is a real and useful answer. Emit the block anyway:',
    '  a message with no block is recorded as a failed review, not a clean one.',
  ].join('\n');
}

/**
 * Read an agent's findings out of its final message.
 *
 * Deliberately narrow. It takes the first fenced block after the LAST sentinel
 * line and parses that; it never sweeps the prose for JSON-looking things. That
 * restraint is the `findPullRequestUrl` lesson — a loop once claimed authorship
 * of somebody else's pull request because prose was searched for a URL.
 *
 * Returning `{ ok: false }` means UNKNOWN and every caller must treat it as a
 * failed unit. It must never be read as "the agent found nothing": inverting
 * that turns a broken run into a clean bill of health, which is the worst
 * failure this product has available to it.
 */
export function parseCodeReviewFindings(text: string | null | undefined): ParsedCodeReviewFindings {
  if (!text) return { ok: false, error: 'The agent produced no final message.' };

  const marker = text.lastIndexOf(CODE_REVIEW_FINDINGS_SENTINEL);
  if (marker < 0) {
    return {
      ok: false,
      error: `The final message carried no ${CODE_REVIEW_FINDINGS_SENTINEL} line.`,
    };
  }

  const after = text.slice(marker + CODE_REVIEW_FINDINGS_SENTINEL.length);
  const fence = after.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  // A block with no closing fence is the common truncation, so fall back to
  // "everything after the opening fence" rather than calling it unparseable.
  const raw = fence ? fence[1]! : after.replace(/^[\s\S]*?```(?:json)?\s*\n/, '');
  if (!raw.trim()) {
    return { ok: false, error: 'The sentinel was present but no JSON block followed it.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `The JSON block did not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const list = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) {
    return { ok: false, error: 'The JSON block had no `findings` array.' };
  }

  const truncated = list.length > CODE_REVIEW_MAX_FINDINGS_PER_UNIT;
  const findings = list
    .slice(0, CODE_REVIEW_MAX_FINDINGS_PER_UNIT)
    .map(normaliseFinding)
    .filter((f): f is RawCodeReviewFinding => f !== null);

  // Absent on every unit but the judge, and absent is not an error: a lens has
  // nothing to drop, and an older prompt that never asked for reasons must keep
  // parsing rather than failing the unit over a missing optional field.
  const droppedRaw = (parsed as { dropped?: unknown })?.dropped;
  const dropped: DroppedCodeReviewCandidate[] = Array.isArray(droppedRaw)
    ? droppedRaw
        .map((d) => {
          const row = (d ?? {}) as Record<string, unknown>;
          const id = str(row.id).trim();
          const reason = str(row.reason).slice(0, CODE_REVIEW_MAX_BODY_CHARS).trim();
          return id ? { id, reason } : null;
        })
        .filter((d): d is DroppedCodeReviewCandidate => d !== null)
    : [];

  return { ok: true, findings, truncated, dropped };
}

function normaliseFinding(value: unknown): RawCodeReviewFinding | null {
  if (!value || typeof value !== 'object') return null;
  const f = value as Record<string, unknown>;

  const title = str(f.title).slice(0, CODE_REVIEW_MAX_TITLE_CHARS).trim();
  const file = str(f.file).trim();
  // A finding with no title says nothing, and one with no file cannot be
  // anchored, shown in a diff or fixed. Dropping the entry is right; dropping
  // the whole payload for one bad entry is not.
  if (!title) return null;

  return {
    severity: isCodeReviewSeverity(f.severity) ? f.severity : 'minor',
    category: str(f.category).slice(0, 60).trim(),
    file,
    lineStart: int(f.lineStart),
    lineEnd: int(f.lineEnd),
    anchor: str(f.anchor).slice(0, CODE_REVIEW_MAX_ANCHOR_CHARS),
    title,
    body: str(f.body).slice(0, CODE_REVIEW_MAX_BODY_CHARS),
    suggestion: f.suggestion == null ? null : str(f.suggestion).slice(0, CODE_REVIEW_MAX_BODY_CHARS),
    confidence: clampConfidence(f.confidence),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

// ---------- The dedupe key ----------

/**
 * The key that makes a re-review MERGE into the finding already on record
 * instead of adding a second row saying the same thing.
 *
 * What it leaves out matters more than what it contains:
 *
 * - **Not the lens.** Two lenses independently flagging one missing null check
 *   is one finding with a seen count of two. Cross-lens agreement is a
 *   confidence signal, and duplicating it is the noisiest failure a multi-lens
 *   reviewer has.
 * - **Not the line numbers.** A rebase moves every line, and surviving a new
 *   commit is the entire requirement.
 *
 * The anchor carries the position instead: the verbatim source the finding is
 * about, which moves with the code. When an agent paraphrases it the backend
 * records `anchorVerified: false` and falls back to `file|title`, which is
 * weaker but still stable.
 *
 * A non-cryptographic hash on purpose — this is a dedupe key, not a security
 * boundary, and FNV-1a is what `promptTemplateHash` already uses here.
 */
export function codeReviewDedupeKey(input: {
  filePath: string;
  title: string;
  anchor?: string | null;
  anchorVerified?: boolean;
}): string {
  const file = input.filePath.trim().replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
  const title = slug(input.title);
  const anchor =
    input.anchorVerified && input.anchor ? collapseWhitespace(input.anchor) : '';
  return fnv1a(`${file}|${title}|${anchor}`);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------- Settings ----------

/**
 * A workspace's code-review posture.
 *
 * Every field optional, so the route's jsonb merge can carry one key without
 * asserting anything about the others. Read through `resolveCodeReviewSettings`
 * rather than directly, so an absent object means the defaults in one place.
 */
export interface CodeReviewSettings {
  preset?: CodeReviewPreset;
  /** Review every new PR this workspace's members author. Unlimited only. */
  autoReview?: boolean;
  /** Post one comment after a fix run lands, saying what it fixed. */
  fixSummaryComment?: boolean;
  /** Post blockers as inline review comments. The loud option, off by default. */
  inlineComments?: boolean;
  /**
   * Fix findings without waiting for somebody to tick them.
   *
   * OFF by default, and the most consequential setting on this object: it is the
   * only one that pushes a commit to a branch with no human in the loop. The
   * design deliberately did not include this — every other guard here assumes a
   * person chose the findings — and it exists because it was asked for, not
   * because the reasoning changed. `autoFixSeverity` is what keeps it honest.
   */
  autoFix?: boolean;
  /**
   * The lowest severity auto-fix will touch. Defaults to blockers only.
   *
   * Deliberately NOT "everything the review found". On the first real review the
   * judge rejected five of six findings, and the one that survived was wrong —
   * so a floor is the difference between fixing what matters and pushing commits
   * for speculation.
   */
  autoFixSeverity?: CodeReviewSeverity;
}

export interface ResolvedCodeReviewSettings {
  preset: CodeReviewPreset;
  autoReview: boolean;
  fixSummaryComment: boolean;
  inlineComments: boolean;
  autoFix: boolean;
  autoFixSeverity: CodeReviewSeverity;
}

/**
 * The defaults, and two of them are product decisions worth stating.
 *
 * `fixSummaryComment` is OFF. The differentiator is that Talyn does not write on
 * your pull request, and a fix already announces itself as a commit — so even
 * the one benign comment is opt-in. This is the deliberate opposite of
 * `respondToHumanComments`, which defaults true because replying to a human who
 * asked you something is not noise.
 *
 * `inlineComments` is OFF and is the only setting that can produce the wall of
 * comments this feature exists to avoid.
 */
export function resolveCodeReviewSettings(
  settings: CodeReviewSettings | null | undefined
): ResolvedCodeReviewSettings {
  return {
    preset: isCodeReviewPreset(settings?.preset) ? settings.preset : DEFAULT_CODE_REVIEW_PRESET,
    autoReview: settings?.autoReview === true,
    fixSummaryComment: settings?.fixSummaryComment === true,
    inlineComments: settings?.inlineComments === true,
    autoFix: settings?.autoFix === true,
    // Blockers only unless somebody widens it. The default has to be the narrow
    // end: this decides what gets committed to a branch unattended.
    autoFixSeverity: isCodeReviewSeverity(settings?.autoFixSeverity)
      ? settings.autoFixSeverity
      : 'blocker',
  };
}

/**
 * Normalise a settings patch, dropping anything unrecognised.
 *
 * Needed because the workspaces PATCH merges `settings` with a TOP-LEVEL jsonb
 * `||`, so sending `{ codeReview: { preset } }` would replace the whole object
 * and silently drop the three toggles. The route deep-merges this key the way it
 * already special-cases `prompts`, and this function is what it merges.
 */
export function codeReviewSettingsPatch(input: unknown): CodeReviewSettings {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const patch: CodeReviewSettings = {};
  if (isCodeReviewPreset(raw.preset)) patch.preset = raw.preset;
  if (typeof raw.autoReview === 'boolean') patch.autoReview = raw.autoReview;
  if (typeof raw.fixSummaryComment === 'boolean') patch.fixSummaryComment = raw.fixSummaryComment;
  if (typeof raw.inlineComments === 'boolean') patch.inlineComments = raw.inlineComments;
  if (typeof raw.autoFix === 'boolean') patch.autoFix = raw.autoFix;
  if (isCodeReviewSeverity(raw.autoFixSeverity)) patch.autoFixSeverity = raw.autoFixSeverity;
  return patch;
}

/**
 * The findings auto-fix is allowed to touch.
 *
 * Three filters, and each one is a thing that went wrong on the first real
 * review:
 *
 * - CONFIRMED only. An unvalidated finding has not been through the checking
 *   pass, which rejected five of six candidates. Fixing one mid-review commits
 *   to a branch for something about to be withdrawn.
 * - At or above the severity floor, which defaults to blockers.
 * - Location CONFIRMED. `anchorVerified: false` means the agent quoted code that
 *   is not at the line it named — the hallucination signal — and the one finding
 *   that survived judging on that review was exactly this, and was wrong. A
 *   person can weigh that against the diff; an unattended fix run cannot.
 *
 * Returns the empty list when auto-fix is off, so callers need no second check.
 */
export function findingsEligibleForAutoFix<
  T extends {
    severity: string;
    verdict: string;
    disposition: string;
    anchorVerified: boolean;
  },
>(findings: readonly T[], settings: ResolvedCodeReviewSettings): T[] {
  if (!settings.autoFix) return [];
  // The fields are typed as plain strings because that is what a database row
  // gives us, and narrowing here rather than at the call site means a row whose
  // severity is something this build has never heard of fails the floor check
  // instead of being cast into passing it.
  return findings.filter(
    (f) =>
      f.verdict === 'confirmed' &&
      f.disposition === 'open' &&
      f.anchorVerified &&
      isCodeReviewSeverity(f.severity) &&
      severityAtOrAbove(f.severity, settings.autoFixSeverity)
  );
}

// ---------- Requests ----------

export interface CodeReviewStartInput {
  preset?: CodeReviewPreset;
  /** Discard the findings already on record rather than carrying them forward. */
  reset?: boolean;
}

export class CodeReviewRequestError extends Error {}

/**
 * Validate a start request, throwing a message written for a person.
 *
 * Paired with `codeReviewStartProblem` below so a disabled button and a 400 can
 * never disagree about why — the `validateLoop` / `loopInputProblem` pattern.
 */
export function validateCodeReviewStart(input: unknown): CodeReviewStartInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.preset !== undefined && !isCodeReviewPreset(raw.preset)) {
    throw new CodeReviewRequestError(
      `"${String(raw.preset)}" is not a review depth. Pick one of: ${CODE_REVIEW_PRESETS.join(', ')}.`
    );
  }
  if (raw.reset !== undefined && typeof raw.reset !== 'boolean') {
    throw new CodeReviewRequestError('`reset` has to be true or false.');
  }
  return {
    ...(isCodeReviewPreset(raw.preset) ? { preset: raw.preset } : {}),
    ...(raw.reset === true ? { reset: true } : {}),
  };
}

export function codeReviewStartProblem(input: unknown): string | null {
  try {
    validateCodeReviewStart(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------- Offered ----------

/**
 * Whether to DRAW code review for this account.
 *
 * Three-state, exactly `loopsOffered`: `null` features means still loading and
 * must render nothing, because conflating "loading" with "not offered" is how a
 * tab flashes in on every launch. Never a permission check — every route, the
 * engine and the fix action gate independently.
 */
export function codeReviewOffered(features: Features | null | undefined): boolean {
  return features?.codeReview === true;
}
