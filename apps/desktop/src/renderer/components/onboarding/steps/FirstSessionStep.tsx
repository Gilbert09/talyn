import { useRef, useState } from 'react';
import { defaultFleetModelForAgent, PLAN_LIMITS, storedFleetModelForAgent } from '@talyn/shared';
import { readSessionDefaults } from '../../../lib/sessionDefaults';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { RepoPicker } from '../../workbench/new/NewWorkbenchControls';
import { useCreateWorkbench } from '../../workbench/new/useCreateWorkbench';
import { defaultRepositoryId, writeLastRepository } from '../../workbench/new/lastRepository';

interface FirstSessionStepProps {
  onCreated: () => void;
  onSkip: () => void;
  onBusyChange: (busy: boolean) => void;
}

export function FirstSessionStep({ onCreated, onSkip, onBusyChange }: FirstSessionStepProps) {
  const { currentWorkspaceId, repositories, cloudProviders, workspaces } = useWorkspaceStore();
  const [repositoryId, setRepositoryId] = useState(() => defaultRepositoryId(currentWorkspaceId, repositories));
  const [prompt, setPrompt] = useState('');
  const [defaults] = useState(readSessionDefaults);
  const submitting = useRef(false);
  const { create, busy, error } = useCreateWorkbench();
  const repo = repositories.find((r) => r.id === repositoryId);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const connectedAgents = cloudProviders?.find((provider) => provider.type === 'selfhosted')?.connectedAgents ?? [];
  const agent = connectedAgents.includes(defaults.agent)
    ? defaults.agent
    : connectedAgents.includes('codex') ? 'codex' : 'claude';
  const model = storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent);
  const freeHours = PLAN_LIMITS.free?.includedBoxHours;

  async function startSession() {
    if (!currentWorkspaceId || !repo || !prompt.trim() || submitting.current) return;
    submitting.current = true;
    onBusyChange(true);
    try {
      const session = await create({
        workspaceId: currentWorkspaceId,
        repositoryId: repo.id,
        repoFullName: repo.fullName,
        runtime: 'sandbox',
        agent,
        model,
        effort: defaults.effort,
        planMode: defaults.planMode,
        internetAccess: defaults.internetAccess,
        autoCreatePr: defaults.autoCreatePr,
        prompt,
      });
      if (session) {
        writeLastRepository(currentWorkspaceId, repo.id);
        onCreated();
      }
    } finally {
      submitting.current = false;
      onBusyChange(false);
    }
  }

  return (
    <div className="space-y-3">
      <RepoPicker repositories={repositories} value={repositoryId} onChange={setRepositoryId} disabled={busy} />
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
      {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
      <Button onClick={() => void startSession()} disabled={busy || !currentWorkspaceId || !repo || !prompt.trim()}>
        {busy ? 'Starting session…' : 'Start session'}
      </Button>
      <p className="text-xs text-muted-foreground">
        The first start can take a little longer while your sandbox image is prepared.
      </p>
      {typeof freeHours === 'number' && Number.isFinite(freeHours) && (
        <p className="text-xs text-muted-foreground">Free includes {freeHours} box-hours a month.</p>
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
