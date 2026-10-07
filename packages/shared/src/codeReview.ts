import type { Features } from './featureFlags.js';
import { parseSkillKey } from './skills.js';

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
export function codeReviewUnitCount(
  preset: CodeReviewPreset,
  chunks = 1,
  /**
   * How many lenses will ACTUALLY run, when that is already known.
   *
   * The preset says how many a depth offers; per-chunk selection can drop some
   * of them once the files are known. This number is the progress denominator,
   * and a bar that promises five steps and delivers four is worse than one that
   * never promised. Defaults to the preset's count for callers deciding before
   * the files are loaded.
   */
  lensCount?: number
): number {
  const plan = CODE_REVIEW_PRESET_PLAN[preset];
  const lenses = lensCount ?? plan.lenses;
  const perChunk = lenses + (plan.sweep ? 1 : 0);
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

/**
 * Severity in the words a person would use.
 *
 * Phrased as an INSTRUCTION rather than a classification — "Must fix" says what
 * to do with it, where "Blocker" asks the reader to know our taxonomy. The
 * stored values stay `blocker`/`major`/`minor`/`nit`, because they are a
 * database column and a wire contract; only what is shown changes.
 */
export const CODE_REVIEW_SEVERITY_LABELS: Record<CodeReviewSeverity, string> = {
  blocker: 'Must fix',
  major: 'Should fix',
  minor: 'Consider',
  nit: 'Nitpick',
};

/** Plural group headings, which read better than a bare label plus a count. */
export const CODE_REVIEW_SEVERITY_GROUP_LABELS: Record<CodeReviewSeverity, string> = {
  blocker: 'Must fix',
  major: 'Should fix',
  minor: 'Worth considering',
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

/**
 * How strict this workspace is about what reaches the list.
 *
 * The same question the depth preset does NOT answer: depth decides how hard
 * Talyn looks, this decides how much of what it finds is worth your attention.
 * A team that wants only the things that would block a merge sets it to
 * blockers; the default shows everything down to the reporting bar above.
 *
 * It is a DISPLAY bar, and deliberately separate from `autoFixSeverity`, which
 * is a COMMIT bar. Seeing a minor finding and having Talyn push a commit for one
 * unattended are different risks, and one control for both would force the
 * cautious answer on the reader.
 */
export function resolveReportingBar(
  settings: CodeReviewSettings | null | undefined
): CodeReviewSeverity {
  return isCodeReviewSeverity(settings?.reportingBar)
    ? settings.reportingBar
    : CODE_REVIEW_REPORTING_BAR;
}

/**
 * Files a review should not spend an agent on.
 *
 * Lock files, generated clients, vendored trees, snapshots and minified
 * bundles. Three reasons, and the third is the one that matters:
 *
 * - They are large, so they eat the diff budget a chunk has.
 * - Nobody writes them, so a finding on one is addressed by regenerating the
 *   file, which is not what a fix run does.
 * - They are NOISE-DENSE. A generated client has thousands of near-identical
 *   lines, and a reviewer told to look hard at a diff will find something to say
 *   about them — which then costs a judging pass to throw away.
 *
 * Matched on the path, not on content: content-sniffing a minified bundle means
 * reading it first, which is the cost this avoids.
 *
 * NOT a setting. A person who wants their lock file reviewed is not somebody the
 * product should build a knob for, and every knob here is one more thing to get
 * wrong before the first useful review.
 */
const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  // Dependency lock files — every ecosystem's, by exact basename.
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock|Pipfile\.lock|flake\.lock)$/,
  // Vendored or third-party trees nobody in this repo authors.
  /(^|\/)(node_modules|vendor|third_party|Pods|\.yarn)\//,
  // Test snapshots: regenerated, never hand-edited.
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  // Generated output, by the conventions that actually appear in repositories.
  /(^|\/)(dist|build|out|coverage)\//,
  /\.(min\.js|min\.css|map)$/,
  /(^|\/).*\.(pb|generated|gen)\.(go|ts|js|py|rb|cs|java)$/,
  /(^|\/)(generated|__generated__)\//,
];

