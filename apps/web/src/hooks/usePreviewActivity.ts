import { useEffect, useState } from 'react';
import { workbenchesOffered, type PreviewPort, type RepositoryPreviewResponse, type Workbench } from '@talyn/shared';
import { api } from '../lib/api';
import { isArchivedWorkbench } from '../lib/workbenchActions';
import { previewKey, usePreviewStatusStore } from '../stores/previewStatus';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

export type PreviewActivity = { status: 'idle' | 'starting' | 'running' | 'failed'; label: string };
const DEFAULT_PORTS: PreviewPort[] = [{ port: 3000 }];

export function usePreviewActivity(workbench: Workbench): PreviewActivity & {
  config: RepositoryPreviewResponse | null;
  ports: PreviewPort[];
  portStatus: (port: number) => PreviewActivity;
} {
  const features = useWorkspaceStore((s) => s.features);
  const enabled = Boolean(features?.previewLinks) && workbenchesOffered(features)
    && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench);
  const [loaded, setLoaded] = useState<{ repositoryId: string; config: RepositoryPreviewResponse } | null>(null);
  const run = useWorkbenchStore((s) => s.scriptOutput[workbench.id]?.run);
  const statusMap = usePreviewStatusStore((s) => s.ports);
  const runStarting = usePreviewStatusStore((s) => s.runStarting[workbench.id] ?? false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    const repositoryId = workbench.repositoryId;
    const load = () => {
      if (!enabled || !repositoryId) return;
      void api.repositories.preview.get(repositoryId).then((config) => {
        if (!cancelled) setLoaded({ repositoryId, config });
      }).catch(() => undefined);
    };
    load();
    window.addEventListener('repository-preview-changed', load);
    return () => { cancelled = true; window.removeEventListener('repository-preview-changed', load); };
  }, [enabled, workbench.repositoryId]);

  useEffect(() => {
    if (!run?.running) usePreviewStatusStore.getState().clear(workbench.id);
  }, [run?.running, workbench.id]);

  const config = enabled && loaded?.repositoryId === workbench.repositoryId ? loaded.config : null;
  const ports = config && config.target !== 'coder' && config.target !== 'off'
    ? config.ports.length ? config.ports : DEFAULT_PORTS : [];
  const portStatus = (port: number): PreviewActivity => {
    const state = statusMap[previewKey(workbench.id, port)];
    if (state === 'starting' || runStarting) return { status: 'starting', label: `Starting preview :${port}` };
    if (state === 'live') return { status: 'running', label: `Running on preview :${port}` };
    if (run?.running) return { status: 'running', label: `Run script is running for preview :${port}` };
    if (run?.exitCode != null && run.exitCode !== 0) return { status: 'failed', label: `Run script exited with code ${run.exitCode}` };
    return { status: 'idle', label: 'Preview is idle' };
  };
  const knownPorts = [...new Set([...ports.map(({ port }) => port), ...Object.keys(statusMap)
    .filter((key) => key.startsWith(`${workbench.id}:`)).map((key) => Number(key.slice(workbench.id.length + 1)))])];
  const states = knownPorts.map(portStatus);
  const activity = states.find((item) => item.status === 'starting')
    ?? (runStarting ? { status: 'starting' as const, label: 'Starting run script' } : undefined)
    ?? states.find((item) => item.status === 'running')
    ?? (run?.running ? { status: 'running' as const, label: 'Run script is running' } : undefined)
    ?? states.find((item) => item.status === 'failed')
    ?? (run?.exitCode != null && run.exitCode !== 0 ? { status: 'failed' as const, label: `Run script exited with code ${run.exitCode}` } : undefined)
    ?? { status: 'idle' as const, label: 'Preview is idle' };
  return { ...activity, config, ports, portStatus };
}
