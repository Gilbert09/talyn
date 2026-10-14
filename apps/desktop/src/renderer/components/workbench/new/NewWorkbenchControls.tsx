import React, { useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Cloud, FolderGit2, GitBranch, GitPullRequest, Laptop, Split, X } from 'lucide-react';
import type { WorkbenchAgent } from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import type { Choice, WorkbenchRuntime } from '../../../lib/readiness';
import { cn } from '../../../lib/utils';
import { formatKeys } from '../../../lib/shortcuts';
import { FleetAgentMark } from '../../../lib/providerMeta';
import type { WatchedRepo } from '../../../stores/workspace';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { Kbd } from '../../ui/kbd';

/** Where the workbench's branch comes from. */
export type NewWorkbenchSource =
  | { kind: 'new' }
  | { kind: 'branch'; branch: string }
  | {
      kind: 'pr';
      pullRequestId: string;
      /** 0 when the row is not in the open-PR store (yet). */
      number: number;
      title: string;
      headBranch: string;
      baseBranch: string;
    };

export const NEW_BRANCH: NewWorkbenchSource = { kind: 'new' };

export const AGENT_LABEL: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

const chipClass =
  'inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

export const ControlChip = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(chipClass, className)} {...props} />
  )
);
ControlChip.displayName = 'ControlChip';

