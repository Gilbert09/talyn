import { useEffect, useState } from 'react';
import type { RepositoryPreviewChoice, RepositoryPreviewResponse } from '@talyn/shared';
import { api } from '../../lib/api';

export function RepositoryPreviewSettings({ repositoryId, repoName, onConfigChange }: { repositoryId: string; repoName: string; onConfigChange: (config: RepositoryPreviewResponse) => void }) {
  const [config, setConfig] = useState<RepositoryPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.repositories.preview.get(repositoryId).then((next) => {
      if (active) { setConfig(next); onConfigChange(next); }
    }).catch((err) => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [repositoryId]);

  const update = async (target?: RepositoryPreviewChoice['target']) => {
    setBusy(true);
    setError(null);
    try {
      const next = target
        ? await api.repositories.preview.patch(repositoryId, { ...config?.user, target })
        : await api.repositories.preview.detect(repositoryId);
      setConfig(next);
      onConfigChange(next);
      window.dispatchEvent(new Event('repository-preview-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <div className="min-w-0 space-y-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      {config && <select aria-label={`Preview target for ${repoName}`} data-attr="settings-repo-preview-target" className="rounded border border-input bg-background px-2 py-1" value={config.user?.target ?? 'auto'} disabled={busy} onChange={(event) => void update(event.target.value as RepositoryPreviewChoice['target'])}>
        <option value="auto">Auto</option><option value="sandbox">Sandbox</option><option value="coder">Coder</option><option value="off">Off</option>
      </select>}
      <button type="button" data-attr="settings-repo-preview-detect" className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50" disabled={busy} onClick={() => void update()}>Detect again</button>
    </div>
    {config?.reasons.map((reason) => <p key={reason} className="text-muted-foreground">Detected: {reason}</p>)}
    {config?.target === 'coder' && (['url', 'workspace', 'checkout', 'run'] as const).map((field) => <label key={`${field}:${config.coder?.[field] ?? ''}`} className="flex items-center gap-2">
      <span className="w-24 shrink-0">{({ url: 'Coder URL', workspace: 'Workspace', checkout: 'Checkout', run: 'Run command' })[field]}</span>
      <input aria-label={`Coder ${field} for ${repoName}`} className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1" defaultValue={config.coder?.[field] ?? ''} onBlur={(event) => {
        const value = event.target.value.trim();
        if (value !== (config.coder?.[field] ?? '')) {
          setBusy(true);
          void api.repositories.preview.patch(repositoryId, { ...config.user, coder: { ...config.user.coder, [field]: value } }).then((next) => { setConfig(next); onConfigChange(next); window.dispatchEvent(new Event('repository-preview-changed')); }).catch((err) => setError(String(err))).finally(() => setBusy(false));
        }
      }} />
    </label>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
