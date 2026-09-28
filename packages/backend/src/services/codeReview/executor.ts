import { v4 as uuid } from 'uuid';
import {
  CODE_REVIEW_FINDINGS_SENTINEL,
  CODE_REVIEW_PRESET_PLAN,
  codeReviewDedupeKey,
  codeReviewUnitCount,
  isCodeReviewPreset,
  parseCodeReviewFindings,
  type CodeReviewPhase,
  type CodeReviewPreset,
  type RawCodeReviewFinding,
  findingsEligibleForAutoFix,
  filesWorthReviewing,
  selectLensesForFiles,
} from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { pullRequests as pullRequestsTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { resolveCloudEnvChain } from '../prCloudFix.js';
import { dispatchSandboxRun } from '../selfHosted/sandboxRun.js';
import { reviewSystemPrompt } from '../selfHosted/systemPrompts.js';
import { startCodeRun } from '../posthogCode/codeRun.js';
import { listFleetHosts, hostIsDispatchable } from '../fleetHosts.js';
import { workspaceMayUseCodeReview } from '../codeReviewAccess.js';
import {
  buildJudgePrompt,
  buildLensPrompt,
  buildSweepPrompt,
  lensByKey,
  lensesForPreset,
  type ReviewPromptContext,
} from './lenses.js';
import {
  applyJudgement,
  findingsForJudging,
  listFindings,
  markStale,
  upsertFindings,
} from './findings.js';
import {
  appendReviewEvent,
  casTransition,
  claimRun,
  countLiveUnits,
  countUnitsDispatchedSince,
  getPrForReview,
  getReview,
  patchRun,
  runsForCycle,
  settleRun,
  type ReviewRow,
  type RunFailureCode,
  type RunKind,
  type RunRow,
} from './store.js';
import type { Action, UnitKey } from './decide.js';
import { startFixRun } from './fix.js';
import { captureCycleFailed, captureCycleFinished } from './analytics.js';
import { workspaceReviewSettings } from './cycle.js';

/**
 * Performing what `decide` asked for.
 *
 * Everything that reads, writes, dispatches or spends money is here; the phase
 * graph itself is next door and pure.
 */

// ---------- Pacing ----------

/**
 * How many of one workspace's review units may be live at once.
 *
 * Three, and the number is about the hardware rather than the plan: the fleet is
 * one box whose memory budget fits a couple of concurrent runs alongside whatever
 * ordinary task work is happening. A wider fan-out does not go faster — it gets
 * refused and spills onto the metered fall-back provider.
 *
 * There is NO advisory lock around the check, deliberately, and the contrast with
 * the plan gate is the point: losing this race costs one extra microVM, which the
 * fleet itself refuses with a 503 the spill path already handles. Losing the plan
 * gate's race lets a free user run two cycles. Do not "fix" one by copying the
 * other.
 */
export const MAX_LIVE_UNITS_PER_WORKSPACE = 3;

/**
 * How long a dispatch stays invisible to the fleet's own capacity report.
 *
 * Hosts push a snapshot every ~15 seconds, so `runsLive` lags. Without counting
 * our own very recent dispatches, a burst all reads the same stale "there is
 * room" and overshoots together.
 */
const CAPACITY_BLIND_WINDOW_MS = 20_000;

/** Free memory a host must still have before we ask it for another microVM. */
const MIN_FREE_MEM_MIB = 2048;

/**
 * At most this many units of one cycle may run on the fall-back provider.
 *
 * PostHog Code accepts no turn, spend or time cap at all — only a cancel — so
 * unbounded spill converts a capacity refusal into unmetered spending. Two keeps a
 * review finishable when the fleet is full without turning a queueing problem
 * into a billing one.
 */
export const MAX_SPILLED_UNITS_PER_CYCLE = 2;

/**
 * Wall-clock ceiling per unit, in seconds.
 *
 * Justified by the product rather than by measurement, which is the honest
 * position: this is a watched, foreground interaction with a progress bar, nobody
 * waits past about a quarter of an hour, and a unit still going then will not
 * produce a review anybody reads. These are the first time-outs Talyn has ever
 * sent the fleet.
 *
 * `maxTurns` and `maxBudgetUsd` are deliberately NOT sent. A defensible turn cap
 * is (files opened + greps + 1) and nobody knows that distribution for these
 * repositories yet; a guessed one truncates the good reviews and saves nothing on
 * the bad. Cost per unit is recorded instead, and the caps come from real numbers.
 */
const UNIT_TIMEOUT_SEC: Record<string, number> = {
  lens: 900,
  sweep: 1200,
  validate: 1200,
  repair: 120,
};

export interface CapacityView {
  /** How many units this pass may fire. */
  unitsAllowed: number;
  /** Whether the fleet has room, which decides where a unit is offered first. */
  fleetHasRoom: boolean;
}

/**
 * How much room there is for this workspace's units right now.
 *
 * The fleet reading is a DATABASE read of the host registry, not an HTTP call:
 * hosts report inwards every ~15 seconds and dialling one per unit would cost
 * more than letting the occasional 503 happen.
 */
export async function readCapacity(workspaceId: string): Promise<CapacityView> {
  const live = await countLiveUnits(workspaceId);
  const unitsAllowed = Math.max(0, MAX_LIVE_UNITS_PER_WORKSPACE - live);
  if (unitsAllowed === 0) return { unitsAllowed: 0, fleetHasRoom: false };

  const hosts = await listFleetHosts().catch(() => []);
  const justDispatched = await countUnitsDispatchedSince(
    new Date(Date.now() - CAPACITY_BLIND_WINDOW_MS)
  ).catch(() => 0);

  const fleetHasRoom = hosts.some((host) => {
    if (!hostIsDispatchable(host)) return false;
    const slots = (host.runsMax ?? 0) - (host.runsLive ?? 0) - justDispatched;
    const freeMem = (host.memBudgetMib ?? 0) - (host.memReservedMib ?? 0);
    return slots > 0 && freeMem >= MIN_FREE_MEM_MIB;
  });

  return { unitsAllowed, fleetHasRoom };
}

// ---------- Prompt context ----------

/**
 * Everything a unit's prompt needs about the pull request.
 *
 * Fetched once per evaluation pass that dispatches, rather than once per unit: a
 * five-unit fan-out asking GitHub for the same file list five times is five times
 * the rate budget for one answer.
 */
async function loadPromptContext(
  review: ReviewRow
): Promise<{ ctx: ReviewPromptContext; headSha: string; headBranch: string } | null> {
  const pr = await getPrForReview(review.pullRequestId);
  if (!pr) return null;
  const summary = (pr.lastSummary ?? {}) as {
    title?: string;
    headBranch?: string;
    baseBranch?: string;
    headSha?: string;
  };

  const files = await githubService
    .getPRFiles(review.workspaceId, pr.owner, pr.repo, pr.number)
    .catch(() => []);

  const body = await loadPrBody(review.pullRequestId);

  return {
    headSha: summary.headSha ?? '',
    headBranch: summary.headBranch ?? '',
    ctx: {
      ref: `${pr.owner}/${pr.repo}#${pr.number}`,
      title: summary.title ?? '',
      body,
      headBranch: summary.headBranch ?? '',
      baseBranch: summary.baseBranch ?? '',
      // Lock files, vendored trees, snapshots and generated output are dropped
      // before a reviewer ever sees them. They are large, nobody writes them,
      // and they are noise-dense — a reviewer told to look hard at a thousand
      // near-identical generated lines will find something to say, which then
      // costs a judging pass to throw away.
      files: filesWorthReviewing(files).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
      chunkIndex: 1,
      chunkTotal: review.chunkTotal,
    },
  };
}

/**
 * The PR description, read on its own.
 *
 * `pull_requests.body` is a column rather than a key in `lastSummary` precisely so
 * the poll loops never ship it, so reading it needs its own query. Failing to get
 * it is not worth failing a review over — the diff is the material.
 */
async function loadPrBody(pullRequestId: string): Promise<string> {
  const rows = await getDbClient()
    .select({ body: pullRequestsTable.body })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, pullRequestId))
    .limit(1);
  return rows[0]?.body ?? '';
}