/** Whether a review should skip this path. See GENERATED_PATH_PATTERNS. */
export function isGeneratedPath(filename: string): boolean {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(filename));
}

/**
 * The files a review will actually read.
 *
 * Returns everything when the filter would leave nothing: a pull request that
 * is ONLY a lock-file bump is still a pull request somebody asked to review, and
 * answering "no files" would report as a failed cycle rather than as a review of
 * what is there.
 */
export function filesWorthReviewing<T extends { filename: string }>(files: readonly T[]): T[] {
  const kept = files.filter((f) => !isGeneratedPath(f.filename));
  return kept.length ? kept : [...files];
}

/**
 * What kind of file this is, for deciding which reviewers a change needs.
 *
 * Coarse on purpose. The finer the classification, the more confidently it is
 * wrong — and a wrong answer here means a reviewer that never ran, which looks
 * exactly like a reviewer that found nothing.
 */
export type CodeReviewFileClass = 'code' | 'test' | 'config' | 'migration' | 'docs' | 'asset';

/**
 * Classify a path.
 *
 * Order matters: a file can look like several of these, and the FIRST match
 * wins. A migration is checked before config because `migrations/0068.sql` is
 * both; a test before code because `src/foo.test.ts` is both.
 */
export function classifyReviewFile(filename: string): CodeReviewFileClass {
  const f = filename.toLowerCase();
  if (/(^|\/)migrations?\//.test(f) || /\.sql$/.test(f)) return 'migration';
  if (
    /(^|\/)(__tests__|tests?|spec|e2e|cypress)\//.test(f) ||
    /\.(test|spec)\.[a-z]+$/.test(f) ||
    /_test\.[a-z]+$/.test(f) ||
    /(^|\/)conftest\.py$/.test(f)
  ) {
    return 'test';
  }
  if (/\.(md|mdx|rst|txt|adoc)$/.test(f) || /(^|\/)docs?\//.test(f)) return 'docs';
  if (
    /\.(json|ya?ml|toml|ini|cfg|conf|properties|tf|tfvars)$/.test(f) ||
    /(^|\/)(dockerfile|makefile|procfile)$/.test(f) ||
    /(^|\/)\.[a-z]+rc$/.test(f) ||
    /(^|\/)\.env/.test(f)
  ) {
    return 'config';
  }
  if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|webm)$/.test(f)) {
    return 'asset';
  }
  return 'code';
}

/**
 * What each reviewer needs to see before it is worth dispatching.
 *
 * A lens runs when the change contains AT LEAST ONE file of a class it cares
 * about. Absent from this map means "always runs", which is the safe default
 * for a lens nobody has classified yet.
 *
 * `correctness` is deliberately not here: any change to anything can contain a
 * mistake, and that is the one reviewer whose absence would be a hole rather
 * than a saving.
 */
export const CODE_REVIEW_LENS_NEEDS: Record<string, readonly CodeReviewFileClass[]> = {
  // Trust boundaries live in code, configuration and schemas — not in prose or
  // a stylesheet.
  security: ['code', 'config', 'migration'],
  // Load, failure and resource behaviour are properties of things that RUN.
  reliability: ['code', 'migration'],
  // Coverage is assessed against a behaviour change, or against the tests
  // themselves when those are what changed.
  tests: ['code', 'test', 'migration'],
  // What this looks like at three in the morning: code, what configures it, and
  // what migrates it.
  operability: ['code', 'config', 'migration'],
};

/** Why a lens was not dispatched, in the words the app shows. */
export interface SkippedLens {
  lens: string;
  reason: string;
}