export function RepoPicker({
  repositories,
  value,
  onChange,
  disabled,
}: {
  repositories: WatchedRepo[];
  value: string;
  onChange: (repositoryId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = repositories.find((r) => r.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ControlChip aria-label="Repository" data-attr="new-workbench-repo" disabled={disabled}>
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{current?.fullName ?? 'Choose a repository'}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </ControlChip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find a repository…" />
          <CommandList>
            <CommandEmpty>No watched repository matches.</CommandEmpty>
            <CommandGroup>
              {repositories.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.fullName}
                  onSelect={() => {
                    onChange(r.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                  {r.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function BaseBranchField({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  // Filter only while typing; a click shows every branch.
  const [typing, setTyping] = useState(false);
  const anchor = useRef<HTMLLabelElement>(null);
  const query = typing ? value.trim().toLowerCase() : '';
  const matches = suggestions.filter((b) => b.toLowerCase().includes(query));
  const shown = open && matches.length > 0;
  const toggle = () => {
    setTyping(false);
    setOpen((o) => !o);
  };
  const pick = (branch: string) => {
    onChange(branch);
    setOpen(false);
  };

  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <label ref={anchor} className={cn(chipClass, 'cursor-text gap-1 hover:bg-accent/60')} title="Base branch">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <input
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setTyping(true);
              setOpen(true);
            }}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setTyping(false);
                setOpen(true);
              } else if ((e.key === 'Escape' || e.key === 'Enter') && shown) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={shown}
            aria-controls="new-workbench-base-branches"
            aria-autocomplete="list"
            spellCheck={false}
            aria-label="Base branch"
            className="w-28 min-w-0 border-0 bg-transparent p-0 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
          />
          {suggestions.length > 0 && (
            <button type="button" tabIndex={-1} aria-label="Show branches" onClick={toggle} className="shrink-0">
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </label>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="max-h-64 w-56 overflow-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // A click on the field itself toggles; do not close here and reopen there.
          if (anchor.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <ul id="new-workbench-base-branches" role="listbox" aria-label="Branches">
          {matches.map((b) => (
            <li key={b} role="option" aria-selected={b === value}>
              <button
                type="button"
                onClick={() => pick(b)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{b}</span>
                {b === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** "Create from…" (⌘I): start from an existing branch or an open pull request instead of a new branch. */
export function CreateFromPopover({
  open,
  onOpenChange,
  source,
  onChange,
  pullRequests,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: NewWorkbenchSource;
  onChange: (source: NewWorkbenchSource) => void;
  pullRequests: PRRow[];
}) {
  const [tab, setTab] = useState<'branch' | 'pr'>(source.kind === 'branch' ? 'branch' : 'pr');
  const [branch, setBranch] = useState(source.kind === 'branch' ? source.branch : '');
  const pick = (next: NewWorkbenchSource) => {
    onChange(next);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <ControlChip aria-label="Create from" data-attr="new-workbench-from" title={`Create from a branch or a pull request (${formatKeys('mod+i')})`}>
          <Split className="h-3.5 w-3.5 shrink-0" />
          {source.kind === 'new' ? 'Create from…' : 'Change…'}
        </ControlChip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'branch' | 'pr')}>
          <div className="flex items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="branch">Branch</TabsTrigger>
              <TabsTrigger value="pr">Pull request</TabsTrigger>
            </TabsList>
            <Kbd keys={formatKeys('mod+i')} />
          </div>
          <TabsContent value="branch">
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (branch.trim()) pick({ kind: 'branch', branch: branch.trim() });
              }}
            >
              <p className="text-xs text-muted-foreground">Check out a branch that already exists instead of making a new one.</p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/my-branch"
                  spellCheck={false}
                  aria-label="Existing branch"
                  list="new-workbench-existing-branches"
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <datalist id="new-workbench-existing-branches">
                  {pullRequests.map((r) => (
                    <option key={r.id} value={r.summary.headBranch} />
                  ))}
                </datalist>
                <button
                  type="submit"
                  disabled={!branch.trim()}
                  className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  Use branch
                </button>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="pr" className="-mx-2 -mb-2">
            <Command className="bg-transparent">
              <CommandInput placeholder="Find an open pull request…" />
              <CommandList className="max-h-64">
                <CommandEmpty>No open pull request in this repository.</CommandEmpty>
                <CommandGroup>
                  {pullRequests.map((r) => (
                    <CommandItem
                      key={r.id}
                      value={`${r.number} ${r.summary.title} ${r.summary.headBranch}`}
                      onSelect={() =>
                        pick({
                          kind: 'pr',
                          pullRequestId: r.id,
                          number: r.number,
                          title: r.summary.title,
                          headBranch: r.summary.headBranch,
                          baseBranch: r.summary.baseBranch,
                        })
                      }
                    >
                      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{r.number}</span>
                      <span className="min-w-0 flex-1 truncate">{r.summary.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

/** The chosen source as a removable chip. Esc in the composer removes it too. */
export function SourceChip({ source, onClear }: { source: NewWorkbenchSource; onClear: () => void }) {
  if (source.kind === 'new') return null;
  const label =
    source.kind === 'pr' ? (
      <>
        <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
        {source.number > 0 && <span className="font-mono">#{source.number}</span>}
        <span className="truncate">{source.title}</span>
      </>
    ) : (
      <>
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono">{source.branch}</span>
      </>
    );
  return (
    <span
      data-attr="new-workbench-source"
      className="inline-flex h-7 max-w-[20rem] items-center gap-1.5 rounded-md bg-primary/10 pl-2 pr-1 text-xs text-primary"
    >
      {label}
      <button
        type="button"
        onClick={onClear}
        className="rounded p-0.5 hover:bg-primary/15"
        aria-label="Start from a new branch instead"
        title="Start from a new branch instead (Esc)"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

const RUNTIMES: Array<{ value: WorkbenchRuntime; label: string; icon: typeof Cloud; hint: string }> = [
  { value: 'sandbox', label: 'Sandbox', icon: Cloud, hint: 'A Talyn Fleet microVM. Keeps working when this computer sleeps.' },
  { value: 'local', label: 'Local', icon: Laptop, hint: 'A git worktree on this computer, with your own tools.' },
];

/** Sandbox | Local. A runtime readiness refuses stays visible, disabled, with the reason on hover. */
export function RuntimeToggle({
  value,
  onChange,
  choices,
}: {
  value: WorkbenchRuntime;
  onChange: (runtime: WorkbenchRuntime) => void;
  choices: Record<WorkbenchRuntime, Choice>;
}) {
  return (
    <div role="radiogroup" aria-label="Runtime" className="inline-flex h-7 items-center rounded-md bg-muted p-0.5">
      {RUNTIMES.map((r) => {
        const choice = choices[r.value];
        const active = value === r.value;
        const Icon = r.icon;
        return (
          <Tooltip key={r.value}>
            <TooltipTrigger asChild>
              {/* A span, so the tooltip still opens over a disabled button. */}
              <span className="inline-flex">
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!choice.available}
                  onClick={() => onChange(r.value)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {r.label}
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{choice.available ? (choice.warning ?? r.hint) : choice.reason}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function AgentPicker({
  value,
  onChange,
  choiceFor,
}: {
  value: WorkbenchAgent | null;
  onChange: (agent: WorkbenchAgent) => void;
  choiceFor: (agent: WorkbenchAgent) => Choice;
}) {
  const [open, setOpen] = useState(false);
  const agents = useMemo(() => (['claude', 'codex'] as const).map((a) => ({ agent: a, choice: choiceFor(a) })), [choiceFor]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ControlChip aria-label="Agent" data-attr="new-workbench-agent">
          {value ? <FleetAgentMark agent={value} className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{value ? AGENT_LABEL[value] : 'No agent'}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </ControlChip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <ul role="listbox" aria-label="Agent">
          {agents.map(({ agent, choice }) => (
            <li key={agent} role="option" aria-selected={agent === value} aria-disabled={!choice.available}>
              <button
                type="button"
                disabled={!choice.available}
                onClick={() => {
                  onChange(agent);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <FleetAgentMark agent={agent} className={cn('mt-0.5 h-4 w-4', !choice.available && 'opacity-50')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block', !choice.available && 'text-muted-foreground')}>{AGENT_LABEL[agent]}</span>
                  {(choice.reason || choice.warning) && (
                    <span className="block text-[11px] text-muted-foreground">{choice.reason ?? choice.warning}</span>
                  )}
                </span>
                {agent === value && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