/** The files one chunk is responsible for. */
function filesForChunk(
  files: ReviewPromptContext['files'],
  chunkIndex: number,
  chunkTotal: number
): ReviewPromptContext['files'] {
  if (chunkTotal <= 1) return files;
  // Round-robin by position rather than by directory, which is the honest v1:
  // directory affinity is the better split and needs measuring before it earns
  // the complexity. Deterministic either way, so a retry reads the same files.
  return files.filter((_, i) => i % chunkTotal === chunkIndex);
}

// ---------- Preparing ----------

/**
 * Work out the cycle's shape and move it to `reviewing`.
 *
 * The preset's resolution is FROZEN here — lenses, sweep, judge, chunk count and
 * the unit total all land on the row — because a release can change the preset
 * table while a cycle is in flight and a cycle must finish as the thing it
 * started as. The same argument as `metadata.internetAccess` riding on a task.
 */
export async function prepareCycle(review: ReviewRow): Promise<void> {
  const preset: CodeReviewPreset = isCodeReviewPreset(review.preset) ? review.preset : 'standard';
  const plan = CODE_REVIEW_PRESET_PLAN[preset];

  const loaded = await loadPromptContext(review);
  if (!loaded) {
    await failCycle(review, 'pr_missing', 'The pull request is no longer being tracked.');
    return;
  }
  if (!loaded.headSha) {
    await failCycle(
      review,
      'head_unknown',
      'Talyn does not know which commit to review yet. Refresh the pull request and try again.'
    );
    return;
  }

  const chunkTotal = plan.chunk ? chunkCountFor(loaded.ctx.files) : 1;

  // Which reviewers this change actually needs, decided HERE because this is
  // where the file list first exists — and because `runsTotal` is written in
  // the same transition. Selecting anywhere later would mean a progress bar
  // that promised five steps and delivered four.
  const { selected, skipped } = selectLensesForFiles(lensesForPreset(preset), loaded.ctx.files);
  const runsTotal = codeReviewUnitCount(preset, chunkTotal, selected.length);

  await casTransition(
    review.id,
    review.version,
    {
      phase: 'reviewing',
      phaseStartedAt: new Date(),
      lensKeys: selected,
      sweep: plan.sweep,
      validate: plan.validate,
      chunkTotal,
      runsTotal,
      targetHeadSha: loaded.headSha,
    },
    {
      fromPhase: 'preparing',
      toPhase: 'reviewing',
      trigger: 'executor',
      code: 'cycle_planned',
      message: skipped.length
        ? `Reviewing ${loaded.ctx.files.length} changed files with ${selected.length} of ` +
          `${selected.length + skipped.length} reviewers.`
        : `Reviewing ${loaded.ctx.files.length} changed files.`,
      // The skips are RECORDED, with their reasons, because a reviewer that
      // never ran finds nothing and nothing looks exactly like a clean bill of
      // health. This is what lets the app say which ones sat out and why.
      detail: { preset, chunkTotal, runsTotal, headSha: loaded.headSha, skippedLenses: skipped },
    }
  );
}

