import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  ScanSearch,
  Undo2,
  Wrench,
} from 'lucide-react';
import {
  CODE_REVIEW_DISMISS_REASONS,
  CODE_REVIEW_DISMISS_REASON_LABELS,
  CODE_REVIEW_PHASE_AT_REST,
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  codeReviewLensLabel,
  codeReviewLensTally,
  codeReviewPresetFacts,
  CODE_REVIEW_PRESET_LABELS,
  CODE_REVIEW_PRESET_PLAN,
  resolveReportingBar,
  CODE_REVIEW_SEVERITY_GROUP_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewProgress,
  severityAtOrAbove,
  type CodeReviewDismissReason,
  type CodeReviewFinding,
  type CodeReviewPreset,
  type CodeReviewPublic,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { useWorkspaceStore } from '../../../stores/workspace';
import { trackEvent } from '../../../lib/analytics';
import { Button } from '../../ui/button';
import { Progress } from '../../ui/progress';
import { cn } from '../../../lib/utils';
import { Markdown } from '../../../lib/markdown';
import { PatchDiff } from '@pierre/diffs/react';
import type { PRFile } from '../../../lib/api';

/**
 * The findings a code review produced, in the app.
 *
 * This tab IS the product. Everything else — the engine, the pacing, the judging
 * pass — exists so that what lands here is a short list of real problems rather
 * than the wall of comments every competing bot leaves on the pull request itself.
 *
 * Three choices here are deliberate and would each be tempting to undo:
 *
 * - **Nothing is ticked by default.** Not even blockers. The one button on this
 *   screen pushes commits to a branch, and a button like that must never start
 *   pre-armed. `Select all` in each group header gives the convenience instead.
 * - **Cards start collapsed except blockers.** A diff tab exists to be read
 *   wholesale; a findings list exists to be triaged, and twelve open explanations
 *   is a wall. Blockers open because they are the ones that must be read.
 * - **Dismissed and stale findings have no checkbox at all** — absent, not
 *   disabled — so the selected count can never include something invisible.
 */
export function FindingsTab({
  pullRequestId,
  seedReview,
  files = null,
}: {
  pullRequestId: string;
  /** The row's copy, so the tab paints before its own fetch lands. */
  seedReview?: CodeReviewPublic | null;
  /**
   * The pull request's changed files, when the host already has them.
   *
   * Passed IN rather than fetched, exactly as the Files tab receives them: the
   * sheet starts that fetch on open, so an anchored diff costs no request. The
   * panel has no files and passes none, which is why this is optional and why
   * every finding still renders without it.
   */
  files?: PRFile[] | null;
}) {
  const [review, setReview] = useState<CodeReviewPublic | null>(seedReview ?? null);
  const [findings, setFindings] = useState<CodeReviewFinding[]>([]);
  const [defaultPreset, setDefaultPreset] = useState<CodeReviewPreset>('standard');
  const [preset, setPreset] = useState<CodeReviewPreset | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The workspace's display bar, so the list, the bucket and the badge agree
  // with the `openCount` the backend computed from the same setting.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const reportingBar = resolveReportingBar(
    workspaces.find((w) => w.id === currentWorkspaceId)?.settings?.codeReview
  );
  const [showBucket, setShowBucket] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showFixed, setShowFixed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.pullRequests.codeReview(pullRequestId);
      setReview(data.review);
      setFindings(data.findings);
      setDefaultPreset(data.defaultPreset);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pullRequestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // `running` covers every non-resting phase, INCLUDING `fixing` — which is why
  // the review-in-progress copy used to appear while an agent was pushing a fix,
  // telling the reader their findings were provisional when the review had long
  // since finished. These two are separate questions and now have separate names.
  const running = review ? !CODE_REVIEW_PHASE_AT_REST[review.phase] : false;
  const fixing = review?.phase === 'fixing';
  const reviewRunning = running && !fixing;
  // What the agent is actually addressing. `selected` is set when the fix claims
  // them and cleared when it lands or fails, so this is the live set rather than
  // whatever was ticked in this browser tab.
  const beingFixed = findings.filter((f) => f.disposition === 'selected');
  // What the last fix dealt with. These used to leave the list the moment they
  // were marked fixed, so "it's fixed now" and "it went stale" and "somebody
  // dismissed it" all looked identical: the finding was simply gone. They stay,
  // in their own collapsed group, each naming the commit that dealt with it.
  const fixed = findings.filter((f) => f.disposition === 'fixed');

  // Poll only while something is happening. The websocket echo keeps the ROW
  // current, but this tab holds the findings, which no echo carries.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [running, load]);

  // A new commit or a new cycle invalidates every finding id, so a selection made
  // against the old list must not survive into the new one.
  useEffect(() => {
    setSelected(new Set());
  }, [pullRequestId, review?.reviewedHeadSha, review?.id]);

  // Reported ONCE per review-and-commit, not per render and not per tab open:
  // the question it answers is "having seen the findings, what did they do", so a
  // second impression for the same list would inflate the denominator of every
  // funnel built on it. Shape only — counts and booleans, never a title, a path
  // or a repository.
  const viewedKey = review && !running ? `${review.id}:${review.reviewedHeadSha}` : null;
  const [viewedReported, setViewedReported] = useState<string | null>(null);
  useEffect(() => {
    if (!viewedKey || !review || viewedReported === viewedKey) return;
    setViewedReported(viewedKey);
    trackEvent('code_review_findings_viewed', {
      preset: review.preset,
      open_count: review.openCount,
      blocker: review.counts.blocker,
      major: review.counts.major,
      minor: review.counts.minor,
      nit: review.counts.nit,
      stale_for_head: review.staleForHead,
    });
  }, [viewedKey, viewedReported, review]);

  const grouped = useMemo(() => {
    const active = findings.filter(
      (f) =>
        (f.disposition === 'open' || f.disposition === 'selected') &&
        severityAtOrAbove(f.severity, reportingBar)
    );
    return CODE_REVIEW_SEVERITY_ORDER.map((severity) => ({
      severity,
      items: active.filter((f) => f.severity === severity),
    })).filter((g) => g.items.length > 0);
  }, [findings, reportingBar]);

  // What the checking pass threw out. Kept in its own group rather than hidden:
  // that pass rejected five of six candidates on the first real review, and a
  // reviewer who cannot see what was dropped has no way to tell a bar that is
  // protecting them from one that is discarding real bugs.
  const dropped = useMemo(
    () => findings.filter((f) => f.verdict === 'rejected'),
    [findings]
  );

  // Exactly what the groups below render, flattened. Derived from `grouped`
  // rather than re-filtered, so the button can never act on a finding the list
  // is not showing.
  // Excludes anything a fix task already owns. `activePrTaskId` allows one task
  // per pull request, so re-submitting a finding in flight is a refusal rather
  // than a second fix — and the button would be offering something impossible.
  const fixableAll = useMemo(
    () =>
      grouped.flatMap((g) =>
        g.items.filter((f) => f.disposition !== 'selected').map((f) => f.id)
      ),
    [grouped]
  );

  const lensTally = useMemo(() => codeReviewLensTally(findings), [findings]);

  const bucket = useMemo(
    () =>
      findings.filter(
        (f) =>
          f.disposition === 'dismissed' ||
          ((f.disposition === 'open' || f.disposition === 'selected') &&
            !severityAtOrAbove(f.severity, reportingBar))
      ),
    [findings]
  );

  // Blockers open on first paint, and only then — re-running this on every render
  // would fight the user closing one.
  useEffect(() => {
    const blockers = findings
      .filter((f) => f.severity === 'blocker' && f.disposition === 'open')
      .map((f) => f.id);
    if (blockers.length) setExpanded((prev) => new Set([...prev, ...blockers]));
  }, [findings]);

  async function startReview(opts: { reset?: boolean } = {}) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.pullRequests.startCodeReview(pullRequestId, {
        preset: preset ?? defaultPreset,
        ...(opts.reset ? { reset: true } : {}),
      });
      setReview(next);
      await load();
    } catch (err) {
      // The free plan's one-cycle rule arrives as a 402 with its own code; the
      // billing store turns that into the upgrade modal rather than a red banner.
      if (!maybeHandleBillingLimit(err, 'code_review_start')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fix a set of findings.
   *
   * Takes the ids rather than reading `selected`, so "Fix all" and "Fix
   * selected" are the same call with a different argument — and every guard the
   * route applies (the plan gate, the task cap deferral, `activePrTaskId`) holds
   * for both without being restated.
   */
  async function fixFindings(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.pullRequests.fixCodeReviewFindings(pullRequestId, ids);
      setSelected(new Set());
      await load();
    } catch (err) {
      if (maybeHandleBillingLimit(err, 'code_review_fix')) return;
      const message = err instanceof Error ? err.message : String(err);
      // A deferral is not a failure: the fix is owed and starts when a task slot
      // frees. Said as a notice rather than an error, because a red banner would
      // read as "this did not work".
      if (message.includes('slot')) setNotice(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(finding: CodeReviewFinding, reason?: CodeReviewDismissReason) {
    setFindings((prev) =>
      prev.map((f) => (f.id === finding.id ? { ...f, disposition: 'dismissed' } : f))
    );
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(finding.id);
      return next;
    });
    // No `code_review_finding_dismissed` here. The route emits it, with these
    // same properties and more — sending it from both sides counted every
    // dismissal twice and split its reason breakdown in half.
    try {
      await api.pullRequests.dismissCodeReviewFinding(pullRequestId, finding.id, reason);
    } finally {
      await load();
    }
  }

  async function undismiss(finding: CodeReviewFinding) {
    try {
      await api.pullRequests.undismissCodeReviewFinding(pullRequestId, finding.id);
    } finally {
      await load();
    }
  }

  // ---------- Never reviewed ----------
  //
  // The tab still exists rather than appearing when a review does: a tab that
  // comes and goes is a moving target. It doubles as where people discover this.
  if (!review) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
          <ScanSearch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Have Talyn review this pull request</p>
            <p className="text-xs text-muted-foreground">
              Findings show up here, in Talyn.
            </p>
          </div>
        </div>
        <PresetPicker value={preset ?? defaultPreset} onChange={setPreset} />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button size="sm" disabled={busy} onClick={() => void startReview()}>
          Review this pull request
        </Button>
      </div>
    );
  }

  const progress = codeReviewProgress(review);

  return (
    <div className="space-y-4">
      {/* The run header. `aria-live` sits HERE and nowhere else: one description
          per open pull request is the right number for a screen reader, where one
          per row on a list of twenty is not. */}
      <div
        className={cn(
          'space-y-2 rounded-md border p-3',
          review.staleForHead && !running && 'border-amber-500/40 bg-amber-500/5'
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium" aria-live="polite">
              {running ? progress.label : headline(review)}
            </p>
            {/* The commit is resolved in `preparing`, so a cycle that has only
                just been claimed genuinely has none yet. Drop the clause rather
                than filling it with a placeholder: this line's whole job is to
                say WHICH commit the findings describe, and "unknown" there reads
                as a fact we lost rather than one not established yet. */}
            <p className="truncate text-[11px] text-muted-foreground">
              {CODE_REVIEW_PRESET_LABELS[review.preset]} review
              {review.headShaShort ? (
                <>
                  {' of '}
                  <code className="font-mono">{review.headShaShort}</code>
                </>
              ) : null}
              {/* Scope, which the app otherwise said nothing about — so a review
                  that read everything and one that skimmed looked identical. */}
              {review.runsTotal > 0 && ` · ${review.runsTotal} passes`}
              {review.chunkTotal > 1 && ` over ${review.chunkTotal} chunks`}
              {/* Which reviewers ran, and — when the change did not need them
                  all — that some sat out. A reviewer that never ran finds
                  nothing, and nothing reads exactly like a clean bill of
                  health, so this says so rather than letting the absence
                  pass for a result. The reason per reviewer is in the
                  timeline. */}
              {review.lensesRun.length > 0 &&
                ` · read by ${review.lensesRun.map(codeReviewLensLabel).join(', ')}`}
              {review.lensesRun.length > 0 &&
                review.lensesRun.length < CODE_REVIEW_PRESET_PLAN[review.preset].lenses &&
                ` (${CODE_REVIEW_PRESET_PLAN[review.preset].lenses - review.lensesRun.length} not needed here)`}
              {review.staleForHead && ' · there are newer commits'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {running ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    // Stopping a FIX stops its task, not the review cycle.
                    // `cancelCodeReview` cancels the review's own units and moves
                    // the phase — during a fix there are no units, so it would
                    // have marked the review cancelled and left the agent running
                    // with commits still to push. The task route is the machinery
                    // that cancels a remote run; its `task:status` echo is what
                    // puts the findings back on the list and the review back to
                    // `ready`, which is where a stopped fix belongs: the findings
                    // are still true, only the fix was given up on.
                    if (fixing && review.fixTaskId) {
                      await api.tasks.stop(review.fixTaskId);
                    } else {
                      setReview(await api.pullRequests.cancelCodeReview(pullRequestId));
                    }
                  } finally {
                    setBusy(false);
                    await load();
                  }
                }}
              >
                {fixing ? 'Stop the fix' : 'Stop'}
              </Button>
            ) : (
              <>
                {/* Fix all, for when the answer is "fix everything" and ticking
                    each one is friction. It acts on what is SHOWN — open, at or
                    above the reporting bar — rather than on everything ever
                    raised, so it cannot silently commit for a nitpick that the
                    list deliberately hides, or for something already dismissed. */}
                {fixableAll.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void fixFindings(fixableAll)}
                    title={`Fix all ${fixableAll.length} finding(s) shown`}
                  >
                    <Wrench className="mr-1 h-3 w-3" />
                    Fix all {fixableAll.length}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={review.staleForHead ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => void startReview()}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  {review.staleForHead ? 'Review this commit' : 'Review again'}
                </Button>
              </>
            )}
          </div>
        </div>
        {running && (
          <Progress value={progress.fraction} label={progress.label} />
        )}
        {!running && review.phase === 'failed' && review.failureReason && (
          <p className="text-[11px] text-red-600 dark:text-red-400">{review.failureReason}</p>
        )}
        {review.deferredSince && running && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            Waiting for a runner to become free.
          </p>
        )}
      </div>

      {/* Findings appear as each reviewer finishes rather than at the end, which is
          the difference between a first signal at thirteen minutes and at forty.
          But they have NOT been through the checking pass yet, and that pass threw
          away five of six on the first real review — so presenting them as settled
          would invite somebody to fix something that is about to be withdrawn. */}
      {reviewRunning && grouped.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Showing what the reviewers have found so far. These have not been checked yet,
          and some are usually dropped.
        </p>
      )}

      {/* The fix has its own state, and it is not the review's. Names what is
          being worked on and how it ends, because the previous version showed an
          empty indeterminate bar and the review's own subtitle — which read as a
          review that had stalled. */}
      {fixing && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Wrench className="h-3 w-3" />
            {beingFixed.length
              ? `Fixing ${beingFixed.length} finding${beingFixed.length === 1 ? '' : 's'}`
              : 'Fixing'}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            An agent is working on a branch. It pushes one commit when it is done, and the
            findings it addressed are marked fixed until the next review confirms them.
          </p>
        </div>
      )}

      {notice && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          {notice}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Clean, and said plainly. This is where the restraint is visible, so it
          must name what was looked at rather than showing a grey dash.
          Gated on the review having actually FINISHED: a cycle that failed has
          no findings for the same reason it has no result, and claiming it
          "found no blockers" next to "the review did not finish" is the app
          contradicting itself on one screen. Same for a cancelled one. */}
      {!running && review.phase === 'ready' && grouped.length === 0 && (
        <div className="rounded-md border bg-muted/20 p-4 text-xs">
          <p className="font-medium">Nothing to flag.</p>
          <p className="mt-1 text-muted-foreground">
            A {CODE_REVIEW_PRESET_LABELS[review.preset].toLowerCase()} review of{' '}
            <code className="font-mono">{review.headShaShort}</code> found no blockers or
            problems worth fixing.
          </p>
        </div>
      )}

      {grouped.map((group) => (
        <section key={group.severity} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {CODE_REVIEW_SEVERITY_GROUP_LABELS[group.severity]}
              <span className="ml-1.5 text-muted-foreground/70">{group.items.length}</span>
            </h3>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() =>
                setSelected((prev) => new Set([...prev, ...group.items.map((f) => f.id)]))
              }
            >
              Select all
            </button>
          </div>
          {group.items.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              pullRequestId={pullRequestId}
              files={files}
              stillChecking={reviewRunning}
              selected={selected.has(finding.id)}
              expanded={expanded.has(finding.id)}
              onToggleSelected={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(finding.id)) next.delete(finding.id);
                  else next.add(finding.id);
                  return next;
                })
              }
              onToggleExpanded={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(finding.id)) next.delete(finding.id);
                  else {
                    next.add(finding.id);
                    // Opening only. A collapse is not an expression of interest,
                    // and counting both would make the rate meaningless.
                    trackEvent('code_review_finding_expanded', {
                      severity: finding.severity,
                      confidence: finding.confidence,
                      anchor_verified: finding.anchorVerified,
                    });
                  }
                  return next;
                })
              }
              onDismiss={(reason) => void dismiss(finding, reason)}
            />
          ))}
        </section>
      ))}

      {/* The funnel, stated. Without it a short list is indistinguishable from a
          shallow review — and the ratio is the most informative thing here. */}
      {!running && review.funnel.raised > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            {review.funnel.raised} raised · {review.funnel.kept} kept after checking
            {review.funnel.rejected > 0 && ` · ${review.funnel.rejected} dropped`}
          </p>
          {/* Which angles found things. Two reviewers on one finding is
              AGREEMENT, and this is the view that makes it visible. */}
          {lensTally.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>Found by</span>
              {lensTally.map((entry) => (
                <span key={entry.lens} className="rounded border px-1.5 py-0.5">
                  {entry.label} {entry.count}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {fixed.length > 0 && (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowFixed((v) => !v)}
          >
            {showFixed ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Fixed ({fixed.length}) — review again to confirm it held
          </button>
          {showFixed && (
            <div className="space-y-2 border-t p-2">
              {fixed.map((finding) => (
                <div key={finding.id} className="rounded px-2 py-1.5 text-[11px]">
                  <p className="flex items-start gap-1.5 font-medium">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      <Markdown text={finding.title} variant="inline" />
                    </span>
                  </p>
                  <p className="truncate pl-[18px] text-muted-foreground">
                    <FilePath path={finding.filePath} line={finding.lineStart} />
                  </p>
                  {/* The commit, which is the whole point of keeping the row.
                      Absent when the run completed without pushing one — said
                      out loud rather than left blank, because a fix that
                      changed nothing is a thing the reader needs to know. */}
                  <p className="pl-[18px] text-muted-foreground">
                    {finding.fixedCommitUrl && finding.fixedHeadShaShort ? (
                      <a
                        href={finding.fixedCommitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        Fixed in <code className="font-mono">{finding.fixedHeadShaShort}</code>
                      </a>
                    ) : (
                      'The fix run reported this done, but pushed no commit for it.'
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {dropped.length > 0 && (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowDropped((v) => !v)}
          >
            {showDropped ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Dropped by the checker ({dropped.length}) — raised, then judged not worth your
            time
          </button>
          {showDropped && (
            <div className="space-y-2 border-t p-2">
              {dropped.map((finding) => (
                <div key={finding.id} className="rounded px-2 py-1.5 text-[11px]">
                  <p className="font-medium">
                    <Markdown text={finding.title} variant="inline" />
                  </p>
                  <p className="truncate text-muted-foreground">
                    <FilePath path={finding.filePath} line={finding.lineStart} />
                  </p>
                  {/* The reason, which is the entire value of this list. Absent
                      on a review judged before reasons were recorded, and that
                      is said rather than left as a blank line. */}
                  <p className="mt-1 italic text-muted-foreground">
                    {finding.verdictReason ? (
                      <Markdown text={finding.verdictReason} variant="inline" />
                    ) : (
                      'No reason was recorded for this one.'
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* One bucket, not two. Nitpicks and dismissals share the property "you
          deliberately are not being shown this", and two half-empty disclosures at
          the foot of every list is more chrome than either earns. */}
      {bucket.length > 0 && (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowBucket((v) => !v)}
          >
            {showBucket ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Also looked at ({bucket.length}) — nitpicks, and things you dismissed
          </button>
          {showBucket && (
            <div className="space-y-1 border-t p-2">
              {bucket.map((finding) => (
                <div
                  key={finding.id}
                  className="flex items-start justify-between gap-2 rounded px-2 py-1.5 text-[11px] hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate">
                      <Markdown text={finding.title} variant="inline" />
                    </p>
                    <p className="truncate text-muted-foreground">
                      <FilePath path={finding.filePath} line={finding.lineStart} />
                      {finding.dismissedReason &&
                        ` · ${CODE_REVIEW_DISMISS_REASON_LABELS[finding.dismissedReason]}`}
                    </p>
                  </div>
                  {finding.disposition === 'dismissed' && (
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title="Put this back on the list"
                      onClick={() => void undismiss(finding)}
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The action bar lives INSIDE the tab, not in the sheet's footer, which the
          merge actions own. Only when something is ticked — a permanently visible
          push button is the thing this screen most needs not to be. */}
      {selected.size > 0 && !fixing && (
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur">
          <span className="text-xs text-muted-foreground">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void fixFindings([...selected])}>
              <Wrench className="mr-1 h-3 w-3" />
              Fix selected
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the header says when the review is at rest.
 *
 * The "N of the previous findings are gone" sentence is the payoff of a fix run
 * and the app should say it out loud rather than leaving the user to notice a
 * shorter list.
 */
function headline(review: CodeReviewPublic): string {
  if (review.phase === 'failed') return 'The review did not finish';
  if (review.phase === 'cancelled') return 'Review stopped';
  if (review.phase === 'fixed') return 'Fix pushed — review again to confirm it held';
  if (review.openCount === 0) return 'Nothing to flag';
  return `${review.openCount} finding${review.openCount === 1 ? '' : 's'}`;
}

function FindingCard({
  finding,
  pullRequestId,
  files,
  stillChecking,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
  onDismiss,
}: {
  finding: CodeReviewFinding;
  pullRequestId: string;
  files: PRFile[] | null;
  /** The cycle is still running, so this finding may yet be withdrawn. */
  stillChecking: boolean;
  selected: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onDismiss: (reason?: CodeReviewDismissReason) => void;
}) {
  const [askingReason, setAskingReason] = useState(false);
  // The list payload carries no body, suggestion or anchor — the projection drops
  // them so that forty findings are not a few hundred kilobytes on a response the
  // pull-request list also uses. So the card fetches its own detail the first time
  // it opens, and keeps it: re-collapsing and re-opening must not re-request.
  const [detail, setDetail] = useState<CodeReviewFinding | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  useEffect(() => {
    if (!expanded || detail || detailFailed) return;
    let cancelled = false;
    void (async () => {
      try {
        const full = await api.pullRequests.codeReviewFinding(pullRequestId, finding.id);
        if (!cancelled) setDetail(full);
      } catch {
        // Silent, and the card falls back to what the list already gave it. A
        // failed detail read must not blank a finding the user can see.
        if (!cancelled) setDetailFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, detail, detailFailed, pullRequestId, finding.id]);

  const full = detail ?? finding;

  return (
    <div className="rounded-md border">
      <div className="flex items-start gap-2 p-2.5">
        {/* A finding already in flight has no checkbox at all, rather than a
            disabled one: it cannot be added to a second fix run, and a control
            that looks available and refuses is worse than an absent one. */}
        {finding.disposition === 'selected' ? (
          <span
            className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            title="An agent is fixing this now"
          >
            <Wrench className="h-3 w-3 text-primary" />
          </span>
        ) : (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
            aria-label={`Select "${finding.title}" to fix`}
          />
        )}
        <span
          className={cn(
            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
            finding.severity === 'blocker' && 'bg-red-500',
            finding.severity === 'major' && 'bg-amber-500',
            finding.severity === 'minor' && 'bg-zinc-400',
            finding.severity === 'nit' && 'bg-zinc-300'
          )}
          aria-hidden
        />
        <button
          type="button"
          onClick={onToggleExpanded}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          {/* Markdown, because agents write it: a title like "`request_id` is
              reused" rendered its backticks literally. Inline only — a heading
              or a list inside a one-line title would break the row. */}
          <p className="text-xs font-medium">
            <Markdown text={finding.title} variant="inline" />
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            <FilePath path={finding.filePath} line={finding.lineStart} />
            {finding.carriedOver && ' · still here'}
            {/* Only while the cycle is live. Once it is at rest every survivor has
                been checked, so saying so then would be noise. */}
            {stillChecking && finding.verdict === 'unvalidated' && ' · not checked yet'}
            {/* Named, not counted. "Logic and Reliability both flagged this" is a
                reason to believe it; "2 reviewers agreed" is a number. */}
            {finding.lenses.length > 1 &&
              ` · ${finding.lenses.map(codeReviewLensLabel).join(' and ')} agree`}
            {/* Said out loud, because it changes how much to trust the location. */}
            {!finding.anchorVerified && ' · location approximate'}
          </p>
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 border-t px-2.5 py-2 text-[11px]">
          {!detail && !detailFailed && (
            <p className="text-muted-foreground">Loading the full finding…</p>
          )}
          {full.body && (
            <div className="[overflow-wrap:anywhere]">
              <Markdown text={full.body} variant="surface" />
            </div>
          )}

          {/* The code, as a DIFF where the pull request touched it. A quotation
              tells you what the agent believed; a hunk tells you what the change
              actually did, which is what decides whether a finding is right. */}
          <FindingCode finding={full} files={files} />

          {full.suggestion && (
            <div className="rounded bg-muted/50 p-2">
              <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
                Suggested change
              </p>
              <div className="[overflow-wrap:anywhere]">
                <Markdown text={full.suggestion} variant="surface" />
              </div>
            </div>
          )}

          {/* How much to believe it, stated rather than implied. A finding that one
              reviewer raised, at middling confidence, against code it could not
              locate is a different object from one three reviewers agreed on — and
              until this row existed both rendered identically. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              Raised by {full.lenses.map(codeReviewLensLabel).join(', ') || 'a reviewer'}
              {full.lenses.length > 1 && ' — independently'}
            </span>
            {full.confidence !== null && <span>Confidence {full.confidence}%</span>}
            <span>{full.anchorVerified ? 'Location confirmed' : 'Location not confirmed'}</span>
            {full.seenCount > 1 && <span>Seen in {full.seenCount} reviews</span>}
          </div>
          {full.verdictReason && (
            <p className="text-[10px] italic text-muted-foreground">
              Checker&rsquo;s note: <Markdown text={full.verdictReason} variant="inline" />
            </p>
          )}
          {askingReason ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Why?</span>
              {CODE_REVIEW_DISMISS_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  className="rounded border px-1.5 py-0.5 hover:bg-muted"
                  onClick={() => onDismiss(reason)}
                >
                  {CODE_REVIEW_DISMISS_REASON_LABELS[reason]}
                </button>
              ))}
              {/* Skippable, deliberately: a reason is useful to us and must not be
                  the price of dismissing something. */}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onDismiss()}
              >
                Skip
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setAskingReason(true)}
            >
              <Check className="mr-1 inline h-3 w-3" />
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Truncated from the LEFT, so the filename survives — as `PRFileRow` does. */
function FilePath({ path, line }: { path: string; line: number | null }) {
  if (!path) return <span>Whole pull request</span>;
  return (
    <span className="inline-block max-w-full truncate font-mono" dir="rtl">
      <bdi>
        {path}
        {line ? `:${line}` : ''}
      </bdi>
    </span>
  );
}

export function PresetPicker({
  value,
  onChange,
}: {
  value: CodeReviewPreset;
  onChange: (preset: CodeReviewPreset) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border p-0.5">
        {CODE_REVIEW_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={cn(
              'rounded px-2.5 py-1 text-xs transition-colors',
              value === preset
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {CODE_REVIEW_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
      {/* The blurb is what makes "no advanced panel" an acceptable design: a preset
          nobody can see inside has to say what it does. The facts below it are
          derived from the preset plan, so they cannot drift from what the engine
          will actually do. */}
      <p className="text-[11px] text-muted-foreground">{CODE_REVIEW_PRESET_BLURBS[value]}</p>
      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
        {codeReviewPresetFacts(value).map((fact) => (
          <li key={fact} className="flex gap-1.5">
            <span aria-hidden>·</span>
            <span>{fact}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** The tab's badge: what the user is being asked about, never the raw total. */
export function findingsBadge(review: CodeReviewPublic | null | undefined): string | undefined {
  if (!review || review.openCount === 0) return undefined;
  return String(review.openCount);
}

export type { CodeReviewSeverity };


/**
 * The finding's code, as a diff hunk rather than a quotation.
 *
 * Slices the file's OWN patch down to the hunks that contain the finding, and
 * hands the slice to the same renderer the Files tab uses. A quotation in a
 * <pre> tells you what the agent believed; a hunk tells you what the pull
 * request actually did, with the added and removed lines coloured — which is
 * what you need to decide whether a finding is right.
 *
 * Falls back to the verbatim quote when there is no patch to slice: the panel
 * renders this tab with no files loaded, a finding can name a file the pull
 * request does not touch, and in both cases the agent's own words are better
 * than an empty box.
 */
function FindingCode({
  finding,
  files,
}: {
  finding: CodeReviewFinding;
  files: PRFile[] | null;
}) {
  const file = files?.find((f) => f.filename === finding.filePath) ?? null;
  const sliced = useMemo(
    () => (file?.patch ? sliceHunksAround(file.patch, finding.lineStart) : null),
    [file?.patch, finding.lineStart]
  );

  if (file && sliced) {
    return (
      <div className="overflow-x-auto rounded border">
        <PatchDiff
          patch={[
            `diff --git a/${file.filename} b/${file.filename}`,
            `--- a/${file.filename}`,
            `+++ b/${file.filename}`,
            sliced,
          ].join('\n')}
          // The card already names the file above, so the library's own header
          // would repeat it with different truncation — the same reason the
          // Files tab disables it.
          options={{ diffStyle: 'unified', disableFileHeader: true }}
        />
      </div>
    );
  }

  if (!finding.anchor) return null;
  return (
    <div className="rounded border bg-muted/30 p-2">
      <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
        {finding.anchorVerified
          ? 'The code it read'
          : 'The code it quoted — not found at this location'}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug">
        {finding.anchor}
      </pre>
    </div>
  );
}

/**
 * The hunks of a patch that cover a line, or the whole patch when none does.
 *
 * A finding names a line in the NEW file, and a patch's `@@ -a,b +c,d @@` header
 * carries exactly that range — so the hunk is found by arithmetic rather than by
 * searching the text for the code, which is what the anchor check already does
 * and does not need repeating.
 *
 * Returning the whole patch when nothing matches is deliberate: a line outside
 * every hunk means the finding is about context the pull request did not change,
 * which is real and worth showing rather than hiding behind an empty result.
 */
export function sliceHunksAround(patch: string, line: number | null): string {
  const lines = patch.split('\n');
  const hunks: { header: number; start: number; end: number; body: string[] }[] = [];
  for (const raw of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      hunks.push({ header: start, start, end: start + Math.max(count, 1) - 1, body: [raw] });
    } else if (hunks.length) {
      hunks[hunks.length - 1]!.body.push(raw);
    }
  }
  if (!hunks.length) return patch;
  if (line === null) return patch;
  const hit = hunks.filter((h) => line >= h.start && line <= h.end);
  if (!hit.length) return patch;
  return hit.map((h) => h.body.join('\n')).join('\n');
}
