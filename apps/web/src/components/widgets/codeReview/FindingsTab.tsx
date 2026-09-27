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
  CODE_REVIEW_PRESET_LABELS,
  CODE_REVIEW_REPORTING_BAR,
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
import { trackEvent } from '../../../lib/analytics';
import { Button } from '../../ui/button';
import { Progress } from '../../ui/progress';
import { cn } from '../../../lib/utils';

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
}: {
  pullRequestId: string;
  /** The row's copy, so the tab paints before its own fetch lands. */
  seedReview?: CodeReviewPublic | null;
}) {
  const [review, setReview] = useState<CodeReviewPublic | null>(seedReview ?? null);
  const [findings, setFindings] = useState<CodeReviewFinding[]>([]);
  const [defaultPreset, setDefaultPreset] = useState<CodeReviewPreset>('standard');
  const [preset, setPreset] = useState<CodeReviewPreset | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showBucket, setShowBucket] = useState(false);
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

  const running = review ? !CODE_REVIEW_PHASE_AT_REST[review.phase] : false;

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
        severityAtOrAbove(f.severity, CODE_REVIEW_REPORTING_BAR)
    );
    return CODE_REVIEW_SEVERITY_ORDER.map((severity) => ({
      severity,
      items: active.filter((f) => f.severity === severity),
    })).filter((g) => g.items.length > 0);
  }, [findings]);

  const bucket = useMemo(
    () =>
      findings.filter(
        (f) =>
          f.disposition === 'dismissed' ||
          ((f.disposition === 'open' || f.disposition === 'selected') &&
            !severityAtOrAbove(f.severity, CODE_REVIEW_REPORTING_BAR))
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

  async function fixSelected() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.pullRequests.fixCodeReviewFindings(pullRequestId, [...selected]);
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
    trackEvent('code_review_finding_dismissed', {
      severity: finding.severity,
      // Absent when somebody dismissed without picking one — the reasons are
      // skippable, so a missing reason is a real answer about the prompt.
      reason: reason ?? null,
      lenses: finding.lenses.length,
      anchor_verified: finding.anchorVerified,
    });
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
              Findings show up here, in Talyn. Nothing is posted on your pull request unless
              you ask.
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
                    setReview(await api.pullRequests.cancelCodeReview(pullRequestId));
                  } finally {
                    setBusy(false);
                    await load();
                  }
                }}
              >
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant={review.staleForHead ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => void startReview()}
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                {review.staleForHead ? 'Review this commit' : 'Review again'}
              </Button>
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

      {notice && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          {notice}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Clean, and said plainly. This is where the restraint is visible, so it
          must name what was looked at rather than showing a grey dash. */}
      {!running && grouped.length === 0 && (
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
                    <p className="truncate">{finding.title}</p>
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
      {selected.size > 0 && (
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur">
          <span className="text-xs text-muted-foreground">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void fixSelected()}>
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
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
  onDismiss,
}: {
  finding: CodeReviewFinding;
  selected: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onDismiss: (reason?: CodeReviewDismissReason) => void;
}) {
  const [askingReason, setAskingReason] = useState(false);

  return (
    <div className="rounded-md border">
      <div className="flex items-start gap-2 p-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
          aria-label={`Select "${finding.title}" to fix`}
        />
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
          <p className="text-xs font-medium">{finding.title}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            <FilePath path={finding.filePath} line={finding.lineStart} />
            {finding.carriedOver && ' · still here'}
            {finding.lenses.length > 1 && ` · ${finding.lenses.length} reviewers agreed`}
            {/* Said out loud, because it changes how much to trust the location. */}
            {!finding.anchorVerified && ' · location approximate'}
          </p>
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 border-t px-2.5 py-2 text-[11px]">
          {finding.body && <p className="whitespace-pre-wrap">{finding.body}</p>}
          {finding.suggestion && (
            <div className="rounded bg-muted/50 p-2">
              <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
                Suggested change
              </p>
              <p className="whitespace-pre-wrap">{finding.suggestion}</p>
            </div>
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
          nobody can see inside has to say what it does. */}
      <p className="text-[11px] text-muted-foreground">{CODE_REVIEW_PRESET_BLURBS[value]}</p>
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