/**
 * How many pieces a large pull request is read in.
 *
 * Provisional, and marked as such. The anchor that matters is how much a lens can
 * hold and still reason about, which is a measurement nobody has taken for these
 * repositories yet — so this is a deliberately coarse split by file count, and the
 * experiment that replaces it is comparing findings-per-file on one large PR read
 * whole against the same PR read in pieces.
 */
const FILES_PER_CHUNK = 25;

function chunkCountFor(files: unknown[]): number {
  return Math.max(1, Math.ceil(files.length / FILES_PER_CHUNK));
}

// ---------- Dispatching a unit ----------

/**
 * Claim one unit and boot an agent for it.
 *
 * Claim first, ALWAYS. The insert is what stops two evaluation passes both paying
 * for one lens, and it has to happen before anything expensive: a claim that loses
 * costs one wasted insert, while a dispatch that loses costs a microVM.
 *
 * A capacity refusal leaves the unit claimed with no `dispatched_at`, which is
 * exactly the state the reconciler retries — the unit is not burned, and the user
 * sees "waiting for a runner" rather than a failure.
 */
export async function dispatchUnit(review: ReviewRow, unit: UnitKey): Promise<void> {
  const runId = uuid();
  const claim = await claimRun(runId, {
    reviewId: review.id,
    workspaceId: review.workspaceId,
    cycle: review.cycle,
    kind: unit.kind,
    lens: unit.lens,
    chunkIndex: unit.chunkIndex,
    chunkTotal: review.chunkTotal,
  });
  // Somebody else owns it. Their pass will dispatch it; ours must not.
  if (!claim.fresh) return;

  // Re-checked at FIRE time as well as at the route, because a workspace can
  // lose the flag's audience without anything touching a row, and a gate that
  // only runs where a client can see it is a decoration.
  if (!(await workspaceMayUseCodeReview(review.workspaceId))) {
    await settleRun(claim.id, { status: 'skipped', failureCode: 'no_provider' });
    await appendReviewEvent(review.id, {
      toPhase: review.phase as CodeReviewPhase,
      trigger: 'executor',
      code: 'not_in_audience',
      message: 'Code review is no longer available for this workspace.',
    });
    return;
  }

  const loaded = await loadPromptContext(review);
  if (!loaded) {
    await settleRun(claim.id, { status: 'failed', failureCode: 'dispatch_failed' });
    return;
  }

  const prompt = await buildUnitPrompt(review, unit, loaded.ctx);
  if (!prompt) {
    await settleRun(claim.id, { status: 'skipped', failureCode: 'dispatch_failed' });
    return;
  }

  const chain = await resolveCloudEnvChain(review.workspaceId);
  if (!chain.length) {
    await settleRun(claim.id, { status: 'failed', failureCode: 'no_provider' });
    await appendReviewEvent(review.id, {
      toPhase: review.phase as CodeReviewPhase,
      trigger: 'executor',
      code: 'no_provider',
      message: 'No agent is connected for this workspace.',
    });
    return;
  }

  const spilled = (await runsForCycle(review.id, review.cycle)).filter(
    (r) => r.provider === 'posthog_code'
  ).length;

  await patchRun(claim.id, { status: 'dispatching' });

  for (const link of chain) {
    if (link.provider === 'selfhosted') {
      const result = await dispatchSandboxRun({
        runId: `talyn-rev-${claim.id}`,
        workspaceId: review.workspaceId,
        repositoryId: review.repositoryId,
        taskType: 'code_writing',
        prompt,
        systemPrompt: reviewSystemPrompt(CODE_REVIEW_FINDINGS_SENTINEL),
        // Read the pull request's own head, not trunk. Nothing else in Talyn
        // sends this, and it is the whole reason the seam grew the field.
        ...(loaded.headBranch ? { targetRef: loaded.headBranch } : {}),
        modelTier: unitModelTier(
          isCodeReviewPreset(review.preset) ? review.preset : 'standard',
          unit.kind
        ),
        budget: { timeoutSec: UNIT_TIMEOUT_SEC[unit.kind] ?? 900 },
      });
      if (result.ok) {
        await patchRun(claim.id, {
          status: 'running',
          provider: 'selfhosted',
          model: result.handle.model,
          sandboxId: result.handle.sandbox.id,
          host: result.handle.host ?? null,
          endpoint: result.handle.endpoint,
          dispatchedAt: new Date(),
        });
        return;
      }
      if (!result.capacity) {
        await settleRun(claim.id, { status: 'failed', failureCode: 'dispatch_failed' });
        await appendReviewEvent(review.id, {
          toPhase: review.phase as CodeReviewPhase,
          trigger: 'executor',
          code: 'dispatch_failed',
          message: result.error,
        });
        return;
      }
      // Busy or unreachable. Fall through to the next link.
      continue;
    }

    if (link.provider === 'posthog_code') {
      if (spilled >= MAX_SPILLED_UNITS_PER_CYCLE) break;
      const result = await startCodeRun({
        workspaceId: review.workspaceId,
        repositoryId: review.repositoryId,
        title: `Code review · ${unit.kind}${unit.lens ? ` · ${unit.lens}` : ''} · ${loaded.ctx.ref}`,
        // This provider cannot be told which ref to read, so the prompt has to
        // ask for the checkout itself.
        prompt: `First run \`gh pr checkout ${loaded.ctx.ref.split('#')[1]}\` so you are reading the pull request under review.\n\n${prompt}`,
      });
      if (result.ok) {
        await patchRun(claim.id, {
          status: 'running',
          provider: 'posthog_code',
          model: result.model,
          remoteTaskId: result.remoteTaskId,
          remoteRunId: result.remoteRunId,
          dispatchedAt: new Date(),
        });
        return;
      }
      await settleRun(claim.id, { status: 'failed', failureCode: 'dispatch_failed' });
      return;
    }
  }

  // Nothing had room. The unit stays claimed with no dispatch time, which is the
  // state the reconciler retries — and it is reported, because a silent deferral
  // is indistinguishable from a broken feature.
  await patchRun(claim.id, { status: 'claimed', failureCode: 'capacity_deferred' });
  await appendReviewEvent(review.id, {
    toPhase: review.phase as CodeReviewPhase,
    trigger: 'executor',
    code: 'capacity_deferred',
    message: 'Waiting for a runner.',
    detail: { kind: unit.kind, lens: unit.lens, chunkIndex: unit.chunkIndex },
  });
}