/**
 * Which reviewers this change actually needs.
 *
 * # The rule, and why it is this way round
 *
 * A lens is SKIPPED only on positive evidence that it has nothing to look at —
 * never because we are unsure. That asymmetry is the whole safety argument:
 * running a reviewer that finds nothing costs money, which is the status quo,
 * while skipping one that would have found something costs a bug and looks
 * exactly like a clean review. Those are not comparable mistakes, so the
 * uncertain case takes the expensive branch.
 *
 * `correctness` is never skipped, and at least one lens always runs: a change
 * of any kind can be wrong, and "we reviewed nothing" is not an outcome this
 * product should be able to produce quietly.
 *
 * Deliberately a rule over the file list rather than a model call. A model
 * would judge better and would also be another unit, another failure mode, and
 * another bill before the review starts — and its decisions could not be shown
 * to the user as a reason they can check.
 */
export function selectLensesForFiles(
  lensKeys: readonly string[],
  files: readonly { filename: string }[]
): { selected: string[]; skipped: SkippedLens[] } {
  const present = new Set(files.map((f) => classifyReviewFile(f.filename)));

  const selected: string[] = [];
  const skipped: SkippedLens[] = [];

  for (const lens of lensKeys) {
    const needs = CODE_REVIEW_LENS_NEEDS[lens];
    // Unclassified lens, or the change contains something it cares about.
    if (!needs || needs.some((klass) => present.has(klass))) {
      selected.push(lens);
      continue;
    }
    skipped.push({
      lens,
      reason: `nothing in this change is ${describeClasses(needs)}`,
    });
  }

  // The floor. A change of only documentation still gets read by somebody.
  if (!selected.length && lensKeys.length) {
    const first = lensKeys[0]!;
    return {
      selected: [first],
      skipped: skipped.filter((s) => s.lens !== first),
    };
  }

  return { selected, skipped };
}

