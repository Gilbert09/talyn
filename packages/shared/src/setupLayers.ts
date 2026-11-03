/**
 * The Setup list: one ordered list of setup steps per repository, plus one
 * list for the whole workspace (Settings → Sandbox setup), and the layered
 * sandbox images the fleet builds from them.
 *
 * The fleet keeps a stack of images: the base image, a repo layer (the
 * repository at a commit plus the repository's OWN setup, shared by every
 * tenant that can read the repository), and a user layer (the workspace's
 * dotfiles and steps, then this repository's steps). One fleet tenant is one
 * Talyn workspace. A box boots the deepest image that exists and runs what the
 * image does not have.
 *
 * Learned steps come from `setupRecipe.ts`. They start as `suggested` and
 * Talyn accepts them under the frequency rule (`setupStepVerdict`). A person
 * can accept or dismiss a suggestion at any time.
 */
import type { RepositoryBake, BakeStep, BakeStepResult } from './bake.js';
import {
  bakeHostsFor,
  bakeWithLearnedSteps,
  LEARNED_PATH_LINE,
  mergeLearnedSetup,
  type AppliedSetupStep,
  type SetupStepKind,
  type SetupStepPhase,
  type SetupStepSource,
  type SetupTiming,
} from './setupRecipe.js';
import type { WorkbenchConfig } from './workbenchConfig.js';
import { shellQuote } from './workbenchGit.js';

/** Where a step runs. `image`: built into the user layer; `box`: on each new box; `both`: in the image and again on each box. */
export type SetupStepRunOn = 'image' | 'box' | 'both';
/** Who put the step in the list. */
export type SetupStepOrigin = 'user' | SetupStepSource;
/**
 * - `active`: in the list, it runs.
 * - `suggested`: Talyn learned it. It does not run until a person or the frequency rule accepts it.
 * - `dismissed`: a person dismissed it. It is not suggested again.
 * - `disabled`: it failed on `SETUP_STEP_MAX_BOX_FAILURES` boxes in a row. It does not run until a person retries it.
 */
export type SetupStepStatus = 'active' | 'suggested' | 'dismissed' | 'disabled';
/** `person`: never removed by Talyn. `talyn`: accepted by the frequency rule; Talyn removes it when few sessions need it. */
export type SetupStepAcceptedBy = 'person' | 'talyn';
/** The repository's own setup on each box: always, only when the checkout is not the image's commit, or never. */
export type RepoSetupRunOnBox = 'always' | 'moved' | 'never';
/** The image a box booted. `legacy` is a per-tenant golden from before layers. */
export type SandboxImageLayer = 'base' | 'legacy' | 'repo' | 'user';
/** Where the repository's own setup command came from. */
export type RepoSetupSource = 'talyn' | 'conductor-json' | 'conductor-toml' | 'none';

/** The user layer limits (Tom, 2026-11-03): 20 steps and 3600 seconds in all, for both sections together. */
export const USER_LAYER_MAX_STEPS = 20;
export const USER_LAYER_TOTAL_SEC = 3600;
/** Extra egress hosts the user layer may reach, for both sections together. The fleet's bake limit. */
export const USER_LAYER_MAX_HOSTS = 10;
/** The time limit of a step a person wrote, when they set none. */
export const USER_STEP_DEFAULT_SEC = 300;
/** The highest time limit of one step. */
export const USER_STEP_MAX_SEC = 3600;
/** A learned step's time limit in an image. A cargo install that compiles from source takes about ten minutes. */
export const LEARNED_LAYER_STEP_SEC = 900;
/** Steps in one list (repository or workspace) that a person can write. */
export const SETUP_LIST_MAX_USER_STEPS = 40;
/** The id of the dotfiles entry in the box setup's result lines. */
export const DOTFILES_STEP_ID = 'dotfiles';