async function buildUnitPrompt(
  review: ReviewRow,
  unit: UnitKey,
  ctx: ReviewPromptContext
): Promise<string | null> {
  const scoped: ReviewPromptContext = {
    ...ctx,
    files: filesForChunk(ctx.files, unit.chunkIndex, review.chunkTotal),
    chunkIndex: unit.chunkIndex + 1,
    chunkTotal: review.chunkTotal,
  };

  if (unit.kind === 'lens') {
    const lens = lensByKey(unit.lens);
    return lens ? buildLensPrompt(lens, scoped) : null;
  }

  if (unit.kind === 'sweep') {
    const covered = (await listFindings(review.id)).map((f) => ({
      severity: f.severity,
      filePath: f.filePath,
      title: f.title,
    }));
    return buildSweepPrompt(scoped, covered, (review.lensKeys as string[]) ?? []);
  }

  if (unit.kind === 'validate') {
    const candidates = await findingsForJudging(review.id, review.cycle);
    // Nothing to judge is not a failure — it is the clean review, and the phase
    // should move on without spending a sandbox to confirm an empty list.
    if (!candidates.length) return null;
    return buildJudgePrompt(
      scoped,
      candidates.map((c) => ({
        id: c.dedupeKey,
        severity: c.severity,
        filePath: c.filePath,
        lines: c.lineStart ? `${c.lineStart}${c.lineEnd ? `-${c.lineEnd}` : ''}` : '?',
        title: c.title,
        body: c.body,
      }))
    );
  }

  return null;
}


