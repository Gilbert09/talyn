import { useEffect } from 'react';
import type { RepositoryPreviewResponse, Workbench } from '@talyn/shared';
import { errorText, refreshCoderPreview } from '../lib/coderPreview';
import { useCoderPreviewStatusStore, emptyCoderPreviewStatus } from '../stores/coderPreviewStatus';
import { previewKey, usePreviewStatusStore, type PreviewPortState } from '../stores/previewStatus';
import { useWorkbenchStore } from '../stores/workbenches';

export type PreviewActivity = { status: 'idle' | 'starting' | 'running' | 'failed'; label: string };
type Config = Pick<RepositoryPreviewResponse, 'target' | 'ports' | 'coder'>;

export function usePreviewActivity(workbench: Workbench, config: Config | null): PreviewActivity & {
  portStatus: (port: number) => PreviewActivity;
  portPhase: (port: number) => PreviewPortState | null;
} {
  const ports = usePreviewStatusStore((s) => s.ports);
  const runStarting = usePreviewStatusStore((s) => s.runStarting[workbench.id] ?? false);
  const run = useWorkbenchStore((s) => s.scriptOutput[workbench.id]?.run);
  const coder = useCoderPreviewStatusStore((s) => s.sessions[workbench.id] ?? emptyCoderPreviewStatus);

  useEffect(() => {
    if (config?.target === 'coder') void refreshCoderPreview(workbench.id).catch((error) => {
      useCoderPreviewStatusStore.getState().update(workbench.id, { refreshError: errorText(error) });
    });
  }, [config?.target, workbench.id]);

  const portPhase = (port: number): PreviewPortState | null => ports[previewKey(workbench.id, port)] ?? (runStarting ? 'starting' : null);
  const idlePort = () => ({ status: 'idle' as const, label: '' });

  if (config?.target === 'coder') {
    const state = coder.state;
    const step = coder.step ?? state?.step;
    if (coder.busy || step) {
      const label = step === 'workspace' ? `Starting ${state?.workspace || config.coder?.workspace || 'Coder workspace'}`
        : step === 'worktree' ? 'Preparing worktree'
          : step === 'sync' ? 'Syncing'
            : step === 'run' ? 'Starting app'
              : step === 'open' ? 'Opening Coder preview'
                : step === 'login' ? 'Signing in to Coder'
                  : step === 'cli' ? 'Checking Coder CLI' : 'Starting Coder preview';
      return { status: 'starting', label, portStatus: idlePort, portPhase };
    }
    const error = coder.error || coder.refreshError || state?.problem?.message || state?.error;
    if (error) return { status: 'failed', label: error, portStatus: idlePort, portPhase };
    if (state?.active && state.running) return { status: 'running', label: 'Running in Coder', portStatus: idlePort, portPhase };
    return { status: 'idle', label: 'Coder preview is idle', portStatus: idlePort, portPhase };
  }

  const portStatus = (port: number): PreviewActivity => {
    const state = portPhase(port);
    if (state === 'starting') return { status: 'starting', label: `Starting preview :${port}` };
    if (state === 'live') return { status: 'running', label: `Running on preview :${port}` };
    if (run?.running) return { status: 'running', label: `Running on preview :${port}` };
    if (run?.exitCode != null && run.exitCode !== 0) return { status: 'failed', label: `Run script exited with code ${run.exitCode}` };
    return { status: 'idle', label: 'Preview is idle' };
  };
  const configuredPorts = config?.target === 'sandbox'
    ? (config.ports.length ? config.ports : [{ port: 3000 }]).map((item) => item.port) : [];
  const portNumbers = [...new Set([...configuredPorts, ...Object.keys(ports)
    .filter((key) => key.startsWith(`${workbench.id}:`)).map((key) => Number(key.slice(workbench.id.length + 1)))])];
  const states = portNumbers.map(portStatus);
  const activity = states.find((item) => item.status === 'starting')
    ?? (runStarting ? { status: 'starting' as const, label: 'Starting run script' } : undefined)
    ?? states.find((item) => item.status === 'running')
    ?? (run?.running ? { status: 'running' as const, label: 'Run script is running' } : undefined)
    ?? states.find((item) => item.status === 'failed')
    ?? (run?.exitCode != null && run.exitCode !== 0 ? { status: 'failed' as const, label: `Run script exited with code ${run.exitCode}` } : undefined)
    ?? { status: 'idle' as const, label: 'Preview is idle' };
  return { ...activity, portStatus, portPhase };
}
