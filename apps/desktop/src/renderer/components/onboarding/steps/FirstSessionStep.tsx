import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { defaultFleetModelForAgent, PLAN_LIMITS, storedFleetModelForAgent, type WorkbenchAgent } from '@talyn/shared';
import { readSessionDefaults } from '../../../lib/sessionDefaults';
import { useWorkspaceStore } from '../../../stores/workspace';
import { localPathFor } from '../../../pages/NewWorkbenchPage';
import { Button } from '../../ui/button';
import { RepoPicker } from '../../workbench/new/NewWorkbenchControls';
import { useCreateWorkbench } from '../../workbench/new/useCreateWorkbench';
import { useRepoPaths } from '../../workbench/new/useRepoPaths';
import { defaultRepositoryId, writeLastRepository } from '../../workbench/new/lastRepository';

export interface FirstSessionCreated {
  runtime: 'sandbox' | 'local';
  agent: WorkbenchAgent;
}

interface FirstSessionStepProps {
  /** Run on this computer with this installed CLI. Null runs in a sandbox. */
  local?: { agent: WorkbenchAgent } | null;
  onCreated: (created: FirstSessionCreated) => void;
  onSkip: () => void;
  onBusyChange: (busy: boolean) => void;
}

export function FirstSessionStep({ local = null, onCreated, onSkip, onBusyChange }: FirstSessionStepProps) {
  const { currentWorkspaceId, repositories, cloudProviders, workspaces } = useWorkspaceStore();
  const [repositoryId, setRepositoryId] = useState(() => defaultRepositoryId(currentWorkspaceId, repositories));
  const [prompt, setPrompt] = useState('');
  const [defaults] = useState(readSessionDefaults);
  const [pathError, setPathError] = useState<string | null>(null);
  const submitting = useRef(false);
  const { create, busy, error } = useCreateWorkbench();
  const repoPaths = useRepoPaths();
  const repo = repositories.find((r) => r.id === repositoryId);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const connectedAgents = cloudProviders?.find((provider) => provider.type === 'selfhosted')?.connectedAgents ?? [];
  const runtime = local ? 'local' : 'sandbox';
  const agent: WorkbenchAgent = local
    ? local.agent
    : connectedAgents.includes(defaults.agent)
      ? defaults.agent
      : connectedAgents.includes('codex') ? 'codex' : 'claude';
  const model = storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent);
  const repoPath = local ? localPathFor(repoPaths.paths, repo?.fullName) : null;
  const freeHours = PLAN_LIMITS.free?.includedBoxHours;
  const needsFolder = Boolean(local && repo && !repoPath);

  async function startSession() {
    if (!currentWorkspaceId || !repo || !prompt.trim() || needsFolder || submitting.current) return;
    submitting.current = true;
    onBusyChange(true);
    try {
      const session = await create({
        workspaceId: currentWorkspaceId,
        repositoryId: repo.id,
        repoFullName: repo.fullName,
        runtime,
        agent,
        model,
        effort: defaults.effort,
        planMode: defaults.planMode,
        internetAccess: defaults.internetAccess,
        autoCreatePr: defaults.autoCreatePr,
        prompt,
        ...(local ? { repoPath } : {}),
      });
      if (session) {
        writeLastRepository(currentWorkspaceId, repo.id);
        onCreated({ runtime, agent });
      }
    } finally {
      submitting.current = false;
      onBusyChange(false);
    }
  }

  async function chooseFolder() {
    if (!repo) return;
    setPathError(null);
    const picked = await repoPaths.pickFolder(repo.fullName).catch((err: unknown) => {
      setPathError(err instanceof Error ? err.message : 'Could not read that folder.');
      return null;
    });
    if (picked?.repoFullName && picked.repoFullName.toLowerCase() !== repo.fullName.toLowerCase()) {
      setPathError(`That folder is a checkout of ${picked.repoFullName}, not ${repo.fullName}.`);
    }
  }

  const shownError = error ?? pathError;

  return (
    <div className="space-y-3">
      <RepoPicker repositories={repositories} value={repositoryId} onChange={setRepositoryId} disabled={busy} />
      {local && repo && (
        <div className="flex items-center gap-2 text-[13px]">
          <Button variant="outline" size="sm" onClick={() => void chooseFolder()} disabled={busy}>
            <FolderOpen className="h-3.5 w-3.5" />
            {repoPath ? 'Change folder…' : 'Choose folder…'}
          </Button>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={repoPath ?? undefined}>
            {repoPath ?? `Choose the folder of your ${repo.fullName} checkout.`}
          </span>
        </div>
      )}
      <label className="block space-y-2 text-[13px]">
        <span>What do you want your agent to do?</span>
        <textarea
          aria-label="Session prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={busy}
          rows={4}
          className="ph-no-capture ph-mask w-full resize-y rounded-md border bg-background p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      {shownError && <p role="alert" className="text-[13px] text-destructive">{shownError}</p>}
      <Button
        onClick={() => void startSession()}
        disabled={busy || !currentWorkspaceId || !repo || !prompt.trim() || needsFolder}
      >
        {busy ? 'Starting session…' : 'Start session'}
      </Button>
      {local ? (
        <p className="text-xs text-muted-foreground">
          The session runs on this computer, in a new git worktree of your checkout.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            The first start can take a little longer while your sandbox image is prepared.
          </p>
          {typeof freeHours === 'number' && Number.isFinite(freeHours) && (
            <p className="text-xs text-muted-foreground">Free includes {freeHours} box-hours a month.</p>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onSkip}
        disabled={busy}
        className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
      >
        Skip for now
      </button>
    </div>
  );
}