/**
 * Which model tier a unit runs at.
 *
 * The sweep and the judge escalate on EVERY preset, and the reason is what each
 * one is for: the sweep reads every lens's output at once, which is the largest
 * context this pipeline ever assembles, and the judge's whole job is to say NO to
 * a plausible wrong finding. Both are the investigative shape the strongest model
 * earns its cost on, and running them on the cheap model — which is what happened
 * on the first real review, where all eight units were Sonnet — makes "Deep"
 * differ from "Standard" only in how many reviewers there are.
 *
 * A preset whose own plan says `effort: 'top'` escalates its lenses too.
 */
export function unitModelTier(preset: CodeReviewPreset, kind: RunKind): 'default' | 'top' {
  // DISABLED, deliberately, and not by deleting the mechanism.
  //
  // Escalation picks the top catalogue entry for the vendor, which is currently
  // claude-fable-5-1 — and the fleet's Claude Code refuses it outright:
  //
  //   400 invalid_request_error
  //   "Claude Code 2.1.75 does not support this model; version 2.1.251 or newer
  //    is required."  (error_code: claude_code_version_too_old)
  //
  // The catalogue says what ANTHROPIC serves; it says nothing about what the
  // agent runtime inside the microVM can drive, and those are different
  // questions. Nothing checked the second one, so both judging units failed on
  // every review the moment this shipped — the lenses ran on Sonnet and
  // survived, so the symptom was not a broken review but an UNJUDGED one, with
  // every finding left unvalidated and the precision bar silently absent.
  //
  // A failed judge is worse than a cheap one, so this returns to the workspace's
  // own model until the fleet's Claude Code is new enough. Re-enable by deleting
  // this early return — the rest of the mechanism is correct and tested, and the
  // cross-vendor guard in topFleetModelForModel still holds.
  void preset;
  void kind;
  return 'default';
}


/**
 * A failure that happened BEFORE the agent ran, read from the harness's words.
 *
 * These are not bad output — they are no output, because nothing started. The
 * difference matters to whoever reads the review: "the reviewer produced
 * something we could not parse, try again" is reasonable advice for a garbled
 * reply and useless for a run that cannot begin, where trying again fails the
 * same way for the same reason every time.
 *
 * Matched on the harness's own error text rather than on a status, because
 * neither provider reports a spawn failure as anything but a completed run with
 * an error string in it.
 */
function harnessFailure(
  text: string | null
): { code: RunFailureCode; message: string } | null {
  if (!text) return null;
  if (text.includes('E2BIG')) {
    return {
      code: 'prompt_too_large',
      message:
        'This change is too large to send to a reviewer in one piece. Talyn now sends ' +
        'less of the diff inline and asks the reviewer to read the rest from the ' +
        'checkout, so reviewing again should work.',
    };
  }
  if (/\bENOSPC\b/.test(text)) {
    return {
      code: 'runner_out_of_space',
      message: 'The machine running the review ran out of disk. This is ours to fix.',
    };
  }
  if (/\bENOMEM\b/.test(text)) {
    return {
      code: 'runner_out_of_memory',
      message: 'The machine running the review ran out of memory. This is ours to fix.',
    };
  }
  return null;
}

// ---------- Ingesting a unit's output ----------

/**
 * Take one settled unit's final message and record what it produced.
 *
 * Absence is a FAILED unit, never an empty one. That is the single most important
 * line in this file: a unit whose output we could not read has told us nothing,
 * and recording it as "found nothing" would turn a broken agent into a clean bill
 * of health.
 */
