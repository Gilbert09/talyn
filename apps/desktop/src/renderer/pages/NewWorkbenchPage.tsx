import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, FolderOpen, Loader2 } from 'lucide-react';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type WorkbenchAgent,
  type WorkbenchEffort,
} from '@talyn/shared';
import { cn } from '../lib/utils';
import { readSessionDefaults } from '../lib/sessionDefaults';
import { FOCUS_COMPOSER_EVENT, formatKeys } from '../lib/shortcuts';
import { agentChoice, runtimeChoice, useReadiness, type WorkbenchRuntime } from '../lib/readiness';
import { useWorkspaceStore } from '../stores/workspace';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkbenchStore, type NewWorkbenchPrefill } from '../stores/workbenches';
import { TooltipProvider } from '../components/ui/tooltip';
import { EffortPicker, ModelPicker, PlanToggle } from '../components/workbench/ComposerControls';
import { useWorkspaceWorkbenches } from '../components/workbench/workbenchSelectors';
import {
  AgentPicker,
  BaseBranchField,
  ControlChip,
  CreateFromPopover,
  NEW_BRANCH,
  RepoPicker,
  RuntimeToggle,
  SourceChip,
  type NewWorkbenchSource,
} from '../components/workbench/new/NewWorkbenchControls';
import { RecentWorkbenches } from '../components/workbench/new/RecentWorkbenches';
import { useCreateWorkbench } from '../components/workbench/new/useCreateWorkbench';
import { useRepoPaths } from '../components/workbench/new/useRepoPaths';
import { defaultRepositoryId, writeLastRepository } from '../components/workbench/new/lastRepository';

const PLACEHOLDER = 'Describe a task. Enter creates the session and starts it. ⇧Enter for a new line.';
const AGENTS: WorkbenchAgent[] = ['claude', 'codex'];

/** A repository's local checkout, matched case-insensitively: a remote's case need not match GitHub's. */
export function localPathFor(paths: Record<string, string>, repoFullName: string | undefined): string | null {
  if (!repoFullName) return null;
  if (paths[repoFullName]) return paths[repoFullName];
  const want = repoFullName.toLowerCase();
  const key = Object.keys(paths).find((k) => k.toLowerCase() === want);
  return key ? paths[key] : null;
}

/**
 * Home, once the workspace has repositories: one composer. Enter creates a
 * workbench on the chosen repository, sends the text as its first message,
 * and opens it — the provisioning progress shows there.
 */
