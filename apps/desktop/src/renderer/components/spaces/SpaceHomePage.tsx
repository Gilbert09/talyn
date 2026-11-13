import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Globe2, Loader2 } from 'lucide-react';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type SpaceSessionRow,
  type SpaceTaskRow,
  type WorkbenchAgent,
  type WorkbenchEffort,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { readSessionDefaults } from '../../lib/sessionDefaults';
import { FOCUS_COMPOSER_EVENT, formatKeys } from '../../lib/shortcuts';
import { agentChoice, runtimeChoice, useReadiness } from '../../lib/readiness';
import { groupSpaceSessions, openSpaceSession, viewersOf } from '../../lib/spaces';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { fuzzyMatchPaths } from '../../lib/workbenchFormat';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkspaceStore, type WatchedRepo } from '../../stores/workspace';
import { emptySpaceList, loadSpaceSessions, useSpacesStore, type SpaceRef } from '../../stores/spaces';
import { useNavigationStore } from '../../stores/navigation';
import { workbenchPlaceLabel } from '../../lib/threads';
import { spaceSessionState } from '../../lib/sessionState';
import { useSpaceSidebarModel } from '../layout/spaceSidebarModel';
import { SessionStateIcon } from '../workbench/WorkbenchBadges';
import { TooltipProvider } from '../ui/tooltip';
import { EffortPicker, ModelPicker, PlanToggle } from '../workbench/ComposerControls';
import { ComposerPopover, applyTrigger, findTrigger, type ComposerTrigger } from '../workbench/ComposerPopover';
import { ImageAttachButton, ImageAttachmentChips, ImageDropOverlay, useComposerImages, useImageDropZone } from '../workbench/useComposerImages';
import {
  ANY_REPOSITORY,
  AgentPicker,
  BaseBranchField,
  ConnectAgentNotice,
  ControlChip,
  CreateFromPopover,
  NEW_BRANCH,
  RepoPicker,
  SourceChip,
  unconnectedAgents,
  type NewWorkbenchSource,
} from '../workbench/new/NewWorkbenchControls';
import { useCreateWorkbench } from '../workbench/new/useCreateWorkbench';
import { timeAgo } from '../workbench/new/RecentWorkbenches';
import { MemberAvatar, PresenceAvatars, SpaceDot } from './SpaceAvatars';

const AGENTS: WorkbenchAgent[] = ['claude', 'codex'];
const LAST_REPO_KEY = 'talyn-space-last-repo';

function readLastRepo(spaceId: string): string | null {
  try {
    return localStorage.getItem(`${LAST_REPO_KEY}:${spaceId}`);
  } catch {
    return null;
  }
}

function writeLastRepo(spaceId: string, repo: string): void {
  try {
    localStorage.setItem(`${LAST_REPO_KEY}:${spaceId}`, repo);
  } catch {
    // Keep the selection in memory if storage is unavailable.
  }
}

/** A space's home: a composer that starts a session or a thread in the space, then every member's sessions and the tasks. */
export function SpaceHomePage({ active }: { active: SpaceRef }) {
  const { space, team } = active;
  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full overflow-y-auto" data-attr="space-home">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-6 pb-16 pt-[10vh]">
          <div className="flex items-center justify-center gap-2" data-attr="space-header">
            <SpaceDot color={space.color} image={space.image} className="h-3 w-3" />
            <h1 className="font-display text-2xl font-semibold tracking-tight">{space.name}</h1>
            <span className="text-sm text-muted-foreground">{team.name}</span>
          </div>
          <SpaceComposer key={space.id} active={active} />
          <SpaceFeed spaceId={space.id} />
        </div>
      </div>
    </TooltipProvider>
  );
}

