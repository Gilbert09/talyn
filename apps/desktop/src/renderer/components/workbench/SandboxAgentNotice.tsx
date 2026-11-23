import React, { useEffect, useState } from 'react';
import { addableBoxAgent, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';

/** Old boxes need a restart before they can use another connected agent. */
export function SandboxAgentNotice({ workbench, owner }: { workbench: Workbench; owner: boolean }) {
  const fleet = useWorkspaceStore((s) => s.cloudProviders?.find((p) => p.type === 'selfhosted'));
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (workbench.status !== 'ready') setRequested(false);
  }, [workbench.status]);
  const settings = workbench.settings as Record<string, unknown>;
  const saved = settings?.sandboxAgents as Record<string, string[]> | undefined;
  const agents = (workbench.sandboxId && saved?.[workbench.sandboxId]) || [workbench.agent];
  if (!owner || workbench.kind === 'thread' || workbench.runtime !== 'sandbox'
    || workbench.status !== 'ready' || !workbench.sandboxId || agents.length !== 1) return null;
  const missing = addableBoxAgent(agents, fleet);
  if (!missing) return null;

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await api.workbenches.restart(workbench.id, { reason: 'add connected agents' });
      setRequested(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restart the sandbox.');
    } finally {
      setBusy(false);
    }
  };
  return <div className="mb-2 text-xs text-muted-foreground" role="status">
    <p>This sandbox runs only {missing === 'codex' ? 'Claude' : 'Codex'}. Restart it to add {missing === 'codex' ? 'Codex' : 'Claude'}.</p>
    <p>Your branch and uncommitted changes will transfer. Running processes will stop. Large ignored files may not transfer.</p>
    {requested || settings?.restartRequestedAt
      ? <p>Restart requested. It will start after all running turns end.</p>
      : <button type="button" className="underline" disabled={busy} onClick={() => void restart()}>
        {busy ? 'Requesting restart…' : 'Restart sandbox'}
      </button>}
    {error && <p className="text-destructive">{error}</p>}
  </div>;
}