/** One row of a Setup list. */
export interface SetupListStep {
  id: string;
  /** Null: a workspace step (Settings → Sandbox setup). */
  repositoryId: string | null;
  position: number;
  name: string;
  command: string;
  kind: SetupStepKind;
  runOn: SetupStepRunOn;
  origin: SetupStepOrigin;
  status: SetupStepStatus;
  /** Why the step is in its status, for example "Talyn removed this step on 2026-11-02: ..." */
  statusReason: string | null;
  statusChangedAt: string | null;
  acceptedBy: SetupStepAcceptedBy | null;
  timeoutSec: number | null;
  /** The step reads a secret or a credential file, so it can run only on the box. */
  boxOnlyReason: string | null;
  why: string | null;
  sourceWorkbenchId: string | null;
  seenCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When the step was accepted. */
  confirmedAt: string | null;
  /** When the step went into the image spec. Null: not yet (a learned step waits `SETUP_RECIPE_SETTLE_MS`). */
  imageAppliedAt: string | null;
  /** The step failed in an image build. It runs on the box instead. */
  imageFailedAt: string | null;
  imageFailureReason: string | null;
  /** Box setups in a row where the step failed. A success sets it to 0. */
  boxFailureCount: number;
  boxLastFailure: string | null;
  lastDurationMs: number | null;
  typicalDurationMs: number | null;
  measuredBoxes: number;
  /** Learned steps only: the recent sessions that needed the step, of all recent sessions. */
  recentNeededSessions?: number;
  recentSessions?: number;
  share?: number | null;
  heavy?: boolean;
  /** The frequency rule's reason, for a learned step. */
  verdictReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Row 0 of the repository Setup list: the repository's own setup, read from its files on each box start. */
export interface RepoSetupInfo {
  /** The setup command. Null: the repository has none, or Talyn has not read it yet. */
  command: string | null;
  source: RepoSetupSource | null;
  /** When a box last read it. Null: never. */
  readAt: string | null;
  runOnBox: RepoSetupRunOnBox;
}

/** What the newest box of the repository was told about its images. */
export interface SetupImageStatus {
  layer: SandboxImageLayer | null;
  /** The commit the repo layer holds. */
  repoCommit: string | null;
  repoLayerPending: boolean | null;
  userLayerPending: boolean | null;
  /** The repository's own setup failed in the repo layer build. The box runs it. */
  repoSetupOk: boolean | null;
  /** Step ids that the booted image holds. */
  appliedStepIds: string[];
  checkedAt: string;
  workbenchId: string | null;
}

/** `GET /repositories/:id/setup`. */
export interface RepositorySetup {
  repositoryId: string;
  learningDisabled: boolean;
  /** The window that a learned step's share counts sessions in. */
  windowDays: number;
  /** Learned steps that are active or recently seen. More are not learned. */
  maxLearnedSteps: number;
  limits: SetupListLimits;
  repoSetup: RepoSetupInfo;
  /** The repository's steps, in order. Dismissed steps are included, last. */
  steps: SetupListStep[];
  /** Extra hosts the image build may reach. */
  hosts: string[];
  image: SetupImageStatus | null;
  lastSetupTiming: SetupTiming | null;
  /** The newest box setups, newest first, at most {@link SETUP_TIMING_HISTORY}. */
  timingHistory: SetupTiming[];
}

export interface SetupListLimits {
  imageMaxSteps: number;
  imageTotalSec: number;
  maxHosts: number;
  maxUserSteps: number;
  stepMaxSec: number;
}

export const SETUP_LIST_LIMITS: SetupListLimits = {
  imageMaxSteps: USER_LAYER_MAX_STEPS,
  imageTotalSec: USER_LAYER_TOTAL_SEC,
  maxHosts: USER_LAYER_MAX_HOSTS,
  maxUserSteps: SETUP_LIST_MAX_USER_STEPS,
  stepMaxSec: USER_STEP_MAX_SEC,
};

/** Box setups kept per repository for the timing history. */
export const SETUP_TIMING_HISTORY = 20;

/** One step as a person sends it in a PUT. No id: a new step. */
export interface SetupListStepInput {
  id?: string;
  name: string;
  /** Required for a new step. A learned step's command cannot change. */
  command?: string;
  runOn: SetupStepRunOn;
  timeoutSec?: number | null;
}

/**
 * `PUT /repositories/:id/setup`. `steps` is the new order of the list. A
 * person's step that is not in it is deleted. A learned step that is not in it
 * keeps its status and goes after the listed steps: to remove one, dismiss it.
 */
export interface PutRepositorySetupInput {
  steps?: SetupListStepInput[];
  runOnBox?: RepoSetupRunOnBox;
  hosts?: string[];
  learningDisabled?: boolean;
}

export interface SandboxDotfiles {
  /** `owner/name`. */
  slug: string;
  /** Branch, tag or commit. Empty: the default branch. */
  ref: string;
  /** The install command. Null: the first of `install.sh`, `setup.sh`, `bootstrap`, `make install`. */
  install: string | null;
}

/** `GET /workspaces/:id/sandbox-setup`. */
export interface WorkspaceSandboxSetup {
  workspaceId: string;
  dotfiles: SandboxDotfiles | null;
  hosts: string[];
  steps: SetupListStep[];
  limits: SetupListLimits;
}

/** `PUT /workspaces/:id/sandbox-setup`. Each field you send replaces it. */
export interface PutWorkspaceSandboxSetupInput {
  dotfiles?: SandboxDotfiles | null;
  hosts?: string[];
  steps?: SetupListStepInput[];
}

// ============================================================================
// Mapping from the old shapes
// ============================================================================

/** The kinds that start something. They run on each box; the rest install. */
const BOX_KINDS = new Set<SetupStepKind>(['docker', 'service', 'compose', 'database', 'other']);

/** A new learned step's place. Installs go into the image; what starts a service runs on each box. */
export function defaultRunOn(kind: SetupStepKind, phase?: SetupStepPhase): SetupStepRunOn {
  if (phase) return phase === 'start' ? 'box' : 'image';
  return BOX_KINDS.has(kind) ? 'box' : 'image';
}

/** The old phase of a step, for the rules that read it (`setupStepUses`). */
export function phaseOfRunOn(runOn: SetupStepRunOn): SetupStepPhase {
  return runOn === 'box' ? 'start' : 'install';
}

/** A short name for a learned step: its command on one line. */
export function setupStepName(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

// ============================================================================
// The create body: `layers`
// ============================================================================

/** One step of the user layer, as the fleet takes it. */
export interface LayerStep {
  id: string;
  name: string;
  run: string;
  timeoutSec?: number;
}

/** `layers.user` of the create body (plan §10.5). */
export interface UserLayerSpec {
  specVersion: 1;
  wide: { dotfiles?: { slug: string; ref: string; install?: string }; steps: LayerStep[] };
  repo: { steps: LayerStep[] };
  hosts?: string[];
  env?: Record<string, string>;
}

/** `layers` of the create body. `user: null`: boot the repo layer, no user layer wanted. */
export interface CreateSandboxLayers {
  repo: { slug: string; baseBranch: string };
  user: UserLayerSpec | null;
}

/** A step that may go into an image: active, accepted into the image, not failed there. */
export interface LayerCandidate {
  id: string;
  name: string;
  command: string;
  kind: SetupStepKind;
  origin: SetupStepOrigin;
  timeoutSec: number | null;
}

function layerStep(step: LayerCandidate): LayerStep {
  const timeoutSec = step.timeoutSec
    ?? (step.origin === 'user' ? USER_STEP_DEFAULT_SEC : LEARNED_LAYER_STEP_SEC);
  return {
    id: step.id,
    name: step.name.slice(0, 128) || step.id,
    // Learned installs put their commands under $HOME; later steps need them on the PATH.
    run: step.origin === 'user' ? step.command : `${LEARNED_PATH_LINE}\n${step.command}`,
    timeoutSec: Math.min(USER_STEP_MAX_SEC, Math.max(1, Math.round(timeoutSec))),
  };
}

/**
 * The user layer spec: the workspace section first, then the repository
 * section, each in list order, inside {@link USER_LAYER_MAX_STEPS} steps,
 * {@link USER_LAYER_TOTAL_SEC} seconds and {@link USER_LAYER_MAX_HOSTS} hosts.
 * The list stops at the first step that does not fit, so a step never goes
 * into the image without the steps before it: what does not fit runs on the
 * box. Null when there is nothing to build.
 */
export function buildUserLayerSpec(input: {
  dotfiles: SandboxDotfiles | null;
  wide: LayerCandidate[];
  repo: LayerCandidate[];
  /** The hosts a person allowed: the workspace's, then the repository's. */
  hosts: string[];
}): { spec: UserLayerSpec | null; includedIds: string[] } {
  const hosts = new Set<string>();
  for (const host of input.hosts) if (hosts.size < USER_LAYER_MAX_HOSTS) hosts.add(host);
  let seconds = 0;
  let count = 0;
  let full = false;
  const includedIds: string[] = [];
  const take = (steps: LayerCandidate[]): LayerStep[] => {
    const out: LayerStep[] = [];
    for (const step of steps) {
      if (full) break;
      const built = layerStep(step);
      const needed = step.origin === 'user' ? [] : bakeHostsFor(step).filter((h) => !hosts.has(h));
      if (count + 1 > USER_LAYER_MAX_STEPS || seconds + (built.timeoutSec ?? 0) > USER_LAYER_TOTAL_SEC
        || hosts.size + needed.length > USER_LAYER_MAX_HOSTS) {
        full = true;
        break;
      }
      needed.forEach((h) => hosts.add(h));
      count += 1;
      seconds += built.timeoutSec ?? 0;
      includedIds.push(step.id);
      out.push(built);
    }
    return out;
  };
  const wideSteps = take(input.wide);
  const repoSteps = take(input.repo);
  const dotfiles = input.dotfiles?.slug
    ? {
        slug: input.dotfiles.slug,
        ref: input.dotfiles.ref,
        ...(input.dotfiles.install?.trim() ? { install: input.dotfiles.install.trim() } : {}),
      }
    : undefined;
  if (!dotfiles && wideSteps.length === 0 && repoSteps.length === 0) return { spec: null, includedIds: [] };
  return {
    spec: {
      specVersion: 1,
      wide: { ...(dotfiles ? { dotfiles } : {}), steps: wideSteps },
      repo: { steps: repoSteps },
      ...(hosts.size ? { hosts: [...hosts].sort() } : {}),
    },
    includedIds,
  };
}

/**
 * The legacy `bake` field, for a host that does not take `layers` yet: the
 * person's own image steps of the repository as the repository's bake, then
 * the learned image steps (`bakeWithLearnedSteps`, 10 steps and 1800 s). The
 * same bake the repository got before the Setup list. `userStepIds`: the
 * person's steps in it. On such a host a box never runs them, as before.
 */
export function legacyBakeFor(input: {
  user: LayerCandidate[];
  learned: AppliedSetupStep[];
  hosts: string[];
  /** The repository stored an explicit (maybe empty) bake: send it, so the fleet's stored bake clears. */
  explicit: boolean;
}): { bake: RepositoryBake | null; userStepIds: string[] } {
  const steps: BakeStep[] = [];
  const userStepIds: string[] = [];
  for (const step of input.user) {
    if (steps.length >= 10) break;
    steps.push({
      name: step.name.slice(0, 128) || step.id,
      run: step.command,
      ...(step.timeoutSec ? { timeoutSec: Math.min(1800, step.timeoutSec) } : {}),
    });
    userStepIds.push(step.id);
  }
  const hosts = input.hosts.slice(0, 10);
  const own: RepositoryBake | null = steps.length > 0 || input.explicit
    ? { steps, ...(steps.length > 0 && hosts.length ? { hosts } : {}) }
    : null;
  return { bake: bakeWithLearnedSteps(own, input.learned), userStepIds };
}

// ============================================================================
// The create response and the box
// ============================================================================

/** The result of one user layer step, as the create response carries it. */
export type LayerStepResult = BakeStepResult & { id?: string };

/**
 * What a box knows about its image. Talyn writes it into the box at the clone
 * ({@link BOX_LAYER_FILE}), so a later read of the box config (the Scripts
 * panel, a resume) builds the same setup.
 */
export interface BoxLayerContext {
  /** Null: a host that does not report layers. */
  layer: SandboxImageLayer | null;
  /** The host reported `appliedStepIds`. False: the old rule (a person's image steps never run on the box). */
  layerAware: boolean;
  /** Step ids the image holds. For an old host: the person's steps in the legacy bake. */
  appliedStepIds: string[];
  repoCommit: string | null;
  repoSetupOk: boolean | null;
  /** HEAD after the checkout. */
  checkoutCommit: string | null;
}

/** Where the clone script writes the box's {@link BoxLayerContext}, outside the work tree. */
export const BOX_LAYER_FILE = '/work/.talyn-box-layer.json';

/** The context from a create response, or the old rule when the host reports nothing. */
export function boxLayerContextFrom(
  response: {
    layer?: string | null;
    goldenLayer?: string | null;
    appliedStepIds?: string[] | null;
    repoCommit?: string | null;
    repoSetupOk?: boolean | null;
  } | null | undefined,
  legacyUserStepIds: string[],
): BoxLayerContext {
  const raw = response?.layer ?? null;
  const layer = raw === 'base' || raw === 'legacy' || raw === 'repo' || raw === 'user' ? raw : null;
  const layerAware = Array.isArray(response?.appliedStepIds);
  return {
    layer,
    layerAware,
    appliedStepIds: layerAware ? response!.appliedStepIds!.filter((id) => typeof id === 'string') : legacyUserStepIds,
    repoCommit: typeof response?.repoCommit === 'string' && response.repoCommit ? response.repoCommit : null,
    repoSetupOk: typeof response?.repoSetupOk === 'boolean' ? response.repoSetupOk : null,
    checkoutCommit: null,
  };
}

/** Read the box's context file. Anything that is not one gives null: the old rule. */
export function parseBoxLayerContext(text: string | null | undefined): BoxLayerContext | null {
  if (!text?.trim()) return null;
  try {
    const raw = JSON.parse(text) as Partial<BoxLayerContext>;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.appliedStepIds)) return null;
    return {
      layer: raw.layer === 'base' || raw.layer === 'legacy' || raw.layer === 'repo' || raw.layer === 'user' ? raw.layer : null,
      layerAware: raw.layerAware === true,
      appliedStepIds: raw.appliedStepIds.filter((id): id is string => typeof id === 'string'),
      repoCommit: typeof raw.repoCommit === 'string' ? raw.repoCommit : null,
      repoSetupOk: typeof raw.repoSetupOk === 'boolean' ? raw.repoSetupOk : null,
      checkoutCommit: typeof raw.checkoutCommit === 'string' ? raw.checkoutCommit : null,
    };
  } catch {
    return null;
  }
}

