import { openExternal } from '../../lib/openExternal';
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitPullRequest, Shield } from 'lucide-react';
import { cn } from '../../lib/utils';
import { renderMarkdownish } from '../../lib/markdown';
import { skillInstructionsByToolId } from '../../lib/skillInstructions';
import type { AgentEvent, GroupedBlock, ToolBlock } from '@talyn/shared';
import {
  buildBlocks,
  describeTool,
  formatToolOutput,
  groupToolRuns,
  groupedBlockSignature,
  mergeToolBlocks,
  parseAutoPrDetails,
  stripAutoPrBlock,
  stripPlanBlocks,
} from '@talyn/shared';

export function AgentBlocks({
  events,
  envName,
  scopeId,
  hideCompletedResults = false,
}: {
  events: AgentEvent[];
  envName?: string;
  scopeId?: string;
  hideCompletedResults?: boolean;
}) {
  const blocks = useMemo(() => {
    const all = groupToolRuns(mergeToolBlocks(buildBlocks(events)));
    return hideCompletedResults ? all.filter((b) => b.kind !== 'result' || b.isError) : all;
  }, [events, hideCompletedResults]);
  const skills = useMemo(() => skillInstructionsByToolId(events), [events]);
  return (
    <>
      {blocks.map((block) => (
        <BlockView
          key={`${scopeId ?? ''}:${block.key}`}
          block={block}
          envName={envName}
          scopeId={scopeId}
          skills={skills}
        />
      ))}
    </>
  );
}

function skillsSignature(block: GroupedBlock, skills: Map<string, string>): string {
  const tools = block.kind === 'tool' ? [block] : block.kind === 'tool_group' ? block.tools : [];
  return tools.map((t) => skills.get(t.toolId)?.length ?? 0).join(',');
}

const BlockView = React.memo(
  BlockViewImpl,
  (prev, next) =>
    prev.envName === next.envName &&
    prev.scopeId === next.scopeId &&
    groupedBlockSignature(prev.block) === groupedBlockSignature(next.block) &&
    skillsSignature(prev.block, prev.skills) === skillsSignature(next.block, next.skills),
);

function BlockViewImpl({
  block,
  envName,
  skills,
}: {
  block: GroupedBlock;
  envName?: string;
  scopeId?: string;
  skills: Map<string, string>;
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
          tools={block.tools}
          summary={block.summary}
          running={block.running}
          isError={block.isError}
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
      if (block.subtype === 'talyn_pr')
        return <PullRequestLine text={block.text} url={block.url} isError={block.isError} />;
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
  const pr = parseAutoPrDetails(text);
  const shown = stripPlanBlocks(stripAutoPrBlock(text));
  if (!shown && !pr.ok) return null;
  return (
    <div className="text-[13px] text-foreground min-w-0 [overflow-wrap:anywhere]">
      {shown ? renderMarkdownish(shown, 'surface') : null}
      {pr.ok && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded border border-border px-3 py-2 text-xs"
          data-testid="pull-request-card"
        >
          <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Pull request ready: {pr.details.title}</span>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split('\n').find((l) => l.trim()) ?? 'Thinking';
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left hover:text-foreground min-w-0"
      >
        <span className="flex-none text-muted-foreground select-none">✻</span>
        <span className={cn('italic min-w-0 flex-1', !open && 'truncate')}>{open ? 'Thinking' : firstLine}</span>
      </button>
      {open && (
        <div className="mt-1 ml-[13px] whitespace-pre-wrap italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {text}
        </div>
      )}
    </div>
  );
}

const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 500;
const PREVIEW_LINES_ERROR = 14;
const PREVIEW_CHARS_ERROR = 1200;

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
  skillInstructions?: string;
}) {
  const described = describeTool(name, input);
  const { label, isCommand } = described;
  const detail = isCommand ? described.detail : shortenPath(described.detail);

  const out = useMemo(() => formatToolOutput(output), [output]);

  const maxLines = isError ? PREVIEW_LINES_ERROR : PREVIEW_LINES;
  const maxChars = isError ? PREVIEW_CHARS_ERROR : PREVIEW_CHARS;
  const fitsInline = out.text.length > 0 && out.lines <= maxLines && out.chars <= maxChars;
  const [open, setOpen] = useState(false);
  const showBody = out.text.length > 0 && (fitsInline || open);
  const canToggle = out.text.length > 0 && !fitsInline;

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
        className={cn('flex w-full items-baseline gap-2 min-w-0 text-left', canToggle && 'group hover:text-foreground')}
      >
        <span
          aria-hidden
          className={cn(
            'flex-none w-1.5 h-1.5 rounded-full translate-y-[-1px]',
            !settled && 'bg-warning animate-pulse',
            settled && isError && 'bg-destructive',
            settled && !isError && 'bg-muted-foreground/50',
          )}
        />
        <span className={cn('flex-none font-medium', isError ? 'text-destructive' : 'text-foreground/80')}>
          {label}
        </span>
        {detail && (
          <span
            className={cn('min-w-0 flex-1 truncate', isCommand ? 'text-muted-foreground' : 'text-muted-foreground')}
            title={detail}
          >
            {detail}
          </span>
        )}
        {!settled && <span className="flex-none text-[11px] text-muted-foreground">running…</span>}
        {stopped && <span className="flex-none text-[11px] text-muted-foreground">stopped</span>}
        {canToggle && (
          <span className="flex-none flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>{out.summary}</span>
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        )}
      </Row>

      {showBody && (
        <div className={cn('mt-1 ml-[2px] border-l pl-3 py-0.5', isError ? 'border-destructive/40' : 'border-border')}>
          <pre
            className={cn(
              'whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.55]',
              !fitsInline && 'max-h-72 overflow-auto pr-2',
              isError ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {out.text}
          </pre>
        </div>
      )}
      {skillInstructions && <SkillInstructions text={skillInstructions} />}
    </div>
  );
}

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

function ToolGroupView({
  tools,
  summary,
  running,
  isError,
  skills,
}: {
  tools: ToolBlock[];
  summary: string;
  running: boolean;
  isError: boolean;
  skills: Map<string, string>;
}) {
  const [open, setOpen] = useState(isError || running);

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
            !running && !isError && 'bg-muted-foreground/50',
          )}
        />
        <span className={cn('min-w-0 truncate', isError && 'text-destructive')}>{summary}</span>
        {running && <span className="flex-none text-[11px] text-muted-foreground">running…</span>}
        {open ? <ChevronDown className="w-3 h-3 flex-none" /> : <ChevronRight className="w-3 h-3 flex-none" />}
      </button>

      {open && (
        <div className="mt-1.5 ml-[2px] border-l border-border pl-3 space-y-2">
          {tools.map((t) => (
            <ToolBlockView
              key={t.key}
              name={t.name}
              input={t.input}
              output={t.output}
              isError={t.isError}
              stopped={t.stopped}
              settled={t.settled}
              skillInstructions={skills.get(t.toolId)}
            />
          ))}
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
    return <AutoAllowedPermission toolName={toolName} toolInput={toolInput} envName={envName} />;
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
          : 'border-warning/40 bg-warning/10',
      )}
    >
      <div className="flex items-center gap-2 text-xs mb-2">
        <Shield
          className={cn(
            'w-3.5 h-3.5',
            resolved ? (status === 'allowed' ? 'text-success' : 'text-destructive') : 'text-warning',
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

function PullRequestLine({ text, url, isError }: { text: string; url?: string; isError?: boolean }) {
  return (
    <div
      className={cn('flex items-start gap-1.5 text-xs', isError ? 'text-destructive' : 'text-muted-foreground')}
      data-testid="pull-request-outcome"
    >
      <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {url ? (
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault();
            openExternal(url);
          }}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline-offset-2 hover:underline"
        >
          {text}
        </a>
      ) : (
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      )}
    </div>
  );
}