export async function ingestUnitOutput(
  review: ReviewRow,
  run: RunRow,
  finalText: string | null
): Promise<{ parsed: boolean; findings: number }> {
  const parsed = parseCodeReviewFindings(finalText);
  if (!parsed.ok) {
    // A unit that never STARTED is not a unit that produced bad output, and
    // calling both "unparseable" told the user to try again — advice that would
    // fail in exactly the same way, for the same reason, every time. The
    // harness's own words are the evidence here, so they are what is read.
    const harness = harnessFailure(finalText);
    await patchRun(run.id, {
      parseAttempts: run.parseAttempts + 1,
      parseError: `${parsed.error}\n---\n${(finalText ?? '').slice(-2000)}`,
    });
    await settleRun(run.id, {
      status: 'failed',
      failureCode: harness ? harness.code : 'unparseable',
    });
    await appendReviewEvent(review.id, {
      toPhase: review.phase as CodeReviewPhase,
      trigger: 'poller',
      code: harness ? harness.code : 'unparseable',
      message: harness ? harness.message : parsed.error,
      detail: { kind: run.kind, lens: run.lens },
    });
    return { parsed: false, findings: 0 };
  }

  const loaded = await loadPromptContext(review);
  const verified = anchorVerifier(loaded?.ctx.files ?? []);

  if (run.kind === 'validate') {
    // The judge emits what SURVIVES, so its keys are the keeps and everything
    // else this cycle produced is rejected. A judge we could not parse leaves
    // every candidate unvalidated instead, which is why that path returns above.
    // Carries the judge's severity through, not just the key: the prompt invites
    // it to correct one, and reading only keys silently discarded every
    // correction it made.
    const kept = parsed.findings.map((f) => ({
      key: keyFor(f, verified(f)),
      severity: f.severity,
    }));
    // The judge is handed each candidate's dedupe key as its id, so what comes
    // back needs no mapping. Recorded so that "the checker threw away five of
    // six" is a claim somebody can audit rather than take on trust.
    const droppedReasons = new Map(parsed.dropped.map((d) => [d.id, d.reason]));
    const { confirmed, rejected } = await applyJudgement(
      review.id,
      review.cycle,
      kept,
      run.id,
      droppedReasons
    );
    await patchRun(run.id, { findingCount: confirmed });
    await settleRun(run.id, { status: 'succeeded' });
    await appendReviewEvent(review.id, {
      toPhase: review.phase as CodeReviewPhase,
      trigger: 'poller',
      code: 'judged',
      message: `Kept ${confirmed}, dropped ${rejected}.`,
      detail: { confirmed, rejected },
    });
    return { parsed: true, findings: confirmed };
  }

  const result = await upsertFindings({
    reviewId: review.id,
    workspaceId: review.workspaceId,
    pullRequestId: review.pullRequestId,
    cycle: review.cycle,
    headSha: review.targetHeadSha,
    runId: run.id,
    lens: run.kind === 'sweep' ? 'sweep' : run.lens,
    findings: parsed.findings,
    verified,
  });
  await patchRun(run.id, { findingCount: parsed.findings.length });
  await settleRun(run.id, { status: 'succeeded' });
  await appendReviewEvent(review.id, {
    toPhase: review.phase as CodeReviewPhase,
    trigger: 'poller',
    code: 'findings_ingested',
    message: `${result.added} new, ${result.merged} already known.`,
    detail: { kind: run.kind, lens: run.lens, ...result },
  });
  return { parsed: true, findings: parsed.findings.length };
}

/**
 * The judge names its keeps by dedupe key, so its output has to be keyed exactly
 * the way the findings were keyed when they were written — same function, same
 * anchor-verification answer, or nothing matches and every candidate is dropped.
 */
function keyFor(finding: RawCodeReviewFinding, verified: boolean): string {
  return codeReviewDedupeKey({
    filePath: finding.file,
    title: finding.title,
    anchor: finding.anchor,
    anchorVerified: verified,
  });
}

/**
 * Whether a finding's anchor is really in the change it claims to be about.
 *
 * Checked against the patches we already have rather than by fetching file
 * contents, which keeps it free. Two things it catches, and one it does not:
 *
 * - A HALLUCINATED PATH — a file the pull request does not touch at all — reads as
 *   unverified, which is the most common review-agent failure.
 * - A PARAPHRASED ANCHOR, which would otherwise mint a fresh dedupe key on every
 *   cycle and duplicate the finding for ever.
 * - It does NOT verify a finding about unchanged context code, which is real and
 *   simply falls back to the weaker file+title key. Acceptable: that key is stable
 *   too, just coarser.
 */
