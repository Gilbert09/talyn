import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, FolderGit2, GitBranch, GitPullRequest, Layers, Split, X } from 'lucide-react';
import type { WorkbenchAgent } from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import type { Choice } from '../../../lib/readiness';
import { cn } from '../../../lib/utils';
import { OPEN_REPOSITORY_PICKER_EVENT, formatKeys } from '../../../lib/shortcuts';
import { FleetAgentMark } from '../../../lib/providerMeta';
import type { WatchedRepo } from '../../../stores/workspace';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
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

export const AGENT_LABEL: Record<WorkbenchAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** The vendor's short name, for a sentence. */
const AGENT_NAME: Record<WorkbenchAgent, string> = { claude: 'Claude', codex: 'Codex' };

const chipClass =
  'inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

export const ControlChip = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(chipClass, className)} {...props} />
  ),
);
ControlChip.displayName = 'ControlChip';

/** The repository picker's value for a thread: no one repository, so the work can cross several. */
export const ANY_REPOSITORY = 'any-repository';

/** The `owner/name` shape the backend accepts. */
const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

export function RepoPicker({
  repositories,
  value,
  onChange,
  disabled,
  allowAnyRepository = false,
  extraAction,
  emptyText = 'No watched repository matches.',
  allowCustom = false,
  composerShortcut = true,
  placeholder = 'Choose a repository',
  className,
}: {
  repositories: WatchedRepo[];
  value: string;
  onChange: (repositoryId: string) => void;
  disabled?: boolean;
  /** Offer "Any repository", which starts a thread. */
  allowAnyRepository?: boolean;
  /** One more item under the list, like "Add repository to space…". */
  extraAction?: { label: string; onSelect: () => void };
  emptyText?: string;
  /** Offer a typed `owner/name` that is not in the list. `onChange` then gets the name, not an id. */
  allowCustom?: boolean;
  /** The composer's picker: opens on `/` and gives focus back to the composer when it closes. */
  composerShortcut?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (disabled || !composerShortcut) return undefined;
    const show = () => setOpen(true);
    window.addEventListener(OPEN_REPOSITORY_PICKER_EVENT, show);
    return () => window.removeEventListener(OPEN_REPOSITORY_PICKER_EVENT, show);
  }, [disabled, composerShortcut]);
  const current = repositories.find((r) => r.id === value);
  const anyRepository = allowAnyRepository && value === ANY_REPOSITORY;
  const label = anyRepository ? 'Any repository' : current?.fullName ?? (allowCustom && value ? value : placeholder);
  const typed = search.trim();
  const customName =
    allowCustom &&
    REPO_FULL_NAME.test(typed) &&
    !repositories.some((r) => r.fullName.toLowerCase() === typed.toLowerCase())
      ? typed
      : null;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch('');
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <ControlChip
          aria-label="Repository"
          data-attr={composerShortcut ? 'new-workbench-repo' : 'repo-picker'}
          disabled={disabled}
          className={className}
        >
          {anyRepository ? <Layers className="h-3.5 w-3.5 shrink-0" /> : <FolderGit2 className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate font-medium text-foreground">{label}</span>
          <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
          {composerShortcut && <Kbd keys="/" />}
        </ControlChip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        onCloseAutoFocus={(event: Event) => {
          if (!composerShortcut) return;
          event.preventDefault();
          document.querySelector<HTMLTextAreaElement>('[data-new-workbench-composer]')?.focus();
        }}
      >
        <Command>
          <CommandInput
            ref={searchRef}
            value={search}
            onValueChange={setSearch}
            placeholder={allowCustom ? 'Find a repository, or type owner/name…' : 'Find a repository…'}
          />
          <CommandList>
            {!customName && <CommandEmpty>{emptyText}</CommandEmpty>}
            {customName && (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value={`__custom ${customName}`}
                  data-attr="repo-picker-custom"
                  onSelect={() => {
                    onChange(customName);
                    changeOpen(false);
                  }}
                >
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    Use <span className="font-medium">{customName}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {allowAnyRepository && (
              <CommandGroup>
                <CommandItem
                  value="Any repository thread"
                  data-attr="new-workbench-any-repository"
                  onSelect={() => {
                    onChange(ANY_REPOSITORY);
                    changeOpen(false);
                  }}
                >
                  <Layers className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">Any repository</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      Starts a thread. It can work across repositories.
                    </span>
                  </span>
                  {anyRepository && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={allowAnyRepository ? 'Repositories' : undefined}>
              {repositories.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.fullName}
                  onSelect={() => {
                    onChange(r.id);
                    changeOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                  {r.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
            {extraAction && (
              <CommandGroup>
                <CommandItem
                  value={`__action ${extraAction.label}`}
                  data-attr="repo-picker-extra-action"
                  onSelect={() => {
                    changeOpen(false);
                    extraAction.onSelect();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{extraAction.label}</span>
                </CommandItem>
              </CommandGroup>
            )}
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
        <ControlChip
          aria-label="Create from"
          data-attr="new-workbench-from"
          title={`Create from a branch or a pull request (${formatKeys('mod+i')})`}
        >
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
              <p className="text-xs text-muted-foreground">
                Check out a branch that already exists instead of making a new one.
              </p>
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

export function AgentPicker({
  value,
  onChange,
  choiceFor,
  onConnect,
}: {
  value: WorkbenchAgent | null;
  onChange: (agent: WorkbenchAgent) => void;
  choiceFor: (agent: WorkbenchAgent) => Choice;
  /** Opens the place to connect an agent. Without it, an unconnected agent is only disabled. */
  onConnect?: (agent: WorkbenchAgent) => void;
}) {
  const [open, setOpen] = useState(false);
  const agents = useMemo(
    () =>
      (['claude', 'codex'] as const).map((a) => ({
        agent: a,
        choice: choiceFor(a),
      })),
    [choiceFor],
  );
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
          {agents.map(({ agent, choice }) => {
            // An agent the workspace has not connected is a link to connect it, not a dead row.
            const connect = !choice.available && choice.connect && onConnect ? onConnect : null;
            return (
              <li key={agent} role="option" aria-selected={agent === value} aria-disabled={!choice.available}>
                <button
                  type="button"
                  disabled={!choice.available && !connect}
                  onClick={() => {
                    if (connect) connect(agent);
                    else onChange(agent);
                    setOpen(false);
                  }}
                  data-attr={connect ? `new-workbench-connect-${agent}` : undefined}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <FleetAgentMark agent={agent} className={cn('mt-0.5 h-4 w-4', !choice.available && 'opacity-50')} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block', !choice.available && 'text-muted-foreground')}>{AGENT_LABEL[agent]}</span>
                    {(choice.reason || choice.warning) && (
                      <span className="block text-[11px] text-muted-foreground">{choice.reason ?? choice.warning}</span>
                    )}
                  </span>
                  {connect && (
                    <span className="mt-0.5 shrink-0 text-[11px] font-medium text-primary">
                      {choice.connect === 'reauth' ? 'Sign in' : 'Connect'}
                    </span>
                  )}
                  {agent === value && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The agents, other than `current`, that the workspace must connect before they can run. */
export function unconnectedAgents(
  current: WorkbenchAgent,
  choiceFor: (agent: WorkbenchAgent) => Choice,
): Array<{ agent: WorkbenchAgent; fix: NonNullable<Choice['connect']> }> {
  return (['claude', 'codex'] as const).flatMap((agent) => {
    const fix = agent === current ? undefined : choiceFor(agent).connect;
    return fix ? [{ agent, fix }] : [];
  });
}

/**
 * "Claude is not connected …" under a new-session composer. Without it, a
 * workspace with only Codex quietly starts every session on Codex, and the
 * Claude models look missing rather than locked.
 */
export function ConnectAgentNotice({
  agents,
  onConnect,
}: {
  agents: ReturnType<typeof unconnectedAgents>;
  onConnect: (agent: WorkbenchAgent) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <>
      {agents.map(({ agent, fix }) => {
        const name = AGENT_NAME[agent];
        return (
          <p key={agent} className="text-muted-foreground" data-attr={`new-workbench-${agent}-not-connected`}>
            {fix === 'reauth'
              ? `The ${name} sign-in for this workspace has expired, so ${name} models cannot run.`
              : `${name} is not connected to this workspace, so ${name} models cannot run.`}{' '}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => onConnect(agent)}
            >
              {fix === 'reauth' ? `Sign in to ${name} again` : `Connect ${name}`}
            </button>
          </p>
        );
      })}
    </>
  );
}