/** The box booted an image with the repository checked out at `/work/repo`. */
export function hasPrebakedCheckout(ctx: Pick<BoxLayerContext, 'layer'> | null, prebakedCheckout?: boolean | null): boolean {
  if (prebakedCheckout === false) return false;
  return ctx?.layer === 'repo' || ctx?.layer === 'user' || ctx?.layer === 'legacy';
}

/**
 * Does the repository's own setup run on this box? Always when the image does
 * not hold it: a base or legacy image, a repo layer whose setup failed, or an
 * old host. Else the knob.
 */
export function repoSetupRunsOnBox(runOnBox: RepoSetupRunOnBox, ctx: BoxLayerContext | null): boolean {
  if (runOnBox === 'always') return true;
  if (!ctx || (ctx.layer !== 'repo' && ctx.layer !== 'user') || ctx.repoSetupOk === false) return true;
  if (runOnBox === 'never') return false;
  if (!ctx.repoCommit || !ctx.checkoutCommit) return true;
  return ctx.repoCommit !== ctx.checkoutCommit;
}

/** A step the box may run. */
export interface BoxCandidate extends AppliedSetupStep {
  runOn: SetupStepRunOn;
  origin: SetupStepOrigin;
}

/**
 * The steps that run on this box, in list order. `box` and `both` always run.
 * An `image` step runs when the image does not hold it. On a host that does not
 * report layers, the old rule: a person's image steps (the legacy bake) never
 * run on the box, and learned steps always do.
 */