function describeClasses(classes: readonly CodeReviewFileClass[]): string {
  const words: Record<CodeReviewFileClass, string> = {
    code: 'code',
    test: 'a test',
    config: 'configuration',
    migration: 'a migration',
    docs: 'documentation',
    asset: 'an asset',
  };
  const list = classes.map((c) => words[c]);
  if (list.length === 1) return list[0]!;
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

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
  /**
   * The commit a fix run produced for this finding, pre-shortened for display
   * beside the full one — `MergeQueuePublic`'s rule, so three components cannot
   * each pick a different length.
   *
   * Null on everything that was not fixed, AND on a fix that completed without
   * pushing. A fixed finding with no sha says it was fixed and links nowhere,
   * which is the honest answer: naming the commit the run started from would
   * point at a change nobody made.
   */
  fixedHeadSha?: string | null;
  fixedHeadShaShort?: string | null;
  /** Built server-side — only it knows which host the repository lives on. */
  fixedCommitUrl?: string | null;
  fixedAt?: string | null;
  /** The run that fixed it, so the transcript is one click from the finding. */
  fixTaskId?: string | null;
  /**
   * When "Post to PR" wrote this finding onto the pull request, as an ISO
   * string. Null when it is only in the app. It stays set when a later cycle
   * re-opens the finding, because the comment is still on the pull request.
   */
  postedAt?: string | null;
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
  /**
   * Which reviewers actually ran on this cycle.
   *
   * Fewer than the depth offers means per-chunk selection dropped some, because
   * the change had nothing they look at. Surfaced rather than left implicit: a
   * reviewer that never ran finds nothing, and nothing looks exactly like a
   * clean bill of health. The precise reason for each is in the timeline.
   */
  lensesRun: string[];
  /**
   * The team's own reviewers on this cycle, so a client can label their lens
   * keys. Frozen at cycle start, so a skill renamed or removed afterwards still
   * reads by the name it ran under. Absent from an older backend, and empty when
   * the cycle ran none.
   */
  customReviewers?: { lensKey: string; name: string }[];
  /**
   * How many pieces the diff was read in. 1 means whole.
   *
   * Scope, which the app otherwise says nothing about — so a review that read
   * everything and one that skimmed looked identical.
   */
  chunkTotal: number;
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
  /**
   * What the review did to its own candidates: raised, kept, thrown out.
   *
   * Shown as a sentence rather than left implicit, because the ratio is the
   * single most informative thing about a review's quality — on the first real
   * one the judge kept one of six — and without it a short list is
   * indistinguishable from a shallow review.
   */
  funnel: { raised: number; kept: number; rejected: number };
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
  // `fixing` is handled here rather than by the plan walk below, because it is
  // NOT in `phasePlan` — the plan is the phases a REVIEW cycle walks, and a fix
  // is a separate piece of work a person asked for afterwards. It fell through
  // to the `index < 0` escape hatch and came out indeterminate with the right
  // label by accident, which read on screen as a review that had stalled. An
  // agent run reports no step count, so indeterminate is the honest answer; what
  // was missing is saying so on purpose.
  if (phase === 'fixing') {
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
  /**
   * Only the judge sends this: the id of the candidate it is keeping, which is
   * that candidate's dedupe key. Absent on every other unit.
   */
  id?: string;
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
    ...(str(f.id).trim() ? { id: str(f.id).trim().slice(0, 200) } : {}),
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
  /**
   * The lowest severity shown in the list. Defaults to the reporting bar.
   *
   * A DISPLAY bar, not a commit bar — see `resolveReportingBar`.
   */
  reportingBar?: CodeReviewSeverity;
  /**
   * The team's own reviewers. Each one is a skill that runs as its own reviewer,
   * next to Talyn's. See `CodeReviewCustomReviewer`.
   */
  customReviewers?: CodeReviewCustomReviewer[];
  /** Run Talyn's own reviewers. On unless a team wants only its own. */
  builtInReviewers?: boolean;
}

export interface ResolvedCodeReviewSettings {
  preset: CodeReviewPreset;
  autoReview: boolean;
  fixSummaryComment: boolean;
  inlineComments: boolean;
  autoFix: boolean;
  autoFixSeverity: CodeReviewSeverity;
  reportingBar: CodeReviewSeverity;
  customReviewers: CodeReviewCustomReviewer[];
  builtInReviewers: boolean;
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
    reportingBar: resolveReportingBar(settings),
    customReviewers: storedCustomReviewers(settings?.customReviewers),
    // On unless somebody turned it off. An absent key is every workspace that
    // existed before the switch did.
    builtInReviewers: settings?.builtInReviewers !== false,
  };
}

/**
 * Normalise a settings patch, dropping anything unrecognised.
 *
 * Needed because the workspaces PATCH merges `settings` with a TOP-LEVEL jsonb
 * `||`, so sending `{ codeReview: { preset } }` would replace the whole object
 * and silently drop the three toggles. The route deep-merges this key the way it
 * already special-cases `prompts`, and this function is what it merges.
 *
 * `customReviewers` is the one key that THROWS (`CodeReviewRequestError`)
 * instead of being dropped. A reviewer list that was quietly discarded reads as
 * a save that worked, and the team then waits for a reviewer that never runs.
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
  if (isCodeReviewSeverity(raw.reportingBar)) patch.reportingBar = raw.reportingBar;
  if (typeof raw.builtInReviewers === 'boolean') patch.builtInReviewers = raw.builtInReviewers;
  if (raw.customReviewers !== undefined) {
    patch.customReviewers = validateCustomReviewers(raw.customReviewers);
  }
  return patch;
}

// ---------- Custom reviewers ----------

/**
 * One of the team's own reviewers: a skill that runs as its own reviewer.
 *
 * `skillKey` is the ordinary skill key. A repo skill carries its repository, so
 * it runs on pull requests in that repository only. A Talyn skill is
 * workspace-wide. A `local:` skill is never valid here, because the backend
 * cannot read a file on somebody's machine.
 *
 * `name` is the skill's name when it was added. It labels the reviewer when the
 * skill cannot be loaded later.
 */