export function NewWorkbenchPage() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const prRows = usePullRequestStore((s) => s.rows);
  const request = useWorkbenchStore((s) => s.newWorkbench);
  const workbenches = useWorkspaceWorkbenches();
  const readiness = useReadiness(workspaceId);
  const repoPaths = useRepoPaths();
  const { create, busy, error: createError, clearError } = useCreateWorkbench();

  const [prompt, setPrompt] = useState('');
  const [repositoryId, setRepositoryId] = useState(() => defaultRepositoryId(workspaceId, repositories));
  const [baseBranch, setBaseBranch] = useState('');
  const [source, setSource] = useState<NewWorkbenchSource>(NEW_BRANCH);
  const [fromOpen, setFromOpen] = useState(false);
  // Read once: a change in Settings applies to the next new session, not to this draft.
  const [defaults] = useState(readSessionDefaults);
  const [runtime, setRuntime] = useState<WorkbenchRuntime>(defaults.runtime);
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [agent, setAgent] = useState<WorkbenchAgent>(defaults.agent);
  const [model, setModel] = useState<string>(() => defaultFleetModelForAgent(defaults.agent));
  const [effort, setEffort] = useState<WorkbenchEffort | null>(defaults.effort);
  const [planMode, setPlanMode] = useState(defaults.planMode);
  const [pathError, setPathError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const repo = repositories.find((r) => r.id === repositoryId) ?? null;
  const defaultBranch = workspace?.repos.find((r) => r.name.toLowerCase() === repo?.fullName.toLowerCase())?.defaultBranch ?? '';
  const repoPath = localPathFor(repoPaths.paths, repo?.fullName);
  const repoPrs = useMemo(
    () =>
      prRows
        .filter((r) => r.state === 'open' && r.repositoryId === repositoryId)
        .sort((a, b) => Number(b.authored) - Number(a.authored) || b.number - a.number),
    [prRows, repositoryId]
  );
  const branchSuggestions = useMemo(
    () => [...new Set([defaultBranch, ...repoPrs.map((r) => r.summary.baseBranch)].filter(Boolean))],
    [defaultBranch, repoPrs]
  );

  const runtimes = useMemo(
    () => runtimeChoice({ sandbox: readiness.sandbox, local: readiness.local }),
    [readiness.sandbox, readiness.local]
  );
  const choiceFor = useCallback(
    (a: WorkbenchAgent) => agentChoice({ sandbox: readiness.sandbox, local: readiness.local }, runtime, a),
    [readiness.sandbox, readiness.local, runtime]
  );
  const agentOk = choiceFor(agent);
  const readinessKnown = !readiness.loading && (readiness.sandbox !== null || !workspaceId);

  // A repository that stops being watched (or a workspace switch) falls back to the default.
  useEffect(() => {
    if (!repositories.some((r) => r.id === repositoryId)) setRepositoryId(defaultRepositoryId(workspaceId, repositories));
  }, [repositories, repositoryId, workspaceId]);

  // The default runtime comes from Settings; when readiness refuses it and the other works, move there until the person chooses.
  useEffect(() => {
    if (!readinessKnown || runtimeTouched || runtimes[runtime].available) return;
    const other: WorkbenchRuntime = runtime === 'sandbox' ? 'local' : 'sandbox';
    if (runtimes[other].available) setRuntime(other);
  }, [readinessKnown, runtimeTouched, runtime, runtimes]);

  // Keep the agent usable for the runtime, and the model the agent's.
  useEffect(() => {
    if (agentOk.available) return;
    const usable = AGENTS.find((a) => choiceFor(a).available);
    if (usable && usable !== agent) setAgent(usable);
  }, [agentOk.available, choiceFor, agent]);
  useEffect(() => {
    setModel(storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent));
  }, [agent, workspace?.settings]);

  const focus = () => textareaRef.current?.focus();

  const applyPrefill = useCallback(
    (prefill: NewWorkbenchPrefill) => {
      if (prefill.repositoryId) setRepositoryId(prefill.repositoryId);
      setBaseBranch(prefill.baseBranch ?? '');
      if (prefill.runtime) {
        setRuntime(prefill.runtime);
        setRuntimeTouched(true);
      }
      if (prefill.fromPullRequestId) {
        const row = usePullRequestStore.getState().rows.find((r) => r.id === prefill.fromPullRequestId);
        setSource({
          kind: 'pr',
          pullRequestId: prefill.fromPullRequestId,
          number: row?.number ?? 0,
          title: row?.summary.title ?? prefill.branch ?? 'Pull request',
          headBranch: row?.summary.headBranch ?? prefill.branch ?? '',
          baseBranch: row?.summary.baseBranch ?? prefill.baseBranch ?? '',
        });
      } else if (prefill.branch) {
        setSource({ kind: 'branch', branch: prefill.branch });
      } else {
        setSource(NEW_BRANCH);
      }
    },
    []
  );

  // Each "New workbench" request: apply its prefill once, then forget it so a later visit starts clean.
  useEffect(() => {
    const { prefill } = useWorkbenchStore.getState().newWorkbench;
    if (prefill) {
      applyPrefill(prefill);
      useWorkbenchStore.getState().clearNewWorkbenchPrefill();
    }
    focus();
  }, [request.seq, applyPrefill]);

  useEffect(() => {
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
  }, []);

  // ⌘I opens "Create from…" from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setFromOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [prompt]);

  const blockedReason = !repo
    ? 'Choose a repository.'
    : !runtimes[runtime].available
      ? runtimes[runtime].reason
      : !agentOk.available
        ? agentOk.reason
        : runtime === 'local' && !repoPath
          ? `Choose the folder of your ${repo.fullName} checkout.`
          : null;
  const canCreate = Boolean(workspaceId && repo) && !blockedReason && !busy;

  const submit = async (text: string) => {
    if (!canCreate || !workspaceId || !repo) return;
    setPathError(null);
    const wb = await create({
      workspaceId,
      repositoryId: repo.id,
      repoFullName: repo.fullName,
      runtime,
      agent,
      model,
      effort,
      planMode,
      prompt: text,
      baseBranch: baseBranch.trim() || (source.kind === 'pr' ? source.baseBranch : undefined),
      branch: source.kind === 'branch' ? source.branch : source.kind === 'pr' ? source.headBranch || undefined : undefined,
      fromPullRequestId: source.kind === 'pr' ? source.pullRequestId : undefined,
      repoPath,
    });
    if (wb) {
      writeLastRepository(workspaceId, repo.id);
      setPrompt('');
      setSource(NEW_BRANCH);
    }
  };

  const chooseFolder = async () => {
    if (!repo) return;
    setPathError(null);
    const picked = await repoPaths.pickFolder(repo.fullName).catch((err: unknown) => {
      setPathError(err instanceof Error ? err.message : 'Could not read that folder.');
      return null;
    });
    if (picked?.repoFullName && picked.repoFullName.toLowerCase() !== repo.fullName.toLowerCase()) {
      setPathError(`That folder is a checkout of ${picked.repoFullName}, not ${repo.fullName}.`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setPlanMode((v) => !v);
      return;
    }
    if (e.key === 'Escape' && (source.kind !== 'new' || baseBranch)) {
      e.preventDefault();
      setSource(NEW_BRANCH);
      setBaseBranch('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (prompt.trim()) void submit(prompt);
    }
  };

  const error = createError ?? pathError;
  const unavailable = readinessKnown
    ? (['sandbox', 'local'] as const).filter((r) => !runtimes[r].available)
    : [];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full overflow-y-auto" data-attr="home-new-workbench">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-6 pb-16 pt-[14vh]">
          <h1 className="text-center font-display text-2xl font-semibold tracking-tight">What do you want to build?</h1>

          <div className="space-y-2">
            <div
              className={cn(
                'rounded-xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60',
                busy && 'opacity-80'
              )}
            >
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (createError) clearError();
                }}
                onKeyDown={onKeyDown}
                placeholder={PLACEHOLDER}
                aria-label="Task"
                rows={3}
                disabled={busy}
                className="block min-h-[96px] w-full resize-none border-0 bg-transparent px-4 pb-2 pt-4 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
              />
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                <RepoPicker
                  repositories={repositories}
                  value={repositoryId}
                  onChange={(id) => {
                    setRepositoryId(id);
                    setSource(NEW_BRANCH);
                    setBaseBranch('');
                    setPathError(null);
                  }}
                />
                <BaseBranchField
                  value={baseBranch}
                  onChange={setBaseBranch}
                  placeholder={(source.kind === 'pr' && source.baseBranch) || defaultBranch || 'main'}
                  suggestions={branchSuggestions}
                />
                <SourceChip source={source} onClear={() => setSource(NEW_BRANCH)} />
                <CreateFromPopover
                  key={`${repositoryId}:${source.kind}`}
                  open={fromOpen}
                  onOpenChange={setFromOpen}
                  source={source}
                  onChange={(next) => {
                    setSource(next);
                    if (next.kind === 'pr' && !baseBranch) setBaseBranch(next.baseBranch);
                    focus();
                  }}
                  pullRequests={repoPrs}
                />
                <div className="ml-auto flex items-center gap-2">
                  <PlanToggle on={planMode} onToggle={() => setPlanMode((v) => !v)} />
                  <button
                    type="button"
                    onClick={() => void submit(prompt)}
                    disabled={!canCreate || !prompt.trim()}
                    aria-label="Create and start"
                    title={blockedReason ?? `Create and start (${formatKeys('enter')})`}
                    data-attr="new-workbench-send"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 px-1">
              <RuntimeToggle
                value={runtime}
                onChange={(r) => {
                  setRuntime(r);
                  setRuntimeTouched(true);
                }}
                choices={runtimes}
              />
              {runtime === 'local' && repo && runtimes.local.available && (
                <ControlChip
                  onClick={() => void chooseFolder()}
                  title={repoPath ?? 'Choose the folder of your local checkout'}
                  data-attr="new-workbench-folder"
                  className={cn(!repoPath && 'text-warning hover:text-warning')}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono">{repoPath ? shortPath(repoPath) : 'Choose folder…'}</span>
                </ControlChip>
              )}
              <AgentPicker value={agent} onChange={setAgent} choiceFor={choiceFor} />
              <ModelPicker agent={agent} value={model} onChange={setModel} />
              <EffortPicker value={effort} onChange={setEffort} />
            </div>

            {(error || unavailable.length > 0 || agentOk.warning) && (
              <div className="space-y-0.5 px-2 text-xs" aria-live="polite">
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
                {unavailable.map((r) => (
                  <p key={r} className="text-muted-foreground" data-attr={`new-workbench-${r}-reason`}>
                    <span className="font-medium">{r === 'sandbox' ? 'Sandbox' : 'Local'} unavailable:</span>{' '}
                    {runtimes[r].reason}
                    {r === 'sandbox' && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:text-foreground"
                          onClick={() => openSettings('agents')}
                        >
                          Agents
                        </button>
                      </>
                    )}
                  </p>
                ))}
                {agentOk.available && agentOk.warning && <p className="text-muted-foreground">{agentOk.warning}</p>}
              </div>
            )}

          </div>

          <RecentWorkbenches workbenches={workbenches} />
        </div>
      </div>
    </TooltipProvider>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}
