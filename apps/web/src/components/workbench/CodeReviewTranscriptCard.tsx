import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ScanSearch } from 'lucide-react';
import {
  CODE_REVIEW_SEVERITY_LABELS,
  codeReviewTranscriptCounts,
  codeReviewTranscriptDetail,
  codeReviewTranscriptFindingLocation,
  codeReviewTranscriptTitle,
  sortCodeReviewTranscriptFindings,
  type CodeReviewSeverity,
  type CodeReviewTranscriptEvent,
  type CodeReviewTranscriptFinding,
} from '@talyn/shared';
import { Markdown } from '../../lib/markdown';
import { cn } from '../../lib/utils';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { CodeReviewSeverityCounts } from '../widgets/codeReview/CodeReviewSeverityCounts';

/** The card shows this many findings before "Show N more". */
export const CODE_REVIEW_CARD_VISIBLE_FINDINGS = 5;

const SEVERITY_PILL: Record<CodeReviewSeverity, string> = {
  blocker: 'bg-red-500/10 text-red-700 dark:text-red-400',
  major: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  minor: 'bg-muted text-muted-foreground',
  nit: 'bg-muted/60 text-muted-foreground',
};

/**
 * True when the client knows the pull request, so the detail sheet can open
 * it. A session knows its own PR; the PR list knows the open ones.
 */
function useKnownPullRequest(pullRequestId: string): boolean {
  const inSession = useWorkbenchStore((s) =>
    Object.values(s.workbenches).some((w) => w?.pullRequestId === pullRequestId)
  );
  const inList = usePullRequestStore((s) => s.rows.some((r) => r.id === pullRequestId));
  return inSession || inList;
}

/** A code review of the session's pull request started, finished or failed. */
export function CodeReviewTranscriptCard({ event }: { event: CodeReviewTranscriptEvent }) {
  const known = useKnownPullRequest(event.pullRequestId);
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  const failed = event.action === 'failed';
  const findings = event.action === 'finished' ? event.findings : [];
  const hasFindings = event.action === 'finished' && event.findingCount > 0;
  const Icon = failed ? AlertCircle : event.action === 'started' ? ScanSearch : hasFindings ? AlertTriangle : CheckCircle2;
  const prLabel = event.prNumber !== null ? `pull request #${event.prNumber}` : 'the pull request';

  return (
    <div
      className={cn('rounded-md border bg-card text-xs', failed ? 'border-destructive/40' : 'border-border')}
      data-testid="code-review-card"
      data-action={event.action}
    >
      <div className="space-y-0.5 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              failed
                ? 'text-destructive'
                : event.action === 'started'
                  ? 'text-muted-foreground'
                  : hasFindings
                    ? 'text-warning'
                    : 'text-success'
            )}
            aria-hidden
          />
          <span className={cn('min-w-0 font-medium', failed && 'text-destructive')}>{codeReviewTranscriptTitle(event)}</span>
          {event.prNumber !== null && <span className="text-muted-foreground">#{event.prNumber}</span>}
          {known && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => openPrDetail(event.pullRequestId, 'findings')}
              aria-label={hasFindings ? `View the findings of ${prLabel}` : `Open the code review of ${prLabel}`}
            >
              {hasFindings ? 'View findings' : 'Details'}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{codeReviewTranscriptDetail(event)}</p>
      </div>
      {event.action === 'finished' && findings.length > 0 && (
        <FindingList findings={findings} findingCount={event.findingCount} />
      )}
    </div>
  );
}

function FindingList({ findings, findingCount }: { findings: CodeReviewTranscriptFinding[]; findingCount: number }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = sortCodeReviewTranscriptFindings(findings);
  const shown = showAll ? sorted : sorted.slice(0, CODE_REVIEW_CARD_VISIBLE_FINDINGS);
  const hidden = sorted.length - shown.length;
  const notInCard = findingCount - findings.length;
  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
      <CodeReviewSeverityCounts counts={codeReviewTranscriptCounts(findings)} className="text-muted-foreground" />
      <ul className="space-y-1" data-testid="code-review-card-findings">
        {shown.map((finding) => (
          <FindingRow key={finding.id} finding={finding} />
        ))}
      </ul>
      {sorted.length > CODE_REVIEW_CARD_VISIBLE_FINDINGS && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          aria-expanded={showAll}
          className="text-[11px] text-foreground hover:underline"
        >
          {showAll ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
      {notInCard > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {notInCard} more in the findings list
        </p>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: CodeReviewTranscriptFinding }) {
  const [expanded, setExpanded] = useState(false);
  const location = codeReviewTranscriptFindingLocation(finding);
  const label = CODE_REVIEW_SEVERITY_LABELS[finding.severity];
  return (
    <li data-severity={finding.severity}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="w-full rounded px-1 py-1 text-left hover:bg-muted/50"
      >
        <span className="flex items-start gap-2">
          <span
            className={cn('mt-px shrink-0 rounded px-1.5 py-px text-[10px] font-medium leading-4', SEVERITY_PILL[finding.severity])}
          >
            {label}
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block font-medium [overflow-wrap:anywhere]">
              <Markdown text={finding.title} variant="inline" />
            </span>
            {location && (
              <span className="block truncate font-mono text-[11px] text-muted-foreground" title={location}>
                {location}
              </span>
            )}
            {finding.summary && (
              <span
                className={cn('block text-muted-foreground [overflow-wrap:anywhere]', !expanded && 'line-clamp-2')}
                data-testid="code-review-card-summary"
              >
                <Markdown text={finding.summary} variant="inline" />
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