export interface CodeReviewCustomReviewer {
  skillKey: string;
  name: string;
}

/** A custom reviewer as one cycle froze it. Stored on the review row. */
export interface CodeReviewCycleReviewer extends CodeReviewCustomReviewer {
  lensKey: string;
}

export const CODE_REVIEW_SKILL_LENS_PREFIX = 'skill:';

/**
 * The lens key a custom reviewer runs under: `skill:` plus the skill key.
 *
 * The skill key itself and not a hash of it. Two reviewers whose hashes
 * collided would share one unit claim, and one of them would never run with
 * nothing to say so. The prefix keeps the key out of the built-in lens names.
 */
export function customReviewerLensKey(skillKey: string): string {
  return `${CODE_REVIEW_SKILL_LENS_PREFIX}${skillKey}`;
}

export function isCustomReviewerLens(lensKey: string): boolean {
  return lensKey.startsWith(CODE_REVIEW_SKILL_LENS_PREFIX);
}

/**
 * The largest skill that can run as a reviewer, in bytes.
 *
 * Not a taste judgement. A review prompt is one process argument, which Linux
 * caps at 131072 bytes. 32 KB of that is kept for the instructions, the pull
 * request description, the file list and the output contract. The other 96 KB
 * is shared by the skill and the inline diff. A diff that does not fit is named
 * and read from the checkout, so its share can go to zero. A skill cannot be
 * read from anywhere else, so its share cannot go above the whole 96 KB.
 *
 * Lower than `SKILL_MAX_BYTES` (256 KB), so a skill that runs as a task can
 * still be too large to run as a reviewer. The backend's inline-diff budget is
 * the same number, and a test holds the two together.
 */
export const CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES = 96 * 1024;

const LOCAL_REVIEWER_REFUSAL =
  'A reviewer cannot be a skill on your machine, because Talyn runs reviews on its servers. ' +
  'Use a skill in the repository or one saved to Talyn.';

/** Compared without case on the repository, which GitHub does not distinguish. */
function reviewerIdentity(skillKey: string): string {
  const parsed = parseSkillKey(skillKey);
  if (parsed?.source === 'repo') {
    return `repo:${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}:${parsed.name}`;
  }
  return skillKey;
}

/**
 * Validate a reviewer list, throwing a message written for a person.
 *
 * Checks the SHAPE only: each key parses, none is `local:`, duplicates are
 * removed. Whether a key names a repository or a skill of this workspace needs
 * the database, and the route does that.
 */
export function validateCustomReviewers(input: unknown): CodeReviewCustomReviewer[] {
  if (!Array.isArray(input)) {
    throw new CodeReviewRequestError('`customReviewers` has to be a list of skills.');
  }
  const seen = new Set<string>();
  const out: CodeReviewCustomReviewer[] = [];
  for (const entry of input) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const skillKey = typeof raw.skillKey === 'string' ? raw.skillKey.trim() : '';
    const parsed = parseSkillKey(skillKey);
    if (!parsed) {
      throw new CodeReviewRequestError(
        `"${skillKey || String(raw.skillKey)}" is not a skill Talyn can run as a reviewer.`
      );
    }
    if (parsed.source === 'local') throw new CodeReviewRequestError(LOCAL_REVIEWER_REFUSAL);
    const identity = reviewerIdentity(skillKey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const given = typeof raw.name === 'string' ? raw.name.trim() : '';
    // A repo skill's name is in its key. A Talyn skill's key holds an id, so
    // the name comes with it, and the route replaces it with the stored one.
    out.push({ skillKey, name: parsed.source === 'repo' ? parsed.name : given || 'Talyn skill' });
  }
  return out;
}

