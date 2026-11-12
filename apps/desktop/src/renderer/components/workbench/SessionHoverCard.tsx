import { useState, type ReactElement, type ReactNode } from 'react';
import {
  agentGlance,
  checksGlance,
  prSizeGlance,
  sandboxGlance,
  sessionGlanceFacts,
  workbenchDisplayName,
  type SessionGlanceFact,
  type SpaceSessionRow,
  type Workbench,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import type { PRRow } from '../../lib/api';
import { relativeTimeLabel, useRelativeNow } from '../../lib/relativeTime';
import type { SessionState } from '../../lib/sessionState';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useBackground } from '../../stores/sessionBackground';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PRReviewPill } from '../widgets/PRReviewPill';
import { PrPill, SessionStateIcon } from './WorkbenchBadges';

/**
 * The card a sidebar session row shows on hover or focus, with no delay: the
 * state, the full title, where the work is, the pull request and the session
 * facts. The content mounts only while the card is open, so a row pays for
 * none of its store reads until a person points at it.
 */
function HoverCardShell({
  label,
  content,
  disabled = false,
  children,
}: {
  label: string;
  content: () => ReactNode;
  disabled?: boolean;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0} disableHoverableContent>
      <Tooltip open={open && !disabled} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          // Assistive tech reads this plain text, not a second copy of the card.
          aria-label={label}
          data-attr="session-hover-card"
          className="w-80 px-3 py-2.5 text-xs leading-snug shadow-lg"
        >
          {content()}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The hover card of a session or thread that is loaded in this client. */
export function WorkbenchHoverCard({
  workbench,
  state,
  shortcut,
  disabled,
  children,
}: {
  workbench: Workbench;
  state: SessionState;
  shortcut?: string | null;
  /** Keeps the card closed, for example while the row's title is being renamed. */
  disabled?: boolean;
  children: ReactElement;
}) {
  const title = workbenchDisplayName(workbench);
  return (
    <HoverCardShell
      label={`${title}. ${state.label}.`}
      disabled={disabled}
      content={() => <WorkbenchGlance workbench={workbench} state={state} shortcut={shortcut ?? null} />}
    >
      {children}
    </HoverCardShell>
  );
}

function WorkbenchGlance({ workbench, state, shortcut }: { workbench: Workbench; state: SessionState; shortcut: string | null }) {
  const now = useRelativeNow();
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const row = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const background = useBackground(workbench.id);
  const list = chats ?? workbench.chats ?? [];
  const facts = sessionGlanceFacts({ workbench, chats: list, background, hasPullRequest: !!(row || workbench.pr) })
    // The state line already says the agent waits for CI.
    .filter((fact) => !(state.kind === 'waiting_ci' && fact.label === 'Wake-up'));
  const lastActivity = list.reduce((latest, chat) => (chat.updatedAt > latest ? chat.updatedAt : latest), workbench.updatedAt);
  const thread = workbench.kind === 'thread';
  return (
    <GlanceLayout
      title={workbenchDisplayName(workbench)}
      state={state}
      shortcut={shortcut}
      location={thread ? null : <BranchLine repo={workbench.repoFullName} branch={workbench.branch} base={workbench.baseBranch} />}
      pullRequest={
        row ? (
          <PullRequestGlance row={row} now={now} />
        ) : workbench.pr ? (
          <PullRequestGlanceShort number={workbench.pr.number} state={workbench.pr.state} title={null} />
        ) : null
      }
      facts={facts}
      footer={timesLine(lastActivity, workbench.createdAt, now)}
    />
  );
}

/** The hover card of a space session from the space's list: a teammate's, or mine when it is not loaded here. */
export function SpaceSessionHoverCard({
  row,
  state,
  shortcut,
  children,
}: {
  row: SpaceSessionRow;
  state: SessionState;
  shortcut?: string | null;
  children: ReactElement;
}) {
  const title = row.title || row.name;
  return (
    <HoverCardShell
      label={`${title}. ${state.label}.`}
      content={() => <SpaceSessionGlance row={row} state={state} shortcut={shortcut ?? null} />}
    >
      {children}
    </HoverCardShell>
  );
}

function SpaceSessionGlance({ row, state, shortcut }: { row: SpaceSessionRow; state: SessionState; shortcut: string | null }) {
  const now = useRelativeNow();
  const facts: SessionGlanceFact[] = [
    { label: 'Started by', value: row.creator.githubLogin ? `@${row.creator.githubLogin}` : 'A teammate' },
    { label: 'Agent', value: agentGlance(row.agent, row.model ? [{ agent: row.agent, model: row.model, updatedAt: row.updatedAt }] : []) },
  ];
  const sandbox = sandboxGlance({ runtime: 'sandbox', status: row.status, sandboxState: row.sandboxState });
  if (sandbox) facts.push(sandbox);
  const prState = row.pullRequest?.state === 'merged' || row.pullRequest?.state === 'closed' ? row.pullRequest.state : 'open';
  return (
    <GlanceLayout
      title={row.title || row.name}
      state={state}
      shortcut={shortcut}
      location={row.kind === 'thread' ? null : <BranchLine repo={row.repoFullName} branch={row.branch} base={row.baseBranch} />}
      pullRequest={row.pullRequest ? <PullRequestGlanceShort number={row.pullRequest.number} state={prState} title={null} /> : null}
      facts={facts}
      footer={timesLine(row.lastActivityAt ?? row.updatedAt, row.createdAt, now)}
    />
  );
}

function GlanceLayout({
  title,
  state,
  shortcut,
  location,
  pullRequest,
  facts,
  footer,
}: {
  title: string;
  state: SessionState;
  shortcut: string | null;
  location: ReactNode;
  pullRequest: ReactNode;
  facts: SessionGlanceFact[];
  footer: string;
}) {
  return (
    <div className="space-y-2" data-attr="session-glance">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <SessionStateIcon state={state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13px] font-medium text-foreground">{title}</div>
          <div className="text-muted-foreground" data-attr="session-glance-state">{state.label}</div>
        </div>
        {shortcut && (
          <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-sans text-[10px] text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </div>
      {location}
      {pullRequest}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5" data-attr="session-glance-facts">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className={cn('break-words', TONE[fact.tone ?? 'default'])}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {footer && <div className="text-[11px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

const TONE = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const;

function BranchLine({ repo, branch, base }: { repo: string; branch: string; base: string }) {
  return (
    <div className="break-all font-mono text-[11px] text-muted-foreground" data-attr="session-glance-branch">
      <span className="text-foreground/80">{repo}</span>
      {branch && (
        <>
          {' · '}
          {branch}
          {base && <span className="opacity-70"> → {base}</span>}
        </>
      )}
    </div>
  );
}

const NO_CHECKS = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };

function PullRequestGlance({ row, now }: { row: PRRow; now: number }) {
  const { summary } = row;
  const open = row.state === 'open';
  const checks = open ? checksGlance(summary.checks) : null;
  const size = prSizeGlance(summary.additions, summary.deletions, summary.changedFiles);
  const meta = [
    size,
    summary.author ? `by @${summary.author}` : null,
    row.state === 'merged' && row.mergedAt ? `merged ${relativeTimeLabel(row.mergedAt, now)}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2" data-attr="session-glance-pr">
      <PullRequestGlanceShort number={row.number} state={row.state} draft={summary.draft} title={summary.title} />
      <div className="flex flex-wrap items-center gap-1.5">
        <PRStatusPill
          compact
          blockingReason={summary.blockingReason}
          checks={summary.checks ?? NO_CHECKS}
          mergeStateStatus={summary.mergeStateStatus}
          state={row.state}
          hideReviewState
          labels={summary.labels}
          ciStatus={summary.ciStatus}
          humanGates={summary.humanGates}
        />
        {open && <PRReviewPill reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision} state={row.state} />}
      </div>
      {checks && <div className="text-muted-foreground" data-attr="session-glance-checks">Checks: {checks}</div>}
      {meta.length > 0 && <div className="text-muted-foreground">{meta.join(' · ')}</div>}
    </div>
  );
}

function PullRequestGlanceShort({
  number,
  state,
  draft,
  title,
}: {
  number: number;
  state: string;
  draft?: boolean;
  title: string | null;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-px">
        <PrPill number={number} state={state} draft={draft} />
      </span>
      <span className={cn('min-w-0 break-words', title ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {title ?? (state === 'merged' ? 'Merged pull request' : state === 'closed' ? 'Closed pull request' : 'Pull request')}
      </span>
    </div>
  );
}

/** "Active 5 minutes ago · started 2 days ago". */
function timesLine(lastActivity: string | null, createdAt: string, now: number): string {
  const active = lastActivity ? relativeTimeLabel(lastActivity, now) : '';
  const started = relativeTimeLabel(createdAt, now);
  const line = [active && `active ${active}`, started && `started ${started}`].filter(Boolean).join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