export function boxStepsToRun<T extends BoxCandidate>(steps: T[], ctx: BoxLayerContext | null): T[] {
  const applied = new Set(ctx?.appliedStepIds ?? []);
  return steps.filter((step) => {
    if (step.runOn !== 'image') return true;
    // A box from before the Setup list wrote no context: the person's image steps were its bake.
    if (!ctx) return step.origin !== 'user';
    if (ctx.layerAware) return !applied.has(step.id);
    // An old host: the person's steps in the legacy bake never ran on a box.
    return step.origin !== 'user' || !applied.has(step.id);
  });
}

/** The box command for the dotfiles: clone once, then the install. */
export function dotfilesBoxCommand(dotfiles: SandboxDotfiles): string {
  const url = shellQuote(`https://github.com/${dotfiles.slug}.git`);
  const branch = dotfiles.ref.trim() ? ` --branch ${shellQuote(dotfiles.ref.trim())}` : '';
  const install = dotfiles.install?.trim()
    ? dotfiles.install.trim()
    : [
        'for f in install.sh setup.sh bootstrap; do',
        '  if [ -f "$f" ]; then bash "./$f"; exit $?; fi',
        'done',
        'if [ -f Makefile ] && grep -q "^install:" Makefile; then make install; fi',
      ].join('\n');
  return [
    `if [ ! -d "$HOME/.dotfiles/.git" ]; then git clone --depth 1${branch} ${url} "$HOME/.dotfiles"; fi`,
    'cd "$HOME/.dotfiles"',
    install,
  ].join('\n');
}

