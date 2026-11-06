import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronRight, GitPullRequest, PauseCircle, Shield } from 'lucide-react';
import { cn } from '../../lib/utils';
import { renderMarkdownish } from '../../lib/markdown';
import { skillInstructionsByToolId } from '../../lib/skillInstructions';
import { MemoryChangeCard } from '../memory/MemoryChangeCard';
import { BoxRefusalAction } from '../billing/BoxRefusalAction';
import { TalynMessageCard, ThreadSessionCard } from '../threads/ThreadSessionCard';
import { openExternal } from '../../lib/openExternal';
import { prDetailIdFor } from '../../lib/prDetail';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import type { AgentEvent, EditDiff, GroupedBlock, ToolGroupChild } from '@talyn/shared';
import {
  buildBlocks,
  describeTool,
  editDiffFromInput,
  formatToolOutput,
  groupToolRuns,
  groupedBlockSignature,
  mergeToolBlocks,
  stripAutoPrBlock,
  stripPlanBlocks,
} from '@talyn/shared';

interface AgentConversationProps {
  transcript: AgentEvent[] | undefined;
  /** Display name of the env the task runs on. Surfaced in the auto-allowed indicator. */
  envName?: string;
  /** Overrides the "Waiting for the agent to start…" empty-state copy (e.g. cloud tasks). */
  waitingHint?: string;
  /**
   * Whose transcript this is — the task id. Scopes block identity so two
   * transcripts cannot share a React key: `seq` restarts at 1 per cloud run,
   * so without it block "3.0" of one task collides with block "3.0" of
   * another and the memo keeps the wrong one on screen.
   */
  scopeId?: string;
}

/**
 * Renderer for structured-mode tasks. Takes the ordered event stream
 * the backend persists on `tasks.transcript` and lays it out as a
 * conversation: assistant text, collapsible tool calls + results,
 * thinking blocks, and permission-request cards (historical only —
 * cloud runs handle permissions provider-side, so the cards render as
 * a read-only record of what the agent asked for and was granted).
 */
export function AgentConversation({
  transcript,
  envName,
  waitingHint,
  scopeId,
}: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track "was the user at the bottom before the latest re-render?" so
  // we only auto-scroll on new events when they were following along.
  // Reading scrollHeight/scrollTop inside the effect measures AFTER the
  // new content has landed — by which point the old position is no
  // longer the scroll bottom. Capturing on scroll + ref avoids that.
  const wasAtBottomRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Be generous — a ~200px slop handles the permission card adding
    // ~400px of content in a single tick without us ping-ponging.
    wasAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript?.length]);

  // Three passes, each one a thing the reader wanted and the event stream
  // does not give: a tool call and its result as ONE row (mergeToolBlocks),
  // then consecutive calls folded into an openable run (groupToolRuns) so the
  // prose between them is what you see first.
  const blocks = useMemo(
    () => groupToolRuns(mergeToolBlocks(buildBlocks(transcript ?? []))),
    [transcript]
  );
  const skills = useMemo(() => skillInstructionsByToolId(transcript ?? []), [transcript]);
  const lastContent = lastContentIndex(blocks);

  if (blocks.length === 0) {
    // Task may have events but none render as blocks yet (the very
    // first few events are `system/init`, `rate_limit_event`,
    // `message_start`). Give the user a less-ominous message than
    // "waiting to start" if we've seen any activity at all.
    const hasAnyEvents = (transcript?.length ?? 0) > 0;
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground bg-background">
        {hasAnyEvents
          ? 'The agent is thinking…'
          : (waitingHint ?? 'Waiting for the agent to start…')}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-auto px-4 py-4 text-[13px] text-foreground bg-background space-y-3 min-w-0"
    >
      {blocks.map((block, i) => (
        <BlockView
          key={`${scopeId ?? ''}:${block.key}`}
          block={block}
          envName={envName}
          scopeId={scopeId}
          skills={skills}
          endsTurn={i === lastContent}
        />
      ))}
    </div>
  );
}