function anchorVerifier(
  files: { filename: string; patch?: string }[]
): (finding: RawCodeReviewFinding) => boolean {
  const patches = new Map(files.map((f) => [f.filename, patchBodyText(f.patch ?? '')]));
  return (finding) => {
    const anchor = finding.anchor?.trim();
    if (!anchor) return false;
    const haystack = patches.get(finding.file);
    if (haystack === undefined) return false;
    const needle = anchor.replace(/\s+/g, ' ').trim();
    return needle.length > 0 && haystack.includes(needle);
  };
}

/**
 * A patch as the CODE it represents, not as a diff.
 *
 * This is the whole of the verifier's correctness, and getting it wrong made the
 * check useless in a way that looked like it was working. A unified diff prefixes
 * every line with `+`, `-` or a space, so collapsing the raw patch left those
 * markers sitting between the lines: a needle reading `a b` had to match a
 * haystack reading `+ a + b`. A single-line anchor matched by luck, because the
 * marker fell outside it. Anything spanning two lines — which is most of what an
 * agent quotes, given a 200-character budget — could never match at all.
 *
 * So EVERY finding came back unverified, the app said "location approximate" on
 * all of them, and the signal that was supposed to catch a hallucinated path
 * instead caught everything. Worse, `anchorVerified` gates auto-fix, so that
 * feature could never have fired.
 *
 * Removed lines are dropped rather than included. A finding is about the code as
 * it now stands, and keeping the `-` side would verify an anchor against text the
 * pull request has just deleted.
 */
function patchBodyText(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
    .filter((line) => !line.startsWith('-'))
    .map((line) => (line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line))
    .join('\n')
    .replace(/\s+/g, ' ');
}

// ---------- Finishing ----------

/** Everything not seen this cycle goes stale, then the review rests at `ready`. */
export async function finishCycle(review: ReviewRow): Promise<void> {
  const staled = await markStale(review.id, review.cycle);
  await casTransition(
    review.id,
    review.version,
    {
      phase: 'ready',
      phaseStartedAt: new Date(),
      reviewedHeadSha: review.targetHeadSha,
      lastError: null,
      lastErrorAt: null,
    },
    {
      fromPhase: review.phase as CodeReviewPhase,
      toPhase: 'ready',
      trigger: 'executor',
      code: 'cycle_finished',
      message: staled ? `${staled} earlier findings are gone.` : 'Review finished.',
      detail: { staled, headSha: review.targetHeadSha },
    }
  );

  // Fire and forget, and deliberately BEFORE the auto-fix: this event describes
  // the review, and an auto-fix that takes twenty minutes must not delay it or be
  // able to lose it by throwing.
  void captureCycleFinished(review);

  await maybeAutoFix(review);
}

/**
 * Fix what the review found, without waiting for anybody to tick it.
 *
 * Off by default, and the ONLY path in this pipeline that pushes a commit with
 * no human in the loop. The design deliberately excluded it — every other guard
 * here assumes a person chose the findings — so it exists because it was asked
 * for, and it is bounded rather than trusted.
 *
 * `findingsEligibleForAutoFix` is the bound: confirmed by the judging pass, at
 * or above a severity floor that defaults to blockers, and with the location
 * confirmed. All three came from the first real review, where the judge rejected
 * five of six candidates and the one that survived quoted code that was not at
 * the line it named — and was wrong. A person can weigh that against the diff in
 * a second; an unattended fix run cannot.
 *
 * Re-reads the review because `finishCycle` has just CAS'd it to `ready`, so the
 * row in hand carries a version that would lose its own CAS.
 *
 * Failures are logged, never thrown: the cycle HAS finished, its findings are on
 * screen, and a fix that could not start must not turn that into a failed review.
 */
async function maybeAutoFix(review: ReviewRow): Promise<void> {
  try {
    const settings = await workspaceReviewSettings(review.workspaceId);
    if (!settings.autoFix) return;

    const fresh = await getReview(review.id);
    // Only from `ready`. Anything else means something moved underneath us — a
    // new commit, a cancel, a fix a person started first — and each of those is
    // a reason not to push.
    if (!fresh || fresh.phase !== 'ready') return;

    const eligible = findingsEligibleForAutoFix(await listFindings(fresh.id), settings);
    if (!eligible.length) return;

    const outcome = await startFixRun(
      fresh,
      eligible.map((f) => f.id),
      // No user id: nobody pressed anything, and recording one would attribute a
      // push to a person who did not ask for it.
      null
    );
    if (!outcome.ok) {
      console.log(`[code-review] auto fix for ${fresh.id} declined: ${outcome.code}`);
    }
  } catch (err) {
    console.warn(`[code-review] auto fix for ${review.id} failed:`, err);
  }
}