/**
 * The box's setup script: the repository's own setup (when it runs), then the
 * dotfiles when the image does not hold them, then the steps in list order
 * (the workspace's, then the repository's). Each step is timed and reported
 * on a `[talyn] learned step result` line, as before.
 */
export function boxSetupScript(
  config: WorkbenchConfig,
  input: {
    steps: BoxCandidate[];
    runRepoSetup: boolean;
    dotfiles: SandboxDotfiles | null;
    ctx: BoxLayerContext | null;
  },
): WorkbenchConfig {
  const own = input.runRepoSetup ? config : { ...config, setup: undefined };
  const steps: AppliedSetupStep[] = [];
  if (input.dotfiles?.slug && input.ctx?.layer !== 'user') {
    steps.push({ id: DOTFILES_STEP_ID, command: dotfilesBoxCommand(input.dotfiles), kind: 'other', phase: 'install', timeoutSec: 600 });
  }
  steps.push(...boxStepsToRun(input.steps, input.ctx));
  if (steps.length === 0) return own;
  return mergeLearnedSetup(own, steps, { keepOrder: true });
}

/** Fill the checkout commit into a context, after the clone script printed it. */
export function withCheckoutCommit(ctx: BoxLayerContext, stdout: string): BoxLayerContext {
  const line = stdout.trim().split('\n').pop()?.trim() ?? '';
  return { ...ctx, checkoutCommit: /^[0-9a-f]{40}$/.test(line) ? line : ctx.checkoutCommit };
}