/**
 * The block list on its own, with no scroll container or empty state — for a
 * caller that lays several transcripts out in one scrolling view (a workbench
 * chat draws one per turn, under the user's message).
 */
export function AgentBlocks({
  events,
  envName,
  scopeId,
  hideCompletedResults = false,
  retryResult,
}: {
  events: AgentEvent[];
  envName?: string;
  scopeId?: string;
  /** Drop the footer of a turn that ended well; the caller shows the totals once. */
  hideCompletedResults?: boolean;
  retryResult?: { key: string; action: React.ReactNode };
}) {
  const blocks = useMemo(() => {
    const all = groupToolRuns(mergeToolBlocks(buildBlocks(events)));
    return hideCompletedResults ? all.filter((b) => b.kind !== 'result' || b.isError) : all;
  }, [events, hideCompletedResults]);
  const skills = useMemo(() => skillInstructionsByToolId(events), [events]);
  const lastContent = lastContentIndex(blocks);
  return (
    <>
      {blocks.map((block, i) => (
        <React.Fragment key={`${scopeId ?? ''}:${block.key}`}>
          <BlockView
            block={block}
            envName={envName}
            scopeId={scopeId}
            skills={skills}
            endsTurn={i === lastContent}
          />
          {block.kind === 'result' && block.key === retryResult?.key && retryResult.action}
        </React.Fragment>
      ))}
    </>
  );
}

// buildBlocks, blockSignature and the Block model live in @talyn/shared:
// apps/web, apps/desktop and apps/admin all render the same event stream,
// and this file used to be a byte-identical copy of its desktop twin.

// ---------------------------------------------------------------------------
// Block views
// ---------------------------------------------------------------------------


/** Which of a block's tool calls have skill instructions, and how long they are. */
function skillsSignature(block: GroupedBlock, skills: Map<string, string>): string {
  const tools = block.kind === 'tool' ? [block] : block.kind === 'tool_group' ? block.tools : [];
  return tools.map((t) => skills.get(t.toolId)?.length ?? 0).join(',');
}

/** The last block that is not a result footer: a failure there is where the turn ended. */
function lastContentIndex(blocks: GroupedBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind !== 'result') return i;
  return -1;
}

const BlockView = React.memo(
  BlockViewImpl,
  (prev, next) =>
    prev.envName === next.envName &&
    prev.scopeId === next.scopeId &&
    prev.endsTurn === next.endsTurn &&
    groupedBlockSignature(prev.block) === groupedBlockSignature(next.block) &&
    skillsSignature(prev.block, prev.skills) === skillsSignature(next.block, next.skills)
);

function BlockViewImpl({
  block,
  envName,
  skills,
  endsTurn = false,
}: {
  block: GroupedBlock;
  envName?: string;
  /** Whose transcript this block belongs to; see blockSignature. */
  scopeId?: string;
  /** The text each launched skill added, by Skill tool call id. */
  skills: Map<string, string>;
  /** Nothing but a result footer follows this block. */
  endsTurn?: boolean;
}) {
  switch (block.kind) {
    case 'text':
      return <TextBlock text={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} />;
    case 'tool':
      return (
        <ToolBlockView
          name={block.name}
          input={block.input}
          output={block.output}
          isError={block.isError}
          stopped={block.stopped}
          settled={block.settled}
          skillInstructions={skills.get(block.toolId)}
        />
      );
    case 'tool_group':
      return (
        <ToolGroupView
          items={block.children}
          summary={block.summary}
          running={block.running}
          isError={block.isError}
          failedCount={block.failedCount}
          openOnFailure={block.lastFailed && endsTurn}
          skills={skills}
        />
      );
    case 'permission':
      return (
        <PermissionBlock
          toolName={block.toolName}
          toolInput={block.toolInput}
          status={block.status}
          persist={block.persist}
          envName={envName}
        />
      );
    case 'system':
      if (block.subtype === 'talyn_pr' && block.pullRequest)
        return <PullRequestCard text={block.text} url={block.url} pullRequest={block.pullRequest} />;
      if (block.subtype === 'talyn_pr') return <PullRequestLine text={block.text} url={block.url} isError={block.isError} />;
      if (block.subtype === 'talyn_memory' && block.memory) return <MemoryChangeCard change={block.memory} />;
      if (block.subtype === 'talyn_thread' && block.thread) return <ThreadSessionCard event={block.thread} />;
      if (block.subtype === 'talyn_message') return <TalynMessageCard text={block.text} />;
      return <SystemBlock text={block.text} subtype={block.subtype} />;
    case 'result':
      return (
        <ResultBlock
          summary={block.summary}
          costUsd={block.costUsd}
          inputTokens={block.inputTokens}
          outputTokens={block.outputTokens}
          isError={block.isError}
          denials={block.denials}
        />
      );
  }
}

