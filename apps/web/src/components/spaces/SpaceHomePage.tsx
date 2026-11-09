import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Globe2, Loader2 } from 'lucide-react';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type CreateSpaceSessionRequest,
  type SpaceSessionRow,
  type SpaceTaskRow,
  type WorkbenchAgent,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { readSessionDefaults } from '../../lib/sessionDefaults';
import { FOCUS_COMPOSER_EVENT, formatKeys } from '../../lib/shortcuts';
import { agentChoice, sandboxChoice, useReadiness } from '../../lib/readiness';
import { groupSpaceSessions, openCreatedSession, openSpaceSession, viewersOf } from '../../lib/spaces';
import { api } from '../../lib/api';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { useWorkspaceStore, type WatchedRepo } from '../../stores/workspace';
import { emptySpaceList, loadSpaceSessions, useSpacesStore, type SpaceRef } from '../../stores/spaces';
import { useNavigationStore } from '../../stores/navigation';
import { workbenchPlaceLabel } from '../../lib/threads';
import { TooltipProvider } from '../ui/tooltip';
import { ModelPicker } from '../workbench/ComposerControls';
import {
  ANY_REPOSITORY,
  AgentPicker,
  ConnectAgentNotice,
  ControlChip,
  RepoPicker,
  unconnectedAgents,
} from '../workbench/new/NewWorkbenchControls';
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
    // ignore quota / privacy-mode issues
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
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const readiness = useReadiness(team.homeWorkspaceId);
  const threadRoute = useNavigationStore((s) => s.route.view === 'home' && s.route.mode === 'thread');
  const route = useNavigationStore((s) => s.route);
  const [defaults] = useState(readSessionDefaults);
  const [agent, setAgent] = useState<WorkbenchAgent>(defaults.agent);
  const [model, setModel] = useState<string>(() => defaultFleetModelForAgent(defaults.agent));
  const [internetAccess, setInternetAccess] = useState(defaults.internetAccess);
  const [prompt, setPrompt] = useState('');
  const [repoFullName, setRepoFullName] = useState<string>(() => (threadRoute ? ANY_REPOSITORY : readLastRepo(space.id) ?? ''));
  // "Any repository" starts a thread; a repository starts a session.
  const mode = repoFullName === ANY_REPOSITORY ? 'thread' : 'session';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pickerRepos = useMemo<WatchedRepo[]>(
    () =>
      (repos ?? []).map((r) => {
        const [owner, name] = r.repoFullName.split('/');
        return { id: r.repoFullName, workspaceId: space.id, owner: owner ?? '', repo: name ?? '', fullName: r.repoFullName };
      }),
    [repos, space.id],
  );

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

  // The home workspace runs the session, so its model setting applies.
  const storedModel = storedFleetModelForAgent(homeWorkspace?.settings, agent);
  useEffect(() => {
    setModel(storedModel ?? defaultFleetModelForAgent(agent));
  }, [agent, storedModel]);

  const choiceFor = useCallback((a: WorkbenchAgent) => agentChoice({ sandbox: readiness.sandbox }, a), [readiness.sandbox]);
  const agentOk = choiceFor(agent);
  const sandbox = sandboxChoice(readiness);
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

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [prompt]);

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
  const canCreate = !blockedReason && !busy;
  const missingAgents = readiness.sandbox !== null && sandbox.available ? unconnectedAgents(agent, choiceFor) : [];
  // Settings shows the current workspace, so it can only fix the home workspace's agents when they are the same one.
  const connectAgent =
    team.homeWorkspaceId && team.homeWorkspaceId === currentWorkspaceId ? () => openSettings('integrations') : undefined;

  const submit = async () => {
    const text = prompt.trim();
    if (!canCreate || !text) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateSpaceSessionRequest =
        mode === 'thread'
          ? { kind: 'thread', agent, model, prompt: text, internetAccess }
          : { repoFullName, agent, model, prompt: text, internetAccess };
      const res = await api.spaces.createSession(space.id, body);
      if (mode === 'session') writeLastRepo(space.id, repoFullName);
      setPrompt('');
      void loadSpaceSessions(space.id);
      openCreatedSession(res.workbench);
    } catch (err) {
      if (maybeHandleBillingLimit(err, 'session_create')) return;
      setError(err instanceof Error && err.message ? err.message : `Could not start the ${mode}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className={cn('rounded-xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60', busy && 'opacity-80')}>
        <textarea
          ref={textareaRef}
          data-new-workbench-composer
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
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
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <RepoPicker
            repositories={pickerRepos}
            value={repoFullName}
            onChange={setRepoFullName}
            allowAnyRepository
            emptyText="No repository in this space matches."
            extraAction={{ label: 'Add repository to space…', onSelect: () => openDialog({ kind: 'addRepository', spaceId: space.id }) }}
          />
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
          <div className="ml-auto">
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
      <div className="space-y-0.5 px-2 text-xs" aria-live="polite">
        {repos && repos.length === 0 && (
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
        {mode === 'session' && repoFullName && homeWorkspace && !repoInHome && (
          <p className="text-muted-foreground" data-attr="space-adds-repository">
            Adds {repoFullName} to {homeWorkspace.name}
          </p>
        )}
        {blockedReason && blockedReason !== 'Choose a repository.' && <p className="text-muted-foreground">{blockedReason}</p>}
        {connectAgent && <ConnectAgentNotice agents={missingAgents} onConnect={connectAgent} />}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function SpaceFeed({ spaceId }: { spaceId: string }) {
  const sessions = useSpacesStore((s) => s.sessions[spaceId]) ?? emptySpaceList<SpaceSessionRow>();
  const tasks = useSpacesStore((s) => s.tasks[spaceId]) ?? emptySpaceList<SpaceTaskRow>();
  const presence = useSpacesStore((s) => s.presence[spaceId]);
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  const groups = useMemo(() => groupSpaceSessions(sessions.items, presence, selfUserId), [sessions.items, presence, selfUserId]);
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
                        {row.running ? ' · working' : ''}
                      </span>
                    </span>
                    <PresenceAvatars members={viewers} size={18} />
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
                  <a
                    href={task.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    #{task.pullRequest.number}
                  </a>
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