function SystemBlock({ text, subtype }: { text: string; subtype?: string }) {
  if (subtype === 'talyn_interruption') {
    return <div className="text-xs text-muted-foreground">Interrupted</div>;
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
        isError ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground',
      )}
    >
      <span className={isError ? 'font-medium' : ''}>{isError ? 'Ended with error' : 'Run complete'}</span>
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
          {summary && <span className="ml-2 text-success font-mono font-normal">{summary}</span>}
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

function ToolInputPreview({ toolName, toolInput }: { toolName: string; toolInput: unknown }) {
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

function renderToolInputSummary(toolName: string, toolInput: unknown): React.ReactNode | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  const field = (label: string, value: unknown, opts: { mono?: boolean; block?: boolean } = {}) => {
    if (value === undefined || value === null || value === '') return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (
      <div key={label} className={cn('flex gap-2', opts.block ? 'flex-col' : 'items-baseline')}>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">{label}</span>
        <span className={cn('text-foreground break-all', opts.mono && 'font-mono text-xs')}>{text}</span>
      </div>
    );
  };

  const wrap = (children: React.ReactNode) => <div className="bg-muted rounded p-2 space-y-1">{children}</div>;

  switch (toolName) {
    case 'Bash':
      return wrap(
        <>
          {field('command', input.command, { mono: true, block: true })}
          {field('description', input.description)}
          {typeof input.timeout === 'number' && field('timeout', `${input.timeout}ms`)}
        </>,
      );
    case 'Read':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {input.offset !== undefined && field('offset', input.offset)}
          {input.limit !== undefined && field('limit', input.limit)}
        </>,
      );
    case 'Edit':
    case 'Write':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {typeof input.old_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">replace</div>
              <pre className="font-mono text-xs bg-destructive/10 text-destructive rounded px-2 py-1 whitespace-pre-wrap break-all">
                {truncate(input.old_string as string, 400)}
              </pre>
            </div>
          )}
          {typeof input.new_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">with</div>
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
        </>,
      );
    case 'Grep':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
          {field('glob', input.glob, { mono: true })}
          {field('type', input.type)}
          {field('output', input.output_mode)}
        </>,
      );
    case 'Glob':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
        </>,
      );
    case 'WebFetch':
    case 'WebSearch':
      return wrap(
        <>
          {field('url', input.url, { mono: true })}
          {field('query', input.query)}
          {field('prompt', input.prompt)}
        </>,
      );
    case 'Task':
    case 'Agent':
      return wrap(
        <>
          {field('description', input.description)}
          {field('subagent', input.subagent_type)}
          {typeof input.prompt === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">prompt</div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-all text-foreground">
                {truncate(input.prompt as string, 600)}
              </pre>
            </div>
          )}
        </>,
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

function shortenPath(p: string): string {
  const work = p.match(/^\/work\/[^/]+\/(.+)$/);
  if (work) return work[1];
  for (const marker of ['/packages/', '/apps/']) {
    const idx = p.indexOf(marker);
    if (idx !== -1) return p.slice(idx + 1);
  }
  const srcIdx = p.indexOf('/src/');
  if (srcIdx !== -1) {
    const before = p.lastIndexOf('/', srcIdx - 1);
    if (before !== -1) return p.slice(before + 1);
  }
  if (p.startsWith('/Users/') || p.startsWith('/home/')) {
    const after = p.indexOf('/', p.indexOf('/', 1) + 1);
    if (after !== -1) return '~' + p.slice(after);
  }
  return p;
}