function SpaceComposer({ active }: { active: SpaceRef }) {
  const { space, team } = active;
  const repos = useSpacesStore((s) => s.repositories[space.id]);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const homeWorkspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === team.homeWorkspaceId) ?? null);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaceRepositories = useWorkspaceStore((s) => s.repositories);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const prRows = usePullRequestStore((s) => s.rows);
  const readiness = useReadiness(team.homeWorkspaceId);
  const threadRoute = useNavigationStore((s) => s.route.view === 'home' && s.route.mode === 'thread');
  const route = useNavigationStore((s) => s.route);
  const { create, busy, error, clearError } = useCreateWorkbench();
  // Read once: a change in Settings applies to the next new session, not to this draft.
  const [defaults] = useState(readSessionDefaults);
  const [agent, setAgent] = useState<WorkbenchAgent>(defaults.agent);
  const [model, setModel] = useState<string>(() => defaultFleetModelForAgent(defaults.agent));
  const [effort, setEffort] = useState<WorkbenchEffort>(defaults.effort);
  const [planMode, setPlanMode] = useState(defaults.planMode);
  const [internetAccess, setInternetAccess] = useState(defaults.internetAccess);
  const autoCreatePr = defaults.autoCreatePr;
  const [prompt, setPrompt] = useState('');
  const [repoFullName, setRepoFullName] = useState<string>(() => (threadRoute ? ANY_REPOSITORY : readLastRepo(space.id) ?? ''));
  // "Any repository" starts a thread; a repository starts a session.
  const mode = repoFullName === ANY_REPOSITORY ? 'thread' : 'session';
  const [baseBranch, setBaseBranch] = useState('');
  const [source, setSource] = useState<NewWorkbenchSource>(NEW_BRANCH);
  const [fromOpen, setFromOpen] = useState(false);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const [filePaths, setFilePaths] = useState<Record<string, string[]>>({});
  const [loadingRepositoryId, setLoadingRepositoryId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const images = useComposerImages('sandbox');
  const { dragging, dropProps } = useImageDropZone((files) => void images.attachFiles(files));

  const pickerRepos = useMemo<WatchedRepo[]>(
    () =>
      (repos ?? []).map((r) => {
        const [owner, name] = r.repoFullName.split('/');
        return { id: r.repoFullName, workspaceId: space.id, owner: owner ?? '', repo: name ?? '', fullName: r.repoFullName };
      }),
    [repos, space.id],
  );

  // The home workspace's own copy of the repository, when it is the workspace shown:
  // its files feed @ mentions and its open pull requests feed "Create from".
  const homeRepo = useMemo(() => {
    if (mode !== 'session' || !team.homeWorkspaceId || team.homeWorkspaceId !== currentWorkspaceId) return null;
    const wanted = repoFullName.toLowerCase();
    return workspaceRepositories.find((r) => r.fullName.toLowerCase() === wanted) ?? null;
  }, [mode, team.homeWorkspaceId, currentWorkspaceId, workspaceRepositories, repoFullName]);
  const defaultBranch =
    homeWorkspace?.repos.find((r) => r.name.toLowerCase() === repoFullName.toLowerCase())?.defaultBranch ?? '';
  const repoPrs = useMemo(
    () =>
      homeRepo
        ? prRows
            .filter((r) => r.state === 'open' && r.repositoryId === homeRepo.id)
            .sort((a, b) => Number(b.authored) - Number(a.authored) || b.number - a.number)
        : [],
    [prRows, homeRepo],
  );
  const branchSuggestions = useMemo(
    () => [...new Set([defaultBranch, ...repoPrs.map((r) => r.summary.baseBranch)].filter(Boolean))],
    [defaultBranch, repoPrs],
  );

  const chooseRepo = (next: string) => {
    setRepoFullName(next);
    setSource(NEW_BRANCH);
    setBaseBranch('');
  };

  // "New thread" opens this page with "Any repository" chosen. Only a new navigation moves the choice.
  useEffect(() => {
    if (threadRoute) setRepoFullName(ANY_REPOSITORY);
    else setRepoFullName((cur) => (cur === ANY_REPOSITORY ? readLastRepo(space.id) ?? '' : cur));
  }, [route]);

  // Keep the choice on a repository the space still has.
  useEffect(() => {
    if (!repos || repoFullName === ANY_REPOSITORY) return;
    if (!repos.some((r) => r.repoFullName === repoFullName)) setRepoFullName(repos[0]?.repoFullName ?? '');
  }, [repos, repoFullName]);

  useEffect(() => setTrigger(null), [repoFullName]);

  // The home workspace runs the session, so its model setting applies.
  const storedModel = storedFleetModelForAgent(homeWorkspace?.settings, agent);
  useEffect(() => {
    setModel(storedModel ?? defaultFleetModelForAgent(agent));
  }, [agent, storedModel]);

  const choiceFor = useCallback((a: WorkbenchAgent) => agentChoice({ sandbox: readiness.sandbox, local: null }, 'sandbox', a), [readiness.sandbox]);
  const agentOk = choiceFor(agent);
  const sandbox = runtimeChoice(readiness).sandbox;
  useEffect(() => {
    if (agentOk.available) return;
    const usable = AGENTS.find((a) => choiceFor(a).available);
    if (usable && usable !== agent) setAgent(usable);
  }, [agentOk.available, choiceFor, agent]);

  const focus = () => textareaRef.current?.focus();
  useEffect(() => {
    focus();
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
  }, []);

  // ⌘I opens "Create from…" from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'session' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setFromOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [prompt]);

  const loadPaths = () => {
    if (!homeRepo || filePaths[homeRepo.id] || loadingRepositoryId === homeRepo.id) return;
    const requestedRepositoryId = homeRepo.id;
    setLoadingRepositoryId(requestedRepositoryId);
    api.repositories
      .files(requestedRepositoryId)
      .then(({ paths }) => setFilePaths((current) => ({ ...current, [requestedRepositoryId]: paths })))
      .catch(() => setFilePaths((current) => ({ ...current, [requestedRepositoryId]: [] })))
      .finally(() => setLoadingRepositoryId((current) => (current === requestedRepositoryId ? null : current)));
  };

  const mentionItems = useMemo(
    () => (trigger?.kind === 'mention' && homeRepo ? fuzzyMatchPaths(trigger.query, filePaths[homeRepo.id] ?? []) : []),
    [trigger, homeRepo, filePaths],
  );

  const updateTrigger = (text: string, caret: number) => {
    const next = homeRepo ? findTrigger(text, caret) : null;
    setTrigger(next?.kind === 'mention' ? next : null);
    setActiveMention(0);
    if (next?.kind === 'mention') loadPaths();
  };

  const pickMention = (path: string) => {
    if (!trigger) return;
    const next = applyTrigger(prompt, trigger, path);
    setPrompt(next.text);
    setTrigger(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const repoInHome = homeWorkspace?.repos.some((r) => r.name.toLowerCase() === repoFullName.toLowerCase()) ?? false;
  const blockedReason = !team.homeWorkspaceId
    ? `You need a workspace of your own to start a ${mode} in a space.`
    : mode === 'session' && !repoFullName
      ? 'Choose a repository.'
      : readiness.sandbox !== null && !sandbox.available
        ? sandbox.reason
        : readiness.sandbox !== null && !agentOk.available
          ? agentOk.reason
          : null;
  const canCreate = !blockedReason && !busy && images.pendingUploads === 0;
  const missingAgents = readiness.sandbox !== null && sandbox.available ? unconnectedAgents(agent, choiceFor) : [];
  // Settings shows the current workspace, so it can only fix the home workspace's agents when they are the same one.
  const connectAgent =
    team.homeWorkspaceId && team.homeWorkspaceId === currentWorkspaceId ? () => openSettings('agents') : undefined;

  const submit = async () => {
    const text = prompt.trim();
    if (!canCreate || !text || !team.homeWorkspaceId) return;
    const session = mode === 'session';
    const wb = await create({
      workspaceId: team.homeWorkspaceId,
      spaceId: space.id,
      kind: session ? 'session' : 'thread',
      runtime: 'sandbox',
      repoFullName: session ? repoFullName : undefined,
      agent,
      model,
      effort,
      planMode,
      internetAccess,
      autoCreatePr: session ? autoCreatePr : undefined,
      prompt: text,
      attachments: images.attachments.length ? images.attachments : undefined,
      baseBranch: session ? baseBranch.trim() || (source.kind === 'pr' ? source.baseBranch : undefined) : undefined,
      branch: session ? (source.kind === 'branch' ? source.branch : source.kind === 'pr' ? source.headBranch || undefined : undefined) : undefined,
      fromPullRequestId: session && source.kind === 'pr' ? source.pullRequestId : undefined,
    });
    if (!wb) return;
    if (session) writeLastRepo(space.id, repoFullName);
    setPrompt('');
    images.clear();
    setSource(NEW_BRANCH);
    void loadSpaceSessions(space.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && (mentionItems.length > 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMention((index) => (index + 1) % Math.max(1, mentionItems.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMention((index) => (index - 1 + mentionItems.length) % Math.max(1, mentionItems.length));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && mentionItems[activeMention]) {
        e.preventDefault();
        pickMention(mentionItems[activeMention]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setPlanMode((v) => !v);
      return;
    }
    if (mode === 'session' && e.key === 'Escape' && (source.kind !== 'new' || baseBranch)) {
      e.preventDefault();
      setSource(NEW_BRANCH);
      setBaseBranch('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const noRepositories = repos !== undefined && repos.length === 0;
  const addsRepository = mode === 'session' && repoFullName && homeWorkspace && !repoInHome;
  const blockedNote = blockedReason && blockedReason !== 'Choose a repository.' ? blockedReason : null;
  const agentWarning = agentOk.available ? agentOk.warning : undefined;
  const hasNotices =
    noRepositories || addsRepository || blockedNote || agentWarning || (connectAgent && missingAgents.length > 0) || error;

  return (
    <div className="space-y-2">
      <div
        {...dropProps}
        className={cn(
          'relative rounded-xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60',
          busy && 'opacity-80',
        )}
      >
        <ImageDropOverlay dragging={dragging} className="rounded-xl" />
        {trigger && (
          <ComposerPopover
            kind="mention"
            items={mentionItems}
            active={activeMention}
            loading={loadingRepositoryId === homeRepo?.id}
            onPick={pickMention}
            onHover={setActiveMention}
          />
        )}
        <textarea
          ref={textareaRef}
          data-new-workbench-composer
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (error) clearError();
            updateTrigger(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => updateTrigger(prompt, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={images.onPaste}
          onBlur={() => setTrigger(null)}
          placeholder={
            mode === 'thread'
              ? `Start a thread in ${space.name}. It can work across repositories. Only you can see it.`
              : `Start a session in ${space.name}. Your teammates can see it.`
          }
          aria-label="Task"
          rows={3}
          disabled={busy}
          className="block min-h-[96px] w-full resize-none border-0 bg-transparent px-4 pb-2 pt-4 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        />
        <ImageAttachmentChips
          attachments={images.attachments}
          pendingUploads={images.pendingUploads}
          imageNotReady={images.imageNotReady}
          onRemove={(index) => images.setAttachments((current) => current.filter((_, i) => i !== index))}
        />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <ImageAttachButton inputRef={images.fileInputRef} onFiles={(files) => void images.attachFiles(files)} />
          <RepoPicker
            repositories={pickerRepos}
            value={repoFullName}
            onChange={chooseRepo}
            allowAnyRepository
            emptyText="No repository in this space matches."
            extraAction={{ label: 'Add repository to space…', onSelect: () => openDialog({ kind: 'addRepository', spaceId: space.id }) }}
          />
          {mode === 'session' && (
            <>
              <BaseBranchField
                value={baseBranch}
                onChange={setBaseBranch}
                placeholder={(source.kind === 'pr' && source.baseBranch) || defaultBranch || 'main'}
                suggestions={branchSuggestions}
              />
              <SourceChip source={source} onClear={() => setSource(NEW_BRANCH)} />
              <CreateFromPopover
                key={`${repoFullName}:${source.kind}`}
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
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <PlanToggle on={planMode} onToggle={() => setPlanMode((v) => !v)} />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canCreate || !prompt.trim()}
              aria-label="Create and start"
              title={blockedReason ?? `Create and start (${formatKeys('enter')})`}
              data-attr="space-new-session-send"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-1">
        <ControlChip
          role="switch"
          aria-checked={internetAccess}
          aria-label="Internet access"
          title={internetAccess ? 'Internet access on' : 'Internet access off'}
          onClick={() => setInternetAccess((value) => !value)}
        >
          <Globe2 className="h-3.5 w-3.5" />
          <span>Internet {internetAccess ? 'on' : 'off'}</span>
        </ControlChip>
        <AgentPicker value={agent} onChange={setAgent} choiceFor={choiceFor} onConnect={connectAgent} />
        <ModelPicker agent={agent} value={model} onChange={setModel} unconnected={missingAgents.map((m) => m.agent)} />
        <EffortPicker value={effort} onChange={setEffort} />
      </div>

      {hasNotices && (
        <div className="space-y-0.5 px-2 text-xs" aria-live="polite">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {noRepositories && (
            <p className="text-muted-foreground">
              This space has no repositories yet.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => openDialog({ kind: 'addRepository', spaceId: space.id })}
              >
                Add one
              </button>
            </p>
          )}
          {addsRepository && (
            <p className="text-muted-foreground" data-attr="space-adds-repository">
              Adds {repoFullName} to {homeWorkspace.name}
            </p>
          )}
          {blockedNote && <p className="text-muted-foreground">{blockedNote}</p>}
          {agentWarning && <p className="text-muted-foreground">{agentWarning}</p>}
          {connectAgent && <ConnectAgentNotice agents={missingAgents} onConnect={connectAgent} />}
        </div>
      )}
    </div>
  );
}

function SpaceFeed({ spaceId }: { spaceId: string }) {
  const sessions = useSpacesStore((s) => s.sessions[spaceId]) ?? emptySpaceList<SpaceSessionRow>();
  const tasks = useSpacesStore((s) => s.tasks[spaceId]) ?? emptySpaceList<SpaceTaskRow>();
  const presence = useSpacesStore((s) => s.presence[spaceId]);
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  const groups = useMemo(() => groupSpaceSessions(sessions.items, presence, selfUserId), [sessions.items, presence, selfUserId]);
  // The sidebar's states: live for my own loaded sessions, from the space row for the rest.
  const { states } = useSpaceSidebarModel(spaceId);
  const rows = [...groups.active, ...groups.recent];
  const hidden = sessions.hiddenCount + tasks.hiddenCount;

  if (!sessions.loaded) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the space…
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <section className="space-y-1" aria-label="Sessions">
        <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sessions</h2>
        {rows.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground" data-attr="space-feed-empty">
            No sessions in this space yet. Start one above.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card">
            {rows.map((row) => {
              const viewers = viewersOf(presence, row.id, selfUserId);
              const state = states.get(row.id) ?? spaceSessionState(row);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => void openSpaceSession(row.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/60"
                    data-attr="space-feed-session"
                  >
                    <MemberAvatar member={row.creator} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{row.title || row.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.creator.githubLogin ?? 'A teammate'} · {workbenchPlaceLabel(row)}
                      </span>
                    </span>
                    <PresenceAvatars members={viewers} size={18} />
                    <span
                      className="flex min-w-0 max-w-[40%] shrink items-center gap-1.5 text-xs text-muted-foreground"
                      data-attr="space-feed-session-state"
                    >
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        <SessionStateIcon state={state} />
                      </span>
                      <span className="truncate">{state.label}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(row.lastActivityAt ?? row.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {tasks.items.length > 0 && (
        <section className="space-y-1" aria-label="Tasks">
          <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Tasks</h2>
          <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card">
            {tasks.items.map((task) => (
              <li key={task.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <MemberAvatar member={task.creator} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{task.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {task.creator.githubLogin ?? 'A teammate'} · {task.status.replace('_', ' ')}
                    {task.repoFullName ? ` · ${task.repoFullName}` : ''}
                  </span>
                </span>
                {task.pullRequest && (
                  <button
                    type="button"
                    onClick={() => void openExternal(task.pullRequest!.url)}
                    className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    #{task.pullRequest.number}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {hidden > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {hidden === 1 ? '1 item you can\'t see' : `${hidden} items you can't see`}
        </p>
      )}
    </div>
  );
}