function TextBlock({ text }: { text: string }) {
  // A session draws a plan block as its own card, under the turn.
  const shown = stripPlanBlocks(stripAutoPrBlock(text));
  if (!shown) return null;
  return (
    // Paragraph spacing is renderMarkdownish's own (`my-1 leading-relaxed` on
    // its `p`), so this sets size and colour only. Overriding it from here
    // would be two single-class rules at equal specificity fighting over
    // stylesheet order.
    <div className="text-[13px] text-foreground min-w-0 [overflow-wrap:anywhere]">
      {shown ? renderMarkdownish(shown, 'surface') : null}
    </div>
  );
}

/**
 * Reasoning, folded down to one dim line.
 *
 * It used to be a full-width bordered row reading only "Thinking" — a box with
 * no information in it, repeated between every pair of tool calls, which is
 * most of what made the transcript hard to scan. The first line of the thought
 * is almost always the useful part, so it is what shows.
 */
function ThinkingBlock({ text, compact = false }: { text: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const firstLine = compact ? 'Thought' : (text.split('\n').find((l) => l.trim()) ?? 'Thinking');
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left hover:text-foreground min-w-0"
      >
        <span className="flex-none text-muted-foreground select-none">✻</span>
        <span className={cn('italic min-w-0 flex-1', !open && 'truncate')}>
          {open && !compact ? 'Thinking' : firstLine}
        </span>
      </button>
      {open && (
        <div className="mt-1 ml-[13px] whitespace-pre-wrap italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * How much output shows without being asked for.
 *
 * BOTH bounds matter, and the character one is the bug fix. The clamp used to
 * be six LINES, so a 4 KB GitHub API response — one enormous minified line —
 * sailed straight through it and wrapped to twenty rows on screen. A tool
 * result is small enough to show inline only when it is short by both measures.
 *
 * Errors get more room: the failing part is the reason anyone is reading.
 */
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 500;
const PREVIEW_LINES_ERROR = 14;
const PREVIEW_CHARS_ERROR = 1200;

/**
 * One tool call: what ran, and what it returned, as a single row.
 *
 * The call and its result used to be sibling boxes, each with its own chevron,
 * border and status icon — so a `git fetch` writing "From <url>" to stderr got
 * its own bordered row with a red ✗ against it, which reads as a failure and is
 * not one. The verdict belongs to the CALL and appears once, on the left rail;
 * the output is just output.
 *
 * # Disclosure is by SIZE, not by a fixed rule
 *
 * Small output shows inline, because hiding two lines of `git log` behind a
 * click is worse than showing them. Large output collapses to a summary you
 * can open — and opens into a BOUNDED, scrollable box, so a 200-line JSON
 * document is a panel you scroll rather than a page you scroll past.
 */
function ToolBlockView({
  name,
  input,
  output,
  isError,
  stopped,
  settled,
  skillInstructions,
}: {
  name: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  stopped: boolean;
  settled: boolean;
  /** The SKILL.md text a Skill call added to the conversation. */
  skillInstructions?: string;
}) {
  const described = describeTool(name, input);
  const { label, isCommand } = described;
  const detail = isCommand ? described.detail : shortenPath(described.detail);

  const editDiff = useMemo(() => editDiffFromInput(name, input), [name, input]);
  const fileKind = editDiff ? null : codexFileKind(label, input);
  // An edit's input already says what changed; "updated successfully" adds nothing.
  const out = useMemo(
    () => formatToolOutput(editDiff && !isError ? undefined : output),
    [output, editDiff, isError]
  );

  const maxLines = isError ? PREVIEW_LINES_ERROR : PREVIEW_LINES;
  const maxChars = isError ? PREVIEW_CHARS_ERROR : PREVIEW_CHARS;
  const fitsInline = out.text.length > 0 && out.lines <= maxLines && out.chars <= maxChars;

  // Anything that does not fit starts closed. Errors are the exception: a run
  // that failed should say why without being asked.
  const [open, setOpen] = useState(false);
  const showBody = out.text.length > 0 && (fitsInline || open);
  const hasDiff = !!editDiff && editDiff.lines.length > 0;
  const canToggle = hasDiff || (out.text.length > 0 && !fitsInline);

  const Row = canToggle ? 'button' : 'div';

  return (
    <div className="font-mono text-xs min-w-0">
      <Row
        {...(canToggle
          ? {
              type: 'button' as const,
              'aria-expanded': open,
              onClick: () => setOpen((v) => !v),
            }
          : {})}
        className={cn(
          'flex w-full items-baseline gap-2 min-w-0 text-left',
          canToggle && 'group hover:text-foreground'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex-none w-1.5 h-1.5 rounded-full translate-y-[-1px]',
            !settled && 'bg-warning animate-pulse',
            settled && isError && 'bg-destructive',
            settled && !isError && 'bg-muted-foreground/50'
          )}
        />
        <span className={cn('flex-none font-medium', isError ? 'text-destructive' : 'text-foreground/80')}>
          {label}
        </span>
        {detail && (
          // One line, ellipsised, whole thing in the tooltip. Truncating the
          // string itself is what produced `git clone --depth` with the rest
          // of the command simply gone.
          <span
            className={cn('min-w-0 flex-1 truncate', isCommand ? 'text-muted-foreground' : 'text-muted-foreground')}
            title={detail}
          >
            {detail}
          </span>
        )}
        {editDiff && (
          <span className="flex-none tabular-nums text-[11px] text-muted-foreground">
            <span className="text-success/80">+{editDiff.added}</span> <span className="text-destructive/80">−{editDiff.removed}</span>
          </span>
        )}
        {fileKind && (
          <span
            title={fileKind.title}
            className="flex-none rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground"
          >
            {fileKind.badge}
          </span>
        )}
        {!settled && <span className="flex-none text-[11px] text-muted-foreground">running…</span>}
        {stopped && <span className="flex-none text-[11px] text-muted-foreground">stopped</span>}
        {canToggle && (
          <span className="flex-none flex items-center gap-1 text-[11px] text-muted-foreground">
            {out.text.length > 0 && <span>{out.summary}</span>}
            {open ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        )}
      </Row>

      {showBody && (
        <div
          className={cn(
            'mt-1 ml-[2px] border-l pl-3 py-0.5',
            isError ? 'border-destructive/40' : 'border-border'
          )}
        >
          <pre
            className={cn(
              'whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.55]',
              // Bounded and scrollable once it is open. Without the cap, opening
              // one JSON response pushes the rest of the run off the screen.
              !fitsInline && 'max-h-72 overflow-auto pr-2',
              isError ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {out.text}
          </pre>
        </div>
      )}
      {hasDiff && open && editDiff && <EditDiffBody diff={editDiff} />}
      {skillInstructions && <SkillInstructions text={skillInstructions} />}
    </div>
  );
}

const CODEX_FILE_KINDS: Record<string, { badge: string; title: string }> = {
  add: { badge: 'A', title: 'Added' },
  update: { badge: 'M', title: 'Modified' },
  delete: { badge: 'D', title: 'Deleted' },
};

/** Codex reports a file edit as a path and a kind, with no diff. */
function codexFileKind(label: string, input: unknown): { badge: string; title: string } | null {
  if (label !== 'edit' && label !== 'write') return null;
  const kind = input && typeof input === 'object' ? (input as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' ? (CODEX_FILE_KINDS[kind] ?? null) : null;
}

const DIFF_PREVIEW_LINES = 12;
const DIFF_MARKS = { add: '+', del: '−', ctx: ' ' } as const;

function EditDiffBody({ diff }: { diff: EditDiff }) {
  const [all, setAll] = useState(false);
  const shown = all ? diff.lines : diff.lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = diff.lines.length - shown.length;
  return (
    <div className="mt-1 ml-[2px] border-l border-border pl-3 py-0.5">
      <div className="max-h-72 overflow-auto rounded bg-muted/40 leading-[1.55]">
        {shown.map((line, i) =>
          line.kind === 'hunk' ? (
            <div key={i} className="select-none text-center text-muted-foreground/60">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                'flex gap-2 px-2',
                line.kind === 'add' && 'bg-success/10 text-success',
                line.kind === 'del' && 'bg-destructive/10 text-destructive',
                line.kind === 'ctx' && 'text-muted-foreground'
              )}
            >
              <span aria-hidden className="flex-none select-none">
                {DIFF_MARKS[line.kind]}
              </span>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text}</span>
            </div>
          )
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
    </div>
  );
}

/**
 * The skill's own instructions, closed by default. Claude Code adds them to
 * the conversation as a `user` message, but the person did not send them.
 */
function SkillInstructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 ml-[2px] border-l border-border pl-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Skill instructions
      </button>
      {open && (
        <div className="mt-1 max-h-72 overflow-auto rounded bg-muted px-3 py-2 pr-2 font-sans text-[13px] text-foreground [overflow-wrap:anywhere]">
          {renderMarkdownish(text, 'surface')}
        </div>
      )}
    </div>
  );
}

/**
 * A run of consecutive tool calls, folded into one openable section.
 *
 * This is the shape the reference clients converge on — PostHog desktop's
 * "Ran 3 commands, read a file", Codex's "Explored 4 reads" — and the reason
 * is the same in all of them: an agent does several things to answer one
 * sentence, and rendering each as a top-level row buries the sentences.
 * Closed, this is one line. Open, every call inside keeps its own disclosure.
 *
 * A RUNNING group opens by default: while the agent is working this is the only
 * place progress is visible. So does a group whose last call failed when the turn
 * ended there. Any other failure stays closed and is counted in the summary line.
 */
function ToolGroupView({
  items,
  summary,
  running,
  isError,
  failedCount,
  openOnFailure,
  skills,
}: {
  items: ToolGroupChild[];
  summary: string;
  running: boolean;
  isError: boolean;
  failedCount: number;
  /** The run's last call failed and the turn ended there. */
  openOnFailure: boolean;
  skills: Map<string, string>;
}) {
  // Taken once, at mount, so a group that finishes while open stays open.
  const [open, setOpen] = useState(running || openOnFailure);

  return (
    <div className="font-mono text-xs min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 min-w-0 text-left text-muted-foreground hover:text-foreground"
      >
        <span
          aria-hidden
          className={cn(
            'flex-none w-1.5 h-1.5 rounded-full translate-y-[-1px]',
            running && 'bg-warning animate-pulse',
            !running && isError && 'bg-destructive',
            !running && !isError && 'bg-muted-foreground/50'
          )}
        />
        <span className="min-w-0 truncate">
          {summary}
          {failedCount > 0 && <span className="text-destructive"> · {failedCount} failed</span>}
        </span>
        {running && <span className="flex-none text-[11px] text-muted-foreground">running…</span>}
        {open ? (
          <ChevronDown className="w-3 h-3 flex-none" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-none" />
        )}
      </button>

      {open && (
        <div className="mt-1.5 ml-[2px] border-l border-border pl-3 space-y-2">
          {items.map((item) =>
            item.kind === 'thinking' ? (
              <ThinkingBlock key={item.key} text={item.text} compact />
            ) : (
              <ToolBlockView
                key={item.key}
                name={item.name}
                input={item.input}
                output={item.output}
                isError={item.isError}
                stopped={item.stopped}
                settled={item.settled}
                skillInstructions={skills.get(item.toolId)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

function PermissionBlock({
  toolName,
  toolInput,
  status,
  persist,
  envName,
}: {
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'allowed' | 'denied' | 'auto_allowed';
  persist?: boolean;
  envName?: string;
}) {
  if (status === 'auto_allowed') {
    // One-line summary up top; click to expand the full tool input
    // so the user can audit what ran under the standing approval.
    return (
      <AutoAllowedPermission
        toolName={toolName}
        toolInput={toolInput}
        envName={envName}
      />
    );
  }

  const resolved = status !== 'pending';
  return (
    <div
      className={cn(
        'rounded border px-3 py-2.5 text-[13px]',
        resolved
          ? status === 'allowed'
            ? 'border-success/30 bg-success/5'
            : 'border-destructive/30 bg-destructive/5'
          : 'border-warning/40 bg-warning/10'
      )}
    >
      <div className="flex items-center gap-2 text-xs mb-2">
        <Shield
          className={cn(
            'w-3.5 h-3.5',
            resolved
              ? status === 'allowed'
                ? 'text-success'
                : 'text-destructive'
              : 'text-warning'
          )}
        />
        <span className="font-semibold">
          {resolved
            ? status === 'allowed'
              ? persist
                ? `Allowed ${toolName} (always for this env)`
                : `Allowed ${toolName}`
              : `Denied ${toolName}`
            : `Approve ${toolName}?`}
        </span>
      </div>
      <ToolInputPreview toolName={toolName} toolInput={toolInput} />
    </div>
  );
}


/** The pull request Talyn opened or linked for a workbench, with a button to open it. */
function PullRequestCard({
  text,
  url,
  pullRequest,
}: {
  text: string;
  url?: string;
  pullRequest: NonNullable<Extract<GroupedBlock, { kind: 'system' }>['pullRequest']>;
}) {
  const label = pullRequest.adopted ? text : pullRequest.existing ? 'Linked' : 'Opened';
  const detailId = useWorkbenchStore((s) =>
    prDetailIdFor(s.selectedWorkbenchId ? s.workbenches[s.selectedWorkbenchId] : null, pullRequest.number)
  );
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  return (
    <div className="rounded-md border border-border bg-card text-xs" data-testid="pull-request-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium" title={pullRequest.title}>
          {pullRequest.title ?? `Pull request #${pullRequest.number}`}
        </span>
        <span className="text-muted-foreground">
          #{pullRequest.number} · {label}
        </span>
        {(url || detailId) && (
          <div className="ml-auto flex items-center gap-1.5">
            {detailId && (
              <Button variant="outline" size="sm" onClick={() => openPrDetail(detailId)} aria-label={`Open the details of pull request #${pullRequest.number}`}>
                Details
              </Button>
            )}
            {url && <Button variant="outline" size="sm" onClick={() => void openExternal(url)} aria-label={`Open pull request #${pullRequest.number}`}>
              Open
            </Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** What a workbench's Create PR turn did: the PR it opened, or why it did not. */
function PullRequestLine({ text, url, isError }: { text: string; url?: string; isError?: boolean }) {
  return (
    <div
      className={cn('flex items-start gap-1.5 text-xs', isError ? 'text-destructive' : 'text-muted-foreground')}
      data-testid="pull-request-outcome"
    >
      <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-foreground underline-offset-2 hover:underline">
          {text}
        </a>
      ) : (
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      )}
    </div>
  );
}

/** Chat subtypes the backend writes when the plan refused a turn's box. */
const BOX_REFUSAL_SUBTYPES = new Set(['usage_exhausted', 'box_limit_reached', 'size_requires_pro']);

function SystemBlock({ text, subtype }: { text: string; subtype?: string }) {
  if (subtype === 'talyn_interruption') {
    return <div className="text-xs text-muted-foreground">Interrupted</div>;
  }
  if (subtype && BOX_REFUSAL_SUBTYPES.has(subtype)) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs"
        data-testid="box-refusal-note"
      >
        <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text || (subtype === 'usage_exhausted' ? 'Out of box-hours. This message waits in the queue.' : 'All your boxes are busy. This message waits in the queue.')}
        </p>
        <BoxRefusalAction code={subtype} notice={text ? { message: text } : null} />
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">
      {subtype ? <span className="uppercase tracking-wide mr-1">{subtype}</span> : null}
      {text}
    </div>
  );
}

function ResultBlock({
  summary,
  costUsd,
  inputTokens,
  outputTokens,
  isError,
  denials,
}: {
  summary: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError: boolean;
  denials: number;
}) {
  return (
    <div
      className={cn(
        'mt-3 pt-2 border-t text-xs flex flex-wrap items-center gap-3',
        isError ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground'
      )}
    >
      <span className={isError ? 'font-medium' : ''}>
        {isError ? 'Ended with error' : 'Run complete'}
      </span>
      {isError && <p className="basis-full whitespace-pre-wrap break-words">{summary || 'The agent stopped unexpectedly.'}</p>}
      {typeof costUsd === 'number' && <span>${costUsd.toFixed(4)}</span>}
      {(inputTokens ?? outputTokens) !== undefined && (
        <span>
          {inputTokens ?? 0}→{outputTokens ?? 0} tok
        </span>
      )}
      {denials > 0 && (
        <span className="text-warning">
          {denials} permission den{denials === 1 ? 'ial' : 'ials'}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

/**
 * Collapsed-by-default auto-allowed row: shows tool name + env, click
 * the chevron to see the same tool-aware input preview as an
 * interactive permission card. Keeps the transcript honest about
 * what actually ran without drowning the view in green rows.
 */
function AutoAllowedPermission({
  toolName,
  toolInput,
  envName,
}: {
  toolName: string;
  toolInput: unknown;
  envName?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = describeTool(toolName, toolInput).detail;
  return (
    <div className="rounded border border-success/20 bg-success/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-xs text-left hover:bg-success/10"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 flex-none text-success mt-0.5" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-none text-success mt-0.5" />
        )}
        <Shield className="w-3.5 h-3.5 flex-none text-success mt-0.5" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-success">
          <span className="font-medium">{toolName}</span>
          {summary && (
            <span className="ml-2 text-success font-mono font-normal">
              {summary}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="text-[11px] text-success italic">
            Auto-allowed — pre-approved for {envName ?? 'this environment'}.
          </div>
          <ToolInputPreview toolName={toolName} toolInput={toolInput} />
        </div>
      )}
    </div>
  );
}

/**
 * Tool-aware preview for permission cards. Raw JSON is unreadable for
 * common tools (Grep, Bash, Edit, ...) — instead surface the fields
 * that matter for an approval decision. User can still drill into the
 * full JSON via the "Show full input" toggle.
 *
 * Unknown tools fall back to the JSON dump so this is never worse
 * than the previous default.
 */
function ToolInputPreview({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: unknown;
}) {
  const [showJson, setShowJson] = useState(false);
  const summary = renderToolInputSummary(toolName, toolInput);

  return (
    <div className="space-y-2">
      {summary ?? <PrettyJson value={toolInput} />}
      {summary && (
        <button
          type="button"
          onClick={() => setShowJson((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {showJson ? 'Hide full input' : 'Show full input'}
        </button>
      )}
      {summary && showJson && <PrettyJson value={toolInput} />}
    </div>
  );
}

function renderToolInputSummary(
  toolName: string,
  toolInput: unknown
): React.ReactNode | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  const field = (
    label: string,
    value: unknown,
    opts: { mono?: boolean; block?: boolean } = {}
  ) => {
    if (value === undefined || value === null || value === '') return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (
      <div
        key={label}
        className={cn(
          'flex gap-2',
          opts.block ? 'flex-col' : 'items-baseline'
        )}
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">
          {label}
        </span>
        <span
          className={cn(
            'text-foreground break-all',
            opts.mono && 'font-mono text-xs'
          )}
        >
          {text}
        </span>
      </div>
    );
  };

  const wrap = (children: React.ReactNode) => (
    <div className="bg-muted rounded p-2 space-y-1">{children}</div>
  );

  switch (toolName) {
    case 'Bash':
      return wrap(
        <>
          {field('command', input.command, { mono: true, block: true })}
          {field('description', input.description)}
          {typeof input.timeout === 'number' && field('timeout', `${input.timeout}ms`)}
        </>
      );
    case 'Read':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {input.offset !== undefined && field('offset', input.offset)}
          {input.limit !== undefined && field('limit', input.limit)}
        </>
      );
    case 'Edit':
    case 'Write':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {typeof input.old_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                replace
              </div>
              <pre className="font-mono text-xs bg-destructive/10 text-destructive rounded px-2 py-1 whitespace-pre-wrap break-all">
                {truncate(input.old_string as string, 400)}
              </pre>
            </div>
          )}
          {typeof input.new_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                with
              </div>
              <pre className="font-mono text-xs bg-success/10 text-success rounded px-2 py-1 whitespace-pre-wrap break-all">
                {truncate(input.new_string as string, 400)}
              </pre>
            </div>
          )}
          {toolName === 'Write' && typeof input.content === 'string' && (
            <pre className="font-mono text-xs bg-success/10 text-success rounded px-2 py-1 whitespace-pre-wrap break-all">
              {truncate(input.content as string, 400)}
            </pre>
          )}
        </>
      );
    case 'Grep':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
          {field('glob', input.glob, { mono: true })}
          {field('type', input.type)}
          {field('output', input.output_mode)}
        </>
      );
    case 'Glob':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
        </>
      );
    case 'WebFetch':
    case 'WebSearch':
      return wrap(
        <>
          {field('url', input.url, { mono: true })}
          {field('query', input.query)}
          {field('prompt', input.prompt)}
        </>
      );
    case 'Task':
    case 'Agent':
      return wrap(
        <>
          {field('description', input.description)}
          {field('subagent', input.subagent_type)}
          {typeof input.prompt === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                prompt
              </div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-all text-foreground">
                {truncate(input.prompt as string, 600)}
              </pre>
            </div>
          )}
        </>
      );
    default:
      return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [${text.length - max} more chars]`;
}

function PrettyJson({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap text-foreground bg-muted rounded p-2 overflow-x-auto">
      {text}
    </pre>
  );
}

/**
 * Tool-aware one-liner for the collapsed tool_use / auto-allowed row.
 * Goal: answer "what did Claude just do?" at a glance without forcing
 * a click. Unknown tools fall back to the old generic arg dump.
 */
/**
 * Strip the absolute prefix off a path so the user sees the
 * repo-relative bit. We don't know the repo root from the renderer,
 * so we slice from the first monorepo-looking segment (packages/apps/
 * src) and otherwise tilde the user's home. Not perfect, but kills
 * the noisy /Users/<me>/dev/<org>/<repo>/ prefix 99% of the time.
 */
function shortenPath(p: string): string {
  // The fleet checks every repo out under /work/<repo>/, so that prefix is on
  // every path a fleet run mentions and carries no information at all. Stripped
  // first because a monorepo path would otherwise keep it.
  const work = p.match(/^\/work\/[^/]+\/(.+)$/);
  if (work) return work[1];
  for (const marker of ['/packages/', '/apps/']) {
    const idx = p.indexOf(marker);
    if (idx !== -1) return p.slice(idx + 1);
  }
  const srcIdx = p.indexOf('/src/');
  if (srcIdx !== -1) {
    // Include the dir before /src/ for context (often the repo name).
    const before = p.lastIndexOf('/', srcIdx - 1);
    if (before !== -1) return p.slice(before + 1);
  }
  if (p.startsWith('/Users/') || p.startsWith('/home/')) {
    const after = p.indexOf('/', p.indexOf('/', 1) + 1);
    if (after !== -1) return '~' + p.slice(after);
  }
  return p;
}