/** The stored list, tolerantly: an entry this build cannot read is left out. */
function storedCustomReviewers(input: unknown): CodeReviewCustomReviewer[] {
  if (!Array.isArray(input)) return [];
  const out: CodeReviewCustomReviewer[] = [];
  for (const entry of input) {
    try {
      out.push(...validateCustomReviewers([entry]));
    } catch {
      // Skipped. The start path refuses a cycle that is left with no reviewer.
    }
  }
  return validateCustomReviewers(out);
}

/**
 * Why this reviewer setup cannot be saved, or null when it can.
 *
 * One function for the settings page and the route, so a disabled switch and a
 * 400 cannot disagree about why.
 */
export function codeReviewReviewersProblem(settings: {
  builtInReviewers: boolean;
  customReviewers: readonly unknown[];
}): string | null {
  if (!settings.builtInReviewers && !settings.customReviewers.length) {
    return "Turn on Talyn's reviewers or add at least one of your own.";
  }
  return null;
}

/**
 * Which of the team's reviewers run on a pull request in this repository.
 *
 * Every Talyn skill, and every repo skill of THIS repository. A repo skill of
 * another repository is left out without an error: that is what the setting
 * means.
 */
export function customReviewersForRepo(
  reviewers: readonly CodeReviewCustomReviewer[],
  repo: { owner: string; repo: string }
): CodeReviewCycleReviewer[] {
  const full = `${repo.owner}/${repo.repo}`.toLowerCase();
  const out: CodeReviewCycleReviewer[] = [];
  for (const reviewer of reviewers) {
    const parsed = parseSkillKey(reviewer.skillKey);
    if (!parsed || parsed.source === 'local') continue;
    if (parsed.source === 'repo' && `${parsed.owner}/${parsed.repo}`.toLowerCase() !== full) {
      continue;
    }
    out.push({ ...reviewer, lensKey: customReviewerLensKey(reviewer.skillKey) });
  }
  return out;
}