export async function failCycle(
  review: ReviewRow,
  code: string,
  message: string
): Promise<void> {
  await casTransition(
    review.id,
    review.version,
    { phase: 'failed', phaseStartedAt: new Date(), lastError: message, lastErrorAt: new Date() },
    {
      fromPhase: review.phase as CodeReviewPhase,
      toPhase: 'failed',
      trigger: 'executor',
      code,
      message,
    }
  );
  void captureCycleFailed(review, code);
}

/** Move the review to a new phase, recording why. */
export async function advancePhase(
  review: ReviewRow,
  to: CodeReviewPhase,
  code: string,
  message?: string
): Promise<boolean> {
  return casTransition(
    review.id,
    review.version,
    { phase: to, phaseStartedAt: new Date() },
    {
      fromPhase: review.phase as CodeReviewPhase,
      toPhase: to,
      trigger: 'executor',
      code,
      ...(message ? { message } : {}),
    }
  );
}


/**
 * Whether the evaluator should look again straight away after this action.
 *
 * Pulled out of `applyActions` so it can be asserted without a database, a fleet
 * and a GitHub token — the answer is pure control flow, and its failure mode is
 * SILENT: a wrong answer here does not break a review, it just makes one crawl.
 *
 * `prepare` and `phase` both say yes, and that is the fix for 4m46s of a
 * 41-minute review. Entering a phase is exactly when its work becomes available
 * — `queued` becomes `preparing`, which has a pull request to read; `preparing`
 * becomes `reviewing`, which has lenses to dispatch — so answering no parked the
 * review until something else poked it. The only thing that reliably does is the
 * 60-second reconciler, because the poller visits units that are already running
 * and a review between phases has none.
 *
 * `finish` and `fail` say no: the cycle is over, and re-driving a terminal review
 * is how a finished cycle starts another one.
 *
 * Cannot spin: `decide` is pure and answers from the phase, so a pass that moved
 * the phase sees different state next round, and `evaluateOnce` caps the walk at
 * MAX_ROUNDS regardless.
 */
export function wantsImmediateRepass(type: Action['type']): boolean {
  switch (type) {
    case 'prepare':
    case 'phase':
    case 'dispatch':
      return true;
    case 'finish':
    case 'fail':
      return false;
  }
}

/**
 * Apply one pass of decisions.
 *
 * Dispatches are fired in parallel — they are independent and each is a slow
 * HTTP call — while a phase change, a finish or a failure is a CAS on the review
 * and therefore has to be the last thing this pass does: the row's version moves
 * under it, so anything after would lose its own CAS.
 *
 * # Why advancing a phase asks for another pass
 *
 * It used to return false, on the reading that the row had moved and the pass was
 * therefore done. That was measurably expensive: entering a phase is precisely
 * when its work becomes available — `queued` becomes `preparing`, which has a
 * pull request to read; `preparing` becomes `reviewing`, which has lenses to
 * dispatch — so stopping there left the review parked until something else
 * happened to poke it. The only thing that reliably does is the 60-second
 * reconciler, and the poller cannot help because it only visits units that are
 * already running, of which a review between phases has none.
 *
 * On the first real review that cost 4m46s of a 41-minute run: 2m42s sitting in
 * `queued` and 2m04s in `preparing`, while the dispatch those phases lead to
 * takes two seconds. A phase boundary should cost nothing.
 *
 * Safe against spinning for two reasons: `decide` is pure and answers from the
 * phase, so a pass that changed the phase necessarily sees a different state
 * next time, and `evaluateOnce` caps the walk at `MAX_ROUNDS` regardless.
 */
export async function applyActions(review: ReviewRow, actions: Action[]): Promise<boolean> {
  const dispatches = actions.filter((a): a is Extract<Action, { type: 'dispatch' }> =>
    a.type === 'dispatch'
  );
  if (dispatches.length) {
    await Promise.all(dispatches.map((a) => dispatchUnit(review, a.unit)));
  }

  for (const action of actions) {
    switch (action.type) {
      case 'prepare':
        await prepareCycle(review);
        return wantsImmediateRepass('prepare');
      case 'phase':
        await advancePhase(review, action.to, action.code, action.message);
        return wantsImmediateRepass('phase');
      case 'finish':
        await finishCycle(review);
        return wantsImmediateRepass('finish');
      case 'fail':
        await failCycle(review, action.code, action.message);
        return wantsImmediateRepass('fail');
      case 'dispatch':
        break;
    }
  }
  // Only dispatches happened, so the review row is untouched and another pass is
  // worth taking: units may already have settled.
  return dispatches.length > 0;
}