/** Where a reviewer's skill lives, in the words the settings page shows. */
export function customReviewerSource(skillKey: string): string {
  const parsed = parseSkillKey(skillKey);
  if (parsed?.source === 'repo') return `${parsed.owner}/${parsed.repo}`;
  return 'Talyn skill';
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

/**
 * What each reviewer was looking for, in the user's words.
 *
 * A DELIBERATE REVERSAL. The design said lens names were internal vocabulary
 * the user must never see, on the reasoning that a preset should be a single
 * choice rather than a panel of knobs. That holds for CONFIGURING a review and
 * does not hold for reading one: "raised by 2 reviewers" says less than "logic
 * and reliability both flagged this", and cross-lens agreement is the strongest
 * confidence signal the pipeline produces. Showing which angles found something
 * is reporting, not configuration.
 *
 * `sweep` is here because it is attributed like a lens on a finding, and the
 * name it is given says what it actually did rather than naming our stage.
 */
export const CODE_REVIEW_LENS_LABELS: Record<string, string> = {
  correctness: 'Logic',
  security: 'Security',
  reliability: 'Reliability',
  tests: 'Tests',
  operability: 'Operability',
  sweep: 'Second pass',
};

/** Lens key to display name, for the reviewers that are not Talyn's own. */
export type CodeReviewLensNames = Readonly<Record<string, string>>;

/** The name map for a review payload's (or a settings object's) reviewers. */
export function codeReviewLensNames(
  reviewers: readonly { lensKey?: string; skillKey?: string; name: string }[] | null | undefined
): CodeReviewLensNames {
  const names: Record<string, string> = {};
  for (const reviewer of reviewers ?? []) {
    const key =
      reviewer.lensKey ?? (reviewer.skillKey ? customReviewerLensKey(reviewer.skillKey) : null);
    if (key && reviewer.name) names[key] = reviewer.name;
  }
  return names;
}

/**
 * The label for a lens key.
 *
 * Talyn's own lenses have fixed labels. A custom reviewer is named by `names`,
 * which a review payload carries for its own cycle. Without a name, a repo
 * skill's key still holds its skill name, so that is used. Anything else falls
 * back to the key.
 */
export function codeReviewLensLabel(key: string, names?: CodeReviewLensNames): string {
  const builtIn = CODE_REVIEW_LENS_LABELS[key];
  if (builtIn) return builtIn;
  const named = names?.[key];
  if (named) return named;
  if (isCustomReviewerLens(key)) {
    const parsed = parseSkillKey(key.slice(CODE_REVIEW_SKILL_LENS_PREFIX.length));
    if (parsed?.source === 'repo') return parsed.name;
  }
  return key;
}

/**
 * How many findings each angle contributed, most first.
 *
 * Counts a finding once per lens that raised it, so two lenses agreeing shows up
 * under both — which is the point: this is the view that makes agreement
 * visible.
 */
export function codeReviewLensTally(
  findings: readonly { lenses: string[] }[],
  names?: CodeReviewLensNames
): { lens: string; label: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const finding of findings) {
    for (const lens of finding.lenses) tally.set(lens, (tally.get(lens) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([lens, count]) => ({ lens, label: codeReviewLensLabel(lens, names), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** How one lens has performed: raised versus kept by the judging pass. */
export interface CodeReviewLensStat {
  lens: string;
  raised: number;
  kept: number;
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

// ---------- Findings, rendered for an agent ----------

/**
 * One finding, in the shape a prompt needs.
 *
 * Lives here rather than beside either prompt builder because BOTH build from it:
 * the dedicated fix run (`reviewFixPrompt.ts`) and the ordinary "get this PR
 * mergeable" run, which carries the findings when a review has produced some. Two
 * copies of this interface would let the two prompt families disagree about what
 * a finding is, which is the drift the shared package exists to prevent.
 */
export interface CodeReviewPromptFinding {
  severity: CodeReviewSeverity;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  body: string;
  suggestion: string | null;
}

/** `path:41-44`, `path:41`, or just `path` — whatever the finding actually knows. */
export function codeReviewFindingLocation(
  f: Pick<CodeReviewPromptFinding, 'filePath' | 'lineStart' | 'lineEnd'>
): string {
  if (!f.lineStart) return f.filePath;
  const end = f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : '';
  return `${f.filePath}:${f.lineStart}${end}`;
}

/**
 * The findings as one bullet, for a prompt that already presents a bullet list of
 * what is wrong with the pull request.
 *
 * Deliberately a different shape from `reviewFixPrompt`'s renderer, which emits
 * markdown headings: that one owns a whole section of its own template, and this
 * one is an item inside somebody else's list. Same facts, same order (most severe
 * first, which the caller's query provides), same numbering so the agent can
 * report back per finding.
 *
 * The commit is named because that is the claim being made: these findings were
 * read at that sha, and an agent that has just rebased needs to know whether it
 * is still looking at the same code.
 */
export function codeReviewFindingsIssue(
  findings: readonly CodeReviewPromptFinding[],
  headShaShort: string | null
): string {
  if (!findings.length) return '';
  const at = headShaShort ? ` on this exact commit (\`${headShaShort}\`)` : '';
  const items = findings.map((f, i) => {
    const suggestion = f.suggestion ? `\n     Suggested change: ${f.suggestion}` : '';
    // The body is indented as a continuation of its own numbered item so a
    // multi-paragraph argument cannot read as the start of the next finding.
    const body = f.body
      .split('\n')
      .map((line) => `     ${line}`)
      .join('\n');
    return `  ${i + 1}. [${CODE_REVIEW_SEVERITY_LABELS[f.severity]}] \`${codeReviewFindingLocation(f)}\` — ${f.title}\n${body}${suggestion}`;
  });
  return (
    `\n- Talyn's code review found ${findings.length} open finding(s)${at}. ` +
    'Fix these as part of this run, and say which of them you fixed. ' +
    'They are numbered so you can refer to them. If one of them is wrong about the code, ' +
    'say so and leave it alone rather than changing working code to satisfy it.\n' +
    items.join('\n')
  );
}
